/**
 * Canvas plumbing for the scanner (browser only). Phones count canvas memory against a hard limit and free it late,
 * so every temporary canvas is emptied with `free()` as soon as it's done with.
 */
import type { Rgba } from "./image.ts";

export function free(c: HTMLCanvasElement) {
  c.width = 0;
  c.height = 0;
}

/** A canvas holding `src` scaled down so its longer side is at most `maxSide` (never scaled up). */
export function fitCanvas(src: CanvasImageSource & { width: number; height: number }, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  return scaledCanvas(src, Math.round(src.width * scale), Math.round(src.height * scale));
}

export function scaledCanvas(
  src: CanvasImageSource,
  width: number,
  height: number,
  from?: { x: number; y: number; width: number; height: number },
) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  if (from) ctx.drawImage(src, from.x, from.y, from.width, from.height, 0, 0, canvas.width, canvas.height);
  else ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function pixels(c: HTMLCanvasElement): Rgba {
  const { data, width, height } = c
    .getContext("2d", { willReadFrequently: true })!
    .getImageData(0, 0, c.width, c.height);
  return { data, width, height };
}

export function toCanvas(img: Rgba, into?: HTMLCanvasElement) {
  const canvas = into ?? document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas
    .getContext("2d")!
    .putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return canvas;
}

/** `img` scaled so its longer side is at most maxSide, via a canvas (better quality than our bilinear warp). */
export function shrink(img: Rgba, maxSide: number): Rgba {
  if (Math.max(img.width, img.height) <= maxSide) return img;
  const full = toCanvas(img);
  const small = fitCanvas(full, maxSide);
  free(full);
  const out = pixels(small);
  free(small);
  return out;
}

/** `img` resized by `scale` (up or down) via a canvas. */
export function scaleImage(img: Rgba, scale: number): Rgba {
  if (Math.abs(scale - 1) < 0.01) return img;
  const full = toCanvas(img);
  const out = scaledCanvas(full, Math.round(img.width * scale), Math.round(img.height * scale));
  free(full);
  const px = pixels(out);
  free(out);
  return px;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/jpeg", quality = 0.82): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't save the scan"))), type, quality),
  );
}

/** Encode an image as JPEG (the canvas is freed straight after). */
export async function toJpeg(img: Rgba, quality = 0.82): Promise<Blob> {
  const c = toCanvas(img);
  try {
    return await canvasToBlob(c, "image/jpeg", quality);
  } finally {
    free(c);
  }
}
