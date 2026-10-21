#!/usr/bin/env bash
# One-time migration from the v1 stack (mongo 4.4 + node-app with ./avatar and ./attachments bind mounts).
#   ./migrate-from-v1.sh <old-mongo-container> <old-avatar-dir> <old-attachments-dir>
#   e.g. ./migrate-from-v1.sh hwanscord-backend_mongo_1 /home/hwan/hwanscord-backend/avatar /home/hwan/hwanscord-backend/attachments
# Requires the v2 stack to be up (deploy.sh) with an EMPTY hwanscord database.
set -euo pipefail
cd "$(dirname "$0")"

OLD_MONGO="${1:?old mongo container name}"
OLD_AVATAR_DIR="${2:?old avatar dir}"
OLD_ATTACHMENT_DIR="${3:?old attachments dir}"
SECRETS_DIR=/srv/hwanscord/secrets
LEGACY_DIR=/srv/hwanscord/legacy
ROOT_PW=$(cat "$SECRETS_DIR/mongo-root-password")

echo "== 1/4 dump v1 database from $OLD_MONGO"
# v1 compose used root/root for the admin user (docker-compose.yml of the old repo)
docker exec "$OLD_MONGO" sh -c 'mongodump --quiet --username root --password root --authenticationDatabase admin --db hwanscord --archive --gzip' \
  > /tmp/hwanscord-v1.archive.gz
ls -la /tmp/hwanscord-v1.archive.gz

echo "== 2/4 restore into hwanscord-mongo"
docker exec -i -e MONGO_PW="$ROOT_PW" hwanscord-mongo sh -c \
  'mongorestore --quiet --username root --password "$MONGO_PW" --authenticationDatabase admin --archive --gzip --nsInclude "hwanscord.*" --drop' \
  < /tmp/hwanscord-v1.archive.gz

echo "== 3/4 copy legacy files into $LEGACY_DIR"
mkdir -p "$LEGACY_DIR/avatar" "$LEGACY_DIR/attachments"
cp -an "$OLD_AVATAR_DIR"/. "$LEGACY_DIR/avatar/" 2>/dev/null || true
cp -an "$OLD_ATTACHMENT_DIR"/. "$LEGACY_DIR/attachments/" 2>/dev/null || true
sudo chown -R 1000:1000 "$LEGACY_DIR" 2>/dev/null || true

echo "== 4/4 run schema migration inside the api container"
docker compose exec -T -e LEGACY_AVATAR_DIR=/legacy/avatar -e LEGACY_ATTACHMENT_DIR=/legacy/attachments api \
  node dist/scripts/migrate-legacy.js

rm -f /tmp/hwanscord-v1.archive.gz
echo "== done. Verify with: curl -s http://127.0.0.1:8080/healthz ; then stop the v1 stack."
