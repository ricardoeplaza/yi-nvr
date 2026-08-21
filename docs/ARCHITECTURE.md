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
│   └── go2rtc/go2rtc.yaml.example   # template; real go2rtc.yaml is manual + gitignored (D17)
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── server.js          # bootstrap: config, middleware, rutas, listen
│   │       ├── ftp.js
│   │       ├── processor.js
│   │       ├── database.js
│   │       ├── camera-registry.js
│   │       ├── retention.js
│   │       ├── config/cameras.json.example # template; real cameras.json is gitignored
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
- ~~`apps/api/scripts/generate-go2rtc-config.js` lee `src/config/cameras.json` y
  escribe `infra/go2rtc/go2rtc.yaml`...~~ **SUPERSEDIDO por D17** (solo la
  parte del generador): el generador se ejecutaba en el arranque de `server.js`
  ANTES del `listen` y **sobrescribía el yaml que funcionaba** con sintaxis
  `src:` que go2rtc no acepta. El yaml es ahora manual (D17). El proxy
  `/stream-proxy/*` de abajo sigue en pie.
- El proxy `/stream-proxy/*` usa `http-proxy-middleware` (v4) con
  `target: GO2RTC_URL` (env, default `http://go2rtc:1984`), `changeOrigin: true`
  y `ws: true` (WebRTC = WebSocket). Se monta DESPUÉS de las rutas API y los
  estáticos; el futuro fallback del SPA irá después.
- **Robustez**: en v4, proveer `on: { error }` desactiva el error-response
  por defecto (504 texto); respondemos `502 {success:false, error:"go2rtc
  unreachable"}`. El middleware además llama a `next(err)`, así que hay un
  error-handler de Express (tras el proxy) que traga el error si la respuesta
  ya fue enviada. Con go2rtc caído, el proceso sigue vivo.
- **Location rewrite**: go2rtc devuelve `Location` absolutas en algunas
  redirecciones (p.ej. 301 a `/api/stream.m3u8?src=<id>&mp4` cuando el stream
  aún no está listo). El proxy reescribe en `on: { proxyRes }` añadiendo el
  prefijo `/stream-proxy` a cualquier Location absoluta, para que el navegador
  siga resolviendo dentro del proxy (sin esto, el navegador saltaba a
  `:4200/api/...` → 404).
- `GET /api/cameras/:id/stream` devuelve URLs relativas del proxy
  (`/stream-proxy/api/ws?src=<id>`, `/stream-proxy/api/stream.mp4?src=<id>`):
  el navegador solo habla con el puerto 3000. El fallback de reproducción es
  el endpoint MSE de go2rtc (`/api/stream.mp4?src=<id>`), que funciona en VLC
  y en `<video>` nativo; se descartó el HLS (`/api/stream.m3u8?src=<id>`)
  porque VLC no lo reproducía de forma fiable (ni directo ni por proxy).
  Nota: no existe `/<id>.m3u8` en go2rtc (daría 404).

### D11 (fase 3) — go2rtc nativo en Windows (dev) + go2rtc integrado en yi-hack
- **Dev nativo** (sin Docker): con `go2rtc.exe` descargado
  (https://github.com/AlexxIT/go2rtc/releases), arrancar
  `go2rtc.exe -config infra/go2rtc/go2rtc.yaml` (el yaml es manual, D17) y
  dejar `GO2RTC_URL=http://127.0.0.1:1984` en el `.env` local.
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
   - ~~`generate-go2rtc-config.js`: emite `audio: true` en el stream si la
     cámara declara audio (la cámara solo emite AAC)~~ — script eliminado en
     D17; el audio se gestiona directamente en `go2rtc.yaml` (manual).

### D14 (fase 3) — Benchmark CPU de RTSP_ALT: justificación del programa RTSP elegido

Justificación empírica de la decisión D13. Ante afirmaciones encontradas
(sobre todo marketing a favor de `go2rtc`), se mide en la cámara real
(`oficina`, <CAMERA_IP>, yi-hack-allwinner-v2 0.3.6, chip Allwinner) qué
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
     `curl.exe http://<CAMERA_IP>/cgi-bin/status.json` → `load_avg`, `free_memory`.
  3. Arrancar consumidor (5 min):
     `ffmpeg -rtsp_transport tcp -i rtsp://<CAMERA_IP>/ch0_1.h264 -f null - 2> ffmpeg-<opcion>.log`
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

### D15 (fase 4) — Web Push: VAPID, suscripciones y triggers
- **Dependencia**: `web-push` (npm), la única nueva de la fase.
- **Claves VAPID**: se generan con `npx web-push generate-vapid-keys`
  (desde `apps/api`). Las claves van **SOLO en el `.env` de la raíz**
  (gitignored): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_CONTACT_EMAIL` (debe ser `mailto:...`). **Nunca** en git: los
  placeholders de `.env.example` se dejan vacíos y este archivo solo
  documenta el comando de generación.
- **Modo noop**: sin las tres variables VAPID, `push/webpush.js` no envía
  nada (log a nivel debug `[Push] VAPID no configurado...`) y devuelve
  `{delivered:0, failed:0, removed:0, noop:true}`. El resto del sistema
  (HTTP/FTP/MQTT) funciona igual; el endpoint `GET /api/push/vapid-public-key`
  devuelve `publicKey: null` y el frontend degrada a "sin notificaciones".
- **Suscripciones**: tabla `push_subscriptions` (endpoint PK, p256dh, auth,
  user_agent, created_at, last_used_at). Upsert por `endpoint`; HTTP 404/410
  del push service → la fila se borra (suscripción caducada); HTTP 2xx →
  `last_used_at` se actualiza. Un job diario (offset aleatorio 0-30 min,
  timers `.unref()`) borra las filas con `COALESCE(last_used_at, created_at)`
  anterior a 180 días.
- **Formato del payload** (decisión menor): JSON plano
  `{title, body, icon, url, data}`. El service worker del frontend (fase 5)
  lo parsea y construye la `Notification` del navegador; `icon` es la URL
  relativa del thumbnail (`/processed/<archivo>.jpg`) y `url` la ruta de la
  app a la que enlazar al hacer clic.
- **Triggers** (sin acoplar push dentro de `mqtt/client.js`):
  - *Movimiento* (inmediato): `server.js` se suscribe a
    `mqttEvents.on('camera-motion')` y llama a `notify({title:'Movimiento',
    body:<nombre>, url:'/cameras/<id>'})`.
  - *Clip procesado* (enriquecido): `ftp.js` (`handleNewVideo`) llama a
    `notify({title:'Nuevo clip', body:<cámara>, icon:<thumbnail_url>,
    url:'/videos/<id>'})` tras `processVideo` + `insertVideo` exitosos.
  - `notify()` es a prueba de fallos por diseño (try/catch + manejo de
    promesa por envío; nunca lanza al llamador).
- **DEFERRED**: la entrega real en un navegador (service worker de push,
  permiso del usuario, prueba con endpoint FCM real) queda pendiente de la
  fase 5 (frontend). En esta fase se verifica el fan-out HTTP contra
  endpoints falsos (2xx/404/410) y el trigger MQTT de movimiento.

### D16 (fase 5) — Live view: WebRTC (WHEP) como primaria, MSE real (MediaSource) como fallback automático
- **Fuente primaria**: WebRTC por WHEP — `StreamService.startWebRtc` contra
  `/stream-proxy/api/webrtc?src=<id>` (ver handshake abajo). Funciona fuera
  de la LAN sin STUN/TURN y el handshake ya está construido en el propio
  frontend (estado reactivo incluido). Cubre iOS Safari (que NO soporta
  MediaSource).
- **Fallback automático (MSE real)**: si el handshake WHEP lanza excepción
  (o el `<video>` emite `error`) o no llega el evento `playing` en ~10 s, el
  `Player` cierra la `RTCPeerConnection` y monta **MSE de verdad** contra
  `mse_url` (`/stream-proxy/api/stream.mp4?src=<id>`): `fetch` (con
  `AbortController`) → bucle `reader` sobre el cuerpo MP4 fragmentado
  (ftyp → moov → moof/mdat) → `MediaSource` + `SourceBuffer` con
  `video.src = URL.createObjectURL(ms)` (no `srcObject`). El contentType del
  `SourceBuffer` NO está hardcoded: go2rtc anuncia el codec exacto en el
  `Content-Type` de la respuesta (`video/mp4; codecs="avc1.640029"` para
  H.264, `codecs="hvc1.1.6.L153.B0"` para H.265) y se usa tal cual tras
  `MediaSource.isTypeSupported()`. Replica el algoritmo MSE de la UI de
  go2rtc (`video-rtc.js`): `sb.mode='segments'`, ventana de ~5 s con
  `setLiveSeekableRange` y catch-up por `playbackRate` (autoconverge a
  velocidad real con ~1 s de latencia). Un solo intento (flag
  `liveFallbackTried`); si también falla, estado `error`.
- **HLS eliminado**: el fallback anterior era hls.js contra
  `/stream-proxy/api/stream.m3u8`. Según "codecs madness" de go2rtc, HLS es
  la peor tecnología para live (latencia alta, formato legacy TS sin audio)
  y solo quedaba como opción legacy para iPhones viejos (≤14); ya no es el
  objetivo. MSE cubre H.264/H.265 en Chrome/Edge/Firefox y WebRTC (la
  primaria) cubre iOS Safari. Dependencia hls.js eliminada del frontend.
- **Handshake WebRTC por WHEP (HTTP)**: `POST /stream-proxy/api/webrtc?src=<id>`
  con el offer en texto plano (`Content-Type: application/sdp`) → respuesta =
  answer en texto plano. Dos requisitos no negociables: (a) el offer se genera
  con `addTransceiver('video'|'audio', {direction:'recvonly'})` — sin
  transceivers explícitos `createOffer()` no emite líneas `m=` y go2rtc no
  tiene nada que negociar; (b) el offer se envía **después** de que termine el
  ICE gathering local (timeout 3 s) porque WHEP no soporta trickle ICE.
  El endpoint WebSocket `/api/ws` de go2rtc se descartó: formato de mensajes
  opaco (JSON) y el lazy-upgrade de http-proxy-middleware lo hacían más
  frágil que un POST simple que ya atraviesa los dos proxies sin config extra.
- **Estado reactivo**: `Player.liveStatus` (output signal
  `'idle' | 'loading' | 'playing' | 'error'`); la página de detalle de
  cámara muestra texto mínimo ("Cargando…" / "Error de stream").
- **Razón de la estrategia**: las cámaras se ven sobre todo fuera de la LAN;
  WebRTC pasa por el proxy Express (puerto 3000) sin infraestructura
  STUN/TURN, y MSE es la red de seguridad que también atraviesa la cadena de
  proxies sin config extra (GET con cuerpo chunked). H.265 + WebRTC falla en
  algunos navegadores; MSE es la segunda mejor opción según "codecs madness"
  de go2rtc.
- **Limpieza**: al destruir el `Player` o cambiar de fuente se limpian
  `srcObject`/`src`, se hace `close()` de la `RTCPeerConnection` abierta
  (por eso `startWebRtc` la devuelve), se aborta el `fetch` MSE
  (`AbortController`), `endOfStream()` de la `MediaSource` y
  `URL.revokeObjectURL()` del object URL.

### D17 (fase 3) — go2rtc.yaml manual: se elimina el generador (veredicto A sobre A/B)

Ante la divergencia entre el generador automático y el `go2rtc.yaml` real que
funciona, se plantearon dos opciones: **A** (yaml manual + `cameras.json`
simplificado, generador eliminado) y **B** (generador que reproduce el formato
real: `cameras.json` como única verdad, con sintaxis inventada para wrappers
`ffmpeg:` y streams derivados). **Gana A**, por evidencia:

- **Bug activo confirmado**: `server.js` ejecutaba
  `scripts/generate-go2rtc-config.js` en el arranque (antes del `listen`), así
  que cada restart del API sobrescribía el yaml que funcionaba. Además la
  sintaxis emitida (`streams.<id>.src:`) **no es válida en go2rtc**: según la
  doc oficial, un stream es una cadena o una **lista de fuentes** (p. ej.
  `- ffmpeg:rtsp://...`); no existe la clave `src:`. El generador producía
  config rota por diseño.
- **`rtsp_url` no lo lee nadie en el backend**: el registro usa `id`, `name`,
  `host`, `ftp_dir`, `mqtt_prefix`, `mqtt_topics`, `mqtt_messages`,
  `capabilities`. `rtsp_url` solo la consumía el generador (y `rtsp.{alt,audio}`
  lo usa `scripts/set-camera-rtsp.js` como registro del programa RTSP de la
  cámara — se conserva). Eliminar `rtsp_url` de `cameras.json` es honesto: no
  era dato del backend.
- **El yaml contiene conocimiento que no deriva de cámaras**: `mirilla_h265`
  (fuente tuya H.265 cruda) + `mirilla` (alias derivado `- ffmpeg:mirilla_h265`
  que normaliza el stream) no corresponden 1:1 con entradas de
  `cameras.json`; el canal real de `oficina` es `ch0_0` (el json decía
  `ch0_1`). El yaml era la verdad de facto; B habría que inventar en
  `cameras.json` la sintaxis go2rtc (nombres de streams intermedios, wrappers),
  acoplando el registro de cámaras al formato interno de go2rtc.
- **Mantenimiento (una persona, cámaras caseras)**: con A cada fichero vive en
  su sitio natural — `cameras.json` = datos del backend (FTP/MQTT),
  `go2rtc.yaml` = configuración go2rtc (editable a mano o desde la WebUI de
  go2rtc en `:1984`, sin reiniciar el API). La única invariantes se documenta:
  **un stream por `id` de cámara** (es el `src` que usa
  `GET /api/cameras/:id/stream`).

Cambios: se elimina `scripts/generate-go2rtc-config.js` y su wiring en
`server.js`; `cameras.json` (+`.example`) pierde `rtsp_url` (y la validación de
`camera-registry.js` deja de exigirla); `go2rtc.yaml.example` pasa a ser
plantilla manual con las reglas (wrapper `ffmpeg:`, alias derivados); se limpia
`GO2RTC_CONFIG_PATH` de `.env.example`/`docker-compose.yml` (el `api` ya no
monta `./infra/go2rtc`; el servicio `go2rtc` sigue esperando a que el yaml
exista). El `go2rtc.yaml` real no se toca: era (y sigue siendo) la verdad.

## Notas durante el desarrollo (live view)

Historial de la depuración del stream en vivo, para que no caiga en el
olvido. Se probó de todo durante muchas horas antes de que funcionara; el
orden de los hallazgos importa:

1. **`ws: true` de http-proxy-middleware (v4) no basta para upgrades**: el
   listener de `upgrade` se registra de forma perezosa (solo tras la primera
   petición HTTP) y, sobre todo, el evento `upgrade` de Express **no pasa por
   el routing**: el prefijo de mount `/stream-proxy` no se corta de
   `req.url`, así que go2rtc recibía `/stream-proxy/api/ws` → 404 → close
   1006. Solución: handler explícito `server.on('upgrade')` en `server.js`
   que corta el prefijo y delega en `streamProxy.upgrade(req, socket, head)`.
2. **Formato del endpoint WS de go2rtc**: espera SDP crudo, no JSON
   (verificado black-box: un JSON malformado lo ignora en silencio, un SDP
   inválido lo cierra). Aun así el WS se descartó a favor de WHEP (D16).
3. **El offer sin `addTransceiver` no lleva líneas `m=`**: sin transceivers
   explícitos `createOffer()` genera un SDP sin secciones de media; go2rtc
   recibe la señalización pero no tiene nada que ofrecer de vuelta. Síntoma
   idéntico al de un proxy roto → se perdió tiempo distinguiendo ambos.
4. **El bug final (el que hizo funcionar todo)**: en
   `camera-detail.page.ts` el binding era `[liveFallbackWsUrl]` pero el input
   que el `Player` consume se llama `liveFallbackWhepUrl` → la URL WHEP
   **nunca llegaba al player** y el fallback moría en silencio. En la misma
   página: mp4 hardcodeado a `localhost:1984` (sin pasar por el proxy) y uso
   del campo `ws_url` en vez de `webrtc_url`. Corregido: binding + signal
   renombrados, `info.mse_url` e `info.webrtc_url` del API.
5. **Verificación black-box del WHEP**: `POST /api/webrtc?src=oficina` con
   un SDP de prueba devuelve 500 `payload type not found` (no 404) tanto
   directo a go2rtc (1984) como vía la cadena Vite→Express (3000) → el
   endpoint existe y el POST con body cruza los dos proxies sin config extra
   (el `Content-Type: application/sdp` no lo toca `express.json()`).
6. **Alternativa considerada y descartada**: el componente `video-rtc.js`
   de go2rtc (elemento `<video-stream src="..." mode="webrtc,mse">`) resuelve
   todo el handshake por nosotros. Descartado porque acopla el frontend a un
    script externo servido desde el puerto 1984 y a la API de go2rtc, y el
    handshake propio (WHEP + estado reactivo del `Player`) ya estaba
    construido. Si en el futuro mantener el handshake propio pesa, esa es la
    vía de escape de una línea.
7. **Cambio de estrategia (D16)**: la primaria pasó de mp4/MSE a WebRTC
   (WHEP) y el fallback de WHEP a HLS con hls.js, porque el endpoint
   mp4/MSE de go2rtc no reproduce de forma fiable en el navegador sin su
   librería propia. HLS verificado black-box: `GET /api/stream.m3u8?src=oficina`
   → 200 (master → media playlist → `segment.ts` 200).
8. **Cambio de estrategia (D16, segunda ronda)**: el fallback pasó de HLS a
   **MSE real (MediaSource API)**, porque H.265 + WebRTC falla en algunos
   navegadores y según "codecs madness" de go2rtc la segunda mejor opción es
   MSE (HLS quedaba solo como legacy para iPhones viejos ≤14). Lección del
   intento anterior: apuntar `<video src>` al endpoint mp4 **NO es MSE** —
   es progressive download de un archivo que nunca termina y el navegador no
   lo reproduce. MSE real exige `MediaSource` + `SourceBuffer` alimentado con
   `fetch` + `reader`. Verificado black-box: la UI de go2rtc (`video-rtc.js`)
   alimenta ese `SourceBuffer` con los frames binarios del WebSocket
   `/api/ws` (negociando el codec por JSON); el endpoint HTTP
   `GET /api/stream.mp4?src=oficina` → 200 `video/mp4; codecs="avc1.640029"`
   y `src=mirilla_h265` → 200 `video/mp4; codecs="hvc1.1.6.L153.B0"`: el
   codec exacto viene en el `Content-Type`, así que no hace falta parsear el
   moov. Limpieza asociada: se eliminó el handler `server.on('upgrade')` de
   `server.js`, el campo `ws_url` de la API, y el `ws: true` del proxy de
   Vite — WHEP es un POST HTTP normal y no necesita upgrades.
