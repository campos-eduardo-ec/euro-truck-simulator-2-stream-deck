# Euro Truck Simulator 2 · Stream Deck + plugin

Control Euro Truck Simulator 2 and American Truck Simulator from an Elgato Stream Deck + on macOS, and see live truck data on its keys and touch strip. Commands go straight into the game through the official SCS SDK input API: no keyboard simulation, and the game does not need to be the window in front.

- **122 game commands** (ignition, parking brake, blinkers, lights, cruise control, retarder, gears, trailer, cameras, radio, Route Advisor...), each usable from any key.
- **30 live readings**: speed, speed limit, distance and time to destination, game time, next rest, cargo, deadline, income, cargo damage, fuel and range, RPM, gear, air pressure, temperatures, odometer and wear by part.
- **10 dials**: cruise control, retarder, headlights, wipers, camera, radio, gearbox, suspension, windows and an info dial that cycles readings.
- A ready-made **profile "Astronauta - Caminhão"** with 3 pages of 8 keys + 4 dials, installed with the plugin and opened automatically when the game starts. Swipe the touch strip to change pages.

Keys show the real state when the game reports it (parking brake on, blinker flashing, cruise at 72 km/h). With the game closed they say "abra o jogo" instead of showing made-up numbers. ATS uses mph, gallons and dollars.

## How it works

```
Stream Deck app ──WebSocket── plugin (Node, digital.astronauta.ets2.sdPlugin)
                                   │ TCP 127.0.0.1:47831, one JSON line per update
                                   ▼
             bridge inside the game (native/astronauta_ets2.dylib, SCS SDK 1.14)
```

The bridge only listens on localhost. Set `ASTRONAUTA_ETS2_PORT` to change the port.

## Install (macOS)

1. **Build** (see below) or use the files a release provides: `digital.astronauta.ets2.streamDeckPlugin` and `astronauta_ets2.dylib`.
2. **Plugin**: double-click `digital.astronauta.ets2.streamDeckPlugin`. The Stream Deck app installs the plugin and offers the profile.
3. **Bridge**: with the game closed, open the game folder in Finder (Steam › Euro Truck Simulator 2 › Manage › Browse local files), right-click `Euro Truck Simulator 2.app` › Show Package Contents, and copy `astronauta_ets2.dylib` into `Contents/MacOS/plugins/` (create the `plugins` folder if needed). macOS may ask for permission to change the app: allow it in System Settings › Privacy & Security › App Management.
4. Start the game. It warns once that it found an SDK plugin: accept it. The Stream Deck + switches to the truck profile.

For American Truck Simulator, repeat step 3 inside `American Truck Simulator.app`. After a game update, check that the `plugins` folder is still inside the app.

## Build from source

Requires Node 20+, Python 3 (with Pillow only to redraw icons), Xcode command line tools and the official [SCS Telemetry SDK 1.14](https://modding.scssoft.com/wiki/Documentation/Engine/SDK/Telemetry), downloaded separately (it is not in this repository).

```sh
SCS_SDK=/path/to/scs_sdk_1_14 tools/package.sh    # manifest, profile, bridge and the .streamDeckPlugin, in dist/
node tools/build-manifest.js                      # manifest.json from bin/catalog.js
python3 tools/build_profile.py                    # profile from the manifest
python3 tools/make-icons.py                       # icons
```

The game on macOS runs as x86_64 (through Rosetta on Apple Silicon), so the bridge is built for x86_64.

`digital.astronauta.ets2.sdPlugin/bin/catalog.js` is the single source of truth for commands, readings and dials. Add an entry there, then regenerate the manifest and the profile.

## Tests

```sh
SCS_SDK=/path/to/scs_sdk_1_14 native/test/run.sh  # builds the bridge and a fake game that loads it
node test/fake_sd_ets2.js                         # fake Stream Deck + real plugin + real bridge
```

The end-to-end test presses keys, turns dials and checks both ends: the command that reached the fake game and the image drawn on the key.

## Português

Plugin para controlar o Euro Truck Simulator 2 e o American Truck Simulator pelo Stream Deck + no Mac: 122 comandos do jogo, 30 leituras ao vivo, 10 dials e o perfil "Astronauta - Caminhão" (3 páginas, 8 teclas e 4 dials cada), que abre sozinho quando o jogo inicia. Os comandos entram pelo SDK oficial da SCS, sem simular teclado.

Instalação: dois cliques no `.streamDeckPlugin`; com o jogo fechado, copie o `astronauta_ets2.dylib` para `Euro Truck Simulator 2.app/Contents/MacOS/plugins/` pelo Finder (Mostrar Conteúdo do Pacote) e autorize em Ajustes do Sistema › Privacidade e Segurança › Gerenciamento de Apps se o macOS pedir. Ao abrir o jogo, aceite o aviso de plugin do SDK.

Desenvolvimento acelerado por IA, com revisão humana. O SDK da SCS é baixado à parte e não fica no repositório.

## Development and contributions

AI assisted development, with human review and personal use before publication. This is not a guarantee of compatibility with every game version.

Source is public so others can inspect it, learn from it and build on it. Forks and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Only the maintainer can accept changes into this repository.

## Credits and license

Original code is MIT-licensed; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Euro Truck Simulator 2, American Truck Simulator, the SCS SDK, Stream Deck and Elgato belong to their owners. This is an unofficial community project, not affiliated with SCS Software or Elgato.
