"""Desenha os ícones PNG do plugin do caminhão (silhueta simples, cores do sistema visual).

    python3 tools/make-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "digital.astronauta.ets2.sdPlugin" / "imgs"
OUT.mkdir(parents=True, exist_ok=True)
BG, ACC, FG = (16, 21, 28, 255), (239, 152, 93, 255), (240, 246, 252, 255)


def truck(size, bg=True, color=ACC, mono=False):
    s = size * 4  # desenha grande e reduz, para suavizar
    im = Image.new("RGBA", (s, s), BG if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = FG if mono else color
    u = s / 32
    # baú
    d.rounded_rectangle([3 * u, 9 * u, 19 * u, 22 * u], radius=1.2 * u, fill=c)
    # cabine
    d.polygon([(20 * u, 12 * u), (25.5 * u, 12 * u), (29 * u, 17 * u), (29 * u, 22 * u), (20 * u, 22 * u)], fill=c)
    d.polygon([(21.5 * u, 13.5 * u), (25 * u, 13.5 * u), (27.3 * u, 17 * u), (21.5 * u, 17 * u)], fill=BG if bg else (0, 0, 0, 0))
    # rodas
    for x in (8, 15, 25):
        d.ellipse([(x - 3) * u, 20.5 * u, (x + 3) * u, 26.5 * u], fill=BG if bg else (0, 0, 0, 0))
        d.ellipse([(x - 2.2) * u, 21.3 * u, (x + 2.2) * u, 25.7 * u], fill=c)
    return im.resize((size, size), Image.LANCZOS)


def save(name, size, **kw):
    truck(size, **kw).save(OUT / f"{name}.png")
    truck(size * 2, **kw).save(OUT / f"{name}@2x.png")


save("icon", 256)                      # ícone do plugin
save("category", 28, bg=False, mono=True)  # lista de ações (monocromático, fundo transparente)
save("action", 20, bg=False, mono=True)
save("key", 72)                        # imagem padrão da tecla antes do primeiro desenho
print("ícones em", OUT)
