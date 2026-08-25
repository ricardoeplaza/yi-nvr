/**
 * paths.js
 *
 * Única fuente de verdad para las rutas de almacenamiento. Centraliza la
 * resolución de DATA_DIR / RECORDINGS_DIR / PUBLIC_DIR para que todos los
 * módulos y scripts usen el mismo criterio (sin repetir la lógica de default
 * en cada archivo, donde la profundidad relativa a __dirname varía).
 *
 * Dev: los datos viven FUERA del source, en la raíz del repo:
 *   - <repo>/data        → SQLite DB + media procesada (SSD)
 *   - <repo>/recordings  → clips entrantes por FTP (HDD opcional)
 * Docker: se sobreescribe vía env (DATA_DIR=/app/data, RECORDINGS_DIR=
 * /app/recordings, PUBLIC_DIR=/app/public); ver Dockerfile + docker-compose.yml.
 */

const path = require('path');

// paths.js vive en apps/api/src → la raíz del repo (yi-nvr/) está 3 niveles arriba.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Base para la DB + media procesada. Dev: <repo>/data.
const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(REPO_ROOT, 'data');

// Clips entrantes por FTP (un subdirectorio por ftp_dir). Dev: <repo>/recordings.
const RECORDINGS_DIR = process.env.RECORDINGS_DIR
    ? path.resolve(process.env.RECORDINGS_DIR)
    : path.join(REPO_ROOT, 'recordings');

// Build de Angular (estáticos del PWA). Dev: apps/api/src/public.
const PUBLIC_DIR = process.env.PUBLIC_DIR
    ? path.resolve(process.env.PUBLIC_DIR)
    : path.join(__dirname, 'public');

// Registro de cámaras. Dev y Docker comparten <repo>/infra/cameras.json
// (gitignored; plantilla en infra/cameras.json.example).
const CAMERAS_JSON_PATH = process.env.CAMERAS_JSON_PATH
    ? path.resolve(process.env.CAMERAS_JSON_PATH)
    : path.join(REPO_ROOT, 'infra', 'cameras.json');

module.exports = { REPO_ROOT, DATA_DIR, RECORDINGS_DIR, PUBLIC_DIR, CAMERAS_JSON_PATH };
