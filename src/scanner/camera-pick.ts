/**
 * Which camera the scanner opens, and how it focuses. No React here, so it's tested in Node with fake devices.
 *
 * Phones have several back cameras, and asking for "environment" plus a picture size can land on one that can't
 * focus (often the ultra-wide, fixed focus), which can't take a sharp close-up of a receipt. So when the camera that
 * opened can't focus, the other back cameras are tried for one that can, and the choice is remembered on the device.
 */

/** The parts of `navigator.mediaDevices` used here. */
export interface Media {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<{ kind: string; deviceId: string }[]>;
}

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CAMERA_KEY = "scanner.camera";

/**
 * A sharp 4:3 picture, the shape of phone sensors (2560×1920 ≈ 4.9 MP); cameras that can't give it pick their nearest
 * size. The photo is a frame of this stream (see Camera.tsx), so a letter page filling the frame is ~230 dpi.
 */
const SIZE = { width: { ideal: 2560 }, height: { ideal: 1920 } };

type Caps = { focusMode?: string[]; pointsOfInterest?: unknown; facingMode?: string[] };

export const capsOf = (track: MediaStreamTrack | undefined): Caps =>
  (track?.getCapabilities?.() as Caps | undefined) ?? {};

/**
 * Whether the camera can focus. Browsers that don't report capabilities at all (Firefox) are trusted to; a camera that
 * reports them without any focus mode is fixed-focus.
 */
export function canFocus(track: MediaStreamTrack | undefined) {
  if (!track?.getCapabilities) return true;
  const modes = capsOf(track).focusMode;
  return !!modes?.some((m) => m === "continuous" || m === "single-shot");
}

const isBack = (track: MediaStreamTrack) => {
  const facing = track.getSettings?.().facingMode;
  return facing ? facing === "environment" : !/front|user|face/i.test(track.label);
};

const stop = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());
const videoTrack = (s: MediaStream) => s.getVideoTracks()[0];

async function backCamera(media: Media) {
  try {
    return await media.getUserMedia({ audio: false, video: { facingMode: { exact: "environment" }, ...SIZE } });
  } catch (err) {
    // No back camera (a laptop): any camera will do. Refusals and busy cameras are real errors.
    const name = (err as { name?: string }).name;
    if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    return media.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...SIZE } });
  }
}

const byId = (media: Media, deviceId: string) =>
  media.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId }, ...SIZE } });

/** Open the scanner's camera: the remembered one, else a back camera that can focus. */
export async function openCamera(media: Media, store: Store | null): Promise<MediaStream> {
  const saved = store?.getItem(CAMERA_KEY);
  if (saved) {
    try {
      return await byId(media, saved);
    } catch (err) {
      if ((err as { name?: string }).name === "NotAllowedError") throw err;
      store?.removeItem(CAMERA_KEY); // unplugged or renumbered: choose again
    }
  }
  let stream = await backCamera(media);
  const first = videoTrack(stream);
  const firstId = first?.getSettings?.().deviceId;
  if (!first || canFocus(first)) {
    if (firstId) store?.setItem(CAMERA_KEY, firstId);
    return stream;
  }
  // This lens can't focus: try the others, one at a time (phones can't open two cameras at once).
  const others = (await media.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId !== firstId);
  stop(stream);
  for (const d of others) {
    try {
      stream = await byId(media, d.deviceId);
    } catch {
      continue;
    }
    const t = videoTrack(stream);
    if (t && isBack(t) && canFocus(t)) {
      store?.setItem(CAMERA_KEY, d.deviceId);
      return stream;
    }
    stop(stream);
  }
  // None can focus: the first one it is (remembered, so the search isn't repeated every scan).
  stream = firstId ? await byId(media, firstId) : await backCamera(media);
  if (firstId) store?.setItem(CAMERA_KEY, firstId);
  return stream;
}

const apply = (track: MediaStreamTrack, c: Record<string, unknown>) =>
  track.applyConstraints({ advanced: [c as MediaTrackConstraintSet] }).catch(() => {});

/** Keep refocusing on its own, where the camera lets us choose. */
export function keepFocused(track: MediaStreamTrack | undefined) {
  if (track && capsOf(track).focusMode?.includes("continuous")) void apply(track, { focusMode: "continuous" });
}

/** Whether tapping can focus this camera (on a point, or at least a one-off refocus). */
export function canTapToFocus(track: MediaStreamTrack | undefined) {
  const caps = capsOf(track);
  return caps.pointsOfInterest !== undefined || !!caps.focusMode?.includes("single-shot");
}

/**
 * Focus on a point (0–1 across and down the picture), like tapping in a camera app. Returns false when the camera
 * can't do it. Goes back to refocusing on its own after a few seconds, still weighted to that point.
 */
export function focusAt(track: MediaStreamTrack | undefined, x: number, y: number): boolean {
  if (!track) return false;
  if (!canTapToFocus(track)) return false;
  const caps = capsOf(track);
  const modes = caps.focusMode ?? [];
  const poi = caps.pointsOfInterest !== undefined;
  const point = poi ? { pointsOfInterest: [{ x, y }] } : {};
  void apply(track, { ...point, focusMode: modes.includes("single-shot") ? "single-shot" : "continuous" }).then(() => {
    if (modes.includes("continuous"))
      setTimeout(() => {
        if (track.readyState === "live") void apply(track, { ...point, focusMode: "continuous" });
      }, 3000);
  });
  return true;
}

/** localStorage, where the browser allows it (private modes may refuse). */
export function storage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Opening a camera takes a noticeable moment (about 1 s on a real phone, whatever the picture size: measured), so the
 * Scan and Photo buttons start it on the tap, while the camera screen appears; the screen then takes it over
 * (`takeWarmCamera`). A camera nobody takes within a few seconds is stopped, so its light never stays on.
 */
let warm: Promise<MediaStream> | null = null;
let warmTimer: ReturnType<typeof setTimeout> | undefined;
const UNCLAIMED_MS = 8000;

export function warmCamera() {
  if (warm || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
  const opening = openCamera(navigator.mediaDevices, storage());
  opening.catch(() => {}); // reported by whoever takes it
  warm = opening;
  warmTimer = setTimeout(() => {
    if (warm !== opening) return;
    warm = null;
    void opening.then(stop, () => {});
  }, UNCLAIMED_MS);
}

/** The camera started by the last tap, if it hasn't been taken (or stopped) yet. */
export function takeWarmCamera(): Promise<MediaStream> | null {
  const w = warm;
  warm = null;
  clearTimeout(warmTimer);
  return w;
}
