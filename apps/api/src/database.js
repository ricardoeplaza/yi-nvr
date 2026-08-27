/**
 * database.js
 * 
 * Módulo de gestión de la base de datos SQLite.
 * 
 * Aquí definimos el esquema y las operaciones CRUD para almacenar
 * los metadatos de los videos recibidos por FTP. Usamos better-sqlite3
 * porque es síncrono y extremadamente rápido, ideal para ARM.
 * 
 * Tabla principal: videos
 *  - id: Identificador único auto-incremental
 *  - camera_name: Nombre de la cámara (extraído del path o proporcionado)
 *  - name: Nombre personalizado asignado por el usuario (NULL si no se ha puesto)
 *  - timestamp: Fecha y hora del evento (ISO 8601)
 *  - original_path: Ruta absoluta del archivo .mp4 original
 *  - thumbnail_path: Ruta del thumbnail JPG generado
 *  - preview_path: Ruta del preview WebP animado
 *  - duration: Duración del video en segundos
 *  - file_size: Tamaño del archivo en bytes
 *  - favorite: Si el clip está marcado como favorito (0/1)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./paths');

// Ruta de almacenamiento persistente (exenta de OverlayFS en Armbian).
// DATA_DIR: <repo>/data en dev, /app/data en Docker (ver paths.js).
const DB_PATH = path.join(DATA_DIR, 'surveillance.db');

// Aseguramos que el directorio de almacenamiento exista
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Instancia de la base de datos (modo verbose opcional para debug)
const db = new Database(DB_PATH);

// Activamos foreign keys y WAL mode para mejor rendimiento en escritura concurrente
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Inicializa el esquema de la base de datos si no existe.
 * Creamos la tabla 'videos' con todos los campos necesarios.
 */
function initSchema() {
    const createTable = `
        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_name TEXT NOT NULL,
            name TEXT,
            timestamp TEXT NOT NULL,
            original_path TEXT NOT NULL UNIQUE,
            thumbnail_path TEXT,
            preview_path TEXT,
            duration REAL,
            file_size INTEGER,
            favorite INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;
    db.exec(createTable);

    // Migración defensiva: añade la columna favorite a BDs creadas antes de
    // que existiera (CREATE TABLE IF NOT EXISTS no altera tablas existentes).
    const videoCols = db.prepare('PRAGMA table_info(videos)').all().map(c => c.name);
    if (!videoCols.includes('favorite')) {
        db.exec('ALTER TABLE videos ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
    }
    if (!videoCols.includes('name')) {
        db.exec('ALTER TABLE videos ADD COLUMN name TEXT');
    }

    // Índices para búsquedas rápidas por cámara y fecha
    db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_camera ON videos(camera_name)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_timestamp ON videos(timestamp)`);

    // Eventos MQTT (movimiento reportado por las cámaras vía yi-hack).
    // camera_id: id de la cámara del registro (puede ser NULL si el prefix
    // ya no existe en cameras.json). payload: texto recibido de la cámara.
    const createMqttEvents = `
        CREATE TABLE IF NOT EXISTS mqtt_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            camera_id TEXT,
            event_type TEXT,
            payload TEXT,
            received_at TEXT
        )
    `;
    db.exec(createMqttEvents);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mqtt_events_camera ON mqtt_events(camera_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mqtt_events_received ON mqtt_events(received_at)`);

    // Suscripciones Web Push (fase 4): una fila por endpoint de push.
    // p256dh/auth: claves de cifrado de la suscripción (base64url).
    // last_used_at: última entrega exitosa (NULL = nunca entregada); se usa
    // en la limpieza de suscripciones antiguas.
    const createPushSubscriptions = `
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            endpoint TEXT PRIMARY KEY,
            p256dh TEXT,
            auth TEXT,
            user_agent TEXT,
            created_at TEXT,
            last_used_at TEXT
        )
    `;
    db.exec(createPushSubscriptions);

    // Ajustes dinámicos por cámara (estado del NVR, no de la cámara).
    // push_enabled: si el movimiento de esta cámara dispara notificaciones
    // Web Push (default 1 = sí, cuando no hay fila).
    const createCameraSettings = `
        CREATE TABLE IF NOT EXISTS camera_settings (
            camera_id TEXT PRIMARY KEY,
            push_enabled INTEGER NOT NULL DEFAULT 1
        )
    `;
    db.exec(createCameraSettings);
}

/**
 * Inserta un nuevo registro de video en la base de datos.
 * @param {Object} videoData - Objeto con los datos del video
 * @returns {Object} - El registro insertado con su ID
 */
function insertVideo(videoData) {
    const stmt = db.prepare(`
        INSERT INTO videos (camera_name, timestamp, original_path, thumbnail_path, preview_path, duration, file_size)
        VALUES (@camera_name, @timestamp, @original_path, @thumbnail_path, @preview_path, @duration, @file_size)
    `);
    
    const result = stmt.run(videoData);
    return { id: result.lastInsertRowid, ...videoData };
}

/**
 * Construye la cláusula WHERE y sus parámetros a partir de los filtros de
 * video compartidos por getVideos y countVideos.
 * @param {Object} filters - Filtros opcionales:
 *   camera (string), startDate/endDate (ISO 8601), q (texto libre, busca en
 *   name y camera_name), favorite (0 | 1, exacto)
 * @returns {{clause: string, params: Object}}
 */
function buildVideoFilterClause(filters = {}) {
    const conditions = ['1=1'];
    const params = {};

    if (filters.camera) {
        conditions.push('camera_name = @camera');
        params.camera = filters.camera;
    }

    if (filters.startDate) {
        conditions.push('timestamp >= @startDate');
        params.startDate = filters.startDate;
    }

    if (filters.endDate) {
        conditions.push('timestamp <= @endDate');
        params.endDate = filters.endDate;
    }

    if (filters.q) {
        conditions.push('(name LIKE @q OR camera_name LIKE @q)');
        params.q = `%${filters.q}%`;
    }

    if (filters.favorite !== undefined && filters.favorite !== null) {
        conditions.push('favorite = @favorite');
        params.favorite = Number(filters.favorite);
    }

    return { clause: conditions.join(' AND '), params };
}

/**
 * Obtiene videos filtrados por rango de fechas, cámara, texto y/o favorito.
 * @param {Object} filters - Filtros opcionales: camera, startDate, endDate,
 *   q (búsqueda en name/camera_name), favorite (0|1), limit, offset
 * @returns {Array} - Lista de videos ordenados por timestamp descendente
 */
function getVideos(filters = {}) {
    const { clause, params } = buildVideoFilterClause(filters);
    let query = `SELECT * FROM videos WHERE ${clause}`;

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
        query += ' LIMIT @limit';
        params.limit = filters.limit;
    }

    if (filters.offset) {
        query += ' OFFSET @offset';
        params.offset = filters.offset;
    }

    const stmt = db.prepare(query);
    return stmt.all(params);
}

/**
 * Cuenta los videos que cumplen los filtros (mismos que getVideos, sin
 * limit/offset).
 * @param {Object} filters - Filtros opcionales: camera, startDate, endDate,
 *   q, favorite
 * @returns {number} - Número de videos que cumplen los filtros
 */
function countVideos(filters = {}) {
    const { clause, params } = buildVideoFilterClause(filters);
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM videos WHERE ${clause}`);
    return stmt.get(params).count;
}

/**
 * Borra de la BD los videos NO favoritos dentro del rango [from, to]
 * (inclusivo) y devuelve las filas borradas (con sus paths) para que el
 * llamador elimine los archivos físicos.
 *
 * from/to: strings ISO 8601 UTC (p. ej. '2026-08-01T00:00:00.000Z'), el
 * mismo formato en el que se guarda la columna timestamp; la comparación
 * lexicográfica coincide con el orden cronológico. Ambos son OPCIONALES
 * (se requiere al menos uno):
 *  - from ausente → sin límite inferior
 *  - to ausente → sin límite superior
 *
 * SIEMPRE excluye los favoritos (favorite = 0).
 * @param {{from?: string, to?: string}} range - Rango de timestamps (inclusive)
 * @returns {Array} - Filas de videos borradas de la BD
 */
function purgeVideos({ from, to } = {}) {
    const conditions = ['favorite = 0'];
    const params = {};
    if (from !== undefined && from !== null) {
        conditions.push('timestamp >= @from');
        params.from = from;
    }
    if (to !== undefined && to !== null) {
        conditions.push('timestamp <= @to');
        params.to = to;
    }
    const select = db.prepare(`
        SELECT * FROM videos
        WHERE ${conditions.join(' AND ')}
    `);
    const videos = select.all(params);

    if (videos.length) {
        const removeMany = db.transaction(rows => {
            const del = db.prepare('DELETE FROM videos WHERE id = @id');
            rows.forEach(row => del.run({ id: row.id }));
        });
        removeMany(videos);
    }

    return videos;
}

/**
 * Obtiene un video específico por su ID.
 * @param {number} id - ID del video
 * @returns {Object|null} - El video encontrado o null
 */
function getVideoById(id) {
    const stmt = db.prepare('SELECT * FROM videos WHERE id = ?');
    return stmt.get(id) || null;
}

/**
 * Obtiene la lista de cámaras únicas que han enviado videos.
 * @returns {Array} - Lista de nombres de cámaras
 */
function getAllCameras() {
    const stmt = db.prepare('SELECT DISTINCT camera_name FROM videos ORDER BY camera_name');
    return stmt.all().map(row => row.camera_name);
}

/**
 * Obtiene estadísticas por cámara (camera_name): total de videos y el
 * timestamp del último video.
 * @returns {Array<{camera_name: string, count: number, last_video: string}>}
 */
function getCameraStats() {
    const stmt = db.prepare(`
        SELECT
            camera_name,
            COUNT(*) as count,
            MAX(timestamp) as last_video
        FROM videos
        GROUP BY camera_name
    `);
    return stmt.all();
}

/**
 * Último video de cada cámara en UN SOLO query (para el listado de
 * cámaras: N cámaras → 1 query, no N). ROW_NUMBER por camera_name
 * ordenado por timestamp DESC (id DESC como desempate) y se queda con
 * rn = 1 de cada cámara.
 * @param {string[]} cameraNames - ftp_dirs a consultar (camera_name en la BD)
 * @returns {Array} - Máximo una fila por cámara (sin la columna auxiliar rn)
 */
function getLatestVideosByCamera(cameraNames) {
    if (!Array.isArray(cameraNames) || cameraNames.length === 0) {
        return [];
    }
    const placeholders = cameraNames.map(() => '?').join(', ');
    const stmt = db.prepare(`
        SELECT id, camera_name, name, timestamp, original_path, thumbnail_path,
               preview_path, duration, file_size, favorite, created_at
        FROM (
            SELECT v.*,
                   ROW_NUMBER() OVER (
                       PARTITION BY v.camera_name
                       ORDER BY v.timestamp DESC, v.id DESC
                   ) AS rn
            FROM videos v
            WHERE v.camera_name IN (${placeholders})
        )
        WHERE rn = 1
    `);
    return stmt.all(...cameraNames);
}

/**
 * Actualiza un video existente (útil para añadir paths de thumbnail/preview después del procesamiento).
 * @param {number} id - ID del video
 * @param {Object} updates - Campos a actualizar
 */
function updateVideo(id, updates) {
    const fields = Object.keys(updates).map(key => `${key} = @${key}`).join(', ');
    const query = `UPDATE videos SET ${fields} WHERE id = @id`;
    const stmt = db.prepare(query);
    stmt.run({ ...updates, id });
}

/**
 * Marca o desmarca un video como favorito.
 * @param {number} id - ID del video
 * @param {boolean} favorite - true para marcar, false para desmarcar
 * @returns {boolean} - True si se actualizó, false si no existía
 */
function setVideoFavorite(id, favorite) {
    const stmt = db.prepare('UPDATE videos SET favorite = ? WHERE id = ?');
    const result = stmt.run(favorite ? 1 : 0, id);
    return result.changes > 0;
}

/**
 * Elimina un video de la base de datos por su ID.
 * @param {number} id - ID del video a eliminar
 * @returns {boolean} - True si se eliminó, false si no existía
 */
function deleteVideo(id) {
    const stmt = db.prepare('DELETE FROM videos WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
}

/**
 * Gets the video rows for the given ids (IN clause). Ids that do not exist
 * are simply not returned.
 * @param {number[]} ids - Video ids to look up
 * @returns {Array} - Matching video rows (with paths), at most one per id
 */
function bulkGetVideos(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return [];
    }
    const placeholders = ids.map(() => '?').join(', ');
    const stmt = db.prepare(`SELECT * FROM videos WHERE id IN (${placeholders})`);
    return stmt.all(...ids);
}

/**
 * Deletes the given video ids from the DB in a single transaction and
 * returns the deleted rows (with paths) so the caller can remove the
 * physical files. Ids that do not exist are ignored.
 * @param {number[]} ids - Video ids to delete
 * @returns {Array} - Deleted video rows (with paths), at most one per id
 */
function bulkDeleteVideos(ids) {
    const rows = bulkGetVideos(ids);
    if (rows.length === 0) {
        return [];
    }
    const removeMany = db.transaction(list => {
        const del = db.prepare('DELETE FROM videos WHERE id = ?');
        list.forEach(row => del.run(row.id));
    });
    removeMany(rows);
    return rows;
}

/**
 * Sets the favorite flag on multiple videos in a single transaction.
 * Ids that do not exist are ignored.
 * @param {number[]} ids - Video ids to update
 * @param {boolean} favorite - true to mark as favorite, false to unmark
 * @returns {number} - Number of rows actually updated (changes)
 */
function bulkSetFavorite(ids, favorite) {
    if (!Array.isArray(ids) || ids.length === 0) {
        return 0;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const run = db.transaction(() => {
        const stmt = db.prepare(`UPDATE videos SET favorite = ? WHERE id IN (${placeholders})`);
        return stmt.run(favorite ? 1 : 0, ...ids).changes;
    });
    return run();
}

// ============================================
// CRUD de suscripciones Web Push
// ============================================

/**
 * Inserta o reemplaza una suscripción de push (upsert por endpoint).
 * @param {Object} sub - {endpoint, p256dh, auth, userAgent}
 * @returns {Object} - La fila guardada
 */
function upsertPushSubscription(sub) {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, last_used_at)
        VALUES (@endpoint, @p256dh, @auth, @userAgent, @createdAt, NULL)
        ON CONFLICT(endpoint) DO UPDATE SET
            p256dh = excluded.p256dh,
            auth = excluded.auth,
            user_agent = COALESCE(excluded.user_agent, push_subscriptions.user_agent),
            created_at = push_subscriptions.created_at
    `);
    stmt.run({
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        userAgent: sub.userAgent || null,
        createdAt: now
    });
    return getPushSubscription(sub.endpoint);
}

/**
 * Obtiene una suscripción por su endpoint.
 * @param {string} endpoint
 * @returns {Object|null}
 */
function getPushSubscription(endpoint) {
    const stmt = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?');
    return stmt.get(endpoint) || null;
}

/**
 * Lista todas las suscripciones activas.
 * @returns {Array<Object>}
 */
function getAllPushSubscriptions() {
    const stmt = db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at');
    return stmt.all();
}

/**
 * Elimina una suscripción por su endpoint.
 * @param {string} endpoint
 * @returns {boolean} - true si existía
 */
function deletePushSubscription(endpoint) {
    const stmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
    const result = stmt.run(endpoint);
    return result.changes > 0;
}

/**
 * Borra las suscripciones cuyo último uso (o creación, si nunca se usaron)
 * es anterior a `maxAgeDays` días.
 * @param {number} maxAgeDays
 * @returns {number} - Número de filas borradas
 */
function deleteStalePushSubscriptions(maxAgeDays) {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
        DELETE FROM push_subscriptions
        WHERE COALESCE(last_used_at, created_at) < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
}

/**
 * Actualiza last_used_at de una suscripción (tras una entrega exitosa).
 * @param {string} endpoint
 */
function touchPushSubscription(endpoint) {
    const stmt = db.prepare(`
        UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?
    `);
    stmt.run(new Date().toISOString(), endpoint);
}

// ============================================
// Ajustes dinámicos por cámara (camera_settings)
// ============================================

/**
 * Obtiene el ajuste de push de una cámara (default: activado si no hay fila).
 * @param {string} cameraId
 * @returns {{push_enabled: boolean}}
 */
function getCameraSetting(cameraId) {
    const stmt = db.prepare('SELECT push_enabled FROM camera_settings WHERE camera_id = ?');
    const row = stmt.get(cameraId);
    return { push_enabled: row ? row.push_enabled === 1 : true };
}

/**
 * Guarda el ajuste de push de una cámara (upsert por camera_id).
 * @param {string} cameraId
 * @param {boolean} enabled
 */
function setCameraPushEnabled(cameraId, enabled) {
    const stmt = db.prepare(`
        INSERT INTO camera_settings (camera_id, push_enabled)
        VALUES (?, ?)
        ON CONFLICT(camera_id) DO UPDATE SET push_enabled = excluded.push_enabled
    `);
    stmt.run(cameraId, enabled ? 1 : 0);
}

// ============================================
// Últimos eventos MQTT por cámara
// ============================================

/**
 * Último evento MQTT de una cámara (cualquier tipo).
 * @param {string} cameraId
 * @returns {{event_type: string, received_at: string}|null}
 */
function getLastEvent(cameraId) {
    const stmt = db.prepare(`
        SELECT event_type, received_at FROM mqtt_events
        WHERE camera_id = ?
        ORDER BY id DESC
        LIMIT 1
    `);
    return stmt.get(cameraId) || null;
}

/**
 * Último evento de actividad (movimiento/IA) de una cámara.
 * @param {string} cameraId
 * @returns {{event_type: string, received_at: string}|null}
 */
function getLastMotionEvent(cameraId) {
    const stmt = db.prepare(`
        SELECT event_type, received_at FROM mqtt_events
        WHERE camera_id = ?
          AND event_type IN ('motion_start', 'ai_human', 'ai_vehicle', 'ai_animal')
        ORDER BY id DESC
        LIMIT 1
    `);
    return stmt.get(cameraId) || null;
}

// Inicializamos el esquema al cargar el módulo
initSchema();

module.exports = {
    insertVideo,
    getVideos,
    countVideos,
    purgeVideos,
    getVideoById,
    getAllCameras,
    getCameraStats,
    getLatestVideosByCamera,
    updateVideo,
    setVideoFavorite,
    deleteVideo,
    bulkGetVideos,
    bulkDeleteVideos,
    bulkSetFavorite,
    upsertPushSubscription,
    getPushSubscription,
    getAllPushSubscriptions,
    deletePushSubscription,
    deleteStalePushSubscriptions,
    touchPushSubscription,
    getCameraSetting,
    setCameraPushEnabled,
    getLastEvent,
    getLastMotionEvent,
    db
};
