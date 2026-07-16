#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Update a self-hosted Nous instance to the latest release.
#
#   1. pulls the latest code from your current branch
#   2. rebuilds + restarts the containers (api, worker, mcp, frontend)
#   3. reminds you to apply any new database migrations
#
# Run it from the repo root on your server:  ./update.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

echo "→ Pulling latest code…"
git pull --ff-only

# Stamp the running build so the in-app version widget can show it + detect updates.
COMMIT=$(git rev-parse --short HEAD)
if grep -q '^APP_COMMIT=' nous.env 2>/dev/null; then
  sed -i.bak "s|^APP_COMMIT=.*|APP_COMMIT=${COMMIT}|" nous.env && rm -f nous.env.bak
else
  echo "APP_COMMIT=${COMMIT}" >> nous.env
fi
echo "  build: ${COMMIT}"

echo "→ Rebuilding and restarting containers (this can take a few minutes)…"
docker compose --env-file nous.env up -d --build

echo
echo "✓ App updated and running."
echo
echo "⚠  Database changes are NOT applied automatically."
echo "   If supabase/migrations/ has new files since your last update, open each"
echo "   (newest by date) in your Supabase SQL editor and run it. They're"
echo "   idempotent, so re-running an already-applied one is safe."
echo "   (A brand-new install instead runs supabase/schema.sql once.)"
