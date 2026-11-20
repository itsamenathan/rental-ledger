/**
 * Small image toolkit for the scanner, in plain TypeScript (no DOM, no WebAssembly), so it runs on low-memory phones
 * and in Node tests. Images are RGBA (as from ImageData); single channels are Float32 planes (0..255).
 *
 * OpenCV.js was used first, but loading it alone took ~700 MB of memory, which got the page killed on phones.
 */

export interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
export interface Plane {
  data: Float32Array;
  width: number;
  height: number;
}
export interface Pt {
  x: number;
  y: number;
}
/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type Filter = "enhanced" | "bw" | "color";

export const plane = (width: number, height: number): Plane => ({
  data: new Float32Array(width * height),
  width,
  height,
});
export const rgba = (width: number, height: number): Rgba => ({
  data: new Uint8ClampedArray(width * height * 4),
  width,
  height,
});

export function luma({ data, width, height }: Rgba): Plane {
  const out = plane(width, height);
  for (let i = 0, j = 0; i < out.data.length; i++, j += 4)
    out.data[i] = 0.299 * data[j]! + 0.587 * data[j + 1]! + 0.114 * data[j + 2]!;
  return out;
}

/** Colourfulness (max − min channel): paper and ink are near 0, most tables and mats are not. */
export function chroma({ data, width, height }: Rgba): Plane {
  const out = plane(width, height);
  for (let i = 0, j = 0; i < out.data.length; i++, j += 4) {
    const r = data[j]!;
    const g = data[j + 1]!;
    const b = data[j + 2]!;
    out.data[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return out;
}

/** Sliding max (or min) over 2r+1 samples along one line, O(n) with a monotonic deque. */
function slide(src: Float32Array, dst: Float32Array, start: number, step: number, n: number, r: number, max: boolean) {
  const q = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const better = (a: number, b: number) => (max ? a >= b : a <= b);
  for (let i = 0, k = -r; k < n; i++, k++) {
    if (i < n) {
      const v = src[start + i * step]!;
      while (tail > head && better(v, src[start + q[tail - 1]! * step]!)) tail--;
      q[tail++] = i;
    }
    if (k >= 0) {
      while (q[head]! < k - r) head++;
      dst[start + k * step] = src[start + q[head]! * step]!;
    }
  }
}

function rank(p: Plane, r: number, max: boolean): Plane {
  const { width: w, height: h } = p;
  const tmp = plane(w, h);
  const out = plane(w, h);
  for (let y = 0; y < h; y++) slide(p.data, tmp.data, y * w, 1, w, r, max);
  for (let x = 0; x < w; x++) slide(tmp.data, out.data, x, w, h, r, max);
  return out;
}
export const maxFilter = (p: Plane, r: number) => rank(p, r, true);
export const minFilter = (p: Plane, r: number) => rank(p, r, false);

/** Box blur of radius r (edges clamped), separable running sums. */
export function boxBlur(p: Plane, r: number): Plane {
  const { width: w, height: h } = p;
  const pass = (src: Float32Array, dst: Float32Array, start: number, step: number, n: number) => {
    let sum = 0;
    const at = (i: number) => src[start + Math.min(n - 1, Math.max(0, i)) * step]!;
    for (let i = -r; i <= r; i++) sum += at(i);
    for (let i = 0; i < n; i++) {
      dst[start + i * step] = sum / (2 * r + 1);
      sum += at(i + r + 1) - at(i - r);
    }
  };
  const tmp = plane(w, h);
  const out = plane(w, h);
  for (let y = 0; y < h; y++) pass(p.data, tmp.data, y * w, 1, w);
  for (let x = 0; x < w; x++) pass(tmp.data, out.data, x, w, h);
  return out;
}

/** Average of each f×f block. */
export function downsample(p: Plane, f: number): Plane {
  const w = Math.max(1, Math.floor(p.width / f));
  const h = Math.max(1, Math.floor(p.height / f));
  const out = plane(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * p.width + x * f;
        for (let dx = 0; dx < f; dx++) s += p.data[row + dx]!;
      }
      out.data[y * w + x] = s / (f * f);
    }
  return out;
}

/** Bilinear sample of a plane at (x, y), clamped to the edges. */
export function sampleAt(p: Plane, x: number, y: number) {
  const { width: w, height: h, data } = p;
  x = Math.min(w - 1, Math.max(0, x));
  y = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * w + x0]!;
  const b = data[y0 * w + x1]!;
  const c = data[y1 * w + x0]!;
  const d = data[y1 * w + x1]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export function percentile(values: Float32Array, q: number) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

// ---------- geometry ----------

/** The 3×3 homography (row-major) taking the four `from` points to the four `to` points. */
export function homography(from: Pt[], to: Pt[]): Float64Array {
  // 8 unknowns (h33 = 1): solve A·h = b by Gaussian elimination with partial pivoting.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[pivot]![c]!)) pivot = r;
    [A[c], A[pivot]] = [A[pivot]!, A[c]!];
    const div = A[c]![c]!;
    if (Math.abs(div) < 1e-12) throw new Error("Those corners don't make a page shape");
    for (let k = c; k < 9; k++) A[c]![k]! /= div;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]!;
      if (f) for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  return Float64Array.from([...A.map((row) => row[8]!), 1]);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Size of the flattened page: its sides' lengths, scaled so it has at most `maxPixels` and never more pixels than the
 * photo had inside the corners (no upscaling).
 */
export function pageSize(q: Quad, maxPixels: number) {
  const w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const scale = Math.min(1, Math.sqrt(Math.min(maxPixels, polygonArea(q)) / (w * h)));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function polygonArea(q: Pt[]) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!;
    const n = q[(i + 1) % q.length]!;
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** True when the four corners make a convex shape (edges never cross, no corner folded inward). */
export function isConvex(q: Pt[]) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const c = q[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Sort four points into top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts: Pt[]): Quad {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // By angle around the centre (clockwise on screen, starting from the top-left quadrant).
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    if (p.x + p.y < best) {
      best = p.x + p.y;
      start = i;
    }
  });
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]!) as Quad;
}

/** Corners slightly inside the image, for when nothing was detected. */
export function insetQuad(w: number, h: number, inset = 0.06): Quad {
  const dx = w * inset;
  const dy = h * inset;
  return [
    { x: dx, y: dy },
    { x: w - dx, y: dy },
    { x: w - dx, y: h - dy },
    { x: dx, y: h - dy },
  ];
}

/**
 * Flatten the part of `src` inside `q` into an upright width×height image (bilinear). `src` should be no more than
 * ~1.5× the output's resolution (pre-scale it), or fine print aliases.
 */
export function warp(src: Rgba, q: Quad, width: number, height: number): Rgba {
  const H = homography(
    [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    q,
  );
  const out = rgba(width, height);
  const s = src.data;
  const sw = src.width;
  const maxX = src.width - 1;
  const maxY = src.height - 1;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++, o += 4) {
      const px = x + 0.5;
      const d = H[6]! * px + H[7]! * py + H[8]!;
      let sx = (H[0]! * px + H[1]! * py + H[2]!) / d - 0.5;
      let sy = (H[3]! * px + H[4]! * py + H[5]!) / d - 0.5;
      sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
      sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c]! + (s[i01 + c]! - s[i00 + c]!) * fx;
        const bottom = s[i10 + c]! + (s[i11 + c]! - s[i10 + c]!) * fx;
        out.data[o + c] = top + (bottom - top) * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** The image turned a quarter turn (clockwise, or counter-clockwise when `ccw`). */
export function rotate90(img: Rgba, ccw = false): Rgba {
  const { width: w, height: h } = img;
  const out = rgba(h, w);
  const s = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  const d = new Uint32Array(out.data.buffer, 0, w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = ccw ? y : h - 1 - y;
      const ny = ccw ? w - 1 - x : x;
      d[ny * h + nx] = s[y * w + x]!;
    }
  return out;
}

// ---------- the "scan look" ----------

/**
 * The paper's brightness at every pixel, without the ink: at ¼ size, a max filter wipes out text, then a blur
 * smooths it. Dividing by it evens out shadows and yellowed paper.
 */
function background(y: Plane): Plane {
  const f = 4;
  const small = downsample(y, f);
  const side = Math.max(small.width, small.height);
  const bg = boxBlur(maxFilter(small, Math.max(3, Math.round(side / 90))), Math.max(4, Math.round(side / 60)));
  const out = plane(y.width, y.height);
  for (let yy = 0; yy < y.height; yy++)
    for (let xx = 0; xx < y.width; xx++)
      out.data[yy * y.width + xx] = Math.max(1, sampleAt(bg, (xx + 0.5) / f - 0.5, (yy + 0.5) / f - 0.5));
  return out;
}

/**
 * The page with a filter applied:
 * - enhanced: grayscale on even white (shadows and paper tint removed); faint print made darker.
 * - bw: black and white, the classic scan; smallest files.
 * - color: colours kept, background evened out to white.
 */
export function applyFilter(img: Rgba, filter: Filter): Rgba {
  const y = luma(img);
  const bg = background(y);
  const out = rgba(img.width, img.height);
  const d = out.data;
  for (let i = 0, j = 0; i < y.data.length; i++, j += 4) {
    const b = bg.data[i]!;
    if (filter === "color") {
      for (let c = 0; c < 3; c++) d[j + c] = Math.min(255, (img.data[j + c]! * 255) / b);
    } else {
      const v = Math.min(1, y.data[i]! / b);
      // Stretch: paper (≥0.9) → white, faint thermal print pulled darker.
      const t = Math.min(1, Math.max(0, (v - 0.25) / 0.65));
      const g = filter === "bw" ? (v < 0.75 ? 0 : 255) : 255 * t * t * (3 - 2 * t);
      d[j] = d[j + 1] = d[j + 2] = g;
    }
    d[j + 3] = 255;
  }
  return out;
}
