#!/usr/bin/env bash
# Double-click this file on macOS to install and start the app.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Get the LTS build from https://nodejs.org,"
  echo "  then close this window and double-click this file again."
  echo
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi

echo
echo "  Starting. The first run takes a few minutes to install everything."
echo "  When it says \"Ready\", open http://localhost:3000 in your browser."
echo
npm run go
