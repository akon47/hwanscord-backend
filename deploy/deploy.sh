#!/usr/bin/env bash
# Pull the requested image tag and (re)start the backend stack. Run on the VM as `deploy` in /srv/hwanscord/backend.
#   APP_TAG=123 ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

export APP_TAG="${APP_TAG:-latest}"
SECRETS_DIR=/srv/hwanscord/secrets
DATA_DIR=/srv/hwanscord/data

for f in mongodb-uri jwt-secret mongo-root-password mongo-app-password cf-turn-key-id cf-turn-api-token cf-analytics-token; do
  if [ ! -s "$SECRETS_DIR/$f" ]; then
    echo "missing secret file: $SECRETS_DIR/$f" >&2
    exit 1
  fi
done
# containers run as other uids (mongo 999, node 1000) and read the files through bind mounts:
# files must be world-readable, the 0700 directory keeps them private on the host.
# optional secrets: compose needs the files to exist; empty means the feature is off
for f in github-client-id github-client-secret; do
  [ -e "$SECRETS_DIR/$f" ] || : > "$SECRETS_DIR/$f"
done
chmod 700 "$SECRETS_DIR"
chmod 644 "$SECRETS_DIR"/*

mkdir -p "$DATA_DIR/uploads/avatars" "$DATA_DIR/uploads/attachments" "$DATA_DIR/mongo" /srv/hwanscord/legacy
# the api container runs as uid 1000 (node) and must own the uploads directory
if [ "$(stat -c %u "$DATA_DIR/uploads")" != "1000" ]; then
  sudo chown -R 1000:1000 "$DATA_DIR/uploads" 2>/dev/null || chown -R 1000:1000 "$DATA_DIR/uploads" || true
fi

echo "== deploying hwanscord-backend:$APP_TAG"
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "== waiting for /healthz"
for i in $(seq 1 30); do
  if body=$(curl -fsS --max-time 3 http://127.0.0.1:8080/healthz 2>/dev/null); then
    echo "$body"
    exit 0
  fi
  sleep 2
done
echo "api did not become healthy in time" >&2
docker compose ps
docker compose logs --tail=100 api
exit 1
