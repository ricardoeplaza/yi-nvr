#!/usr/bin/env node
/**
 * scripts/mqtt-degraded.js
 *
 * Prueba de degradación elegante del cliente MQTT del NVR: arranca
 * mqtt/client.js contra un puerto MUERTO (127.0.0.1:1884), espera ~5 s y
 * verifica que el proceso NO ha crasheado y que el cliente reporta
 * desconectado (reintentando en background). Después stop() y exit 0.
 *
 * NO toca el servidor del NVR: se usa el módulo en un proceso aparte.
 *
 * Uso:
 *   node scripts/mqtt-degraded.js
 *
 * Salida: 0 si la degradación es correcta, 1 si no.
 */

const mqttClient = require('../src/mqtt/client');

const DEAD_URL = 'mqtt://127.0.0.1:1884';
const WAIT_MS = 5000;

console.log(`[degraded] Arrancando cliente MQTT contra ${DEAD_URL} (puerto muerto)`);
mqttClient.start(DEAD_URL);

setTimeout(() => {
    const connected = mqttClient.isConnected();
    const status = mqttClient.getStatus();
    console.log(`[degraded] Tras ${WAIT_MS} ms: proceso vivo, isConnected=${connected}, status=${JSON.stringify(status)}`);

    mqttClient.stop();
    if (connected) {
        console.error('[degraded] FALLO: el cliente debería estar desconectado');
        process.exit(1);
    }
    console.log('[degraded] OK: sin crash, cliente desconectado reintentando en background');
    process.exit(0);
}, WAIT_MS);
