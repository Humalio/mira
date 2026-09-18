#!/usr/bin/env sh
# Production adapter-node smoke test.
#
# Builds the REAL server bundle and boots it, which is the only thing that
# exercises the production adapter and initialization entrypoint. `vite dev` never runs
# that path, so this catches production boot and initialization breakage BEFORE prod.
#
# Needs a reachable Postgres via DATABASE_URL — defaults to the compose.dev.yaml
# db on localhost. Bring it up first:  docker compose -f compose.dev.yaml up -d db
#
# Usage:  ./scripts/smoke.sh
set -e

export DATABASE_URL="${DATABASE_URL:-postgres://mira:mira@127.0.0.1:5432/mira}"
export MEDIA_DIR="${MEDIA_DIR:-./data/media}"
export PORT="${PORT:-3000}"
# adapter-node binds 0.0.0.0 by default; a smoke run must not expose a throwaway
# server (dummy OAuth credentials, test database) to the LAN.
export HOST="${HOST:-127.0.0.1}"
export ORIGIN="${ORIGIN:-http://127.0.0.1:$PORT}"
export PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-$ORIGIN}"
export NODE_ENV=production
# An isolated smoke secret; supply AUTH_SECRET explicitly to test a deployment's
# configured secret. Never use this generated value for persistent user sessions.
export AUTH_SECRET="${AUTH_SECRET:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(33).toString("base64"))')}"
# Smoke checks startup, not an OAuth exchange. Use inert provider credentials when
# the caller has not supplied a real provider pair.
export AUTH_GOOGLE_ID="${AUTH_GOOGLE_ID:-smoke-only}"
export AUTH_GOOGLE_SECRET="${AUTH_GOOGLE_SECRET:-smoke-only-no-provider-exchange}"

echo "→ building production bundle (npm run build)…"
npm run build >/dev/null

echo "→ applying database database initialization…"
node scripts/init-db.mjs

echo "→ booting 'node scripts/start.mjs' on PORT=$PORT …"
node scripts/start.mjs & SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; do
  # Fail fast if the process already died (this is the exit-13 unsettled-TLA case).
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "✗ FAIL — server process exited during boot (likely unsettled top-level await / initialization error)"
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -gt 30 ]; then
    echo "✗ FAIL — server never served 200 within ~15s"
    exit 1
  fi
  sleep 0.5
done

echo "✓ PASS — production server booted and GET / -> 200"
