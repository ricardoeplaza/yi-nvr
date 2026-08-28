/**
 * routes/cameras.js
 *
 * Router de la API para la gestión de cámaras (se monta en /api).
 *
 * Endpoints:
 *  - GET /cameras           - Listado rápido: SOLO cameras.json + stats de
 *                              la BD + estado MQTT (SIN probes al
 *                              dispositivo; responde en ms). Es el contrato
 *                              clásico (pre-enriquecimiento con estado real).
 *  - GET /cameras/status    - Listado completo: como GET /cameras + status
 *                              (yi-hack, probes CGI con caché TTL) y
 *                              latest_video por cámara.
 *  - POST /cameras/:id/reload - Recarga el archivo cameras.json completo
 *  - POST /cameras/group/power - Enciende/apaga un grupo de cámaras
 *  - POST /cameras/:id/power - Enciende/apaga la cámara (switch_on yes/no)
 *  - POST /cameras/:id/led   - LED on/off
 *  - POST /cameras/:id/night-vision - IR-cut on/off
 *  - POST /cameras/:id/rec-mode - Grabación por movimiento on/off
 *  - POST /cameras/:id/command - Comando genérico con whitelist
 *
 * Los 6 endpoints de control van por el adapter del ecosistema
 * (camera/index.js → adapters/yi-hack.js, CGI camera_settings.sh): la
 * whitelist (COMMAND_VALUES) vive en el adapter, los mutantes invalidan su
 * propia caché de probes (la ruta NO invalida nada) y los errores se
 * mapean así: INVALID → 400 (mensaje de la whitelist); 404/409/400-host
 * los responde resolveCameraFor; fallo de fetch → 502 "cámara no
 * alcanzable"; CONFIG_REJECTED → 502 "la cámara rechazó la configuración".
 *
 * Nota: el :id de reload se acepta para simetría de la API, pero la recarga
 * aplica a TODO el archivo de configuración (no a una sola cámara).
 */

const express = require('express');
const debug = require('debug');
const registry = require('../camera-registry');
const { getCameraStats, getLatestVideosByCamera } = require('../database');
const mqttClient = require('../mqtt/client');
const { getCameraAdapter, resolveCameraFor } = require('../camera');
const { buildCameraStatus } = require('../camera-status-service');
const { videoWithUrls } = require('./videos');

const router = express.Router();

/**
 * Mensaje 409 de controles remotos (literal: el frontend lo aserta en
 * camera-detail.page.spec.ts).
 * @param {Object} cam - Cámara del registro
 * @returns {string}
 */
function unsupportedControlsMessage(cam) {
    return `la cámara "${cam.id}" es de ecosistema "${registry.getEcosystem(cam)}": no admite controles remotos (solo datos del NVR)`;
}

/**
 * Resuelve la cámara de req.params.id y su adapter para un endpoint de
 * control, pasando a resolveCameraFor el mensaje 409 de controles remotos.
 * @param {Object} req - Request de Express (usa req.params.id)
 * @param {Object} res - Response de Express (responde él los errores)
 * @param {string} method - Método del adapter que la ruta va a llamar
 * @returns {{cam: Object, adapter: Object}|null} - null si ya respondió
 */
function resolveControl(req, res, method) {
    const cam = registry.getCameraById(req.params.id);
    return resolveCameraFor(
        req,
        res,
        method,
        cam ? unsupportedControlsMessage(cam) : undefined
    );
}

/**
 * Mapea un error del adapter al HTTP correspondiente: INVALID → 400 con el
 * mensaje de la whitelist; CONFIG_REJECTED → 502 "la cámara rechazó la
 * configuración"; resto (fetch crudo) → 502 "cámara no alcanzable".
 * @param {Object} res - Response de Express
 * @param {Error} error
 */
function adapterError(res, error) {
    debug('[API] Error del adapter:', error);
    if (error.code === 'INVALID') {
        res.status(400).json({ success: false, error: error.message });
    } else if (error.code === 'CONFIG_REJECTED') {
        res.status(502).json({ success: false, error: error.message });
    } else {
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
}

/**
 * GET /api/cameras/
 *
 * Listado rápido de cámaras: SOLO cameras.json + estadísticas de la BD
 * (SQLite) + estado MQTT en memoria. NO sondea los dispositivos (sin
 * probes HTTP a los CGI, sin campos `status` ni `latest_video`), así
 * responde en ms sin depender de la latencia de las cámaras. Es el contrato
 * clásico de GET /cameras (pre-enriquecimiento con estado real); los campos
 * de dispositivo (status, latest_video) solo los trae GET /cameras/status.
 */
router.get('/cameras', (req, res) => {
    try {
        const cameras = registry.getAllCameras();

        // Índices de estadísticas por ftp_dir (camera_name en la BD)
        const statsByCamera = {};
        getCameraStats().forEach(row => {
            statsByCamera[row.camera_name] = row;
        });

        const data = cameras.map(cam => {
            const stats = statsByCamera[cam.ftp_dir];
            const mqttState = mqttClient.getCameraMqttState(cam.id);
            return {
                id: cam.id,
                name: cam.name,
                host: cam.host,
                ecosystem: registry.getEcosystem(cam),
                ftp_dir: cam.ftp_dir,
                capabilities: cam.capabilities,
                has_videos: stats ? stats.count > 0 : false,
                video_count: stats ? stats.count : 0,
                last_video: stats ? stats.last_video : null,
                mqtt: mqttState
                    ? { online: mqttState.online, lastSeen: mqttState.lastSeen }
                    : null
            };
        });

        res.json({
            success: true,
            count: data.length,
            data
        });
    } catch (error) {
        // El error completo se logea en el servidor; el cliente solo recibe un
        // mensaje genérico (no exponemos error.message para no filtrar info
        // interna).
        debug('[API] Error al obtener cámaras (list):', error);
        res.status(500).json({ success: false, error: 'error interno' });
    }
});

/**
 * GET /api/cameras/status
 *
 * Listado completo: las cámaras de cameras.json (orden de archivo) con
 * estadísticas de la BD (la BD guarda camera_name = ftp_dir) + dos campos
 * de dispositivo por cámara:
 *  - status: para las cámaras con adapter (yi-hack), el MISMO objeto que
 *    devuelve GET /cameras/:id/status (state, http, mqtt, status,
 *    camera_config, system_config, sd, video_count, last_video,
 *    push_enabled, last_event, last_motion); para el resto, null (el NVR no
 *    puede saber si está encendida). Las cámaras con adapter se sondean en
 *    paralelo (3 probes HTTP de 3 s cada una, con caché TTL por cámara,
 *    ver adapters/yi-hack.js), así la latencia ≈ el probe más lento, no la
 *    suma de las N.
 *  - latest_video: último clip de la cámara (ROW_NUMBER por cámara en UN
 *    solo query a la BD) con las mismas URLs que GET /api/videos
 *    (videoWithUrls); null si no tiene clips.
 */
router.get('/cameras/status', async (req, res) => {
    try {
        const cameras = registry.getAllCameras();

        // Índices de estadísticas por ftp_dir (camera_name en la BD)
        const statsByCamera = {};
        getCameraStats().forEach(row => {
            statsByCamera[row.camera_name] = row;
        });

        // Último clip de cada cámara en UN SOLO query (ROW_NUMBER por
        // camera_name; ver database.getLatestVideosByCamera)
        const latestByCamera = {};
        getLatestVideosByCamera(cameras.map(cam => cam.ftp_dir)).forEach(row => {
            latestByCamera[row.camera_name] = row;
        });

        // Estado real de las cámaras con adapter en paralelo: cada
        // buildCameraStatus hace sus 3 probes HTTP en paralelo (3 s de
        // timeout cada uno), y las cámaras corren entre sí en paralelo
        // también.
        const adapterCams = cameras.filter(cam => getCameraAdapter(cam) !== null);
        const statusByCamera = {};
        const statusResults = await Promise.allSettled(
            adapterCams.map(cam => buildCameraStatus(cam))
        );
        statusResults.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                statusByCamera[adapterCams[i].id] = result.value;
            } else {
                // El error completo (objeto) se logea en el servidor con debug;
                // el cliente solo recibe un mensaje genérico.
                debug('[API] Error al obtener estado de', adapterCams[i].id, result.reason);
            }
        });

        const data = cameras.map(cam => {
            const stats = statsByCamera[cam.ftp_dir];
            const mqttState = mqttClient.getCameraMqttState(cam.id);
            const latest = latestByCamera[cam.ftp_dir];
            return {
                id: cam.id,
                name: cam.name,
                host: cam.host,
                ecosystem: registry.getEcosystem(cam),
                ftp_dir: cam.ftp_dir,
                capabilities: cam.capabilities,
                has_videos: stats ? stats.count > 0 : false,
                video_count: stats ? stats.count : 0,
                last_video: stats ? stats.last_video : null,
                mqtt: mqttState
                    ? { online: mqttState.online, lastSeen: mqttState.lastSeen }
                    : null,
                status: getCameraAdapter(cam) ? (statusByCamera[cam.id] || null) : null,
                latest_video: latest ? videoWithUrls(latest) : null
            };
        });

        res.json({
            success: true,
            count: data.length,
            data
        });
    } catch (error) {
        // El error completo se logea en el servidor; el cliente solo recibe un
        // mensaje genérico (no exponemos error.message para no filtrar info
        // interna).
        debug('[API] Error al obtener cámaras:', error);
        res.status(500).json({ success: false, error: 'error interno' });
    }
});

/**
 * POST /api/cameras/:id/reload
 *
 * Recarga el archivo cameras.json completo y revalida su contenido.
 * El :id se acepta pero el reload aplica a todo el archivo.
 * Éxito: 200 {success, reloaded, count}. Error de validación/parseo:
 * 400 {success, error} (el servidor NO cae; el estado en memoria se
 * mantiene con la última carga válida).
 */
router.post('/cameras/:id/reload', (req, res) => {
    try {
        const count = registry.reload();
        // Tras un reload, el cliente MQTT debe re-suscribir los temas de
        // entrada (las cámaras/suffixes pueden haber cambiado)
        try {
            mqttClient.syncSubscriptions();
        } catch (e) {
            console.error('[API] Error al re-suscribir temas MQTT tras reload:', e.message);
        }
        res.json({
            success: true,
            reloaded: true,
            count
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/group/power
 *
 * Debe registrarse ANTES de /cameras/:id/power (y de toda ruta /cameras/:id/...)
 * por orden de registro de path-to-regexp v8: si se invirtiera, "group" sería
 * capturado como :id y este endpoint devolvería 404.
 *
 * Cuerpo: {"cameraIds": ["oficina"], "enabled": true}
 * Enciende/apaga un grupo de cámaras (un setSwitchOn por cámara, vía
 * adapter). Devuelve un resumen por cámara: cada id se resuelve
 * independiente (404/409/400-host/fallo de fetch no abortan el resto).
 */
router.post('/cameras/group/power', async (req, res) => {
    const { cameraIds, enabled } = req.body || {};
    if (!Array.isArray(cameraIds) || cameraIds.length === 0) {
        return res.status(400).json({ success: false, error: 'cameraIds debe ser un array no vacío' });
    }
    // Cada elemento debe ser string y el array limitado (evita trabajo no
    // acotado: N búsquedas + N CGI).
    if (!cameraIds.every(id => typeof id === 'string')) {
        return res.status(400).json({ success: false, error: 'cada cameraId debe ser un string' });
    }
    if (cameraIds.length > 50) {
        return res.status(400).json({ success: false, error: 'cameraIds no puede tener más de 50 elementos' });
    }
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    const value = enabled ? 'yes' : 'no';
    const results = [];
    for (const id of cameraIds) {
        const cam = registry.getCameraById(id);
        const adapter = getCameraAdapter(cam);
        if (!cam) {
            results.push({ cameraId: id, success: false, error: 'cámara no encontrada' });
            continue;
        }
        if (!adapter) {
            results.push({ cameraId: id, success: false, error: unsupportedControlsMessage(cam) });
            continue;
        }
        if (!cam.host) {
            results.push({ cameraId: id, success: false, error: 'la cámara no tiene host configurado' });
            continue;
        }
        try {
            await adapter.setSwitchOn(cam, value);
            results.push({ cameraId: id, success: true, value });
        } catch (error) {
            debug('[API] Error en group/power para', id, error);
            results.push({
                cameraId: id,
                success: false,
                error: error.code === 'CONFIG_REJECTED' ? error.message : 'cámara no alcanzable'
            });
        }
    }
    res.json({
        success: true,
        results,
        value
    });
});

/**
 * POST /api/cameras/:id/power
 *
 * Cuerpo: {"enabled": true} — enciende/apaga la cámara (switch_on yes/no).
 */
router.post('/cameras/:id/power', async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    const r = resolveControl(req, res, 'setSwitchOn');
    if (!r) return;
    try {
        await r.adapter.setSwitchOn(r.cam, enabled);
    } catch (error) {
        return adapterError(res, error);
    }
    res.json({ success: true, applied: true, key: 'switch_on', value: enabled ? 'yes' : 'no' });
});

/**
 * POST /api/cameras/:id/led
 *
 * Cuerpo: {"enabled": true} — enciende/apaga el LED de la cámara.
 */
router.post('/cameras/:id/led', async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    const r = resolveControl(req, res, 'setLed');
    if (!r) return;
    try {
        await r.adapter.setLed(r.cam, enabled);
    } catch (error) {
        return adapterError(res, error);
    }
    res.json({ success: true, applied: true, key: 'led', value: enabled ? 'yes' : 'no' });
});

/**
 * POST /api/cameras/:id/night-vision
 *
 * Cuerpo: {"enabled": true} — enciende/apaga el IR-cut (visión nocturna).
 */
router.post('/cameras/:id/night-vision', async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    const r = resolveControl(req, res, 'setIr');
    if (!r) return;
    try {
        await r.adapter.setIr(r.cam, enabled);
    } catch (error) {
        return adapterError(res, error);
    }
    res.json({ success: true, applied: true, key: 'ir', value: enabled ? 'yes' : 'no' });
});

/**
 * POST /api/cameras/:id/rec-mode
 *
 * Cuerpo: {"mode": "motion"} — grabación por movimiento (save_video_on_motion).
 * "motion" → on; "off" → off; cualquier otro valor → 400.
 */
router.post('/cameras/:id/rec-mode', async (req, res) => {
    const { mode } = req.body || {};
    if (mode !== 'motion' && mode !== 'off') {
        return res.status(400).json({ success: false, error: 'mode debe ser "motion" u "off"' });
    }
    const r = resolveControl(req, res, 'setSaveVideoOnMotion');
    if (!r) return;
    try {
        await r.adapter.setSaveVideoOnMotion(r.cam, mode === 'motion');
    } catch (error) {
        return adapterError(res, error);
    }
    res.json({
        success: true,
        applied: true,
        key: 'save_video_on_motion',
        value: mode === 'motion' ? 'yes' : 'no'
    });
});

/**
 * POST /api/cameras/:id/command
 *
 * Cuerpo: {"command": "rotate", "value": "on"} — comando genérico validado
 * contra la whitelist del adapter (COMMAND_VALUES, no se duplica aquí).
 * Comando no soportado o valor inválido → 400 (mensaje del adapter).
 */
router.post('/cameras/:id/command', async (req, res) => {
    const { command, value } = req.body || {};
    if (typeof command !== 'string' || command === '') {
        return res.status(400).json({ success: false, error: 'command debe ser un string no vacío' });
    }
    if (typeof value !== 'string' || value === '') {
        return res.status(400).json({ success: false, error: 'value debe ser un string no vacío' });
    }
    const r = resolveControl(req, res, 'setCommand');
    if (!r) return;
    try {
        await r.adapter.setCommand(r.cam, command, value);
    } catch (error) {
        return adapterError(res, error);
    }
    res.json({ success: true, applied: true, key: command, value });
});

module.exports = router;
