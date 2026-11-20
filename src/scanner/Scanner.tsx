/**
 * The document scanner: photo → find the page → drag the corners to fix → flatten → filter → more pages → one file.
 * Loaded with React.lazy from the receipt picker. Image work is plain TypeScript (`image.ts`, `detect.ts`) and keeps
 * memory low for phones: one working copy of the photo, each finished page kept only as a JPEG.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { today } from "../format.ts";
import { canvasToBlob, fitCanvas, free, pixels, scaledCanvas, scaleImage, shrink, toCanvas, toJpeg } from "./canvas.ts";
import { DETECT_SIDE, detectPage } from "./detect.ts";
import {
  applyFilter,
  insetQuad,
  isConvex,
  pageSize,
  polygonArea,
  rotate90,
  warp,
  type Filter,
  type Pt,
  type Quad,
  type Rgba,
} from "./image.ts";
import Camera, { CameraButton, CheckIcon, GalleryIcon } from "./Camera.tsx";
import { canUseCamera } from "./live-camera.ts";
import { pagesToFile, type ScannedPage } from "./output.ts";

export interface ScanResult {
  file: File;
  /** Grayscale, evened-out copies of each page for reading the text (OCR). */
  ocrPages: Blob[];
  /** A small picture of the first page, for showing a PDF (a JPEG scan is its own picture). */
  preview?: Blob;
}

interface Props {
  /** The first photo, taken with the phone's camera app. Without it the scanner opens its own camera. */
  initial?: File;
  onDone: (result: ScanResult) => void;
  onClose: () => void;
}

/** Longest side of the working copy of the photo (a 12 MP photo is ~4000 px; this keeps ~5.8 MP). */
const WORK_SIDE = 2400;
/** Pages are at most this many pixels (a letter page at ~210 dpi); never more than the photo had. */
const PAGE_PIXELS = 3_000_000;
/**
 * Text reading works on a copy of at most this many pixels (plenty for print, much less memory), and at least
 * OCR_MIN_WIDTH wide: a receipt that was small in the photo is enlarged, which the text reader needs.
 */
const OCR_PIXELS = 2_500_000;
const OCR_MIN_WIDTH = 1100;
const PREVIEW_SIDE = 1200;

/** The page being worked on: flattened, upright, in colour. */
interface Draft {
  flat: Rgba;
  filter: Filter;
}

interface Page extends ScannedPage {
  ocr: Blob;
  thumb: string;
  /** About tile-sized at 3× screen density; only the first page's is used, for a PDF. */
  preview: Blob;
  filter: Filter;
}

type Step =
  | { name: "loading"; message: string }
  /** The scanner's own camera (where the browser allows it). */
  | { name: "camera" }
  /** Waiting for a photo from the phone's camera app (no live camera here); `note` says why. */
  | { name: "capture"; note?: string }
  | { name: "adjust"; photo: HTMLCanvasElement; quad: Quad; detected: Quad | null }
  | { name: "filter"; draft: Draft; photo: HTMLCanvasElement; quad: Quad; detected: Quad | null }
  | { name: "error"; message: string };

const FILTERS: { id: Filter; label: string }[] = [
  { id: "enhanced", label: "Enhanced" },
  { id: "bw", label: "B&W" },
  { id: "color", label: "Color" },
];

const nextFrame = () => new Promise((r) => setTimeout(r, 30));

/** Flatten the page inside `quad` of `photo`, reading only the area around it at about the output's resolution. */
function flattenPage(photo: HTMLCanvasElement, quad: Quad): Rgba {
  const { width, height } = pageSize(quad, PAGE_PIXELS);
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const x1 = Math.min(photo.width, Math.ceil(Math.max(...xs)) + 2);
  const y1 = Math.min(photo.height, Math.ceil(Math.max(...ys)) + 2);
  // Sample from no more than ~1.5× the output's resolution, so fine print doesn't alias.
  const s = Math.min(1, 1.5 * Math.sqrt((width * height) / polygonArea(quad)));
  const crop = scaledCanvas(photo, Math.round((x1 - x0) * s), Math.round((y1 - y0) * s), {
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
  });
  const sx = crop.width / (x1 - x0);
  const sy = crop.height / (y1 - y0);
  const src = pixels(crop);
  free(crop);
  const local = quad.map((p) => ({ x: (p.x - x0) * sx, y: (p.y - y0) * sy })) as Quad;
  const flat = warp(src, local, width, height);
  // A page photographed sideways comes out wider than tall; turn it upright (receipts are tall).
  return flat.width > flat.height * 1.15 ? rotate90(flat) : flat;
}

/**
 * The finished page: filtered JPEG, a copy for text reading and a thumbnail. Pixels aren't kept. One step at a time,
 * so no more than one full-size copy besides `flat` exists at once (phones run out of memory, not time).
 */
async function finishPage({ flat, filter }: Draft): Promise<Page> {
  const { width, height } = flat;
  const cap = Math.sqrt(OCR_PIXELS / (width * height));
  const ocr = await toJpeg(
    applyFilter(scaleImage(flat, Math.min(cap, Math.max(1, OCR_MIN_WIDTH / width))), "enhanced"),
    0.9,
  );
  // The JPEG and the thumbnail come from the same canvas; the filtered pixels are garbage once it's drawn.
  const canvas = toCanvas(applyFilter(flat, filter));
  try {
    const jpeg = await canvasToBlob(canvas);
    const previewCanvas = fitCanvas(canvas, 480);
    const preview = await canvasToBlob(previewCanvas, "image/jpeg", 0.75);
    const thumbCanvas = fitCanvas(previewCanvas, 160);
    const thumb = thumbCanvas.toDataURL("image/jpeg", 0.7);
    free(previewCanvas);
    free(thumbCanvas);
    return { jpeg, width, height, ocr, thumb, preview, filter };
  } finally {
    free(canvas);
  }
}

export default function Scanner({ initial, onDone, onClose }: Props) {
  const [step, setStep] = useState<Step>(
    initial ? { name: "loading", message: "Finding the page…" } : { name: "camera" },
  );
  // Our own camera works here (until it fails); otherwise photos come from the phone's camera app.
  const [live, setLive] = useState(canUseCamera);
  const [pages, setPages] = useState<Page[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  // The working photo, so it can be emptied as soon as it's replaced or the scanner closes.
  const photoRef = useRef<HTMLCanvasElement | null>(null);
  // Closed (× or Escape) while a page was still being saved: drop the result instead of attaching it.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (photoRef.current) free(photoRef.current);
    };
  }, []);

  const dropPhoto = () => {
    if (photoRef.current) free(photoRef.current);
    photoRef.current = null;
  };

  /** Decode a photo, find the page and show the corners. */
  const openPhoto = useCallback(async (source: File | ImageBitmap) => {
    setStep({ name: "loading", message: "Finding the page…" });
    await nextFrame();
    try {
      // A camera frame is already decoded; a file from the camera app or the gallery isn't.
      const bitmap =
        source instanceof ImageBitmap
          ? source
          : await createImageBitmap(source, { imageOrientation: "from-image" }).catch(() => {
              throw new Error("Couldn't read that photo. Try taking it again, or pick a JPEG or PNG.");
            });
      const photo = fitCanvas(bitmap, WORK_SIDE);
      bitmap.close();
      if (photoRef.current) free(photoRef.current);
      photoRef.current = photo;
      let detected: Quad | null = null;
      try {
        const small = fitCanvas(photo, DETECT_SIDE);
        const scale = photo.width / small.width;
        const found = detectPage(pixels(small));
        free(small);
        if (found) detected = found.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad;
      } catch {
        // Detection is a convenience: the corners can always be placed by hand.
      }
      setStep({ name: "adjust", photo, quad: detected ?? insetQuad(photo.width, photo.height), detected });
    } catch (err) {
      setStep({ name: "error", message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (initial) void openPhoto(initial);
  }, [initial, openPhoto]);

  // Escape steps back (or closes); it must not also close the entry form's modal underneath.
  const back = useCallback(() => {
    if (step.name === "filter")
      setStep({ name: "adjust", photo: step.photo, quad: step.quad, detected: step.detected });
    else onClose();
  }, [step, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      back();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [back]);

  const pickPhoto = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    if (file) void openPhoto(file);
  };

  /** Run a slow step with a message showing (yields first so the message paints). */
  const work = async <T,>(message: string, fn: () => T | Promise<T>): Promise<T | undefined> => {
    setBusy(message);
    await nextFrame();
    try {
      return await fn();
    } catch (err) {
      setStep({ name: "error", message: (err as Error).message || "Something went wrong scanning that page" });
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const flatten = async () => {
    if (step.name !== "adjust") return;
    const { photo, quad, detected } = step;
    const flat = await work("Straightening…", () => flattenPage(photo, quad));
    if (flat)
      setStep({ name: "filter", draft: { flat, filter: pages.at(-1)?.filter ?? "enhanced" }, photo, quad, detected });
  };

  /** Save the page being edited as JPEGs and let go of its pixels and the photo. */
  const commitPage = async (): Promise<Page[] | undefined> => {
    if (step.name !== "filter") return pages;
    // The photo isn't needed any more (no going back to the corners once saved): free it before the work starts.
    dropPhoto();
    const page = await work("Saving the page…", () => finishPage(step.draft));
    if (!page) return undefined;
    // Let go of the page's pixels too (the step held them) before the PDF or the next photo.
    setStep({ name: "loading", message: "Saving the scan…" });
    const next = [...pages, page];
    setPages(next);
    return next;
  };

  /**
   * Take another photo: the live camera, or the phone's camera app. With the camera app the current screen stays (the
   * photo is replaced only if one is taken; backing out of the camera app keeps the corners).
   */
  const takePhoto = () => {
    if (!live) return cameraRef.current?.click();
    dropPhoto();
    setStep({ name: "camera" });
  };

  const cameraFailed = useCallback((note: string) => {
    setLive(false);
    setStep({ name: "capture", note });
  }, []);

  const addPage = async () => {
    if (!(await commitPage())) return;
    if (!live) setStep({ name: "capture" });
    takePhoto();
  };

  const finish = async (list: Page[] | undefined) => {
    if (!list?.length) return;
    const file = await work(list.length > 1 ? `Making a ${list.length}-page PDF…` : "Saving the scan…", () =>
      pagesToFile(list, today()),
    );
    if (file && !closed.current)
      onDone({ file, ocrPages: list.map((p) => p.ocr), preview: list.length > 1 ? list[0]!.preview : undefined });
  };

  const removePage = (i: number) => setPages((list) => list.filter((_, j) => j !== i));

  const setDraft = (draft: Draft) => step.name === "filter" && setStep({ ...step, draft });

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label="Scan a document">
      <header className="scanner-head">
        <button type="button" className="scanner-icon" onClick={onClose} aria-label="Close scanner">
          ×
        </button>
        <h2>
          Scan
          {pages.length > 0 && <span className="muted"> · page {pages.length + 1}</span>}
        </h2>
        <span className="scanner-icon" aria-hidden />
      </header>

      {pages.length > 0 && (
        <ul className="scanner-pages" aria-label="Scanned pages">
          {pages.map((p, i) => (
            <li key={p.thumb + i}>
              <img src={p.thumb} alt={`Page ${i + 1}`} />
              <button type="button" onClick={() => removePage(i)} aria-label={`Remove page ${i + 1}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {step.name === "loading" && (
        <div className="scanner-stage scanner-msg">
          <span className="tile-spinner" aria-hidden />
          <p>{step.message}</p>
        </div>
      )}

      {step.name === "camera" && (
        <Camera
          onPhoto={(photo) => void openPhoto(photo)}
          onFail={cameraFailed}
          left={<CameraButton label="Gallery" icon={<GalleryIcon />} onClick={() => galleryRef.current?.click()} />}
          right={
            pages.length > 0 && (
              <CameraButton
                label="Done"
                icon={<CheckIcon />}
                primary
                count={pages.length}
                disabled={!!busy}
                onClick={() => void finish(pages)}
              />
            )
          }
        />
      )}

      {step.name === "capture" && (
        <div className="scanner-stage scanner-msg">
          {step.note && <p className="small">{step.note}</p>}
          <p>{pages.length ? "Take a photo of the next page." : "Take a photo of the page."}</p>
          <div className="scanner-actions">
            <button type="button" className="btn" onClick={() => galleryRef.current?.click()}>
              Choose photo
            </button>
            <button type="button" className="btn primary" onClick={takePhoto}>
              Take photo
            </button>
            {pages.length > 0 && (
              <button type="button" className="btn" disabled={!!busy} onClick={() => void finish(pages)}>
                Done
              </button>
            )}
          </div>
        </div>
      )}

      {step.name === "error" && (
        <div className="scanner-stage scanner-msg">
          <p>{step.message}</p>
          <div className="scanner-actions">
            <button type="button" className="btn" onClick={() => galleryRef.current?.click()}>
              Choose photo
            </button>
            <button type="button" className="btn primary" onClick={takePhoto}>
              Take photo
            </button>
            {pages.length > 0 && (
              <button type="button" className="btn" disabled={!!busy} onClick={() => void finish(pages)}>
                Done with {pages.length} {pages.length === 1 ? "page" : "pages"}
              </button>
            )}
          </div>
        </div>
      )}

      {step.name === "adjust" && (
        <>
          <CornerEditor photo={step.photo} quad={step.quad} onChange={(quad) => setStep({ ...step, quad })} />
          <p className="scanner-tip">
            {step.detected
              ? "Drag the corners to fit the page."
              : "Couldn't find the page edges: drag the corners to the page."}
          </p>
          <footer className="scanner-foot">
            <button type="button" className="btn" onClick={takePhoto}>
              Retake
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setStep({ ...step, quad: insetQuad(step.photo.width, step.photo.height, 0) })}
            >
              Whole photo
            </button>
            {step.detected && (
              <button type="button" className="btn" onClick={() => setStep({ ...step, quad: step.detected! })}>
                Auto
              </button>
            )}
            <button type="button" className="btn primary" disabled={!!busy} onClick={() => void flatten()}>
              Next
            </button>
          </footer>
        </>
      )}

      {step.name === "filter" && (
        <>
          <FilterPreview draft={step.draft} />
          <div className="scanner-tools">
            <div className="segmented" role="radiogroup" aria-label="Look">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={step.draft.filter === f.id}
                  className={step.draft.filter === f.id ? "on" : ""}
                  onClick={() => setDraft({ ...step.draft, filter: f.id })}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn small"
              aria-label="Rotate left"
              title="Rotate left"
              onClick={() => setDraft({ ...step.draft, flat: rotate90(step.draft.flat, true) })}
            >
              ⟲
            </button>
            <button
              type="button"
              className="btn small"
              aria-label="Rotate right"
              title="Rotate right"
              onClick={() => setDraft({ ...step.draft, flat: rotate90(step.draft.flat) })}
            >
              ⟳
            </button>
          </div>
          <footer className="scanner-foot">
            <button type="button" className="btn" onClick={back}>
              Corners
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void addPage()}>
              + Page
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!busy}
              onClick={() => void commitPage().then(finish)}
            >
              Done
            </button>
          </footer>
        </>
      )}

      {busy && (
        <div className="scanner-busy" role="status">
          <span className="tile-spinner" aria-hidden />
          {busy}
        </div>
      )}

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => pickPhoto(e.currentTarget)}
      />
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.currentTarget)} />
    </div>
  );
}

/** Size (CSS px) that fits a w×h image inside the element, measured live. */
function useFit(ref: RefObject<HTMLElement | null>, w: number, h: number) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const scale = Math.min(box.width / w, box.height / h);
      setSize({ width: Math.floor(w * scale), height: Math.floor(h * scale) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, w, h]);
  return size;
}

const LOUPE_CSS_PX = 110;

/** The photo with the page outline and four draggable corners (plus a magnifier while dragging). */
function CornerEditor({
  photo,
  quad,
  onChange,
}: {
  photo: HTMLCanvasElement;
  quad: Quad;
  onChange: (q: Quad) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const size = useFit(stageRef, photo.width, photo.height);
  const scale = size.width ? photo.width / size.width : 1; // image px per CSS px

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    // Draw at the displayed size (times the screen's density), not the full-size photo.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(size.width * dpr));
    c.height = Math.max(1, Math.round(size.height * dpr));
    c.getContext("2d")!.drawImage(photo, 0, 0, c.width, c.height);
  }, [photo, size]);

  const drawLoupe = (p: Pt) => {
    const l = loupeRef.current;
    if (!l) return;
    const ctx = l.getContext("2d")!;
    const zoom = 2.5;
    const span = (LOUPE_CSS_PX * scale) / zoom; // image px shown across the loupe
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, l.width, l.height);
    ctx.drawImage(photo, p.x - span / 2, p.y - span / 2, span, span, 0, 0, l.width, l.height);
    ctx.strokeStyle = "#4fae8a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(l.width / 2, 0);
    ctx.lineTo(l.width / 2, l.height);
    ctx.moveTo(0, l.height / 2);
    ctx.lineTo(l.width, l.height / 2);
    ctx.stroke();
  };

  const toImage = (e: PointerEvent): Pt => {
    const box = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(photo.width, Math.max(0, ((e.clientX - box.left) / box.width) * photo.width)),
      y: Math.min(photo.height, Math.max(0, ((e.clientY - box.top) / box.height) * photo.height)),
    };
  };

  const onDown = (i: number) => (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag(i);
    requestAnimationFrame(() => drawLoupe(quad[i]!));
  };
  const onMove = (e: PointerEvent) => {
    if (drag === null) return;
    const p = toImage(e);
    const next = quad.map((q, j) => (j === drag ? p : q)) as Quad;
    // Never let the outline fold over itself.
    if (isConvex(next)) onChange(next);
    drawLoupe(p);
  };
  const onUp = () => setDrag(null);

  const r = 16 * scale; // handle radius in image px = 16 CSS px
  const points = quad.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <div className="scanner-stage" ref={stageRef}>
      <div className="scan-frame" style={{ width: size.width, height: size.height }}>
        <canvas ref={canvasRef} style={{ width: size.width, height: size.height }} />
        <svg
          viewBox={`0 0 ${photo.width} ${photo.height}`}
          preserveAspectRatio="none"
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <path
            className="scan-shade"
            fillRule="evenodd"
            d={`M0 0H${photo.width}V${photo.height}H0Z M${quad.map((p) => `${p.x} ${p.y}`).join(" L")}Z`}
          />
          <polygon className="scan-outline" points={points} />
          {quad.map((p, i) => (
            <g key={i}>
              <circle className="scan-handle-hit" cx={p.x} cy={p.y} r={r * 1.8} onPointerDown={onDown(i)} />
              <circle className={`scan-handle ${drag === i ? "on" : ""}`} cx={p.x} cy={p.y} r={r} />
            </g>
          ))}
        </svg>
        {drag !== null && (
          <canvas
            ref={loupeRef}
            className={`scan-loupe ${quad[drag]!.x < photo.width / 2 && quad[drag]!.y < photo.height / 2 ? "right" : ""}`}
            width={220}
            height={220}
          />
        )}
      </div>
    </div>
  );
}

/** The flattened page with its filter applied, on a screen-sized copy (recomputed when the filter or rotation changes). */
function FilterPreview({ draft }: { draft: Draft }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useFit(stageRef, draft.flat.width, draft.flat.height);
  // What the canvas shows; while it differs from the draft, the preview is dimmed.
  const [shown, setShown] = useState<Draft | null>(null);
  const rendering = shown?.flat !== draft.flat || shown.filter !== draft.filter;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled || !canvasRef.current) return;
      toCanvas(applyFilter(shrink(draft.flat, PREVIEW_SIDE), draft.filter), canvasRef.current);
      setShown(draft);
    }, 20);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [draft]);

  return (
    <div className="scanner-stage" ref={stageRef}>
      <div
        className={`scan-frame page ${rendering ? "rendering" : ""}`}
        style={{ width: size.width, height: size.height }}
      >
        <canvas ref={canvasRef} style={{ width: size.width, height: size.height }} />
      </div>
    </div>
  );
}
