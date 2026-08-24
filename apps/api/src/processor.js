/**
 * processor.js
 * 
 * Módulo de procesamiento de video con FFmpeg.
 * 
 * Este módulo se encarga de:
 *  1. Extraer un thumbnail JPG del video recibido.
 *  2. Generar un preview animado en formato WebP.
 *  3. Ejecutar FFmpeg con baja prioridad (nice) para no saturar el Orange Pi Zero 3.
 * 
 * IMPORTANTE SOBRE FFmpeg:
 *  - fluent-ffmpeg requiere que el binario 'ffmpeg' esté instalado en el sistema.
 *  - En el Orange Pi, se instala con: sudo apt-get install ffmpeg
 *  - Alternativa: Si no puedes instalar ffmpeg globalmente, puedes usar 'ffmpeg-static':
 *      npm install ffmpeg-static
 *      const ffmpegPath = require('ffmpeg-static');
 *      ffmpeg.setFfmpegPath(ffmpegPath);
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createQueue } = require('./queue');

// Directorio de salida para los archivos procesados
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(__dirname, 'storage');
const PROCESSED_DIR = path.join(STORAGE_DIR, 'processed');

// Límite de concurrencia del pipeline de ffmpeg: cuántos videos se
// procesan a la vez. Con 1 (default) solo corren los ffmpeg de un video
// (thumbnail + preview) y el resto del backlog espera en cola.
const FFMPEG_CONCURRENCY = Math.max(1, parseInt(process.env.FFMPEG_CONCURRENCY, 10) || 1);
// Hilos por proceso ffmpeg (2 por defecto: no monopolizar los núcleos del SBC).
const FFMPEG_THREADS = Math.max(1, parseInt(process.env.FFMPEG_THREADS, 10) || 2);
// Duración (seg) y fps de la animación WebP: 4s a 6fps = 24 frames.
const PREVIEW_SECONDS = Math.max(1, parseFloat(process.env.PREVIEW_SECONDS) || 4);
const PREVIEW_FPS = Math.max(1, parseInt(process.env.PREVIEW_FPS, 10) || 6);

// Cola FIFO que acota los ffmpeg concurrentes (evita el OOM cuando varias
// cámaras suben clips atrasados a la vez).
const processingQueue = createQueue(FFMPEG_CONCURRENCY);

// Aseguramos que el directorio de procesados exista
if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
}

/**
 * Extrae la duración de un video usando ffprobe.
 * @param {string} videoPath - Ruta del video
 * @returns {Promise<number>} - Duración en segundos
 */
function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                console.error('[Processor] Error al obtener duración:', err.message);
                return resolve(0);
            }
            const duration = metadata.format.duration || 0;
            resolve(duration);
        });
    });
}

/**
 * Genera un thumbnail JPG del video (frame al 50% de la duración).
 * @param {string} videoPath - Ruta del video original
 * @param {string} outputName - Nombre base para los archivos de salida
 * @returns {Promise<string>} - Ruta del thumbnail generado
 */
function generateThumbnail(videoPath, outputName) {
    return new Promise((resolve, reject) => {
        const thumbnailPath = path.join(PROCESSED_DIR, `${outputName}_thumb.jpg`);
        
        ffmpeg(videoPath)
            .outputOptions(['-threads', String(FFMPEG_THREADS)])
            .screenshots({
                timestamps: ['50%'],  // Tomamos el frame del medio del video
                filename: `${outputName}_thumb.jpg`,
                folder: PROCESSED_DIR,
                size: '640x360'       // Resolución suficiente para preview
            })
            .on('end', () => {
                console.log(`[Processor] Thumbnail generado: ${thumbnailPath}`);
                resolve(thumbnailPath);
            })
            .on('error', (err) => {
                console.error('[Processor] Error generando thumbnail:', err.message);
                reject(err);
            });
    });
}

/**
 * Genera un preview animado en formato WebP de duración fija
 * (PREVIEW_SECONDS a PREVIEW_FPS, por defecto 4s a 6fps = 24 frames),
 * tomado de los primeros segundos del clip.
 * @param {string} videoPath - Ruta del video original
 * @param {string} outputName - Nombre base para los archivos de salida
 * @returns {Promise<string>} - Ruta del preview WebP generado
 */
function generatePreview(videoPath, outputName) {
    return new Promise((resolve, reject) => {
        const previewPath = path.join(PROCESSED_DIR, `${outputName}_preview.webp`);

        // Animación de duración fija: -t como OPCIÓN DE ENTRADA hace que ffmpeg
        // solo lea los primeros PREVIEW_SECONDS del clip (no procesa un clip de
        // 1 min entero) y fps retemporiza a PREVIEW_FPS → 4s a 6fps = 24 frames.
        // -filter_complex bifurca (split) el flujo: la rama [s1] genera la paleta
        // (palettegen) y [s0] la aplica (paletteuse) → webp compacto.
        const filterString = `[0:v]fps=${PREVIEW_FPS},scale=320:-1:flags=lanczos,split=2[s0][s1];[s1]palettegen=stats_mode=diff[p];[s0][p]paletteuse=dither=bayer`;

        // Usamos ffmpeg directamente con child_process para tener más control
        // y poder ejecutarlo con 'nice' (baja prioridad de CPU)
        const args = [
            '-t', String(PREVIEW_SECONDS),
            '-i', videoPath,
            '-filter_complex', filterString,
            '-loop', '0',  // Loop infinito
            '-preset', 'picture',
            '-quality', '60',
            '-an',  // Sin audio
            '-threads', String(FFMPEG_THREADS),
            '-y',   // Sobrescribir si existe
            previewPath
        ];

        // Ejecutamos con nice para baja prioridad (ideal para Orange Pi)
        // En Windows, 'nice' no está disponible nativamente, pero en Linux/Armbian sí.
        // Detectamos el sistema operativo para usar el comando adecuado.
        const isWindows = process.platform === 'win32';
        const command = isWindows ? 'ffmpeg' : 'nice';
        const finalArgs = isWindows ? args : ['-n', '19', 'ffmpeg', ...args];

        const ffmpegProcess = spawn(command, finalArgs, {
            detached: false,
            stdio: 'pipe'
        });

        let stderrOutput = '';
        ffmpegProcess.stderr.on('data', (data) => {
            stderrOutput += data.toString();
        });

        ffmpegProcess.on('close', (code) => {
            if (code === 0) {
                console.log(`[Processor] Preview WebP generado: ${previewPath}`);
                resolve(previewPath);
            } else {
                console.error(`[Processor] FFmpeg salió con código ${code}`);
                console.error('[Processor] stderr:', stderrOutput);
                reject(new Error(`FFmpeg falló con código ${code}`));
            }
        });

        ffmpegProcess.on('error', (err) => {
            console.error('[Processor] Error ejecutando FFmpeg:', err.message);
            reject(err);
        });
    });
}

/**
 * Procesa un video completo: thumbnail + preview + metadatos.
 * Esta es la función principal que se llama cuando llega un nuevo video por FTP.
 * @param {string} videoPath - Ruta absoluta del archivo .mp4 recibido
 * @returns {Promise<Object>} - Metadatos procesados
 */
async function processVideo(videoPath) {
    const pending = processingQueue.size();
    if (pending > 0) {
        console.log(`[Processor] Cola: ${pending} video(s) en espera, encolando ${path.basename(videoPath)}`);
    }
    return processingQueue.add(() => processVideoNow(videoPath));
}

async function processVideoNow(videoPath) {
    console.log(`[Processor] Iniciando procesamiento de: ${videoPath}`);

    const startTime = Date.now();
    const fileName = path.basename(videoPath, path.extname(videoPath));
    const fileSize = fs.statSync(videoPath).size;
    
    try {
        // Obtenemos la duración del video
        const duration = await getVideoDuration(videoPath);
        
        // Generamos thumbnail y preview en paralelo para optimizar tiempo
        const [thumbnailPath, previewPath] = await Promise.all([
            generateThumbnail(videoPath, fileName),
            generatePreview(videoPath, fileName)
        ]);

        const processingTime = Date.now() - startTime;
        console.log(`[Processor] Procesamiento completado en ${processingTime}ms`);
        if (processingQueue.size() === 0) {
            console.log('[Processor] Cola de procesamiento vacía');
        }

        return {
            original_path: videoPath,
            thumbnail_path: thumbnailPath,
            preview_path: previewPath,
            duration: duration,
            file_size: fileSize
        };

    } catch (error) {
        console.error('[Processor] Error en el procesamiento:', error.message);
        throw error;
    }
}

module.exports = {
    processVideo,
    getVideoDuration,
    generateThumbnail,
    generatePreview
};
