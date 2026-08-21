# yi-nvr

> A 100% free, self-hosted NVR ecosystem that replaces the closed Xiaomi/Yi (MiHome) world for cameras running [yi-hack](https://github.com/roleoroleo/yi-hack-Allwinner-v2) firmware.

**This project is being live-coded by an AI.** The entire codebase is written in real time by [Qwen 3.8 27B](https://qwen.ai), running **locally on a 16 GB VRAM machine** — no cloud APIs, no proprietary models. That is the point: this is a public, verifiable proof that serious software development is possible with local, open-weight models.

That said, this is *not* "prompt and pray". Behind every commit there is:

- a long, deliberate **human planning phase** captured in [`AGENT-PLAN.md`](AGENT-PLAN.md) — the single source of truth that defines the mission, the stack, the nine execution phases and their acceptance criteria, and
- **constant human supervision, commit by commit**, reviewing, correcting and approving each step.

## Why this project exists

Two motivations, one codebase:

1. **Freedom.** Xiaomi's recent policy changes turned the official ecosystem (MiHome app) into a subscription-gated experience: core surveillance features are no longer fully usable without paying. Combined with the deprecation of the original yi-hack, that pushed this project to build a complete, **libre alternative** that gives back full control of your own cameras — no accounts, no cloud lock-in, no subscription.
2. **Proof.** Demonstrating that an autonomous AI agent, powered by a locally-run 27B model with 16 GB of VRAM, can take a working proof-of-concept all the way to a production-grade application under human supervision.

The result is a single project that covers the whole job the Xiaomi ecosystem used to do:

- **Camera management** — state, events, live stream and configuration for N cameras, all over MQTT.
- **Recording** — a self-hosted "cloud recorder": cameras push motion-triggered clips over FTP; they are processed (thumbnails + animated previews), indexed in SQLite and served over a REST API and a PWA.
- **Notifications** — Web Push alerts in real time, so you always know what is happening.

## Features

- **FTP clip receiver** — motion-triggered `.mp4` uploads from yi-hack cameras, mapped to cameras via a configurable registry.
- **Video processing** — per-clip JPG thumbnail + animated WebP preview with `ffmpeg`.
- **MQTT control plane** — motion events in; LED, night vision (IR-cut), record mode and power commands out.
- **Live view** — WebRTC in the browser via a `go2rtc` sidecar (MSE/mp4 fallback), proxied through the same process. No plugins.
- **Web Push notifications** — on motion and on clip processing completion.
- **Mobile-first PWA** — dashboard, camera controls, clip gallery, timeline, settings.
- **Retention & bounded disk** — age-based and capacity-based cleanup policies.
- **Single HTTP entry point** — API + PWA + media + stream proxy on one port. No nginx, no extra web server.
- **Lightweight** — designed to run on small ARM SBCs (Orange Pi and friends), behind a Tailscale/Headscale VPN.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express 5 |
| Database | SQLite via `better-sqlite3` |
| FTP | `ftp-srv` + `chokidar` |
| Video processing | `fluent-ffmpeg` + system `ffmpeg` |
| MQTT broker | Eclipse Mosquitto 2 (Docker) |
| RTSP → WebRTC | `go2rtc` sidecar, proxied in-process |
| Push | `web-push` (VAPID) |
| Frontend | Angular PWA |
| Packaging | Docker Compose (systemd as plan B for low-RAM SBCs) |

## Project structure

```
yi-nvr/
├── AGENT-PLAN.md            # execution plan: phases, criteria, decisions
├── .env.example
├── infra/
│   ├── mosquitto/           # broker config
│   └── go2rtc/              # stream config (manual; .example template)
├── apps/
│   ├── api/                 # Node.js backend (FTP, MQTT, push, REST, PWA hosting)
│   │   └── src/
│   │       ├── server.js    # bootstrap only
│   │       ├── ftp.js       # FTP receiver
│   │       ├── processor.js # thumbnail/preview pipeline
│   │       ├── database.js  # SQLite (WAL)
│   │       ├── mqtt/        # client, topics, commands
│   │       ├── push/        # Web Push fan-out
│   │       └── routes/      # videos, cameras, timeline, push, stream
│   └── frontend/            # Angular PWA
├── storage/                 # Docker volume target (never committed)
└── docs/
    ├── ARCHITECTURE.md      # stack, environments, decision log
    └── API.md               # full API reference
```

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS, 20+)
- [FFmpeg](https://ffmpeg.org/) on the system PATH
- An MQTT broker (Mosquitto) for camera control
- Cameras flashed with [yi-hack-Allwinner-v2](https://github.com/roleoroleo/yi-hack-Allwinner-v2)

### Development

```bash
cp .env.example .env
cd apps/api
npm install
npm start
```

The server listens on `http://localhost:3000` (HTTP API + static assets) and `2121` (FTP, passive range `1024–1050`).

### Camera config (first run)

```bash
cp apps/api/src/config/cameras.json.example apps/api/src/config/cameras.json
```

- `cameras.json` is the single source of truth for the backend (LAN IPs, FTP dir, MQTT prefix/topics). It is **gitignored** — fill in your real values.
- `infra/go2rtc/go2rtc.yaml` is **manual** (template: `infra/go2rtc/go2rtc.yaml.example` — copy it and fill in real values). It is **gitignored** and the API never writes to it. One stream per camera `id` from `cameras.json`; use the `ffmpeg:` prefix to normalize a source (e.g. H.265 → H.264). For Tuya/Smart Life cameras, put the full `tuya://` URL (device id, email, password) as a stream source.

### Docker (full stack)

```bash
cp .env.example .env   # fill in VAPID keys and API_AUTH_TOKEN
docker compose up -d
```

Only port `3000` (HTTP) and the FTP ports are exposed; Mosquitto and go2rtc stay on the internal network.

## API (summary)

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/videos` | List clips (filters: `camera`, `startDate`, `endDate`, `limit`) |
| `GET` | `/api/videos/:id` | Clip details |
| `DELETE` | `/api/videos/:id` | Delete clip + files |
| `GET` | `/api/cameras` | Registered cameras + DB facts |
| `POST` | `/api/cameras/:id/reload` | Hot-reload camera registry |
| `POST` | `/api/cameras/:id/led` | Toggle LED |
| `POST` | `/api/cameras/:id/night-vision` | Toggle IR-cut |
| `POST` | `/api/cameras/:id/rec-mode` | `continuous` \| `motion` \| `off` |
| `POST` | `/api/cameras/:id/power` | Power on/off |
| `GET` | `/api/cameras/:id/stream` | WebRTC/MSE stream endpoints |
| `GET` | `/api/timeline` | Recordings grouped by date |
| `GET` | `/api/health` | Liveness |
| `POST` | `/api/push/subscribe` | Register a Web Push subscription |

See [`docs/API.md`](docs/API.md) for the full reference once phase 8 lands.

## Status

The project is evolving phase by phase following [`AGENT-PLAN.md`](AGENT-PLAN.md) (phase 0 → 9), each phase gated by verifiable acceptance criteria and tagged in git. The current tag tells you exactly how far it has come.

## Thanks

- **[roleoro](https://github.com/roleoroleo)** — for [yi-hack-Allwinner-v2](https://github.com/roleoroleo/yi-hack-Allwinner-v2), the open firmware that exposes MQTT, RTSP and FTP on these cameras and makes this whole project possible. Without it, there is no escape from the closed ecosystem.
- The open-source community behind `go2rtc`, `Mosquitto`, `better-sqlite3` and the rest of the stack.

## License

[ISC](https://opensource.org/licenses/ISC) — free to use, modify and redistribute.
