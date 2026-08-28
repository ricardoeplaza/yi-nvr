/**
 * mqtt/topics.js
 *
 * Resolución de temas y mensajes MQTT de las cámaras yi-hack según el
 * CONTRATO REAL del firmware (verificado en vivo sobre
 * yi-hack-allwinner-v2 0.3.6, estilo Tasmota):
 *
 *  ENTRADA (la cámara publica, el NVR se suscribe):
 *   <prefix>/<birth_will>      → "online" (retained al conectar) / "offline" (last-will)
 *   <prefix>/<motion>          → motion_start, motion_stop, human, vehicle, animal, crying
 *   <prefix>/<motion_image>    → JPEG binario (NO suscrito por el NVR; solo documentado)
 *   <prefix>/<motion_files>    → lista de archivos al terminar un motion
 *   <prefix>/<sound_detection> → "sound"
 *
 *  FEEDBACK (la cámara re-publica el estado aplicado):
 *   <prefix>/stat/camera/<cmd>
 *
 * `prefix` es `camera.mqtt_prefix` (por defecto de fábrica: MAC sin dos
 * puntos; los usuarios pueden personalizarlo, p. ej. "yi-oficina").
 *
 * Los suffixes de tema y los strings de payload VARÍAN entre firmwares y
 * entre usuarios, por lo que cada cámara puede sobrescribirlos en
 * cameras.json con las claves opcionales:
 *   "mqtt_topics":   { "birth_will": "status", "motion": "motion_detection",
 *                      "motion_image": "motion_detection_image",
 *                      "motion_files": "motion_files",
 *                      "sound_detection": "sound_detection" }
 *   "mqtt_messages": { "online": "online", "offline": "offline",
 *                      "motion_start": "motion_start", "motion_stop": "motion_stop",
 *                      "ai_human": "human", "ai_vehicle": "vehicle",
 *                      "ai_animal": "animal", "baby_crying": "crying",
 *                      "sound": "sound" }
 * Siempre con fallback a los defaults de fábrica de yi-hack.
 */

// Defaults de fábrica de yi-hack (cuando la cámara no ha personalizado nada)
const DEFAULT_TOPICS = {
    birth_will: 'birth_will',
    motion: 'motion',
    motion_image: 'motion_image',
    motion_files: 'motion_files',
    sound_detection: 'sound_detection'
};

const DEFAULT_MESSAGES = {
    online: 'online',
    offline: 'offline',
    motion_start: 'motion_start',
    motion_stop: 'motion_stop',
    ai_human: 'ai_human_detection',
    ai_vehicle: 'ai_vehicle_detection',
    ai_animal: 'ai_animal_detection',
    baby_crying: 'baby_crying',
    sound: 'sound_detection'
};

/**
 * Resuelve un mapa de valores por cámara aplicando los overrides de
 * `camera[configKey]` (opcional) sobre los defaults de fábrica.
 * @param {Object} camera - Objeto de cámara del registro
 * @param {Object} defaults - Defaults de fábrica
 * @param {string} configKey - Clave de override en cameras.json (mqtt_topics | mqtt_messages)
 * @returns {Object} - Mapa completo (defaults + overrides)
 */
function resolveWithOverrides(camera, defaults, configKey) {
    const result = { ...defaults };
    const overrides = camera[configKey];
    if (overrides && typeof overrides === 'object') {
        for (const [key, value] of Object.entries(overrides)) {
            if (typeof value === 'string' && value !== '') {
                result[key] = value;
            }
        }
    }
    return result;
}

/**
 * Devuelve los temas MQTT completos de una cámara.
 * @param {Object} camera - Objeto de cámara del registro
 * @returns {{birth_will: string, motion: string, motion_image: string,
 *            motion_files: string, sound_detection: string,
 *            stat: string}}
 * @throws {Error} - Si la cámara no tiene mqtt_prefix
 */
function getTopics(camera) {
    if (!camera.mqtt_prefix) {
        throw new Error(`La cámara "${camera.id}" no tiene mqtt_prefix configurado`);
    }
    const p = camera.mqtt_prefix;
    const t = resolveWithOverrides(camera, DEFAULT_TOPICS, 'mqtt_topics');
    return {
        birth_will: `${p}/${t.birth_will}`,
        motion: `${p}/${t.motion}`,
        // Documentado pero NO suscrito por el NVR (JPEGs pesados)
        motion_image: `${p}/${t.motion_image}`,
        motion_files: `${p}/${t.motion_files}`,
        sound_detection: `${p}/${t.sound_detection}`,
        // Feedback de estado: la cámara re-publica cada comando aplicado
        stat: `${p}/stat/camera/+`
    };
}

/**
 * Devuelve el mapa de mensajes (strings de payload) de una cámara, con
 * fallback a los defaults de fábrica.
 * @param {Object} camera - Objeto de cámara del registro
 * @returns {Object<string, string>}
 */
function getMessages(camera) {
    return resolveWithOverrides(camera, DEFAULT_MESSAGES, 'mqtt_messages');
}

/**
 * Normaliza un mensaje recibido (topic + payload) a un eventType.
 * @param {Object} camera - Objeto de cámara del registro
 * @param {string} topic - Tema MQTT recibido
 * @param {string} payload - Payload recibido (texto)
 * @returns {{eventType: string, command?: string}} - eventType en
 *   { online, offline, motion_start, motion_stop, ai_human, ai_vehicle,
 *     ai_animal, baby_crying, sound, motion_files, stat:<cmd>, unknown }
 */
function matchEvent(camera, topic, payload) {
    const text = (payload == null ? '' : String(payload)).trim();

    if (camera && camera.mqtt_prefix) {
        const topics = getTopics(camera);
        const messages = getMessages(camera);

        if (topic === topics.birth_will) {
            if (text === messages.online) return { eventType: 'online' };
            if (text === messages.offline) return { eventType: 'offline' };
            return { eventType: 'unknown' };
        }

        if (topic === topics.motion) {
            if (text === messages.motion_start) return { eventType: 'motion_start' };
            if (text === messages.motion_stop) return { eventType: 'motion_stop' };
            if (text === messages.ai_human) return { eventType: 'ai_human' };
            if (text === messages.ai_vehicle) return { eventType: 'ai_vehicle' };
            if (text === messages.ai_animal) return { eventType: 'ai_animal' };
            if (text === messages.baby_crying) return { eventType: 'baby_crying' };
            return { eventType: 'unknown' };
        }

        if (topic === topics.sound_detection) {
            if (text === messages.sound) return { eventType: 'sound' };
            return { eventType: 'unknown' };
        }

        if (topic === topics.motion_files) {
            return { eventType: 'motion_files' };
        }

        // Feedback de estado: <prefix>/stat/camera/<cmd>
        const statBase = `${camera.mqtt_prefix}/stat/camera/`;
        if (topic.startsWith(statBase)) {
            return { eventType: `stat:${topic.slice(statBase.length)}`, command: topic.slice(statBase.length) };
        }
    }

    return { eventType: 'unknown' };
}

module.exports = {
    DEFAULT_TOPICS,
    DEFAULT_MESSAGES,
    getTopics,
    getMessages,
    matchEvent
};
