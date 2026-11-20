// New detector on the labelled set: worst-corner error (% of diagonal) and time per photo.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const [, , REPO, SET, ONLY] = process.argv;
const { detectPage, DETECT_SIDE } = await import(`${REPO}/src/scanner/detect.ts`);
const truth = JSON.parse(readFileSync(`${SET}/truth.json`, "utf8"));

function load(file, maxSide) {
  const [w, h] = execFileSync("magick", ["identify", "-format", "%w %h", file], { encoding: "utf8" })
    .split(" ")
    .map(Number);
  const s = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.round(w * s),
    H = Math.round(h * s);
  const data = execFileSync("magick", [file, "-resize", `${W}x${H}!`, "-depth", "8", "rgba:-"], { maxBuffer: 1 << 28 });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: W,
    height: H,
    scale: w / W,
    diag: Math.hypot(w, h),
  };
}
let ok = 0,
  n = 0;
for (const name of Object.keys(truth)) {
  if (ONLY && name !== ONLY) continue;
  const img = load(`${SET}/${name}.jpg`, DETECT_SIDE);
  const t0 = performance.now();
  const q = detectPage(img);
  const ms = performance.now() - t0;
  const t = truth[name];
  const err = q
    ? (Math.max(...q.map((p, i) => Math.hypot(p.x * img.scale - t[i][0], p.y * img.scale - t[i][1]))) / img.diag) * 100
    : Infinity;
  n++;
  if (err < 1.5) ok++;
  console.log(
    `${name.padEnd(9)} ${q ? err.toFixed(2) + "%" : "not found"}  ${ms.toFixed(0)}ms${ONLY ? "  " + JSON.stringify(q?.map((p) => [Math.round(p.x * img.scale), Math.round(p.y * img.scale)])) + " vs " + JSON.stringify(t.map((p) => p.map(Math.round))) : ""}`,
  );
}
console.log(`${ok}/${n} under 1.5%`);
