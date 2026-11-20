#!/bin/sh
# Compila a ponte do Euro Truck Simulator 2 / American Truck Simulator para o Mac.
# O jogo no Mac é x86_64 (roda pelo Rosetta nos Macs com Apple Silicon), então a ponte também.
#
#   SCS_SDK=/caminho/do/scs_sdk_1_14 ./build.sh
#
# O SDK oficial vem de https://modding.scssoft.com/wiki/Documentation/Engine/SDK/Telemetry
# (scs_sdk_1_14.zip). Não fica no repositório.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SDK=${SCS_SDK:?defina SCS_SDK com a pasta do SDK da SCS (a que tem include/)}
OUT=${OUT:-"$HERE/build"}
mkdir -p "$OUT"
clang++ -arch x86_64 -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter \
  -fPIC -shared -fvisibility=default \
  -mmacosx-version-min=11.0 \
  -I"$SDK/include" -I"$SDK/include/common" -I"$SDK/include/amtrucks" -I"$SDK/include/eurotrucks2" \
  -Wl,-install_name,astronauta_ets2.dylib \
  -o "$OUT/astronauta_ets2.dylib" "$HERE/astronauta_ets2.cpp"
codesign --force --sign - "$OUT/astronauta_ets2.dylib" >/dev/null 2>&1 || true
echo "gerado: $OUT/astronauta_ets2.dylib"
