/**
 * The entry form's "Photo" button where the browser allows a live camera: the scanner's viewfinder, but every shot is
 * kept as a plain photo (no page finding or clean-up). Several can be taken in a row; Done attaches them all.
 * "Camera app" hands over to the phone's own camera, keeping what was already taken. Photos are held only as JPEGs.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { today } from "../format.ts";
import Camera, { CameraAppIcon, CameraButton, CheckIcon } from "./Camera.tsx";
import { canvasToBlob, free, scaledCanvas } from "./canvas.ts";

interface Shot {
  file: File;
  thumb: string;
}

async function toPhoto(frame: ImageBitmap, n: number): Promise<File> {
  const c = scaledCanvas(frame, frame.width, frame.height);
  frame.close();
  try {
    const jpeg = await canvasToBlob(c, "image/jpeg", 0.9);
    const time = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
    return new File([jpeg], `photo-${today()}-${time}${n > 1 ? `-${n}` : ""}.jpg`, { type: "image/jpeg" });
  } finally {
    free(c);
  }
}

export default function PhotoCamera({
  onDone,
  onClose,
  onCameraApp,
}: {
  /** The photos taken (at least one). */
  onDone: (files: File[]) => void;
  onClose: () => void;
  /** Use the phone's camera app instead; `files` were already taken here. Called from the tap, so it may open it. */
  onCameraApp: (files: File[]) => void;
}) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [saving, setSaving] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const count = useRef(0);

  // Thumbnails are object URLs: let them go when a photo is removed or the camera closes.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const live = urls.current;
    return () => live.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const take = (frame: ImageBitmap) => {
    setSaving((n) => n + 1);
    toPhoto(frame, ++count.current)
      .then((file) => {
        const thumb = URL.createObjectURL(file);
        urls.current.add(thumb);
        setShots((list) => [...list, { file, thumb }]);
      })
      .catch(() => {})
      .finally(() => setSaving((n) => n - 1));
  };

  const remove = (i: number) => {
    const thumb = shots[i]!.thumb;
    URL.revokeObjectURL(thumb);
    urls.current.delete(thumb);
    setShots((list) => list.filter((s) => s.thumb !== thumb));
  };

  const files = shots.map((s) => s.file);

  // Escape closes the camera only, not the entry form underneath.
  const close = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  return (
    <div className="scanner" role="dialog" aria-modal="true" aria-label="Take photos">
      <header className="scanner-head">
        <button type="button" className="scanner-icon" onClick={onClose} aria-label="Close camera">
          ×
        </button>
        <h2>
          Photo
          {shots.length > 0 && <span className="muted"> · {shots.length} taken</span>}
        </h2>
        <span className="scanner-icon" aria-hidden />
      </header>

      {shots.length > 0 && (
        <ul className="scanner-pages" aria-label="Photos taken">
          {shots.map((s, i) => (
            <li key={s.thumb}>
              <img src={s.thumb} alt={`Photo ${i + 1}`} />
              <button type="button" onClick={() => remove(i)} aria-label={`Remove photo ${i + 1}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {failed ? (
        <div className="scanner-stage scanner-msg">
          <p className="small">{failed}</p>
          <div className="scanner-actions">
            <button type="button" className="btn primary" onClick={() => onCameraApp(files)}>
              Open camera app
            </button>
          </div>
        </div>
      ) : (
        <Camera
          burst
          onPhoto={take}
          onFail={setFailed}
          left={
            <CameraButton
              label="Camera app"
              icon={<CameraAppIcon />}
              disabled={saving > 0}
              onClick={() => onCameraApp(files)}
            />
          }
          right={
            shots.length > 0 && (
              <CameraButton
                label="Done"
                icon={<CheckIcon />}
                primary
                count={shots.length}
                disabled={saving > 0}
                onClick={() => onDone(files)}
              />
            )
          }
        />
      )}
    </div>
  );
}
