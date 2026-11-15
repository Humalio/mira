# Build stage: compile the SvelteKit app (adapter-node) to build/. The one native dep
# (sharp) gets its prebuilt linux-x64 binary here. Production dependencies are prepared
# separately so build-only tools such as Vite and its compilers cannot reach the runtime image.
# The DB driver is postgres-js — pure JS.
# Trixie provides maintained ffmpeg and multimedia libraries. Bookworm's ffmpeg 5.1
# carried several HIGH/CRITICAL CVEs that caused the release scan to reject the image.
FROM node:24-trixie-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
# When a platform package (such as Rolldown's native binding) fails to download, npm skips it
# without failing, and Docker would then keep that broken layer in its cache until the lockfile
# changes. Load each native binding the build and the tests need in the same step, so a bad
# install fails here and is never cached.
RUN npm ci \
    && node --input-type=module -e "for (const name of ['rolldown', 'lightningcss', 'sharp']) await import(name); process.exit(0)"
COPY . .
RUN npm run build

FROM node:24-trixie-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
# Same check for the one native package the server itself loads.
RUN npm ci --omit=dev \
    && node --input-type=module -e "await import('sharp'); process.exit(0)"

# Runtime stage: tiny node server. ffmpeg for the per-album video compression;
# ca-certificates for outbound TLS (the OAuth sign-in exchange with the provider);
# tini to run as process 1 (see ENTRYPOINT below).
FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/database ./database
COPY scripts/init-db.mjs scripts/schema-fingerprint.mjs scripts/start.mjs ./scripts/
COPY package.json ./

# npm, npx, Corepack and Vite's native compilers (Rolldown, Lightning CSS, and esbuild
# where present) are build-time tooling; the server runs with node. npm retains Vite as a
# peer dependency of SvelteKit in the production install, so remove the compilers
# explicitly. The compiled adapter-node output does not load them at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /app/node_modules/@esbuild \
    /app/node_modules/esbuild \
    /app/node_modules/@rolldown \
    /app/node_modules/rolldown \
    /app/node_modules/lightningcss \
    /app/node_modules/lightningcss-*

# Uploaded media lives under /data — mount a volume in prod. The database is
# Postgres, reached via DATABASE_URL (provided by compose, NOT baked into the
# image). The initial schema is created from ./database before the server process starts.
ENV MEDIA_DIR=/data/media \
    HOST=0.0.0.0 \
    PORT=3000 \
    BODY_SIZE_LIMIT=64M
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

# A start may rightly wait up to a minute for the database and then up to 90 seconds for the
# previous instance to let go of it, so failed checks only count after three minutes. Until
# the server first answers it is checked every 5 seconds (--start-interval needs Docker
# Engine 25 or later to build; older engines running the image check every 30 seconds).
HEALTHCHECK --interval=30s --timeout=4s --start-period=180s --start-interval=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.title="mira" \
      org.opencontainers.image.description="Mira — shared photo & video albums for trips and meetups (SvelteKit/adapter-node)" \
      org.opencontainers.image.licenses="MIT"

# Process 1 ignores a stop signal it has no handler for. Without tini that was the shell
# while init-db waited for the database, then node until the server had started (including
# the wait for the previous instance's lock), so `docker stop` during start-up waited out
# the whole stop period. tini passes the signal on: before the server is up the start-up
# simply ends; once it is up, node shuts down gracefully as before, finishing the video it
# is putting together before it releases the lock.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node scripts/init-db.mjs && exec node scripts/start.mjs"]
