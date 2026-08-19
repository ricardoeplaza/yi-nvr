#!/usr/bin/env node
/**
 * scripts/mqtt-loopback.js
 *
 * Valida el transporte de PUBLICACIÓN contra el broker real usando un
 * prefix FICTICIO (no acciona ninguna cámara): se suscribe a
 * `TESTCAM000000/#`, publica `TESTCAM000000/cmnd/camera/led = on` y
 * verifica que el suscriptor lo recibe.
 *
 * Uso:
 *   node scripts/mqtt-loopback.js [brokerUrl]
 *     brokerUrl - default: env MQTT_BROKER_URL o mqtt://192.168.14.230:1883
 *
 * Salida: 0 si la publicación fue recibida, 1 en caso contrario.
 */

const mqtt = require('mqtt');

const brokerUrl = process.argv[2] || process.env.MQTT_BROKER_URL || 'mqtt://192.168.14.230:1883';
const PREFIX = 'TESTCAM000000';
const CMD_TOPIC = `${PREFIX}/cmnd/camera/led`;
const CMD_PAYLOAD = 'on';

// Un solo cliente: suscriptor y publicador (el broker enruta también al
// propio cliente, como haría el API en producción)
const client = mqtt.connect(brokerUrl, { reconnectPeriod: 0, connectTimeout: 5000 });

let finished = false;
const timer = setTimeout(() => {
    console.error('[loopback] Timeout: no se recibió la publicación');
    finish(1);
}, 10000);

function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    client.end(true, () => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
}

client.on('connect', () => {
    client.subscribe(`${PREFIX}/#`, { qos: 1 }, err => {
        if (err) {
            console.error(`[loopback] Error al suscribir: ${err.message}`);
            finish(1);
            return;
        }
        // Pequeño delay para que la suscripción esté activa en el broker
        setTimeout(() => {
            client.publish(CMD_TOPIC, CMD_PAYLOAD, { qos: 1 }, pubErr => {
                if (pubErr && !finished) {
                    console.error(`[loopback] Error al publicar: ${pubErr.message}`);
                    finish(1);
                }
            });
        }, 500);
    });
});

client.on('message', (topic, payload) => {
    if (topic === CMD_TOPIC && payload.toString() === CMD_PAYLOAD) {
        console.log(`[loopback] OK: recibido ${topic} = ${JSON.stringify(payload.toString())}`);
        finish(0);
    }
});

client.on('error', err => {
    console.error(`[loopback] No se pudo conectar a ${brokerUrl}: ${err.message}`);
    finish(1);
});
