/**
 * routes/camera-status.js
 *
 * Router de la API para el estado REAL y el control remoto de una cámara
 * (se monta en /api). A diferencia de routes/cameras.js (comandos MQTT),
 * aquí el API actúa como proxy HTTP contra los CGI de la cámara (yi-hack):
 * el frontend nunca conoce la IP de la cámara, solo habla con el API.
 *
 * IMPORTANTE: los CGI de yi-hack viven bajo el prefijo `/cgi-bin/` (así
 * los invoca la UI oficial de la cámara, verificado en htdocs/js/modules/*.js
 * y en vivo contra la cámara real). P. ej. `http://<host>/cgi-bin/status.json`.
 *
 * Ecosistemas (campo `ecosystem` de cameras.json; default "generic", ver
 * camera-registry.js):
 *  - "yi-hack": firmware yi-hack; se puede consultar TODO (status.json,
 *    get_configs.sh, SD, WiFi, uptime) y enviarle controles (reboot, httpd,
 *    MQTT). Comportamiento clásico de este router.
 *  - "generic": el resto (p. ej. Tuya): NO se le hace NINGÚN fetch ni
 *    comando al dispositivo. El API devuelve solo lo que el NVR ya indexa:
 *    IP, nº de videos, último video y últimos eventos de la BD de clips.
 *
 * CONTRATO DE RESPUESTA UNIFICADA de GET /cameras/:id/status: mismas claves
 * para ambos ecosistemas; las no disponibles son SIEMPRE null (nunca
 * ausentes), para que el frontend use `capabilities` sin hardcodear el
 * ecosistema:
 *  - id, host, ecosystem ("yi-hack" | "generic")
 *  - capabilities: qué secciones puede mostrar el frontend:
 *      live_status → state/http/mqtt/status/camera_config/system_config
 *      controls    → endpoints de control (reboot, httpd, MQTT...)
 *      sd          → sección SD
 *      wifi        → WiFi (wlan_essid/wlan_strength de status.json)
 *      system      → fw/uptime/memoria (status.json + system_config)
 *      mqtt        → estado online MQTT
 *      push        → toggle de push del NVR (AMBOS ecosistemas: es estado
 *                    del NVR, no un control de la cámara)
 *      videos      → metadatos de clips del NVR (ambos ecosistemas)
 *    yi-hack: todos true. generic: solo push y videos.
 *  - state: "on"|"off"|"unreachable" (yi-hack) | null (generic: el NVR no
 *    puede saber si la cámara está encendida)
 *  - http: bool (yi-hack) | null (generic)
 *  - mqtt: {online, lastSeen} (yi-hack; null si aún no hay datos MQTT) | null (generic)
 *  - status, camera_config, system_config, sd: objeto (yi-hack; null si la
 *    cámara no respondió a ese CGI) | null (generic)
 *  - video_count, last_video: metadatos de clips del NVR (ambos)
 *  - push_enabled: bool (ambos)
 *  - last_event, last_motion: últimos eventos de la BD (ambos; null si no hay)
 *
 * Endpoints:
 *  - GET  /cameras/:id/status - Estado real (contrato arriba). En yi-hack:
 *    status.json + get_configs (camera/system) + SD calculada + últimos
 *    eventos MQTT + estado push. Compone el estado de la cámara:
 *    "on" | "off" | "unreachable". "unreachable" es un estado legítimo
 *    (200), no un error: la cámara puede estar físicamente apagada o con
 *    HTTPD desactivado.
 *
 *    El estado NO depende solo del probe HTTP: si el HTTP de la cámara
 *    está caído (httpd de yi-hack detenido o HTTPD=no) pero el birth/will
 *    MQTT dice "online", el estado es "on" con http=false (la cámara está
 *    viva; solo falta su servidor HTTP). En ese caso camera_config se
 *    rellena con el último feedback stat/camera/<cmd> (MQTT) para que los
 *    toggles muestren el estado real, y se envía un ping de sync (payload
 *    vacío a cmnd/camera) si aún no hay feedback.
 *  - POST /cameras/:id/reboot - Reinicia la cámara (CGI reboot.sh).
 *    SOLO yi-hack (generic → 409).
 *  - POST /cameras/:id/httpd  - HTTPD yes/no (set_configs.sh?conf=system).
 *    Persiste en etc/system.conf; el firmware solo lee HTTPD al arrancar
 *    (system.sh), así que el cambio se aplica en el siguiente reboot.
 *    SOLO yi-hack (generic → 409).
 *  - POST /cameras/:id/push   - Activa/desactiva el push de movimiento de
 *    esta cámara (estado del NVR, tabla camera_settings, no de la cámara).
 *    AMBOS ecosistemas: es un ajuste del NVR, no un control del dispositivo.
 *
 * Errores: cámara desconocida 404; sin host 400 (yi-hack); control no
 * soportado por el ecosistema 409 (reboot/httpd a una generic); cámara no
 * alcanzable 502 (en los POST yi-hack). El proxy HTTP hacia la cámara usa
 * fetch nativo con timeout de 3 s por petición (la cámara responde en <1 s;
 * 3 s es margen para WiFi lento sin congelar la UI).
 */

const express = require('express');
const registry = require('../camera-registry');
const mqttClient = require('../mqtt/client');
const commands = require('../mqtt/commands');
const {
    getCameraSetting,
    setCameraPushEnabled,
    getCameraStats,
    getLastEvent,
    getLastMotionEvent
} = require('../database');

const router = express.Router();

// Timeout del proxy HTTP hacia la cámara
const PROXY_TIMEOUT_MS = 3000;

// Capacidad total de la SD por defecto (MB) cuando la cámara no tiene
// sd_total_mb configurado en cameras.json: 32 GB, la tarjeta más común
// en estas cámaras.
const SD_TOTAL_MB_DEFAULT = 32768;

// Capabilities del contrato unificado (ver cabecera). yi-hack: todo.
// generic: solo lo que el NVR gestiona sin tocar el dispositivo (push y
// videos). El frontend decide qué secciones renderizar con este objeto.
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
 * @param {string} freePct - p.ej. "71%"
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
 * GET /api/cameras/:id/status
 *
 * Estado de la cámara según su ecosistema (contrato unificado en la
 * cabecera). yi-hack: consulta en paralelo status.json,
 * get_configs.sh?conf=camera y ?conf=system (3 s de timeout cada uno); si
 * la cámara no responde, el estado es "unreachable" (200, no error).
 * generic: SIN fetch al dispositivo; solo metadatos del NVR.
 */
router.get('/cameras/:id/status', async (req, res) => {
    try {
        const cam = registry.getCameraById(req.params.id);
        if (!cam) {
            return res.status(404).json({ success: false, error: 'cámara no encontrada' });
        }

        const ecosystem = registry.getEcosystem(cam);
        const nvr = getNvrData(cam);

        // generic: no se consulta NADA al dispositivo; se devuelve solo lo
        // que el NVR ya indexa (las claves de dispositivo son null).
        if (ecosystem !== 'yi-hack') {
            return res.json({
                success: true,
                data: {
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
                }
            });
        }

        if (!cam.host) {
            return res.status(400).json({ success: false, error: 'la cámara no tiene host configurado' });
        }

        const base = `http://${cam.host}`;
        const [statusRes, camConfRes, sysConfRes] = await Promise.allSettled([
            fetchCameraJson(`${base}/cgi-bin/status.json`),
            fetchCameraJson(`${base}/cgi-bin/get_configs.sh?conf=camera`),
            fetchCameraJson(`${base}/cgi-bin/get_configs.sh?conf=system`)
        ]);
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

        res.json({
            success: true,
            data: {
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
            }
        });
    } catch (error) {
        console.error('[API] Error al obtener estado de cámara:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/reboot
 *
 * Reinicia la cámara (CGI reboot.sh: sync×3, killall mqttv4, sleep 1,
 * reboot). La cámara puede dejar de responder antes de responder; se
 * intenta leer la respuesta pero no importa: si el fetch completó el
 * handshake HTTP, el reboot ya está en marcha.
 */
router.post('/cameras/:id/reboot', async (req, res) => {
    try {
        const cam = registry.getCameraById(req.params.id);
        if (!cam) {
            return res.status(404).json({ success: false, error: 'cámara no encontrada' });
        }
        if (registry.getEcosystem(cam) !== 'yi-hack') {
            return res.status(409).json({
                success: false,
                error: `la cámara "${cam.id}" es de ecosistema "${registry.getEcosystem(cam)}": no admite controles remotos (solo datos del NVR)`
            });
        }
        if (!cam.host) {
            return res.status(400).json({ success: false, error: 'la cámara no tiene host configurado' });
        }
        try {
            await fetchCameraJson(`http://${cam.host}/cgi-bin/reboot.sh`);
        } catch (e) {
            return res.status(502).json({ success: false, error: 'cámara no alcanzable' });
        }
        res.json({ success: true, rebooted: true });
    } catch (error) {
        console.error('[API] Error al reiniciar cámara:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/httpd
 *
 * Cuerpo: {"enabled": true|false} — activa/desactiva el servidor HTTP
 * de la cámara (set_configs.sh?conf=system, HTTPD yes/no). Persiste en
 * etc/system.conf, pero el firmware solo lee HTTPD al arrancar
 * (system.sh), así que el cambio se aplica en el siguiente reboot.
 */
router.post('/cameras/:id/httpd', async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    try {
        const cam = registry.getCameraById(req.params.id);
        if (!cam) {
            return res.status(404).json({ success: false, error: 'cámara no encontrada' });
        }
        if (registry.getEcosystem(cam) !== 'yi-hack') {
            return res.status(409).json({
                success: false,
                error: `la cámara "${cam.id}" es de ecosistema "${registry.getEcosystem(cam)}": no admite controles remotos (solo datos del NVR)`
            });
        }
        if (!cam.host) {
            return res.status(400).json({ success: false, error: 'la cámara no tiene host configurado' });
        }
        try {
            await fetchCameraJson(`http://${cam.host}/cgi-bin/set_configs.sh?conf=system`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ HTTPD: enabled ? 'yes' : 'no' })
            });
        } catch (e) {
            return res.status(502).json({ success: false, error: 'cámara no alcanzable' });
        }
        res.json({
            success: true,
            httpd: enabled ? 'yes' : 'no',
            applied: 'next_boot'
        });
    } catch (error) {
        console.error('[API] Error al cambiar HTTPD:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/push
 *
 * Cuerpo: {"enabled": true|false} — activa/desactiva el push de
 * movimiento de esta cámara (estado del NVR, no de la cámara).
 */
router.post('/cameras/:id/push', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    try {
        const cam = registry.getCameraById(req.params.id);
        if (!cam) {
            return res.status(404).json({ success: false, error: 'cámara no encontrada' });
        }
        setCameraPushEnabled(cam.id, enabled);
        res.json({ success: true, push_enabled: enabled });
    } catch (error) {
        console.error('[API] Error al cambiar push:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
