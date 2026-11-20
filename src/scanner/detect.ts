/**
 * Find the page in a photo. Pure (RGBA in, corners out) so it's tested in Node (`detect.test.ts`) and tuned on a set
 * of labelled photos.
 *
 * 1. Clean up: ink is closed over (so text can't make edges) and the image softened.
 * 2. Edges from brightness and from colour (a white page on a white table can still differ in tint).
 * 3. Candidate outlines: four straight lines (Hough transform, image borders included for a page running off the
 *    photo) and the outlines of bright, colourless regions.
 * 4. Each candidate is scored: how much of each side has an edge running along it, how paper-like the inside is
 *    (bright, colourless), its size and angles. The best wins, so a placemat or a checked tablecloth loses to the
 *    receipt lying on it.
 * 5. Each side is refitted to the edge pixels along it and the corners recomputed, which also places a corner
 *    hidden under a finger.
 */
import {
  boxBlur,
  chroma,
  isConvex,
  luma,
  maxFilter,
  minFilter,
  orderCorners,
  percentile,
  plane,
  polygonArea,
  sampleAt,
  type Plane,
  type Pt,
  type Quad,
  type Rgba,
} from "./image.ts";

/** Longest side the detector works at; the caller scales the photo down to this. */
export const DETECT_SIDE = 720;

interface Line {
  /** Unit normal and offset: nx·x + ny·y = rho. */
  nx: number;
  ny: number;
  rho: number;
  /** Direction in [0, π). */
  theta: number;
  votes: number;
  border?: boolean;
}

interface Edges {
  w: number;
  h: number;
  /** Thin edge pixels (non-maximum suppressed, hysteresis). */
  on: Uint8Array;
  gx: Float32Array;
  gy: Float32Array;
  /** Closed (ink removed) brightness and colourfulness, for paper-likeness. */
  bright: Plane;
  color: Plane;
  /** Brightest channel, so colourfulness can be judged relative to brightness (tinted paper). */
  value: Plane;
  /** Brightness a page should reach (relative to the photo's brightest areas; low enough for paper in shadow). */
  paperLevel: number;
  /** Gradient strength, and the strong-edge threshold: soft edges (shadows) count for less. */
  mag: Float32Array;
  high: number;
}

function sobel(p: Plane) {
  const { width: w, height: h, data } = p;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = data[i - w - 1]!;
      const b = data[i - w]!;
      const c = data[i - w + 1]!;
      const d = data[i - 1]!;
      const f = data[i + 1]!;
      const g = data[i + w - 1]!;
      const hh = data[i + w]!;
      const k = data[i + w + 1]!;
      gx[i] = c + 2 * f + k - (a + 2 * d + g);
      gy[i] = g + 2 * hh + k - (a + 2 * b + c);
    }
  return { gx, gy };
}

function findEdges(img: Rgba): Edges {
  const w = img.width;
  const h = img.height;
  const side = Math.max(w, h);
  // Closing (max then min) wipes out dark strokes thinner than the kernel: text, lines on forms.
  const k = Math.max(3, Math.round(side * 0.012));
  const bright = minFilter(maxFilter(luma(img), k), k);
  const color = boxBlur(chroma(img), 2);
  const value = plane(w, h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4)
    value.data[i] = Math.max(img.data[j]!, img.data[j + 1]!, img.data[j + 2]!);
  const L = boxBlur(boxBlur(bright, 1), 1);
  const gL = sobel(L);
  const gC = sobel(color);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = plane(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = Math.hypot(gL.gx[i]!, gL.gy[i]!);
    const b = 1.3 * Math.hypot(gC.gx[i]!, gC.gy[i]!);
    if (a >= b) {
      gx[i] = gL.gx[i]!;
      gy[i] = gL.gy[i]!;
      mag.data[i] = a;
    } else {
      gx[i] = gC.gx[i]! * 1.3;
      gy[i] = gC.gy[i]! * 1.3;
      mag.data[i] = b;
    }
  }
  // Thresholds from the photo itself: busy photos get a higher bar, flat ones a lower one.
  const high = Math.max(12, percentile(mag.data, 0.9));
  const low = high * 0.45;
  // Non-maximum suppression along the gradient.
  const nms = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag.data[i]!;
      if (m < low) continue;
      const ax = Math.abs(gx[i]!);
      const ay = Math.abs(gy[i]!);
      let o: number;
      if (ay < ax * 0.414) o = 1;
      else if (ax < ay * 0.414) o = w;
      else o = gx[i]! * gy[i]! > 0 ? w + 1 : w - 1;
      if (m >= mag.data[i + o]! && m > mag.data[i - o]!) nms[i] = m;
    }
  // Hysteresis: weak edges survive when connected to strong ones.
  const on = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++)
    if (nms[i]! >= high && !on[i]) {
      on[i] = 1;
      stack.push(i);
      while (stack.length) {
        const j = stack.pop()!;
        for (const o of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) {
          const n = j + o;
          if (n > 0 && n < w * h && !on[n] && nms[n]! >= low) {
            on[n] = 1;
            stack.push(n);
          }
        }
      }
    }
  const paperLevel = 0.45 * percentile(bright.data, 0.97);
  return { w, h, on, gx, gy, bright, color, value: boxBlur(value, 2), paperLevel, mag: mag.data, high };
}

const THETAS = 180;

function houghLines(e: Edges): Line[] {
  const { w, h, on } = e;
  const diag = Math.ceil(Math.hypot(w, h));
  const rhos = 2 * diag + 1;
  const acc = new Int32Array(THETAS * rhos);
  const cos = new Float64Array(THETAS);
  const sin = new Float64Array(THETAS);
  for (let t = 0; t < THETAS; t++) {
    cos[t] = Math.cos((t * Math.PI) / THETAS);
    sin[t] = Math.sin((t * Math.PI) / THETAS);
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!on[i]) continue;
      // Only vote for line angles that agree with this pixel's gradient (±12°): cuts noise and speeds this up.
      const g = Math.atan2(e.gy[i]!, e.gx[i]!);
      const t0 = Math.round((((g % Math.PI) + Math.PI) % Math.PI) / (Math.PI / THETAS));
      for (let dt = -12; dt <= 12; dt++) {
        const t = (((t0 + dt) % THETAS) + THETAS) % THETAS;
        const r = Math.round(x * cos[t]! + y * sin[t]!) + diag;
        acc[t * rhos + r]!++;
      }
    }
  const minVotes = Math.max(20, Math.min(w, h) * 0.12);
  const peaks: { t: number; r: number; v: number }[] = [];
  for (let t = 0; t < THETAS; t++)
    for (let r = 0; r < rhos; r++) {
      const v = acc[t * rhos + r]!;
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -3; dt <= 3 && isMax; dt++)
        for (let dr = -4; dr <= 4; dr++) {
          if (!dt && !dr) continue;
          const tt = t + dt;
          const rr = r + dr;
          if (tt < 0 || tt >= THETAS || rr < 0 || rr >= rhos) continue;
          const u = acc[tt * rhos + rr]!;
          if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      if (isMax) peaks.push({ t, r, v });
    }
  peaks.sort((a, b) => b.v - a.v);
  const lines: Line[] = [];
  for (const p of peaks) {
    if (lines.length >= 28) break;
    const nx = cos[p.t]!;
    const ny = sin[p.t]!;
    const rho = p.r - diag;
    // Skip near-duplicates of a stronger line.
    if (
      lines.some(
        (l) => Math.abs(l.nx * nx + l.ny * ny) > 0.995 && Math.abs(l.rho - rho * Math.sign(l.nx * nx + l.ny * ny)) < 6,
      )
    )
      continue;
    lines.push({ nx, ny, rho, theta: ((p.t * Math.PI) / THETAS + Math.PI / 2) % Math.PI, votes: p.v });
  }
  // The photo's own edges, for a page that runs off it.
  const border = (nx: number, ny: number, rho: number): Line => ({
    nx,
    ny,
    rho,
    theta: (Math.atan2(ny, nx) + Math.PI / 2) % Math.PI,
    votes: 0,
    border: true,
  });
  lines.push(border(1, 0, 0), border(1, 0, w - 1), border(0, 1, 0), border(0, 1, h - 1));
  return lines;
}

function intersect(a: Line, b: Line): Pt | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.rho * b.ny - a.ny * b.rho) / det, y: (a.nx * b.rho - a.rho * b.nx) / det };
}

const angleBetween = (a: number, b: number) => {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
};

function quadsFromLines(lines: Line[], w: number, h: number): Quad[] {
  const minSep = Math.min(w, h) * 0.12;
  // Pairs of roughly parallel lines: opposite sides of the page.
  const pairs: [Line, Line][] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (angleBetween(a.theta, b.theta) > (30 * Math.PI) / 180) continue;
      // Far enough apart (measured at the photo's centre).
      const da = a.nx * (w / 2) + a.ny * (h / 2) - a.rho;
      const db = b.nx * (w / 2) + b.ny * (h / 2) - b.rho;
      const sameSide = a.nx * b.nx + a.ny * b.ny > 0;
      if (Math.abs(sameSide ? da - db : da + db) < minSep) continue;
      pairs.push([a, b]);
    }
  const out: Quad[] = [];
  const slack = 0.03;
  for (let i = 0; i < pairs.length; i++)
    for (let j = i + 1; j < pairs.length; j++) {
      const [a, b] = pairs[i]!;
      const [c, d] = pairs[j]!;
      if (angleBetween(a.theta, c.theta) < (50 * Math.PI) / 180) continue;
      if ([a, b, c, d].filter((l) => l.border).length > 2) continue;
      const pts = [intersect(a, c), intersect(a, d), intersect(b, d), intersect(b, c)];
      if (pts.some((p) => !p || p.x < -w * slack || p.x > w * (1 + slack) || p.y < -h * slack || p.y > h * (1 + slack)))
        continue;
      const clamped = (pts as Pt[]).map((p) => ({
        x: Math.min(w - 1, Math.max(0, p.x)),
        y: Math.min(h - 1, Math.max(0, p.y)),
      }));
      const q = orderCorners(clamped);
      if (isConvex(q)) out.push(q);
    }
  return out;
}

/** Outlines of the bright, colourless regions (paper), as the four hull points enclosing the most area. */
function quadsFromRegions(e: Edges): Quad[] {
  const { w, h, bright, color, paperLevel } = e;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    mask[i] = paperLike(bright.data[i]!, color.data[i]!, e.value.data[i]!, paperLevel) ? 1 : 0;
  const label = new Int32Array(w * h);
  const out: Quad[] = [];
  let next = 0;
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    next++;
    label[s] = next;
    stack.push(s);
    let area = 0;
    const left = new Int32Array(h).fill(w);
    const right = new Int32Array(h).fill(-1);
    while (stack.length) {
      const i = stack.pop()!;
      area++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < left[y]!) left[y] = x;
      if (x > right[y]!) right[y] = x;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
        if (n >= 0 && n < w * h && mask[n] && !label[n]) {
          label[n] = next;
          stack.push(n);
        }
    }
    if (area < w * h * 0.03 || area > w * h * 0.97) continue;
    const pts: Pt[] = [];
    for (let y = 0; y < h; y++) if (right[y]! >= 0) pts.push({ x: left[y]!, y }, { x: right[y]!, y });
    const q = largestQuad(convexHull(pts));
    if (q) out.push(q);
  }
  return out;
}

function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The four hull vertices enclosing the largest area (hull thinned to ≤ 16 points first). */
function largestQuad(hull: Pt[]): Quad | null {
  if (hull.length < 4) return null;
  let pts = hull;
  if (pts.length > 16) {
    const step = pts.length / 16;
    pts = Array.from({ length: 16 }, (_, i) => hull[Math.floor(i * step)]!);
    // Keep the extreme points, which are likely corners.
    for (const f of [(p: Pt) => p.x + p.y, (p: Pt) => p.x - p.y, (p: Pt) => -p.x + p.y, (p: Pt) => -p.x - p.y]) {
      const best = hull.reduce((a, b) => (f(b) > f(a) ? b : a));
      if (!pts.includes(best)) pts.push(best);
    }
    pts = convexHull(pts);
  }
  let best: Quad | null = null;
  let bestArea = 0;
  const n = pts.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const q = [pts[a]!, pts[b]!, pts[c]!, pts[d]!];
          const area = polygonArea(q);
          if (area > bestArea) {
            bestArea = area;
            best = orderCorners(q);
          }
        }
  return best;
}

const onBorder = (a: Pt, b: Pt, w: number, h: number) => {
  const t = 2.5;
  return (
    (a.x < t && b.x < t) ||
    (a.y < t && b.y < t) ||
    (a.x > w - 1 - t && b.x > w - 1 - t) ||
    (a.y > h - 1 - t && b.y > h - 1 - t)
  );
};

/**
 * How much of the side (ends trimmed) has an edge running along it nearby, each hit weighted by its sharpness, so a
 * soft shadow line counts for less than the page's own edge.
 */
function sideSupport(e: Edges, a: Pt, b: Pt): number {
  const { w, h, on, gx, gy, mag, high } = e;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return 0;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const n = Math.max(16, Math.round(len / 4));
  const reach = Math.max(2, Math.round(Math.max(w, h) * 0.005));
  let hits = 0;
  for (let k = 0; k < n; k++) {
    const t = 0.06 + (0.88 * (k + 0.5)) / n;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    for (let d = -reach; d <= reach; d++) {
      const x = Math.round(px - uy * d);
      const y = Math.round(py + ux * d);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x;
      if (!on[i]) continue;
      const g = Math.hypot(gx[i]!, gy[i]!);
      // The edge must run along the side (its gradient across it).
      if (g > 0 && Math.abs(-uy * gx[i]! + ux * gy[i]!) / g > 0.85) {
        hits += Math.min(1, mag[i]! / (2 * high));
        break;
      }
    }
  }
  return hits / n;
}

/**
 * Paper: bright for this photo and either colourless, or a light tint (yellow, pink and green copies) that is
 * clearly brighter still. Strong colours (most mats, tablecloths) don't count.
 */
const paperLike = (bright: number, color: number, value: number, level: number) =>
  bright >= level && (color < 40 || (color < 0.45 * value && bright >= 1.4 * level));

const isPaper = (e: Edges, x: number, y: number) =>
  paperLike(sampleAt(e.bright, x, y), sampleAt(e.color, x, y), sampleAt(e.value, x, y), e.paperLevel);

/**
 * Share of a strip just inside the side that looks like paper. A page's edge has paper right inside it; a line on
 * the table that happens to pass near the page doesn't.
 */
function innerPaper(e: Edges, a: Pt, b: Pt, centre: Pt): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let nx = -(b.y - a.y) / len;
  let ny = (b.x - a.x) / len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if ((centre.x - mx) * nx + (centre.y - my) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const off = Math.max(4, Math.max(e.w, e.h) * 0.015);
  let hits = 0;
  const n = 16;
  for (let k = 0; k < n; k++) {
    const t = 0.1 + (0.8 * (k + 0.5)) / n;
    if (isPaper(e, a.x + (b.x - a.x) * t + nx * off, a.y + (b.y - a.y) * t + ny * off)) hits++;
  }
  return hits / n;
}

/** Share of the inside that looks like paper: bright for this photo and colourless. */
function paperScore(e: Edges, q: Quad): number {
  let hits = 0;
  let n = 0;
  for (let i = 1; i < 12; i++)
    for (let j = 1; j < 12; j++) {
      const s = i / 12;
      const t = j / 12;
      const top = { x: q[0].x + (q[1].x - q[0].x) * s, y: q[0].y + (q[1].y - q[0].y) * s };
      const bottom = { x: q[3].x + (q[2].x - q[3].x) * s, y: q[3].y + (q[2].y - q[3].y) * s };
      const x = top.x + (bottom.x - top.x) * t;
      const y = top.y + (bottom.y - top.y) * t;
      n++;
      if (isPaper(e, x, y)) hits++;
    }
  return hits / n;
}

function cornerAngles(q: Quad) {
  return q.map((p, i) => {
    const a = q[(i + 3) % 4]!;
    const b = q[(i + 1) % 4]!;
    const v1 = Math.atan2(a.y - p.y, a.x - p.x);
    const v2 = Math.atan2(b.y - p.y, b.x - p.x);
    let d = Math.abs(v1 - v2);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return (d * 180) / Math.PI;
  });
}

interface Scored {
  quad: Quad;
  score: number;
}

function score(e: Edges, q: Quad): Scored | null {
  const { w, h } = e;
  const area = polygonArea(q) / (w * h);
  if (area < 0.03) return null;
  const angles = cornerAngles(q);
  if (angles.some((a) => a < 40 || a > 140)) return null;
  const sides = [0, 1, 2, 3].map((i) => [q[i]!, q[(i + 1) % 4]!] as const);
  const borderSides = sides.filter(([a, b]) => onBorder(a, b, w, h)).length;
  if (borderSides > 2) return null;
  const centre = { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
  const support = sides.map(([a, b]) =>
    onBorder(a, b, w, h) ? 0.55 : sideSupport(e, a, b) * (0.4 + 0.6 * innerPaper(e, a, b, centre)),
  );
  const mean = support.reduce((s, v) => s + v, 0) / 4;
  const min = Math.min(...support);
  if (min < 0.12) return null;
  const paper = paperScore(e, q);
  const squareness = 1 - angles.reduce((s, a) => s + Math.abs(a - 90), 0) / 4 / 50;
  return {
    quad: q,
    score: 0.42 * mean + 0.18 * min + 0.2 * paper + 0.15 * Math.min(1, area / 0.35) + 0.05 * squareness,
  };
}

/** Refit each side to the edge pixels along it and intersect the fitted lines. */
function refine(e: Edges, q: Quad): Quad {
  const { w, h, on, gx, gy } = e;
  const band = Math.max(3, Math.round(Math.max(w, h) * 0.01));
  const lines: (Line | null)[] = [0, 1, 2, 3].map((i) => {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    if (onBorder(a, b, w, h)) {
      if (a.x < 3 && b.x < 3) return { nx: 1, ny: 0, rho: 0, theta: Math.PI / 2, votes: 0, border: true };
      if (a.y < 3 && b.y < 3) return { nx: 0, ny: 1, rho: 0, theta: 0, votes: 0, border: true };
      if (a.x > w - 4) return { nx: 1, ny: 0, rho: w - 1, theta: Math.PI / 2, votes: 0, border: true };
      return { nx: 0, ny: 1, rho: h - 1, theta: 0, votes: 0, border: true };
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let pts: Pt[] = [];
    const minX = Math.max(1, Math.floor(Math.min(a.x, b.x) - band));
    const maxX = Math.min(w - 2, Math.ceil(Math.max(a.x, b.x) + band));
    const minY = Math.max(1, Math.floor(Math.min(a.y, b.y) - band));
    const maxY = Math.min(h - 2, Math.ceil(Math.max(a.y, b.y) + band));
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const i = y * w + x;
        if (!on[i]) continue;
        const t = ((x - a.x) * ux + (y - a.y) * uy) / len;
        if (t < 0.04 || t > 0.96) continue;
        if (Math.abs(-(x - a.x) * uy + (y - a.y) * ux) > band) continue;
        const g = Math.hypot(gx[i]!, gy[i]!);
        if (g > 0 && Math.abs(-uy * gx[i]! + ux * gy[i]!) / g > 0.9) pts.push({ x, y });
      }
    let line: Line | null = null;
    for (let round = 0; round < 3; round++) {
      if (pts.length < 12) return null;
      line = fitLine(pts);
      const l = line;
      const kept = pts.filter((p) => Math.abs(l.nx * p.x + l.ny * p.y - l.rho) < 1.5);
      if (kept.length === pts.length) break;
      pts = kept;
    }
    return line;
  });
  const corners: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const prev = lines[(i + 3) % 4];
    const cur = lines[i];
    const p = prev && cur ? intersect(prev, cur) : null;
    // Keep the original corner when a side couldn't be fitted or the fit moved it implausibly far.
    const limit = Math.max(w, h) * 0.04;
    corners.push(p && Math.hypot(p.x - q[i]!.x, p.y - q[i]!.y) < limit ? p : q[i]!);
  }
  const out = corners.map((p) => ({
    x: Math.min(w - 1, Math.max(0, p.x)),
    y: Math.min(h - 1, Math.max(0, p.y)),
  })) as Quad;
  return isConvex(out) ? out : q;
}

/** Total least squares line through the points. */
function fitLine(pts: Pt[]): Line {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Direction = main axis; normal is perpendicular.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return { nx, ny, rho: nx * mx + ny * my, theta: ((angle % Math.PI) + Math.PI) % Math.PI, votes: pts.length };
}

/**
 * The page's corners in `img` (already scaled to about DETECT_SIDE), or null when nothing page-like stands out.
 */
export function detectPage(img: Rgba): Quad | null {
  const e = findEdges(img);
  const candidates = [...quadsFromLines(houghLines(e), e.w, e.h), ...quadsFromRegions(e)];
  let best: Scored | null = null;
  for (const q of candidates) {
    const s = score(e, q);
    if (s && (!best || s.score > best.score)) best = s;
  }
  if (!best || best.score < 0.4) return null;
  return refine(e, best.quad);
}
