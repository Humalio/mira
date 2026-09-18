#!/usr/bin/env sh
# Validate this exact tree, every DB test, and the runtime image. Docker required.
# All containers are disposable and publish no host ports.
set -eu
RUN_ID="mira-verify-$$"
DB="$RUN_ID-db"
CHECK="$RUN_ID-check"
IMAGE="$RUN_ID-runtime"
cleanup() {
  docker rm -fv "$CHECK" "$DB" >/dev/null 2>&1 || true
  docker image rm "$CHECK" "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build --target builder -t "$CHECK" .
docker run -d --name "$DB" -e POSTGRES_USER=mira -e POSTGRES_PASSWORD=mira -e POSTGRES_DB=mira postgres:18-alpine >/dev/null
i=0
until docker exec "$DB" pg_isready -U mira -d mira >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 60 ] || exit 1
  sleep 1
done
docker run --rm --name "$CHECK" --network "container:$DB" \
  -e TEST_DATABASE_URL=postgres://mira:mira@127.0.0.1:5432/mira \
  -e TEST_REQUIRE_FFMPEG=1 "$CHECK" sh -ec '
    npm run lint
    npm run check
    npm audit --omit=dev --audit-level=high
    npm run test:database
    # The compression tests skip themselves without ffmpeg, and this build stage has
    # none, so a release could pass without one video ever being encoded. Install the
    # ffmpeg the runtime image ships (same Debian release); TEST_REQUIRE_FFMPEG makes
    # those tests fail instead of skipping when it is missing.
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null
    ffmpeg -version | head -n 1
    npm test
    npm run test:integration
  '
docker build -t "$IMAGE" .
sh scripts/image-smoke.sh "$IMAGE"
