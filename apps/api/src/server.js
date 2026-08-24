/**
 * server.js
 *
 * Punto de entrada principal de la aplicación.
 *
 * Este archivo arranca tres servicios:
 *  1. Servidor FTP (ftp.js) - Para recepción de videos desde las cámaras.
 *  2. Servidor Web Express - API REST + Frontend estático.
 *  3. Cliente MQTT (mqtt/client.js) - Eventos y comandos de las cámaras
 *     yi-hack. Degradación elegante: sin broker, HTTP/FTP siguen vivos.
 *
 * API Endpoints (routers en src/routes/):
 *  - GET /api/health          - Estado del servicio (DB + FTP)
 *  - GET /api/videos          - Lista de videos con filtros
 *  - GET /api/videos/:id      - Detalle de un video específico
 *  - DELETE /api/videos/:id   - Elimina un video y sus archivos
 *  - GET /api/cameras         - Lista de cámaras registradas con estadísticas
 *  - POST /api/cameras/:id/reload - Recarga cameras.json
 *  - POST /api/cameras/:id/{power,led,night-vision,rec-mode} - Comandos MQTT
 *  - POST /api/cameras/:id/command - Comando MQTT genérico (whitelist)
 *  - POST /api/cameras/group/power - Comando MQTT a un grupo de cámaras
 *  - GET /api/cameras/:id/status - Estado real (proxy HTTP a los CGI yi-hack)
 *  - POST /api/cameras/:id/reboot - Reinicia la cámara (CGI reboot.sh)
 *  - POST /api/cameras/:id/httpd  - HTTPD yes/no (aplicado en el siguiente boot)
 *  - POST /api/cameras/:id/push   - Push de movimiento de la cámara (NVR)
 *  - GET /api/timeline        - Datos agregados para el timeline
 *  - GET /api/cameras/:id/stream - URLs de streaming (WebRTC/MSE) vía go2rtc
 *  - GET /api/push/vapid-public-key - Clave pública VAPID (o null)
 *  - POST /api/push/subscribe - Suscribe un endpoint Web Push
 *  - POST /api/push/unsubscribe - Quita una suscripción por endpoint
 *  - GET /api/cameras/:id/storage - Info SD + directorios de eventos (yi-hack)
 *  - DELETE /api/cameras/:id/storage/files - Borrar archivo de evento
 *  - DELETE /api/cameras/:id/storage/dirs - Borrar directorio de eventos
 *  - POST /api/cameras/:id/storage/purge - Purge por scope (all/last/range)
 *  - GET /api/cameras/:id/storage/ftp - Config push FTP
 *  - POST /api/cameras/:id/storage/ftp - Escribir config push FTP
 *
 * Web Push (fase 4): los triggers son el evento `camera-motion` del cliente
 * MQTT (notify inmediato, salvo que el push de esa cámara esté desactivado
 * en camera_settings) y el clip indexado en ftp.js. Sin claves VAPID el
 * módulo push funciona en modo noop (no envía, no falla).
 *
 * Proxy go2rtc (live view):
 *  - /stream-proxy/* → GO2RTC_URL (env, default http://go2rtc:1984)
 *    Si go2rtc no está corriendo (normal en dev), responde 502 JSON sin
 *    tumbar el proceso. Montado tras las rutas API y los estáticos.
 *
 * El frontend se sirve desde /public como archivos estáticos.
 * Los videos procesados se sirven desde /storage/processed.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
require('dotenv').config();

// Cargamos el registro de cámaras ANTES de cualquier otro módulo que lo
// use (ftp.js lo requiere). Si cameras.json es inválido al arranque,
// salimos con código de error y un log claro.
try {
    require('./camera-registry');
} catch (e) {
    console.error('[Registry] No se pudo cargar cameras.json:', e.message);
    process.exit(1);
}

// go2rtc (live view): `infra/go2rtc/go2rtc.yaml` es MANUAL (lo mantiene el
// usuario; plantilla en infra/go2rtc/go2rtc.yaml.example, ver D17 en
// docs/ARCHITECTURE.md). El API no lo genera ni lo toca: solo lo consume
// go2rtc y el proxy /stream-proxy/* de abajo.
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { startFtpServer, isFtpListening } = require('./ftp');
const { db } = require('./database');
const mqttClient = require('./mqtt/client');

const videosRouter = require('./routes/videos');
const camerasRouter = require('./routes/cameras');
const cameraStatusRouter = require('./routes/camera-status');
const timelineRouter = require('./routes/timeline');
const streamRouter = require('./routes/stream');
const pushRouter = require('./routes/push');
const storageRouter = require('./routes/storage');
const webpush = require('./push/webpush');
const cameraRegistry = require('./camera-registry');
const { getCameraSetting } = require('./database');

// Configuración
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// go2rtc (live view): URL del sidecar. Dev nativo: http://127.0.0.1:1984
const GO2RTC_URL = process.env.GO2RTC_URL || 'http://go2rtc:1984';

// Directorio de almacenamiento (override vía env para Docker; por defecto src/storage)
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(__dirname, 'storage');

// Creamos la aplicación Express
const app = express();

// Middleware para parsear JSON
app.use(express.json());

// ============================================
// SERVICIO DE ARCHIVOS ESTÁTICOS
// ============================================

// Frontend: servimos los archivos de /public
app.use(express.static(path.join(__dirname, 'public')));

// Videos procesados: servimos thumbnails y previews
app.use('/processed', express.static(path.join(STORAGE_DIR, 'processed')));

// Videos originales: servimos los .mp4 recibidos por FTP
app.use('/videos', express.static(path.join(STORAGE_DIR, 'ftp')));

// ============================================
// API REST - HEALTH
// ============================================

/**
 * GET /api/health
 *
 * Estado del servicio: uptime, base de datos (SELECT 1) y servidor FTP.
 * Si DB o FTP fallan, responde 503.
 */
app.get('/api/health', (req, res) => {
    let dbStatus = 'ok';
    try {
        db.prepare('SELECT 1').get();
    } catch (e) {
        dbStatus = 'error';
    }

    const ftpStatus = isFtpListening() ? 'listening' : 'down';
    const mqttStatus = mqttClient.isConnected() ? 'connected' : 'disconnected';
    const healthy = dbStatus === 'ok' && ftpStatus === 'listening';

    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'error',
        uptime: process.uptime(),
        db: dbStatus,
        ftp: ftpStatus,
        // Informativo: el broker MQTT caído NO degrada la salud del servicio
        mqtt: mqttStatus
    });
});

// ============================================
// API REST - ROUTERS
// ============================================

app.use('/api', videosRouter);
app.use('/api', camerasRouter);
app.use('/api', cameraStatusRouter);
app.use('/api', timelineRouter);
app.use('/api', streamRouter);
app.use('/api', pushRouter);
app.use('/api', storageRouter);

// ============================================
// WEB PUSH - TRIGGER DE MOVIMIENTO (fase 4)
// ============================================

// Escuchamos el bus del cliente MQTT (NO acoplado dentro de mqtt/client.js):
// cada evento de movimiento dispara una notificación push inmediata.
// notify() es a prueba de fallos (no lanza), pero lo envolvemos igualmente
// para que ningún error de este handler tume el pipeline de eventos.
mqttClient.mqttEvents.on('camera-motion', ({ cameraId, eventType }) => {
    try {
        // Toggle de push por cámara (camera_settings; default: activado)
        if (!getCameraSetting(cameraId).push_enabled) {
            return;
        }
        const camera = cameraRegistry.getCameraById(cameraId);
        const cameraName = camera ? camera.name : cameraId;
        console.log(`[Push] Movimiento de ${cameraId} (${eventType}), notificando`);
        webpush.notify({
            title: 'Movimiento',
            body: cameraName,
            url: `/cameras/${cameraId}`
        });
    } catch (e) {
        console.error('[Push] Error en el trigger de movimiento:', e.message);
    }
});

// ============================================
// PROXY go2rtc (live view)
// ============================================

// Proxy HTTP a go2rtc. Montado DESPUÉS de las rutas API y los
// estáticos (más adelante el fallback del SPA irá después de este bloque).
// Si go2rtc no está corriendo (caso normal en dev), las peticiones a
// /stream-proxy/* responden 502 JSON y el proceso sigue vivo.
const streamProxy = createProxyMiddleware({
    target: GO2RTC_URL,
    changeOrigin: true,
    on: {
        // go2rtc devuelve Location absolutas en algunas redirecciones (p.ej.
        // 301 a /api/stream.m3u8?src=...&mp4 con el stream aún no listo):
        // añadimos el prefijo de montaje para que el navegador siga por el proxy.
        proxyRes: (proxyRes) => {
            const loc = proxyRes.headers['location'];
            if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith('/stream-proxy/')) {
                proxyRes.headers['location'] = `/stream-proxy${loc}`;
            }
        },
        // Sustituye al error-response por defecto de http-proxy-middleware:
        // logueamos y respondemos 502 JSON.
        error: (err, req, res) => {
            console.error(`[Proxy] go2rtc unreachable (${GO2RTC_URL}):`, err.message);
            if (res && typeof res.writeHead === 'function' && !res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'go2rtc unreachable' }));
            }
        }
    }
});

app.use('/stream-proxy', streamProxy);

// El proxy llama a next(err) al fallar: si ya respondimos 502 (on.error),
// se traga el error; si no, responde 502 JSON. El resto, al handler default.
app.use((err, req, res, next) => {
    if (req.originalUrl.startsWith('/stream-proxy')) {
        if (!res.headersSent) {
            res.status(502).json({ success: false, error: 'go2rtc unreachable' });
        }
        return;
    }
    next(err);
});

// ============================================
// INICIO DE SERVICIOS
// ============================================

async function startServices() {
    try {
        // Iniciamos el servidor FTP para recepción de videos
        await startFtpServer();

        // Iniciamos el servidor web Express
        const server = app.listen(PORT, HOST, () => {
            console.log(`[Server] API Web iniciada en http://${HOST}:${PORT}`);
            console.log(`[Server] Endpoints disponibles:`);
            console.log(`         GET /api/health`);
            console.log(`         GET /api/videos`);
            console.log(`         GET /api/videos/:id`);
            console.log(`         GET /api/cameras`);
            console.log(`         POST /api/cameras/:id/reload`);
            console.log(`         POST /api/cameras/:id/{power,led,night-vision,rec-mode}`);
            console.log(`         POST /api/cameras/:id/command`);
            console.log(`         POST /api/cameras/group/power`);
            console.log(`         GET /api/cameras/:id/status`);
            console.log(`         POST /api/cameras/:id/{reboot,httpd,push}`);
            console.log(`         GET /api/timeline`);
            console.log(`         GET /api/cameras/:id/stream`);
            console.log(`         GET /api/push/vapid-public-key`);
            console.log(`         POST /api/push/subscribe`);
            console.log(`         POST /api/push/unsubscribe`);
            console.log(`         GET /api/cameras/:id/storage`);
            console.log(`         DELETE /api/cameras/:id/storage/{files,dirs}`);
            console.log(`         POST /api/cameras/:id/storage/purge`);
            console.log(`         GET/POST /api/cameras/:id/storage/ftp`);
            console.log(`         /stream-proxy/* → ${GO2RTC_URL}`);
        });

        // Job de limpieza de suscripciones push antiguas (diario, offset aleatorio)
        webpush.startCleanupJob();

        // Cliente MQTT: NO bloquea el listen. Si el broker no está disponible
        // (dev en Windows sin Mosquitto), el cliente se queda reintentando en
        // background con backoff exponencial y HTTP/FTP siguen funcionando.
        mqttClient.start(process.env.MQTT_BROKER_URL);

    } catch (err) {
        console.error('[Server] Error al iniciar servicios:', err.message);
        process.exit(1);
    }
}

// Manejamos el cierre graceful para liberar recursos
function shutdown(signal) {
    console.log(`[Server] Recibido ${signal}, cerrando servicios...`);
    mqttClient.stop();
    webpush.stopCleanupJob();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Iniciamos la aplicación
startServices();
