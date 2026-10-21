#!/usr/bin/env bash
# Nightly backup: mongodump (gzip archive) of the hwanscord database, keep the last 14; weekly tar of uploads, keep 4.
# Scheduled by a systemd timer (the VM is a minimal Ubuntu without cron), installed once as root:
#   cp /srv/hwanscord/backend/systemd/hwanscord-backup.* /etc/systemd/system/ && systemctl daemon-reload \n#     && systemctl enable --now hwanscord-backup.timer
set -euo pipefail

BACKUP_DIR=/srv/hwanscord/backups
SECRETS_DIR=/srv/hwanscord/secrets
DATA_DIR=/srv/hwanscord/data
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

ROOT_PW=$(cat "$SECRETS_DIR/mongo-root-password")
echo "[$STAMP] mongodump"
docker exec -e MONGO_PW="$ROOT_PW" hwanscord-mongo sh -c \
  'mongodump --quiet --username root --password "$MONGO_PW" --authenticationDatabase admin --db hwanscord --archive --gzip' \
  > "$BACKUP_DIR/mongo-$STAMP.archive.gz"
ls -1t "$BACKUP_DIR"/mongo-*.archive.gz | tail -n +15 | xargs -r rm -f

if [ "$(date +%u)" = "7" ]; then
  echo "[$STAMP] uploads tar"
  tar -C "$DATA_DIR" -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz" uploads
  ls -1t "$BACKUP_DIR"/uploads-*.tar.gz | tail -n +5 | xargs -r rm -f
fi
echo "[$STAMP] done: $(du -sh "$BACKUP_DIR" | cut -f1)"
