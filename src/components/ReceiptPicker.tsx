import { useRef, type ReactNode } from "react";
import type { Attachment } from "../api.ts";
import type { OutboxFile } from "../outbox.ts";
import type { ReceiptUploads } from "../receipt-uploads.ts";

interface Props {
  uploads: ReceiptUploads;
  /** Receipts already on the entry (editing). */
  attachments?: Attachment[];
  onRemoveAttachment?: (id: number) => void;
  /** Receipts waiting on this device with a queued entry. */
  queuedFiles?: OutboxFile[];
  onRemoveQueued?: (index: number) => void;
}

export default function ReceiptPicker({
  uploads,
  attachments = [],
  onRemoveAttachment,
  queuedFiles = [],
  onRemoveQueued,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
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
        <button type="button" className="receipt-btn" onClick={() => cameraRef.current?.click()}>
          <CameraIcon />
          Take photo
        </button>
        <button type="button" className="receipt-btn" onClick={() => fileRef.current?.click()}>
          <FileIcon />
          Choose file
        </button>
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

      {count > 0 && (
        <ul className="receipt-tiles">
          {attachments.map((a) => (
            <Tile
              key={`a${a.id}`}
              name={a.filename}
              href={`/api/attachments/${a.id}`}
              thumb={a.content_type.startsWith("image/") ? `/api/attachments/${a.id}` : null}
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
