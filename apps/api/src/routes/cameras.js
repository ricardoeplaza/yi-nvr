/**
 * routes/cameras.js
 *
 * Router de la API para la gestión de cámaras (se monta en /api).
 *
 * Endpoints:
 *  - GET /cameras           - Lista de cámaras registradas con estadísticas de videos
 *  - POST /cameras/:id/reload - Recarga el archivo cameras.json completo
 *
 * Nota: el :id de reload se acepta para simetría de la API, pero la recarga
 * aplica a TODO el archivo de configuración (no a una sola cámara).
 */

const express = require('express');
const registry = require('../camera-registry');
const { getCameraStats } = require('../database');

const router = express.Router();

/**
 * GET /api/cameras
 *
 * Obtiene las cámaras registradas en cameras.json (en orden de archivo)
 * enriquecidas con estadísticas de la BD (la BD guarda camera_name = ftp_dir).
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
            return {
                id: cam.id,
                name: cam.name,
                host: cam.host,
                capabilities: cam.capabilities,
                has_videos: stats ? stats.count > 0 : false,
                video_count: stats ? stats.count : 0,
                last_video: stats ? stats.last_video : null
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
        res.json({
            success: true,
            reloaded: true,
            count
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

module.exports = router;
