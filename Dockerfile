FROM node:22-slim
WORKDIR /app

# Install build tools for native node-gyp dependencies (webtorrent, torrent-stream)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "--max-old-space-size=384", "server/index.js"]

