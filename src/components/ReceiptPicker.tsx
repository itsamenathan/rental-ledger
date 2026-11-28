import { useCallback, useEffect, useEffectEvent, useRef, useState, type ComponentType, type ReactNode } from "react";
import { apiUrl } from "../portfolio.ts";
import { useLocation, useNavigate } from "react-router";
import type { Attachment } from "../api.ts";
import type { OutboxFile } from "../outbox.ts";
import type { ReceiptUploads } from "../receipt-uploads.ts";
import { useToast } from "../hooks.ts";
import { warmCamera } from "../scanner/camera-pick.ts";
import { canUseCamera } from "../scanner/live-camera.ts";
import type { ScanResult } from "../scanner/Scanner.tsx";

// The scanner and the photo camera are separate files, fetched while the form is open (`useModule`).
const loadScanner = () => import("../scanner/Scanner.tsx");
const loadPhotoCamera = () => import("../scanner/PhotoCamera.tsx");

/**
 * A screen whose code is fetched on demand: `load()` (again) on a tap if it isn't here yet. Not React.lazy: React
 * holds a lazy screen back for ~300 ms even when its code arrives at once, and the camera screens should be instant.
 */
function useModule<P>(load: () => Promise<{ default: ComponentType<P> }>, onError: () => void) {
  const [component, setComponent] = useState<ComponentType<P> | null>(null);
  const fetch = useCallback(
    () =>
      void load().then(
        (m) => setComponent(() => m.default),
        () => onError(),
      ),
    [load, onError],
  );
  return [component, fetch] as const;
}

/**
 * The phone's Back button closes an open camera or scanner instead of leaving the page: opening one adds a history
 * entry (same address, a marker in its state); Back removes it, which closes the screen, and closing the screen any
 * other way goes back over that entry so the history stays as it was.
 */
function useBackCloses(open: boolean, close: () => void) {
  const navigate = useNavigate();
  const location = useLocation();
  const pushed = useRef(false);
  // True once the marked entry is the current one; a location without the marker after that means Back was pressed.
  const armed = useRef(false);
  const onBack = useEffectEvent(close);
  const marked = !!(location.state as { receiptCamera?: boolean } | null)?.receiptCamera;
  useEffect(() => {
    if (open && !pushed.current) {
      pushed.current = true;
      void navigate(location, { state: { ...(location.state as object | null), receiptCamera: true } });
    } else if (!open && pushed.current) {
      pushed.current = false;
      if (armed.current) {
        armed.current = false;
        void navigate(-1);
      }
    }
  }, [open, navigate, location]);
  useEffect(() => {
    if (marked) armed.current = true;
    else if (armed.current) {
      armed.current = false;
      pushed.current = false;
      onBack();
    }
  }, [marked]);
}

interface Props {
  uploads: ReceiptUploads;
  /** Receipts already on the entry (editing). */
  attachments?: Attachment[];
  onRemoveAttachment?: (id: number) => void;
  /** Receipts waiting on this device with a queued entry. */
  queuedFiles?: OutboxFile[];
  onRemoveQueued?: (index: number) => void;
  /** A document was scanned (it's already added to the uploads); the form may read its text. */
  onScanned?: (result: ScanResult) => void;
}

export default function ReceiptPicker({
  uploads,
  attachments = [],
  onRemoveAttachment,
  queuedFiles = [],
  onRemoveQueued,
  onScanned,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  /** The photo the scanner opens with (the Scan button goes straight to the camera). */
  // The scanner is open: with a photo from the camera app, or (where the browser allows) with its own camera.
  const [scan, setScan] = useState<{ initial?: File } | null>(null);
  // The in-app camera for plain photos (where the browser allows a live camera).
  const [photoCam, setPhotoCam] = useState(false);
  const toast = useToast();
  const loadFailed = useCallback(() => {
    setScan(null);
    setPhotoCam(false);
    toast({ text: "Couldn't load the camera. Check the connection and try again.", kind: "error" });
  }, [toast]);
  const [Scanner, fetchScanner] = useModule(loadScanner, loadFailed);
  const [PhotoCamera, fetchPhotoCamera] = useModule(loadPhotoCamera, loadFailed);
  // Fetch them while the form is open (after it has settled), so tapping Scan or Photo shows them at once.
  useEffect(() => {
    const idle = globalThis.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1200));
    const cancel = globalThis.cancelIdleCallback ?? clearTimeout;
    const id = idle(() => {
      fetchScanner();
      if (canUseCamera()) fetchPhotoCamera();
    });
    return () => cancel(id as number);
  }, [fetchScanner, fetchPhotoCamera]);
  useBackCloses(!!scan || photoCam, () => {
    setScan(null);
    setPhotoCam(false);
  });
  const openLive = (which: "scan" | "photo") => {
    // The camera starts opening now, while the screen appears. (Not on touch-down: a touch that becomes a scroll
    // would switch the camera on for a moment, and phones show a camera-in-use light.)
    warmCamera();
    if (which === "scan") {
      if (!Scanner) fetchScanner();
      setScan({});
    } else {
      if (!PhotoCamera) fetchPhotoCamera();
      setPhotoCam(true);
    }
  };
  const pick = (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])];
    input.value = ""; // picking the same file again still fires change
    if (files.length) uploads.add(files);
  };
  const count = attachments.length + queuedFiles.length + uploads.items.length;

  return (
    <div className="receipts">
      <div className="receipts-head">
        <span>
          Receipt <span className="optional">optional</span>
        </span>
        {count > 0 && <span className="muted small">{count === 1 ? "1 file" : `${count} files`}</span>}
      </div>
      <div className="receipt-actions">
        <button
          type="button"
          className="receipt-btn"
          onClick={() => (canUseCamera() ? openLive("scan") : scanRef.current?.click())}
          title="Photograph a receipt or document: the page is cropped, straightened and cleaned up, and the total is read"
        >
          <ScanIcon />
          Scan
        </button>
        <button
          type="button"
          className="receipt-btn"
          onClick={() => (canUseCamera() ? openLive("photo") : cameraRef.current?.click())}
        >
          <CameraIcon />
          Photo
        </button>
        <button type="button" className="receipt-btn" onClick={() => fileRef.current?.click()}>
          <FileIcon />
          File
        </button>
        <input
          ref={scanRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (!file) return;
            if (!Scanner) fetchScanner();
            setScan({ initial: file });
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => pick(e.currentTarget)}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(e) => pick(e.currentTarget)}
        />
      </div>

      {photoCam && !PhotoCamera && <Opening what="camera" />}
      {photoCam && PhotoCamera && (
        <PhotoCamera
          onClose={() => setPhotoCam(false)}
          onDone={(files) => {
            setPhotoCam(false);
            uploads.add(files);
          }}
          onCameraApp={(files) => {
            // Opened from the tap itself: browsers only open the camera app from a user's tap.
            cameraRef.current?.click();
            setPhotoCam(false);
            if (files.length) uploads.add(files);
          }}
        />
      )}

      {scan && !Scanner && <Opening what="scanner" />}
      {scan && Scanner && (
        <Scanner
          initial={scan.initial}
          onClose={() => setScan(null)}
          onDone={(result) => {
            setScan(null);
            uploads.add([result.file], [result.preview]);
            onScanned?.(result);
          }}
        />
      )}

      {count > 0 && (
        <ul className="receipt-tiles">
          {attachments.map((a) => (
            <Tile
              key={`a${a.id}`}
              name={a.filename}
              href={apiUrl(`/api/attachments/${a.id}`)}
              thumb={
                a.content_type.startsWith("image/")
                  ? apiUrl(`/api/attachments/${a.id}`)
                  : a.has_preview
                    ? apiUrl(`/api/attachments/${a.id}/preview`)
                    : null
              }
              status={<span className="tile-status ok">Saved</span>}
              onRemove={onRemoveAttachment && (() => onRemoveAttachment(a.id))}
            />
          ))}
          {queuedFiles.map((f, i) => (
            <Tile
              key={`q${i}-${f.name}`}
              name={f.name}
              thumb={null}
              status={<span className="tile-status">Waiting to sync</span>}
              onRemove={onRemoveQueued && (() => onRemoveQueued(i))}
            />
          ))}
          {uploads.items.map((r) => (
            <Tile
              key={r.key}
              name={r.file.name}
              thumb={r.preview}
              busy={r.status === "uploading"}
              status={
                r.status === "uploading" ? (
                  <span className="tile-status">Uploading…</span>
                ) : r.status === "done" ? (
                  <span className="tile-status ok">Uploaded</span>
                ) : r.status === "local" ? (
                  <span className="tile-status" title="No connection: it's sent with the entry">
                    Sends on save
                  </span>
                ) : (
                  <span className="tile-status bad" title={r.error}>
                    Failed ·{" "}
                    <button type="button" className="link" onClick={() => uploads.retry(r.key)}>
                      retry
                    </button>
                  </span>
                )
              }
              error={r.status === "error" ? r.error : undefined}
              onRemove={() => uploads.remove(r.key)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Tile({
  name,
  href,
  thumb,
  busy,
  status,
  error,
  onRemove,
}: {
  name: string;
  href?: string;
  thumb: string | null;
  busy?: boolean;
  status: ReactNode;
  error?: string;
  onRemove?: () => void;
}) {
  const face = (
    <span className={`tile-thumb ${busy ? "busy" : ""}`}>
      {thumb ? <img src={thumb} alt="" /> : <DocIcon name={name} />}
      {busy && <span className="tile-spinner" aria-hidden />}
    </span>
  );
  return (
    <li className={`receipt-tile ${error ? "failed" : ""}`} title={error ?? name}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${name}`}>
          {face}
        </a>
      ) : (
        face
      )}
      <span className="tile-name">{name}</span>
      {status}
      {onRemove && (
        <button type="button" className="tile-remove" onClick={onRemove} aria-label={`Remove ${name}`}>
          ×
        </button>
      )}
    </li>
  );
}

const iconProps = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function CameraIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg {...iconProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 18v-6M9 15l3-3 3 3" />
    </svg>
  );
}

function DocIcon({ name }: { name: string }) {
  const ext = name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
  return (
    <span className="tile-doc">
      <svg {...iconProps} width={26} height={26}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
      <span>{ext}</span>
    </span>
  );
}

/** Shown while the scanner or camera code loads (first use). */
function Opening({ what }: { what: string }) {
  return (
    <div className="scanner">
      <div className="scanner-stage scanner-msg">
        <span className="tile-spinner" aria-hidden />
        <p>Opening the {what}…</p>
      </div>
    </div>
  );
}
