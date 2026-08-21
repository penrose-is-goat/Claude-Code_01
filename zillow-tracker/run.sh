#!/usr/bin/env bash
# One command, from a fresh clone, to a running app with real Zillow data.
#
#   ./run.sh
#
# Everything below is idempotent — run it again any time.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Installing dependencies"
npm install --no-audit --no-fund

step "Preparing the database"
npx prisma generate
mkdir -p data
npx prisma db push --skip-generate

step "Loading the captured Zillow data"
# Replays real search results captured from Zillow's public pages through the live
# parser. With BRAVE_SEARCH_API_KEY set, swap this for a live sweep of your own area:
#   npm run harvest -- --place "Your City, ST" --budget 60
if [ -f captures/boulder-co-2026-08-21.json ]; then
  npx tsx scripts/harvest.ts --place "Boulder, CO" --from captures/boulder-co-2026-08-21.json || true
fi

step "Checking it works"
npx vitest run --reporter=dot 2>&1 | tail -4

step "Starting the app"
echo "Open http://localhost:3000"
echo
echo "The app starts EMPTY on purpose — no area is built in."
echo "On the dashboard, type a place or draw an area to search."
echo "Captured data currently covers Boulder, CO; searching anywhere else"
echo "returns nothing until you harvest that area."
echo
npm run dev
