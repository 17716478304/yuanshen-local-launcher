#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin .build-cache external/hk4e
base64 -d -i src/clients/secret.b64 -o src/clients/secret.ts
fetch() { curl --http1.1 -fL --retry 3 --connect-timeout 20 --max-time 180 "$1" -o "$2.tmp"; mv "$2.tmp" "$2"; }
if [ ! -f .build-cache/neutralino-4.11.0.zip ]; then
  fetch https://github.com/3Shain/neutralinojs/releases/download/v4.11.0-1/neutralinojs-v4.11.0.zip .build-cache/neutralino-4.11.0.zip
fi
echo "938078afc60d48435cd1ec47ac0a7f15c63cd61ee603c0b8095013b843fec08e  .build-cache/neutralino-4.11.0.zip" | shasum -a 256 -c -
unzip -oq .build-cache/neutralino-4.11.0.zip -d bin
if [ ! -s neutralino.js ]; then
  fetch https://github.com/neutralinojs/neutralino.js/releases/download/v3.9.0/neutralino.js neutralino.js
fi
echo "577771c2728e8d8fab112c7da95cb02fc98cca31a9e5e065459bcac20cfb1272  neutralino.js" | shasum -a 256 -c -
if [ ! -f .build-cache/protoc-31.1.zip ]; then
  fetch https://github.com/protocolbuffers/protobuf/releases/download/v31.1/protoc-31.1-osx-universal_binary.zip .build-cache/protoc-31.1.zip
fi
echo "99ea004549c139f46da5638187a85bbe422d78939be0fa01af1aa8ab672e395f  .build-cache/protoc-31.1.zip" | shasum -a 256 -c -
unzip -oqj .build-cache/protoc-31.1.zip bin/protoc -d bin
bin/protoc --proto_path=sophon_server --python_out=sophon_server sophon_server/*.proto
cp sidecar/hpatchz/hpatchz sophon_server/hpatchz
