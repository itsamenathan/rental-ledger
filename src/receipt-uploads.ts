import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "./portfolio.ts";
import { api } from "./api.ts";
import { isUnreachable, timeout, UPLOAD_TIMEOUT_MS } from "./outbox.ts";

/**
 * A receipt picked in the entry form. It's uploaded right away (`POST /api/uploads`) and attached when the entry is
 * saved (`upload_ids`); closing the form without saving discards it. Without a connection it stays on this device
 * ("local") and goes with the entry through the outbox.
 */
export interface PickedReceipt {
  key: string;
  file: File;
  preview: string | null;
  /** A picture sent with the file for showing it later (a scanned PDF's first page). */
  picture?: Blob;
  status: "uploading" | "done" | "local" | "error";
  uploadId?: number;
  error?: string;
}

/** Tell the server to drop uploads that won't be saved. Survives the page closing; failures are left to the server's prune. */
function discard(ids: number[]) {
  if (!ids.length) return;
  void fetch(apiUrl("/api/uploads/discard"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
    keepalive: true,
  }).catch(() => {});
}

let seq = 0;

/**
 * Receipts picked in one form. `stage: false` keeps every file on this device (editing an entry that is itself still
 * waiting to sync).
 */
export function useReceiptUploads({ stage }: { stage: boolean }) {
  const [items, setItems] = useState<PickedReceipt[]>([]);
  // The latest list, for the unmount/pagehide cleanup and for awaiting uploads in a save handler.
  const itemsRef = useRef(items);
  const inflight = useRef(new Map<string, Promise<void>>());
  // The form is gone: an upload that finishes now is discarded instead of kept.
  const closed = useRef(false);

  const update = useCallback((fn: (list: PickedReceipt[]) => PickedReceipt[]) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);
  const patch = useCallback(
    (key: string, p: Partial<PickedReceipt>) => update((l) => l.map((i) => (i.key === key ? { ...i, ...p } : i))),
    [update],
  );

  const upload = useCallback(
    (item: PickedReceipt) => {
      const form = new FormData();
      form.append("file", item.file);
      if (item.picture) form.append("preview", item.picture, "preview.jpg");
      const run = api<{ id: number }>("uploads", { method: "POST", body: form, signal: timeout(UPLOAD_TIMEOUT_MS) })
        .then((r) => {
          // Removed while uploading: drop it on the server too.
          if (closed.current || !itemsRef.current.some((i) => i.key === item.key)) return discard([r.id]);
          patch(item.key, { status: "done", uploadId: r.id, error: undefined });
        })
        .catch((err: unknown) => {
          if (isUnreachable(err)) patch(item.key, { status: "local", error: undefined });
          else patch(item.key, { status: "error", error: (err as Error).message });
        })
        .finally(() => inflight.current.delete(item.key));
      inflight.current.set(item.key, run);
    },
    [patch],
  );

  /** `previews[i]` is a picture to show for `files[i]` when the file isn't one (a scanned PDF's first page). */
  const add = useCallback(
    (files: File[], previews: (Blob | undefined)[] = []) => {
      const added = files.map((file, i): PickedReceipt => ({
        key: `r${++seq}`,
        file,
        preview: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : previews[i]
            ? URL.createObjectURL(previews[i])
            : null,
        picture: file.type.startsWith("image/") ? undefined : previews[i],
        status: stage ? "uploading" : "local",
      }));
      update((l) => [...l, ...added]);
      if (stage) added.forEach(upload);
    },
    [stage, update, upload],
  );

  const retry = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (!item) return;
      patch(key, { status: "uploading", error: undefined });
      upload({ ...item, status: "uploading" });
    },
    [patch, upload],
  );

  const remove = useCallback(
    (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (!item) return;
      if (item.uploadId) discard([item.uploadId]);
      if (item.preview) URL.revokeObjectURL(item.preview);
      update((l) => l.filter((i) => i.key !== key));
    },
    [update],
  );

  /** Wait for uploads still in flight, then report what the save should send. */
  const settle = useCallback(async () => {
    await Promise.all(inflight.current.values());
    const list = itemsRef.current;
    return {
      uploadIds: list.filter((i) => i.status === "done").map((i) => i.uploadId!),
      /** Files that couldn't be uploaded for lack of a connection: send them after the save, or queue them. */
      localFiles: list.filter((i) => i.status === "local").map((i) => i.file),
      /** Every file still wanted, for a save that has to wait on this device. */
      allFiles: list.filter((i) => i.status !== "error").map((i) => i.file),
      failed: list.filter((i) => i.status === "error"),
    };
  }, []);

  /**
   * Forget every receipt. `saved`: the entry kept them (nothing to discard). Otherwise uploads are dropped on the server,
   * e.g. when the files went into the outbox with the entry instead.
   */
  const clear = useCallback(
    ({ saved }: { saved: boolean }) => {
      const list = itemsRef.current;
      if (!saved) discard(list.flatMap((i) => (i.uploadId ? [i.uploadId] : [])));
      list.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
      update(() => []);
    },
    [update],
  );

  // Closing the form (or the page) without saving discards what was uploaded for it.
  useEffect(() => {
    const drop = () => discard(itemsRef.current.flatMap((i) => (i.uploadId ? [i.uploadId] : [])));
    const onHide = (e: PageTransitionEvent) => {
      if (!e.persisted) drop();
    };
    closed.current = false;
    window.addEventListener("pagehide", onHide);
    return () => {
      closed.current = true;
      window.removeEventListener("pagehide", onHide);
      drop();
      itemsRef.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
    };
  }, []);

  return { items, add, remove, retry, settle, clear, uploading: items.some((i) => i.status === "uploading") };
}

export type ReceiptUploads = ReturnType<typeof useReceiptUploads>;
