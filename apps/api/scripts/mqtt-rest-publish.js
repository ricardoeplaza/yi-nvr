#!/usr/bin/env node
/**
 * scripts/mqtt-rest-publish.js
 *
 * Valida la rama REST → publish del API contra una cámara FICTICIA (no
 * acciona cámaras reales): se suscribe a `TESTCAM000000/#`, llama
 * `POST /api/cameras/testcam/led {"enabled": true}` contra el API local y
 * verifica que el comando publicado por el API llega al broker.
 *
 * Requiere:
 *  - El API corriendo en http://localhost:3000
 *  - Una entrada temporal en cameras.json: id "testcam", mqtt_prefix
 *    "TESTCAM000000" (añadida/eliminada por quien ejecuta la prueba)
 *
 * Uso:
 *   node scripts/mqtt-rest-publish.js [apiUrl]
 *     apiUrl - default: http://localhost:3000
 *
 * Salida: 0 si el comando llegó, 1 en caso contrario.
 */

const http = require('http');
const mqtt = require('mqtt');

const apiUrl = process.argv[2] || 'http://localhost:3000';
const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://192.168.14.230:1883';
const PREFIX = 'TESTCAM000000';
const CMD_TOPIC = `${PREFIX}/cmnd/camera/led`;

let finished = false;
const timer = setTimeout(() => {
    console.error('[rest-publish] Timeout: no se recibió el comando publicado por el API');
    finish(1);
}, 15000);

function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    client.end(true, () => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
}

// 1. Suscriptor del prefix ficticio (el broker enruta también al API)
const client = mqtt.connect(brokerUrl, { reconnectPeriod: 0, connectTimeout: 5000 });
client.on('connect', () => {
    client.subscribe(`${PREFIX}/#`, { qos: 1 }, err => {
        if (err) {
            console.error(`[rest-publish] Error al suscribir: ${err.message}`);
            finish(1);
            return;
        }
        // 2. Llamada REST al API (tras dar tiempo a que la suscripción esté activa)
        setTimeout(postCommand, 500);
    });
});

client.on('message', (topic, payload) => {
    if (topic === CMD_TOPIC) {
        console.log(`[rest-publish] OK: recibido ${topic} = ${JSON.stringify(payload.toString())}`);
        if (payload.toString() === 'on') {
            finish(0);
        } else {
            console.error('[rest-publish] FALLO: payload inesperado');
            finish(1);
        }
    }
});

client.on('error', err => {
    console.error(`[rest-publish] No se pudo conectar a ${brokerUrl}: ${err.message}`);
    finish(1);
});

/**
 * POST /api/cameras/testcam/led {"enabled": true} contra el API local.
 */
function postCommand() {
    const req = http.request({
        host: 'localhost',
        port: 3000,
        path: '/api/cameras/testcam/led',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 16 }
    }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
            console.log(`[rest-publish] API ${res.statusCode}: ${body}`);
            if (res.statusCode !== 200) {
                console.error('[rest-publish] FALLO: el API no publicó el comando');
                finish(1);
            }
        });
    });
    req.on('error', err => {
        console.error(`[rest-publish] Error en la llamada REST (${apiUrl}): ${err.message}`);
        finish(1);
    });
    req.write('{"enabled":true}');
    req.end();
}
