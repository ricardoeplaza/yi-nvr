# Frontend — yi-nvr PWA

Mobile-first **Angular 22** Progressive Web App (PWA) that is the client UI for the
NVR. It renders the cameras, live stream, recorded-video gallery, storage and push
settings, and talks to the backend REST API (`http://localhost:3000`) through typed
services.

This directory is **only the frontend**. In the production flow there is no standalone
dev server: the app is built once with `npm run build:web` and then served as static
files by the same Express process that runs the API (single-process deployment). The
old "run `ng serve` on `http://localhost:4200`" boilerplate does not apply here — see
[Build & serving](#build--serving).

---

## Overview / role

The frontend is the user-facing shell of the yi-nvr system. It is a single-page app
with lazy-loaded routes and a custom lightweight i18n layer. All data access goes
through services that wrap `HttpClient`; pages never call the API directly. The app is
served statically by the backend, so a running instance needs only one process — the
API server in `apps/api` — which serves both the REST endpoints and the built PWA.

---

## Architecture

The source tree under `src/app/` is organized into focused layers:

```
src/app/
├── app.config.ts        Application config (router, HttpClient, service worker)
├── app.routes.ts        Route table (lazy-loaded, auth-guarded)
├── app.ts               Root standalone component (<router-outlet> + footer)
│
├── pages/               Feature pages (one folder per route)
│   ├── login/           Login gate (writes the auth flag to localStorage)
│   ├── dashboard/       Today's timeline + player (push-notification deep-link target)
│   ├── cameras/         Camera list / registry with power & recording toggles
│   ├── camera-detail/   Single-camera status, controls, live stream, SD info
│   ├── gallery/         Recorded-video gallery: search, filters, bulk actions, purge
│   ├── storage-management/  Per-camera SD management (FTP push, files, purge)
│   └── settings/        Push notifications + app/session info
│
├── services/            Data access — thin wrappers over HttpClient → RxJS Observables
│   ├── camera.service.ts
│   ├── video.service.ts
│   ├── stream.service.ts
│   ├── push.service.ts
│   ├── storage.service.ts
│   └── power.service.ts        Optimistic toggle state (depends on CameraService)
│
├── models/              Typed domain contracts for the API responses
│   ├── camera.model.ts
│   ├── video.model.ts
│   ├── stream.model.ts
│   └── storage.model.ts
│
├── guards/
│   └── auth.guard.ts     Redirects unauthenticated users to /login
│
└── shared/              Reusable components, pipes and cross-cutting services
    ├── i18n/             I18nService (locale detection + t()) and the `t` pipe
    ├── player/           Video player (live WebRTC/MSE + recorded playback)
    ├── timeline/         Today's recording timeline
    ├── camera-card/      Camera list card
    ├── gallery-card/     Recorded-clip card
    ├── video-card/       Lightweight clip reference
    ├── app-header/, app-nav/, app-footer/, app-back/   Layout chrome
    ├── confirm-dialog/, purge-sheet/, selection-bar/   Action modals & toolbars
    ├── empty-state/, toast/           Feedback primitives
    └── format-date.pipe.ts, format-duration.pipe.ts  Date/duration formatting
```

### How a page → service → REST API fits together

```
┌──────────────────────────────┐
│  Page component (e.g.        │
│  camera-detail.page.ts)      │
│   • Angular signals for UI   │
│     state                    │
│   • imports shared           │
│     components/pipes         │
└───────────────┬──────────────┘
                │ injects service (providedIn: 'root')
                ▼
┌──────────────────────────────┐
│  Service (e.g.               │
│  camera.service.ts)          │
│   • HttpClient instance      │
│   • maps request →           │
│     Observable<Envelope>     │
│     where Envelope =         │
│     { success, data, count } │
└───────────────┬──────────────┘
                │ HTTP GET/POST/PATCH/DELETE against /api/*
                ▼
┌──────────────────────────────┐
│  REST API (apps/api)          │
│   • routes/*.js               │
│   • proxies to cameras,       │
│     go2rtc stream, FTP, etc.  │
└───────────────┬──────────────┘
                │
                ▼
┌──────────────────────────────┐
│  Domain models (src/app/      │
│  models/*.model.ts)           │
│   • Camera, CameraStatus,     │
│     Video, StreamInfo,        │
│     StorageInfo …             │
│   • typed contracts that the  │
│     API and UI agree on       │
└──────────────────────────────┘
```

Pages are **standalone components** that declare their imports inline. State is held in
Angular **signals**; optimistic UI updates are paired with rollback on API error (for
example toggling a camera's power or a clip's favorite).

The app supports two camera "ecosystems" — `yi-hack` and `generic` — distinguished by
the `capabilities` field returned by the status endpoint. Pages render sections
conditionally based on those capabilities rather than hard-coding per-ecosystem UI, so
the same page adapts to what each camera exposes (live status, controls, SD, WiFi,
system, MQTT, push, videos).

---

## Pages

Routes are defined in `src/app/app.routes.ts` and loaded lazily via dynamic imports.
Every route except `/login` is protected by `auth.guard.ts`.

| Path | Component | Purpose |
| --- | --- | --- |
| `/login` | `LoginPage` | Login gate. On success it writes `yi-nvr-auth=true` to `localStorage` and replaces the URL with `/`. Not guarded. |
| `/` (root) | `DashboardPage` | Today's recording timeline, an inline player, and push-notification deep-linking (`?video=<id>` opens the matching clip). Guarded. |
| `/cameras` | `Cameras` | Camera registry: list of cameras with power, LED, night-vision and recording-mode toggles, plus last-clip thumbnails. Guarded. |
| `/cameras/:id` | `CameraDetailPage` | Single-camera detail: live stream player (WebRTC primary, MSE fallback), real-time status polling, SD usage, and camera controls (power, LED, IR, recording mode, SD recording, push, reboot). Guarded. |
| `/cameras/:id/storage` | `StoragePage` | Per-camera SD management: FTP cloud-push config, event-directory/file browsing, deletion, and retention purge. Guarded. |
| `/videos` | `GalleryPage` | Recorded-video gallery with search, camera/date/favorite filters, infinite scroll, bulk favorite/delete, per-clip rename, and a purge bottom sheet. Guarded. |
| `/settings` | `SettingsPage` | Push-notification management (register/unregister Web Push) and app/session info with sign-out. Guarded. |
| `**` | — | Catch-all redirect to `/`. |

The `auth.guard.ts` reads `localStorage.getItem('yi-nvr-auth')`; if it is not exactly
`'true'` the guard returns a URL tree for `/login`, which redirects the user there.

---

## Services & data access

Every service is `@Injectable({ providedIn: 'root' })` and exposes `Observable`s built
on `HttpClient`. Request/response envelopes are typed in the model layer.

### `camera.service.ts`
Reads and mutates camera state.
- `getCameras()` → `{ success, count, data: Camera[] }` (`GET /api/cameras`)
- `getCamerasStatus()` → per-camera live status (`GET /api/cameras/status`)
- `setPower`, `setLed`, `setNightVision`, `setRecMode` → device command toggles
  (`POST /api/cameras/:id/{power,led,night-vision,rec-mode}`), returning a
  `CommandResult { success, applied, key, value }`
- `setGroupPower(cameraIds, enabled)` → batch command (`POST /api/cameras/group/power`)
- `getCameraStatus(cameraId)` → unified status contract (`GET /api/cameras/:id/status`)
- `rebootCamera(cameraId)` → reboot via CGI (`POST /api/cameras/:id/reboot`)
- `setPush`, `setSdRecording` → camera push and SD-recording toggles

### `video.service.ts`
Reads, filters and mutates recorded clips.
- `getVideos(params)` → paginated list with query string (`GET /api/videos`)
- `countVideos(params)` → total count for a filter set (`GET /api/videos/count`)
- `renameVideo(id, name)`, `setFavorite(id, favorite)`, `deleteVideo(id)` → per-clip ops
- `bulkDelete(ids)`, `bulkFavorite(ids, favorite)` → batch operations
- `purgeVideos({ scope, from?, to? })` → retention purge (`POST /api/videos/purge`)

### `stream.service.ts`
Live-streaming via go2rtc.
- `getStreamInfo(cameraId)` → `{ success, src, webrtc_url, mse_url }` (`GET /api/cameras/:id/stream`)
- `startWebRtc(videoElement, whepUrl)` → builds an `RTCPeerConnection`, declares
  recvonly video+audio transceivers, gathers ICE candidates, then POSTs the SDP offer
  to go2rtc's **WHEP** endpoint (HTTP POST with `Content-Type: application/sdp`; the
  answer SDP flows back as plain text). Used by `CameraDetailPage` as the primary
  WebRTC path, with an MSE fallback URL.

### `push.service.ts`
Web Push notifications.
- `getVapidKey()` → VAPID public key (`GET /api/push/vapid-public-key`)
- `subscribe(subscription)`, `unsubscribe(subscription)` → backend subscription ops
- `registerPush()` → requests Notification permission, registers the dedicated push
  service worker at `/push/sw.js` (scope `/push/`), fetches the VAPID key and
  subscribes. Returns a discriminated union result with failure reasons
  (`permission-denied`, `no-vapid-key`, `sw-registration`, `subscription`).

### `storage.service.ts`
SD / cloud-push storage management for a camera (yi-hack only).
- `getStorage(cameraId)` → SD info + event directories (`GET /api/cameras/:id/storage`)
- `deleteDir`, `deleteFile`, `getDirFiles` → file/directory ops
- `purge(req)` → retention purge (`POST /api/cameras/:id/storage/purge`)
- `getFtpConfig`, `saveFtpConfig` → FTP cloud-push configuration

### `power.service.ts`
Optimistic power-state management. Holds a `signal<Record<string, boolean>>`, seeds
the known state from the status config, and performs optimistic toggles with rollback
on API error. It depends on `CameraService` and `I18nService`.

---

## Models

Typed contracts in `src/app/models/` that define the shape of API responses so the UI
and backend can agree precisely.

- **`camera.model.ts`** — `Camera`, `CameraStatus`, `CameraCapabilities`,
  `StatusCapabilities`, `CameraMqttState`, `CameraSd`, `CameraRawStatus`. Defines the
  `Ecosystem` type (`'yi-hack' | 'generic'`) and the unified status contract, where an
  unavailable section is always represented as `null` (never missing) so pages can
  decide what to render via `capabilities`.
- **`video.model.ts`** — `Video`: id, name, camera_name, timestamp, paths, duration,
  file size, favorite flag and URLs.
- **`stream.model.ts`** — `StreamInfo`: `success`, `src`, `webrtc_url`, `mse_url`.
- **`storage.model.ts`** — `StorageInfo`, `StorageFtpConfig`, `StorageFtpSuggested`,
  `StorageFtpUpdate`, `StorageDirFile`, `StorageDirFiles`, `StoragePurgeRequest`,
  `StoragePurgeResult`.

---

## i18n

The app uses a minimal, dictionary-based internationalization system.

- **Six supported locales:** `en` (English), `es` (Spanish), `fr` (French), `de`
  (German), `pt` (Portuguese) and `it` (Italian).
- **Detection at startup:** the locale is detected **once** from the browser language
  (`navigator.languages[0] ?? navigator.language`, lowercased, two-letter prefix). An
  unsupported browser locale falls back to English. The detected locale is written to
  `<html lang>` and used for `Intl` date formatting. There is **no persistence and no
  in-app language switching** — the UI always follows the browser's language.
- **Dictionaries:** flat JSON files under `src/i18n/` (`en.json`, `es.json`, `fr.json`,
  `de.json`, `pt.json`, `it.json`). Each file is a flat key → string map with
  **256 keys**, and all six share an identical key set (verified). Placeholders use the
  `{{name}}` syntax and are substituted by `I18nService.t()`.
- **Source of truth:** `es.json` is the source/base dictionary. The `I18nKey` type and
  the `I18N_KEYS` manifest in `src/i18n/keys.ts` are derived directly from `es.json`, so
  new keys are introduced in Spanish first. `t()` uses the detected locale's template
  when present and non-empty, otherwise it falls back to Spanish (which is always
  complete), guaranteeing output is never broken.

> **Reality note:** `src/app/shared/i18n/i18n.service.ts` still carries a comment saying
> "only es/en JSON files exist so far (fr/de/pt/it land in later commits)". That comment
> is now **outdated** — all six locale files exist and are complete with 256 keys each.
> The runtime behavior described above (six locales, Spanish as source) is accurate.

Translation is applied in templates via the standalone `t` pipe: `{{ 'common.back' | t }}`.

---

## Build & serving

### Building the PWA

```bash
npm run build:web
```

This runs two steps:

1. `ng build` — compiles the Angular app to production output at
   `dist/frontend/browser`.
2. `node scripts/build-web.cjs` — copies that output into
   `apps/api/src/public`, where Express serves it. The copy preserves any existing
   `mockup/` directory and replaces everything else, so rebuilt assets take effect on
   the next API restart.

### How it is served (no `ng serve`)

In the real deployment the frontend is **not** run with a dev server. The single
Express process in `apps/api/src/server.js` serves the built PWA as static files from
`PUBLIC_DIR` (default: `apps/api/src/public`, configurable via `PUBLIC_DIR`), with
`index.html` always sent with `no-cache` so the service worker picks up new versions.
A **SPA fallback** catches any unmatched GET request and returns `index.html` so the
client router can resolve client-side routes (deep links such as `/cameras/:id`).

To run the app end to end you start the API server (`apps/api`); it serves both the REST
API (`http://localhost:3000/api/*`) and the built PWA at the site root. Running the PWA
standalone (outside the API) requires serving `apps/api/src/public` yourself — there is
no `ng serve` step in the production flow.

### Development (`ng serve`)

For local UI development you can run the Angular dev server, which hot-reloads as you edit. It needs **two terminals** — the API must be running first, because the dev server proxies to it:

```bash
# Terminal 1 — the API (serves /api/* and the static build on :3000)
cd apps/api && npm install && npm start

# Terminal 2 — the Angular dev server (hot-reloads the UI)
cd apps/frontend && npm install && npm start   # ng serve → http://localhost:4200
```

The dev server listens on `http://localhost:4200` and proxies API/media routes to the running API via [`proxy.conf.json`](proxy.conf.json):

| Proxy prefix | Target |
| --- | --- |
| `/api`, `/videos`, `/processed`, `/stream-proxy`, `/push` | `http://localhost:3000` |

This lets you iterate on the UI without rebuilding. It is **not** used in production — the API serves the built PWA statically (see [How it is served](#how-it-is-served)).

### Service worker

`app.config.ts` registers a service worker (`ngsw-worker.js`) that is **enabled only in
production** (`enabled: !isDevMode()`). Push notifications use a dedicated service worker
at `/push/sw.js` with scope `/push/`. Note that Web Push requires a secure context, so
it only works over HTTPS (or `localhost`).

---

## Getting started

### Prerequisites

- Node.js (the project targets `npm@12.0.1`; use `corepack enable` if needed).
- npm.
- A running backend API at `http://localhost:3000` for the app to talk to in the real
  flow.

### Install dependencies

```bash
cd apps/frontend
npm install
```

### Build

```bash
npm run build:web
```

This produces the PWA in `apps/api/src/public`. To view it, start the API server
(`apps/api`); it serves the built app at the site root.

> Running the app standalone (e.g. opening `dist/frontend/browser/index.html`) will not
> work as intended: the API is what serves the static files and provides the SPA
> fallback, so use `npm run build:web` and serve through the API.

### Handy scripts

| Script | Description |
| --- | --- |
| `npm run build:web` | Build the PWA and copy it into `apps/api/src/public`. |
| `npm run icons` | Regenerate app icons (uses `sharp`). |
| `npm run watch` | Development `ng build --watch` in development configuration. |
| `npm test` | Run unit tests with Vitest. |

---

## Testing

Unit tests use **Vitest** through the Angular CLI:

```bash
ng test
```

Specs live alongside their sources as `*.spec.ts` files, for example:

- Component specs: `camera-card.spec.ts`, `gallery-card.spec.ts`, `player.spec.ts`,
  `purge-sheet.spec.ts`, `selection-bar.spec.ts`, `toast.spec.ts`, `confirm-dialog.spec.ts`.
- Service specs: `power.service.spec.ts`, `video.service.spec.ts`.
- Page specs: `camera-detail.page.spec.ts`, `cameras.spec.ts`, `dashboard.page.spec.ts`,
  `gallery.page.spec.ts`, `storage.page.spec.ts`.
- `app.spec.ts` covers the root component.

---

## Status / roadmap

- **Done:** camera registry and per-camera controls, unified status contract with
  ecosystem-aware rendering (`yi-hack` / `generic`), recorded-video gallery with search,
  filters, bulk actions and retention purge, per-camera SD management (FTP cloud push,
  file browsing, purge), live streaming via go2rtc WebRTC + MSE fallback, Web Push
  notifications, custom i18n in six languages, and a PWA with a production service worker.
- **In progress / planned:** the service-worker config is wired for production caching;
  deep-linking from push notifications to the dashboard/clip is implemented. Roadmap
  phases are tracked in the repository docs (see `docs/ARCHITECTURE.md`), covering items
  such as HTTPS via Tailscale, additional locales, and further hardening of the storage
  and push pipelines.
