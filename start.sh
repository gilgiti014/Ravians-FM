#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
(sleep 2; (xdg-open http://localhost:3000/#/studio || open http://localhost:3000/#/studio) >/dev/null 2>&1) &
node server.js
