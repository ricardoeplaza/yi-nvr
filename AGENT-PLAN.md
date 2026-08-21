# AGENT EXECUTION PLAN — Home NVR (Supersedes PLAN-DESARROLLO-NVR.md)

**Audience:** autonomous coding agent (OpenCode / Qwen). This document is the single source of truth for execution. Follow phases in strict order (0 → 9). Each phase is a closed work unit: goal, concrete tasks, affected files, verifiable acceptance criteria.

**Rules of engagement:**
1. Do not start phase N+1 until every acceptance criterion of phase N passes (or is explicitly marked `DEFERRED-TO-INTEGRATION` / `DEFERRED-TO-SBC` with a note in `docs/ARCHITECTURE.md`).
2. Commit at the end of each phase with message `feat(phase-N): <summary>` and create git tag `phase-N`.
3. Low-impact ambiguities: pick the simplest reversible option, document it in `docs/ARCHITECTURE.md` under "Decisions", and make it configurable. Do not block.
4. Never introduce nginx, Apache, Caddy, or any additional web server. All proxying happens inside the Express process.
5. Never rewrite the working FTP / processor / database logic. Refactor structure only.
6. No AI/ML features. The original plan mentioned "AI analysis" — that was an error; no such code exists. Do not build it.

---

## 1. Mission

Build a self-hosted NVR ecosystem that replaces both the official MiHome app and Home Assistant for a set of 3–5 Xiaomi cameras running `yi-hack` firmware (MQTT + RTSP + FTP clip upload).

- Receive motion-triggered clips over FTP, process them (thumbnail + animated WebP preview), index them in SQLite, serve them via REST API and an Angular PWA.
- Talk MQTT directly to cameras (motion events in, control commands out: LED, IR-cut/night vision, record mode, power).
- Show live video in the browser via WebRTC (go2rtc sidecar).
- Send Web Push notifications on motion and on clip processing completion.
- Single HTTP entry point (port 3000) serving API + PWA + media + proxied go2rtc. No nginx.

## 2. Environments (critical — read carefully)

| Environment | OS / Arch | Role | Notes |
|---|---|---|---|
| **Dev** | Windows (win32, x64), Node 24 | All coding and native verification | Shell is PowerShell 5.1. Use `curl.exe` (not the PowerShell alias) for HTTP checks. ffmpeg must be on PATH (`winget install Gyan.FFmpeg`). Docker Desktop (WSL2) is OPTIONAL here. |
| **Integration** | Debian, linux/amd64 | Authoritative Docker validation | Full `docker compose` stack, clean install from README, 24h stability. This is where `[INTEG]` criteria are verified. |
| **Production** | Linux ARM SBC (TBC: `linux/arm/v7` 512MB or `linux/arm64`) | Final deployment | Behind Tailscale/Headscale VPN, never exposed to the internet. `[SBC]` criteria. |

Consequences:
- **All code must be cross-platform** (developed on Windows, run on Linux). See section 10 (cross-platform pitfalls).
- Acceptance criteria that need Docker are tagged `[INTEG]`. If Docker is not available in the current session, verify what you can natively, mark the rest `DEFERRED-TO-INTEGRATION` in `docs/ARCHITECTURE.md`, and continue.
- Acceptance criteria that need the real SBC or real cameras are tagged `[SBC]`. Simulate with test data, mark `DEFERRED-TO-SBC`.
- Native modules (`better-sqlite3`) must be built for the **target platform inside Docker** (buildx `--platform`), never copied from the dev machine's `node_modules`.

## 3. What exists today (reuse verdict)

Working project at repo root with real data (~90 clips, cameras `oficina` + default):

| File | Verdict |
|---|---|
| `src/ftp.js` | **KEEP.** ftp-srv on port 2121 (passive 1024–1050), user `camera`/`surveillance123`, chokidar watcher → processing pipeline. Only changes: config via env, camera mapping via registry. |
| `src/processor.js` | **KEEP.** ffmpeg thumbnail (JPG 640x360) + animated WebP preview (320px, 10 frames), `nice -n 19` on Linux (already guarded for Windows). |
| `src/database.js` | **KEEP + EXTEND.** better-sqlite3, WAL, `videos` table. Keep the `videos` table schema **unchanged** (no migration of existing data). Add new tables only. |
| `src/server.js` | **MODULARIZE.** Split into `routes/*`. The 5 existing endpoints must keep identical URLs, query params, and JSON response shapes. |
| `src/public/` (vanilla HTML/CSS/JS) | **DISCARD.** Replaced by the Angular PWA (phase 5). Its features (gallery with filters + pagination, timeline grouped by date, video modal player, delete with confirm) are the functional spec for the new frontend. |
| `src/storage/` | **PRESERVE.** Contains `surveillance.db`, `ftp/`, `processed/`. Never commit it. Existing data must keep working after the repo reorganization. |

Existing API contract to preserve (byte-compatible JSON):
- `GET /api/videos?camera=&startDate=&endDate=&limit=` → `{success, count, data: [{id, camera_name, timestamp, original_path, thumbnail_path, preview_path, duration, file_size, original_url, thumbnail_url, preview_url}]}`
- `GET /api/videos/:id` → `{success, data: {...}}`
- `DELETE /api/videos/:id` → deletes DB row + physical files
- `GET /api/cameras` → today: `{success, count, data: [name, ...]}`. Phase 1 **extends** this (see below); existing consumers must not break.
- `GET /api/timeline` → `{success, data: [{date, total, cameras: {name: count}}]}`

## 4. Technology stack (closed decisions — do not re-evaluate)

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express 5 (already in use) |
| Database | SQLite via `better-sqlite3` (already in use) |
| FTP | `ftp-srv` (already in use) |
| File watching | `chokidar` (already in use) |
| Video processing | `fluent-ffmpeg` + system `ffmpeg` binary (already in use) |
| MQTT broker | Eclipse Mosquitto 2 (Docker container) |
| MQTT client | `mqtt` (npm) |
| RTSP → WebRTC | `go2rtc` (Docker sidecar) |
| Proxying go2rtc | `http-proxy-middleware` inside Express (NOT a new server) |
| Push | `web-push` (npm) + VAPID |
| Frontend | Angular (latest stable) + PWA (`@angular/pwa`), separate push service worker |
| Packaging | Docker Compose (api + mosquitto + go2rtc). systemd units as documented plan B for memory-constrained SBCs |
| Auth | Static bearer token (`API_AUTH_TOKEN`) — single-user home system, keep it simple |

## 5. Target repository structure

```
yi-nvr/
├── AGENT-PLAN.md                  # this file
├── docker-compose.yml
├── .env.example
├── .gitignore
├── .gitattributes
├── infra/
│   ├── mosquitto/mosquitto.conf
│   └── go2rtc/go2rtc.yaml.example # template; real go2rtc.yaml is manual + gitignored (D17)
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── src/
│   │       ├── server.js          # bootstrap only: config, middleware, routes mount, listen
│   │       ├── ftp.js             # kept
│   │       ├── processor.js       # kept
│   │       ├── database.js        # kept + new tables
│   │       ├── camera-registry.js
│   │       ├── retention.js
│   │       ├── config/
│   │       │   └── cameras.json
│   │       ├── mqtt/
│   │       │   ├── client.js
│   │       │   ├── topics.js
│   │       │   └── commands.js
│   │       ├── push/
│   │       │   └── webpush.js
│   │       └── routes/
│   │           ├── videos.js
│   │           ├── cameras.js
│   │           ├── timeline.js
│   │           ├── push.js
│   │           └── stream.js
│   └── frontend/                  # Angular workspace (phase 5)
├── storage/                       # Docker volume target (see note below)
├── scripts/
│   └── integration-check.sh       # phase 8
└── docs/
    ├── ARCHITECTURE.md
    └── API.md
```

**Storage path note:** `database.js`, `ftp.js`, `processor.js` resolve storage relative to `__dirname` (`src/storage`). After the move, that becomes `apps/api/src/storage` — **this is where the existing data lives and must keep working in dev**. Introduce a `STORAGE_DIR` env var (default: `path.join(__dirname, 'storage')`) in all three modules so Docker can point it at `/app/storage` (mounted from repo-root `./storage`). In Docker, the mounted `./storage` is a **copy** of the dev storage for integration testing; do not move the real data into the repo-root `storage/` during development.

## 6. Phases

### Phase 0 — Repo bootstrap (Windows)

**Goal:** monorepo layout, git, env config, zero functional regression.

Tasks:
1. `git init` at repo root. Create `.gitignore`: `node_modules/`, `.env`, `storage/`, `apps/api/src/storage/`, `apps/api/public/`, `dist/`, `*.db`, `*.db-wal`, `*.db-shm`, `.angular/`.
2. Create `.gitattributes` with `* text=auto eol=lf`.
3. Move `src/` → `apps/api/src/`, `package.json` + `package-lock.json` → `apps/api/`. Adjust relative requires if any break (they use `__dirname`, so they should not). The existing data ends up in `apps/api/src/storage/`.
4. Add `dotenv` dependency. Create `.env.example` (section 7) and a local `.env` (gitignored) with dev defaults.
5. Make the three core modules read `STORAGE_DIR` / `FTP_PORT` / `FTP_USER` / `FTP_PASS` / `PORT` / `HOST` from env (with the current values as defaults) instead of hardcoding.
6. Create `docs/ARCHITECTURE.md` summarizing this plan (stack, environments, decisions log).
7. Baseline commit.

**Acceptance criteria:**
- From `apps/api`: `npm install && npm start` boots both FTP (2121) and HTTP (3000) on Windows.
- `curl.exe http://localhost:3000/api/videos` returns the existing ~90 clips with correct `original_url`/`thumbnail_url`/`preview_url` (files still served from the moved `storage/`).
- `curl.exe http://localhost:3000/api/timeline` and `/api/cameras` return the same shapes as before.
- No file in git contains absolute dev-machine paths.
- `git tag phase-0` created.

---

### Phase 1 — Backend modularization + camera registry (Windows)

**Goal:** `server.js` becomes a thin bootstrap; cameras become first-class configuration entities.

Tasks:
1. Split `server.js` into `routes/videos.js`, `routes/cameras.js`, `routes/timeline.js` (Express Routers). Keep URLs, params, and JSON shapes identical. `server.js` keeps: express app, static mounts (`/public`, `/processed`, `/videos`), JSON middleware, route mounting, listen, graceful shutdown.
2. Create `src/config/cameras.json`:
   ```json
   [
     {
       "id": "oficina",
       "name": "Oficina",
       "host": "192.168.1.50",
       "ftp_dir": "oficina",
       "mqtt_prefix": "A4CB8XXXXXXX",
       "rtsp_url": "rtsp://192.168.1.50:554/ch0_0.h264",
       "capabilities": { "led": true, "ircut": true, "rec_mode": true, "power": false }
     }
   ]
   ```
   - `ftp_dir` is the subdirectory under the FTP root the camera uploads to (maps uploads → camera id).
   - `mqtt_prefix` is the yi-hack camera id (MAC without colons).
    - Seed it with the cameras that exist in the current data (`oficina` and a `default` entry for root-level clips).
    - The real `cameras.json` is gitignored (LAN IPs / credentials); commit `cameras.json.example` with placeholders instead.
3. Create `src/camera-registry.js`: loads + validates the JSON at startup (manual validation, no extra deps: required fields, unique ids, valid JSON — a malformed file must log a clear error and exit non-zero, NOT crash silently mid-request), exposes `getAllCameras()`, `getCameraById(id)`, `getCameraByFtpDir(dir)`, `reload()`.
4. Wire the FTP pipeline: when a clip arrives, resolve the camera via `ftp_dir`; store `camera_name` in the DB as today (the `ftp_dir` value) — **no DB schema change**.
5. Extend `GET /api/cameras` to return the registry merged with DB facts:
   ```json
   { "success": true, "count": 2,
     "data": [ { "id": "oficina", "name": "Oficina", "host": "...", "capabilities": {...},
                 "has_videos": true, "video_count": 63, "last_video": "2026-08-18T..." } ] }
   ```
   Keep it a non-breaking superset (add fields; do not remove the array-of-objects shape).
6. Add `POST /api/cameras/:id/reload` → re-validates the JSON in place and hot-applies; `400` with the validation error if invalid.
7. Add `GET /api/health` → `{status: "ok", uptime, db: "ok", ftp: "listening"}` (used by later phases and monitoring).

**Acceptance criteria:**
- All 5 original endpoints return identical responses to phase 0 (compare `/api/videos?limit=5` output before/after, ignoring `last_video`-style additions).
- Editing `cameras.json` to add a camera + `POST /api/cameras/:id/reload` makes it appear in `GET /api/cameras` without restart.
- A deliberately broken `cameras.json` (bad JSON) → reload returns `400`; a broken file at boot → process exits with a clear message.
- `git tag phase-1`.

---

### Phase 2 — MQTT integration (replaces Home Assistant) (Windows)

**Goal:** the NVR speaks MQTT directly with yi-hack cameras: motion events in, control commands out.

Tasks:
1. `infra/mosquitto/mosquitto.conf`: minimal, listener 1883, **no** port published to the host in compose (internal network only).
2. `src/mqtt/topics.js`: topic map. Default suffixes (yi-hack convention `<mqtt_prefix>/<suffix>`): `motion` (in), `led` (out, payload `1`/`0`), `ircut` (out, `1`/`0`), `rec_mode` (out, `continuous`|`motion`|`off`), `power` (out, `1`/`0`). Suffixes must be overridable **per camera** in `cameras.json` (`"mqtt_suffixes": { ... }`) because yi-hack versions differ.
3. `src/mqtt/client.js`: connect to `MQTT_BROKER_URL`, subscribe to `<prefix>/motion` for every registered camera (re-subscribe on registry reload), auto-reconnect with exponential backoff, expose `publish(topic, payload)`. The MQTT module must **degrade gracefully**: if the broker is unreachable at boot, log a warning and keep the HTTP/FTP services alive (retry in background). This is essential for the Windows dev loop where no broker may be running.
4. `src/mqtt/commands.js`: `setLed(cameraId, bool)`, `setIrcut(cameraId, bool)`, `setRecMode(cameraId, mode)`, `setPower(cameraId, bool)`, `setGroupPower(cameraIds, bool)`.
5. REST wrappers in `routes/cameras.js`:
   - `POST /api/cameras/:id/led` `{"enabled": true}`
   - `POST /api/cameras/:id/night-vision` `{"enabled": true}`
   - `POST /api/cameras/:id/rec-mode` `{"mode": "motion"}`
   - `POST /api/cameras/:id/power` `{"enabled": false}`
   - `POST /api/cameras/group/power` `{"cameraIds": ["oficina"], "enabled": true}`
   - All return `{success: true, published: "<topic>", payload: ...}` or `404` unknown camera / `503` MQTT offline.
6. DB: new table `mqtt_events (id INTEGER PK, camera_id TEXT, event_type TEXT, payload TEXT, received_at TEXT)`.
7. Motion handler: on `<prefix>/motion` with truthy payload → insert row in `mqtt_events`. Emit an internal event (`process.emit`/EventEmitter) named `camera-motion` — phase 4 will subscribe to it for push. Do not couple push code into this phase.

**Acceptance criteria (Windows, no real camera):**
- With a local broker running (Docker Desktop `eclipse-mosquitto:2`, or an in-process `aedes` broker started by a small test script committed under `apps/api/scripts/`), publishing `mosquitto_pub -t oficina/motion -m 1` creates a row in `mqtt_events`.
- `POST /api/cameras/oficina/led {"enabled": true}` → the corresponding topic receives `1` (verify with `mosquitto_sub` or the aedes test script).
- `POST /api/cameras/oficina/rec-mode {"mode": "bogus"}` → `400`.
- Kill the broker → API still serves `/api/videos`; MQTT reconnects when the broker returns (log evidence).
- `[INTEG]` Mosquitto runs inside compose with no host-published port.
- `git tag phase-2`.

---

### Phase 3 — Live view: go2rtc + WebRTC (Windows dev, `[INTEG]` full check)

**Goal:** live camera feed in the browser, no plugins, via WebRTC through go2rtc, proxied by Express.

Tasks:
1. ~~`apps/api/scripts/generate-go2rtc-config.js`: reads `cameras.json`, writes `infra/go2rtc/go2rtc.yaml`~~ — **SUPERSEDED (D17, docs/ARCHITECTURE.md)**: the generator was deleted. It ran at API startup and overwrote the working `go2rtc.yaml` with `src:` syntax that go2rtc does not accept (a stream is a string or a list of sources; there is no `src:` key), and the real yaml carries go2rtc-specific knowledge (per-source `ffmpeg:` wrappers, derived alias streams) that does not derive from `cameras.json`. `go2rtc.yaml` is now **manual**: commit `go2rtc.yaml.example` as the template; the real `go2rtc.yaml` (like `cameras.json`) is gitignored — see root `.gitignore`. Stream names must match camera `id`s in `cameras.json`.
2. Compose: `go2rtc` service (`alexxit/go2rtc`), config volume `./infra/go2rtc:/config`. Its entrypoint must wait for `go2rtc.yaml` to exist (small shell loop) to avoid the startup race with `api`.
3. `routes/stream.js`:
    - `GET /api/cameras/:id/stream` → `{success, src: <id>, webrtc_url: "/stream-proxy/api/webrtc?src=<id>", mse_url: "/stream-proxy/api/stream.mp4?src=<id>"}` (WHEP primary, MSE/mp4 fallback).
    - `app.use('/stream-proxy', createProxyMiddleware({ target: GO2RTC_URL, changeOrigin: true }))` registered **before** the SPA fallback (no `ws: true` — WHEP is a plain HTTP POST).
4. Dev on Windows: go2rtc ships a Windows binary — for local dev, document in `docs/ARCHITECTURE.md` how to run it natively (`go2rtc.exe -config infra/go2rtc/go2rtc.yaml`) and point `GO2RTC_URL=http://127.0.0.1:1984`. If it cannot run in the dev environment, mark WebRTC playback `DEFERRED-TO-INTEGRATION`; the proxy + API endpoints must still be verified (proxy to a stub or to the native binary).

**Acceptance criteria:**
- `curl.exe http://localhost:3000/stream-proxy/api/streams` returns the go2rtc stream list (proxied).
- `GET /api/cameras/oficina/stream` returns the JSON above.
- `[INTEG]` Full compose: only port 3000 (api) + 2121/1024-1050 (FTP) published to the host; go2rtc and mosquitto unreachable from the host.
- `[INTEG]`/`[SBC]` Real WebRTC playback in a browser against a real camera (or an RTSP test source, e.g. `rtsp://w8ctm77fihhv2jnd.x.cache1.codelibrary.net/...` if the environment allows external test streams; otherwise `DEFERRED-TO-SBC`).
- `git tag phase-3`.

---

### Phase 4 — Web Push notifications (Windows)

**Goal:** real-time notifications (mobile, browser closed) on motion and on clip processing completion.

Tasks:
1. Generate VAPID keys (`npx web-push generate-vapid-keys`), document the command in `docs/ARCHITECTURE.md`. Keys go **only** in `.env` / `.env.example` placeholders. Never commit real keys.
2. DB: new table `push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, user_agent TEXT, created_at TEXT, last_used_at TEXT)`.
3. `src/push/webpush.js`:
   - `subscribe(sub)`, `unsubscribe(endpoint)`.
   - `notify({title, body, icon, url, data})` → fans out to all subscriptions; on HTTP 404/410 remove the subscription; never let one bad subscription break the fan-out.
   - If VAPID keys are not configured: `notify` is a no-op that logs at debug level (dev-friendly).
4. `routes/push.js`:
   - `GET /api/push/vapid-public-key`
   - `POST /api/push/subscribe` (standard PushSubscription JSON)
   - `POST /api/push/unsubscribe`
5. Triggers:
   - **Motion (immediate, light):** subscribe to the `camera-motion` event from phase 2 → `notify({title: "Movimiento", body: "<camera name>", url: "/cameras/<id>"})`. Target: < 2 s from MQTT event.
   - **Clip processed (enriched):** in the FTP pipeline, after `processVideo` + `insertVideo` succeed → `notify({title: "Nuevo clip", body: "<camera name>", icon: "<thumbnail_url>", url: "/videos/<id>"})`. No AI content — just camera, thumbnail, link.
6. Daily cleanup job (`setInterval`, aligned to `retention.js` cadence is fine): drop subscriptions not used in 6 months.

**Acceptance criteria:**
- `POST /api/push/subscribe` with a syntactically valid fake subscription → `201`, row in DB.
- Triggering `notify` with that fake subscription logs the expected `web-push` 4xx handling and removes the row (410 path) — proves fan-out + cleanup without a real device.
- Publishing a motion event via the phase-2 test harness → `notify` invoked within 2 s (log timestamps).
- Real device check `[SBC]`: Chrome/Android receives the push; tapping opens the PWA on the right route.
- No VAPID material in git (`git grep` check in the phase commit).
- `git tag phase-4`.

---

### Phase 5 — Angular PWA frontend (Windows)

**Goal:** mobile-first PWA that fully replaces the vanilla frontend, the MiHome app, and the HA panel.

Tasks:
1. `ng new frontend` inside `apps/frontend` (standalone components, SSR **disabled**, zoneless if stable, else default). Add PWA support (`@angular/pwa` / `ng add @angular/pwa` per current Angular docs). App name "yi-nvr", theme dark, `manifest.webmanifest` with icons (generate a simple set).
2. **Service worker strategy (decided, do not re-litigate):** Angular's `ngsw-worker.js` stays at scope `/` for asset caching. Push is handled by a **separate** minimal service worker served at `/push-sw.js` with scope `/push/` (a tiny static dir or an Express route serving it). The PWA registers both. Do NOT try to merge push into ngsw.
3. Angular services (`src/app/core/`):
   - `ApiService` (base URL `/api`, bearer token from `AuthService`, error normalization)
   - `CameraService`, `VideoService`, `TimelineService`
   - `PushService` (VAPID fetch, `PushManager.subscribe` with `applicationServerKey`, registers `/push-sw.js`, subscribe/unsubscribe calls)
    - `StreamService` (live view from `GET /api/cameras/:id/stream`; expose a reactive "playing/error" state; **primary = WebRTC via WHEP** — `POST` the raw offer SDP to `webrtc_url` (`Content-Type: application/sdp`), recvonly `addTransceiver`, wait for ICE gathering without trickle, play the answer SDP on a native `RTCPeerConnection`; **fallback = MSE** with the MediaSource API against `mse_url` (fetch + reader loop, SourceBuffer from the go2rtc `Content-Type`, segments mode, 5 s window with catch-up). No WebSocket, no HLS.js)
   - `AuthService` (stores the bearer token in `localStorage`; login page is a single field that sets the token — no user model, single-user system)
4. Routes/pages:
   - `/login` (token)
   - `/` **Dashboard**: grid of cameras (from `GET /api/cameras`): name, last thumbnail (latest video for that camera), recording status if known, power toggle per camera + "all" group toggle.
   - `/cameras/:id` **Camera detail**: control switches (LED, night vision, rec mode segmented control) calling phase-2 endpoints; "Ver en directo" button mounting the WebRTC player; "Grabaciones" link filtered by camera.
   - `/videos` **Gallery**: replaces the vanilla gallery — cards with animated WebP preview, camera, date, duration, size; filters (camera, date range); pagination; delete with confirm; click → player modal (HTML5 `<video>` with `original_url`).
   - `/timeline` **Timeline**: date-grouped bars with per-camera counts (reuses `/api/timeline`), tap a day → gallery filtered to that day.
   - `/settings` **Settings**: enable/disable notifications (PushService), show VAPID status, storage/retention info if exposed.
5. `ng serve` dev proxy: `proxy.conf.json` → `http://localhost:3000`.
6. Budgets in `angular.json`: raise initial budget to 1.5 MB if needed; keep warnings at zero.

**Acceptance criteria:**
- `npm run build` in `apps/frontend` succeeds with no errors.
- With the phase-1+ backend running on Windows: every page works against the real API (no mocks): gallery shows the ~90 real clips with working previews and player; timeline renders; camera detail controls send MQTT commands (verify with the phase-2 harness); login/token flow enforced.
- Push subscription flow: on a real Chrome/Android device (or desktop Chrome with a test VAPID) `POST /api/push/subscribe` is received by the backend.
- `git tag phase-5`.

---

### Phase 6 — Docker packaging (build anywhere, verify `[INTEG]`)

**Goal:** one compose file, one public HTTP port (3000) + FTP ports, no nginx.

Tasks:
1. `apps/api/Dockerfile` (multi-stage):
   ```dockerfile
   FROM node:20-bookworm-slim AS frontend-build
   WORKDIR /frontend
   COPY apps/frontend/package*.json ./
   RUN npm ci
   COPY apps/frontend .
   RUN npm run build
   # NOTE: verify the actual Angular output path (dist/<name>/browser for esbuild builder) and adjust

   FROM node:20-bookworm-slim
   WORKDIR /app
   # ffmpeg is MANDATORY (thumbnail/preview pipeline) + toolchain as fallback for better-sqlite3
   RUN apt-get update && apt-get install -y --no-install-recommends \
         ffmpeg python3 make g++ \
       && rm -rf /var/lib/apt/lists/*
   COPY apps/api/package*.json ./
   RUN npm ci --omit=dev
   COPY apps/api .
   COPY --from=frontend-build /frontend/dist/<name>/browser ./public
   ENV STORAGE_DIR=/app/storage
   EXPOSE 3000 2121
   CMD ["node", "src/server.js"]
   ```
   Build context is the **repo root** (it needs `apps/frontend`).
2. `docker-compose.yml` (repo root):
   ```yaml
   services:
     api:
       build:
         context: .
         dockerfile: apps/api/Dockerfile
       ports:
         - "3000:3000"
         - "2121:2121"
         - "1024-1050:1024-1050"   # FTP passive
       volumes:
         - ./storage:/app/storage
         - ./infra/go2rtc:/go2rtc-cfg
       environment:
         - STORAGE_DIR=/app/storage
         - MQTT_BROKER_URL=mqtt://mosquitto:1883
         - GO2RTC_URL=http://go2rtc:1984
         - VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
         - VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
         - API_AUTH_TOKEN=${API_AUTH_TOKEN}
         - RETENTION_DAYS=${RETENTION_DAYS:-30}
         - STORAGE_MAX_GB=${STORAGE_MAX_GB:-10}
       depends_on: [mosquitto, go2rtc]
       restart: unless-stopped

     mosquitto:
       image: eclipse-mosquitto:2
       volumes:
         - ./infra/mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf
       restart: unless-stopped

     go2rtc:
       image: alexxit/go2rtc:latest
       volumes:
         - ./infra/go2rtc:/config
       restart: unless-stopped
   ```
    - ~~`api` must generate `go2rtc.yaml` into the shared `./infra/go2rtc` volume at startup~~ — **SUPERSEDED (D17)**: `go2rtc.yaml` is manual; `api` no longer mounts `./infra/go2rtc` nor sets `GO2RTC_CONFIG_PATH`. The `go2rtc` service still waits for the (user-provided) `go2rtc.yaml` to exist.
   - mosquitto and go2rtc publish **no** host ports.
3. `server.js`:
   - Serve `apps/api/public` (the Angular build in Docker; in dev this dir is absent → static middleware just 404s, fine).
   - SPA fallback as **middleware** (Express 5-safe), registered after all API/static/proxy routes:
     ```js
     app.use((req, res, next) => {
       if (req.method !== 'GET' || req.headers['accept']?.includes('application/json')) return next();
       if (req.path.startsWith('/api/') || req.path.startsWith('/stream-proxy/') ||
           req.path.startsWith('/videos/') || req.path.startsWith('/processed/')) return next();
       const idx = path.join(PUBLIC_DIR, 'index.html');
       if (fs.existsSync(idx)) return res.sendFile(idx, { headers: { 'Cache-Control': 'no-cache' } });
       next();
     });
     ```
   - Optional HTTPS: if `HTTPS_CERT_PATH` + `HTTPS_KEY_PATH` are set and the files exist → `https.createServer`; else plain HTTP. If push is enabled (VAPID set) but no HTTPS, log a loud warning at boot.
4. `[INTEG]` On the Debian amd64 machine: `docker compose build && docker compose up -d`, run `scripts/integration-check.sh` (create it in this phase): health endpoint, `/api/videos` with a test clip, thumbnail generation **inside the container** (proves ffmpeg works), `/stream-proxy/api/streams`, SPA index served at `/`, SPA deep-link `/cameras/oficina` returns `index.html`, no host ports beyond 3000/2121/1024-1050 (`ss -ltn`).

**Acceptance criteria:**
- `[INTEG]` Clean `docker compose up` from a fresh clone + `.env` on Debian amd64; all checks in `integration-check.sh` pass.
- `[INTEG]` A test `.mp4` dropped into the container's FTP root (or uploaded via an FTP client) is processed: thumbnail + webp appear in `processed/`, row in DB, served over HTTP.
- `git tag phase-6`.

---

### Phase 7 — Security hardening + retention (Windows + `[INTEG]` re-check)

**Goal:** defense in depth behind the VPN + bounded disk growth.

Tasks:
1. **Auth middleware** (in `server.js`, before routes): if `API_AUTH_TOKEN` is set, every `GET/POST/DELETE /api/*` except `/api/health` requires `Authorization: Bearer <token>` → else `401`. Static assets, `/videos`, `/processed`, `/stream-proxy` stay open (they are media; the API is the control plane). Document the trade-off.
2. **Rate limiting**: `express-rate-limit` on the MQTT command routes and `/api/push/*` (e.g. 30 req/min/IP).
3. **HTTPS boot** already in place from phase 6 — verify the warning path (VAPID set, no certs → warning, not crash).
4. **`src/retention.js`** (new — this was missing from the original plan):
   - Daily job (random 0–30 min offset after boot, then every 24 h):
     1. **Age policy:** delete clips with `timestamp < now - RETENTION_DAYS` (files: original + thumbnail + preview; then DB rows).
     2. **Capacity policy:** while `du(storage/ftp) + du(storage/processed) > STORAGE_MAX_GB`, delete oldest clips first (same atomic per-clip removal).
   - Per-clip removal is a small function reused by `DELETE /api/videos/:id` (DRY): unlink files (ignore ENOENT) + delete row, in a DB transaction where possible.
   - Log every purge: `count`, `bytesFreed`, `reason: age|capacity`.
   - Env: `RETENTION_DAYS=30`, `STORAGE_MAX_GB=10`, `RETENTION_ENABLED=true` (settable false for tests).
5. Expose `GET /api/storage` (auth-protected): `{clips, bytesUsed, retentionDays, maxGb, lastPurge}` — surfaced in PWA settings (small addition to phase-5 page; keep it optional if it blocks the phase).

**Acceptance criteria:**
- Without token (with `API_AUTH_TOKEN` set): `GET /api/videos` → `401`; with token → `200`. `/` and `/videos/...` still `200` without token.
- 31 rapid calls to a command route → at least one `429`.
- Retention test (Windows, `RETENTION_ENABLED=true`, tiny thresholds): insert 3 fake clips with old timestamps + fake files → force-run the purge function → files and rows gone, log line present. Capacity path: set `STORAGE_MAX_GB` below current usage → oldest removed first.
- `[INTEG]` Re-run `integration-check.sh` with auth enabled.
- `git tag phase-7`.

---

### Phase 8 — Integration on Debian amd64 (`[INTEG]`)

**Goal:** prove the whole system from a clean machine, the way it will be deployed.

Tasks:
1. On a clean Debian amd64 (VM or the real integration box): install Docker Engine + Compose v2, clone the repo at tag `phase-7`, `cp .env.example .env`, fill VAPID + token, `docker compose up -d`.
2. Run `scripts/integration-check.sh` end-to-end (extend it if phase 6 left gaps): API, FTP upload → processed artifacts, MQTT motion → `mqtt_events` (via a temporary `mosquitto_pub` from the host using `docker compose exec`), push subscribe, proxy, SPA deep links, auth 401s, retention dry-run.
3. Soak: leave the stack running **24 h** with periodic synthetic traffic (a small script that uploads a test clip every 10 min and publishes a motion event). Record `docker stats --no-stream` snapshots; no OOM, no unbounded memory growth in the api container, WAL files not growing unbounded (run `PRAGMA wal_checkpoint(TRUNCATE)` check or observe sizes).
4. Write `docs/API.md` (all endpoints, request/response examples, auth) and finalize `docs/ARCHITECTURE.md` (decisions log, environment matrix, how to add a camera, how to change yi-hack topic suffixes).
5. Write the root `README.md`: prerequisites, quickstart (dev + Docker), `.env` reference, adding a camera (cameras.json + yi-hack side config: FTP target, MQTT broker), generating VAPID keys, backup procedure (copy `storage/surveillance.db*` + `cameras.json`; `sqlite3 .backup` recommended), troubleshooting (ffmpeg missing, ports, WebRTC behind VPN).

**Acceptance criteria:**
- Clean install following **only** the README succeeds on Debian amd64.
- 24 h soak passes (no OOM, stable RSS, clips processed, no error spam in logs).
- `docs/API.md` covers 100% of implemented endpoints.
- `git tag phase-8`.

---

### Phase 9 — Production deployment on ARM SBC (`[SBC]`)

**Goal:** repeatable deployment on the final hardware, with a documented escape hatch.

Tasks:
1. **Hardware profiles** in `docs/ARCHITECTURE.md` (hardware is TBC — support both):
   - `linux/arm/v7` (e.g. Orange Pi Zero, Allwinner H2, 512 MB RAM): **light mode** — `go2rtc` service disabled by default (live view off or pointed at a remote go2rtc via `GO2RTC_URL`), retention tuned down, document measured RAM budget per service.
   - `linux/arm64` (e.g. Orange Pi Zero 3 or similar): full stack.
   - Compose: use `platform:` from an env var `TARGET_PLATFORM` (default `linux/arm64`); on the v7 profile set it to `linux/arm/v7`.
2. **ARM image builds:** from the Debian amd64 box, `docker buildx build --platform linux/arm/v7 -f apps/api/Dockerfile . -t nvr-api:armv7 --load` (QEMU — slow but correct; `better-sqlite3` must compile for the target, which is why the toolchain is in the Dockerfile). Alternative documented path: build on-device. **Never** transfer `node_modules` between architectures.
3. **systemd plan B** (for 512 MB boxes where the Docker daemon is too heavy): `deploy/systemd/yi-nvr-api.service` (+ optional `go2rtc.service`, mosquitto via package) running `node src/server.js` with the same env file. Document when to choose it.
4. **Tailscale HTTPS:** `tailscale cert` → set `HTTPS_CERT_PATH`/`HTTPS_KEY_PATH`; verify push works end-to-end from the phone over the tailnet (Web Push requires a secure context).
5. **Backup:** `scripts/backup.sh` — `sqlite3 storage/surveillance.db ".backup ..."` + copy `cameras.json`, `rsync`/`scp` to an external destination, cron entry. Test restore once.
6. Final runbook in `README.md` section "Deployment": from bare SBC OS to running stack, < 30 min, no implicit steps.

**Acceptance criteria:**
- On the target SBC: stack (full or light profile) up, all phase-8 checks pass over the tailnet.
- 24 h stable with 3–5 real cameras (clips arriving, thumbnails generated, push received on the phone, live view working on the arm64 profile).
- `docker stats` (or `ps` for systemd) shows no OOM and headroom; documented numbers in `docs/ARCHITECTURE.md`.
- Restore-from-backup tested.
- `git tag phase-9` (final).

---

## 7. `.env.example` (complete)

```ini
# HTTP
PORT=3000
HOST=0.0.0.0
HTTPS_CERT_PATH=
HTTPS_KEY_PATH=

# FTP (keep 2121 — do NOT use port 21, it needs root/capabilities)
FTP_PORT=2121
FTP_HOST=0.0.0.0
FTP_USER=camera
FTP_PASS=surveillance123

# Storage
STORAGE_DIR=

# MQTT
MQTT_BROKER_URL=mqtt://mosquitto:1883

# go2rtc
GO2RTC_URL=http://go2rtc:1984

# Web Push (generate: npx web-push generate-vapid-keys — NEVER commit real keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_CONTACT_EMAIL=mailto:you@example.com

# Auth (empty = auth disabled, dev only)
API_AUTH_TOKEN=

# Retention
RETENTION_ENABLED=true
RETENTION_DAYS=30
STORAGE_MAX_GB=10
```

## 8. Definition of done (project level)

- All phases tagged, all acceptance criteria passed or explicitly deferred with a note.
- `README.md` lets a stranger deploy on Debian amd64 and on the SBC without asking questions.
- No secrets in git. No nginx. One HTTP port. Existing ~90 clips still browsable in the new PWA.
- The vanilla frontend is deleted (not left around).

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 512 MB SBC cannot run full stack | Light mode (no local go2rtc), systemd plan B, measured budgets documented in phase 9 |
| yi-hack MQTT suffixes vary by firmware | Per-camera `mqtt_suffixes` override in `cameras.json`; defaults in `mqtt/topics.js` |
| `better-sqlite3` native build on ARM | Toolchain in Dockerfile; build with buildx for the target platform |
| WebRTC fails across VPN (no STUN) | go2rtc host candidates work on LAN/tailnet; documented MSE fallback message; `[SBC]` verification |
| ffmpeg missing in container (original plan bug) | Explicit `apt-get install ffmpeg` in Dockerfile + container-level test in phase 6 |
| Unbounded disk growth (original plan gap) | Dual retention policy (age + capacity), phase 7 |
| Windows↔Linux path/line-ending bugs | `.gitattributes eol=lf`, `path.join` only, no hardcoded separators, cross-check in `[INTEG]` |
| go2rtc/api startup race over shared config | go2rtc entrypoint waits for `go2rtc.yaml` (manual file, D17 — no longer generated by api) |

## 10. Cross-platform pitfalls (Windows dev → Linux prod)

- Use `path.join` / `path.resolve` everywhere. Never string-concatenate paths. Never assume `/`.
- LF line endings in the repo (`.gitattributes`). Windows editors must not rewrite to CRLF on save for committed files.
- `nice` does not exist on Windows — `processor.js` already guards it; keep the guard.
- ffmpeg on the dev machine must be on PATH; in containers it is installed by the Dockerfile.
- `curl` in PowerShell is an alias to `Invoke-WebRequest` — always use `curl.exe`.
- File locking: Windows may hold handles briefly after deletes; the FTP pipeline's 2 s settle + chokidar `awaitWriteFinish` already cope. Do not "fix" these timings without reason.
- `node_modules` is per-OS/per-arch: never copy it between environments; always `npm ci` at the destination (Docker does this).
- Ports: 2121 + 1024–1050 are fine on both OSes; check for local conflicts on Windows (Hyper-V/WSL2 can reserve ranges — if 1024–1050 collide in dev, override `FTP_PASSIVE_RANGE` via env; add this env var to `ftp.js` in phase 0 if you touch the file anyway).

## 11. Explicitly OUT of scope

- AI/ML clip analysis (removed from the plan; may be a future project).
- Multi-user accounts, roles, per-device tokens.
- Two-way audio, PTZ, camera firmware management.
- CI/CD pipelines (verification is via the per-phase scripts + `[INTEG]`/`[SBC]` checklists).
- Mobile native apps (the PWA + Web Push is the mobile story).
