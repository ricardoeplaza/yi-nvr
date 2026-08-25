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
 *  - Puerto: 21 (por defecto — el puerto que hardcodea ftppush.sh de la
 *    cámara; configurable vía FTP_PORT). 21 < 1024 es puerto privilegiado:
 *    el bind requiere root/admin o CAP_NET_BIND_SERVICE.
 *  - Modo pasivo: Habilitado para soportar NAT/firewalls
 *  - Autenticación: Simple (usuario/contraseña configurables)
 *  - Directorio raíz: src/storage/ftp (donde se depositan los videos)
 */

const FtpSrv = require('ftp-srv');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { processVideo } = require('./processor');
const { insertVideo, getCameraSetting } = require('./database');
const { getCameraByFtpDir } = require('./camera-registry');
const webpush = require('./push/webpush');
const { RECORDINGS_DIR } = require('./paths');

// Configuración del servidor FTP
const FTP_PORT = process.env.FTP_PORT || 21;
const FTP_HOST = process.env.FTP_HOST || '0.0.0.0';
const FTP_USER = process.env.FTP_USER || 'camera';
const FTP_PASS = process.env.FTP_PASS || 'surveillance123';

// Directorio donde se almacenan los videos recibidos por FTP (clips entrantes,
// HDD opcional). Dev: <repo>/recordings, Docker: /app/recordings (ver paths.js).

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

// Flag de estado del servidor FTP (true tras startFtpServer resuelto)
let ftpListening = false;

/**
 * Indica si el servidor FTP está escuchando.
 * @returns {boolean}
 */
function isFtpListening() {
    return ftpListening;
}

/**
 * Resuelve la IP LAN del NVR a la que las cámaras pueden llegar.
 * Criterio (en orden):
 *  1. Env NVR_PUBLIC_IP (override explícito; p. ej. NVR multi-homed, NAT
 *     o DMZ donde la IP auto-detectada no es la que ven las cámaras).
 *  2. Primera IPv4 no-internal de os.networkInterfaces() (excluye loopback
 *     e IPv6). En un NVR con una sola interfaz LAN es la IP de la LAN.
 *  3. Fallback 127.0.0.1 (solo útil si cámara y NVR comparten host).
 * @returns {string}
 */
function getNvrPublicIp() {
    const fromEnv = (process.env.NVR_PUBLIC_IP || '').trim();
    if (fromEnv) {
        return fromEnv;
    }
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
            if (iface.internal || iface.family !== 'IPv4') continue;
            return iface.address;
        }
    }
    return '127.0.0.1';
}

/**
 * Config FTP derivada que el NVR impone a la cámara: los parámetros de
 * push NO son libres (ver §12.4 de docs/CAMERA-CGI-REFERENCE.md):
 *  - FTP_HOST     = IP LAN del NVR (a la que la cámara puede llegar)
 *  - FTP_USERNAME = usuario del ftp-srv (env FTP_USER)
 *  - FTP_PASSWORD = contraseña del ftp-srv (env FTP_PASS)
 *  - FTP_DIR      = ftp_dir de la cámara (cameras.json; en la BD
 *                   videos.camera_name = ftp_dir, así el NVR sabe de qué
 *                   cámara es cada clip)
 * @param {string} ftpDir - ftp_dir de la cámara
 * @returns {{FTP_HOST: string, FTP_USERNAME: string, FTP_PASSWORD: string, FTP_DIR: string}}
 */
function getFtpSuggestedConfig(ftpDir) {
    return {
        FTP_HOST: getNvrPublicIp(),
        FTP_USERNAME: FTP_USER,
        FTP_PASSWORD: FTP_PASS,
        FTP_DIR: ftpDir
    };
}

// Aseguramos que el directorio FTP exista
if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Creamos la instancia del servidor FTP
const ftpServer = new FtpSrv({
    url: `ftp://${FTP_HOST}:${FTP_PORT}`,
    pasv_url: FTP_HOST,
    pasv_min: FTP_PASV_MIN,
    pasv_max: FTP_PASV_MAX,
    anonymous: false,
    greeting: ['Welcome to yi-nvr FTP Server', 'Please authenticate to upload videos.']
});

/**
 * Extrae el nombre de la cámara del path del archivo.
 * Si la cámara sube a /camera_name/video.mp4, extraemos 'camera_name'.
 * Si no hay subdirectorio, usamos 'default'.
 * @param {string} filePath - Ruta del archivo subido
 * @returns {string} - Nombre de la cámara
 */
function extractCameraName(filePath) {
    const relativePath = path.relative(RECORDINGS_DIR, filePath);
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

        // Comprobamos si la cámara está registrada (la BD sigue guardando
        // camera_name con el valor de ftp_dir; si no está, avisamos e indexamos igual)
        if (!getCameraByFtpDir(cameraName)) {
            console.warn('[FTP] Clip de cámara no registrada: ' + cameraName);
        }

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

        // Notificación push del clip procesado (fase 4). notify() nunca lanza,
        // pero lo envolvemos igualmente para que el fallo (si apareciera) no
        // rompa el pipeline de indexación del clip.
        // Toggle de push por cámara (camera_settings; default: activado).
        const pushCamera = getCameraByFtpDir(cameraName);
        if (pushCamera && !getCameraSetting(pushCamera.id).push_enabled) {
            return;
        }
        try {
            const thumbnailUrl = videoRecord.thumbnail_path
                ? `/processed/${path.basename(videoRecord.thumbnail_path)}`
                : undefined;
            webpush.notify({
                title: 'Nuevo clip',
                body: cameraName,
                icon: thumbnailUrl,
                url: `/videos/${videoRecord.id}`
            });
        } catch (e) {
            console.error('[FTP] Error en la notificación push del clip:', e.message);
        }

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
    console.log(`[FTP] Iniciando monitoreo de directorio: ${RECORDINGS_DIR}`);
    
    const watcher = chokidar.watch(RECORDINGS_DIR, {
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
            resolve({ root: RECORDINGS_DIR });
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
        ftpListening = true;
        console.log(`[FTP] Servidor iniciado en ${FTP_HOST}:${FTP_PORT}`);
        console.log(`[FTP] Directorio raíz: ${RECORDINGS_DIR}`);
        console.log(`[FTP] Credenciales: ${FTP_USER} / ${FTP_PASS}`);
        
        // Iniciamos el watcher de archivos
        setupFileWatcher();
        
        return ftpServer;
    } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            console.error(`[FTP] El puerto ${FTP_PORT} es privilegiado (< 1024): el bind requiere permisos de administrador.`);
            console.error('[FTP] Linux: corre el API como root o con CAP_NET_BIND_SERVICE (setcap "cap_net_bind_service=+ep" $(which node)).');
            console.error('[FTP] Windows: ejecuta el API como administrador.');
            console.error('[FTP] Alternativa: usa un puerto no privilegiado (FTP_PORT en .env) y parchea ftppush.sh en la SD de la cámara (docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md §5.2.1).');
        } else if (err.code === 'EADDRINUSE') {
            console.error(`[FTP] El puerto ${FTP_PORT} ya está en uso: libera el puerto o cambia FTP_PORT en .env.`);
        }
        console.error('[FTP] Error al iniciar servidor:', err.message);
        throw err;
    }
}

module.exports = {
    startFtpServer,
    isFtpListening,
    getNvrPublicIp,
    getFtpSuggestedConfig,
    ftpServer,
    RECORDINGS_DIR
};
