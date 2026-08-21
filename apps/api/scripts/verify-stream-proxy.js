/**
 * scripts/verify-stream-proxy.js
 *
 * Verificación de vida corta del proxy /stream-proxy (fase 3). El script:
 *  1. Levanta EN PROCESO un stub HTTP "go2rtc" en 127.0.0.1:1984 que
 *     responde GET /api/streams con un JSON tipo go2rtc.
 *  2. Comprueba que el .env de la raíz tenga GO2RTC_URL=http://127.0.0.1:1984;
 *     si no, avisa de que hay que reiniciar el watch server y sale con código 2.
 *  3. GET http://localhost:3000/stream-proxy/api/streams → debe devolver la
 *     respuesta del stub (prueba de que el proxy reenvía a GO2RTC_URL).
 *  4. Cierra el stub y sale.
 *
 * Códigos de salida: 0 = OK, 1 = fallo de verificación,
 * 2 = hay que reiniciar el watch server (env no en vigor) y re-ejecutar.
 *
 * Uso (desde apps/api): node scripts/verify-stream-proxy.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const STUB_HOST = '127.0.0.1';
const STUB_PORT = 1984;
const API_BASE = 'http://127.0.0.1:3000';

/**
 * Lee GO2RTC_URL del .env de la raíz (o null si no existe / no está).
 * @returns {string|null}
 */
function readEnvGo2rtcUrl() {
    try {
        const raw = fs.readFileSync(ENV_PATH, 'utf8');
        const line = raw.split(/\r?\n/).find(l => l.startsWith('GO2RTC_URL='));
        if (!line) return null;
        return line.slice('GO2RTC_URL='.length).trim();
    } catch (e) {
        return null;
    }
}

/**
 * GET plano con timeout; resuelve con {status, body}.
 * @param {string} url
 * @returns {Promise<{status: number, body: string}>}
 */
function getHttp(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timeout de 5 s')));
    });
}

// Stub "go2rtc": solo GET /api/streams (el resto, 404)
const stub = http.createServer((req, res) => {
    if (req.url === '/api/streams') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            oficina: {
                id: 'oficina',
                kind: 'webrtc',
                url: 'rtsp://192.168.1.50:554/ch0_1.h264',
                modes: ['webrtc', 'mse', 'hls', 'mp4', 'rec']
            }
        }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});

function finish(code) {
    stub.close();
    process.exit(code);
}

(async () => {
    await new Promise(resolve => stub.listen(STUB_PORT, STUB_HOST, resolve));
    console.log(`[verify] Stub go2rtc escuchando en http://${STUB_HOST}:${STUB_PORT}`);

    // ¿El .env apunta al stub? (si no, el watch server no puede tenerlo en vigor)
    const envUrl = readEnvGo2rtcUrl();
    if (envUrl !== `http://${STUB_HOST}:${STUB_PORT}`) {
        console.error(`[verify] El .env tiene GO2RTC_URL=${envUrl === null ? '<ausente>' : envUrl}; se esperaba http://${STUB_HOST}:${STUB_PORT}.`);
        console.error('[verify] Reinicia el watch server (node --watch) para que recargue el .env y vuelve a ejecutar este script.');
        finish(2);
    }

    const proxyUrl = `${API_BASE}/stream-proxy/api/streams`;
    let result;
    try {
        result = await getHttp(proxyUrl);
    } catch (err) {
        console.error(`[verify] Error pidiendo ${proxyUrl}:`, err.message);
        finish(1);
    }

    console.log(`[verify] GET ${proxyUrl} → HTTP ${result.status}`);
    console.log(`[verify] Body: ${result.body}`);

    if (result.status === 502) {
        console.error('[verify] 502 con el stub EN MARCHA: el watch server no tiene GO2RTC_URL=http://127.0.0.1:1984 en vigor (¿arrancó antes de cambiar el .env?).');
        console.error('[verify] Reinicia el watch server (node --watch) y vuelve a ejecutar este script.');
        finish(2);
    }

    let ok = false;
    if (result.status === 200) {
        try {
            const parsed = JSON.parse(result.body);
            ok = parsed.oficina && parsed.oficina.id === 'oficina' && parsed.oficina.kind === 'webrtc';
        } catch (e) {
            ok = false;
        }
    }

    if (ok) {
        console.log('[verify] OK: /stream-proxy reenvía a go2rtc (stub) correctamente.');
        finish(0);
    }
    console.error('[verify] FALLO: la respuesta del proxy no coincide con el stub.');
    finish(1);
})();
