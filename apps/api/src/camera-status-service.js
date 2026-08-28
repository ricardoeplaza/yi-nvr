/**
 * camera-status-service.js
 *
 * Capa de composición del contrato unificado de estado de cámara (contrato
 * documentado en la cabecera de routes/camera-status.js). NO contiene lógica
 * de dispositivo: los probes HTTP, la caché de probes y la escritura CGI
 * viven en el adapter del ecosistema (camera/adapters/yi-hack.js, vía
 * camera/index.js); este servicio compone probes + registry MQTT + datos del
 * NVR (SQLite) en el objeto de estado.
 *
 * La usan:
 *  - GET /cameras/:id/status (routes/camera-status.js)
 *  - GET /cameras/status (routes/cameras.js): enriquece cada yi-hack con su
 *    estado para que la pantalla de listado no haga N+1 peticiones.
 *  - GET /cameras/:id/storage y /storage/ftp (routes/storage.js): usan
 *    buildSd (de este servicio) para la SD y el adapter (getStatus /
 *    getSystemConfig) para status.json / get_configs system, dentro de la
 *    misma caché de probes del adapter (no con un fetch aparte).
 *
 * Fuentes del estado (yi-hack):
 *  - adapter.getProbes(cam): 3 probes HTTP en paralelo (status.json,
 *    get_configs.sh?conf=camera y ?conf=system), con caché TTL por cámara
 *    (default 30 s; env CAMERA_STATUS_CACHE_TTL_MS; 0 desactiva) y
 *    single-flight (ver camera/adapters/yi-hack.js).
 *  - Registry MQTT (en memoria, sin I/O): birth/will online/offline y
 *    feedback stat/camera/<cmd> (mqtt/client.js).
 *  - SQLite (datos del NVR): stats de clips, push, últimos eventos
 *    (database.js).
 *
 * generic (ecosistema sin adapter): SIN fetch ni comandos al dispositivo;
 * solo datos del NVR.
 *
 * Compatibilidad: getProbes / fetchProbes / fetchCameraJson /
 * setCameraConfig / invalidateCameraStatus se exportan aún (misma firma y
 * retorno de antes) pero NINGUNA ruta los llama hoy; se delegan al adapter
 * (o se conservan como helpers genéricos) para no romper la API pública.
 */

const registry = require('./camera-registry');
const mqttClient = require('./mqtt/client');
const {
    getCameraSetting,
    getCameraStats,
    getLastEvent,
    getLastMotionEvent
} = require('./database');
const { getCameraAdapter } = require('./camera');

// Timeout del proxy HTTP hacia la cámara (fetchCameraJson, compatibilidad de
// rutas: lo usa aún el POST /cameras/:id/reboot de routes/camera-status.js)
const PROXY_TIMEOUT_MS = 3000;

// TTL de la caché de probes por cámara (ms). Env CAMERA_STATUS_CACHE_TTL_MS;
// default 30 s; 0 desactiva la caché. La caché en sí vive en el adapter
// (camera/adapters/yi-hack.js); esta constante se conserva exportada por
// compatibilidad (mismo valor que el adapter, misma fuente env).
const PROBE_CACHE_TTL_MS = (() => {
    const raw = process.env.CAMERA_STATUS_CACHE_TTL_MS;
    if (raw === undefined || raw === '') return 30000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 30000;
})();

// Capacidad total de la SD por defecto (MB) cuando la cámara no tiene
// sd_total_mb configurado en cameras.json: 32 GB, la tarjeta más común
// en estas cámaras. Único default del objeto `sd` (buildSd).
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
 * @param {number} [timeoutMs] - Timeout (por defecto PROXY_TIMEOUT_MS)
 * @returns {Promise<Object>} - JSON parseado (sin el sentinel "NULL")
 */
async function fetchCameraJson(url, options = {}, timeoutMs = PROXY_TIMEOUT_MS) {
    const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs)
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
 * Construye el objeto `sd` del contrato unificado (ÚNICO punto de la app
 * que lo construye; el adapter solo entrega free_sd). Convierte un
 * porcentaje de SD usado (free_sd de status.json es el % LIBRE) en MB
 * usando sd_total_mb de cameras.json (o SD_TOTAL_MB_DEFAULT si la cámara
 * no lo configura).
 * @param {string|null} freePct - p. ej. "71%" (null → sd null)
 * @param {number|null} [totalMb] - sd_total_mb de la cámara (default
 *   SD_TOTAL_MB_DEFAULT)
 * @returns {Object|null} - {total_mb, free_mb, used_mb, free_pct} | null
 */
function buildSd(freePct, totalMb) {
    const total = totalMb || SD_TOTAL_MB_DEFAULT;
    const pct = parseInt(freePct, 10);
    if (Number.isNaN(pct)) return null;
    const freeMb = Math.round((pct / 100) * total);
    return {
        total_mb: total,
        free_mb: freeMb,
        used_mb: total - freeMb,
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
 * Devuelve la promesa de los 3 probes de la cámara, delegando en el adapter
 * del ecosistema (getProbes del adapter: caché TTL + single-flight). Es la
 * ÚNICA puerta de lectura de los 3 CGI de estado: cualquier ruta que lea
 * uno de esos CGI debe pasar por aquí para que la lectura quede DENTRO de
 * la caché (la usan buildCameraStatus, GET /cameras/:id/storage y
 * GET /cameras/:id/storage/ftp).
 * @param {Object} cam - Objeto de cámara del registro (con host)
 * @returns {Promise<Array>|null} - [statusRes, camConfRes, sysConfRes]
 *   (settled), o null si el ecosistema no tiene adapter
 */
function getProbes(cam) {
    const adapter = getCameraAdapter(cam);
    return adapter ? adapter.getProbes(cam) : null;
}

/**
 * Alias de getProbes (compatibilidad de la API antigua del servicio; el
 * probe en sí vive en el adapter).
 * @param {Object} cam
 * @returns {Promise<Array>|null}
 */
function fetchProbes(cam) {
    return getProbes(cam);
}

/**
 * Invalida la caché de probes de una cámara (delegada en
 * adapter.invalidateProbes): la próxima lectura (getProbes /
 * buildCameraStatus) sondeará de nuevo. Se llama tras operaciones que
 * cambian el estado del dispositivo (comandos MQTT, reboot, httpd,
 * escritura de config FTP, borrados de SD —liberan espacio y cambian
 * free_sd de status.json—).
 * @param {string} id
 */
function invalidateCameraStatus(id) {
    const cam = registry.getCameraById(id);
    const adapter = getCameraAdapter(cam);
    if (adapter) {
        adapter.invalidateProbes(cam);
    }
}

/**
 * Escribe parámetros en la config de la cámara, delegando en el adapter
 * (set_configs.sh?conf=system; semántica CONFIG_REJECTED 502 "la cámara
 * rechazó la configuración"). Mantiene la firma antigua del servicio
 * (cam, conf, payload, timeoutMs): payload es el objeto de claves a
 * escribir en UN solo CGI; timeoutMs ya no se usa (el adapter usa su
 * timeout de 15 s, el mismo que pasaban las rutas).
 * @param {Object} cam - Cámara del registro (necesita id y host)
 * @param {string} conf - Archivo de config: solo "system" (el adapter no
 *   escribe conf=camera)
 * @param {Object<string, string>} payload - Claves a escribir (yes/no/...)
 * @param {number} [timeoutMs] - Obsoleto (lo conserva la firma antigua)
 * @returns {Promise<Object>} - JSON del CGI (sin el sentinel "NULL")
 * @throws {Error} - code "CONFIG_REJECTED" (502) si el CGI rechazó la
 *   escritura; "UNSUPPORTED_ECOSYSTEM" (409) si no hay adapter;
 *   "INVALID" (400) si conf no es "system"
 */
async function setCameraConfig(cam, conf, payload, timeoutMs) {
    const adapter = getCameraAdapter(cam);
    if (!adapter) {
        const err = new Error('la cámara no soporta escritura de configuración por CGI');
        err.status = 409;
        err.code = 'UNSUPPORTED_ECOSYSTEM';
        throw err;
    }
    if (conf !== 'system') {
        const err = new Error(`conf no soportado: "${conf}" (el adapter solo escribe conf=system)`);
        err.status = 400;
        err.code = 'INVALID';
        throw err;
    }
    const entries = Object.entries(payload);
    if (entries.length === 1) {
        return adapter.setCameraConfig(cam, entries[0][0], entries[0][1]);
    }
    return adapter.setFtpPushConfig(cam, payload);
}

/**
 * Construye el objeto `data` del contrato unificado de estado de una
 * cámara (mismas claves para ambos ecosistemas; ver cabecera de
 * routes/camera-status.js). Es el cuerpo de GET /cameras/:id/status
 * (sin el wrapper {success}) y la fuente del campo `status` de
 * GET /cameras/status.
 * yi-hack: 3 probes HTTP en paralelo (3 s de timeout cada uno, con caché
 * TTL por cámara en el adapter) + registry MQTT + datos del NVR.
 * generic (sin adapter): SIN fetch al dispositivo; solo datos del NVR.
 * @param {Object} cam - Objeto de cámara del registro
 * @returns {Promise<Object>} - Objeto de estado (contrato unificado)
 */
async function buildCameraStatus(cam) {
    const ecosystem = registry.getEcosystem(cam);
    const nvr = getNvrData(cam);
    const adapter = getCameraAdapter(cam);

    // Ecosistema sin adapter: no se consulta NADA al dispositivo; se
    // devuelve solo lo que el NVR ya indexa (las claves de dispositivo
    // son null).
    if (!adapter) {
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

    // yi-hack: probes en paralelo vía el adapter (caché TTL + single-
    // flight). Sin host no se puede sondear (el endpoint de una cámara
    // responde 400 antes de llegar aquí; en el listado se trata como
    // "unreachable").
    let statusRes = { status: 'rejected' };
    let camConfRes = { status: 'rejected' };
    let sysConfRes = { status: 'rejected' };
    if (cam.host) {
        [statusRes, camConfRes, sysConfRes] = await adapter.getProbes(cam);
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
    // toggles).
    if (!camConf && cmdState) {
        camConf = buildConfigFromMqtt(cmdState);
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
        sd: buildSd(status ? status.free_sd : null, cam.sd_total_mb),
        ...nvr
    };
}

module.exports = {
    PROXY_TIMEOUT_MS,
    PROBE_CACHE_TTL_MS,
    SD_TOTAL_MB_DEFAULT,
    YIHACK_CAPABILITIES,
    GENERIC_CAPABILITIES,
    fetchCameraJson,
    setCameraConfig,
    composeState,
    buildConfigFromMqtt,
    buildSd,
    getNvrData,
    fetchProbes,
    getProbes,
    buildCameraStatus,
    invalidateCameraStatus
};
