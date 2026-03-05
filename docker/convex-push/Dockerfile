FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY convex/ ./convex/
COPY convex.json tsconfig.json ./
COPY docker/convex-push.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
ENTRYPOINT ["sh", "/entrypoint.sh"]
