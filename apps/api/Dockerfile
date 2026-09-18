# syntax=docker/dockerfile:1

# yi-nvr API (Express 5 + Angular PWA)
#
# Multi-stage build. Context: repo root (context: ., dockerfile: apps/api/Dockerfile),
# because the frontend-build stage needs the full apps/frontend directory.

FROM node:26-alpine AS frontend-build
WORKDIR /frontend
COPY apps/frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY apps/frontend .
RUN npm run build

FROM node:26-alpine AS deps
WORKDIR /app
COPY apps/api/package*.json ./
# libc6-compat lets glibc binaries (e.g. esbuild's postinstall) run on musl.
# python3/make/g++ are a fallback in case any dependency forces node-gyp.
RUN apk add --no-cache --virtual .build-deps python3 make g++ libc6-compat \
    && npm ci --omit=dev \
    && apk del .build-deps

FROM node:26-alpine
WORKDIR /app
# ffmpeg: thumbnail + preview pipeline.
# tini: proper init for signal forwarding and reaping ffmpeg child processes.
RUN apk add --no-cache ffmpeg tini

COPY --from=deps /app/node_modules ./node_modules
COPY apps/api .
COPY --from=frontend-build /frontend/dist/frontend/browser ./public

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    INCOMING_DIR=/app/incoming \
    RECORDINGS_DIR=/app/recordings \
    REMOTE_RECORDINGS_DIR=/app/remote_recordings \
    PUBLIC_DIR=/app/public

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# 3000 = single HTTP endpoint (API + SPA + media + go2rtc proxy). 21 = FTP.
EXPOSE 3000 21
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]