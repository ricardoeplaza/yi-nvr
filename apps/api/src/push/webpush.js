/**
 * push/webpush.js
 *
 * Módulo de notificaciones Web Push (npm `web-push` + VAPID).
 *
 * Responsabilidades:
 *  - Gestión de suscripciones (tabla `push_subscriptions` de database.js):
 *    subscribe/unsubscribe con validación mínima (endpoint + keys p256dh/auth).
 *  - `notify({title, body, icon, url, data})`: fan-out de una notificación a
 *    TODAS las suscripciones. Es a prueba de fallos por diseño:
 *      - Sin claves VAPID configuradas → modo noop (debug log, no envía).
 *      - Cada envío se envuelve en try/catch + manejo de promesa: una
 *        suscripción mala NO tumba el fan-out ni lanza al llamador.
 *      - HTTP 404/410 → la suscripción caducó y se borra de la tabla.
 *      - HTTP 2xx → se actualiza `last_used_at`.
 *      - Todos los fallos se loguean con prefijo [Push] (warn/error).
 *  - Limpieza periódica de suscripciones antiguas (`cleanupStale`): un
 *    `setInterval` diario con offset aleatorio de 0-30 min (estilo job,
 *    timers con `.unref()` para no bloquear el shutdown).
 *
 * Formato del payload (decisión fase 4, ver docs/ARCHITECTURE.md):
 * JSON `{title, body, icon, url, data}` — el service worker del frontend
 * (fase 5) lo lee y construye la `Notification` del navegador.
 *
 * Claves VAPID (SOLO en .env, nunca en git):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL
 * Generación: `npx web-push generate-vapid-keys`
 */

const webpush = require('web-push');
const {
    upsertPushSubscription,
    getAllPushSubscriptions,
    deletePushSubscription,
    deleteStalePushSubscriptions,
    touchPushSubscription
} = require('../database');

// Intervalo del job de limpieza (24 h) y rango del offset aleatorio (0-30 min)
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_OFFSET_MAX_MS = 30 * 60 * 1000;

// Timer del job (null = job no iniciado)
let cleanupTimer = null;

/**
 * Indica si las claves VAPID necesarias están en el entorno.
 * Se lee en cada llamada (no se cachea) para que los cambios en .env tras un
 * reload del watch-mode se reflejen sin reiniciar.
 * @returns {boolean}
 */
function isConfigured() {
    return Boolean(
        process.env.VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY &&
        process.env.VAPID_CONTACT_EMAIL
    );
}

/**
 * Devuelve la clave pública VAPID (o null si no está configurada).
 * @returns {string|null}
 */
function getPublicKey() {
    return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Valida y guarda una suscripción de push (upsert por endpoint).
 * @param {Object} sub - PushSubscription estándar: {endpoint, keys: {p256dh,
 *   auth}, expirationTime?} + userAgent opcional (userAgent o user_agent).
 * @returns {Object} - La fila guardada
 * @throws {Error} - Con `status` 400 si falta endpoint o keys
 */
function subscribe(sub) {
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint === '') {
        const err = new Error('falta "endpoint" en la suscripción');
        err.status = 400;
        throw err;
    }
    const p256dh = sub.keys && sub.keys.p256dh;
    const auth = sub.keys && sub.keys.auth;
    if (typeof p256dh !== 'string' || p256dh === '' ||
        typeof auth !== 'string' || auth === '') {
        const err = new Error('faltan "keys.p256dh" y/o "keys.auth" en la suscripción');
        err.status = 400;
        throw err;
    }

    const userAgent = typeof sub.userAgent === 'string'
        ? sub.userAgent
        : (typeof sub.user_agent === 'string' ? sub.user_agent : undefined);

    return upsertPushSubscription({
        endpoint: sub.endpoint,
        p256dh,
        auth,
        userAgent
    });
}

/**
 * Elimina una suscripción por su endpoint (no lanza si no existe).
 * @param {string} endpoint
 * @returns {boolean} - true si existía
 * @throws {Error} - Con `status` 400 si falta el endpoint
 */
function unsubscribe(endpoint) {
    if (typeof endpoint !== 'string' || endpoint === '') {
        const err = new Error('falta "endpoint"');
        err.status = 400;
        throw err;
    }
    return deletePushSubscription(endpoint);
}

/**
 * Envía una notificación a todas las suscripciones (fan-out).
 *
 * Nunca lanza: los errores individuales se loguean con [Push] y el resumen
 * los cuenta. Sin claves VAPID → noop (debug log) para que el llamador no
 * tenga que distinguir el modo dev sin push.
 *
 * @param {{title: string, body: string, icon?: string, url?: string, data?: *}} notification
 * @returns {Promise<{delivered: number, failed: number, removed: number, noop?: boolean}>}
 */
async function notify(notification) {
    const { title, body, icon, url, data } = notification || {};

    if (!isConfigured()) {
        console.debug(`[Push] VAPID no configurado, notificando en modo noop: ${title}`);
        return { delivered: 0, failed: 0, removed: 0, noop: true };
    }

    const subs = getAllPushSubscriptions();
    const summary = { delivered: 0, failed: 0, removed: 0 };
    if (subs.length === 0) {
        return summary;
    }

    const payload = JSON.stringify({ title, body, icon, url, data });
    const vapidDetails = {
        subject: process.env.VAPID_CONTACT_EMAIL,
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY
    };

    const sends = subs.map(sub => {
        const subscription = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
        };

        let promise;
        try {
            promise = webpush.sendNotification(subscription, payload, { vapidDetails });
        } catch (err) {
            summary.failed += 1;
            console.error(`[Push] Error preparando envío a ${sub.endpoint}:`, err.message);
            return Promise.resolve();
        }

        // web-push resuelve solo con 2xx ({statusCode, body, headers}) y
        // rechaza con WebPushError (propiedad `statusCode`) en el resto.
        return promise.then(resp => {
            summary.delivered += 1;
            try {
                touchPushSubscription(sub.endpoint);
            } catch (e) {
                console.warn(`[Push] No se pudo actualizar last_used_at de ${sub.endpoint}:`, e.message);
            }
        }).catch(err => {
            const status = err && err.statusCode;
            if (status === 404 || status === 410) {
                summary.removed += 1;
                console.warn(`[Push] Suscripción caducada (HTTP ${status}), eliminada: ${sub.endpoint}`);
                try {
                    deletePushSubscription(sub.endpoint);
                } catch (e) {
                    console.error(`[Push] No se pudo borrar la suscripción ${sub.endpoint}:`, e.message);
                }
            } else {
                summary.failed += 1;
                console.error(`[Push] Error enviando a ${sub.endpoint}:`, err.message);
            }
        });
    });

    // Esperamos a todas: el resumen es fiable y el llamador puede ignorar
    // la promesa si prefiere fire-and-forget.
    await Promise.allSettled(sends);
    return summary;
}

/**
 * Borra las suscripciones cuyo último uso (o creación, si nunca se usó)
 * es anterior a `maxAgeDays` días (default 180 = 6 meses).
 * @param {number} [maxAgeDays=180]
 * @returns {number} - Número de filas borradas
 */
function cleanupStale(maxAgeDays = 180) {
    try {
        const removed = deleteStalePushSubscriptions(maxAgeDays);
        if (removed > 0) {
            console.log(`[Push] Limpieza: ${removed} suscripción(es) antigua(s) eliminada(s)`);
        }
        return removed;
    } catch (e) {
        console.error('[Push] Error en la limpieza de suscripciones:', e.message);
        return 0;
    }
}

/**
 * Arranca el job de limpieza diaria (idempotente). Primer ejecuto con un
 * offset aleatorio de 0-30 min tras el arranque (desfase entre instancias),
 * luego cada 24 h. Timers con `.unref()`: no bloquean el cierre del proceso.
 */
function startCleanupJob() {
    if (cleanupTimer) return;

    const offsetMs = Math.floor(Math.random() * CLEANUP_OFFSET_MAX_MS);
    const firstRun = setTimeout(() => {
        cleanupStale();
    }, offsetMs);
    if (firstRun.unref) firstRun.unref();

    cleanupTimer = setInterval(() => {
        cleanupStale();
    }, CLEANUP_INTERVAL_MS);
    if (cleanupTimer.unref) cleanupTimer.unref();

    console.log(`[Push] Job de limpieza diaria iniciado (primer ejecuto en ~${Math.round(offsetMs / 60000)} min)`);
}

/**
 * Detiene el job de limpieza (graceful shutdown).
 */
function stopCleanupJob() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

module.exports = {
    isConfigured,
    getPublicKey,
    subscribe,
    unsubscribe,
    notify,
    cleanupStale,
    startCleanupJob,
    stopCleanupJob
};
