/**
 * server.js
 * 
 * Punto de entrada principal de la aplicación.
 * 
 * Este archivo arranca dos servicios:
 *  1. Servidor FTP (ftp.js) - Para recepción de videos desde las cámaras.
 *  2. Servidor Web Express - API REST + Frontend estático.
 * 
 * API Endpoints:
 *  - GET /api/videos          - Lista de videos con filtros
 *  - GET /api/videos/:id      - Detalle de un video específico
 *  - GET /api/cameras         - Lista de cámaras disponibles
 *  - GET /api/timeline        - Datos agregados para el timeline
 * 
 * El frontend se sirve desde /public como archivos estáticos.
 * Los videos procesados se sirven desde /storage/processed.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const { startFtpServer } = require('./ftp');
const { getVideos, getVideoById, getAllCameras, getTimelineData, deleteVideo } = require('./database');

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
// API REST - ENDPOINTS
// ============================================

/**
 * GET /api/videos
 * 
 * Obtiene la lista de videos con soporte para filtros.
 * Query params opcionales:
 *  - camera: Filtrar por nombre de cámara
 *  - startDate: Fecha inicio (ISO 8601)
 *  - endDate: Fecha fin (ISO 8601)
 *  - limit: Límite de resultados (default: 100)
 */
app.get('/api/videos', (req, res) => {
    try {
        const { camera, startDate, endDate, limit } = req.query;
        
        const filters = {};
        if (camera) filters.camera = camera;
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;
        if (limit) filters.limit = parseInt(limit, 10);

        const videos = getVideos(filters);
        
        // Añadimos URLs accesibles para cada video
        const videosWithUrls = videos.map(video => ({
            ...video,
            original_url: `/videos/${path.relative(path.join(STORAGE_DIR, 'ftp'), video.original_path).replace(/\\/g, '/')}`,
            thumbnail_url: video.thumbnail_path ? `/processed/${path.basename(video.thumbnail_path)}` : null,
            preview_url: video.preview_path ? `/processed/${path.basename(video.preview_path)}` : null
        }));

        res.json({
            success: true,
            count: videosWithUrls.length,
            data: videosWithUrls
        });

    } catch (error) {
        console.error('[API] Error al obtener videos:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/videos/:id
 * 
 * Obtiene el detalle de un video específico por su ID.
 */
app.get('/api/videos/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const video = getVideoById(id);

        if (!video) {
            return res.status(404).json({ success: false, error: 'Video no encontrado' });
        }

        // Añadimos URLs accesibles
        const videoWithUrls = {
            ...video,
            original_url: `/videos/${path.relative(path.join(STORAGE_DIR, 'ftp'), video.original_path).replace(/\\/g, '/')}`,
            thumbnail_url: video.thumbnail_path ? `/processed/${path.basename(video.thumbnail_path)}` : null,
            preview_url: video.preview_path ? `/processed/${path.basename(video.preview_path)}` : null
        };

        res.json({
            success: true,
            data: videoWithUrls
        });

    } catch (error) {
        console.error('[API] Error al obtener video:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /api/videos/:id
 * 
 * Elimina un video específico por su ID.
 * También elimina los archivos físicos asociados (video original, thumbnail y preview).
 */
app.delete('/api/videos/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        
        // Obtenemos el video para saber qué archivos eliminar
        const video = getVideoById(id);
        
        if (!video) {
            return res.status(404).json({ success: false, error: 'Video no encontrado' });
        }
        
        // Eliminamos los archivos físicos si existen
        const filesToDelete = [
            video.original_path,
            video.thumbnail_path,
            video.preview_path
        ];
        
        filesToDelete.forEach(filePath => {
            if (filePath && fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                    console.log(`[API] Archivo eliminado: ${filePath}`);
                } catch (err) {
                    console.error(`[API] Error eliminando archivo ${filePath}:`, err.message);
                }
            }
        });
        
        // Eliminamos el registro de la base de datos
        const deleted = deleteVideo(id);
        
        if (deleted) {
            res.json({
                success: true,
                message: 'Video eliminado correctamente'
            });
        } else {
            res.status(500).json({ success: false, error: 'No se pudo eliminar el video' });
        }
        
    } catch (error) {
        console.error('[API] Error al eliminar video:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/cameras
 * 
 * Obtiene la lista de cámaras que han enviado videos.
 */
app.get('/api/cameras', (req, res) => {
    try {
        const cameras = getAllCameras();
        res.json({
            success: true,
            count: cameras.length,
            data: cameras
        });
    } catch (error) {
        console.error('[API] Error al obtener cámaras:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/timeline
 * 
 * Obtiene datos agregados para mostrar un timeline en el frontend.
 * Agrupa videos por fecha y cámara.
 */
app.get('/api/timeline', (req, res) => {
    try {
        const timeline = getTimelineData();
        
        // Reorganizamos los datos para facilitar el consumo en el frontend
        const groupedByDate = {};
        timeline.forEach(item => {
            if (!groupedByDate[item.date]) {
                groupedByDate[item.date] = {
                    date: item.date,
                    total: 0,
                    cameras: {}
                };
            }
            groupedByDate[item.date].total += item.count;
            groupedByDate[item.date].cameras[item.camera_name] = item.count;
        });

        res.json({
            success: true,
            data: Object.values(groupedByDate)
        });

    } catch (error) {
        console.error('[API] Error al obtener timeline:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// SPA FALLBACK
// ============================================

// Para rutas no definidas en la API, servimos el index.html (SPA behavior)
// app.get('*', (req, res) => {
//     const indexPath = path.join(__dirname, 'public', 'index.html');
//     if (fs.existsSync(indexPath)) {
//         res.sendFile(indexPath);
//     } else {
//         res.status(404).send('Frontend not built. Please create public/index.html');
//     }
// });

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
            console.log(`         GET /api/videos`);
            console.log(`         GET /api/videos/:id`);
            console.log(`         GET /api/cameras`);
            console.log(`         GET /api/timeline`);
        });

    } catch (err) {
        console.error('[Server] Error al iniciar servicios:', err.message);
        process.exit(1);
    }
}

// Manejamos el cierre graceful para liberar recursos
process.on('SIGTERM', () => {
    console.log('[Server] Recibido SIGTERM, cerrando servicios...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[Server] Recibido SIGINT, cerrando servicios...');
    process.exit(0);
});

// Iniciamos la aplicación
startServices();
