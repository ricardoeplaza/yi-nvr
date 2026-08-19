/**
 * mqtt/commands.js
 *
 * Comandos de SALIDA hacia las cámaras yi-hack vía MQTT (contrato real,
 * estilo Tasmota): se publica a `<prefix>/cmnd/camera/<cmd>` (QoS 1) y la
 * cámara responde en `<prefix>/stat/camera/<cmd>`.
 *
 * Whitelist de comandos y valores válidos (constante exportada
 * COMMAND_VALUES): comando → array de valores permitidos.
 *
 * Errores (se lanzan como Error con `code` para que la capa REST mapee el
 * estado HTTP):
 *  - NOT_FOUND     → la cámara no existe en el registro (404)
 *  - NO_PREFIX     → la cámara no tiene mqtt_prefix configurado (400)
 *  - NOT_CONNECTED → el broker no está conectado (503)
 *  - INVALID       → comando o valor no en la whitelist (400)
 */

const registry = require('../camera-registry');
const client = require('./client');
const { commandTopic } = require('./topics');

// Whitelist de comandos y sus valores válidos (fijos en el firmware yi-hack)
const COMMAND_VALUES = {
    // on/off
    led: ['on', 'off'],
    ir: ['on', 'off'],
    rotate: ['on', 'off'],
    motion_detection: ['on', 'off'],
    save_video_on_motion: ['on', 'off'],
    sound_detection: ['on', 'off'],
    baby_crying_detect: ['on', 'off'],
    ai_human_detection: ['on', 'off'],
    ai_vehicle_detection: ['on', 'off'],
    ai_animal_detection: ['on', 'off'],
    face_detection: ['on', 'off'],
    motion_tracking: ['on', 'off'],
    local_record: ['on', 'off'], // solo soportado por el firmware sonoff
    // yes/no
    switch_on: ['yes', 'no'],
    // niveles
    sensitivity: ['low', 'medium', 'high'],
    sound_sensitivity: ['30', '35', '40', '45', '50', '60', '70', '80', '90'],
    // crucero
    cruise: ['no', 'presets', '360']
};

/**
 * Lanza un Error con `code` (para el mapeo HTTP de la capa REST).
 * @param {string} code
 * @param {string} message
 * @throws {Error}
 */
function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    throw err;
}

/**
 * Resuelve la cámara por id y lanza NOT_FOUND si no existe.
 * @param {string} cameraId
 * @returns {Object} - Objeto de cámara del registro
 */
function resolveCamera(cameraId) {
    const camera = registry.getCameraById(cameraId);
    if (!camera) {
        fail('NOT_FOUND', `Cámara no encontrada: "${cameraId}"`);
    }
    return camera;
}

/**
 * Publica un comando a una cámara: valida cámara, whitelist y valor, y
 * publica vía el cliente MQTT.
 * @param {string} cameraId
 * @param {string} command - Suffix del comando (p. ej. "led")
 * @param {string} value - Valor (p. ej. "on")
 * @returns {{topic: string, payload: string}}
 */
function sendCommand(cameraId, command, value) {
    const camera = resolveCamera(cameraId);

    const allowed = COMMAND_VALUES[command];
    if (!allowed) {
        fail('INVALID', `Comando no soportado: "${command}" (válidos: ${Object.keys(COMMAND_VALUES).join(', ')})`);
    }
    if (!allowed.includes(value)) {
        fail('INVALID', `Valor inválido para "${command}": "${value}" (válidos: ${allowed.join(', ')})`);
    }

    let topic;
    try {
        topic = commandTopic(camera, command);
    } catch (e) {
        const err = new Error(e.message);
        err.code = 'NO_PREFIX';
        throw err;
    }

    if (!client.publish(topic, value)) {
        fail('NOT_CONNECTED', 'Broker MQTT no disponible');
    }
    return { topic, payload: value };
}

/**
 * Enciende/apaga la cámara (comando switch_on, payload yes/no).
 * @param {string} cameraId
 * @param {boolean} enabled
 * @returns {{topic: string, payload: string}}
 */
function setPower(cameraId, enabled) {
    return sendCommand(cameraId, 'switch_on', enabled ? 'yes' : 'no');
}

/**
 * Enciende/apaga el LED de la cámara (comando led, payload on/off).
 * @param {string} cameraId
 * @param {boolean} enabled
 * @returns {{topic: string, payload: string}}
 */
function setLed(cameraId, enabled) {
    return sendCommand(cameraId, 'led', enabled ? 'on' : 'off');
}

/**
 * Enciende/apaga el IR-cut / visión nocturna (comando ir, payload on/off).
 * @param {string} cameraId
 * @param {boolean} enabled
 * @returns {{topic: string, payload: string}}
 */
function setIrcut(cameraId, enabled) {
    return sendCommand(cameraId, 'ir', enabled ? 'on' : 'off');
}

/**
 * Activa/desactiva la grabación por movimiento (comando
 * save_video_on_motion, payload on/off).
 * @param {string} cameraId
 * @param {boolean} enabled
 * @returns {{topic: string, payload: string}}
 */
function setSaveVideoOnMotion(cameraId, enabled) {
    return sendCommand(cameraId, 'save_video_on_motion', enabled ? 'on' : 'off');
}

/**
 * Enciende/apaga un grupo de cámaras (comando switch_on por cámara). Si
 * alguna falla, el error sube tras publicar las que pudieron (las cámaras
 * son independientes).
 * @param {Array<string>} cameraIds
 * @param {boolean} enabled
 * @returns {Array<{cameraId: string, topic: string, payload: string}>}
 */
function setGroupPower(cameraIds, enabled) {
    const results = [];
    for (const id of cameraIds) {
        const { topic, payload } = sendCommand(id, 'switch_on', enabled ? 'yes' : 'no');
        results.push({ cameraId: id, topic, payload });
    }
    return results;
}

module.exports = {
    COMMAND_VALUES,
    sendCommand,
    setPower,
    setLed,
    setIrcut,
    setSaveVideoOnMotion,
    setGroupPower
};
