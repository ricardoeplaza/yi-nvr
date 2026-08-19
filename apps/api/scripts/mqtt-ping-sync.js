#!/usr/bin/env node
/**
 * scripts/mqtt-ping-sync.js
 *
 * Publica un PAYLOAD VACÍO a `<prefix>/cmnd/camera` (ping de sync del
 * contrato yi-hack): la cámara solo re-publica su estado actual en
 * `<prefix>/stat/camera/*`; no cambia nada. Inofensivo para la cámara real.
 *
 * Uso:
 *   node scripts/mqtt-ping-sync.js [prefix] [brokerUrl]
 *     prefix    - default: yi-oficina
 *     brokerUrl - default: env MQTT_BROKER_URL o mqtt://192.168.14.230:1883
 */

const mqtt = require('mqtt');

const prefix = process.argv[2] || 'yi-oficina';
const brokerUrl = process.argv[3] || process.env.MQTT_BROKER_URL || 'mqtt://192.168.14.230:1883';

const client = mqtt.connect(brokerUrl, { reconnectPeriod: 0, connectTimeout: 5000 });
const timer = setTimeout(() => {
    console.error('[ping-sync] Timeout conectando al broker');
    process.exit(1);
}, 8000);

client.on('connect', () => {
    client.publish(`${prefix}/cmnd/camera`, '', { qos: 1 }, err => {
        clearTimeout(timer);
        if (err) {
            console.error(`[ping-sync] Error al publicar: ${err.message}`);
            process.exit(1);
        }
        console.log(`[ping-sync] Publicado payload vacío en ${prefix}/cmnd/camera (ping de sync)`);
        client.end(true, () => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
    });
});

client.on('error', err => {
    console.error(`[ping-sync] No se pudo conectar a ${brokerUrl}: ${err.message}`);
    clearTimeout(timer);
    process.exit(1);
});
