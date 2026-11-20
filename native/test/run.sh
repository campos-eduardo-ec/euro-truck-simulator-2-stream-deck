#!/bin/sh
# Compila a ponte e o jogo falso (x86_64, como o jogo) e roda o teste.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
SDK=${SCS_SDK:?defina SCS_SDK com a pasta do SDK da SCS}
"$HERE/build.sh" >/dev/null
clang++ -arch x86_64 -std=c++17 -O1 -w -mmacosx-version-min=11.0 \
  -I"$SDK/include" -I"$SDK/include/common" -I"$SDK/include/amtrucks" -I"$SDK/include/eurotrucks2" \
  -o "$HERE/build/fake_game" "$HERE/test/fake_game.cpp"
arch -x86_64 "$HERE/build/fake_game" "$HERE/build/astronauta_ets2.dylib"
