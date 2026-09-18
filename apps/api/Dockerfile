# syntax=docker/dockerfile:1

# yi-nvr API (Express 5 + Angular PWA)
#
# Build multi-stage. Contexto: raíz del repo (context: ., dockerfile: apps/api/Dockerfile)
# porque el stage frontend-build necesita apps/frontend completo.
#
# Base node:26-trixie-slim (glibc): better-sqlite3 usa binarios prebuilt glibc
# y ffmpeg es paquete de primera clase en Debian. Se queda como root (no
# USER node) porque FTP escucha en el puerto 21 (privilegiado); tini = init
# real → reenvío de señales + reap de los hijos de ffmpeg.

FROM node:26-trixie-slim AS frontend-build
WORKDIR /frontend
COPY apps/frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY apps/frontend .
RUN npm run build

FROM node:26-trixie-slim AS deps
WORKDIR /app
# python3/make/g++: fallback por si un prebuilt de better-sqlite3 no existiera
# y toca compilar vía node-gyp. El stage se descarta (solo se copia
# node_modules), así la toolchain nunca infla la imagen final.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY apps/api/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:26-trixie-slim
WORKDIR /app
# ffmpeg: pipeline thumbnail + preview (processor.js).
# tini: init real → reenvío de señales + reap de hijos de ffmpeg.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*
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

# 3000 = HTTP único (API + SPA + media + proxy go2rtc). 21 = FTP (privilegiado).
EXPOSE 3000 21
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
