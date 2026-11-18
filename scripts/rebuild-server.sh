#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export PATH="$PWD/.runtime/node/bin:$PATH"
.venv/bin/python -m pip install -r requirements.txt
npm ci --no-audit --no-fund
npm run build
.venv/bin/python -m unittest discover -s tests -v
systemctl --user daemon-reload
systemctl --user restart nexarm-console.service nexarm-control.service
systemctl --user is-active nexarm-console.service nexarm-control.service
