#!/usr/bin/env python3
"""Held-out validation photos (different layouts and backgrounds) with known corners."""
import json, os, subprocess, sys, math
OUT = sys.argv[1]; SRC = sys.argv[2]
os.makedirs(OUT, exist_ok=True); os.chdir(OUT)
def mk(*a): subprocess.run(["magick", *map(str, a)], check=True)
W, H = 3024, 4032
# sources
mk(f"{SRC}/invoice.png", "-colorspace", "sRGB", "-type", "TrueColor", "-fuzz", "5%", "-fill", "#f3e7a2", "-opaque", "white", "PNG24:yellow.png")
def rot(cx, cy, w, h, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    return [(cx + x * c - y * s, cy + x * s + y * c) for x, y in [(-w/2, -h/2), (w/2, -h/2), (w/2, h/2), (-w/2, h/2)]]
cases = {
  "rot35": (W, H, ["-size", f"{W}x{H}", "plasma:#202830-#40505a", "-blur", "0x4"], f"{SRC}/receipt.png", (1200, 2700), rot(1500, 2000, 1100, 2400, 35)),
  "yellow": (W, H, ["-size", f"{W}x{H}", "xc:#9a9a96", "-attenuate", "0.5", "+noise", "Gaussian"], "yellow.png", (1700, 2200), [(450, 700), (2600, 600), (2700, 3400), (380, 3500)]),
  "landscape": (H, W, ["-size", f"{H}x{W}", "plasma:#3a3f2a-#5a5a40", "-blur", "0x5"], f"{SRC}/invoice.png", (1700, 2200), [(1100, 350), (2950, 420), (3050, 2750), (1000, 2700)]),
  "marble": (W, H, ["-size", f"{W}x{H}", "plasma:#c8c8c8-#e8e8e8", "-colorspace", "gray", "-blur", "0x2"], f"{SRC}/invoice.png", (1700, 2200), [(400, 800), (2600, 700), (2750, 3400), (300, 3500)]),
  "two": (W, H, ["-size", f"{W}x{H}", "plasma:#4a3020-#2a1810", "-blur", "0x4", "-fill", "#f8f6f0", "-draw", "polygon 2300,2600 2900,2650 2850,3900 2250,3850"], f"{SRC}/receipt.png", (1200, 2700), [(500, 500), (1900, 600), (2000, 3600), (380, 3500)]),
  "handheld": (W, H, ["-size", f"{W}x{H}", "xc:#7a6a58", "-attenuate", "0.8", "+noise", "Gaussian", "-blur", "0x3"], f"{SRC}/receipt.png", (1200, 2700), [(780, 520), (2240, 640), (2420, 3700), (560, 3560)]),
  "closeup": (W, H, ["-size", f"{W}x{H}", "plasma:#503828-#302018", "-blur", "0x4"], f"{SRC}/invoice.png", (1700, 2200), [(120, 260), (2900, 160), (2960, 3880), (60, 3950)]),
}
truth = {}
for name, (w, h, bgspec, src, (sw, sh), quad) in cases.items():
    mk(*bgspec, "bg.png")
    spec = " ".join(f"{a[0]},{a[1]} {b[0]},{b[1]}" for a, b in zip([(0, 0), (sw, 0), (sw, sh), (0, sh)], quad))
    extra = []
    if name == "handheld":
        extra = ["(", "-size", f"{w}x{h}", "radial-gradient:white-#606060", ")", "-compose", "multiply", "-composite", "-motion-blur", "0x4+30"]
    mk("bg.png", "(", src, "-alpha", "set", "-virtual-pixel", "transparent", "-background", "none",
       "-define", f"distort:viewport={w}x{h}+0+0", "-distort", "Perspective", spec, ")", "-compose", "over", "-composite",
       *extra, "-attenuate", "0.3", "+noise", "Gaussian", "-quality", "60" if name == "handheld" else "90", f"{name}.jpg")
    truth[name] = quad
os.remove("bg.png")
json.dump(truth, open("truth.json", "w"), indent=1)
print("ok")
