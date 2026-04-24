FROM node:20-slim AS deps

# better-sqlite3 needs build tools on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Persistent data lives here. On Railway, mount a volume at /app/data.
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/trashbot.db

EXPOSE 3000
CMD ["node", "src/index.js"]
