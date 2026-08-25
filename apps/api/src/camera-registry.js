/**
 * camera-registry.js
 *
 * Registro de cámaras definido en `infra/cameras.json` (fuerte tipado por
 * validación, no por confianza en el contenido del archivo).
 *
 * El archivo lista las cámaras del sistema con:
 *  - id: identificador único (usado en la API, ej. /api/cameras/:id/reload)
 *  - name: nombre legible para el frontend
 *  - host: IP/hostname de la cámara (puede ser vacío p. ej. para 'default')
 *  - ftp_dir: subdirectorio bajo la raíz FTP al que sube la cámara. Las
 *    cámaras que suben a la raíz del FTP (sin subdirectorio) corresponden a
 *    'default' (ver extractCameraName en ftp.js).
 *  - ecosystem (opcional): ecosistema de la cámara. Valores:
 *    - "yi-hack": firmware yi-hack; el API puede consultarle TODO por
 *      HTTP/MQTT (status.json, get_configs.sh, SD, WiFi, controles, reboot).
 *    - "generic": el resto (p. ej. Tuya): el NVR SOLO indexa sus clips por
 *      FTP; NO se le consulta ni envía nada al dispositivo (no sabe
 *      responder). El API devuelve solo lo que el NVR ya tiene (IP, nº de
 *      videos, último video, últimos eventos).
 *    Default si falta: "generic" (seguro: nunca se consulta por HTTP/MQTT a
 *    una cámara que no sabe responder; una yi-hack debe marcarse SIEMPRE
 *    explícitamente).
 *  - mqtt_prefix: prefix MQTT yi-hack de la cámara (por defecto de fábrica:
 *    MAC sin dos puntos; personalizable, p. ej. "yi-oficina").
 *  - sd_total_mb (opcional): capacidad total de la SD en MB. Ningún CGI del
 *    firmware expone el total (solo free_sd en %), así que se configura aquí
 *    para poder calcular usado/libre en la página de detalle.
 *  - capabilities: objeto de booleanos (led, ircut, rec_mode, power).
 *  - mqtt_topics (opcional): overrides de los suffixes de tema MQTT por
 *    cámara (birth_will, motion, motion_image, motion_files, sound_detection).
 *  - mqtt_messages (opcional): overrides de los strings de payload que la
 *    cámara publica (online, offline, motion_start, motion_stop, ai_human,
 *    ai_vehicle, ai_animal, baby_crying, sound).
 *
 * La validación (validateCameras) es una función pura que Lanza un Error con
 * mensaje descriptivo ante cualquier problema, lo que permite probarla sin
 * arrancar el servidor. loadCameras() acepta una ruta opcional por parámetro
 * (default: infra/cameras.json) por la misma razón.
 */

const fs = require('fs');
const path = require('path');

// Ruta del archivo de configuración. Dev y Docker comparten <repo>/infra/cameras.json
// (gitignored; plantilla en infra/cameras.json.example). Ver paths.js.
const { CAMERAS_JSON_PATH: DEFAULT_CONFIG_PATH } = require('./paths');

// Ecosistemas de cámara válidos (ver cabecera). Default: "generic".
const ECOSYSTEMS = ['yi-hack', 'generic'];

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
    const seenPrefixes = new Set();

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

        for (const field of ['host', 'mqtt_prefix']) {
            if (typeof cam[field] !== 'string') {
                throw new Error(`cameras[${i}]: falta "${field}" (string, puede ser vacío)`);
            }
        }

        // Ecosistema (opcional): "yi-hack" | "generic" (default "generic")
        if (cam.ecosystem !== undefined && !ECOSYSTEMS.includes(cam.ecosystem)) {
            throw new Error(`cameras[${i}]: "ecosystem" debe ser "yi-hack" o "generic"`);
        }

        // El prefix MQTT debe ser único y no vacío (se usa para resolver
        // de tema → cámara en el cliente MQTT)
        if (cam.mqtt_prefix !== '') {
            if (seenPrefixes.has(cam.mqtt_prefix)) {
                throw new Error(`cameras[${i}]: "mqtt_prefix" duplicado: "${cam.mqtt_prefix}"`);
            }
            seenPrefixes.add(cam.mqtt_prefix);
        }

        // Capacidad total de la SD (opcional): número positivo en MB
        if (cam.sd_total_mb !== undefined) {
            if (typeof cam.sd_total_mb !== 'number' || !Number.isFinite(cam.sd_total_mb) ||
                    cam.sd_total_mb <= 0) {
                throw new Error(`cameras[${i}]: "sd_total_mb" debe ser un número positivo (MB)`);
            }
        }

        // Overrides opcionales del contrato MQTT (mapas de string → string)
        for (const field of ['mqtt_topics', 'mqtt_messages']) {
            if (cam[field] === undefined) continue;
            if (typeof cam[field] !== 'object' || cam[field] === null || Array.isArray(cam[field])) {
                throw new Error(`cameras[${i}]: "${field}" debe ser un objeto de string → string`);
            }
            for (const [key, value] of Object.entries(cam[field])) {
                if (typeof value !== 'string') {
                    throw new Error(`cameras[${i}]: "${field}.${key}" debe ser string`);
                }
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
 * @param {string} [filePath] - Ruta opcional del archivo (default: infra/cameras.json)
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
 * Ecosistema de una cámara, aplicando el default "generic" si el campo no
 * está en cameras.json (ver cabecera: "generic" es el default seguro).
 * @param {Object|undefined} cam
 * @returns {"yi-hack"|"generic"}
 */
function getEcosystem(cam) {
    return cam && typeof cam.ecosystem === 'string' && cam.ecosystem !== ''
        ? cam.ecosystem
        : 'generic';
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
 * Busca una cámara por su mqtt_prefix (el primer segmento de sus temas).
 * @param {string} prefix
 * @returns {Object|undefined}
 */
function getCameraByMqttPrefix(prefix) {
    return cameras.find(cam => cam.mqtt_prefix === prefix);
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
    ECOSYSTEMS,
    getAllCameras,
    getCameraById,
    getCameraByFtpDir,
    getCameraByMqttPrefix,
    getEcosystem,
    loadCameras,
    reload,
    validateCameras
};
