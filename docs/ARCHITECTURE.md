# Architecture — Surveillance Center (Home NVR)

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
survillance-center/
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
