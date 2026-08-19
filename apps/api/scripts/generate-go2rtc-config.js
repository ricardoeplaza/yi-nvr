/**
 * scripts/generate-go2rtc-config.js
 *
 * Genera el yaml de configuración de go2rtc a partir de
 * `src/config/cameras.json` (una entrada por cámara que tenga `rtsp_url`,
 * clave = id de la cámara):
 *
 *   streams:
 *     oficina:
 *       src: rtsp://192.168.14.30/ch0_1.h264
 *       audio: true
 *
 * `audio: true` solo se emite si la cámara declara audio en el stream
 * (cameras.json → `rtsp.audio` distinto de no/none; la cámara emite AAC,
 * único codec de audio soportado por h264grabber/go2rtc del firmware).
 *
 * Ruta de salida: env GO2RTC_CONFIG_PATH (absoluta, o relativa resuelta
 * desde la raíz del repo). Default: <raiz>/infra/go2rtc/go2rtc.yaml.
 *
 * Uso:
 *  - Manual:      node scripts/generate-go2rtc-config.js   (desde apps/api)
 *  - Automático:  server.js lo ejecuta en el arranque, antes del listen.
 *
 * Si ninguna cámara tiene rtsp_url, escribe un yaml válido vacío
 * (`streams: {}`) y loguea un warning. El error se lanza al caller:
 * server.js lo envuelve en try/catch (go2rtc es opcional en dev).
 */

const fs = require('fs');
const path = require('path');

// Raíz del repo (scripts/ → apps/api → apps → raiz)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CAMERAS_JSON_PATH = path.join(__dirname, '..', 'src', 'config', 'cameras.json');
const DEFAULT_OUT_PATH = path.join(REPO_ROOT, 'infra', 'go2rtc', 'go2rtc.yaml');

// Al ejecutarse a mano (fuera de server.js) también leemos el .env de la
// raíz, para que GO2RTC_CONFIG_PATH se respete igual que en el arranque.
require('dotenv').config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

/**
 * Resuelve la ruta de salida del yaml.
 * @returns {string} - Ruta absoluta del go2rtc.yaml a escribir
 */
function resolveOutPath() {
    const env = process.env.GO2RTC_CONFIG_PATH;
    if (env && env.trim() !== '') {
        return path.isAbsolute(env) ? env : path.resolve(REPO_ROOT, env);
    }
    return DEFAULT_OUT_PATH;
}

/**
 * Indica si la cámara declara audio en su stream RTSP.
 * @param {Object} cam - Entrada de cameras.json
 * @returns {boolean} - true si rtsp.audio es un valor de audio activo
 */
function camHasAudio(cam) {
    const audio = cam.rtsp && cam.rtsp.audio;
    return typeof audio === 'string'
        && audio.trim() !== ''
        && audio.toLowerCase() !== 'no'
        && audio.toLowerCase() !== 'none';
}

/**
 * Construye el contenido YAML a partir de la lista de cámaras.
 * @param {Array<Object>} cameras - Contenido parseado de cameras.json
 * @returns {string} - YAML (terminado en salto de línea)
 */
function buildYaml(cameras) {
    const withRtsp = cameras.filter(
        cam => typeof cam.rtsp_url === 'string' && cam.rtsp_url.trim() !== ''
    );

    if (withRtsp.length === 0) {
        return 'streams: {}\n';
    }

    const lines = ['streams:'];
    withRtsp.forEach(cam => {
        lines.push(`  ${cam.id}:`);
        lines.push(`    src: ${cam.rtsp_url}`);
        if (camHasAudio(cam)) {
            lines.push(`    audio: true`);
        }
    });
    return lines.join('\n') + '\n';
}

/**
 * Lee cameras.json, genera el yaml y lo escribe a disco (creando la
 * carpeta de destino si no existe).
 * @returns {string} - Ruta absoluta del yaml escrito
 * @throws {Error} - Si cameras.json no se puede leer/parsear o la escritura falla
 */
function generateGo2rtcConfig() {
    const raw = fs.readFileSync(CAMERAS_JSON_PATH, 'utf8');
    const cameras = JSON.parse(raw);
    if (!Array.isArray(cameras)) {
        throw new Error('cameras.json debe ser un array de cámaras');
    }

    const outPath = resolveOutPath();
    const yaml = buildYaml(cameras);

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, yaml, 'utf8');

    const count = cameras.filter(
        cam => typeof cam.rtsp_url === 'string' && cam.rtsp_url.trim() !== ''
    ).length;

    if (count === 0) {
        console.warn(`[go2rtc-config] Warning: ninguna cámara con rtsp_url; se escribió streams vacío en ${outPath}`);
    } else {
        console.log(`[go2rtc-config] ${count} stream(s) generados en ${outPath}`);
    }
    return outPath;
}

// Ejecución manual: logueamos el error y salimos con código 1 (no lanzamos)
if (require.main === module) {
    try {
        generateGo2rtcConfig();
    } catch (err) {
        console.error('[go2rtc-config] Error al generar go2rtc.yaml:', err.message);
        process.exit(1);
    }
}

module.exports = { generateGo2rtcConfig };
