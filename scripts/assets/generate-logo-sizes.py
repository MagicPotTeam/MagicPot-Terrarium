"""Generate the small logo files the app draws at runtime.

The master logo (packages/runtime-assets/build/icon.png) is 4096 x 4096 and
stays where packaging needs it (installer, .exe / .icns / Linux icons). Drawing
it in the UI costs a 64 MB decode in the renderer at every start, and using it
as the window / drag icon costs the same in main. The UI and main use these
downscaled copies instead.

Usage (needs Pillow; run from the repository root after the logo changes):
    python3 scripts/assets/generate-logo-sizes.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "packages/runtime-assets/build/icon.png"
OUTPUTS = [
    # Title bar (26 CSS px) and sidebar (55 CSS px) at up to 2.3x.
    (ROOT / "packages/app/src/renderer/src/assets/logo-128.png", 128),
    # Sidebar on high-DPI screens (srcset).
    (ROOT / "packages/app/src/renderer/src/assets/logo-256.png", 256),
    # Linux window icon and the fallback canvas drag icon (main process).
    (ROOT / "packages/runtime-assets/resources/icon-256.png", 256),
]


def main() -> None:
    with Image.open(SOURCE) as source:
        source = source.convert("RGBA")
        for target, size in OUTPUTS:
            # Pillow resamples RGBA in premultiplied alpha, so the transparent
            # edge does not darken; LANCZOS keeps the outline crisp.
            small = source.resize((size, size), Image.LANCZOS)
            small.save(target, format="PNG", optimize=True)
            print(f"{target.relative_to(ROOT)}: {size} x {size}, {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
