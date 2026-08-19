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
 *  - GET /api/timeline        - Datos agregados para el timeline
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

const express = require('express');
const { startFtpServer, isFtpListening } = require('./ftp');
const { db } = require('./database');
const mqttClient = require('./mqtt/client');

const videosRouter = require('./routes/videos');
const camerasRouter = require('./routes/cameras');
const timelineRouter = require('./routes/timeline');

// Configuración
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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
app.use('/api', timelineRouter);

// ============================================
// INICIO DE SERVICIOS
// ============================================

async function startServices() {
    try {
        // Iniciamos el servidor FTP para recepción de videos
        await startFtpServer();

        // Iniciamos el servidor web Express
        app.listen(PORT, HOST, () => {
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
            console.log(`         GET /api/timeline`);
        });

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
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Iniciamos la aplicación
startServices();
