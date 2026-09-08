/**
 * remote-mirror.js
 *
 * Backup 3-2-1: copia cada clip procesado a REMOTE_RECORDINGS_DIR (dir fijo;
 * el mapeo a NFS/rclone lo hace un volume de compose). Es una COPIA no fatal:
 * un fallo remoto se loguea con reintentos pero nunca rompe el pipeline.
 */

const path = require('path');
const fs = require('fs');
const { REMOTE_RECORDINGS_DIR, REMOTE_MIRROR } = require('./paths');

// Mounts remotos inestables: 3 intentos con backoff 1s, 2s.
const MIRROR_ATTEMPTS = 3;
const MIRROR_BACKOFF_BASE_MS = 1000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Copia un clip a REMOTE_RECORDINGS_DIR (idempotente: sobrescribe si existe).
 * No-op si REMOTE_MIRROR está off. Nunca lanza.
 * @param {string} srcPath - Ruta absoluta del clip en RECORDINGS_DIR
 */
async function mirrorToRemote(srcPath) {
    if (!REMOTE_MIRROR) {
        return;
    }
    const destPath = path.join(REMOTE_RECORDINGS_DIR, path.basename(srcPath));
    for (let attempt = 1; attempt <= MIRROR_ATTEMPTS; attempt++) {
        try {
            await fs.promises.copyFile(srcPath, destPath);
            console.log(`[Remote] Clip espejado en remoto: ${path.basename(srcPath)}`);
            return;
        } catch (err) {
            if (attempt === MIRROR_ATTEMPTS) {
                console.error(`[Remote] Mirror falló tras ${MIRROR_ATTEMPTS} intentos (${srcPath} → ${destPath}): ${err.message}`);
                return;
            }
            const delay = MIRROR_BACKOFF_BASE_MS * 2 ** (attempt - 1);
            console.warn(`[Remote] Mirror intento ${attempt}/${MIRROR_ATTEMPTS} falló: ${err.message}; reintento en ${delay}ms`);
            await sleep(delay);
        }
    }
}

module.exports = { mirrorToRemote };
