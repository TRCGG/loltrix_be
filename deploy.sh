#!/bin/bash
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Deploy start"

# 1. Clean old dist
log "1. Removing old dist..."
rm -rf dist

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
