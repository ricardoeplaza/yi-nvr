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
const { setCameraPushEnabled } = require('../database');
const {
    fetchCameraJson,
    buildCameraStatus
} = require('../camera-status-service');

const router = express.Router();

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
        if (registry.getEcosystem(cam) === 'yi-hack' && !cam.host) {
            return res.status(400).json({ success: false, error: 'la cámara no tiene host configurado' });
        }

        // La composición del estado (probes HTTP en paralelo, registry
        // MQTT, datos del NVR) vive en camera-status-service.js y se
        // comparte con GET /cameras (campo `status` de cada yi-hack).
        res.json({ success: true, data: await buildCameraStatus(cam) });
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
