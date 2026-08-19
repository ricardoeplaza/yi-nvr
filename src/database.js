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

// Ruta de almacenamiento persistente (exenta de OverlayFS en Armbian)
const STORAGE_DIR = path.join(__dirname, 'storage');
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

// Inicializamos el esquema al cargar el módulo
initSchema();

module.exports = {
    insertVideo,
    getVideos,
    getVideoById,
    getAllCameras,
    getTimelineData,
    updateVideo,
    deleteVideo,
    db
};
