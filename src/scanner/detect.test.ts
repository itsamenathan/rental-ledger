import { describe, expect, it } from "vite-plus/test";
import { detectPage } from "./detect.ts";
import { applyFilter, homography, orderCorners, rgba, rotate90, warp, type Pt, type Quad, type Rgba } from "./image.ts";

/** A seeded pseudo-random source, so the noise is the same every run. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const inside = (q: Pt[], x: number, y: number) => {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = Math.sign((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x));
    if (c && sign && c !== sign) return false;
    if (c) sign = c;
  }
  return true;
};

/**
 * A photo: noisy `table` colour, an optional `mat` rectangle, and a paper `page` with rows of dark "text" (positioned
 * in page coordinates, so they follow the perspective).
 */
function photo(opts: {
  w: number;
  h: number;
  table: number[];
  page?: Quad;
  mat?: Quad;
  matColor?: number[];
  seed?: number;
}) {
  const { w, h, table, page, mat, matColor = [40, 75, 58] } = opts;
  const rand = rng(opts.seed ?? 1);
  const img = rgba(w, h);
  // page coords (0..1) → photo, to place text rows
  const toPage = homography(page ?? q([0, 0], [1, 0], [1, 1], [0, 1]), [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = table;
      if (mat && inside(mat, x, y)) c = matColor;
      if (page && inside(page, x, y)) {
        const d = toPage[6]! * x + toPage[7]! * y + toPage[8]!;
        const u = (toPage[0]! * x + toPage[1]! * y + toPage[2]!) / d;
        const v = (toPage[3]! * x + toPage[4]! * y + toPage[5]!) / d;
        const text = u > 0.12 && u < 0.8 && v > 0.08 && v < 0.85 && (v * 40) % 1 < 0.35 && (u * 23) % 1 < 0.8;
        c = text ? [40, 40, 40] : [248, 246, 240];
      }
      const n = (rand() - 0.5) * 18;
      const i = (y * w + x) * 4;
      img.data[i] = c[0]! + n;
      img.data[i + 1] = c[1]! + n;
      img.data[i + 2] = c[2]! + n;
      img.data[i + 3] = 255;
    }
  return img;
}

const worst = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y)));
const q = (...pts: [number, number][]) => pts.map(([x, y]) => ({ x, y })) as Quad;

describe("detectPage", () => {
  it("finds a tilted page on a dark table", () => {
    const page = q([150, 110], [420, 140], [450, 560], [110, 530]);
    const found = detectPage(photo({ w: 540, h: 720, table: [90, 62, 40], page }));
    expect(found).not.toBeNull();
    expect(worst(found!, page)).toBeLessThan(4);
  });

  it("prefers the paper over a bigger mat it lies on", () => {
    const page = q([200, 200], [360, 215], [370, 520], [185, 505]);
    const mat = q([60, 90], [480, 90], [480, 640], [60, 640]);
    const found = detectPage(photo({ w: 540, h: 720, table: [225, 220, 210], page, mat }));
    expect(worst(found!, page)).toBeLessThan(4);
  });

  it("finds a white page on a nearly white table", () => {
    const page = q([140, 120], [410, 150], [430, 600], [120, 580]);
    const found = detectPage(photo({ w: 540, h: 720, table: [222, 220, 214], page, seed: 7 }));
    expect(worst(found!, page)).toBeLessThan(5);
  });

  it("follows a page that runs off the bottom of the photo", () => {
    const page = q([150, 150], [420, 170], [445, 900], [120, 880]);
    const found = detectPage(photo({ w: 540, h: 720, table: [70, 60, 50], page }));
    expect(found).not.toBeNull();
    // Top corners on the page, bottom ones on the photo's bottom edge.
    expect(worst([found![0], found![1]] as unknown as Quad, [page[0], page[1]] as unknown as Quad)).toBeLessThan(4);
    expect(found![2].y).toBeGreaterThan(715);
    expect(found![3].y).toBeGreaterThan(715);
  });

  it("returns null for a photo with no page", () => {
    const img = photo({ w: 300, h: 400, table: [90, 62, 40] });
    expect(detectPage(img)).toBeNull();
  });
});

describe("image helpers", () => {
  it("orders corners clockwise from the top-left", () => {
    const pts = [
      { x: 10, y: 90 },
      { x: 90, y: 10 },
      { x: 5, y: 5 },
      { x: 95, y: 95 },
    ];
    expect(orderCorners(pts)).toEqual([
      { x: 5, y: 5 },
      { x: 90, y: 10 },
      { x: 95, y: 95 },
      { x: 10, y: 90 },
    ]);
  });

  it("warps the page flat and filters it to a white background", () => {
    const page = q([150, 110], [420, 140], [450, 560], [110, 530]);
    const img = photo({ w: 540, h: 720, table: [90, 62, 40], page });
    const flat = warp(img, page, 200, 300);
    expect([flat.width, flat.height]).toEqual([200, 300]);
    // A margin pixel is paper, not table.
    const at = (im: Rgba, x: number, y: number) => im.data[(y * im.width + x) * 4]!;
    expect(at(flat, 6, 150)).toBeGreaterThan(200);
    const enhanced = applyFilter(flat, "enhanced");
    expect(at(enhanced, 6, 150)).toBeGreaterThan(240);
    const bw = applyFilter(flat, "bw");
    expect(new Set(Array.from({ length: 200 }, (_, x) => at(bw, x, 150)))).toEqual(new Set([0, 255]));
    const turned = rotate90(flat);
    expect([turned.width, turned.height]).toEqual([300, 200]);
  });
});
