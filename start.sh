#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -x .runtime/node/bin/node ]; then PATH="$PWD/.runtime/node/bin:$PATH"; export PATH; fi
if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi
if ! .venv/bin/python -c 'import serial, numpy' 2>/dev/null; then .venv/bin/python -m pip install -r requirements.txt; fi
if [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
if [ "$(uname -s)" = Darwin ]; then
  camera/build.sh || printf "NexArm camera helper could not be built.\n" >&2
fi
npm run build
exec .venv/bin/python -m nexarm.server "$@"
