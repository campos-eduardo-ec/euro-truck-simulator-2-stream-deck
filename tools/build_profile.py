"""Gera o perfil 'Astronauta - Caminhão' do Stream Deck + (8 teclas + 4 dials por página).

O perfil é um .streamDeckProfile (zip) com um manifest raiz e um manifest por página. Ele vai
dentro do plugin (digital.astronauta.ets2.sdPlugin/profiles/): o app oferece instalar junto com o
plugin, e o plugin abre o perfil sozinho quando o jogo inicia. NUNCA escrever direto em
ProfilesV3: o app do Stream Deck mantém os perfis em memória e sobrescreve.

Cada ação é validada contra o manifest.json do plugin (existe? é tecla ou dial?) e cada página
precisa ter exatamente 8 teclas e 4 dials.

    python3 tools/build_profile.py            # grava o perfil
    python3 tools/build_profile.py --check    # só valida
"""
from __future__ import annotations

import json
import sys
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SD = ROOT / "digital.astronauta.ets2.sdPlugin"
OUT = SD / "profiles" / "Astronauta - Caminhao.streamDeckProfile"
NAME = "Astronauta - Caminhão"
PROFILE_ID = "7C2E9A41-5B83-4F0D-9E62-1A4D8B3C7F95"  # fixo: reimportar substitui, não duplica
DEVICE_MODEL = "20GBD9901"  # Stream Deck +
TR = "digital.astronauta.ets2"


def a(action, **settings):
    return (f"{TR}.{action}", settings)


# Troca de página: deslizar no touch strip.
PAGES = [
    {
        "key": "caminhao-dirigir",
        "name": "Caminhão · Dirigir",
        "keys": [a("ignicao"), a("freiomao"), a("piscaesq"), a("piscadir"),
                 a("alerta"), a("farolalto"), a("buzina"), a("velocidade")],
        "dials": [a("dialpiloto"), a("dialretarder"), a("dialluzes"), a("diallimpador")],
    },
    {
        "key": "caminhao-viagem",
        "name": "Caminhão · Viagem",
        "keys": [a("reboque"), a("mapa"), a("limite"), a("horario"),
                 a("combustivel"), a("descanso"), a("giroflex"), a("lampejo")],
        "dials": [a("dialinfo", grupo="viagem"), a("dialinfo", grupo="entrega"),
                  a("dialcamera"), a("dialradio")],
    },
    {
        "key": "caminhao-oficina",
        "name": "Caminhão · Eixos e oficina",
        "keys": [a("diferencial"), a("eixo"), a("eixoreboque"), a("buzinaar"),
                 a("desgaste"), a("danocarga"), a("ar"), a("espelhos")],
        "dials": [a("dialcambio"), a("dialinfo", grupo="caminhao"),
                  a("dialsuspensao"), a("dialjanelas")],
    },
]


def validate(manifest):
    actions = {x["UUID"]: x for x in manifest.get("Actions", [])}
    errors = []
    for page in PAGES:
        if len(page["keys"]) != 8:
            errors.append(f"[{page['key']}] {len(page['keys'])} teclas (esperado 8)")
        if len(page["dials"]) != 4:
            errors.append(f"[{page['key']}] {len(page['dials'])} dials (esperado 4)")
        for kind, items in (("Keypad", page["keys"]), ("Encoder", page["dials"])):
            for uuid_, _ in items:
                act = actions.get(uuid_)
                if act is None:
                    errors.append(f"[{page['key']}] ação inexistente no manifest: {uuid_}")
                elif kind not in act.get("Controllers", ["Keypad"]):
                    errors.append(f"[{page['key']}] {uuid_} não é {kind}")
    return actions, errors


def page_id(page):
    # Mesma semente do gerador antigo (repo stream-deck-plugins): perfis já importados continuam iguais.
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"deck-plugins/{PROFILE_ID}/page/{page['key']}")).upper()


def build_page(page, manifest, actions):
    controllers = []
    for kind, items in (("Keypad", page["keys"]), ("Encoder", page["dials"])):
        out = {}
        for i, (uuid_, settings) in enumerate(items):
            pos = f"{i % 4},{i // 4}"
            out[pos] = {
                "ActionID": str(uuid.uuid5(uuid.NAMESPACE_URL, f"deck-plugins/{PROFILE_ID}/{page['key']}/{kind}/{pos}")),
                "LinkedTitle": True,
                "Name": actions[uuid_]["Name"],
                "Plugin": {"Name": manifest["Name"], "UUID": TR, "Version": manifest["Version"]},
                "Resources": None,
                "Settings": dict(settings),
                "State": 0,
                "States": [{"FTitle": "", "Title": ""}],
                "UUID": uuid_,
            }
        controllers.append({"Type": kind, "Actions": out})
    return {"Controllers": controllers, "Icon": "", "Name": page["name"]}


def main():
    manifest = json.loads((SD / "manifest.json").read_text(encoding="utf-8-sig"))
    actions, errors = validate(manifest)
    if errors:
        print("ERROS:")
        for e in errors:
            print("  -", e)
        raise SystemExit(1)
    print(f"{len(PAGES)} páginas, {sum(len(p['keys']) for p in PAGES)} teclas, "
          f"{sum(len(p['dials']) for p in PAGES)} dials, validado contra o manifest")
    if "--check" in sys.argv:
        return
    ids = [page_id(p).lower() for p in PAGES]
    root = {
        "Device": {"Model": DEVICE_MODEL},
        "Name": NAME,
        # A página padrão fica FORA da lista Pages (que traz as demais).
        "Pages": {"Current": ids[0], "Default": ids[0], "Pages": ids[1:]},
        "Version": "3.0",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{PROFILE_ID}.sdProfile/manifest.json", json.dumps(root, ensure_ascii=False, indent=2))
        for p in PAGES:
            z.writestr(f"{PROFILE_ID}.sdProfile/Profiles/{page_id(p)}/manifest.json",
                       json.dumps(build_page(p, manifest, actions), ensure_ascii=False, indent=2))
    print("gravado:", OUT)


if __name__ == "__main__":
    main()
