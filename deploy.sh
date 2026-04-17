#!/bin/bash
set -euo pipefail

# ==============================================================================
# 수동 롤백 방법 (배포 실패 시):
#
#   cd /home/gtrix/gtrix/loltrix 
#   rm -rf dist
#   mv dist.backup dist
#   pm2 reload ecosystem.config.cjs --update-env
#
# 주의:
#   - dist.backup 은 직전 성공 배포본 1개만 보관됨
#   - 첫 배포 실패 시에는 백업이 없으므로 수동 복구 불가 → 재배포 필요
# ==============================================================================

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Deploy start"

# 1. Backup current dist (keep most recent previous version)
if [ -d dist ]; then
  log "1. Backing up current dist to dist.backup..."
  rm -rf dist.backup
  mv dist dist.backup
else
  log "1. No existing dist to backup (first deploy)"
fi

# 2. Unzip new dist.zip
log "2. Unzipping dist.zip..."
unzip -o dist.zip
rm -f dist.zip

# 3. Copy runtime files into dist/
log "3. Copying package.json and swagger-output.json to dist/..."
cp package.json dist/
cp swagger-output.json dist/

# 4. Install production dependencies
log "4. Installing production dependencies..."
cd dist
npm install --omit=dev --ignore-scripts
cd ..

# 5. Reload pm2 with updated env vars
log "5. Reloading PM2..."
pm2 reload ecosystem.config.cjs --update-env

log "Deploy complete!"
