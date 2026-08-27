/**
 * camera-status-service.js
 *
 * Lógica compartida del contrato unificado de estado de cámara (contrato
 * documentado en la cabecera de routes/camera-status.js). La usan:
 *  - GET /cameras/:id/status (routes/camera-status.js)
 *  - GET /cameras (routes/cameras.js): enriquece cada yi-hack con su estado
 *    para que la pantalla de listado no haga N+1 peticiones.
 *
 * Fuentes del estado (yi-hack):
 *  - Probes HTTP a los CGI de la cámara (status.json,
 *    get_configs.sh?conf=camera y ?conf=system): 3 fetch en paralelo por
 *    cámara, cada uno con 3 s de timeout (AbortSignal.timeout). NO hay
 *    cache: cada llamada sondea la cámara. En el listado se abanica a las
 *    N cámaras en paralelo (Promise.allSettled en routes/cameras.js), así
 *    la latencia total ≈ el probe más lento (≤ ~3 s), no la suma.
 *  - Registry MQTT (en memoria, sin I/O): birth/will online/offline y
 *    feedback stat/camera/<cmd> (mqtt/client.js).
 *  - SQLite (datos del NVR): stats de clips, push, últimos eventos
 *    (database.js).
 *
 * generic: SIN fetch ni comandos al dispositivo; solo datos del NVR.
 */

const registry = require('./camera-registry');
const mqttClient = require('./mqtt/client');
const commands = require('./mqtt/commands');
const {
    getCameraSetting,
    getCameraStats,
    getLastEvent,
    getLastMotionEvent
} = require('./database');

// Timeout del proxy HTTP hacia la cámara
const PROXY_TIMEOUT_MS = 3000;

// Capacidad total de la SD por defecto (MB) cuando la cámara no tiene
// sd_total_mb configurado en cameras.json: 32 GB, la tarjeta más común
// en estas cámaras.
const SD_TOTAL_MB_DEFAULT = 32768;

// Capabilities del contrato unificado (ver cabecera de
// routes/camera-status.js). yi-hack: todo. generic: solo lo que el NVR
// gestiona sin tocar el dispositivo (push y videos). El frontend decide
// qué secciones renderizar con este objeto.
const YIHACK_CAPABILITIES = Object.freeze({
    live_status: true,
    controls: true,
    sd: true,
    wifi: true,
    system: true,
    mqtt: true,
    push: true,
    videos: true
});
const GENERIC_CAPABILITIES = Object.freeze({
    live_status: false,
    controls: false,
    sd: false,
    wifi: false,
    system: false,
    mqtt: false,
    push: true,
    videos: true
});

/**
 * Fetch de un CGI que responde JSON. Lanza si la cámara no responde, el
 * timeout se agota o la respuesta no es JSON.
 * @param {string} url
 * @param {Object} [options] - Opciones de fetch (method, headers, body)
 * @returns {Promise<Object>} - JSON parseado (sin el sentinel "NULL")
 */
async function fetchCameraJson(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        const err = new Error(`respuesta no-JSON: ${text.slice(0, 120)}`);
        err.status = 502;
        throw err;
    }
    // get_configs.sh cierra el JSON con el sentinel "NULL":"NULL"
    if (data && typeof data === 'object' && 'NULL' in data) {
        delete data.NULL;
    }
    return data;
}

/**
 * Compone el estado legible de la cámara:
 *  - responde HTTP y SWITCH_ON=no → "off" (apagada por software)
 *  - responde HTTP (SWITCH_ON=yes o desconocido) → "on"
 *  - no responde HTTP pero el birth/will MQTT dice online → "on"
 *    (la cámara está viva; solo su httpd está caído/desactivado)
 *  - no responde HTTP y MQTT dice offline (o no hay datos) → "unreachable"
 * @param {boolean} reachable
 * @param {Object|null} config - conf de cámara (get_configs.sh?conf=camera)
 * @param {boolean} mqttOnline - birth/will MQTT de la cámara
 * @returns {string}
 */
function composeState(reachable, config, mqttOnline) {
    if (reachable) {
        return config && config.SWITCH_ON === 'no' ? 'off' : 'on';
    }
    return mqttOnline ? 'on' : 'unreachable';
}

// Mapeo comando MQTT (feedback stat/camera/<cmd>) → clave de camera.conf.
// Los payloads MQTT usan on/off; la conf usa yes/no → se normaliza a yes/no.
const MQTT_CMD_TO_CONF_KEY = {
    switch_on: 'SWITCH_ON',
    led: 'LED',
    ir: 'IR',
    save_video_on_motion: 'SAVE_VIDEO_ON_MOTION'
};

/**
 * Normaliza un payload MQTT (on/off/yes/no) al formato de camera.conf.
 * @param {string} value
 * @returns {string} - "yes" | "no"
 */
function normalizeYesNo(value) {
    return value === 'yes' || value === 'on' ? 'yes' : 'no';
}

/**
 * Construye una camera_config "sintética" a partir del último feedback
 * stat MQTT de la cámara. Se usa cuando el HTTP de la cámara no está
 * disponible, para que los toggles muestren el estado real (no el
 * default OFF).
 * @param {Object<string, string>} cmdState - feedback stat (cmd → payload)
 * @returns {Object|null} - conf parcial (solo las claves con feedback)
 */
function buildConfigFromMqtt(cmdState) {
    const conf = {};
    for (const [cmd, key] of Object.entries(MQTT_CMD_TO_CONF_KEY)) {
        if (typeof cmdState[cmd] === 'string') {
            conf[key] = normalizeYesNo(cmdState[cmd]);
        }
    }
    return Object.keys(conf).length > 0 ? conf : null;
}

/**
 * Convierte un porcentaje de SD usado (free_sd de status.json es el %
 * LIBRE) en MB usando sd_total_mb de cameras.json (o SD_TOTAL_MB_DEFAULT
 * si la cámara no lo configura).
 * @param {string} freePct - p. ej. "71%"
 * @param {number|null} totalMb
 * @returns {Object|null}
 */
function buildSd(freePct, totalMb) {
    if (!totalMb) return null;
    const pct = parseInt(freePct, 10);
    if (Number.isNaN(pct)) return null;
    const freeMb = Math.round((pct / 100) * totalMb);
    return {
        total_mb: totalMb,
        free_mb: freeMb,
        used_mb: totalMb - freeMb,
        free_pct: pct
    };
}

/**
 * Metadatos que el NVR ya indexa de una cámara (tabla videos por ftp_dir +
 * mqtt_events + camera_settings). Válidos para ambos ecosistemas: en
 * generic son la ÚNICA fuente de datos de la cámara.
 * @param {Object} cam - Objeto de cámara del registro
 * @returns {{video_count: number, last_video: string|null,
 *            push_enabled: boolean,
 *            last_event: Object|null, last_motion: Object|null}}
 */
function getNvrData(cam) {
    const stats = getCameraStats().find(row => row.camera_name === cam.ftp_dir);
    return {
        video_count: stats ? stats.count : 0,
        last_video: stats ? stats.last_video : null,
        push_enabled: getCameraSetting(cam.id).push_enabled,
        last_event: getLastEvent(cam.id),
        last_motion: getLastMotionEvent(cam.id)
    };
}

/**
 * Construye el objeto `data` del contrato unificado de estado de una
 * cámara (mismas claves para ambos ecosistemas; ver cabecera de
 * routes/camera-status.js). Es el cuerpo de GET /cameras/:id/status
 * (sin el wrapper {success}) y la fuente del campo `status` de
 * GET /cameras.
 * yi-hack: 3 probes HTTP en paralelo (3 s de timeout cada uno) + registry
 * MQTT + datos del NVR. generic: SIN fetch al dispositivo; solo datos del
 * NVR.
 * @param {Object} cam - Objeto de cámara del registro
 * @returns {Promise<Object>} - Objeto de estado (contrato unificado)
 */
async function buildCameraStatus(cam) {
    const ecosystem = registry.getEcosystem(cam);
    const nvr = getNvrData(cam);

    // generic: no se consulta NADA al dispositivo; se devuelve solo lo que
    // el NVR ya indexa (las claves de dispositivo son null).
    if (ecosystem !== 'yi-hack') {
        return {
            id: cam.id,
            host: cam.host,
            ecosystem,
            capabilities: GENERIC_CAPABILITIES,
            state: null,
            http: null,
            mqtt: null,
            status: null,
            camera_config: null,
            system_config: null,
            sd: null,
            ...nvr
        };
    }

    // yi-hack: probes en paralelo. Sin host no se puede sondear (el endpoint
    // de una cámara responde 400 antes de llegar aquí; en el listado se
    // trata como "unreachable").
    let statusRes = { status: 'rejected' };
    let camConfRes = { status: 'rejected' };
    let sysConfRes = { status: 'rejected' };
    if (cam.host) {
        const base = `http://${cam.host}`;
        [statusRes, camConfRes, sysConfRes] = await Promise.allSettled([
            fetchCameraJson(`${base}/cgi-bin/status.json`),
            fetchCameraJson(`${base}/cgi-bin/get_configs.sh?conf=camera`),
            fetchCameraJson(`${base}/cgi-bin/get_configs.sh?conf=system`)
        ]);
    }
    const reachable = statusRes.status === 'fulfilled';
    const status = reachable ? statusRes.value : null;
    let camConf = camConfRes.status === 'fulfilled' ? camConfRes.value : null;
    const sysConf = sysConfRes.status === 'fulfilled' ? sysConfRes.value : null;

    // Estado MQTT (birth/will + feedback stat) como fuente secundaria
    const mqttState = mqttClient.getCameraMqttState(cam.id);
    const mqttOnline = !!(mqttState && mqttState.online);
    const cmdState = mqttClient.getCameraCommandState(cam.id);

    // Si el HTTP de la cámara está caído, la conf real no se puede
    // leer: usamos el último feedback stat MQTT (estado real de los
    // toggles) y, si aún no hay ninguno, pedimos un sync ping para
    // que la cámara re-publique su estado (llegará al próximo poll).
    if (!camConf && cmdState) {
        camConf = buildConfigFromMqtt(cmdState);
    }
    if (!camConf && mqttOnline && !cmdState) {
        try {
            commands.syncCameraState(cam.id);
        } catch (e) {
            // broker caído: sin sync, el estado se reintentará solo
        }
    }

    return {
        id: cam.id,
        host: cam.host,
        ecosystem,
        capabilities: YIHACK_CAPABILITIES,
        state: composeState(reachable, camConf, mqttOnline),
        http: reachable,
        mqtt: mqttState
            ? { online: mqttState.online, lastSeen: mqttState.lastSeen }
            : null,
        status,
        camera_config: camConf,
        system_config: sysConf,
        sd: buildSd(status ? status.free_sd : null, cam.sd_total_mb || SD_TOTAL_MB_DEFAULT),
        ...nvr
    };
}

module.exports = {
    PROXY_TIMEOUT_MS,
    SD_TOTAL_MB_DEFAULT,
    YIHACK_CAPABILITIES,
    GENERIC_CAPABILITIES,
    fetchCameraJson,
    composeState,
    buildConfigFromMqtt,
    buildSd,
    getNvrData,
    buildCameraStatus
};
