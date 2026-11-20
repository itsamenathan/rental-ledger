#!/usr/bin/env python3
"""Labelled synthetic scan photos at phone resolution (3024x4032) with known page corners."""
import json, os, subprocess, sys

OUT = sys.argv[1]
W, H = 3024, 4032
os.makedirs(OUT, exist_ok=True)
os.chdir(OUT)


def mk(*args):
    subprocess.run(["magick", *map(str, args)], check=True)


# Sources
args = ["-size", "1700x2200", "xc:white", "-font", "DejaVu-Sans", "-fill", "#222", "-pointsize", "64",
        "-annotate", "+140+220", "INVOICE #10442", "-pointsize", "34"]
for i in range(27):
    args += ["-annotate", f"+140+{380 + i * 62}", f"Line item {i}   service and materials   {i * 7 + 11}.50"]
args += ["-pointsize", "48", "-annotate", "+140+2120", "TOTAL DUE   $1,284.50", "invoice.png"]
mk(*args)
args = ["-size", "1200x2700", "xc:#fbfaf5", "-font", "DejaVu-Sans-Mono", "-fill", "#2a2a2a", "-pointsize", "60",
        "-annotate", "+110+170", "HARBOR HARDWARE", "-pointsize", "44"]
lines = ["123 Main St, Harbor ME", "Date: 11/18/2026  14:22", "", "Paint roller        12.99", "Drop cloth           8.49",
         "Sandpaper 3pk        5.25", "Painters tape        6.79", "Brush 2in            9.99", "",
         "SUBTOTAL            43.51", "SALES TAX 5.5%       2.39", "", "TOTAL               45.90", "",
         "VISA ****4421        45.90", "", "Thank you!", "Returns within 30 days"]
for i, l in enumerate(lines):
    if l:
        args += ["-annotate", f"+110+{270 + i * 80}", l]
args += ["receipt.png"]
mk(*args)


def bg(name, spec):
    mk("-size", f"{W}x{H}", *spec, name)


bg("bg-dark.png", ["plasma:#6b4a2b-#3a2618", "-colorspace", "gray", "-fill", "#6b4a2b", "-tint", "60", "-blur", "0x6"])
bg("bg-light.png", ["xc:#d8d2c6", "-attenuate", "0.5", "+noise", "Gaussian", "-blur", "0x3",
                    "(", "-size", f"{W}x{H}", "gradient:#ffffff-#b8b2a6", ")", "-compose", "multiply", "-composite"])
bg("bg-busy.png", ["plasma:fractal", "-blur", "0x2", "(", "-size", f"{W//8}x{H//8}", "pattern:checkerboard", "-scale", "800%", ")",
                   "-compose", "overlay", "-composite"])
bg("bg-gray.png", ["xc:#8a8c90", "-attenuate", "0.6", "+noise", "Gaussian", "-blur", "0x2"])
# light table with a dark green placemat
bg("bg-mat.png", ["xc:#e4ddd0", "-attenuate", "0.4", "+noise", "Gaussian", "-fill", "#2f4a3a",
                  "-draw", "rectangle 250,500 2800,3700", "-blur", "0x2"])

bg("bg-white.png", ["xc:#efede8", "-attenuate", "0.3", "+noise", "Gaussian", "-blur", "0x2",
                    "(", "-size", f"{W}x{H}", "gradient:#ffffff-#dcdad4", ")", "-compose", "multiply", "-composite"])
bg("bg-wood.png", ["xc:gray50", "-attenuate", "1.5", "+noise", "Gaussian", "-colorspace", "gray", "-motion-blur", "0x120+80",
                   "-auto-level", "-sigmoidal-contrast", "6x50%", "+level-colors", "#4a2c14,#d0a070", "-blur", "0x1"])
cases = {
    "dark": ("bg-dark.png", "receipt.png", [(900, 700), (2200, 820), (2350, 3500), (700, 3380)]),
    "light": ("bg-light.png", "receipt.png", [(820, 600), (2150, 680), (2260, 3550), (640, 3460)]),
    "busy": ("bg-busy.png", "receipt.png", [(950, 640), (2250, 740), (2300, 3420), (800, 3330)]),
    "offframe": ("bg-dark.png", "receipt.png", [(800, 900), (2300, 980), (2500, 5600), (560, 5500)]),
    "placemat": ("bg-mat.png", "receipt.png", [(1050, 900), (2050, 980), (2120, 3300), (930, 3240)]),
    "invoice": ("bg-gray.png", "invoice.png", [(420, 640), (2650, 500), (2780, 3480), (330, 3560)]),
    "small": ("bg-light.png", "receipt.png", [(1200, 1300), (1850, 1350), (1900, 2850), (1120, 2800)]),
    "white": ("bg-white.png", "receipt.png", [(880, 620), (2180, 700), (2300, 3500), (720, 3420)]),
    "wood": ("bg-wood.png", "invoice.png", [(380, 700), (2600, 560), (2760, 3520), (300, 3620)]),
    "blurry": ("bg-dark.png", "receipt.png", [(900, 650), (2250, 760), (2380, 3550), (680, 3440)]),
    "finger": ("bg-gray.png", "receipt.png", [(880, 640), (2200, 720), (2330, 3480), (700, 3400)]),
    "curled": ("bg-dark.png", "receipt-curl.png", [(900, 700), (2200, 820), (2350, 3500), (700, 3380)]),
}
# curled thermal receipt: the long edges bow (transparent around it)
mk("receipt.png", "-alpha", "set", "-background", "none", "-virtual-pixel", "transparent", "-wave", "-60x5400",
   "-gravity", "center", "-extent", "1200x2700", "receipt-curl.png")
truth = {}
for name, (bgf, src, quad) in cases.items():
    sw, sh = (1700, 2200) if src == "invoice.png" else (1200, 2700)
    pts = [(0, 0), (sw, 0), (sw, sh), (0, sh)]
    spec = " ".join(f"{a[0]},{a[1]} {b[0]},{b[1]}" for a, b in zip(pts, quad))
    extra = []
    if name == "blurry":
        extra = ["-blur", "0x9"]
    if name == "finger":  # a thumb over the bottom-left corner
        extra = ["-fill", "#c58f74", "-draw", "ellipse 720,3330 230,150 0,360", "-blur", "0x1"]
    if name == "light":  # shadow across the lower part
        extra = ["(", "-size", f"{W}x{H}", "xc:white", "-fill", "#7a7a7a", "-draw", "polygon 0,2600 3024,2000 3024,4032 0,4032",
                 "-blur", "0x60", ")", "-compose", "multiply", "-composite"]
    mk(bgf, "(", src, "-alpha", "set", "-virtual-pixel", "transparent", "-background", "none",
       "-define", f"distort:viewport={W}x{H}+0+0", "-distort", "Perspective", spec, ")",
       "-compose", "over", "-composite", *extra, "-attenuate", "0.3", "+noise", "Gaussian", "-quality", "90", f"{name}.jpg")
    q = quad
    if name == "offframe":  # the visible page ends at the bottom edge
        def at_bottom(a, b):
            t = (H - a[1]) / (b[1] - a[1])
            return (a[0] + t * (b[0] - a[0]), H)
        q = [quad[0], quad[1], at_bottom(quad[1], quad[2]), at_bottom(quad[0], quad[3])]
    truth[name] = q
json.dump(truth, open("truth.json", "w"), indent=1)
print("ok", list(truth))
