# Architecture — yi-nvr (Home NVR)

Resumen del plan de ejecución (`AGENT-PLAN.md`, fuente de verdad). Este documento se
actualiza con la "Decision log" a lo largo de las fases.

## Mission

Ecosistema NVR autoalojado que sustituye a la app MiHome y a Home Assistant para 3–5
cámaras Xiaomi con firmware `yi-hack` (MQTT + RTSP + subida de clips por FTP):

- Recepción de clips por FTP, procesamiento (thumbnail JPG + preview WebP animado),
  indexado en SQLite, servicio vía REST API + PWA Angular.
- MQTT directo con las cámaras (eventos de movimiento; comandos: LED, IR-cut, modo
  de grabación, encendido/apagado).
- Vídeo en directo vía WebRTC (sidecar go2rtc, proxy dentro de Express).
- Notificaciones Web Push (movimiento y clip procesado).
- Un único punto de entrada HTTP (puerto 3000): API + PWA + medios + go2rtc proxy.
  **Sin nginx ni ningún otro web server.**

## Technology stack (decisiones cerradas)

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express 5 |
| Database | SQLite vía `better-sqlite3` |
| FTP | `ftp-srv` |
| File watching | `chokidar` |
| Video processing | `fluent-ffmpeg` + binario `ffmpeg` del sistema |
| MQTT broker | Eclipse Mosquitto 2 (Docker) |
| MQTT client | `mqtt` (npm) |
| RTSP → WebRTC | `go2rtc` (sidecar Docker) |
| Proxying go2rtc | `http-proxy-middleware` dentro de Express |
| Push | `web-push` (npm) + VAPID |
| Frontend | Angular (stable) + PWA, service worker de push separado |
| Packaging | Docker Compose (api + mosquitto + go2rtc); systemd como plan B para SBCs con poca RAM |
| Auth | Bearer token estático (`API_AUTH_TOKEN`) — sistema doméstico de un solo usuario |

## Environments

| Environment | OS / Arch | Rol | Notas |
|---|---|---|---|
| **Dev** | Windows (win32, x64), Node 24 | Desarrollo y verificación nativa | PowerShell 5.1. Usar `curl.exe` (no el alias). ffmpeg en PATH (`winget install Gyan.FFmpeg`). Docker Desktop opcional. |
| **Integration** | Debian, linux/amd64 | Validación Docker autoritativa | Stack `docker compose` completo, instalación limpia desde README, 24 h de estabilidad. Criterios `[INTEG]`. |
| **Production** | Linux ARM SBC (TBC: `linux/arm/v7` 512 MB o `linux/arm64`) | Despliegue final | Detrás de Tailscale/Headscale, nunca expuesto a internet. Criterios `[SBC]`. |

Consecuencias:
- Todo el código es cross-platform (desarrollo en Windows, producción en Linux): solo
  `path.join`/`path.resolve`, nunca concatenación de rutas.
- Módulos nativos (`better-sqlite3`) se compilan **dentro de Docker** para la
  plataforma objetivo (buildx `--platform`), nunca se copia `node_modules` entre
  máquinas.

## Target repository structure

```
yi-nvr/
├── AGENT-PLAN.md
├── docker-compose.yml
├── .env.example
├── .gitignore
├── .gitattributes
├── infra/
│   ├── mosquitto/mosquitto.conf
│   └── go2rtc/go2rtc.yaml
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── scripts/generate-go2rtc-config.js
│   │   └── src/
│   │       ├── server.js          # bootstrap: config, middleware, rutas, listen
│   │       ├── ftp.js
│   │       ├── processor.js
│   │       ├── database.js
│   │       ├── camera-registry.js
│   │       ├── retention.js
│   │       ├── config/cameras.json
│   │       ├── mqtt/{client,topics,commands}.js
│   │       ├── push/webpush.js
│   │       └── routes/{videos,cameras,timeline,push,stream}.js
│   └── frontend/                  # workspace Angular (fase 5)
├── storage/                       # destino del volumen Docker (copia para integración)
├── scripts/integration-check.sh
└── docs/{ARCHITECTURE,API}.md
```

Notas de almacenamiento: `database.js`, `ftp.js` y `processor.js` resuelven el storage
relativo a `__dirname` (`src/storage`). En dev los datos reales viven en
`apps/api/src/storage/` (nunca en git). En Docker, `STORAGE_DIR=/app/storage` apunta al
volumen `./storage` montado en la raíz del repo (una **copia** para pruebas de
integración; los datos reales de dev no se mueven a la raíz).

## Decisions

### D1 (fase 0) — Estrategia de carga de dotenv
`server.js` carga el entorno como **primeras líneas**, antes de cualquier `require` que
lea variables:

```js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
require('dotenv').config();
```

- Primera llamada: ruta absoluta al `.env` de la raíz del repo (funcione desde el cwd
  que sea).
- Segunda llamada (sin `path`): fallback al cwd (p. ej. `apps/api` si se crea un
  `.env` local). `dotenv` no sobrescribe variables ya cargadas, así que el `.env` de la
  raíz gana y las variables reales del sistema (`process.env` previas) ganan sobre
  ambos.
- `database.js`/`ftp.js`/`processor.js` **no** cargan dotenv: dependen de que `server.js`
  (el único entrypoint) haya cargado el entorno antes de requerirlos.

### D2 (fase 0) — Corrección one-time de rutas absolutas en la BD
Al mover `src/` → `apps/api/src/`, las rutas absolutas guardadas en `videos.
original_path`, `thumbnail_path` y `preview_path` (prefijo `<raiz>\src\storage`)
quedaron obsoletas. Se corrigió con un `UPDATE ... SET col = replace(col, viejo, nuevo)`
por columna (script temporal, eliminado tras usarlo), **no** con una migración de
esquema: los valores cambian, no el esquema (la tabla `videos` se mantiene intacta,
según el veredicto KEEP de la sección 3 del plan). Verificado tras el cambio: 87 filas
(idéntico al previo), 0 filas con el prefijo antiguo y los 261 archivos (87 originales
+ 87 thumbnails + 87 previews) existen en disco.

### D3 (fase 0) — `STORAGE_DIR` con default por `__dirname`
Los tres módulos usan:

```js
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR)
                                            : path.join(__dirname, 'storage');
```

- Dev (Windows/Linux): default `apps/api/src/storage`, donde viven los datos reales.
- Docker: `STORAGE_DIR=/app/storage` (volumen montado).
- `server.js` usa la misma constante para los montajes estáticos `/videos` y
  `/processed` y para calcular `original_url` con `path.relative`, por lo que las URLs
  siguen siendo relativas (`/videos/...`, `/processed/...`) y correctas tras el
  movimiento.

### D4 (fase 0) — Env `FTP_PASSIVE_RANGE`
Añadido en `ftp.js` (el plan lo sugería "si tocas el archivo de todos modos"). Formato
`"min-max"` (ej. `"2000-2050"`), default `1024-1050`. Útil en Windows, donde
Hyper-V/WSL2 pueden reservar el rango 1024–1050 (sección 10 del plan). Valor inválido
→ warning + default.

### D5 (fase 0) — ffmpeg pendiente en la máquina de dev
`ffmpeg` **no** está en el PATH de la máquina de desarrollo en el momento de la fase 0
(verificado con `ffmpeg -version`). No se instaló (fuera del alcance de la fase).
Pendiente: `winget install Gyan.FFmpeg`. Sin ffmpeg, el pipeline de thumbnails/previews
fallará para clips nuevos (los 87 clips existentes siguen sirviéndose correctamente).

### D6 (fase 0) — `allowScripts` de npm 12 para `better-sqlite3`
npm 12 bloquea por defecto los install scripts no autorizados; el binding nativo de
`better-sqlite3` no se descargó/construyó en el primer `npm install`. Se aprobó con
`npm install-scripts approve better-sqlite3`, lo que añade el campo `allowScripts` a
`apps/api/package.json` (se commitea a propósito: sin él, `npm ci` en otras máquinas
con npm 12 repetiría el problema). `dtrace-provider` (dependencia opcional de
`ftp-srv`, con fallback JS) se dejó bloqueado.

### D7 (fase 2) — Contrato MQTT real de yi-hack (estilo Tasmota)
Verificado en vivo sobre la cámara `oficina` (firmware
`yi-hack-allwinner-v2 0.3.6`, broker `192.168.14.230:1883`, sin auth, QoS 1).
El contrato NO es el de los ejemplos genéricos de yi-hack:

- **Prefix**: `camera.mqtt_prefix`. Default de fábrica = MAC sin `:`, pero los
  usuarios lo personalizan (la cámara `oficina` usa `yi-oficina`).
- **Entrada** (la cámara publica): `<prefix>/<birth_will>` → `online` (retained)
  / `offline` (last-will); `<prefix>/<motion>` → `motion_start` | `motion_stop`
  | `human` | `vehicle` | `animal` | `crying`; `<prefix>/<motion_files>` → lista
  de archivos al terminar un motion; `<prefix>/<sound_detection>` → `sound`.
- **Salida** (el NVR publica, QoS 1): `<prefix>/cmnd/camera/<cmd>` con payloads
  fijos: `on`/`off` (led, ir, rotate, motion_detection, save_video_on_motion,
  sound_detection, baby_crying_detect, ai_*_detection, face_detection,
  motion_tracking, local_record), `yes`/`no` (switch_on), `low|medium|high`
  (sensitivity), `30..90` (sound_sensitivity), `no|presets|360` (cruise).
  Payload **vacío** a `<prefix>/cmnd/camera` = ping de sync (la cámara
  re-publica su estado; no cambia nada).
- **Feedback**: `<prefix>/stat/camera/<cmd>` (mismo suffix que el comando).

Los suffixes de tema y los strings de payload **varían entre firmwares y entre
usuarios**, por lo que todo se resuelve por cámara con fallback a los defaults
de fábrica (`mqtt/topics.js`). Referencia real (cámara `oficina`, en
`cameras.json`):

| Campo | Default fábrica | `oficina` |
|---|---|---|
| prefix | MAC sin `:` | `yi-oficina` |
| birth_will | `birth_will` | `status` |
| motion | `motion` | `motion_detection` |
| motion_image | `motion_image` | `motion_detection_image` |
| ai_human / ai_vehicle / ai_animal | `ai_human_detection` / `ai_vehicle_detection` / `ai_animal_detection` | `human` / `vehicle` / `animal` |
| baby_crying | `baby_crying` | `crying` |
| sound | `sound_detection` | `sound` |

### D8 (fase 2) — `motion_image` no se suscribe
El tema `<prefix>/<motion_image>` lleva JPEGs binarios pesados. El NVR no los
necesita (los clips llegan por FTP), así que el cliente **no** se suscribe; el
tema solo se resuelve/documenta en `topics.js` para futuras fases.

### D9 (fase 2) — [INTEG] mosquitto en compose sin puerto host: DEFERRED-TO-INTEGRATION
El criterio `[INTEG]` de "mosquitto en compose sin puerto publicado al host" se
marcará en la fase de integración. `infra/mosquitto/mosquitto.conf` ya está
preparado (listener 1883, `allow_anonymous true` — Mosquitto 2 lo deniega por
defecto —, solo red interna).

### D10 (fase 3) — go2rtc: config generado + proxy en Express
- `apps/api/scripts/generate-go2rtc-config.js` lee `src/config/cameras.json` y
  escribe `infra/go2rtc/go2rtc.yaml` (una entrada `streams.<id>` por cámara con
  `rtsp_url`; sin cámaras → `streams: {}` + warning). Se ejecuta en el arranque
  de `server.js` ANTES del `listen`, envuelto en try/catch: si falla, log de
  error pero el servicio sigue (go2rtc es opcional en dev). El yaml se
  commitea como ejemplo (artefacto derivado).
- El proxy `/stream-proxy/*` usa `http-proxy-middleware` (v4) con
  `target: GO2RTC_URL` (env, default `http://go2rtc:1984`), `changeOrigin: true`
  y `ws: true` (WebRTC = WebSocket). Se monta DESPUÉS de las rutas API y los
  estáticos; el futuro fallback del SPA irá después.
- **Robustez**: en v4, proveer `on: { error }` desactiva el error-response
  por defecto (504 texto); respondemos `502 {success:false, error:"go2rtc
  unreachable"}`. El middleware además llama a `next(err)`, así que hay un
  error-handler de Express (tras el proxy) que traga el error si la respuesta
  ya fue enviada. Con go2rtc caído, el proceso sigue vivo.
- `GET /api/cameras/:id/stream` devuelve URLs relativas del proxy
  (`/stream-proxy/api/ws?src=<id>`, `/stream-proxy/<id>.m3u8`): el navegador
  solo habla con el puerto 3000.

### D11 (fase 3) — go2rtc nativo en Windows (dev) + go2rtc integrado en yi-hack
- **Dev nativo** (sin Docker): con `go2rtc.exe` descargado
  (https://github.com/AlexxIT/go2rtc/releases), arrancar
  `go2rtc.exe -config infra/go2rtc/go2rtc.yaml` (el yaml lo genera el API en
  el arranque) y dejar `GO2RTC_URL=http://127.0.0.1:1984` en el `.env` local.
  go2rtc escucha por defecto en `127.0.0.1:1984`.
- **Alternativa SBC** (corregido tras analizar el repo del firmware
  `roleoroleo/yi-hack-Allwinner-v2`, ver D13): el campo
  `"go2rtc":"yes"` de `/cgi-bin/status.json` **solo indica que el binario
  `go2rtc` (v1.9.14, descargado en el build) está empaquetado** en
  `/tmp/sd/yi-hack/bin/go2rtc`; NO que esté corriendo. El firmware lo usa
  únicamente como **servidor RTSP** (opción `RTSP_ALT=go2rtc`): el yaml que
  genera `script/service.sh` deja `api.listen:""` y `webrtc.listen:""`
  (desactivados) y solo `rtsp.listen:":554"`. Por eso el puerto 1984 de la
  cámara no escucha y las rutas `/go2rtc/*` dan 404: **por diseño**, no es un
  fallo. El go2rtc de la cámara **no sirve como live view directo** (sin
  WHEP/WebRTC); la arquitectura por defecto sigue siendo el **go2rtc central**
  del repo consumiendo RTSP :554 de la cámara.

### D12 (fase 3) — Criterios [INTEG]/[SBC] del live view: DEFERRED
- `[INTEG]` compose completo con solo puertos 3000/2121/1024-1050 publicados
  al host: **DEFERRED-TO-INTEGRATION** (verificar en la fase de integración
  contra el stack Docker real; `docker-compose.yml` ya lo define así).
 - `[INTEG]`/`[SBC]` reproducción WebRTC real en navegador (stream en vivo):
   **DEFERRED-TO-INTEGRATION** / **DEFERRED-TO-SBC**. En dev se verifica el
   proxy con un stub HTTP (`scripts/verify-stream-proxy.js`), no con cámara real.

### D13 (fase 3) — RTSP server program de la cámara (RTSP_ALT): estándar por defecto, configurable

Análisis del firmware `yi-hack-allwinner-v2` (repo clonado, fw 0.3.6). La UI
web expone "RTSP server program" (key `RTSP_ALT`, enum validado por
`mqtt-config/validate.c`): 3 programas que **todos sirven la misma URL**
`rtsp://<cam>:554/ch0_0.h264` (high) / `ch0_1.h264` (low) con el mismo H.264
codificado (nadie transcodifica):

| Opción | Daemon | Fuente | Audio | Peso |
|---|---|---|---|---|
| `standard` (default) | `rRTSPServer` (live555, C++) | lee `/dev/shm/fshare_frame_buffer` directo | aac/pcm/alaw/ulaw | medio, el más probado |
| `alternative` | `h264grabber -f` (C) + `rtsp_server_yi` (C++ ligero) | h264grabber volca h264/aac a fifos `/tmp/h264_{low,high}_fifo` | solo aac | el más ligero |
| `go2rtc` | `go2rtc` v1.9.14 (Go, estático ARM) + `h264grabber` como fuente `exec` | stdout de h264grabber | solo aac | el más pesado (runt. Go en 512MB) |

- `h264grabber` (C, en el repo) solo saca el flujo **ya codificado** de la
  shared memory; con `-f` escribe a fifos, sin `-f` a stdout (fuente exec de
  go2rtc). Opciones: `-r low|high|both`, `-a` (audio AAC), `-s` (no tocar SPS
  timing), `-m <model>`.
- El watchdog (`script/wd.sh`) vigila cada variante (puerto LISTEN + procesos
  vivos; `standard` además detecta proceso bloqueado al 0% CPU con socket
  establecido y lo relanza).
- **Recomendación**: mantener `standard` como default (es lo que trae el
  firmware, soporta todos los codecs de audio y es lo más probado en el chip).
  Si en el SBC se nota CPU ajustada, `alternative` es la opción ligera.
  `go2rtc` en la cámara **no aporta** nada a nuestra arquitectura (ya hay un
  go2rtc central) y es el más pesado.
- **Código preparado para las 3 opciones**:
  - `cameras.json`: campo `rtsp: { alt, audio }` por cámara (registro de qué
    programa RTSP usa la cámara y su audio).
  - `scripts/set-camera-rtsp.js`: consulta (`--get`) y cambia (`--alt ...
    --audio ... --apply`) `RTSP_ALT`/`RTSP_AUDIO` vía los CGIs de la cámara
    (`set_configs.sh?conf=system` + `service.sh?name=rtsp&action=stop|start`)
    y re-sincroniza `cameras.json`. Sin `--apply` es dry-run.
  - `generate-go2rtc-config.js`: emite `audio: true` en el stream si la
    cámara declara audio (la cámara solo emite AAC).

### D14 (fase 3) — Benchmark CPU de RTSP_ALT: justificación del programa RTSP elegido

Justificación empírica de la decisión D13. Ante afirmaciones encontradas
(sobre todo marketing a favor de `go2rtc`), se mide en la cámara real
(`oficina`, 192.168.14.30, yi-hack-allwinner-v2 0.3.6, chip Allwinner) qué
programa RTSP consume menos CPU/RAM bajo la misma carga.

**Protocolo de prueba** (manual, desde la PC):

- **Variables controladas**: 1 único consumidor RTSP fijo (ffmpeg en la PC,
  sink `null`), siempre el stream low `ch0_1` (el que usa el NVR), audio OFF
  en las 3 opciones, `RTSP_STREAM=low`. Las 3 pruebas se hacen **seguidas**
  (misma luz/movimiento de fondo, porque el bitrate varía con la escena).
- **Por cada opción** (`standard` → `alternative` → `go2rtc`):
  1. Aplicar: `node scripts/set-camera-rtsp.js --camera oficina --alt <opcion> --audio no --apply`
     (desde `apps/api`). Esperar 60 s de estabilización.
  2. **Baseline sin consumidor**: 3 lecturas (~20 s entre ellas) de
     `curl.exe http://192.168.14.30/cgi-bin/status.json` → `load_avg`, `free_memory`.
  3. Arrancar consumidor (5 min):
     `ffmpeg -rtsp_transport tcp -i rtsp://192.168.14.30/ch0_1.h264 -f null - 2> ffmpeg-<opcion>.log`
  4. Mientras corre, 3–5 lecturas de `status.json` (`load_avg`, `free_memory`)
     y, si hay SSH en la cámara (usuario `root`),
     `top -b -n 2 -d 1 | grep -E "rRTSPServer|go2rtc|h264grabber|rtsp_server_yi"`
     (la 2ª muestra de `top` es el %CPU real; misma técnica que el watchdog)
     y `free`.
  5. Parar ffmpeg y anotar del final del log: fps y `dropped frames`.
  6. Anotar en la tabla y pasar a la siguiente opción.
- **Al terminar**: restaurar la opción ganadora con `--apply`.
- **Criterio de victoria**: menor **Δload** (load_avg con consumidor −
  baseline) y 0 dropped frames. Si los Δload difieren <10 %, se mantiene
  `standard` (mismo resultado, más probado). Un crash/restart del daemon
  durante la prueba (hueco de fps) descarta la opción por estabilidad.

**Resultados** (completar tras las pruebas):

| Opción | load_avg sin client | load_avg con client | Δload | free_mem (KB) | CPU daemon % (SSH) | fps | drops | Estable? |
|---|---|---|---|---|---|---|---|---|
| standard | | | | | | | | |
| alternative | | | | | | | | |
| go2rtc | | | | | | | | |

**Conclusión** (completar tras las pruebas):

- Opción elegida como default para las cámaras del proyecto:
- Razón (datos de la tabla):
- Fecha de las pruebas:
