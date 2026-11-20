/**
 * The scanner's own viewfinder (getUserMedia), so taking several pages never leaves the page for the phone's camera
 * app, where the browser sits in the background and may be closed for memory. Browsers only allow it on https (or
 * localhost); elsewhere, and when the camera is refused or missing, the scanner uses the camera app instead.
 *
 * The camera is on only while this is shown: every track is stopped when it unmounts or the page is hidden, so the
 * camera light goes off and its memory is free for straightening the page.
 */
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { canTapToFocus, focusAt, keepFocused, openCamera, storage, takeWarmCamera } from "./camera-pick.ts";

/**
 * The photo is the frame on screen when the shutter is pressed, so it's instant. (`ImageCapture.takePhoto` gives full
 * sensor resolution but switches the camera into still mode and refocuses on every shot: 2–4 s on Android phones.)
 */

function stop(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Why the camera couldn't start, for the message shown with the camera-app fallback. */
function reason(err: unknown) {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access is off for this site, so Take photo uses the phone's camera app.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found on this device.";
  if (name === "NotReadableError") return "The camera is busy in another app.";
  return "The camera couldn't start.";
}

export default function Camera({
  onPhoto,
  onFail,
  burst = false,
  left,
  right,
}: {
  /** The frame on screen when the shutter was pressed (the receiver closes it). */
  onPhoto: (photo: ImageBitmap) => void;
  /** The camera can't be used: fall back to the camera app (with this message). */
  onFail: (message: string) => void;
  /** Keep the camera live after a shot (plain photos, several in a row) instead of holding the picture still. */
  burst?: boolean;
  /** Footer buttons either side of the shutter (choose a photo; done). */
  left?: ReactNode;
  right?: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [shooting, setShooting] = useState(false);
  // Bumped on each shot in burst mode: a quick white flash says the photo was taken.
  const [flash, setFlash] = useState(0);
  // Where the last tap-to-focus was (CSS px in the stage), shown as a ring for a moment.
  const [tappable, setTappable] = useState(false);
  const [ring, setRing] = useState<{ x: number; y: number; key: number } | null>(null);
  // The picture's shape (width / height), so the frame around it is exactly the picture: overlays sit on the image.
  const [shape, setShape] = useState(3 / 4);
  const fail = useEffectEvent((message: string) => onFail(message));

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      if (streamRef.current || document.hidden) return;
      try {
        // Started by the button tap where it could be (`warmCamera`), so it opens while this screen loads.
        const stream = await (takeWarmCamera() ?? openCamera(navigator.mediaDevices, storage()));
        // Hidden, closed, or a second start won the race while this one waited: keep only one stream.
        if (cancelled || document.hidden || streamRef.current) return stop(stream);
        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => {});
        // Some phones only report focus controls once the picture is flowing.
        keepFocused(stream.getVideoTracks()[0]);
        setTappable(canTapToFocus(stream.getVideoTracks()[0]));
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) fail(reason(err));
      }
    };
    const end = () => {
      stop(streamRef.current);
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setReady(false);
    };
    // A hidden page keeps no camera: stop it, and start again when the page is back.
    const onVisibility = () => (document.hidden ? end() : void start());
    document.addEventListener("visibilitychange", onVisibility);
    void start();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      end();
    };
  }, []);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video || !streamRef.current || shooting) return;
    setShooting(true);
    try {
      const frame = await createImageBitmap(video);
      if (burst) {
        setFlash((n) => n + 1);
        setShooting(false);
      } else video.pause(); // the picture holds still while the page is found
      onPhoto(frame);
    } catch {
      setShooting(false);
    }
  };

  /** Tap to focus there: the tap's place in the picture (the frame is exactly the picture). */
  const tapToFocus = (e: PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    if (focusAt(streamRef.current?.getVideoTracks()[0], x, y))
      setRing({ x: e.clientX - box.left, y: e.clientY - box.top, key: Date.now() });
  };

  const measure = () => {
    const v = videoRef.current;
    if (v?.videoWidth && v.videoHeight) setShape(v.videoWidth / v.videoHeight);
  };

  return (
    <>
      <div className="scanner-stage scan-camera">
        <div className="scan-camera-frame" style={{ "--shape": shape } as CSSProperties} onPointerUp={tapToFocus}>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            aria-label="Camera"
            onLoadedMetadata={measure}
            onResize={measure}
          />
          {ring && (
            <span
              key={ring.key}
              className="scan-focus-ring"
              style={{ left: ring.x, top: ring.y }}
              onAnimationEnd={() => setRing(null)}
              aria-hidden
            />
          )}
          {ready && tappable && (
            <p className="scan-camera-hint">
              <FocusIcon />
              Tap the page to focus
            </p>
          )}
          {flash > 0 && <span key={flash} className="scan-flash" aria-hidden />}
        </div>
        {!ready && (
          <p className="scan-camera-starting">
            <span className="tile-spinner" aria-hidden />
            Starting the camera…
          </p>
        )}
      </div>
      <footer className="scanner-foot scan-camera-foot">
        <div className="scan-camera-side">{left}</div>
        <button
          type="button"
          className="scan-shutter"
          aria-label="Take photo"
          disabled={!ready || shooting}
          onClick={() => void shoot()}
        >
          <span aria-hidden />
        </button>
        <div className="scan-camera-side">{right}</div>
      </footer>
    </>
  );
}

/** A round button beside the shutter: an icon with a caption under it (and a count, for Done). */
export function CameraButton({
  label,
  icon,
  onClick,
  disabled,
  primary,
  count,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** The main action (Done): filled in the accent colour. */
  primary?: boolean;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={`scan-side-btn ${primary ? "primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={count ? `${label} (${count})` : label}
    >
      <span className="scan-side-icon">
        {icon}
        {!!count && <span className="scan-side-count">{count}</span>}
      </span>
      <span className="scan-side-label" aria-hidden>
        {label}
      </span>
    </button>
  );
}

const svg = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const GalleryIcon = () => (
  <svg {...svg}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="9" cy="9" r="1.6" />
    <path d="m21 15-4.5-4.5L7 20" />
  </svg>
);

/** The phone's own camera app: a camera with an arrow out of it. */
export const CameraAppIcon = () => (
  <svg {...svg}>
    <path d="M14.5 4h-5L7.5 6.5H5a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
    <circle cx="12" cy="13" r="3.5" />
    <path d="M17 3h4v4M21 3l-4.5 4.5" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...svg} strokeWidth={2.6}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

const FocusIcon = () => (
  <svg {...svg} width={16} height={16}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);
