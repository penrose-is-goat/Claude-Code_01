#!/usr/bin/env bash
# One command to get the app running. Safe to re-run.
set -e
cd "$(dirname "$0")"

echo "==> Installing dependencies (first run takes ~30s)"
npm install --no-audit --no-fund --silent

echo "==> Creating the database"
npx prisma generate >/dev/null 2>&1
mkdir -p data
npx prisma db push --skip-generate >/dev/null 2>&1

echo "==> Setting up your areas"
npx tsx prisma/seed.ts

echo "==> Loading listings and open houses"
npx tsx scripts/poll.ts

echo ""
echo "======================================================"
echo "  Starting the app.  Open:  http://localhost:3000"
echo "  Open houses page:   http://localhost:3000/open-houses"
echo "  Press Ctrl+C to stop."
echo "======================================================"
echo ""
npm run dev
