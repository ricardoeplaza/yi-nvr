/**
 * routes/storage.js
 *
 * Router de la API para la gestión de almacenamiento (SD) de una cámara
 * yi-hack (se monta en /api). El API actúa como proxy HTTP contra los
 * CGI de gestión de eventos de la cámara (yi-hack):
 *  - eventsdir.sh (listado de directorios de eventos)
 *  - eventsfile.sh (listado de archivos en un directorio)
 *  - eventsdirdel.sh (borrado de directorio)
 *  - eventsfiledel.sh (borrado de archivo)
 *  - get_configs.sh / set_configs.sh (config de push FTP)
 *
 * El frontend nunca conoce la IP de la cámara, solo habla con el API.
 *
 * SOLO yi-hack: las cámaras "generic" no tienen firmware yi-hack ni CGIs;
 * todas las rutas devuelven 409 UNSUPPORTED_ECOSYSTEM.
 *
 * Nomenclatura de la SD (firmware yi-hack, ver docs/CAMERA-CGI-REFERENCE.md §12):
 *  - Directorio de eventos (14 chars): YYYY Y MM M DD D HH H
 *    p. ej. "2020Y01M01D01H" → 1 de enero de 2020, hora 01
 *  - Archivo de evento (12 chars): MM M SS S XX .mp4
 *    p. ej. "00M00S60.mp4" → minuto 00, segundo 00, frame 60
 *  - Ruta completa para borrado: <dirname>/<filename>.mp4
 *
 * Endpoints:
 *  - GET    /cameras/:id/storage              - Info SD + directorios de eventos
 *  - GET    /cameras/:id/storage/dirs/:dir/files - Ficheros de un directorio (eventsfile.sh)
 *  - DELETE /cameras/:id/storage/files - Borrar un archivo (eventsfiledel.sh)
 *  - DELETE /cameras/:id/storage/dirs  - Borrar un directorio (eventsdirdel.sh)
 *  - POST   /cameras/:id/storage/purge - Purge por scope: range | last | all
 *  - GET    /cameras/:id/storage/ftp   - Leer config de push FTP
 *  - POST   /cameras/:id/storage/ftp   - Escribir config de push FTP
 *
 * Rendimiento (medido en cámara real, 95 directorios):
 *  - eventsdir.sh tarda ~12 s: el firmware ejecuta `ls -r` + `date -d @...`
 *    POR DIRECTORIO. Con el timeout de 5 s el fetch se abortaba y el API
 *    devolvía dirs: null (la UI mostraba "Sin directorios"). Por eso:
 *    (a) timeout propio de 30 s para ese CGI y (b) cache del listado con
 *    TTL de 60 s + invalidación explícita tras cada borrado/purge.
 *  - eventsfile.sh tarda ~0.5 s POR DIRECTORIO: se expone como endpoint
 *    pidiendo cada directorio bajo demanda (no se pre-cargan todos).
 *
 * Push FTP — parámetros auto-derivados (NO son libres, ver §12.4 de
 * docs/CAMERA-CGI-REFERENCE.md):
 *  - FTP_HOST     = IP LAN del NVR (getNvrPublicIp: env NVR_PUBLIC_IP →
 *    primera IPv4 no-internal → 127.0.0.1)
 *  - FTP_USERNAME/FTP_PASSWORD = credenciales del ftp-srv (env FTP_USER/
 *    FTP_PASS)
 *  - FTP_DIR      = ftp_dir de la cámara (cameras.json; videos.camera_name
 *    = ftp_dir, así el NVR sabe de qué cámara es cada clip)
 * GET .../ftp devuelve además `suggested` (esos valores derivados) y
 * `in_sync: boolean` (si los valores actuales de la cámara coinciden con
 * los derivados).
 * POST .../ftp acepta SOLO los switches (FTP_UPLOAD, FTP_DIR_TREE,
 * FTP_FILE_DELETE_AFTER_UPLOAD; valores "yes"/"no"). Los campos fijos
 * (host/user/pass/dir) SIEMPRE se escriben con los derivados: el frontend
 * no los envía y cualquier valor que llegue en el cuerpo se ignora (el
 * NVR es la única fuente de verdad).
 *
 * Errores: cámara desconocida 404; sin host 400; ecosistema no soportado
 * 409; cámara no alcanzable 502; nombre inválido 400; parámetros inválidos 400.
 */

const express = require('express');
const registry = require('../camera-registry');
const { getFtpSuggestedConfig } = require('../ftp');

const router = express.Router();

// Timeout del proxy HTTP hacia la cámara (5 s: suficiente para status.json,
// get_configs, borrados y eventsfile.sh, que responden en ~1 s)
const PROXY_TIMEOUT_MS = 5000;

// Timeout exclusivo de set_configs.sh: el CGI hace un `sed -i` por clave
// (7 claves = 7 reescrituras de system.conf en la SD). En reposo tarda
// ~1,5 s, pero con la SD ocupada (grabación o purge en curso) puede
// superar los 5 s genéricos → 502 falso.
const SET_CONFIGS_TIMEOUT_MS = 15000;

// Timeout exclusivo de eventsdir.sh: el firmware tarda ~12 s con 95
// directorios (escala con el nº de directorios: `date` por cada uno).
const EVENTSDIR_TIMEOUT_MS = 30000;

// TTL de la cache del listado de directorios. Los borrados invalidan la
// cache explícitamente (forgetCachedDirs), así el TTL solo cubre el caso
// "apareció un directorio nuevo" (máx. 1 por hora por cámara).
const DIRS_CACHE_TTL_MS = 60000;

// Retardo entre borrados secuenciales en el purge (evita saturar la SD
// y da tiempo al firmware a actualizar su índice interno)
const PURGE_DELAY_MS = 500;

// Capacidad total de la SD por defecto (MB) cuando la cámara no tiene
// sd_total_mb configurado: 32 GB, la tarjeta más común.
const SD_TOTAL_MB_DEFAULT = 32768;

// Claves de la config system.sh relacionadas con FTP push
const FTP_KEYS = [
    'FTP_UPLOAD',
    'FTP_HOST',
    'FTP_DIR',
    'FTP_DIR_TREE',
    'FTP_USERNAME',
    'FTP_PASSWORD',
    'FTP_FILE_DELETE_AFTER_UPLOAD'
];

// Campos FIJOS: los determina el NVR (getFtpSuggestedConfig); el cliente no
// los edita (ver cabecera). El resto son switches editables ("yes"/"no").
const FTP_FIXED_KEYS = ['FTP_HOST', 'FTP_DIR', 'FTP_USERNAME', 'FTP_PASSWORD'];
const FTP_SWITCH_KEYS = ['FTP_UPLOAD', 'FTP_DIR_TREE', 'FTP_FILE_DELETE_AFTER_UPLOAD'];

/**
 * Fetch de un CGI que responde JSON. Lanza si la cámara no responde, el
 * timeout se agota o la respuesta no es JSON.
 * @param {string} url
 * @param {Object} [options] - Opciones de fetch (method, headers, body)
 * @param {number} [timeoutMs] - Timeout (por defecto PROXY_TIMEOUT_MS)
 * @returns {Promise<Object>} - JSON parseado (sin el sentinel "NULL")
 */
async function fetchCameraJson(url, options = {}, timeoutMs = PROXY_TIMEOUT_MS) {
    const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        const err = new Error(`respuesta no-JSON: ${text.slice(0, 120)}`);
        err.status = 502;
        throw err;
    }
    if (data && typeof data === 'object' && 'NULL' in data) {
        delete data.NULL;
    }
    return data;
}

/**
 * Parsea la respuesta de eventsdir.sh. La cámara devuelve
 * {"records":[{"datetime":"Date: ... Time: ...","dirname":"..."}, ...]};
 * se tolera también un array plano de nombres (otras versiones).
 * @param {Object|Array} data
 * @returns {string[]|null} - Nombres de directorio válidos, o null si la
 *   respuesta no tiene forma reconocible
 */
function parseEventsDir(data) {
    const records = Array.isArray(data)
        ? data
        : (data && Array.isArray(data.records) ? data.records : null);
    if (!records) return null;
    return records
        .map(r => (typeof r === 'string' ? r : (r && typeof r.dirname === 'string' ? r.dirname : null)))
        .filter(d => typeof d === 'string' && isValidDirName(d));
}

// Cache del listado de directorios por cámara (eventsdir.sh es lento, ver
// EVENTSDIR_TIMEOUT_MS). Se invalida explícitamente tras borrados.
const dirsCache = new Map(); // cam.id -> { dirs: string[], ts: number }

/**
 * Devuelve el listado cacheado si sigue fresco (TTL), o null.
 * @param {string} id
 * @returns {string[]|null}
 */
function getCachedDirs(id) {
    const entry = dirsCache.get(id);
    if (entry && Date.now() - entry.ts < DIRS_CACHE_TTL_MS) return entry.dirs;
    return null;
}

/**
 * Almacena el listado en la cache.
 * @param {string} id
 * @param {string[]} dirs
 */
function setCachedDirs(id, dirs) {
    dirsCache.set(id, { dirs, ts: Date.now() });
}

/**
 * Quita nombres de la cache (sin refetch: el resultado de un borrado es
 * conocido). Si la entrada no existe, no hace nada.
 * @param {string} id
 * @param {string[]} names
 */
function forgetCachedDirs(id, names) {
    const entry = dirsCache.get(id);
    if (!entry) return;
    const drop = new Set(names);
    entry.dirs = entry.dirs.filter(d => !drop.has(d));
    entry.ts = Date.now();
}

/**
 * Valida un nombre de directorio de eventos (14 chars: YYYY Y MM M DD D HH H).
 * @param {string} dir
 * @returns {boolean}
 */
function isValidDirName(dir) {
    return /^\d{4}Y\d{2}M\d{2}D\d{2}H$/.test(dir);
}

/**
 * Valida una ruta de archivo de evento (<dirname>/<filename>.mp4|.jpg).
 * @param {string} file
 * @returns {boolean}
 */
function isValidFilePath(file) {
    if (typeof file !== 'string') return false;
    const parts = file.split('/');
    if (parts.length !== 2) return false;
    if (!isValidDirName(parts[0])) return false;
    const name = parts[1];
    if (!name || name.includes('..') || name.includes('/')) return false;
    return /\.(mp4|jpg)$/.test(name);
}

/**
 * Convierte un nombre de directorio de eventos a un Date.
 * Formato: YYYY Y MM M DD D HH H (14 chars).
 * @param {string} dir - p. ej. "2020Y01M01D01H"
 * @returns {Date|null} - null si el nombre no es válido
 */
function dirNameToDate(dir) {
    if (!isValidDirName(dir)) return null;
    const year = parseInt(dir.slice(0, 4), 10);
    const month = parseInt(dir.slice(5, 7), 10);
    const day = parseInt(dir.slice(8, 10), 10);
    const hour = parseInt(dir.slice(11, 13), 10);
    return new Date(Date.UTC(year, month - 1, day, hour));
}

/**
 * Resuelve la cámara y verifica el ecosistema. Si no es yi-hack, responde
 * 409 y devuelve null. Si no existe, responde 404 y devuelve null.
 * @param {Object} req
 * @param {Object} res
 * @returns {Object|null} - Objeto de cámara o null (ya respondió)
 */
function resolveYiHackCamera(req, res) {
    const cam = registry.getCameraById(req.params.id);
    if (!cam) {
        res.status(404).json({ success: false, error: 'cámara no encontrada' });
        return null;
    }
    const ecosystem = registry.getEcosystem(cam);
    if (ecosystem !== 'yi-hack') {
        res.status(409).json({
            success: false,
            error: `la cámara "${cam.id}" es de ecosistema "${ecosystem}": la gestión de SD requiere firmware yi-hack`
        });
        return null;
    }
    if (!cam.host) {
        res.status(400).json({ success: false, error: 'la cámara no tiene host configurado' });
        return null;
    }
    return cam;
}

/**
 * GET /api/cameras/:id/storage
 *
 * Info de la SD + listado de directorios de eventos.
 * Consulta en paralelo eventsdir.sh (con cache, ver cabecera) y
 * status.json (para free_sd).
 *
 * Respuesta:
 *  - sd: {total_mb, free_mb, used_mb, free_pct} | null
 *  - dirs: array de nombres de directorio (14 chars) | null
 */
router.get('/cameras/:id/storage', async (req, res) => {
    const cam = resolveYiHackCamera(req, res);
    if (!cam) return;

    try {
        const base = `http://${cam.host}`;
        // eventsdir.sh es lento en la cámara: si la cache sigue fresca,
        // se evita el fetch de ~12 s (ver cabecera)
        const cached = getCachedDirs(cam.id);
        const dirsPromise = cached
            ? Promise.resolve(cached)
            : fetchCameraJson(`${base}/cgi-bin/eventsdir.sh`, {}, EVENTSDIR_TIMEOUT_MS)
                .then(parseEventsDir)
                .then(list => {
                    if (list) setCachedDirs(cam.id, list);
                    return list;
                });
        const [dirsRes, statusRes] = await Promise.allSettled([
            dirsPromise,
            fetchCameraJson(`${base}/cgi-bin/status.json`)
        ]);

        const dirs = dirsRes.status === 'fulfilled' ? dirsRes.value : null;
        const status = statusRes.status === 'fulfilled' ? statusRes.value : null;

        // SD calculada (mismo criterio que camera-status.js)
        let sd = null;
        if (status && cam.sd_total_mb) {
            const pct = parseInt(status.free_sd, 10);
            if (!Number.isNaN(pct)) {
                const totalMb = cam.sd_total_mb;
                const freeMb = Math.round((pct / 100) * totalMb);
                sd = {
                    total_mb: totalMb,
                    free_mb: freeMb,
                    used_mb: totalMb - freeMb,
                    free_pct: pct
                };
            }
        }

        res.json({
            success: true,
            data: {
                id: cam.id,
                sd,
                dirs
            }
        });
    } catch (error) {
        console.error('[API] Error al listar storage:', error.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * GET /api/cameras/:id/storage/dirs/:dir/files
 *
 * Listado de ficheros de evento dentro de un directorio
 * (eventsfile.sh?dirname=<dir>). Se pide bajo demanda: la cámara tarda
 * ~0.5 s por directorio, así que no se pre-cargan todos.
 *
 * Respuesta: {dir, date, files: [{time, filename, thumbfilename}]}
 *  - time: p. ej. "Time: 13:27" (formateado por el firmware)
 *  - thumbfilename: "" si no hay thumbnail
 */
router.get('/cameras/:id/storage/dirs/:dir/files', async (req, res) => {
    const cam = resolveYiHackCamera(req, res);
    if (!cam) return;

    const dir = req.params.dir;
    if (!isValidDirName(dir)) {
        return res.status(400).json({ success: false, error: `nombre de directorio inválido: "${dir}"` });
    }

    try {
        const data = await fetchCameraJson(
            `http://${cam.host}/cgi-bin/eventsfile.sh?dirname=${encodeURIComponent(dir)}`
        );
        if (!data || data.error === 'true') {
            return res.status(502).json({ success: false, error: 'cámara no alcanzable' });
        }
        const files = Array.isArray(data.records)
            ? data.records
                .filter(r => r && typeof r.filename === 'string')
                .map(r => ({
                    time: typeof r.time === 'string' ? r.time : '',
                    filename: r.filename,
                    thumbfilename: typeof r.thumbfilename === 'string' ? r.thumbfilename : ''
                }))
            : [];
        res.json({
            success: true,
            data: { dir, date: data.date || null, files }
        });
    } catch (e) {
        console.error('[API] Error al listar ficheros de directorio:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * DELETE /api/cameras/:id/storage/files
 *
 * Cuerpo: {"file": "<dirname>/<filename>.mp4"}
 * Borra un archivo de evento (eventsfiledel.sh). El firmware también
 * borra el thumbnail .jpg correspondiente.
 */
router.delete('/cameras/:id/storage/files', async (req, res) => {
    const cam = resolveYiHackCamera(req, res);
    if (!cam) return;

    const { file } = req.body || {};
    if (!file || typeof file !== 'string') {
        return res.status(400).json({ success: false, error: 'file es requerido (string: "<dirname>/<filename>.mp4")' });
    }
    if (!isValidFilePath(file)) {
        return res.status(400).json({ success: false, error: `ruta de archivo inválida: "${file}"` });
    }

    try {
        await fetchCameraJson(
            `http://${cam.host}/cgi-bin/eventsfiledel.sh?file=${encodeURIComponent(file)}`
        );
        res.json({ success: true, deleted: file });
    } catch (e) {
        console.error('[API] Error al borrar archivo:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * DELETE /api/cameras/:id/storage/dirs
 *
 * Cuerpo: {"dir": "<dirname>"}
 * Borra un directorio de eventos completo (eventsdirdel.sh).
 *
 * NOTA: el firmware tiene un bug en eventsdirdel.sh (validación rota),
 * así que la sanitización estricta en el NVR es la única protección.
 */
router.delete('/cameras/:id/storage/dirs', async (req, res) => {
    const cam = resolveYiHackCamera(req, res);
    if (!cam) return;

    const { dir } = req.body || {};
    if (!dir || typeof dir !== 'string') {
        return res.status(400).json({ success: false, error: 'dir es requerido (string: "<dirname>")' });
    }
    if (!isValidDirName(dir)) {
        return res.status(400).json({ success: false, error: `nombre de directorio inválido: "${dir}"` });
    }

    try {
        await fetchCameraJson(
            `http://${cam.host}/cgi-bin/eventsdirdel.sh?dir=${encodeURIComponent(dir)}`
        );
        forgetCachedDirs(cam.id, [dir]);
        res.json({ success: true, deleted: dir });
    } catch (e) {
        console.error('[API] Error al borrar directorio:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * POST /api/cameras/:id/storage/purge
 *
 * Purge de eventos por scope. Cuerpo:
 *  - {"scope": "all"} — borra TODO (dir=all; incluye timelapse)
 *  - {"scope": "last", "count": N} — borra los N directorios más recientes
 *  - {"scope": "range", "from": "ISO", "to": "ISO"} — borra directorios
 *    dentro del rango [from, to] (inclusive)
 *
 * Los borrados se ejecutan secuencialmente con un retardo de
 * PURGE_DELAY_MS entre cada uno (evita saturar la SD).
 *
 * Respuesta: {success, purged: [nombres], count: N}
 */
router.post('/cameras/:id/storage/purge', async (req, res) => {
    const cam = resolveYiHackCamera(req, res);
    if (!cam) return;

    const { scope, count, from, to } = req.body || {};

    if (!scope || !['all', 'last', 'range'].includes(scope)) {
        return res.status(400).json({
            success: false,
            error: 'scope debe ser "all", "last" o "range"'
        });
    }

    try {
        // Scope "all": un solo CGI, borra todo
        if (scope === 'all') {
            await fetchCameraJson(`http://${cam.host}/cgi-bin/eventsdirdel.sh?dir=all`);
            dirsCache.delete(cam.id);
            return res.json({ success: true, purged: ['all'], count: 1 });
        }

        // Para "last" y "range" necesitamos el listado de directorios
        // (cache primero: eventsdir.sh es lento, ver cabecera)
        let dirs = getCachedDirs(cam.id);
        if (!dirs) {
            const dirsRes = await fetchCameraJson(
                `http://${cam.host}/cgi-bin/eventsdir.sh`, {}, EVENTSDIR_TIMEOUT_MS
            );
            dirs = parseEventsDir(dirsRes) || [];
        }

        let toDelete = [];

        if (scope === 'last') {
            const n = parseInt(count, 10);
            if (!n || n <= 0 || n > 1000) {
                return res.status(400).json({
                    success: false,
                    error: 'count debe ser un entero positivo (1..1000)'
                });
            }
            // Ordenar por fecha (más antiguos primero) y tomar los N últimos
            const sorted = dirs
                .map(d => ({ dir: d, date: dirNameToDate(d) }))
                .filter(d => d.date !== null)
                .sort((a, b) => a.date - b.date);
            toDelete = sorted.slice(-n).map(d => d.dir);
        } else if (scope === 'range') {
            if (!from || !to) {
                return res.status(400).json({
                    success: false,
                    error: 'from y to son requeridos (ISO 8601) para scope "range"'
                });
            }
            const fromDate = new Date(from);
            const toDate = new Date(to);
            if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
                return res.status(400).json({
                    success: false,
                    error: 'from y to deben ser fechas ISO 8601 válidas'
                });
            }
            toDelete = dirs.filter(d => {
                const dt = dirNameToDate(d);
                return dt && dt >= fromDate && dt <= toDate;
            });
        }

        // Borrado secuencial con retardo
        const purged = [];
        for (const dir of toDelete) {
            try {
                await fetchCameraJson(
                    `http://${cam.host}/cgi-bin/eventsdirdel.sh?dir=${encodeURIComponent(dir)}`
                );
                purged.push(dir);
            } catch (e) {
                console.warn(`[API] Purge: fallo al borrar ${dir}:`, e.message);
            }
            if (purged.length < toDelete.length) {
                await new Promise(r => setTimeout(r, PURGE_DELAY_MS));
            }
        }

        forgetCachedDirs(cam.id, purged);
        res.json({ success: true, purged, count: purged.length });
    } catch (error) {
        console.error('[API] Error en purge:', error.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * GET /api/cameras/:id/storage/ftp
 *
 * Lee la configuración de push FTP de la cámara (get_configs.sh?conf=system)
 * y devuelve las claves FTP_* (valores actuales) + `suggested` (valores
 * derivados del NVR: host = IP LAN del NVR, user/pass = ftp-srv, dir =
 * ftp_dir de la cámara) + `in_sync` (true si los campos fijos actuales de
 * la cámara coinciden con los derivados).
 *
 * Respuesta: {FTP_UPLOAD, FTP_HOST, ..., suggested: {FTP_HOST, FTP_DIR,
 *            FTP_USERNAME, FTP_PASSWORD}, in_sync: boolean}
 */
router.get('/cameras/:id/storage/ftp', async (req, res) => {
    const cam = resolveYiHackCamera(req, res);
    if (!cam) return;

    try {
        const conf = await fetchCameraJson(
            `http://${cam.host}/cgi-bin/get_configs.sh?conf=system`
        );
        const ftp = {};
        for (const key of FTP_KEYS) {
            ftp[key] = conf[key] !== undefined ? conf[key] : null;
        }
        const suggested = getFtpSuggestedConfig(cam.ftp_dir);
        const in_sync = FTP_FIXED_KEYS.every(
            key => (ftp[key] || '') === suggested[key]
        );
        res.json({ success: true, data: { ...ftp, suggested, in_sync } });
    } catch (e) {
        console.error('[API] Error al leer config FTP:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * POST /api/cameras/:id/storage/ftp
 *
 * Cuerpo: SOLO switches (subset de FTP_SWITCH_KEYS, valores "yes"/"no"):
 * FTP_UPLOAD, FTP_DIR_TREE, FTP_FILE_DELETE_AFTER_UPLOAD.
 *
 * Los campos fijos (FTP_HOST, FTP_DIR, FTP_USERNAME, FTP_PASSWORD) NO se
 * aceptan del cliente: SIEMPRE se escriben con los valores derivados del
 * NVR (getFtpSuggestedConfig), de modo que el POST es auto-reparador (un
 * "Guardar" re-sincroniza la cámara aunque tenga valores viejos).
 *
 * Escribe la configuración (set_configs.sh?conf=system).
 *
 * NOTA: el servicio ftppush solo ARRANCA en el boot si FTP_UPLOAD=yes;
 * si ya está corriendo, lee la config en vivo (cada 45 s). El cambio
 * de FTP_UPLOAD de no→yes requiere reboot.
 *
 * Respuesta: {success, requires_reboot: bool}
 */
router.post('/cameras/:id/storage/ftp', async (req, res) => {
    const cam = resolveYiHackCamera(req, res);
    if (!cam) return;

    const body = req.body || {};
    // Solo switches editables; los campos fijos los fuerza el NVR
    const payload = {};
    for (const key of FTP_SWITCH_KEYS) {
        if (body[key] !== undefined) {
            if (body[key] !== 'yes' && body[key] !== 'no') {
                return res.status(400).json({
                    success: false,
                    error: `${key} debe ser "yes" o "no"`
                });
            }
            payload[key] = body[key];
        }
    }
    if (Object.keys(payload).length === 0) {
        return res.status(400).json({
            success: false,
            error: `ningún switch editable en el cuerpo (editables: ${FTP_SWITCH_KEYS.join(', ')}; host/usuario/contraseña/carpeta los fuerza el NVR)`
        });
    }
    // Campos fijos SIEMPRE con los valores derivados (ver cabecera)
    const suggested = getFtpSuggestedConfig(cam.ftp_dir);
    for (const key of FTP_FIXED_KEYS) {
        payload[key] = suggested[key];
    }

    try {
        const data = await fetchCameraJson(
            `http://${cam.host}/cgi-bin/set_configs.sh?conf=system`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            },
            SET_CONFIGS_TIMEOUT_MS
        );
        // El CGI responde {"error":"false"} en éxito; "true" = rechazó la
        // escritura (clave inválida, query string inválida, ...)
        if (data && data.error === 'true') {
            console.error('[API] set_configs rechazó la escritura:', JSON.stringify(data));
            return res.status(502).json({ success: false, error: 'la cámara rechazó la configuración' });
        }
        // requires_reboot: solo si se cambia FTP_UPLOAD (el servicio
        // arranca en boot; si ya corre, lee la config en vivo)
        const requiresReboot = payload.FTP_UPLOAD !== undefined;
        res.json({ success: true, requires_reboot: requiresReboot });
    } catch (e) {
        console.error('[API] Error al escribir config FTP:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

module.exports = router;
