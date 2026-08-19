/**
 * camera-registry.js
 *
 * Registro de cámaras definido en `config/cameras.json` (fuerte tipado por
 * validación, no por confianza en el contenido del archivo).
 *
 * El archivo lista las cámaras del sistema con:
 *  - id: identificador único (usado en la API, ej. /api/cameras/:id/reload)
 *  - name: nombre legible para el frontend
 *  - host: IP/hostname de la cámara (puede ser vacío p. ej. para 'default')
 *  - ftp_dir: subdirectorio bajo la raíz FTP al que sube la cámara. Las
 *    cámaras que suben a la raíz del FTP (sin subdirectorio) corresponden a
 *    'default' (ver extractCameraName en ftp.js).
 *  - mqtt_prefix: id yi-hack de la cámara (MAC sin dos puntos), para fases
 *    futuras de control vía MQTT.
 *  - rtsp_url: URL RTSP para fases futuras (go2rtc / streaming).
 *  - capabilities: objeto de booleanos (led, ircut, rec_mode, power).
 *
 * La validación (validateCameras) es una función pura que Lanza un Error con
 * mensaje descriptivo ante cualquier problema, lo que permite probarla sin
 * arrancar el servidor. loadCameras() acepta una ruta opcional por parámetro
 * (default: src/config/cameras.json) por la misma razón.
 */

const fs = require('fs');
const path = require('path');

// Ruta por defecto del archivo de configuración
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config', 'cameras.json');

// Estado en memoria (se reemplaza completo en cada carga)
let cameras = [];

/**
 * Valida la estructura de la lista de cámaras.
 * @param {*} data - Contenido parseado de cameras.json
 * @throws {Error} - Con mensaje descriptivo si el dato no es válido
 */
function validateCameras(data) {
    if (!Array.isArray(data)) {
        throw new Error('cameras.json debe ser un array de objetos de cámara');
    }

    const seenIds = new Set();
    const seenDirs = new Set();

    data.forEach((cam, i) => {
        if (typeof cam !== 'object' || cam === null || Array.isArray(cam)) {
            throw new Error(`cameras[${i}]: cada entrada debe ser un objeto`);
        }

        if (typeof cam.id !== 'string' || cam.id.trim() === '') {
            throw new Error(`cameras[${i}]: falta "id" (string no vacío)`);
        }
        if (seenIds.has(cam.id)) {
            throw new Error(`cameras[${i}]: "id" duplicado: "${cam.id}"`);
        }
        seenIds.add(cam.id);

        if (typeof cam.name !== 'string' || cam.name.trim() === '') {
            throw new Error(`cameras[${i}]: falta "name" (string no vacío)`);
        }

        if (typeof cam.ftp_dir !== 'string' || cam.ftp_dir.trim() === '') {
            throw new Error(`cameras[${i}]: falta "ftp_dir" (string no vacío)`);
        }
        if (seenDirs.has(cam.ftp_dir)) {
            throw new Error(`cameras[${i}]: "ftp_dir" duplicado: "${cam.ftp_dir}"`);
        }
        seenDirs.add(cam.ftp_dir);

        for (const field of ['host', 'mqtt_prefix', 'rtsp_url']) {
            if (typeof cam[field] !== 'string') {
                throw new Error(`cameras[${i}]: falta "${field}" (string, puede ser vacío)`);
            }
        }

        const caps = cam.capabilities;
        if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
            throw new Error(`cameras[${i}]: "capabilities" debe ser un objeto de booleanos`);
        }
        for (const [key, value] of Object.entries(caps)) {
            if (typeof value !== 'boolean') {
                throw new Error(`cameras[${i}]: "capabilities.${key}" debe ser booleano`);
            }
        }
    });
}

/**
 * Carga, valida y actualiza el estado en memoria del registro.
 * @param {string} [filePath] - Ruta opcional del archivo (default: src/config/cameras.json)
 * @returns {number} - Número de cámaras cargadas
 * @throws {Error} - Si el archivo no se puede leer, el JSON es malformado o
 *                   la validación falla
 */
function loadCameras(filePath) {
    const target = filePath || DEFAULT_CONFIG_PATH;

    let raw;
    try {
        raw = fs.readFileSync(target, 'utf8');
    } catch (err) {
        throw new Error(`No se pudo leer ${target}: ${err.message}`);
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        throw new Error(`JSON malformado en ${target}: ${err.message}`);
    }

    validateCameras(data);

    cameras = data;
    return cameras.length;
}

/**
 * Devuelve todas las cámaras registradas, en el orden del archivo.
 * @returns {Array<Object>}
 */
function getAllCameras() {
    return cameras;
}

/**
 * Busca una cámara por su id.
 * @param {string} id
 * @returns {Object|undefined}
 */
function getCameraById(id) {
    return cameras.find(cam => cam.id === id);
}

/**
 * Busca una cámara por su ftp_dir (el valor que se guarda como camera_name en la BD).
 * @param {string} dir
 * @returns {Object|undefined}
 */
function getCameraByFtpDir(dir) {
    return cameras.find(cam => cam.ftp_dir === dir);
}

/**
 * Recarga el archivo de configuración completo (todas las cámaras).
 * @returns {number} - Número de cámaras tras la recarga
 * @throws {Error} - El error de lectura/parseo/validación sube al caller
 */
function reload() {
    return loadCameras();
}

// Carga inicial al requerir el módulo
loadCameras();

module.exports = {
    getAllCameras,
    getCameraById,
    getCameraByFtpDir,
    loadCameras,
    reload,
    validateCameras
};
