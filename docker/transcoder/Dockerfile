FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js transcode.js ./

ENV PORT=3300
ENV HW_ACCEL=cpu
EXPOSE 3300

HEALTHCHECK --interval=10s --start-period=5s CMD curl -f http://localhost:3300/health || exit 1

CMD ["node", "server.js"]
