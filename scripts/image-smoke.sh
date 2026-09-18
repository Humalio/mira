#!/usr/bin/env sh
# Boot the BUILT production image against a throwaway Postgres before it is pushed.
#
# Exercises exactly what a promote to :stable would run: the image's initial setup
# entrypoint over the day-zero schema, then `node scripts/start.mjs` (single-instance
# lock, maintenance start-up) until GET / answers 200 inside the container.
#
# Usage:  sh scripts/image-smoke.sh <image:tag>
set -eu

IMAGE_REF="${1:?usage: image-smoke.sh <image:tag>}"
RUN_ID="mira-smoke-$$"
DB="${RUN_ID}-db"
APP="${RUN_ID}-app"
SECRET="$(head -c 33 /dev/urandom | base64)"

cleanup() {
  docker rm -fv "$APP" "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$DB" -e POSTGRES_USER=mira -e POSTGRES_PASSWORD=mira -e POSTGRES_DB=mira \
  postgres:18-alpine >/dev/null
i=0
until docker exec "$DB" pg_isready -U mira -d mira >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "✗ Postgres never became ready"; exit 1; }
  sleep 1
done
# pg_isready can pass during the image's init restart; wait for a real query.
until docker exec "$DB" psql -U mira -d mira -c 'select 1' >/dev/null 2>&1; do sleep 1; done

# Share the database container's network namespace so the app reaches 127.0.0.1:5432.
docker run -d --name "$APP" --network "container:$DB" \
  -e DATABASE_URL=postgres://mira:mira@127.0.0.1:5432/mira \
  -e ORIGIN=http://127.0.0.1:3000 -e PUBLIC_ORIGIN=https://photos.example.org \
  -e AUTH_SECRET="$SECRET" -e AUTH_GOOGLE_ID=smoke-only -e AUTH_GOOGLE_SECRET=smoke-only \
  -e MIRA_ADMIN_IDENTITIES=google:smoke \
  "$IMAGE_REF" >/dev/null

i=0
until docker exec "$APP" node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" != "true" ]; then
    echo "✗ FAIL — container exited during boot:"; docker logs "$APP" 2>&1 | tail -40; exit 1
  fi
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "✗ FAIL — no 200 within ~60s:"; docker logs "$APP" 2>&1 | tail -40; exit 1
  fi
  sleep 1
done

# Re-running the entrypoint's database initialization against the now-current schema must be a no-op.
docker exec "$APP" node scripts/init-db.mjs >/dev/null
echo "✓ PASS — image initialized a fresh database and served GET / -> 200"

# Exercise the emitted production assets and header, rather than only config text.
docker exec "$APP" node --input-type=module -e '
  import { readdirSync, readFileSync } from "node:fs";
  const response = await fetch("http://127.0.0.1:3000/");
  const csp = response.headers.get("content-security-policy") || "";
  if (!csp.includes("https://accounts.google.com") || !csp.includes("font-src")) throw new Error("OAuth/font policy missing");
  const assets = "build/client/_app/immutable/assets";
  for (const name of readdirSync(assets).filter((name) => name.endsWith(".css"))) {
    if (/data:(?:font|application\/(?:font|x-font))/.test(readFileSync(`${assets}/${name}`, "utf8"))) throw new Error("Font inlined despite self-only font policy");
  }
  const html = await response.text();
  if (!html.includes("mobile-web-app-capable")) throw new Error("Missing mobile web app metadata");
'
echo "✓ PASS — production fonts are self-hosted and OAuth redirects are allowed"

# Behind a proxy the request arrives on an internal address; what leaves the page must
# carry PUBLIC_ORIGIN. Only the built server shows whether the setting reaches the code.
docker exec "$DB" psql -U mira -d mira -c "
  insert into users (id, provider, provider_account_id) values ('smoke-user', 'google', 'smoke-owner');
  insert into albums (id, slug, name, owner_user_id) values ('smoke-album', 'smoke-album', 'Smoke', 'smoke-user');" >/dev/null
docker exec "$APP" node --input-type=module -e '
  const html = await (await fetch("http://127.0.0.1:3000/j/smoke-album")).text();
  for (const tag of [
    `<meta property="og:url" content="https://photos.example.org/j/smoke-album"`,
    `<meta property="og:image" content="https://photos.example.org/invite.png"`
  ]) if (!html.includes(tag)) throw new Error(`Invitation preview ignores PUBLIC_ORIGIN: missing ${tag}`);
'
echo "✓ PASS — invitation links carry PUBLIC_ORIGIN, not the address the request arrived on"

# Losing the dedicated session lock must stop this instance before it can keep
# serving alongside another owner. This targets only the throwaway smoke database.
LOCKS="$(docker exec "$DB" psql -U mira -d mira -Atc "select count(*) from pg_stat_activity where application_name = 'mira-singleton'")"
[ "$LOCKS" = "1" ] || { echo "✗ expected exactly one singleton connection"; exit 1; }
docker exec "$DB" psql -U mira -d mira -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'mira-singleton'" >/dev/null
i=0
while [ "$(docker inspect -f '{{.State.Running}}' "$APP")" = "true" ]; do
  i=$((i + 1)); [ "$i" -gt 20 ] && { echo "✗ server kept running after lock loss"; exit 1; }
  sleep 1
done
docker logs "$APP" 2>&1 | grep -q 'singleton lock connection lost' || { echo "✗ missing lock-loss diagnostic"; exit 1; }
echo "✓ PASS — singleton connection loss terminated the server"
