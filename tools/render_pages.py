"""Renderiza el PDF del TFG a imágenes WebP de página única para la web del cuaderno.

Cada página se guarda con el blanco convertido en transparencia (la tinta lleva
alfa), para poder componerla sobre papel normal o papel cebolla en la web.

    python tools/render_pages.py            -> web/img/a/  (130 ppp, vista general)
    python tools/render_pages.py --hd       -> web/img/h/  (230 ppp, para ampliar)

Nombres: p01 = portada; pNN-L / pNN-R = mitad izquierda / derecha del pliego NN.
"""
import io
import sys
from pathlib import Path

import fitz
import numpy as np
from PIL import Image

HD = "--hd" in sys.argv
DPI = 230 if HD else 130
QUALITY = 86 if HD else 82

root = Path(__file__).resolve().parent.parent
pdf_path = root / "TFG_Ene25_Ridruejo_Tunon_Isabel (1).pdf"
out = root / "web" / "img" / ("h" if HD else "a")
out.mkdir(parents=True, exist_ok=True)


def unmultiply_white(im):
    """Convierte una página sobre blanco en tinta con alfa (composición exacta sobre blanco)."""
    a = np.asarray(im).astype(np.float32) / 255.0
    alpha = 1.0 - a.min(axis=2)
    safe = np.maximum(alpha, 1e-4)[..., None]
    rgb = np.clip((a - (1.0 - alpha[..., None])) / safe, 0, 1)
    rgba = np.dstack([rgb, alpha])
    return Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), "RGBA")


def save(im, name):
    unmultiply_white(im).save(out / f"{name}.webp", "WEBP", quality=QUALITY, method=4)


doc = fitz.open(pdf_path)
for i, page in enumerate(doc, start=1):
    im = Image.open(io.BytesIO(page.get_pixmap(dpi=DPI).tobytes("png"))).convert("RGB")
    if page.rect.width < page.rect.height:
        save(im, f"p{i:02d}")
    else:
        w = im.width // 2
        save(im.crop((0, 0, w, im.height)), f"p{i:02d}-L")
        save(im.crop((w, 0, 2 * w, im.height)), f"p{i:02d}-R")
    print(f"pdf {i}/{len(doc)}", file=sys.stderr)
