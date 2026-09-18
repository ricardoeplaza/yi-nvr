# yi-nvr API — Backend service

The **API** is the brain of the self-hosted NVR ecosystem for [yi-hack](https://github.com/roleoroleo/yi-hack-Allwinner-v2) cameras. It runs as a **single Node.js 26 / Express 5 process** that hosts four things at once:

1. A **REST API** (`/api/*`) — the data contract for the whole system.
2. The static **Angular PWA** frontend (built into `src/public`).
3. An embedded **FTP server** (`ftp-srv`) for receiving camera clips.
4. A **go2rtc stream proxy** (`/stream-proxy/*`) for live WebRTC/MSE view.

On top of those it also runs an **MQTT client** (degrades gracefully when the broker is down) and a **Web Push** module. The entry point is [`src/server.js`](src/server.js).

This service is the "brain": cameras push motion clips to it over FTP, it processes and indexes them in SQLite, and it serves everything back through the REST API that the Angular frontend consumes. Cameras also talk to it over MQTT for the control plane (motion events in; LED, IR-cut, record mode, power out).

---

## Table of contents

- [Overview / role](#overview--role)
- [Architecture](#architecture)
- [Data flow](#data-flow)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Modules](#modules)
- [REST API](#rest-api)
- [Storage & directories](#storage--directories)
- [Deployment](#deployment)
- [Dev tools / testing](#dev-tools--testing)
- [Status / roadmap](#status--roadmap)

---

## Overview / role

The ecosystem is split between two apps:

| App | Role |
|---|---|
| `apps/api` (this service) | The **backend brain**: receives camera data via FTP/MQTT, processes motion clips with ffmpeg, indexes them in SQLite, and serves the REST API + static PWA. Also hosts the FTP receiver and the go2rtc live-view proxy. |
| `apps/frontend` | The **Angular 22 PWA** (dashboard, camera controls, clip gallery, timeline). It is a client-only app that talks to this service over HTTP. |

The API is deliberately a **single process**. There is no separate web server, nginx, or reverse proxy in front of it — Express serves the API, the static build, and the go2rtc proxy from one port (3000), while `ftp-srv` listens on port 21 inside the same process. Sidecars (`mosquitto`, `go2rtc`) run alongside via Docker Compose but are optional: the HTTP/FTP/PWA stack works even if the MQTT broker or go2rtc is absent.

---

## Architecture

The whole system is one Node.js process with a small set of cooperating modules. The data plane (clips) and the control plane (MQTT) are independent, so a failure in one never takes down the other.

```
                         ┌───────────────────────────────────────────┐
   Camera  ──FTP (.mp4)─▶│  apps/api (Node.js 26 / Express 5)         │
                         │                                             │
                         │  ┌──────────────┐   chokidar watches        │
                         │  │ ftp-srv :21  │◀──────── INCOMING_DIR     │
                         │  └──────┬───────┘                            │
                         │         │ new .mp4 detected                  │
                         │         ▼                                    │
                         │  ┌──────────────┐   ffmpeg (thumbnail +     │
                         │  │ processor.js │◀──────── animated WebP)   │
                         │  └──────┬───────┘                            │
                         │         │ insertVideo()                      │
                         │         ▼                                    │
                         │  ┌───────────────────────┐  GET /api/videos │
                         │  │ database.js (SQLite)   │◀─────────────────┤
                         │  │  WAL mode              │  POST /api/...   │
                         │  └──────────┬────────────┘                   │
                         │             │                                │
        REST API ◀────────┘            │  GET /videos, /processed/*     │
        (Angular PWA)                  │  express.static → RECORDINGS_DIR
                         │             │                                │
   Browser ──WebRTC/MSE──│  /stream-proxy/* ──► go2rtc sidecar (:1984)  │
   live view             │         (502 JSON if go2rtc absent)          │
                         │                                             │
   Camera ◀──MQTT───────│  mqtt/client.js ──► mosquitto broker          │
   control plane         │     (birth/will, motion, stat/camera/+)      │
                         │         reconnects w/ exponential backoff    │
                         │                                             │
                         │  push/webpush.js ◀── VAPID keys (.env)       │
                         └───────────────────────────────────────────┘
```

### Key design points

- **One process, many concerns.** Express serves the API and static PWA; `ftp-srv` + a `chokidar` watcher handle clip ingestion; `http-proxy-middleware` proxies `/stream-proxy/*` to go2rtc; the MQTT client and Web Push job run as background tasks.
- **Static + SPA fallback.** The Angular build is served from `PUBLIC_DIR` (`src/public` by default). Any `GET` that doesn't match an API/static/stream path falls through to `index.html`, so deep links (`/cameras/oficina`, `/videos`, …) resolve client-side. If there is no built frontend (dev without `npm run build:web`), the fallback returns 404 instead of serving a broken shell.
- **go2rtc proxy degrades gracefully.** `/stream-proxy/*` proxies to `GO2RTC_URL`. In dev go2rtc usually isn't running, so requests return a JSON `502 {"success":false,"error":"go2rtc unreachable"}` and the process keeps running — no crash.
- **MQTT is best-effort.** If `MQTT_BROKER_URL` is empty or the broker is unreachable, the client logs a warning and keeps retrying in the background with exponential backoff (1 s → 2 s → … up to 60 s). HTTP/FTP/PWA keep working.
- **SQLite in WAL mode.** `better-sqlite3` runs synchronously in `WAL` mode for fast concurrent writes on ARM SBCs. The DB lives outside the source tree (`data/surveillance.db`).

---

## Data flow

### Clip pipeline (FTP → SQLite → served)

```
Camera ──FTP upload──▶ incoming/ (staging, ONLY dir chokidar watches)
                          │  new .mp4 detected
                          ▼
                  processor.js (ffmpeg)
                     ├─ thumbnail JPG
                     └─ animated WebP preview
                          │
                  rename to <timestamp>_<camera>.mp4
                          │
                          ▼
                  recordings/ (served at /videos)
                          │  insertVideo()
                          ▼
                  data/surveillance.db (SQLite, WAL)
                          │
   GET /api/videos ───────┘
        ▲
        │ Angular PWA
```

1. A camera flashes with motion and uploads a short `.mp4` clip over FTP to `incoming/`. The filename encodes only minute:second:frame in base-8 (no date/time), so clips from different hours can collide — the **real** recording time is read from the MP4's `creation_time` metadata via `ffprobe`.
2. `processor.js` generates a **thumbnail JPG** (frame at 50% of duration) and an **animated WebP preview** (~4 s at 6 fps, palette-based). ffmpeg runs with low priority (`nice`) to avoid saturating the SBC; a FIFO queue (`queue.js`) caps concurrent ffmpeg processes so a backlog of late clips can't OOM the box.
3. The clip is renamed to `<timestamp>_<camera>.mp4` and moved out of staging into `recordings/`. A **0-byte placeholder** is written back to the original path so the camera doesn't re-upload it.
4. Metadata is inserted into SQLite (`insertVideo`). Processed media (thumbnails, previews) are served from `/processed/*`; original clips from `/videos/*`.
5. Optionally, each processed clip is mirrored to a remote location for 3-2-1 backup (`remote-mirror.js`, non-fatal with retries).

### MQTT control plane

`mqtt/client.js` subscribes (QoS 1) to each camera's input topics (`birth_will`, `motion`, `motion_files`, `sound_detection`, and feedback `stat/camera/+`). It normalizes events, persists them to the `mqtt_events` table, and emits internal bus events:

- `camera-motion` — for motion/IA detections (drives Web Push).
- `camera-online` — on an offline→online transition (e.g. after a reboot), which invalidates the camera's probe cache.

The MQTT client is **not** coupled to push; it only emits events. The push decision logic lives in `server.js` and `push/webpush.js`.

### WebRTC live view

`GET /api/cameras/:id/stream` returns relative stream URLs (`/stream-proxy/api/webrtc?src=…`, `/stream-proxy/api/stream.mp4?src=…`). The browser always talks to port 3000; go2rtc stays hidden behind the proxy. If go2rtc is down, the proxy returns `502`.

---

## Getting started

### Prerequisites

- **Node.js 20+** (the project targets Node 26 in Docker; dev can run on Node 20+).
- **ffmpeg / ffprobe on your `PATH`** — required for video processing. On Debian/Ubuntu: `sudo apt-get install ffmpeg`. You can also point at a specific binary with `FFMPEG_PATH` (ffprobe is derived from it automatically).

### Install & run

```bash
cd apps/api
npm install
npm start          # production mode
# or
npm run dev        # same entry point; handy under watch-mode edits
```

The service listens on:

| Port | Purpose |
|---|---|
| **3000** | HTTP REST API + static Angular PWA + processed media (`/processed/*`) + go2rtc stream proxy (`/stream-proxy/*`). `HOST` defaults to `0.0.0.0`. |
| **21** | FTP server for camera uploads (passive range 1024–1050 by default; see [Configuration](#configuration)). Port 21 is privileged, so the bind requires admin/root or `CAP_NET_BIND_SERVICE`. |

> **Windows:** run the API as an administrator to bind port 21. On Linux you can either run as root, or grant the capability (`setcap "cap_net_bind_service=+ep" $(which node)`), or use a non-privileged port via `FTP_PORT` and patch `ftppush.sh` on the camera's SD card.

### Running modes

There are two ways to run this service locally, depending on whether you're iterating on the UI or running the full stack.

**Production local (default).** Build the frontend once, then start the API — the API serves the built PWA as static files:

```bash
cd apps/frontend && npm install && npm run build:web   # build the PWA first
cd apps/api && npm install && npm start                # API serves it on :3000
```

If you start the API **before** building the frontend, `http://localhost:3000` returns a 404 — the static files don't exist yet. Build first.

**Development.** Run the API and the Angular dev server together. The dev server (`ng serve`, on `http://localhost:4200`) proxies API/media routes to the API, so you can edit UI code without rebuilding:

```bash
# Terminal 1 — the API (serves /api/* and the static build)
cd apps/api && npm install && npm start

# Terminal 2 — the Angular dev server (hot-reloads the UI)
cd apps/frontend && npm install && npm start   # ng serve → http://localhost:4200
```

The dev server's proxy (`apps/frontend/proxy.conf.json`) forwards `/api`, `/videos`, `/processed`, `/stream-proxy`, and `/push` to `http://localhost:3000`. Edit UI files and see changes at `http://localhost:4200`; the API keeps running on `3000`.

---

### First boot checklist

1. Copy the environment template: `cp ../../.env.example ../../.env`.
2. Configure `.env`: at minimum set `NVR_PUBLIC_IP`, `API_AUTH_TOKEN` (in production), and the VAPID keys for push.
3. Add your cameras to `infra/cameras.json` (gitignored; copy `infra/cameras.json.example`).
4. Open **http://localhost:3000** — you'll see the dashboard (after building the frontend once, see below).

### Building the frontend

The mobile dashboard is served from the same port but only after the Angular PWA is built once into `apps/api/src/public`:

```bash
cd apps/frontend && npm install && npm run build:web
```

The API keeps serving on port 3000 (and FTP on 21) regardless of whether the frontend is built.

---

## Configuration

Configuration lives in a `.env` file at the repo root (`.env.example` is the template). Storage paths are the single source of truth in [`src/paths.js`](src/paths.js); every module resolves its directories through it rather than re-deriving them.

| Variable | Default | Used by | Purpose |
|---|---|---|---|
| `PORT` | `3000` | `server.js` | HTTP API + PWA listen port. |
| `HOST` | `0.0.0.0` | `server.js` | Bind address for the HTTP server. |
| `FTP_PORT` | `21` | `ftp.js` | FTP server port. Privileged (< 1024) → needs root/admin. |
| `FTP_HOST` | `0.0.0.0` | `ftp.js` | FTP bind address. |
| `FTP_USER` | `camera` | `ftp.js` | FTP login username for cameras. |
| `FTP_PASS` | `surveillance123` | `ftp.js` | FTP login password for cameras. |
| `FTP_PASSIVE_RANGE` | `1024-1050` | `ftp.js` | Passive data port range (override if Windows/Hyper-V reserves 1024–1050). Docker uses `1024-1027`. |
| `MQTT_BROKER_URL` | *(empty)* | `server.js`, `mqtt/client.js` | Broker URL (`mqtt://host:1883`). Empty → MQTT client disabled. |
| `GO2RTC_URL` | `http://go2rtc:1984` | `server.js` | go2rtc sidecar URL for the stream proxy. |
| `VAPID_PUBLIC_KEY` | *(empty)* | `push/webpush.js` | Web Push public key (generate with `npx web-push generate-vapid-keys`). |
| `VAPID_PRIVATE_KEY` | *(empty)* | `push/webpush.js` | Web Push private key. Without these, push runs in noop mode. |
| `VAPID_CONTACT_EMAIL` | `mailto:you@example.com` | `push/webpush.js` | VAPID subject email. |
| `API_AUTH_TOKEN` | *(empty)* | `.env.example` only | **Declared in `.env.example` but not yet read by the current source.** Do not leave empty in production. |
| `DATA_DIR` | `<repo>/data` | `paths.js`, `database.js`, `processor.js` | SQLite DB + processed media (`data/processed`). |
| `INCOMING_DIR` | `<repo>/incoming` | `paths.js`, `ftp.js` | FTP staging; the **only** directory chokidar watches. Can be tmpfs. |
| `RECORDINGS_DIR` | `<repo>/recordings` | `paths.js`, `server.js`, `ftp.js` | Processed clips served at `/videos`. |
| `REMOTE_RECORDINGS_DIR` | `<repo>/remote_recordings` | `paths.js`, `remote-mirror.js` | Fixed remote-mirror directory (3-2-1 backup). The NFS/rclone mount is mapped onto it by a compose volume, not here. |
| `REMOTE_MIRROR` | *(empty)* | `paths.js`, `remote-mirror.js` | `1`/`true` enables copying every processed clip to the remote mirror (non-fatal with retries). |
| `CAMERAS_JSON_PATH` | `<repo>/infra/cameras.json` | `paths.js`, `camera-registry.js` | Camera registry (gitignored; template in `infra/cameras.json.example`). |
| `FFMPEG_PATH` | `ffmpeg` | `ftp.js`, `processor.js` | Path to the ffmpeg binary. ffprobe is derived from it (`<path>` → `ffprobe`). |
| `FFMPEG_CONCURRENCY` | `1` | `processor.js` | Max concurrent ffmpeg processes (1 = safe for low-RAM SBCs). |
| `FFMPEG_THREADS` | `2` | `processor.js` | Threads per ffmpeg process. |
| `PREVIEW_SECONDS` | `4` | `processor.js` | Animated WebP preview duration. |
| `PREVIEW_FPS` | `6` | `processor.js` | Animated WebP preview frame rate (4 s × 6 fps = 24 frames). |
| `REMOVE_LOWRES_TRACK` | *(empty → on)* | `ftp.js` | Stream-copy remove the low-res 640×360 track (~26% storage savings). Set to `false` to keep it. |
| `NVR_PUBLIC_IP` | *(auto-detected)* | `ftp.js` | LAN IP of the NVR as seen by cameras (FTP host advertised to cameras). Override if multi-homed/NAT'd. |
| `CAMERA_STATUS_CACHE_TTL_MS` | `30000` | `camera-status-service.js`, adapter | TTL of the in-memory probe cache for yi-hack CGI probes (0 disables it). |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | *(empty)* | `mqtt/client.js` | Optional broker credentials. |
| `HTTPS_CERT_PATH` / `HTTPS_KEY_PATH` | *(empty)* | `server.js` | Optional TLS certs (e.g. a Tailscale cert). Web Push needs a secure context, so HTTPS is required for push to work. |

> **Note on `API_AUTH_TOKEN`:** it is documented in `.env.example` as REQUIRED but is not currently referenced by any source file. Treat it as reserved until the auth layer is wired up.

---

## Modules

All modules live under [`src/`](src). Here is each one and its responsibility:

| Module | Responsibility |
|---|---|
| `server.js` | **Bootstrap.** Loads the camera registry first (exits if `cameras.json` is invalid), builds the Express app, mounts static/PWA, `/processed`, `/videos`, the go2rtc proxy (`/stream-proxy/*`) and all routers, registers the SPA fallback, starts FTP + HTTP + MQTT, and prints the endpoint list. Also handles graceful shutdown (SIGTERM/SIGINT). |
| `ftp.js` | **FTP receiver.** Creates the `ftp-srv` server (port 21, passive mode, username/password auth, root = `INCOMING_DIR`). Uses `chokidar` to watch `INCOMING_DIR` for new `.mp4` files. On detection it waits for the upload to finish, reads the real time from MP4 metadata (`ffprobe`), renames the clip into `RECORDINGS_DIR`, writes a 0-byte placeholder so the camera doesn't re-upload, runs ffmpeg processing, inserts the record, sends a "new clip" push notification, and mirrors to remote. Also resolves the NVR's LAN IP and derives the FTP config pushed to cameras. |
| `processor.js` | **Video processing.** Extracts a thumbnail JPG (frame at 50% of duration) and an animated palette-based WebP preview (~4 s @ 6 fps). Runs ffmpeg with low priority (`nice` on Linux; plain `ffmpeg` on Windows) via a bounded FIFO queue (`queue.js`) so a backlog can't OOM the SBC. |
| `database.js` | **SQLite layer.** `better-sqlite3` in WAL mode. Schema: `videos`, `mqtt_events`, `push_subscriptions`, `camera_settings`. CRUD for videos (filters, favorites, bulk ops, purge), MQTT event persistence, Web Push subscription management, and per-camera settings. Exports the shared `db` instance. |
| `paths.js` | **Single source of truth for storage paths.** Centralizes `DATA_DIR`, `INCOMING_DIR`, `RECORDINGS_DIR`, `REMOTE_RECORDINGS_DIR`, `REMOTE_MIRROR`, `PUBLIC_DIR`, `CAMERAS_JSON_PATH` (all env-overridable). Dev defaults live at the repo root; Docker overrides them via `/app/…`. |
| `camera-registry.js` | **Camera registry.** Loads, validates (pure function), and serves `infra/cameras.json` in memory. Two ecosystems: `yi-hack` (full HTTP/MQTT control) and `generic` (FTP-only; the safe default). Provides lookup by id, ftp_dir, mqtt_prefix, and ecosystem. |
| `camera-status-service.js` | **Unified camera status.** Composes a single status contract per camera from three sources: the adapter's HTTP probes (`yi-hack`), the in-memory MQTT registry (online/offline + command feedback), and SQLite NVR data. Shared by `/cameras/:id/status` and the `status` field of `/cameras`. |
| `queue.js` | **Bounded FIFO queue.** Dependency-free concurrency limiter so only N ffmpeg processes run at once (`FFMPEG_CONCURRENCY`, default 1). Exposes `add`, `size`, `running`, and `drain`. |
| `remote-mirror.js` | **3-2-1 backup.** Copies each processed clip to `REMOTE_RECORDINGS_DIR` (non-fatal: 3 attempts with exponential backoff, then logs and moves on). No-op when `REMOTE_MIRROR` is off. |
| `push/webpush.js` | **Web Push.** Manages subscriptions (`push_subscriptions` table) and fan-out notifications via `web-push` + VAPID. Fail-safe: noop without VAPID keys, per-subscription errors never break the batch, expired (404/410) subscriptions are purged. Runs a daily cleanup job (24 h interval, random 0–30 min offset). |
| `camera/index.js` | **Adapter factory + route helper.** Returns the adapter for a camera's ecosystem (`yi-hack` → `adapters/yi-hack`, else null) and `resolveCameraFor`, which resolves a camera by id and self-answers 404/409/400 errors for routes. |
| `camera/adapters/yi-hack.js` | **yi-hack HTTP adapter.** The only public HTTP API to yi-hack cameras. Probes (`status.json`, `get_configs.sh?conf=camera|system`) with a per-camera cache (TTL + single-flight), reads/writes configs, controls the camera (LED, IR-cut, power, record mode, generic whitelisted commands), manages SD event dirs/files, and reboots. Invalidates its own probe cache on mutations. |
| `mqtt/client.js` | **MQTT client.** Connects to `MQTT_BROKER_URL`, subscribes QoS 1 to each camera's input topics, normalizes events, persists them, and emits the internal bus (`camera-motion`, `camera-online`). Graceful degradation: retries with exponential backoff if the broker is down; HTTP/FTP/PWA keep running. |
| `mqtt/topics.js` | **MQTT topic/message resolution.** Defines yi-hack defaults for topics (`birth_will`, `motion`, …) and payloads, applies per-camera overrides from `cameras.json`, and normalizes received messages to event types. |
| `routes/videos.js` | Video CRUD: list with filters, detail, rename, favorite, bulk delete/favorite, purge by retention, delete (removes physical files). |
| `routes/cameras.js` | Fast camera listing (`/cameras`, no device probes) and the complete `/cameras/status`; registry reload; group power; per-camera control (power, LED, night-vision, rec-mode, generic command). |
| `routes/camera-status.js` | Real-time camera status and control: unified status contract, reboot, HTTPD, SD recording toggle, push toggle. Proxies to yi-hack CGI endpoints. |
| `routes/stream.js` | Live view: returns WebRTC/MSE stream URLs proxied through `/stream-proxy`. |
| `routes/push.js` | Web Push management: fetch the VAPID public key, subscribe/unsubscribe. |
| `routes/storage.js` | SD/event management for yi-hack cameras: SD info + event dirs, list/delete event files & dirs, purge by scope, and read/write FTP push config. Proxies to yi-hack CGI endpoints. |

---

## REST API

The API is mounted under `/api` on port 3000. Processed media is served from `/processed/*`, original clips from `/videos/*`, and live streams from `/stream-proxy/*`. A **full, formatted reference is coming soon** in [`docs/API.md`](../../docs/API.md) — see the repo root README for links.

### Health & videos

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Service status: uptime, DB (`SELECT 1`), FTP listening, MQTT connected. Returns **503** if the DB or FTP is unhealthy. MQTT is reported but never fails health (broker down is non-fatal). |
| `GET` | `/api/videos` | List clips with filters (`camera`, `startDate`, `endDate`, `q`, `favorite`, `limit`, `offset`). |
| `GET` | `/api/videos/count` | Count clips matching the same filters as `GET /videos`. |
| `GET` | `/api/videos/:id` | Details of a specific clip (enriched with `original_url`, `thumbnail_url`, `preview_url`). |
| `PATCH` | `/api/videos/:id` | Set a custom name (`name`, ≤ 200 chars; `null`/`''` clears it). |
| `POST` | `/api/videos/:id/favorite` | Toggle favorite (`{"favorite": true}`). |
| `POST` | `/api/videos/bulk-delete` | Delete many clips + their physical files (`{"ids": [..]}`, max 500). |
| `POST` | `/api/videos/bulk-favorite` | Set/clear favorite on many clips (`{"ids": [..], "favorite": bool}`). |
| `POST` | `/api/videos/purge` | Retention cleanup: `{"scope": "day"|"week"|"month"|"range"|"all", "from?","to?"}`. Never deletes favorites. |
| `DELETE` | `/api/videos/:id` | Delete a clip + its physical files (original, thumbnail, preview). |

### Cameras & control plane

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cameras` | Fast listing: `cameras.json` + SQLite stats + MQTT state. **No device probes** (responds in ms). |
| `GET` | `/api/cameras/status` | Complete listing: everything in `/cameras` plus per-camera real status (`state`, `http`, `mqtt`, configs, `sd`) and latest clip. yi-hack cameras are probed in parallel. |
| `POST` | `/api/cameras/:id/reload` | Reload the entire `cameras.json` registry (re-subscribes MQTT topics). The `:id` is accepted for symmetry but reloads everything. |
| `POST` | `/api/cameras/group/power` | Power a group of cameras (`{"cameraIds": [..], "enabled": bool}`, max 50). |
| `POST` | `/api/cameras/:id/power` | Power the camera on/off (`{"enabled": bool}`). |
| `POST` | `/api/cameras/:id/led` | Toggle LED (`{"enabled": bool}`). |
| `POST` | `/api/cameras/:id/night-vision` | Toggle IR-cut / night vision (`{"enabled": bool}`). |
| `POST` | `/api/cameras/:id/rec-mode` | Toggle motion recording (`{"mode": "motion"|"off"}`). |
| `POST` | `/api/cameras/:id/command` | Generic whitelisted command (`{"command": "..", "value": ".."}`). |

### Camera status & storage (yi-hack)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cameras/:id/status` | Unified real-time status contract (same shape for both ecosystems; unavailable fields are always `null`). See the module docs for the full field list. |
| `POST` | `/api/cameras/:id/reboot` | Reboot the camera (CGI `reboot.sh`). yi-hack only. |
| `POST` | `/api/cameras/:id/httpd` | Set HTTPD yes/no (`{"enabled": bool}`); applied on next boot. yi-hack only. |
| `POST` | `/api/cameras/:id/sd-recording` | Toggle SD recording (`{"enabled": bool}`); applied on next boot. yi-hack only. |
| `POST` | `/api/cameras/:id/push` | Toggle motion push from the NVR side (`{"enabled": bool}`); works for **both** ecosystems. |
| `GET` | `/api/cameras/:id/storage` | SD info + event directories (yi-hack). |
| `GET` | `/api/cameras/:id/storage/dirs/:dir/files` | List event files in an event directory (yi-hack). |
| `DELETE` | `/api/cameras/:id/storage/files` | Delete an event file (`{"file": "<dirname>/<filename>.mp4"}`). |
| `DELETE` | `/api/cameras/:id/storage/dirs` | Delete an event directory (`{"dir": "<dirname>"}`). |
| `POST` | `/api/cameras/:id/storage/purge` | Purge events by scope (`all` / `last N` / `range`). |
| `GET` | `/api/cameras/:id/storage/ftp` | Read the camera's FTP push config + NVR-derived `suggested` values + `in_sync`. |
| `POST` | `/api/cameras/:id/storage/ftp` | Write FTP push switches (`FTP_UPLOAD`, `FTP_DIR_TREE`, `FTP_FILE_DELETE_AFTER_UPLOAD`). Fixed fields (host/user/pass/dir) are always forced by the NVR. |

### Stream & push

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/cameras/:id/stream` | WebRTC/MSE stream URLs (relative to `/stream-proxy`). |
| `GET` | `/api/push/vapid-public-key` | VAPID public key, or `null` if not configured. |
| `POST` | `/api/push/subscribe` | Register a standard `PushSubscription` (201). |
| `POST` | `/api/push/unsubscribe` | Remove a subscription by endpoint (idempotent). |

### Non-API routes

| Route | Purpose |
|---|---|
| `/processed/*` | Serves thumbnails and animated previews from `data/processed`. |
| `/videos/*` | Serves original `.mp4` clips from `recordings/`. |
| `/stream-proxy/*` | Proxies to go2rtc (`GO2RTC_URL`). Returns JSON `502` if go2rtc is unreachable. |

> **Note:** there is **no** `/api/timeline` endpoint. Timeline rendering is a client-side concern handled by the Angular PWA against the video/camera APIs above.

---

## Storage & directories

Storage lives **outside the source tree** in both dev and Docker (Docker remaps them to `/app/…`). The mapping of `remote_recordings` to an NFS/rclone mount is done via a compose volume, not inside this service.

| Directory | Purpose | Notes |
|---|---|---|
| `data/` (`DATA_DIR`) | SQLite DB (`surveillance.db`, WAL mode) + processed media (`data/processed`). | SSD recommended. Created automatically if missing. |
| `incoming/` (`INCOMING_DIR`) | FTP staging: raw camera uploads. **The only directory chokidar watches.** | Can be tmpfs for speed (see compose). |
| `recordings/` (`RECORDINGS_DIR`) | Processed clips, served at `/videos`. | Created automatically if missing. |
| `remote_recordings/` (`REMOTE_RECORDINGS_DIR`) | Remote-mirror destination for 3-2-1 backup. | Fixed path; the remote mount is mapped onto it by compose. Created if missing (ftp.js). |
| `src/public/` (`PUBLIC_DIR`) | Built Angular PWA (static assets + `index.html`). | Rebuilt with `npm run build:web` in `apps/frontend`. |
| `infra/cameras.json` (`CAMERAS_JSON_PATH`) | Camera registry (gitignored; template in `infra/cameras.json.example`). | Single source of truth for cameras. |

**The 3-2-1 backup:** with `REMOTE_MIRROR=1`, every processed clip is copied to `remote_recordings/`. This directory is a fixed path in Docker (`/app/remote_recordings`); you map your NFS/rclone mount onto it via a compose volume. Mirror failures are logged with retries and never break the local pipeline.

---

## Deployment

### Docker Compose (primary)

```bash
docker compose up -d
```

This pulls the image from `apps/api/Dockerfile` and starts the API, the MQTT broker (`mosquitto`), and the `go2rtc` sidecar. Storage directories are declared as **volumes** (`./data`, `./incoming`, `./recordings`, plus the optional remote mirror) so data persists across restarts. The passive FTP range is set to `1024-1027` in compose.

See [`../../docker-compose.yml`](../../docker-compose.yml) for the full service list, volumes, and environment mapping.

### systemd (plan B for low-RAM SBCs)

For constrained single-board computers where Docker's overhead isn't worth it, run the API directly under systemd as a fallback. The storage directories remain **volumes** — point the unit at the same `DATA_DIR`, `INCOMING_DIR`, and `RECORDINGS_DIR` used by Docker (repo-root paths in dev, or an external mount). This keeps the ffmpeg processing queue (`FFMPEG_CONCURRENCY=1`) and thread budget (`FFMPEG_THREADS=2`) tuned for low-RAM environments.

---

## Dev tools / testing

The `scripts/` directory holds MQTT verification helpers (run against a real broker; they never touch physical cameras):

| Script | Purpose |
|---|---|
| `mqtt-smoke.js` | Read-side smoke test: subscribes to a prefix (`yi-oficina/#` by default), waits ~10 s, prints everything received. Exit 0 if connected. |
| `mqtt-loopback.js` | Validates the publish transport against the real broker using a **fictional** prefix — publishes and confirms the subscriber receives it. |
| `mqtt-ping-sync.js` | Publishes an empty payload to `<prefix>/cmnd/camera` (yi-hack sync ping); the camera re-publishes its current state, which you can verify. |
| `mqtt-rest-publish.js` | Exercises the REST publish branch against a **fictional** camera (`TESTCAM000000`) — publishes a command via the API and confirms it reaches the broker. |
| `mqtt-degraded.js` | Verifies graceful degradation: runs `mqtt/client.js` against a **dead** port (~5 s) and asserts the process doesn't crash and reports disconnected/retrying. |
| `mqtt-db-tail.js` | Reads the last N rows of the `mqtt_events` table from the DB (read-only, WAL-compatible). |

Other helpers: `set-camera-rtsp.js` and `verify-stream-proxy.js`. All scripts accept a broker URL as an argument or via `MQTT_BROKER_URL`.

---

## Status / roadmap

The project evolves **phase by phase**, each gated by verifiable acceptance criteria and tagged in git. The current git tag tells you exactly how far it has come; the execution plan lives in [`../../AGENT-PLAN.md`](../../AGENT-PLAN.md).

Backend status highlights:

- ✅ Single-process Express 5 + FTP (`ftp-srv`/`chokidar`) + go2rtc proxy + MQTT client + Web Push.
- ✅ Graceful degradation: MQTT broker down and/or go2rtc absent don't take the service down.
- ✅ Unified camera status contract (`yi-hack` vs `generic` ecosystems).
- ✅ 3-2-1 remote mirror backup (non-fatal with retries).
- ⏳ Full formatted REST reference — [`docs/API.md`](../../docs/API.md) is **coming soon**.

---

## Related docs

- Repository root README — [`../../README.md`](../../README.md)
- Frontend (Angular PWA) — [`../../apps/frontend/README.md`](../../apps/frontend/README.md)
- Architecture & decisions — [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
- Camera CGI reference — [`../../docs/CAMERA-CGI-REFERENCE.md`](../../docs/CAMERA-CGI-REFERENCE.md)
- Official firmware settings — [`../../docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md`](../../docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md)
- Full REST reference — [`../../docs/API.md`](../../docs/API.md) *(coming soon)*
