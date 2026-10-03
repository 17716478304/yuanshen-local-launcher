#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v pnpm >/dev/null
command -v uv >/dev/null
scripts/bootstrap-tools.sh
pnpm install --frozen-lockfile
uv sync --frozen --project sophon_server --python "${LAUNCHER_PYTHON:-python3.12}"
sophon_server/.venv/bin/python scripts/licenses.py
cd sophon_server
.venv/bin/python -m py_compile *.py
export SDKROOT="$(/usr/bin/arch -arm64 /usr/bin/xcrun --show-sdk-path)"
export CC="$(/usr/bin/arch -arm64 /usr/bin/xcrun --find clang)"
.venv/bin/python -m nuitka --standalone --disable-ccache --python-flag=isolated --include-module=certifi \
  --include-data-files="$(.venv/bin/python -c 'import certifi; print(certifi.where())')=certifi/cacert.pem" \
  --include-data-files=./hpatchz=./hpatchz --include-module=sophon_api --include-module=game_process --include-module=storage --include-module=uvicorn.loops.auto \
  --include-module=uvicorn.protocols.http.h11_impl --include-module=uvicorn.protocols.websockets.websockets_impl \
  --include-module=uvicorn.lifespan.on --output-filename=sophon-server --output-dir=./build \
  --assume-yes-for-downloads server.py
cd ..
YAAGL_CHANNEL_CLIENT=hk4ecn node build-app.js
