# yi-nvr API (Express 5 + Angular PWA)
#
# Build multi-stage. Contexto: raíz del repo (context: ., dockerfile: apps/api/Dockerfile)
# porque el stage frontend-build necesita apps/frontend completo.

FROM node:26-trixie-slim AS frontend-build
WORKDIR /frontend
COPY apps/frontend/package*.json ./
RUN npm ci
COPY apps/frontend .
RUN npm run build

FROM node:26-trixie-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY apps/api/package*.json ./
RUN npm ci --omit=dev

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
    RECORDINGS_DIR=/app/recordings \
    PUBLIC_DIR=/app/public

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('http').get('http://localhost:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 3000 = HTTP único (API + SPA + media + proxy go2rtc). 21 = FTP (privilegiado).
EXPOSE 3000 21
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
