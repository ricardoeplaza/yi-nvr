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
// execFileSync NO es global en Node 24/26 (plataforma objetivo: dev Node 24,
// Docker node:26), así que se requiere explícitamente (igual que spawn en
// processor.js). child_process es un modulo built-in, nunca falta.
const { execFileSync } = require('child_process');
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

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFMPEG_PATH
  ? FFMPEG_PATH.replace(/ffmpeg(-static)?(\.exe)?$/i, 'ffprobe$2')
  : 'ffprobe';

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

// Los nombres que NOSOTROS generamos siguen siempre el patrón
// YYYY-MM-DDTHH-MM-SS_camara[_N].mp4 (ver resolveFinalPath). Los archivos
// crudos que sube la cámara nunca tienen este formato (usan el esquema
// base-8 de ftppush.sh, ej. "05M19S41.mp4").
//
// Como el rename final se hace DENTRO del mismo directorio que vigila
// chokidar (RECORDINGS_DIR), ese rename es indistinguible para chokidar de
// "llegó un archivo nuevo": dispara un 'add' sobre el nombre ya renombrado,
// y sin este filtro handleNewVideo se ejecutaría una SEGUNDA vez sobre un
// vídeo que ya procesamos nosotros mismos (duplicando thumbnail/preview y
// violando el UNIQUE de videos.original_path al reinsertar).
const OWN_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_.+\.mp4$/i;

// TODO(futuro corto): desdoblar RECORDINGS_DIR en dos carpetas para eliminar
// este workaround de nombre (OWN_FILENAME_PATTERN / isOwnGeneratedFile):
//   - <incoming>: donde la cámara sube por FTP y lo ÚNICO que vigila chokidar.
//   - <recording> (el RECORDINGS_DIR actual): donde viven los clips YA
//     procesados y listos para archivar/servir.
// Con ese split, el rename final MOVERÍA el clip FUERA de la carpeta vigilada,
// así chokidar nunca vería nuestros propios renames y el filtro de nombre
// dejaría de ser necesario.
// Extra: <incoming> podría mapearse a un ramdisk (tmpfs) para evitar la
// escritura temporal en disco (más rápido y menos desgaste en el SBC).

/**
 * Indica si el nombre de archivo corresponde al patrón que NOSOTROS
 * generamos en resolveFinalPath (y no a una subida cruda de la cámara).
 * @param {string} filePath
 * @returns {boolean}
 */
function isOwnGeneratedFile(filePath) {
    return OWN_FILENAME_PATTERN.test(path.basename(filePath));
}

// Set para rastrear archivos que ya están siendo procesados
// (evita procesamiento duplicado). Se marca la ruta ORIGINAL detectada por
// chokidar tan pronto como entra en handleNewVideo, no al final del
// pipeline, para que un evento 'change' disparado durante el procesamiento
// (remux, espera de estabilidad, etc.) no cuele un segundo procesamiento
// del mismo archivo.
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
 * Obtiene la hora REAL de grabación de un clip desde la metadatos MP4
 * (creation_time), NO la hora de subida por FTP.
 *
 * Por que importa: con FTP_DIR_TREE=no todos los clips de todas las horas
 * comparten un directorio, y el nombre del archivo (MM M SS S XX, dígitos en
 * base-8) solo codifica minuto:segundo:cuadro (sin hora ni fecha). Así, clips
 * de horas distintas pueden colisionar (p. ej. 13:05:19 y 14:05:19 ambos
 * "05M19S41.mp4"). La hora real está en creation_time (ISO 8601 completo:
 * fecha + hora + minuto + segundo).
 *
 * Se usa ffprobe (no -show_entries en ffmpeg 9.0) y execFileSync para una
 * captura sincrónica fiable en Windows. Devuelve el timestamp en formato ISO
 * 8601 COMPLETO en UTC con 'Z' (ej. 2026-08-19T14:05:19.000Z) o null si
 * ffprobe falla (clip en progreso, "moov atom not found", binario inexistente).
 * El fallo NO bloquea el pipeline (cae a la hora de subida).
 *
 * Por que UTC con 'Z' (NO hora local): el frontend Angular hace
 *   new Date(v.timestamp).getHours() / toLocaleDateString()
 * y el navegador convierte a la hora LOCAL del dispositivo automáticamente
 * (14:05 UTC se ve como 16:05 en UTC+2). Si convirtieramos a local AQUÍ, el
 * navegador lo volvería a convertir y se vería 18:05 (doble conversión).
 * Además, new Date() solo parsea una cadena full-date-full-time válida cuando
 * lleva 'Z' u offset; con guiones/colones sin zona devuelve Invalid Date
 * (→ NaN:NaN en el dashboard). creation_time ya viene en UTC (ISO 8601), así
 * que lo normalizamos con new Date(...).toISOString().
 * @param {string} filePath - Ruta absoluta del clip .mp4
 * @returns {Promise<string|null>} - ISO 8601 UTC con 'Z' (ej. 2026-08-19T14:05:19.000Z)
 *                                  o null si ffprobe no pudo leer el archivo
 */
async function getCreationTime(filePath) {
    let output;
    try {
        output = execFileSync(FFPROBE_PATH, [
            '-i', filePath,
            '-show_entries', 'format_tags=creation_time',
            '-loglevel', 'error'
        ], { encoding: 'utf8' });
    } catch (err) {
        console.warn(`[FTP] ffprobe no pudo leer ${path.basename(filePath)}: ${err.message}`);
        return null;
    }
    // Solo la línea de formato usa "TAG:creation_time=" (sin espacios). La
    // metadatos de stream usa "creation_time : <valor>" (con espacios), así que
    // esta búsqueda es inequívoca incluso con el banner de versión mezclado.
    // match[1] = "2026-08-19T14:05:19.000000Z" (ISO 8601 UTC).
    const match = output.match(/TAG:creation_time=(\S+)/);
    if (!match) return null;
    const d = new Date(match[1]);
    if (isNaN(d.getTime())) return null;
    // ISO 8601 UTC normalizado (ej. "2026-08-19T14:05:19.000Z"). El frontend
    // lo convierte a hora local al mostrar (getHours()/toLocaleDateString()).
    return d.toISOString();
}

/**
 * Elimina la pista de vídeo de baja resolución (640x360, stream 1) por stream
 * copy (ffmpeg NO transcodifica). El clip tiene 3 streams: 0 = vídeo 1920x1080
 * H.264, 1 = vídeo 640x360 H.264 (preview, ~26% del tamaño, INÚTIL para
 * nosotros: generamos nuestras propias miniaturas/previews), 2 = audio AAC. Al
 * mapear solo 0 y 2, eliminamos ~26% de almacenamiento.
 *
 * Escribe un archivo temp en el mismo directorio, lo renombra reemplazando al
 * original (mismo nombre) y devuelve esa ruta (sin cambios). Devuelve null si
 * falla (no bloquea el pipeline; el archivo original queda intacto).
 * @param {string} filePath - Ruta absoluta del clip .mp4
 * @returns {Promise<string|null>} - Ruta del clip remuxado (igual que la
 *                                  entrada, ahora con 2 streams), o null si falla
 */
async function removeLowResTrack(filePath) {
    const dir = path.dirname(filePath);
    // Temp con extension .mp4 real: ffmpeg infiere el formato de salida del
    // sufijo (con un nombre sin extension .mp4, ffmpeg no elige el formato y
    // falla con "Unable to choose an output format"). El archivo queda oculto
    // (dotfile) y chokidar lo ignora (ignored: /(^|[\/\\])\../).
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-lowres.mp4`);
    try {
        execFileSync(FFMPEG_PATH, [
            '-y',
            '-i', filePath,
            '-map', '0:0',  // vídeo principal (1920x1080)
            '-map', '0:2',  // audio (AAC)
            '-c', 'copy',    // stream copy (sin re-codificar)
            '-map_metadata', '0',
            tmpPath
        ]);
        // Renombramos el temp reemplazando al original (mismo nombre).
        fs.renameSync(tmpPath, filePath);
        return filePath;
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        console.warn(`[FTP] No se pudo eliminar la pista low-res de ${path.basename(filePath)}: ${err.message}`);
        return null;
    }
}

/**
 * Calcula un nombre de archivo destino <timestamp>_<cámara>.mp4 a partir de
 * la hora LOCAL (coincide con lo que muestra el dashboard), y resuelve
 * colisiones añadiendo un sufijo numérico ANTES de la extensión
 * (ej. "..._cam1.mp4" -> "..._cam1_2.mp4" -> "..._cam1_3.mp4").
 *
 * El timestamp ISO lleva ':' y '.' (inválidos en nombres de archivo de
 * Windows), así que derivamos un nombre seguro YYYY-MM-DDTHH-MM-SS.
 * @param {string} dir - Directorio donde vivirá el archivo final
 * @param {string} cameraName - Nombre de cámara (extractCameraName)
 * @param {string} timestamp - ISO 8601 (creation_time o hora de subida)
 * @returns {string} - Ruta absoluta libre de colisiones
 */
function resolveFinalPath(dir, cameraName, timestamp) {
    const d = new Date(timestamp);
    const p = (n) => String(n).padStart(2, '0');
    const fileStamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    const baseName = `${fileStamp}_${cameraName}`;
    const ext = '.mp4';

    let finalPath = path.join(dir, `${baseName}${ext}`);
    let counter = 2;
    while (fs.existsSync(finalPath)) {
        finalPath = path.join(dir, `${baseName}_${counter}${ext}`);
        counter++;
    }
    return finalPath;
}

/**
 * Envía la notificación push del clip procesado (fase 4). Respeta el toggle
 * de push por cámara (camera_settings; default: activado). notify() nunca
 * lanza, pero lo envolvemos igualmente para que un fallo aquí no rompa el
 * pipeline de indexación del clip.
 * @param {string} cameraName
 * @param {object} videoRecord - Registro devuelto por insertVideo()
 */
function sendClipNotification(cameraName, videoRecord) {
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
}

/**
 * Procesa un archivo de video recién detectado.
 * Esta función se llama cuando chokidar detecta un nuevo archivo .mp4.
 * @param {string} originalPath - Ruta absoluta del archivo tal como lo reportó chokidar
 */
async function handleNewVideo(originalPath) {
    // Verificamos que sea un archivo .mp4 (case-insensitive: cámaras/firmwares
    // distintos pueden subir en mayúsculas).
    if (path.extname(originalPath).toLowerCase() !== '.mp4') {
        return;
    }

    // Si el nombre ya tiene NUESTRO formato final, este evento no viene de
    // una subida de la cámara: es chokidar reaccionando a nuestro propio
    // rename dentro del directorio vigilado. Lo ignoramos para no
    // reprocesar (y reinsertar) un vídeo que ya indexamos.
    if (isOwnGeneratedFile(originalPath)) {
        return;
    }

    // Evitamos procesar el mismo archivo dos veces. Se marca YA aquí (no al
    // final del pipeline) para cubrir toda la ventana de procesamiento:
    // espera de estabilidad + remux + rename pueden tardar varios segundos,
    // y un evento 'change' de chokidar en ese intervalo no debe colar un
    // segundo procesamiento del mismo archivo original.
    if (processingFiles.has(originalPath)) {
        return;
    }
    processingFiles.add(originalPath);

    // currentPath rastrea la ruta ACTUAL del archivo a través del pipeline
    // (puede cambiar tras el remux y de nuevo tras el rename final), mientras
    // que originalPath se mantiene fijo para la dedup y los logs de error.
    let currentPath = originalPath;

    try {
        // Esperamos un momento para asegurar que el archivo esté completamente escrito
        // (especialmente importante para archivos grandes subidos por FTP)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verificamos que el archivo existe y tiene tamaño
        const stats = fs.statSync(currentPath);
        if (stats.size === 0) {
            console.warn(`[FTP] Archivo vacío, ignorando: ${currentPath}`);
            return;
        }

        console.log(`[FTP] Nuevo video detectado: ${path.basename(currentPath)} (${stats.size} bytes)`);

        // Extraemos nombre de cámara del path
        const cameraName = extractCameraName(currentPath);

        // Hora real de grabación desde creation_time del MP4 (NO la hora de
        // subida). Con FTP_DIR_TREE=no el nombre base-8 (MM M SS S XX) no codifica
        // la hora, así que varios clips colisionan; usamos el timestamp completo.
        // Fallback a la hora de subida si ffprobe falla (clip en progreso).
        const creationTime = await getCreationTime(currentPath);
        const timestamp = creationTime || new Date().toISOString();
        // timestamp = ISO 8601 UTC (ej. "2026-08-19T14:05:19.000Z"), válido para
        // new Date() en Angular. Se guarda en la BD tal cual; el frontend lo
        // convierte a hora local al mostrar (getHours()/toLocaleDateString()).

        // Comprobamos si la cámara está registrada (la BD sigue guardando
        // camera_name con el valor de ftp_dir; si no está, avisamos e indexamos igual)
        if (!getCameraByFtpDir(cameraName)) {
            console.warn('[FTP] Clip de cámara no registrada: ' + cameraName);
        }

        // Opcionalmente eliminamos la pista low-res (640x360, stream 1):
        // stream copy, ~26% menos de almacenamiento. Si falla, no bloquea.
        if (process.env.REMOVE_LOWRES_TRACK !== 'false') {
            const remuxedPath = await removeLowResTrack(currentPath);
            if (remuxedPath) {
                currentPath = remuxedPath;
            }
        }

        // Renombramos a <timestamp>_<cámara>.mp4 para evitar colisiones (el
        // nombre base-8 no incluye hora ni fecha).
        const finalPath = resolveFinalPath(path.dirname(currentPath), cameraName, timestamp);
        fs.renameSync(currentPath, finalPath);
        currentPath = finalPath;

        // Procesamos el video (thumbnail + preview)
        const processedData = await processVideo(currentPath);

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

        sendClipNotification(cameraName, videoRecord);

    } catch (err) {
        console.error(`[FTP] Error procesando ${path.basename(originalPath)}:`, err.message);
    } finally {
        // Liberamos el archivo del set después de un tiempo. Se libera por
        // originalPath (la clave que usamos para marcar y comprobar), no por
        // currentPath, que puede haber cambiado tras el remux/rename.
        setTimeout(() => {
            processingFiles.delete(originalPath);
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
    getCreationTime,
    removeLowResTrack,
    ftpServer,
    RECORDINGS_DIR
};