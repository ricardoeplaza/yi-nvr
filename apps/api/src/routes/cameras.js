/**
 * routes/cameras.js
 *
 * Router de la API para la gestión de cámaras (se monta en /api).
 *
 * Endpoints:
 *  - GET /cameras           - Lista de cámaras registradas con estadísticas
 *                              de videos, status (yi-hack) y latest_video
 *  - POST /cameras/:id/reload - Recarga el archivo cameras.json completo
 *  - POST /cameras/group/power - Enciende/apaga un grupo de cámaras (MQTT)
 *  - POST /cameras/:id/power - Enciende/apaga la cámara (MQTT, switch_on yes/no)
 *  - POST /cameras/:id/led   - LED on/off (MQTT)
 *  - POST /cameras/:id/night-vision - IR-cut on/off (MQTT)
 *  - POST /cameras/:id/rec-mode - Grabación por movimiento on/off (MQTT)
 *  - POST /cameras/:id/command - Comando genérico con whitelist (MQTT)
 *
 * Nota: el :id de reload se acepta para simetría de la API, pero la recarga
 * aplica a TODO el archivo de configuración (no a una sola cámara).
 *
 * Comandos MQTT: éxito 200 {success, published, payload}; cámara desconocida
 * 404 {success:false, error}; broker desconectado 503; comando/valor/mode
 * inválido 400; cámara de ecosistema "generic" 409 (no admite controles).
 */

const express = require('express');
const registry = require('../camera-registry');
const { getCameraStats, getLatestVideosByCamera } = require('../database');
const mqttClient = require('../mqtt/client');
const commands = require('../mqtt/commands');
const { buildCameraStatus } = require('../camera-status-service');
const { videoWithUrls } = require('./videos');

const router = express.Router();

/**
 * Mapea un error de mqtt/commands.js al estado HTTP correspondiente.
 * @param {Error} error
 * @returns {number} - 404, 400 o 503
 */
function mqttErrorStatus(error) {
    switch (error.code) {
        case 'NOT_FOUND': return 404;
        case 'NOT_CONNECTED': return 503;
        case 'UNSUPPORTED_ECOSYSTEM': return 409;
        case 'NO_PREFIX':
        case 'INVALID':
        default: return 400;
    }
}

/**
 * GET /api/cameras
 *
 * Obtiene las cámaras registradas en cameras.json (en orden de archivo)
 * enriquecidas con estadísticas de la BD (la BD guarda camera_name =
 * ftp_dir). Campos ADITIVOS por cámara (no rompen consumidores antiguos):
 *  - status: para yi-hack, el MISMO objeto que devuelve
 *    GET /cameras/:id/status (state, http, mqtt, status, camera_config,
 *    system_config, sd, video_count, last_video, push_enabled, last_event,
 *    last_motion); para generic, null (el NVR no puede saber si está
 *    encendida). Las yi-hack se sondean en paralelo (probes HTTP de 3 s
 *    acotados por AbortSignal en cada una), así la latencia ≈ el probe más
 *    lento, no la suma de las N.
 *  - latest_video: último clip de la cámara (ROW_NUMBER por cámara en UN
 *    solo query a la BD) con las mismas URLs que GET /api/videos
 *    (videoWithUrls); null si no tiene clips.
 */
router.get('/cameras', async (req, res) => {
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

        // Estado real de las yi-hack en paralelo: cada buildCameraStatus
        // hace sus 3 probes HTTP en paralelo (3 s de timeout cada uno),
        // y las cámaras corren entre sí en paralelo también.
        const yiHackCams = cameras.filter(cam => registry.getEcosystem(cam) === 'yi-hack');
        const statusByCamera = {};
        const statusResults = await Promise.allSettled(
            yiHackCams.map(cam => buildCameraStatus(cam))
        );
        statusResults.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                statusByCamera[yiHackCams[i].id] = result.value;
            } else {
                console.error(`[API] Error al obtener estado de ${yiHackCams[i].id}:`,
                    result.reason && result.reason.message);
            }
        });

        const data = cameras.map(cam => {
            const stats = statsByCamera[cam.ftp_dir];
            const mqttState = mqttClient.getCameraMqttState(cam.id);
            const latest = latestByCamera[cam.ftp_dir];
            const ecosystem = registry.getEcosystem(cam);
            return {
                id: cam.id,
                name: cam.name,
                host: cam.host,
                ecosystem,
                ftp_dir: cam.ftp_dir,
                capabilities: cam.capabilities,
                has_videos: stats ? stats.count > 0 : false,
                video_count: stats ? stats.count : 0,
                last_video: stats ? stats.last_video : null,
                mqtt: mqttState
                    ? { online: mqttState.online, lastSeen: mqttState.lastSeen }
                    : null,
                status: ecosystem === 'yi-hack' ? (statusByCamera[cam.id] || null) : null,
                latest_video: latest ? videoWithUrls(latest) : null
            };
        });

        res.json({
            success: true,
            count: data.length,
            data
        });
    } catch (error) {
        console.error('[API] Error al obtener cámaras:', error.message);
        res.status(500).json({ success: false, error: error.message });
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
 * Cuerpo: {"cameraIds": ["oficina"], "enabled": true}
 * Enciende/apaga un grupo de cámaras (un comando MQTT por cámara).
 */
router.post('/cameras/group/power', (req, res) => {
    const { cameraIds, enabled } = req.body || {};
    if (!Array.isArray(cameraIds) || cameraIds.length === 0) {
        return res.status(400).json({ success: false, error: 'cameraIds debe ser un array no vacío' });
    }
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    try {
        const results = commands.setGroupPower(cameraIds, enabled);
        res.json({
            success: true,
            published: results.map(r => r.topic),
            payload: enabled ? 'yes' : 'no'
        });
    } catch (error) {
        res.status(mqttErrorStatus(error)).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/power
 *
 * Cuerpo: {"enabled": true} — enciende/apaga la cámara (switch_on yes/no).
 */
router.post('/cameras/:id/power', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    try {
        const { topic, payload } = commands.setPower(req.params.id, enabled);
        res.json({ success: true, published: topic, payload });
    } catch (error) {
        res.status(mqttErrorStatus(error)).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/led
 *
 * Cuerpo: {"enabled": true} — enciende/apaga el LED de la cámara.
 */
router.post('/cameras/:id/led', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    try {
        const { topic, payload } = commands.setLed(req.params.id, enabled);
        res.json({ success: true, published: topic, payload });
    } catch (error) {
        res.status(mqttErrorStatus(error)).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/night-vision
 *
 * Cuerpo: {"enabled": true} — enciende/apaga el IR-cut (visión nocturna).
 */
router.post('/cameras/:id/night-vision', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled debe ser booleano' });
    }
    try {
        const { topic, payload } = commands.setIrcut(req.params.id, enabled);
        res.json({ success: true, published: topic, payload });
    } catch (error) {
        res.status(mqttErrorStatus(error)).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/rec-mode
 *
 * Cuerpo: {"mode": "motion"} — grabación por movimiento (save_video_on_motion).
 * "motion" → on; "off" → off; cualquier otro valor → 400.
 */
router.post('/cameras/:id/rec-mode', (req, res) => {
    const { mode } = req.body || {};
    if (mode !== 'motion' && mode !== 'off') {
        return res.status(400).json({ success: false, error: 'mode debe ser "motion" u "off"' });
    }
    try {
        const { topic, payload } = commands.setSaveVideoOnMotion(req.params.id, mode === 'motion');
        res.json({ success: true, published: topic, payload });
    } catch (error) {
        res.status(mqttErrorStatus(error)).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/cameras/:id/command
 *
 * Cuerpo: {"command": "rotate", "value": "on"} — comando genérico validado
 * contra la whitelist de mqtt/commands.js (COMMAND_VALUES). Comando no
 * soportado o valor inválido → 400.
 */
router.post('/cameras/:id/command', (req, res) => {
    const { command, value } = req.body || {};
    if (typeof command !== 'string' || command === '') {
        return res.status(400).json({ success: false, error: 'command debe ser un string no vacío' });
    }
    if (typeof value !== 'string' || value === '') {
        return res.status(400).json({ success: false, error: 'value debe ser un string no vacío' });
    }
    try {
        const { topic, payload } = commands.sendCommand(req.params.id, command, value);
        res.json({ success: true, published: topic, payload });
    } catch (error) {
        res.status(mqttErrorStatus(error)).json({ success: false, error: error.message });
    }
});

module.exports = router;
