/**
 * camera/adapters/yi-hack.js
 *
 * Adapter yi-hack (patrón Adapter/Strategy): la ÚNICA API pública de HTTP
 * hacia cámaras yi-hack. Cada método recibe la cámara `cam` del registro
 * (camera-registry.js: id, host, ftp_dir, ...) como primer argumento.
 *
 * Lógica portada sin cambiar TTL, single-flight ni timeouts:
 *  - camera-status-service.js: caché de probes (TTL env
 *    CAMERA_STATUS_CACHE_TTL_MS, default 30 s, 0 desactiva; single-flight:
 *    la caché guarda la promesa en vuelo, no el valor), los 3 probes, y
 *    setCameraConfig (semántica CONFIG_REJECTED).
 *  - routes/storage.js: fetchCameraJson, sanitización 14-chars,
 *    parseEventsDir, dirsCache (TTL 60 s) y timeouts 5/15/30 s.
 *  - routes/camera-status.js: reboot.sh y HTTPD.
 *  - mqtt/commands.js: whitelist COMMAND_VALUES (re-exportada aquí para que
 *    las rutas no la dupliquen).
 *
 * Los métodos mutantes invalidan la caché de probes de la cámara en éxito
 * (invalidateProbes): las rutas dejan de invalidar manualmente.
 *
 * Timeouts por operación (medidos en cámara real, ver fuentes):
 *  - probes (status.json, get_configs.sh): 3 s
 *  - reboot.sh: 3 s (la cámara puede dejar de responder antes de responder)
 *  - camera_settings.sh (controles inmediatos vía ipc_cmd, §10.2): 5 s
 *  - set_configs.sh?conf=system (aplica en el siguiente boot, §10.2): 15 s
 *  - eventsfile.sh / eventsdirdel.sh / eventsfiledel.sh: 5 s
 *  - eventsdir.sh: 30 s (~13 s en cámara real con ~95 directorios)
 *
 * Errores: el adapter lanza; la capa REST mapea a HTTP (502 "cámara no
 * alcanzable" ante fallo de fetch, 400 ante nombre inválido). Se conserva
 * CONFIG_REJECTED (code "CONFIG_REJECTED", 502, "la cámara rechazó la
 * configuración") de set_configs.sh.
 */

// Timeouts (ms): portados de camera-status-service.js (3 s) y
// routes/storage.js (5/15/30 s)
const PROBE_TIMEOUT_MS = 3000;
const REBOOT_TIMEOUT_MS = 3000;
const CAMERA_SETTINGS_TIMEOUT_MS = 5000;
const SET_CONFIGS_TIMEOUT_MS = 15000;
const EVENT_OP_TIMEOUT_MS = 5000;
const EVENTSDIR_TIMEOUT_MS = 30000;

// TTL de la caché de probes por cámara (ms). Env CAMERA_STATUS_CACHE_TTL_MS;
// default 30 s; 0 desactiva la caché (siempre sondear).
const PROBE_CACHE_TTL_MS = (() => {
    const raw = process.env.CAMERA_STATUS_CACHE_TTL_MS;
    if (raw === undefined || raw === '') return 30000;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 30000;
})();

// Caché de probes por cámara: cam.id -> { ts, promise }. Single-flight:
// guarda la promesa del probe en curso, así las peticiones concurrentes
// dentro del TTL comparten un solo sondeo.
const probeCache = new Map();

// Whitelist de comandos y sus valores válidos: exactamente las 15 keys que
// camera_settings.sh maneja (verificadas en el firmware v0.3.6,
// docs/CAMERA-CGI-REFERENCE.md §10.3). Portada de mqtt/commands.js y
// re-exportada para que las rutas la reutilicen sin duplicarla.
// NO incluye baby_crying_detect (solo existe vía MQTT en el firmware,
// ipc_cmd -B; el NVR no publica MQTT) ni local_record (no existe en este
// firmware, solo en el fork sonoff): el CGI las ignoraría en silencio
// (no-op con error:false).
const COMMAND_VALUES = {
    // on/off
    led: ['on', 'off'],
    ir: ['on', 'off'],
    rotate: ['on', 'off'],
    motion_detection: ['on', 'off'],
    save_video_on_motion: ['on', 'off'],
    sound_detection: ['on', 'off'],
    ai_human_detection: ['on', 'off'],
    ai_vehicle_detection: ['on', 'off'],
    ai_animal_detection: ['on', 'off'],
    face_detection: ['on', 'off'],
    motion_tracking: ['on', 'off'],
    // yes/no
    switch_on: ['yes', 'no'],
    // niveles
    sensitivity: ['low', 'medium', 'high'],
    sound_sensitivity: ['30', '35', '40', '45', '50', '60', '70', '80', '90'],
    // crucero
    cruise: ['no', 'presets', '360']
};

// TTL de la caché del listado de directorios (eventsdir.sh es lento, ver
// EVENTSDIR_TIMEOUT_MS). Se invalida explícitamente tras borrados.
const DIRS_CACHE_TTL_MS = 60000;

// Caché del listado de directorios por cámara: cam.id -> { dirs, ts }
const dirsCache = new Map();

// Capabilities del adapter: qué métodos existen (la factory lo usa para
// documentar la superficie de este ecosistema).
const capabilities = Object.freeze({
    getProbes: true,
    getStatus: true,
    getCameraConfig: true,
    getSystemConfig: true,
    invalidateProbes: true,
    setSwitchOn: true,
    setLed: true,
    setIr: true,
    setSaveVideoOnMotion: true,
    setCommand: true,
    setHttpd: true,
    setRecWithoutCloud: true,
    setFtpPushConfig: true,
    setCameraConfig: true,
    listEventDirs: true,
    listEventFiles: true,
    deleteEventDir: true,
    deleteEventFile: true,
    reboot: true
});

/**
 * Fetch de un CGI que responde JSON. Lanza si la cámara no responde, el
 * timeout se agota o la respuesta no es JSON.
 * @param {string} url
 * @param {Object} [options] - Opciones de fetch (method, headers, body)
 * @param {number} [timeoutMs] - Timeout (por defecto EVENT_OP_TIMEOUT_MS)
 * @returns {Promise<Object>} - JSON parseado (sin el sentinel "NULL")
 */
async function fetchCameraJson(url, options = {}, timeoutMs = EVENT_OP_TIMEOUT_MS) {
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
    // get_configs.sh cierra el JSON con el sentinel "NULL":"NULL"
    if (data && typeof data === 'object' && 'NULL' in data) {
        delete data.NULL;
    }
    return data;
}

/**
 * Devuelve la promesa del probe en curso/reciente si sigue fresca (TTL),
 * o null (hay que lanzar un probe nuevo).
 * @param {string} id
 * @returns {Promise<Array>|null}
 */
function getCachedProbes(id) {
    if (PROBE_CACHE_TTL_MS <= 0) return null;
    const entry = probeCache.get(id);
    if (entry && Date.now() - entry.ts < PROBE_CACHE_TTL_MS) return entry.promise;
    return null;
}

/**
 * Lanza los 3 probes HTTP de la cámara en paralelo (status.json,
 * get_configs.sh?conf=camera y ?conf=system; PROBE_TIMEOUT_MS cada uno).
 * @param {Object} cam - Objeto de cámara del registro (con host)
 * @returns {Promise<Array>} - [statusRes, camConfRes, sysConfRes] (settled)
 */
function fetchProbes(cam) {
    const base = `http://${cam.host}`;
    return Promise.allSettled([
        fetchCameraJson(`${base}/cgi-bin/status.json`, {}, PROBE_TIMEOUT_MS),
        fetchCameraJson(`${base}/cgi-bin/get_configs.sh?conf=camera`, {}, PROBE_TIMEOUT_MS),
        fetchCameraJson(`${base}/cgi-bin/get_configs.sh?conf=system`, {}, PROBE_TIMEOUT_MS)
    ]);
}

/**
 * Devuelve la promesa de los 3 probes de la cámara, sirviéndola desde la
 * caché si sigue fresca (TTL) o lanzándola y cacheándola si no (single-
 * flight). Es la ÚNICA puerta de lectura de los 3 CGI de estado: cualquier
 * lectura de status.json / get_configs debe pasar por aquí para que quede
 * DENTRO de la caché.
 * @param {Object} cam - Objeto de cámara del registro (con host)
 * @returns {Promise<Array>} - [statusRes, camConfRes, sysConfRes] (settled)
 */
function getProbes(cam) {
    let probePromise = getCachedProbes(cam.id);
    if (!probePromise) {
        probePromise = fetchProbes(cam);
        probeCache.set(cam.id, { ts: Date.now(), promise: probePromise });
    }
    return probePromise;
}

/**
 * Invalida la caché de probes de una cámara: la próxima lectura sondeará de
 * nuevo. La llaman los métodos mutantes en éxito (las rutas ya no la
 * invalidan manualmente).
 * @param {Object} cam - Objeto de cámara del registro (con id)
 */
function invalidateProbes(cam) {
    probeCache.delete(cam.id);
}

/**
 * Lee status.json a través de la caché de probes.
 * @param {Object} cam
 * @returns {Promise<Object|null>} - JSON de status.json, o null si el probe
 *   falló (la cámara no respondió / no-JSON)
 */
async function getStatus(cam) {
    const [statusRes] = await getProbes(cam);
    return statusRes.status === 'fulfilled' ? statusRes.value : null;
}

/**
 * Lee get_configs.sh?conf=camera a través de la caché de probes.
 * @param {Object} cam
 * @returns {Promise<Object|null>} - conf de cámara, o null si el probe falló
 */
async function getCameraConfig(cam) {
    const probes = await getProbes(cam);
    const camConfRes = probes[1];
    return camConfRes.status === 'fulfilled' ? camConfRes.value : null;
}

/**
 * Lee get_configs.sh?conf=system a través de la caché de probes.
 * @param {Object} cam
 * @returns {Promise<Object|null>} - conf de sistema, o null si el probe falló
 */
async function getSystemConfig(cam) {
    const probes = await getProbes(cam);
    const sysConfRes = probes[2];
    return sysConfRes.status === 'fulfilled' ? sysConfRes.value : null;
}

/**
 * Normaliza un valor (booleano o string) al formato yes/no de la conf.
 * @param {*} value
 * @returns {string} - "yes" | "no"
 */
function toYesNo(value) {
    return value === true || value === 'yes' || value === 'on' ? 'yes' : 'no';
}

/**
 * Convierte un valor de whitelist (on/off/yes/no/...) al valor que espera
 * camera_settings.sh (yes/no para booleanos; el resto pasa tal cual).
 * @param {string} value
 * @returns {string}
 */
function toCgiValue(value) {
    if (value === 'on') return 'yes';
    if (value === 'off') return 'no';
    return value;
}

/**
 * Escribe un parámetro en la conf de cámara vía camera_settings.sh (Opción
 * A: aplicación INMEDIATA vía ipc_cmd, ver docs/CAMERA-CGI-REFERENCE.md
 * §10.2). Invalida la caché de probes en éxito.
 * @param {Object} cam
 * @param {string} key - Parámetro del CGI (switch_on, led, ir, ...)
 * @param {string} value - Valor (on/off/yes/no/low/...; se normaliza)
 * @returns {Promise<Object|null>} - JSON del CGI si es parseable
 */
async function setViaCameraSettings(cam, key, value) {
    const url = `http://${cam.host}/cgi-bin/camera_settings.sh?${encodeURIComponent(key)}=${encodeURIComponent(toCgiValue(value))}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(CAMERA_SETTINGS_TIMEOUT_MS) });
    if (!res.ok) {
        const err = new Error(`camera_settings.sh respondió HTTP ${res.status}`);
        err.status = 502;
        throw err;
    }
    // Respuesta verificada en el firmware (v0.3.6, §10.3): SIEMPRE JSON —
    // {"error":"false"} en éxito (para TODAS las keys, no solo IR) y
    // {"error":"true"} solo si el query string no pasa validate.sh. Se
    // tolera no-JSON por si una versión distinta cambia el formato.
    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (e) {
        data = null;
    }
    if (data && data.error === 'true') {
        const err = new Error('la cámara rechazó la configuración');
        err.status = 502;
        err.code = 'CONFIG_REJECTED';
        throw err;
    }
    invalidateProbes(cam);
    return data;
}

/**
 * Enciende/apaga la cámara (camera_settings.sh, switch_on yes/no).
 * @param {Object} cam
 * @param {boolean|string} value - true/false, "yes"/"no" u "on"/"off"
 */
function setSwitchOn(cam, value) {
    return setViaCameraSettings(cam, 'switch_on', toYesNo(value));
}

/**
 * Enciende/apaga el LED (camera_settings.sh, led yes/no).
 * @param {Object} cam
 * @param {boolean|string} value
 */
function setLed(cam, value) {
    return setViaCameraSettings(cam, 'led', toYesNo(value));
}

/**
 * Enciende/apaga el IR-cut / visión nocturna (camera_settings.sh, ir
 * yes/no; verificado en firmware: ir=yes → ipc_cmd -i on, §10.1).
 * @param {Object} cam
 * @param {boolean|string} value
 */
function setIr(cam, value) {
    return setViaCameraSettings(cam, 'ir', toYesNo(value));
}

/**
 * Activa/desactiva la grabación por movimiento (camera_settings.sh,
 * save_video_on_motion yes/no).
 * @param {Object} cam
 * @param {boolean|string} value
 */
function setSaveVideoOnMotion(cam, value) {
    return setViaCameraSettings(cam, 'save_video_on_motion', toYesNo(value));
}

/**
 * Comando genérico validado contra la whitelist COMMAND_VALUES
 * (camera_settings.sh, aplicación inmediata).
 * @param {Object} cam
 * @param {string} key - Comando (p. ej. "led", "sensitivity", "cruise")
 * @param {string} value - Valor permitido para ese comando
 * @throws {Error} - code "INVALID" (400) si el comando o el valor no están
 *   en la whitelist
 */
async function setCommand(cam, key, value) {
    const allowed = COMMAND_VALUES[key];
    if (!allowed) {
        const err = new Error(`Comando no soportado: "${key}" (válidos: ${Object.keys(COMMAND_VALUES).join(', ')})`);
        err.code = 'INVALID';
        err.status = 400;
        throw err;
    }
    if (!allowed.includes(value)) {
        const err = new Error(`Valor inválido para "${key}": "${value}" (válidos: ${allowed.join(', ')})`);
        err.code = 'INVALID';
        err.status = 400;
        throw err;
    }
    return setViaCameraSettings(cam, key, value);
}

/**
 * Escribe claves en la conf de sistema vía set_configs.sh?conf=system
 * (aplica en el SIGUIENTE boot, §10.2). Invalida la caché de probes en
 * éxito. ÚNICO punto de escritura de system.conf del API.
 * @param {Object} cam
 * @param {Object<string, string>} payload - Claves a escribir
 * @param {number} [timeoutMs] - Timeout (default SET_CONFIGS_TIMEOUT_MS)
 * @returns {Promise<Object>} - JSON del CGI (sin el sentinel "NULL")
 * @throws {Error} - code "CONFIG_REJECTED" (502) si el CGI rechazó la
 *   escritura (error: "true")
 */
async function writeSystemConfig(cam, payload, timeoutMs = SET_CONFIGS_TIMEOUT_MS) {
    const data = await fetchCameraJson(
        `http://${cam.host}/cgi-bin/set_configs.sh?conf=system`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        },
        timeoutMs
    );
    // El CGI responde {"error":"false"} en éxito; "true" = rechazó la
    // escritura (clave inválida, query string inválida, ...)
    if (data && data.error === 'true') {
        const err = new Error('la cámara rechazó la configuración');
        err.status = 502;
        err.code = 'CONFIG_REJECTED';
        throw err;
    }
    invalidateProbes(cam);
    return data;
}

/**
 * Escape hatch: escribe UNA clave en la conf de sistema
 * (set_configs.sh?conf=system, aplica en el siguiente boot).
 * @param {Object} cam
 * @param {string} key - Clave de system.conf (p. ej. "HTTPD", "RTSP")
 * @param {string} value - Valor a escribir
 */
function setCameraConfig(cam, key, value) {
    return writeSystemConfig(cam, { [key]: value });
}

/**
 * Activa/desactiva el servidor HTTP de la cámara (HTTPD yes/no en
 * system.conf; el firmware solo lo lee al arrancar, así que el cambio se
 * aplica en el siguiente reboot).
 * @param {Object} cam
 * @param {boolean|string} value - true/false, "yes"/"no" u "on"/"off"
 */
function setHttpd(cam, value) {
    return writeSystemConfig(cam, { HTTPD: toYesNo(value) });
}

/**
 * Activa/desactiva la grabación de videos en la tarjeta SD (REC_WITHOUT_CLOUD
 * yes/no en system.conf: yes → grabación local en SD, no → solo stream RTSP).
 * El firmware solo lee system.conf al arrancar, así que el cambio se aplica
 * en el siguiente boot (no reinicia la cámara).
 * @param {Object} cam
 * @param {boolean|string} value - true/false, "yes"/"no" u "on"/"off"
 */
function setRecWithoutCloud(cam, value) {
    return writeSystemConfig(cam, { REC_WITHOUT_CLOUD: toYesNo(value) });
}

/**
 * Escribe la config de push FTP completa (switches + campos fijos derivados
 * por el NVR) en system.conf (aplica en el siguiente boot; ftppush la lee en
 * vivo cada 45 s si el servicio ya corre).
 * @param {Object} cam
 * @param {Object<string, string>} config - Payload completo (FTP_UPLOAD,
 *   FTP_HOST, FTP_DIR, FTP_USERNAME, FTP_PASSWORD, ...)
 */
function setFtpPushConfig(cam, config) {
    return writeSystemConfig(cam, config);
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
 * Parsea la respuesta de eventsdir.sh. La cámara devuelve
 * {"records":[{"datetime":"...","dirname":"..."}, ...]}; se tolera también
 * un array plano de nombres (otras versiones).
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
 * Lista los directorios de eventos de la SD (eventsdir.sh, 30 s, con
 * dirsCache de 60 s: el CGI tarda ~13 s en cámara real).
 * @param {Object} cam
 * @returns {Promise<string[]|null>} - Nombres de directorio (14 chars), o
 *   null si la respuesta no tiene forma reconocible
 */
async function listEventDirs(cam) {
    const cached = getCachedDirs(cam.id);
    if (cached) return cached;
    const data = await fetchCameraJson(
        `http://${cam.host}/cgi-bin/eventsdir.sh`, {}, EVENTSDIR_TIMEOUT_MS
    );
    const list = parseEventsDir(data);
    if (list) setCachedDirs(cam.id, list);
    return list;
}

/**
 * Lista los ficheros de un directorio de eventos (eventsfile.sh, bajo
 * demanda: la cámara tarda ~0,5 s por directorio).
 * @param {Object} cam
 * @param {string} dir - Nombre de directorio (14 chars, validado aquí)
 * @returns {Promise<{dir: string, date: string|null, files: Array<{time: string, filename: string, thumbfilename: string}>}>}
 * @throws {Error} - status 400 si el nombre de directorio es inválido;
 *   502 si la cámara no responde o rechaza
 */
async function listEventFiles(cam, dir) {
    if (!isValidDirName(dir)) {
        const err = new Error(`nombre de directorio inválido: "${dir}"`);
        err.status = 400;
        throw err;
    }
    const data = await fetchCameraJson(
        `http://${cam.host}/cgi-bin/eventsfile.sh?dirname=${encodeURIComponent(dir)}`,
        {}, EVENT_OP_TIMEOUT_MS
    );
    if (!data || data.error === 'true') {
        const err = new Error('cámara no alcanzable');
        err.status = 502;
        throw err;
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
    return { dir, date: data.date || null, files };
}

/**
 * Borra un directorio de eventos completo (eventsdirdel.sh). El firmware
 * tiene un bug en la validación de ese CGI, así que la sanitización
 * estricta aquí es la única protección. Invalida dirsCache y la caché de
 * probes (liberar espacio cambia free_sd de status.json).
 * @param {Object} cam
 * @param {string} dir - Nombre de directorio (14 chars, validado aquí)
 * @returns {Promise<string>} - El nombre borrado
 * @throws {Error} - status 400 si el nombre es inválido
 */
async function deleteEventDir(cam, dir) {
    if (!isValidDirName(dir)) {
        const err = new Error(`nombre de directorio inválido: "${dir}"`);
        err.status = 400;
        throw err;
    }
    await fetchCameraJson(
        `http://${cam.host}/cgi-bin/eventsdirdel.sh?dir=${encodeURIComponent(dir)}`,
        {}, EVENT_OP_TIMEOUT_MS
    );
    forgetCachedDirs(cam.id, [dir]);
    invalidateProbes(cam);
    return dir;
}

/**
 * Borra un archivo de evento (eventsfiledel.sh; el firmware también borra el
 * thumbnail .jpg correspondiente). Invalida la caché de probes (liberar
 * espacio cambia free_sd de status.json).
 * @param {Object} cam
 * @param {string} dir - Nombre de directorio (14 chars)
 * @param {string} file - Nombre de archivo (p. ej. "00M00S60.mp4")
 * @returns {Promise<string>} - Ruta completa borrada (<dir>/<file>)
 * @throws {Error} - status 400 si la ruta es inválida
 */
async function deleteEventFile(cam, dir, file) {
    const path = `${dir}/${file}`;
    if (!isValidFilePath(path)) {
        const err = new Error(`ruta de archivo inválida: "${path}"`);
        err.status = 400;
        throw err;
    }
    await fetchCameraJson(
        `http://${cam.host}/cgi-bin/eventsfiledel.sh?file=${encodeURIComponent(path)}`,
        {}, EVENT_OP_TIMEOUT_MS
    );
    invalidateProbes(cam);
    return path;
}

/**
 * Reinicia la cámara (CGI reboot.sh: sync×3, killall mqttv4, sleep 1,
 * reboot). Lanza si el fetch falla (la capa REST lo mapea a 502 "cámara no
 * alcanzable"); en éxito invalida la caché de probes (el estado cacheado es
 * inservible).
 * @param {Object} cam
 * @returns {Promise<boolean>} - true (reboot en marcha)
 */
async function reboot(cam) {
    await fetchCameraJson(`http://${cam.host}/cgi-bin/reboot.sh`, {}, REBOOT_TIMEOUT_MS);
    invalidateProbes(cam);
    return true;
}

module.exports = {
    capabilities,
    COMMAND_VALUES,
    getProbes,
    getStatus,
    getCameraConfig,
    getSystemConfig,
    invalidateProbes,
    setSwitchOn,
    setLed,
    setIr,
    setSaveVideoOnMotion,
    setCommand,
    setHttpd,
    setRecWithoutCloud,
    setFtpPushConfig,
    setCameraConfig,
    listEventDirs,
    listEventFiles,
    deleteEventDir,
    deleteEventFile,
    reboot
};
