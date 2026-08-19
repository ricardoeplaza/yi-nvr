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

// Directorio de salida para los archivos procesados
const PROCESSED_DIR = path.join(__dirname, 'storage', 'processed');

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
 * Genera un preview animado en formato WebP.
 * Creamos un WebP animado con una secuencia de frames espaciados.
 * @param {string} videoPath - Ruta del video original
 * @param {string} outputName - Nombre base para los archivos de salida
 * @returns {Promise<string>} - Ruta del preview WebP generado
 */
function generatePreview(videoPath, outputName) {
    return new Promise((resolve, reject) => {
        const previewPath = path.join(PROCESSED_DIR, `${outputName}_preview.webp`);
        
        // Obtenemos la duración primero para calcular los timestamps
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                console.error('[Processor] Error ffprobe:', err.message);
                return reject(err);
            }

            const duration = metadata.format.duration || 10;
            // Generamos 10 frames espaciados uniformemente (máximo 5 segundos de preview)
            const frameCount = 10;
            const interval = Math.min(duration / frameCount, 0.5);
            const timestamps = [];
            
            for (let i = 0; i < frameCount; i++) {
                timestamps.push(i * interval);
            }

                        // Usamos -filter_complex porque necesitamos bifurcar (split) el flujo de vídeo.
            // Sintaxis: Entrada -> Escala -> Dividir -> (Rama A: Paleta) ; (Rama B: Uso de paleta)
            const filterString = "[0:v]scale=320:-1:flags=lanczos,split=2[s0][s1];[s1]fps=2,palettegen=stats_mode=diff[p];[s0][p]paletteuse=dither=bayer";

            // Usamos ffmpeg directamente con child_process para tener más control
            // y poder ejecutarlo con 'nice' (baja prioridad de CPU)
            const args = [
                '-i', videoPath,
                //'-vf', `fps=2,scale=320:-1:flags=lanczos,split[s0][s1];[s0]palettegen=[s1]paletteuse=dither=bayer`,
                '-filter_complex', filterString,
                '-loop', '0',  // Loop infinito
                '-preset', 'picture',
                '-quality', '60',
                '-an',  // Sin audio
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
    });
}

/**
 * Procesa un video completo: thumbnail + preview + metadatos.
 * Esta es la función principal que se llama cuando llega un nuevo video por FTP.
 * @param {string} videoPath - Ruta absoluta del archivo .mp4 recibido
 * @returns {Promise<Object>} - Metadatos procesados
 */
async function processVideo(videoPath) {
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
