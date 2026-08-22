# The API. Node 26 runs the TypeScript directly with type stripping, so there
# is no build step and nothing to keep in sync between source and dist.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache curl \
 && addgroup -S link && adduser -S link -G link

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER link
EXPOSE 4000

# The container is unhealthy if it cannot reach the database, not merely if the
# process is alive — a server that answers 503 to everything is not serving.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/health || exit 1

# Signals reach node directly so the graceful shutdown in index.ts actually runs.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
