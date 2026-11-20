/** Kept apart from Camera.tsx so the entry form can ask without loading the scanner. */

/** Whether this browser can show a live camera here: a camera API, on https or localhost. */
export const canUseCamera = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && globalThis.isSecureContext !== false;
