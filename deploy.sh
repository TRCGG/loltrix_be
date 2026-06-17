#!/bin/bash
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Deploy start"

BACKUP_CANDIDATE="dist.backup.next"

rollback() {
  if [ -d "$BACKUP_CANDIDATE" ]; then
    log "Deploy failed. Restoring previous dist..."
    rm -rf dist
    mv "$BACKUP_CANDIDATE" dist
    pm2 reload ecosystem.config.cjs --update-env || true
  fi
}

trap rollback ERR

# 1. Validate new dist.zip before touching current dist
log "1. Validating dist.zip..."
test -f dist.zip
unzip -tq dist.zip

# 2. Move current dist to temporary backup
rm -rf "$BACKUP_CANDIDATE"
if [ -d dist ]; then
  log "2. Moving current dist to $BACKUP_CANDIDATE..."
  mv dist "$BACKUP_CANDIDATE"
else
  log "2. No existing dist to backup (first deploy)"
fi

# 3. Unzip new dist.zip
log "3. Unzipping dist.zip..."
unzip -o dist.zip
rm -f dist.zip

# 4. Reload pm2 with updated env vars
log "4. Reloading PM2..."
pm2 reload ecosystem.config.cjs --update-env

trap - ERR

# 5. Keep previous successful dist as dist.backup
log "5. Updating dist.backup..."
rm -rf dist.backup
if [ -d "$BACKUP_CANDIDATE" ]; then
  mv "$BACKUP_CANDIDATE" dist.backup
fi

log "Deploy complete!"
