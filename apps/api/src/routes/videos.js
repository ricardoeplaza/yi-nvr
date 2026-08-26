/**
 * routes/videos.js
 *
 * Router de la API para la gestión de videos (se monta en /api).
 *
 * Endpoints:
 *  - GET /videos    - Lista de videos con filtros
 *  - GET /videos/count - Cuenta de videos con los mismos filtros
 *  - GET /videos/:id - Detalle de un video específico
 *  - PATCH /videos/:id - Actualiza el nombre personalizado (name)
 *  - POST /videos/:id/favorite - Marca/desmarca un video como favorito
 *  - POST /videos/purge - Borra videos por retención/rango (excluye favoritos)
 *  - DELETE /videos/:id - Elimina un video y sus archivos físicos
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { getVideos, countVideos, purgeVideos, getVideoById, setVideoFavorite, updateVideo, deleteVideo } = require('../database');
const { DATA_DIR, RECORDINGS_DIR } = require('../paths');

// Retención de purge: mismos valores que el frontend (storage.page.ts).
const SCOPE_MS = {
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000
};

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
 * Añade a una fila de video sus URLs accesibles y favorite como booleano.
 * @param {Object} video - Fila de la tabla videos
 * @returns {Object} - La misma fila enriquecida
 */
function videoWithUrls(video) {
    return {
        ...video,
        favorite: Boolean(video.favorite),
        original_url: buildOriginalUrl(video.original_path),
        thumbnail_url: video.thumbnail_path ? `/processed/${path.basename(video.thumbnail_path)}` : null,
        preview_url: video.preview_path ? `/processed/${path.basename(video.preview_path)}` : null
    };
}

/**
 * Construye el objeto de filtros de BD a partir de los query params
 * comunes de GET /videos y GET /videos/count.
 * @param {Object} query - req.query
 * @returns {Object} - Filtros para getVideos/countVideos
 */
function filtersFromQuery(query) {
    const { camera, startDate, endDate, limit, offset, q, favorite } = query;
    const filters = {};
    if (camera) filters.camera = camera;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;
    if (q) filters.q = q;
    if (favorite === '0' || favorite === '1') filters.favorite = Number(favorite);
    if (limit) {
        const parsed = parseInt(limit, 10);
        if (!isNaN(parsed) && parsed > 0) filters.limit = parsed;
    }
    if (offset) {
        const parsed = parseInt(offset, 10);
        if (!isNaN(parsed) && parsed >= 0) filters.offset = parsed;
    }
    return filters;
}

/**
 * GET /api/videos
 *
 * Obtiene la lista de videos con soporte para filtros.
 * Query params opcionales:
 *  - camera: Filtrar por nombre de cámara
 *  - startDate: Fecha inicio (ISO 8601)
 *  - endDate: Fecha fin (ISO 8601)
 *  - q: Búsqueda de texto en name y camera_name
 *  - favorite: 0 o 1 (solo favoritos / solo no favoritos)
 *  - limit: Límite de resultados (default: 100)
 *  - offset: Desplazamiento para paginación
 */
router.get('/videos', (req, res) => {
    try {
        const filters = filtersFromQuery(req.query);
        const videos = getVideos(filters);

        // Añadimos URLs accesibles para cada video
        const videosWithUrls = videos.map(videoWithUrls);

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
 * GET /api/videos/count
 *
 * Cuenta los videos que cumplen los mismos query params que GET /api/videos
 * (camera, startDate, endDate, q, favorite).
 * IMPORTANTE: debe registrarse ANTES que GET /videos/:id para que 'count'
 * no se capture como :id.
 */
router.get('/videos/count', (req, res) => {
    try {
        const filters = filtersFromQuery(req.query);
        const count = countVideos(filters);
        res.json({ success: true, count });
    } catch (error) {
        console.error('[Videos] Error al contar videos:', error.message);
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
            favorite: Boolean(video.favorite),
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
 * PATCH /api/videos/:id
 *
 * Actualiza el nombre personalizado del video.
 * Body: { "name": string | null } — máx 200 caracteres; '' o null limpia
 * el nombre (guarda NULL).
 */
router.patch('/videos/:id', (req, res) => {
    try {
        const { name } = req.body || {};

        let cleanName;
        if (name === null || name === undefined || name === '') {
            cleanName = null;
        } else if (typeof name !== 'string' || name.length > 200) {
            return res.status(400).json({ success: false, error: 'name debe ser un string de máximo 200 caracteres' });
        } else {
            cleanName = name;
        }

        const id = parseInt(req.params.id, 10);
        const video = getVideoById(id);

        if (!video) {
            return res.status(404).json({ success: false, error: 'Video no encontrado' });
        }

        updateVideo(id, { name: cleanName });
        const updated = getVideoById(id);

        console.log(`[Videos] Nombre actualizado para video ${id}: ${cleanName}`);
        res.json({ success: true, video: videoWithUrls(updated) });
    } catch (error) {
        console.error('[Videos] Error al actualizar nombre:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/videos/purge
 *
 * Borra videos por retención, excluyendo SIEMPRE los favoritos.
 * Body: { scope: 'day' | 'week' | 'month' | 'range', from?: string, to?: string }
 *  - day/week/month: borra lo anterior a (now - SCOPE_MS[scope])
 *  - range: borra en [from, to] (ISO 8601, ambos inclusivos)
 * Respuesta: { success, expected, purged: string[], failed: string[] }
 * (purged/failed contienen los ids de los videos).
 */
router.post('/videos/purge', (req, res) => {
    try {
        const { scope, from, to } = req.body || {};

        let range;
        if (scope === 'day' || scope === 'week' || scope === 'month') {
            // Retención: se borra todo lo ANTERIOR al corte, nunca el último periodo.
            range = {
                from: new Date(0).toISOString(),
                to: new Date(Date.now() - SCOPE_MS[scope]).toISOString()
            };
        } else if (scope === 'range') {
            const fromMs = Date.parse(from);
            const toMs = Date.parse(to);
            if (typeof from !== 'string' || typeof to !== 'string' || isNaN(fromMs) || isNaN(toMs)) {
                return res.status(400).json({ success: false, error: 'scope range requiere from y to como fechas ISO válidas' });
            }
            range = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
        } else {
            return res.status(400).json({ success: false, error: 'scope inválido (day, week, month o range)' });
        }

        // purgeVideos ya excluye favoritos y borra las filas de la BD;
        // devuelve las filas para eliminar sus archivos físicos.
        const candidates = purgeVideos(range);
        const expected = candidates.length;
        const purged = [];
        const failed = [];

        candidates.forEach(video => {
            let ok = true;
            [video.original_path, video.thumbnail_path, video.preview_path].forEach(filePath => {
                if (!filePath) {
                    return;
                }
                const marker = filePath.includes(path.sep + 'processed') ? 'processed' : 'ftp';
                const resolved = resolveStoredPath(filePath, marker);
                if (fs.existsSync(resolved)) {
                    try {
                        fs.unlinkSync(resolved);
                    } catch (err) {
                        console.error(`[Videos] Error eliminando archivo ${resolved}:`, err.message);
                        ok = false;
                    }
                }
            });
            (ok ? purged : failed).push(String(video.id));
            console.log(`[Videos] Purge: video ${video.id} ${ok ? 'purgeado' : 'con errores en archivos'}`);
        });

        res.json({ success: true, expected, purged, failed });
    } catch (error) {
        console.error('[Videos] Error al purgar videos:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/videos/:id/favorite
 *
 * Marca o desmarca un video como favorito.
 * Body: { "favorite": true | false }
 */
router.post('/videos/:id/favorite', (req, res) => {
    try {
        const { favorite } = req.body || {};
        if (typeof favorite !== 'boolean') {
            return res.status(400).json({ success: false, error: 'favorite debe ser booleano' });
        }

        const id = parseInt(req.params.id, 10);
        const video = getVideoById(id);

        if (!video) {
            return res.status(404).json({ success: false, error: 'Video no encontrado' });
        }

        setVideoFavorite(id, favorite);

        res.json({ success: true, favorite });
    } catch (error) {
        console.error('[API] Error al cambiar favorito:', error.message);
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
