# yi-nvr

**A free, self-hosted NVR ecosystem for [yi-hack](https://github.com/roleoroleo/yi-hack-Allwinner-v2) cameras — an open alternative to the closed Xiaomi / Yi / MiHome ecosystem.**

Take full control of your surveillance setup: manage multiple cameras, record motion-triggered clips, view live streams directly in your browser, and receive instant push notifications. No accounts, no cloud lock-in, and no subscriptions. Just your cameras, your storage, and your rules.

> **Up and running in seconds:** clone the repository, copy `.env`, and run `npm start` inside `apps/api`. Your system will be ready at **http://localhost:3000** in about a minute.

---

## Quick Start

The entire system runs as a single Node.js process on a single port — no separate web server or nginx required.

> **Build the frontend first:** The dashboard shares the API port (`3000`), but requires the Angular PWA to be built at least once; otherwise, `http://localhost:3000` will return a 404 error. Make sure to run `npm run build:web` inside `apps/frontend` before starting the backend:

```bash
# 1. Build the Angular PWA once (served by the API as static files)
cd apps/frontend && npm install && npm run build:web

# 2. Copy the environment template (first time only)
cp .env.example .env

# 3. Start the backend — REST API + static PWA on http://localhost:3000
cd apps/api && npm install && npm start

```

Open **http://localhost:3000** to access the dashboard.

The two local execution modes — **production** (single build served by the API) versus **development** (`ng serve` proxied to the API) — are detailed in the technical READMEs below.

### Camera Configuration

`infra/cameras.json` serves as the single source of truth for the backend (LAN IPs, FTP directory, MQTT topics). It is **gitignored**, so be sure to enter your real camera details before connecting them.

---

## Key Features

* **Camera Management** — Monitor status, view events, stream live video, and configure camera settings via MQTT.
* **Motion-Triggered Recording** — Cameras upload short `.mp4` clips over FTP. Each clip generates a JPG thumbnail and an animated WebP preview, gets indexed in SQLite, and is served via the API and PWA.
* **In-Browser Live View** — Low-latency WebRTC streaming powered by a `go2rtc` sidecar (with fallback to MSE/mp4), proxied through the main process. No plugins required.
* **Web Push Notifications** — Receive real-time alerts for motion events and clip processing completion straight to your browser.
* **Mobile-First PWA** — Dashboard, camera controls, clip gallery, timeline, and settings bundled into a single installable app.
* **Storage & Disk Management** — Automated retention policies based on age and storage capacity keep disk usage fully predictable.
* **Lightweight & Flexible** — Optimized to run efficiently on low-power single-board computers (such as Orange Pi) behind a Tailscale/Headscale VPN.

---

## Architecture & Data Flow

Data moves through a simple, linear pipeline:

```
Camera ──FTP clips──▶ FTP receiver ──▶ ffmpeg processing
                                              │
                                        thumbnail + preview
                                              │
                                        SQLite index
                                              │
REST API ◀───────────────────────────────────┘
   ▲
   │ MQTT (motion, LED, IR-cut, record mode, power)
Camera ◀─────────────────────────────── control plane
   ▲
   │ WebRTC / MSE (live view)
Browser ◀──────────────────────────────────────── go2rtc sidecar

```

1. The **camera** detects motion and uploads a short clip via FTP.
2. The **FTP receiver** captures the raw file, and `ffmpeg` generates a thumbnail along with an animated preview.
3. The processed metadata is indexed in SQLite and exposed through the **REST API**.
4. The **Angular PWA** fetches this data to display cameras, galleries, and timelines.
5. **MQTT** manages motion events and control commands (LED, night vision, recording mode, power) between the NVR and each camera.
6. **Web Push** delivers instant notifications to your browser.

For complete architectural details — technology choices, environment variables, and design trade-offs — check out [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Node.js (LTS 20+), Express 5 |
| Database | SQLite via `better-sqlite3` |
| FTP Receiver | `ftp-srv` + `chokidar` |
| Video Processing | `fluent-ffmpeg` + system `ffmpeg` binary |
| MQTT Control Plane | Eclipse Mosquitto 2 (Docker) |
| RTSP → WebRTC | `go2rtc` sidecar, proxied in-process |
| Push Notifications | `web-push` (VAPID) |
| Frontend | Angular 22 PWA (with service worker) |
| Deployment | Docker Compose (with systemd support for low-RAM devices) |

---

## Deployment

For production environments, running via Docker Compose is recommended. **You do not need to clone the full repository** — simply download `docker-compose.yml` and the `.example` config files, customize them, and start the stack:

```bash
# 1. Fetch docker-compose.yml
curl -o docker-compose.yml https://raw.githubusercontent.com/ricardoeplaza/yi-nvr/master/docker-compose.yml

# 2. Fetch configuration templates
curl -o .env.example      https://raw.githubusercontent.com/ricardoeplaza/yi-nvr/master/.env.example
curl -o infra/cameras.json.example   https://raw.githubusercontent.com/ricardoeplaza/yi-nvr/master/infra/cameras.json.example
curl -o infra/go2rtc/go2rtc.yaml.example https://raw.githubusercontent.com/ricardoeplaza/yi-nvr/master/infra/go2rtc/go2rtc.yaml.example
curl -o infra/mosquitto/mosquitto.conf.example https://raw.githubusercontent.com/ricardoeplaza/yi-nvr/master/infra/mosquitto/mosquitto.conf.example

# 3. Configure (edit the generated files with your settings)
cp .env.example .env          # Set NVR_PUBLIC_IP, VAPID keys, API_AUTH_TOKEN
cp infra/cameras.json.example infra/cameras.json   # Add your camera details
cp infra/go2rtc/go2rtc.yaml.example infra/go2rtc/go2rtc.yaml   # Define RTSP streams
cp infra/mosquitto/mosquitto.conf.example infra/mosquitto/mosquitto.conf

# 4. Start the stack (pulls latest images; launches API, Mosquitto, and go2rtc)
docker compose up -d

```

> The `.example` templates reside in `infra/`, `infra/go2rtc/`, and `infra/mosquitto/`. If you encounter issues fetching individual files, fall back to cloning the repository once: `git clone https://github.com/ricardoeplaza/yi-nvr.git && cd yi-nvr`.

**Exposed Ports**

| Port(s) | Purpose |
| --- | --- |
| `3000` | HTTP API + static PWA + media server + stream proxy |
| `21` + `1024–1027` | FTP service (camera uploads; passive port range) |
| `1883` | Mosquitto MQTT broker (local camera connections) |

> Port `21` is a privileged port, so the container runs as root by default. If you prefer to avoid privileged ports, change `FTP_PORT` in `.env` and update `ftppush.sh` on the camera's SD card.

**Storage Structure** — Data remains outside the source tree in both local development and Docker setups:

| Directory | Purpose | Recommended Storage |
| --- | --- | --- |
| `./data/` | SQLite database + processed assets (thumbnails, previews) | SSD |
| `./incoming/` | FTP staging area: raw camera uploads (monitored by watcher) | tmpfs / HDD |
| `./recordings/` | Local copy of processed clips (served at `/videos`) | HDD |

**Optional 3-2-1 Backup Strategy:** Set `REMOTE_MIRROR=1` and mount a remote storage target (NFS or rclone) to the `./remote_recordings/` directory. Each processed clip will be mirrored automatically. Remote sync failures are logged and retried without disrupting local operations.

---

## Developer API

The backend exposes a RESTful API on the same port as the web interface (`http://localhost:3000`). Key endpoints include:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service health status (DB, FTP, MQTT) |
| `GET` | `/api/videos` | Query video clips (filters: `camera`, `startDate`, `endDate`, `q`, `favorite`, `limit`) |
| `GET` | `/api/videos/:id` | Fetch clip metadata |
| `PATCH` | `/api/videos/:id` | Update clip title |
| `POST` | `/api/videos/:id/favorite` | Toggle clip favorite status |
| `DELETE` | `/api/videos/:id` | Delete clip and associated files |
| `GET` | `/api/cameras` | List registered cameras and stats |
| `POST` | `/api/cameras/:id/reload` | Hot-reload camera registry configuration |
| `POST` | `/api/cameras/:id/{power,led,night-vision,rec-mode}` | Send control commands to camera |
| `GET` | `/api/cameras/:id/stream` | Get WebRTC/MSE streaming endpoints |
| `POST` | `/api/push/subscribe` | Register Web Push subscriptions |

The core implementation is located in [`apps/api/src/server.js`](apps/api/src/server.js) and router modules under `apps/api/src/routes/`.

---

## Documentation Links

* **Frontend (Angular PWA)** — [`apps/frontend/README.md`](apps/frontend/README.md)
* **Backend Architecture** — [`apps/api/src/server.js`](apps/api/src/server.js) and `apps/api/src/routes/`
* **Design & System Architecture** — [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
* **Camera CGI Command Reference** — [`docs/CAMERA-CGI-REFERENCE.md`](docs/CAMERA-CGI-REFERENCE.md)
* **Firmware SD Card Configuration** — [`docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md`](docs/SD-FIRMWARE-OFFICIAL-SETTINGS.md)

---

## Project Status

The project is developed iteratively in phases, each verified against strict acceptance criteria and tagged in git. Check the current git tag to see the latest progress. The development roadmap is available in [`AGENT-PLAN.md`](AGENT-PLAN.md).

---

## Acknowledgments

* **[roleoroleo](https://github.com/roleoroleo?utm_source=gemini)** — Creator of [yi-hack-Allwinner-v2](https://github.com/roleoroleo/yi-hack-Allwinner-v2?utm_source=gemini), the custom firmware enabling MQTT, RTSP, and FTP support on these cameras. This project would not exist without his work.
* The open-source communities behind `go2rtc`, `Mosquitto`, `better-sqlite3`, `ffmpeg`, and the surrounding ecosystem.

---

## License

[ISC License](https://opensource.org/licenses/ISC?utm_source=gemini) — Free to use, modify, and distribute.

---

## Built Entirely with Local Open Models

This codebase was developed using **Qwen 27B**, an open-weight model running **100% locally on a single 16 GB GPU** without relying on cloud APIs or proprietary services. This approach demonstrates that full-featured, production-ready software can be engineered using open weights on accessible hardware.

The project followed a disciplined human-in-the-loop workflow:

* A comprehensive **human planning phase** recorded in [`AGENT-PLAN.md`](AGENT-PLAN.md), outlining the architecture, tech stack, execution roadmap, and acceptance benchmarks.
* Continuous **human oversight and commit-by-commit review**, validating and approving every line of code.

The result is a reliable, self-hosted system that replaces proprietary cloud ecosystems using consumer-grade hardware.