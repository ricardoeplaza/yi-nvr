/**
 * paths.js
 *
 * Única fuente de verdad para las rutas de almacenamiento. Centraliza la
 * resolución de DATA_DIR / RECORDINGS_DIR / PUBLIC_DIR para que todos los
 * módulos y scripts usen el mismo criterio (sin repetir la lógica de default
 * en cada archivo, donde la profundidad relativa a __dirname varía).
 *
 * Dev: los datos viven FUERA del source, en la raíz del repo: data/,
 * incoming/, recordings/, remote_recordings/. Docker los sobreescribe vía env
 * (/app/...); ver Dockerfile + docker-compose.yml. El mapeo de
 * /app/remote_recordings a un NFS/rclone del host se hace en los volumes de
 * compose, no aquí.
 */

const path = require('path');

// paths.js vive en apps/api/src → la raíz del repo (yi-nvr/) está 3 niveles arriba.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Base para la DB + media procesada. Dev: <repo>/data.
const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(REPO_ROOT, 'data');

// Staging FTP: subidas crudas de la cámara; lo único que vigila chokidar.
const INCOMING_DIR = process.env.INCOMING_DIR
    ? path.resolve(process.env.INCOMING_DIR)
    : path.join(REPO_ROOT, 'incoming');

// Copia local de los clips procesados (se sirve en /videos).
const RECORDINGS_DIR = process.env.RECORDINGS_DIR
    ? path.resolve(process.env.RECORDINGS_DIR)
    : path.join(REPO_ROOT, 'recordings');

// Mirror remoto (3-2-1): directorio fijo; el mapeo a NFS/rclone lo hace un
// volume de compose. Se crea si no existe (ftp.js).
const REMOTE_RECORDINGS_DIR = process.env.REMOTE_RECORDINGS_DIR
    ? path.resolve(process.env.REMOTE_RECORDINGS_DIR)
    : path.join(REPO_ROOT, 'remote_recordings');

// Flag del mirror remoto ('1'/'true').
const REMOTE_MIRROR = ['1', 'true'].includes((process.env.REMOTE_MIRROR || '').trim().toLowerCase());

// Build de Angular (estáticos del PWA). Dev: apps/api/src/public.
const PUBLIC_DIR = process.env.PUBLIC_DIR
    ? path.resolve(process.env.PUBLIC_DIR)
    : path.join(__dirname, 'public');

// Registro de cámaras. Dev y Docker comparten <repo>/infra/cameras.json
// (gitignored; plantilla en infra/cameras.json.example).
const CAMERAS_JSON_PATH = process.env.CAMERAS_JSON_PATH
    ? path.resolve(process.env.CAMERAS_JSON_PATH)
    : path.join(REPO_ROOT, 'infra', 'cameras.json');

module.exports = {
    REPO_ROOT,
    DATA_DIR,
    INCOMING_DIR,
    RECORDINGS_DIR,
    REMOTE_RECORDINGS_DIR,
    REMOTE_MIRROR,
    PUBLIC_DIR,
    CAMERAS_JSON_PATH
};
