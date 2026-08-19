/**
 * mqtt/client.js
 *
 * Cliente MQTT del NVR (npm `mqtt`). Se conecta al broker indicado por
 * `MQTT_BROKER_URL` y gestiona:
 *  - Suscripciones (QoS 1) a los temas de ENTRADA de cada cámara del
 *    registro: birth_will, motion, motion_files, sound_detection y
 *    stat/camera/+ (feedback de comandos). NO se suscribe a motion_image
 *    (JPEGs pesados; el tema existe y está documentado en topics.js).
 *  - Normalización de eventos (topics.matchEvent) y persistencia en la
 *    tabla `mqtt_events` (database.js).
 *  - Emisión de `camera-motion` en el EventEmitter exportado
 *    (`mqttEvents`) para motion_start/ai_human/ai_vehicle/ai_animal.
 *    Una fase futura se suscribirá para notificaciones push; este módulo
 *    NO acopla nada de push.
 *  - `publish()` (QoS 1) para los comandos de salida (mqtt/commands.js).
 *
 * Degradación elegante (OBLIGATORIA para dev sin broker):
 *  - Si `MQTT_BROKER_URL` está vacío, el cliente no se inicia (warning).
 *  - Si el broker no está disponible, se loguea un warning y el servidor
 *    sigue vivo (HTTP/FTP funcionando); el cliente reintenta en background
 *    con backoff exponencial (1s → 2s → 4s ... máx 60s).
 *  - Mientras no hay conexión, `publish()` devuelve false (las rutas
 *    responden 503) y los eventos de las cámaras simplemente no llegan.
 */

const { EventEmitter } = require('events');
const mqtt = require('mqtt');
const registry = require('../camera-registry');
const { db } = require('../database');
const { getTopics, matchEvent } = require('./topics');

// Eventos internos del módulo MQTT (bus para fases futuras, p. ej. push)
const mqttEvents = new EventEmitter();

// Parámetros de reconexión con backoff exponencial
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
const CONNECT_TIMEOUT_MS = 5000;

// EventTypes que disparan el evento `camera-motion` (los que interesan a push)
const MOTION_EVENT_TYPES = new Set(['motion_start', 'ai_human', 'ai_vehicle', 'ai_animal']);

// Estado del cliente
let client = null;
let brokerUrl = '';
let connected = false;
let stopping = false;
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer = null;
let clientSeq = 0;

/**
 * Inserta un evento MQTT en la tabla mqtt_events (la tabla se crea en
 * database.js). El fallo de persistencia no tumba el pipeline de eventos.
 * @param {string|null} cameraId
 * @param {string} eventType
 * @param {string} payload
 */
function recordEvent(cameraId, eventType, payload) {
    try {
        db.prepare(`
            INSERT INTO mqtt_events (camera_id, event_type, payload, received_at)
            VALUES (?, ?, ?, ?)
        `).run(cameraId, eventType, payload, new Date().toISOString());
    } catch (e) {
        console.error('[MQTT] Error al guardar evento en mqtt_events:', e.message);
    }
}

/**
 * Extrae el prefix (primer segmento) de un tema MQTT.
 * @param {string} topic
 * @returns {string}
 */
function prefixOf(topic) {
    return topic.split('/')[0];
}

/**
 * Calcula los temas de entrada a suscribir para todas las cámaras.
 * @returns {{topics: string[], byPrefix: Map<string, string>}} - Lista de
 *   temas (con wildcards de stat) y mapa prefix → cameraId
 */
function collectInputTopics() {
    const topics = [];
    const byPrefix = new Map();
    for (const cam of registry.getAllCameras()) {
        if (!cam.mqtt_prefix) continue;
        let t;
        try {
            t = getTopics(cam);
        } catch (e) {
            continue;
        }
        byPrefix.set(cam.mqtt_prefix, cam.id);
        topics.push(t.birth_will, t.motion, t.motion_files, t.sound_detection, t.stat);
    }
    return { topics, byPrefix };
}

/**
 * Reconstruye las suscripciones (QoS 1). Se llama al conectar y tras cada
 * reload del registro.
 */
function syncSubscriptions() {
    const { topics } = collectInputTopics();
    if (client && connected && topics.length > 0) {
        client.subscribe(topics, { qos: 1 }, err => {
            if (err) {
                console.error('[MQTT] Error al suscribir temas de entrada:', err.message);
            } else {
                console.log(`[MQTT] Suscripciones activas: ${topics.length} tema(s)`);
            }
        });
    }
    return topics.length;
}

/**
 * Maneja un mensaje MQTT recibido: resuelve la cámara por prefix,
 * normaliza el evento, lo persiste y (si es de movimiento) lo emite.
 * @param {string} topic
 * @param {Buffer} payload
 */
function onMessage(topic, payload) {
    const text = payload.toString();
    const camera = registry.getCameraByMqttPrefix(prefixOf(topic));

    const { eventType } = matchEvent(camera, topic, text);
    const receivedAt = new Date().toISOString();

    console.log(`[MQTT] ${receivedAt} ${camera ? camera.id : '<desconocida>'} ${eventType} ${topic}=${JSON.stringify(text)}`);
    recordEvent(camera ? camera.id : null, eventType, text);

    if (camera && MOTION_EVENT_TYPES.has(eventType)) {
        mqttEvents.emit('camera-motion', {
            cameraId: camera.id,
            eventType,
            payload: text,
            topic
        });
    }
}

/**
 * Crea y arranca un cliente MQTT (un cliente por intento de conexión).
 * @returns {import('mqtt').MqttClient}
 */
function createClient() {
    clientSeq += 1;
    const c = mqtt.connect(brokerUrl, {
        clientId: `yi-nvr-${process.pid}-${clientSeq}`,
        clean: true,
        reconnectPeriod: 0, // la reconexión la gestiona este módulo (backoff)
        connectTimeout: CONNECT_TIMEOUT_MS,
        username: process.env.MQTT_USERNAME || undefined,
        password: process.env.MQTT_PASSWORD || undefined
    });

    c.on('connect', () => {
        connected = true;
        backoffMs = INITIAL_BACKOFF_MS;
        console.log(`[MQTT] Conectado al broker ${brokerUrl}`);
        syncSubscriptions();
    });

    c.on('reconnect', () => {
        console.warn('[MQTT] Reconectando con el broker...');
    });

    c.on('message', onMessage);

    c.on('close', () => {
        if (connected) {
            connected = false;
            console.warn('[MQTT] Conexión con el broker perdida');
        }
        scheduleReconnect();
    });

    c.on('error', err => {
        console.warn(`[MQTT] Error de conexión: ${err.message}`);
    });

    return c;
}

/**
 * Programa un reintento de conexión con backoff exponencial (duplica hasta
 * el máximo de 60 s). Solo hay un reintento programado a la vez.
 */
function scheduleReconnect() {
    if (stopping) return;
    if (reconnectTimer) return; // ya hay uno en marcha

    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (stopping) return;
        console.log(`[MQTT] Reintentando conexión a ${brokerUrl} (backoff ${delay} ms)`);
        client = createClient();
    }, delay);
    // No bloquear el event loop en el shutdown del proceso
    if (reconnectTimer.unref) reconnectTimer.unref();
}

/**
 * Inicia el cliente MQTT. NO lanza ni bloquea: si el broker no está, se
 * queda reintentando en background (degradación elegante).
 * @param {string} url - URL del broker (p. ej. mqtt://192.168.14.230:1883)
 */
function start(url) {
    brokerUrl = url || '';
    if (!brokerUrl) {
        console.warn('[MQTT] MQTT_BROKER_URL vacío: el cliente MQTT no se inicia (modo sin broker)');
        return;
    }

    stopping = false;
    console.log(`[MQTT] Iniciando cliente (broker: ${brokerUrl})`);
    try {
        client = createClient();
    } catch (e) {
        console.warn(`[MQTT] No se pudo crear el cliente inicial: ${e.message}. Reintentando en background...`);
        scheduleReconnect();
    }
}

/**
 * Cierra el cliente MQTT de forma ordenada (graceful shutdown).
 */
function stop() {
    stopping = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (client) {
        try {
            client.end(true);
        } catch (e) {
            // ignorar: el proceso está cerrando
        }
        client = null;
    }
    connected = false;
}

/**
 * Publica un payload en un tema (QoS 1).
 * @param {string} topic
 * @param {string} payload
 * @returns {boolean} - true si se aceptó la publicación, false si no hay conexión
 */
function publish(topic, payload) {
    if (!client || !connected) return false;
    return client.publish(topic, payload, { qos: 1 });
}

/**
 * Estado de conexión (para /api/health y depuración).
 * @returns {{connected: boolean, brokerUrl: string}}
 */
function getStatus() {
    return { connected, brokerUrl };
}

module.exports = {
    mqttEvents,
    start,
    stop,
    publish,
    isConnected: () => connected,
    getStatus,
    syncSubscriptions
};
