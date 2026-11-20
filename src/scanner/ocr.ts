/**
 * Read the text of scanned pages on this device with tesseract.js. The worker, the WebAssembly core and the English
 * model are served by the app itself (never a CDN), so OCR works offline once the service worker has cached them.
 */
import { createWorker, OEM, type Worker } from "tesseract.js";
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import coreSimdUrl from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import coreUrl from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import engUrl from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";

// From wasm-feature-detect: a tiny module that only validates where WebAssembly SIMD is supported.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** tesseract.js can leave a promise pending forever when the worker fails to start: give up instead. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took too long`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

function startWorker(): Promise<Worker> {
  return createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: workerUrl,
    corePath: WebAssembly.validate(SIMD_PROBE) ? coreSimdUrl : coreUrl,
    // tesseract fetches `${langPath}/eng.traineddata.gz`; the model is a hashed build file, so that suffix goes in
    // the URL fragment (never sent, ignored by caches) and the request is for the hashed file itself.
    langPath: `${engUrl}#`,
    workerBlobURL: false,
    cacheMethod: "none", // the service worker caches the model file
  });
}

/** Whether the text reader's files are already on this device (the first scan downloads about 4.5 MB). */
export async function textReaderCached(): Promise<boolean> {
  if (!("caches" in globalThis)) return false;
  try {
    return !!(await caches.match(engUrl)) && !!(await caches.match(workerUrl));
  } catch {
    return false;
  }
}

/** The text of every page, in order. Pages are read one after another to keep memory low on phones. */
export async function readText(pages: Blob[]): Promise<string> {
  const worker = await withTimeout(startWorker(), 120_000, "Starting the text reader");
  try {
    const out: string[] = [];
    for (const page of pages) out.push((await withTimeout(worker.recognize(page), 90_000, "Reading a page")).data.text);
    return out.join("\n");
  } finally {
    await worker.terminate();
  }
}
