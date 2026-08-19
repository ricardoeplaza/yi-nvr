#!/usr/bin/env node
/**
 * scripts/mqtt-smoke.js
 *
 * Smoke test de lectura contra el broker REAL: se suscribe a `yi-oficina/#`
 * (o al prefix indicado como primer argumento), espera ~10 s, imprime todo
 * lo recibido y sale. La cámara publica `status` (retained) → debe llegar
 * "online" (o el último estado) nada más conectar.
 *
 * Uso:
 *   node scripts/mqtt-smoke.js [prefix] [brokerUrl]
 *     prefix    - default: yi-oficina
 *     brokerUrl - default: env MQTT_BROKER_URL o mqtt://192.168.14.230:1883
 *
 * Salida: 0 si se conectó (aunque no llegaran mensajes), 1 si no.
 */

const mqtt = require('mqtt');

const prefix = process.argv[2] || 'yi-oficina';
const brokerUrl = process.argv[3] || process.env.MQTT_BROKER_URL || 'mqtt://192.168.14.230:1883';
const WAIT_MS = 10000;

let connected = false;
const client = mqtt.connect(brokerUrl, { reconnectPeriod: 0, connectTimeout: 5000 });

const timer = setTimeout(() => {
    console.log(`[smoke] Fin de la espera (${WAIT_MS} ms). Mensajes recibidos: ${received}`);
    finish(0);
}, WAIT_MS);

let received = 0;

function finish(code) {
    clearTimeout(timer);
    client.end(true, () => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
}

client.on('connect', () => {
    connected = true;
    console.log(`[smoke] Conectado a ${brokerUrl}, suscribiendo ${prefix}/#`);
    client.subscribe(`${prefix}/#`, { qos: 1 }, err => {
        if (err) {
            console.error(`[smoke] Error al suscribir: ${err.message}`);
            finish(1);
        }
    });
});

client.on('message', (topic, payload) => {
    received += 1;
    console.log(`[smoke] ${topic} = ${JSON.stringify(payload.toString())}`);
});

client.on('error', err => {
    console.error(`[smoke] Error de conexión a ${brokerUrl}: ${err.message}`);
    if (!connected) finish(1);
});
