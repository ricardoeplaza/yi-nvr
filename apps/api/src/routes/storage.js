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
 * todas las rutas devuelven 409 UNSUPPORTED_ECOSYSTEM (lo responde
 * resolveCameraFor, ver camera/index.js).
 *
 * Toda la lógica de dispositivo (fetch CGI, sanitización 14-chars, cachés
 * de dirs/probes) vive en el adapter (camera/adapters/yi-hack.js); esta
 * ruta solo compone: resolución de cámara (resolveCameraFor), validación de
 * parámetros del cuerpo, orquestación del purge y derivación de la config
 * FTP del NVR (getFtpSuggestedConfig).
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
const { resolveCameraFor } = require('../camera');
const { buildSd } = require('../camera-status-service');
const { getFtpSuggestedConfig } = require('../ftp');

const router = express.Router();

// Retardo entre borrados secuenciales en el purge (evita saturar la SD
// y da tiempo al firmware a actualizar su índice interno)
const PURGE_DELAY_MS = 500;

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
 * Convierte un nombre de directorio de eventos a un Date.
 * Formato: YYYY Y MM M DD D HH H (14 chars).
 * @param {string} dir - p. ej. "2020Y01M01D01H"
 * @returns {Date|null} - null si el nombre no es válido
 */
function dirNameToDate(dir) {
    if (!/^\d{4}Y\d{2}M\d{2}D\d{2}H$/.test(dir)) return null;
    const year = parseInt(dir.slice(0, 4), 10);
    const month = parseInt(dir.slice(5, 7), 10);
    const day = parseInt(dir.slice(8, 10), 10);
    const hour = parseInt(dir.slice(11, 13), 10);
    return new Date(Date.UTC(year, month - 1, day, hour));
}

/**
 * GET /api/cameras/:id/storage
 *
 * Info de la SD + listado de directorios de eventos.
 * Consulta en paralelo eventsdir.sh (listEventDirs: caché TTL de 60 s
 * dentro del adapter, el CGI tarda ~13 s en cámara real) y status.json
 * (getStatus, dentro de la caché de probes del adapter).
 *
 * Respuesta:
 *  - sd: {total_mb, free_mb, used_mb, free_pct} | null
 *  - dirs: array de nombres de directorio (14 chars) | null
 */
router.get('/cameras/:id/storage', async (req, res) => {
    const r = resolveCameraFor(req, res, 'listEventDirs');
    if (!r) return;
    const { cam, adapter } = r;

    try {
        // listEventDirs lanza si la cámara no responde: se tolera (dirs null),
        // igual que antes (allSettled). getStatus nunca lanza (null si el
        // probe falló).
        const [dirs, status] = await Promise.all([
            adapter.listEventDirs(cam).catch(() => null),
            adapter.getStatus(cam)
        ]);

        res.json({
            success: true,
            data: {
                id: cam.id,
                sd: buildSd(status ? status.free_sd : null, cam.sd_total_mb),
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
    const r = resolveCameraFor(req, res, 'listEventFiles');
    if (!r) return;
    const { cam, adapter } = r;

    try {
        const data = await adapter.listEventFiles(cam, req.params.dir);
        res.json({ success: true, data });
    } catch (e) {
        if (e.status === 400) {
            return res.status(400).json({ success: false, error: e.message });
        }
        console.error('[API] Error al listar ficheros de directorio:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * DELETE /api/cameras/:id/storage/files
 *
 * Cuerpo: {"file": "<dirname>/<filename>.mp4"}
 * Borra un archivo de evento (eventsfiledel.sh). El firmware también
 * borra el thumbnail .jpg correspondiente. La sanitización de la ruta
 * la hace el adapter (deleteEventFile).
 */
router.delete('/cameras/:id/storage/files', async (req, res) => {
    const r = resolveCameraFor(req, res, 'deleteEventFile');
    if (!r) return;
    const { cam, adapter } = r;

    const { file } = req.body || {};
    if (!file || typeof file !== 'string') {
        return res.status(400).json({ success: false, error: 'file es requerido (string: "<dirname>/<filename>.mp4")' });
    }
    const parts = file.split('/');

    try {
        const deleted = await adapter.deleteEventFile(cam, parts[0], parts[1]);
        res.json({ success: true, deleted });
    } catch (e) {
        if (e.status === 400) {
            return res.status(400).json({ success: false, error: e.message });
        }
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
 * así que la sanitización estricta del adapter (deleteEventDir) es la
 * única protección.
 */
router.delete('/cameras/:id/storage/dirs', async (req, res) => {
    const r = resolveCameraFor(req, res, 'deleteEventDir');
    if (!r) return;
    const { cam, adapter } = r;

    const { dir } = req.body || {};
    if (!dir || typeof dir !== 'string') {
        return res.status(400).json({ success: false, error: 'dir es requerido (string: "<dirname>")' });
    }

    try {
        const deleted = await adapter.deleteEventDir(cam, dir);
        res.json({ success: true, deleted });
    } catch (e) {
        if (e.status === 400) {
            return res.status(400).json({ success: false, error: e.message });
        }
        console.error('[API] Error al borrar directorio:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * POST /api/cameras/:id/storage/purge
 *
 * Purge de eventos por scope. Cuerpo:
 *  - {"scope": "all"} — borra TODO el listado de directorios
 *  - {"scope": "last", "count": N} — borra los N directorios más recientes
 *  - {"scope": "range", "from": "ISO", "to": "ISO"} — borra directorios
 *    dentro del rango [from, to] (inclusive)
 *
 * Orquestación de la ruta sobre el adapter: listEventDirs (caché TTL de
 * 60 s) + borrado secuencial con deleteEventDir y un retardo de
 * PURGE_DELAY_MS entre cada uno (evita saturar la SD).
 *
 * Respuesta: {success, purged: [nombres], count: N}
 */
router.post('/cameras/:id/storage/purge', async (req, res) => {
    const r = resolveCameraFor(req, res, 'listEventDirs');
    if (!r) return;
    const { cam, adapter } = r;

    const { scope, count, from, to } = req.body || {};

    if (!scope || !['all', 'last', 'range'].includes(scope)) {
        return res.status(400).json({
            success: false,
            error: 'scope debe ser "all", "last" o "range"'
        });
    }

    try {
        // Listado de directorios (caché del adapter: eventsdir.sh es lento)
        const dirs = (await adapter.listEventDirs(cam)) || [];

        let toDelete = [];

        if (scope === 'all') {
            toDelete = dirs;
        } else if (scope === 'last') {
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

        // Borrado secuencial con retardo (deleteEventDir invalida sus
        // propias cachés de dirs y probes en éxito)
        const purged = [];
        for (const dir of toDelete) {
            try {
                await adapter.deleteEventDir(cam, dir);
                purged.push(dir);
            } catch (e) {
                console.warn(`[API] Purge: fallo al borrar ${dir}:`, e.message);
            }
            if (purged.length < toDelete.length) {
                await new Promise(resolve => setTimeout(resolve, PURGE_DELAY_MS));
            }
        }

        res.json({ success: true, purged, count: purged.length });
    } catch (error) {
        console.error('[API] Error en purge:', error.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

/**
 * GET /api/cameras/:id/storage/ftp
 *
 * Lee la configuración de push FTP de la cámara (get_configs.sh?conf=system
 * a través de la caché de probes del adapter: getSystemConfig) y devuelve
 * las claves FTP_* (valores actuales) + `suggested` (valores derivados del
 * NVR: host = IP LAN del NVR, user/pass = ftp-srv, dir = ftp_dir de la
 * cámara) + `in_sync` (true si los campos fijos actuales de la cámara
 * coinciden con los derivados).
 *
 * Respuesta: {FTP_UPLOAD, FTP_HOST, ..., suggested: {FTP_HOST, FTP_DIR,
 *            FTP_USERNAME, FTP_PASSWORD}, in_sync: boolean}
 */
router.get('/cameras/:id/storage/ftp', async (req, res) => {
    const r = resolveCameraFor(req, res, 'getSystemConfig');
    if (!r) return;
    const { cam, adapter } = r;

    try {
        const conf = await adapter.getSystemConfig(cam);
        if (!conf) {
            return res.status(502).json({ success: false, error: 'cámara no alcanzable' });
        }
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
 * Escribe la configuración (set_configs.sh?conf=system, vía
 * adapter.setFtpPushConfig; aplica en el siguiente boot).
 *
 * NOTA: el servicio ftppush solo ARRANCA en el boot si FTP_UPLOAD=yes;
 * si ya está corriendo, lee la config en vivo (cada 45 s). El cambio
 * de FTP_UPLOAD de no→yes requiere reboot.
 *
 * Respuesta: {success, requires_reboot: bool}
 */
router.post('/cameras/:id/storage/ftp', async (req, res) => {
    const r = resolveCameraFor(req, res, 'setFtpPushConfig');
    if (!r) return;
    const { cam, adapter } = r;

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
        // setFtpPushConfig invalida la caché de probes si la escritura
        // tiene éxito (único punto de escritura CGI del adapter).
        await adapter.setFtpPushConfig(cam, payload);
        // requires_reboot: solo si se cambia FTP_UPLOAD (el servicio
        // arranca en boot; si ya corre, lee la config en vivo)
        const requiresReboot = payload.FTP_UPLOAD !== undefined;
        res.json({ success: true, requires_reboot: requiresReboot });
    } catch (e) {
        if (e.code === 'CONFIG_REJECTED') {
            console.error('[API] set_configs rechazó la escritura:', e.message);
            return res.status(502).json({ success: false, error: 'la cámara rechazó la configuración' });
        }
        console.error('[API] Error al escribir config FTP:', e.message);
        res.status(502).json({ success: false, error: 'cámara no alcanzable' });
    }
});

module.exports = router;
