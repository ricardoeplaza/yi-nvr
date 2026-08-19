/**
 * ftp.js
 * 
 * Módulo del servidor FTP para recepción de videos.
 * 
 * Usamos 'ftp-srv' para crear un servidor FTP que acepte archivos .mp4
 * de las cámaras de vigilancia. Como ftp-srv no expone un evento directo
 * para archivos subidos, utilizamos 'chokidar' para monitorear el directorio
 * FTP. Cuando detectamos un nuevo archivo .mp4, dispar el procesamiento
 * con FFmpeg y guardamos los metadatos en SQLite.
 * 
 * Configuración:
 *  - Puerto: 2121 (por defecto, configurable)
 *  - Modo pasivo: Habilitado para soportar NAT/firewalls
 *  - Autenticación: Simple (usuario/contraseña configurables)
 *  - Directorio raíz: src/storage/ftp (donde se depositan los videos)
 */

const FtpSrv = require('ftp-srv');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const { processVideo } = require('./processor');
const { insertVideo } = require('./database');

// Configuración del servidor FTP
const FTP_PORT = process.env.FTP_PORT || 2121;
const FTP_HOST = process.env.FTP_HOST || '0.0.0.0';
const FTP_USER = process.env.FTP_USER || 'camera';
const FTP_PASS = process.env.FTP_PASS || 'surveillance123';

// Directorio donde se almacenan los videos recibidos por FTP
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(__dirname, 'storage');
const FTP_ROOT = path.join(STORAGE_DIR, 'ftp');

// Rango de puertos pasivos (override vía env, ej. "2000-2050", p. ej. si Hyper-V/WSL2
// reserva 1024-1050 en Windows). Default: 1024-1050.
let FTP_PASV_MIN = 1024;
let FTP_PASV_MAX = 1050;
if (process.env.FTP_PASSIVE_RANGE) {
    const parts = process.env.FTP_PASSIVE_RANGE.split('-');
    const min = parseInt(parts[0], 10);
    const max = parseInt(parts[1], 10);
    if (Number.isInteger(min) && Number.isInteger(max) && min > 0 && max >= min) {
        FTP_PASV_MIN = min;
        FTP_PASV_MAX = max;
    } else {
        console.warn(`[FTP] FTP_PASSIVE_RANGE inválido: "${process.env.FTP_PASSIVE_RANGE}", usando 1024-1050`);
    }
}

// Set para rastrear archivos que ya están siendo procesados
// (evita procesamiento duplicado)
const processingFiles = new Set();

// Aseguramos que el directorio FTP exista
if (!fs.existsSync(FTP_ROOT)) {
    fs.mkdirSync(FTP_ROOT, { recursive: true });
}

// Creamos la instancia del servidor FTP
const ftpServer = new FtpSrv({
    url: `ftp://${FTP_HOST}:${FTP_PORT}`,
    pasv_url: FTP_HOST,
    pasv_min: FTP_PASV_MIN,
    pasv_max: FTP_PASV_MAX,
    anonymous: false,
    greeting: ['Welcome to Surveillance Center FTP Server', 'Please authenticate to upload videos.']
});

/**
 * Extrae el nombre de la cámara del path del archivo.
 * Si la cámara sube a /camera_name/video.mp4, extraemos 'camera_name'.
 * Si no hay subdirectorio, usamos 'default'.
 * @param {string} filePath - Ruta del archivo subido
 * @returns {string} - Nombre de la cámara
 */
function extractCameraName(filePath) {
    const relativePath = path.relative(FTP_ROOT, filePath);
    const parts = relativePath.split(path.sep);
    // Si hay subdirectorio, usamos el primer segmento como nombre de cámara
    return parts.length > 1 ? parts[0] : 'default';
}

/**
 * Procesa un archivo de video recién detectado.
 * Esta función se llama cuando chokidar detecta un nuevo archivo .mp4.
 * @param {string} filePath - Ruta absoluta del archivo
 */
async function handleNewVideo(filePath) {
    // Verificamos que sea un archivo .mp4
    if (!filePath.endsWith('.mp4') && !filePath.endsWith('.MP4')) {
        return;
    }

    // Evitamos procesar el mismo archivo dos veces
    if (processingFiles.has(filePath)) {
        return;
    }

    processingFiles.add(filePath);

    try {
        // Esperamos un momento para asegurar que el archivo esté completamente escrito
        // (especialmente importante para archivos grandes subidos por FTP)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verificamos que el archivo existe y tiene tamaño
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
            console.warn(`[FTP] Archivo vacío, ignorando: ${filePath}`);
            processingFiles.delete(filePath);
            return;
        }

        console.log(`[FTP] Nuevo video detectado: ${path.basename(filePath)} (${stats.size} bytes)`);

        // Extraemos nombre de cámara del path
        const cameraName = extractCameraName(filePath);
        const timestamp = new Date().toISOString();

        // Procesamos el video (thumbnail + preview)
        const processedData = await processVideo(filePath);

        // Guardamos los metadatos en la base de datos
        const videoRecord = insertVideo({
            camera_name: cameraName,
            timestamp: timestamp,
            original_path: processedData.original_path,
            thumbnail_path: processedData.thumbnail_path,
            preview_path: processedData.preview_path,
            duration: processedData.duration,
            file_size: processedData.file_size
        });

        console.log(`[FTP] Video indexado correctamente. ID: ${videoRecord.id}, Cámara: ${cameraName}`);

    } catch (err) {
        console.error(`[FTP] Error procesando ${path.basename(filePath)}:`, err.message);
    } finally {
        // Liberamos el archivo del set después de un tiempo
        setTimeout(() => {
            processingFiles.delete(filePath);
        }, 5000);
    }
}

/**
 * Configura el watcher de archivos con chokidar.
 * Monitorea el directorio FTP en busca de nuevos archivos .mp4.
 */
function setupFileWatcher() {
    console.log(`[FTP] Iniciando monitoreo de directorio: ${FTP_ROOT}`);
    
    const watcher = chokidar.watch(FTP_ROOT, {
        ignored: /(^|[\/\\])\../, // Ignorar archivos ocultos
        persistent: true,
        ignoreInitial: true, // No procesar archivos existentes al inicio
        awaitWriteFinish: {
            stabilityThreshold: 3000, // Esperar 3 segundos después de que deje de escribirse
            pollInterval: 100
        },
        depth: 5 // Monitorear subdirectorios hasta 5 niveles de profundidad
    });

    watcher
        .on('add', filePath => {
            console.log(`[Watcher] Archivo añadido: ${filePath}`);
            handleNewVideo(filePath);
        })
        .on('change', filePath => {
            // Solo procesamos si no lo hemos procesado antes
            if (!processingFiles.has(filePath)) {
                console.log(`[Watcher] Archivo modificado: ${filePath}`);
                handleNewVideo(filePath);
            }
        })
        .on('unlink', filePath => {
            console.log(`[Watcher] Archivo eliminado: ${filePath}`);
        })
        .on('error', error => {
            console.error('[Watcher] Error:', error.message);
        })
        .on('ready', () => {
            console.log('[Watcher] Monitoreo iniciado y listo');
        });

    return watcher;
}

/**
 * Registra los eventos del servidor FTP.
 */
function setupEventHandlers() {
    
    // Evento de autenticación: validamos usuario/contraseña
    ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
        console.log(`[FTP] Intento de login: ${username} desde ${connection.ip}`);
        
        if (username === FTP_USER && password === FTP_PASS) {
            console.log(`[FTP] Usuario ${username} autenticado correctamente`);
            // Resolvemos con el directorio raíz para este usuario
            resolve({ root: FTP_ROOT });
        } else {
            console.warn(`[FTP] Autenticación fallida para ${username}`);
            reject(new Error('Invalid username or password'));
        }
    });

    // Evento cuando un cliente se conecta
    ftpServer.on('client-connect', ({ connection }) => {
        console.log(`[FTP] Cliente conectado desde: ${connection.ip}`);
    });

    // Evento cuando un cliente se desconecta
    ftpServer.on('client-disconnect', ({ connection }) => {
        console.log(`[FTP] Cliente desconectado: ${connection.ip}`);
    });

    // Evento de error del servidor
    ftpServer.on('server-error', ({ error }) => {
        console.error('[FTP] Error del servidor:', error.message);
    });
}

/**
 * Inicia el servidor FTP y el monitoreo de archivos.
 * @returns {Promise} - Resuelve cuando el servidor está listo
 */
async function startFtpServer() {
    setupEventHandlers();
    
    try {
        await ftpServer.listen();
        console.log(`[FTP] Servidor iniciado en ${FTP_HOST}:${FTP_PORT}`);
        console.log(`[FTP] Directorio raíz: ${FTP_ROOT}`);
        console.log(`[FTP] Credenciales: ${FTP_USER} / ${FTP_PASS}`);
        
        // Iniciamos el watcher de archivos
        setupFileWatcher();
        
        return ftpServer;
    } catch (err) {
        console.error('[FTP] Error al iniciar servidor:', err.message);
        throw err;
    }
}

module.exports = {
    startFtpServer,
    ftpServer,
    FTP_ROOT
};
