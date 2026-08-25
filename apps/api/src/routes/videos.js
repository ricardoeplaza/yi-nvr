/**
 * routes/videos.js
 *
 * Router de la API para la gestión de videos (se monta en /api).
 *
 * Endpoints:
 *  - GET /videos    - Lista de videos con filtros
 *  - GET /videos/:id - Detalle de un video específico
 *  - DELETE /videos/:id - Elimina un video y sus archivos físicos
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getVideos, getVideoById, deleteVideo } = require('../database');
const { DATA_DIR, RECORDINGS_DIR } = require('../paths');

// Directorios de almacenamiento (mismo criterio que server.js, vía paths.js)

const router = express.Router();

/**
 * Resuelve la ruta real de un archivo cuyo path guardado en la BD puede
 * apuntar a una ubicación anterior (el proyecto se renombró/movió y la BD
 * conserva rutas absolutas viejas). Si la ruta guardada no existe, se
 * remapea tomando los segmentos tras el último directorio `marker` ('ftp' o
 * 'processed') y colocándolos bajo la raíz de almacenamiento actual.
 * @param {string} storedPath - Ruta absoluta guardada en la BD
 * @param {string} marker - Nombre del subdirectorio de referencia ('ftp' | 'processed')
 * @returns {string} - Ruta resuelta (puede no existir en disco)
 */
function resolveStoredPath(storedPath, marker) {
    if (fs.existsSync(storedPath)) {
        return storedPath;
    }
    const baseDir = marker === 'ftp' ? RECORDINGS_DIR : path.join(DATA_DIR, marker);
    const parts = path.normalize(storedPath).split(path.sep);
    const idx = parts.lastIndexOf(marker);
    if (idx >= 0 && idx < parts.length - 1) {
        return path.join(baseDir, ...parts.slice(idx + 1));
    }
    return path.join(baseDir, path.basename(storedPath));
}

/**
 * Construye la URL /videos/... de un original a partir de su path guardado.
 * @param {string} originalPath
 * @returns {string}
 */
function buildOriginalUrl(originalPath) {
    const rel = path.relative(RECORDINGS_DIR, resolveStoredPath(originalPath, 'ftp'));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return `/videos/${rel.split(path.sep).join('/')}`;
    }
    return `/videos/${path.basename(originalPath)}`;
}

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
router.get('/videos', (req, res) => {
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
            original_url: buildOriginalUrl(video.original_path),
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
router.get('/videos/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const video = getVideoById(id);

        if (!video) {
            return res.status(404).json({ success: false, error: 'Video no encontrado' });
        }

        // Añadimos URLs accesibles
        const videoWithUrls = {
            ...video,
            original_url: buildOriginalUrl(video.original_path),
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
router.delete('/videos/:id', (req, res) => {
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
            if (!filePath) {
                return;
            }
            // Resolvemos la ruta real (la BD puede guardar paths de una
            // ubicación anterior del proyecto)
            const marker = filePath.includes(path.sep + 'processed') ? 'processed' : 'ftp';
            const resolved = resolveStoredPath(filePath, marker);
            if (fs.existsSync(resolved)) {
                try {
                    fs.unlinkSync(resolved);
                    console.log(`[API] Archivo eliminado: ${resolved}`);
                } catch (err) {
                    console.error(`[API] Error eliminando archivo ${resolved}:`, err.message);
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

module.exports = router;
