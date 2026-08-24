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
 *  - timestamp: Fecha y hora del evento (ISO 8601)
 *  - original_path: Ruta absoluta del archivo .mp4 original
 *  - thumbnail_path: Ruta del thumbnail JPG generado
 *  - preview_path: Ruta del preview WebP animado
 *  - duration: Duración del video en segundos
 *  - file_size: Tamaño del archivo en bytes
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ruta de almacenamiento persistente (exenta de OverlayFS en Armbian).
// Sobrescribible vía STORAGE_DIR (Docker monta el volumen en /app/storage).
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(__dirname, 'storage');
const DB_PATH = path.join(STORAGE_DIR, 'surveillance.db');

// Aseguramos que el directorio de almacenamiento exista
if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
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
            timestamp TEXT NOT NULL,
            original_path TEXT NOT NULL UNIQUE,
            thumbnail_path TEXT,
            preview_path TEXT,
            duration REAL,
            file_size INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `;
    db.exec(createTable);

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
 * Obtiene videos filtrados por rango de fechas y/o cámara.
 * @param {Object} filters - Filtros opcionales: camera, startDate, endDate
 * @returns {Array} - Lista de videos ordenados por timestamp descendente
 */
function getVideos(filters = {}) {
    let query = 'SELECT * FROM videos WHERE 1=1';
    const params = {};

    if (filters.camera) {
        query += ' AND camera_name = @camera';
        params.camera = filters.camera;
    }

    if (filters.startDate) {
        query += ' AND timestamp >= @startDate';
        params.startDate = filters.startDate;
    }

    if (filters.endDate) {
        query += ' AND timestamp <= @endDate';
        params.endDate = filters.endDate;
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
        query += ' LIMIT @limit';
        params.limit = filters.limit;
    }

    const stmt = db.prepare(query);
    return stmt.all(params);
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
 * Obtiene datos agregados para el timeline (videos agrupados por día).
 * @returns {Array} - Datos agrupados por fecha
 */
function getTimelineData() {
    const stmt = db.prepare(`
        SELECT 
            date(timestamp) as date,
            camera_name,
            COUNT(*) as count
        FROM videos
        GROUP BY date(timestamp), camera_name
        ORDER BY date(timestamp) DESC
    `);
    return stmt.all();
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
 * Elimina un video de la base de datos por su ID.
 * @param {number} id - ID del video a eliminar
 * @returns {boolean} - True si se eliminó, false si no existía
 */
function deleteVideo(id) {
    const stmt = db.prepare('DELETE FROM videos WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
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
    getVideoById,
    getAllCameras,
    getCameraStats,
    getTimelineData,
    updateVideo,
    deleteVideo,
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
