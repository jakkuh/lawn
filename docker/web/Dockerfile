FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM deps AS builder
COPY . .
ARG VITE_SELF_HOSTED=true
ARG VITE_CONVEX_URL=http://127.0.0.1:3210
ARG VITE_CONVEX_SITE_URL=http://127.0.0.1:3211
ENV SKIP_PRERENDER=true
RUN npx vite build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 5296
CMD ["npx", "vite", "preview", "--port", "5296", "--host", "0.0.0.0"]
