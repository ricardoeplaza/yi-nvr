/**
 * scripts/set-camera-rtsp.js
 *
 * Consulta y cambia el "RTSP server program" (RTSP_ALT) de una cámara
 * yi-hack-allwinner-v2 usando sus CGIs HTTP:
 *
 *   GET  /cgi-bin/get_configs.sh?conf=system   (solo lectura)
 *   POST /cgi-bin/set_configs.sh?conf=system   (body JSON: {"RTSP_ALT":"...","RTSP_AUDIO":"..."})
 *   GET  /cgi-bin/service.sh?name=rtsp&action=stop|start
 *
 * Los 3 valores posibles de RTSP_ALT (firmware, select "RTSP server program"):
 *   - standard    : rRTSPServer (live555, C++). Default del firmware.
 *                   Audio: aac/pcm/alaw/ulaw. El más probado.
 *   - alternative : h264grabber (fifo) + rtsp_server_yi. Binarios C ligeros,
 *                   el de menor consumo CPU/RAM. Audio: solo aac.
 *   - go2rtc      : go2rtc v1.9.x (binario Go embebido) con h264grabber como
 *                   fuente exec. RTSP más robusto, pero el más pesado en RAM
 *                   (runt. Go) en chips Allwinner. Audio: solo aac.
 *                   (Su API/WebRTC van deshabilitados: solo sirve RTSP :554.)
 *
 * En los 3 casos la URL que consume nuestro go2rtc central es la misma:
 * rtsp://<cam>:554/ch0_0.h264 (high) y /ch0_1.h264 (low).
 *
 * Uso (desde apps/api):
 *   node scripts/set-camera-rtsp.js --camera oficina --get
 *   node scripts/set-camera-rtsp.js --camera oficina --alt alternative --audio aac
 *   node scripts/set-camera-rtsp.js --camera oficina --alt alternative --audio aac --apply
 *
 * Sin --apply solo imprime el plan (dry-run), no toca la cámara.
 * Con --apply: escribe la config, reinicia el servicio RTSP de la cámara y
 * actualiza el campo `rtsp` de cameras.json para mantener el registro
 * sincronizado. El proceso termina solo (no queda nada en background).
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CAMERAS_JSON_PATH = path.join(REPO_ROOT, 'infra', 'cameras.json');

const VALID_ALT = ['standard', 'alternative', 'go2rtc'];
const VALID_AUDIO = ['no', 'none', 'pcm', 'alaw', 'ulaw', 'aac'];
const HTTP_TIMEOUT_MS = 10000;

function parseArgs(argv) {
    const args = { camera: null, get: false, alt: null, audio: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--camera') args.camera = argv[++i];
        else if (a === '--get') args.get = true;
        else if (a === '--alt') args.alt = argv[++i];
        else if (a === '--audio') args.audio = argv[++i];
        else if (a === '--apply') args.apply = true;
        else {
            console.error(`Argumento desconocido: ${a}`);
            process.exit(2);
        }
    }
    return args;
}

function findCamera(id) {
    const cameras = JSON.parse(fs.readFileSync(CAMERAS_JSON_PATH, 'utf8'));
    const cam = cameras.find(c => c.id === id);
    if (!cam) {
        console.error(`Cámara "${id}" no encontrada en cameras.json`);
        process.exit(2);
    }
    if (!cam.host) {
        console.error(`La cámara "${id}" no tiene host definido`);
        process.exit(2);
    }
    return cam;
}

async function httpGet(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const text = await res.text();
    return { status: res.status, text };
}

async function httpPostJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    const text = await res.text();
    return { status: res.status, text };
}

function baseHost(cam) {
    return `http://${cam.host}`;
}

async function getSystemConfig(cam) {
    const { status, text } = await httpGet(`${baseHost(cam)}/cgi-bin/get_configs.sh?conf=system`);
    if (status !== 200) {
        throw new Error(`get_configs.sh respondió ${status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text);
    const rtspKeys = Object.keys(json).filter(k => k.startsWith('RTSP'));
    const out = {};
    rtspKeys.forEach(k => { out[k] = json[k]; });
    return out;
}

function updateCamerasJson(camId, alt, audio) {
    const raw = fs.readFileSync(CAMERAS_JSON_PATH, 'utf8');
    const cameras = JSON.parse(raw);
    const cam = cameras.find(c => c.id === camId);
    cam.rtsp = { ...(cam.rtsp || {}), alt, audio };
    fs.writeFileSync(CAMERAS_JSON_PATH, JSON.stringify(cameras, null, 4) + '\n', 'utf8');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.camera) {
        console.error('Falta --camera <id>');
        process.exit(2);
    }
    const cam = findCamera(args.camera);

    if (args.get && !args.alt) {
        const cfg = await getSystemConfig(cam);
        console.log(`Config RTSP actual de "${args.camera}" (${cam.host}):`);
        Object.entries(cfg).forEach(([k, v]) => console.log(`  ${k}=${v}`));
        return;
    }

    if (!args.alt) {
        console.error('Indica --get (consulta) o --alt <standard|alternative|go2rtc> (cambio)');
        process.exit(2);
    }
    if (!VALID_ALT.includes(args.alt)) {
        console.error(`--alt inválido: ${args.alt} (valores: ${VALID_ALT.join(', ')})`);
        process.exit(2);
    }
    const audio = args.audio !== null ? args.audio : ((cam.rtsp && cam.rtsp.audio) || 'no');
    if (!VALID_AUDIO.includes(audio)) {
        console.error(`--audio inválido: ${audio} (valores: ${VALID_AUDIO.join(', ')})`);
        process.exit(2);
    }

    const current = await getSystemConfig(cam);
    console.log(`Config RTSP actual de "${args.camera}" (${cam.host}):`);
    Object.entries(current).forEach(([k, v]) => console.log(`  ${k}=${v}`));

    const changes = [];
    if (current.RTSP_ALT !== args.alt) changes.push(`RTSP_ALT: ${current.RTSP_ALT} → ${args.alt}`);
    if (current.RTSP_AUDIO !== audio) changes.push(`RTSP_AUDIO: ${current.RTSP_AUDIO} → ${audio}`);

    if (changes.length === 0) {
        console.log('Sin cambios: la cámara ya tiene la config solicitada.');
        return;
    }
    console.log('Cambios pendientes:');
    changes.forEach(c => console.log(`  - ${c}`));

    if (!args.apply) {
        console.log('Dry-run: sin --apply no se modifica la cámara.');
        return;
    }

    const body = { RTSP_ALT: args.alt };
    if (current.RTSP_AUDIO !== audio) body.RTSP_AUDIO = audio;

    const setRes = await httpPostJson(`${baseHost(cam)}/cgi-bin/set_configs.sh?conf=system`, body);
    const setOk = setRes.status === 200 && setRes.text.includes('"error":"false"');
    if (!setOk) {
        throw new Error(`set_configs.sh falló (${setRes.status}): ${setRes.text.slice(0, 200)}`);
    }
    console.log('Config escrita en la cámara. Reiniciando servicio RTSP...');

    const stopRes = await httpGet(`${baseHost(cam)}/cgi-bin/service.sh?name=rtsp&action=stop`);
    if (stopRes.status !== 200) {
        throw new Error(`service.sh stop falló (${stopRes.status})`);
    }
    const startRes = await httpGet(`${baseHost(cam)}/cgi-bin/service.sh?name=rtsp&action=start`);
    if (startRes.status !== 200) {
        throw new Error(`service.sh start falló (${startRes.status})`);
    }
    console.log('Servicio RTSP reiniciado.');

    updateCamerasJson(args.camera, args.alt, audio);
    console.log(`cameras.json actualizado (rtsp.alt=${args.alt}, rtsp.audio=${audio}).`);
    console.log('Listo.');
}

main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
