FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY start-login.sh /app/start-login.sh
RUN chmod +x /app/start-login.sh

CMD ["/app/start-login.sh"]
