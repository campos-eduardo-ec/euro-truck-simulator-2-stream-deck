#!/bin/sh
# Monta tudo do plugin do caminhão e gera os dois arquivos de instalação em dist/:
#   digital.astronauta.ets2.streamDeckPlugin   (dois cliques: instala o plugin e o perfil)
#   astronauta_ets2.dylib                      (a ponte, vai dentro do jogo; ver INSTALL.md)
#
#   SCS_SDK=/pasta/do/scs_sdk_1_14 tools/package.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SD=$ROOT/digital.astronauta.ets2.sdPlugin
DIST=$ROOT/dist
mkdir -p "$DIST" "$SD/profiles"

node "$ROOT/tools/build-manifest.js"
python3 "$ROOT/tools/build_profile.py" >/dev/null
"$ROOT/native/build.sh" >/dev/null
cp "$ROOT/native/build/astronauta_ets2.dylib" "$DIST/"

rm -f "$DIST/digital.astronauta.ets2.streamDeckPlugin"
(cd "$ROOT" && zip -qr -X "$DIST/digital.astronauta.ets2.streamDeckPlugin" digital.astronauta.ets2.sdPlugin -x "*.DS_Store")
echo "pronto em $DIST:"
ls -la "$DIST"
