ARG BASE=nvidia
# ---------- NVIDIA stage: CUDA + FFmpeg with NVENC ----------
FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04 AS base-nvidia

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
      ffmpeg && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

ENV HW_ACCEL=nvidia
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=video,compute,utility

# ---------- CPU stage: slim Node image ----------
FROM node:22-bookworm-slim AS base-cpu

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

ENV HW_ACCEL=cpu

# ---------- Final: pick base by build arg ----------
FROM base-${BASE}

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js transcode.js ./

ENV PORT=3300
EXPOSE 3300

HEALTHCHECK --interval=10s --start-period=5s CMD curl -f http://localhost:3300/health || exit 1

CMD ["node", "server.js"]
