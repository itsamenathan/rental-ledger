import { api, ApiError, type Attachment, type Transaction } from "../api.ts";
import { money } from "../format.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import { Modal } from "../lib.tsx";
import { enqueueDelete, isUnreachable, SAVE_TIMEOUT_MS, timeout } from "../outbox.ts";
import TxForm from "./TxForm.tsx";

/**
 * Load a transaction and edit it in a dialog. Deleting offers an undo toast. With no connection, the last copy the
 * app saw (`initial`, e.g. the list row) is used, and edits/deletes wait on this device until it reconnects.
 */
export default function TxEditModal({
  id,
  initial,
  onClose,
  onChanged,
}: {
  id: number;
  initial?: Transaction;
  onClose: () => void;
  onChanged: () => void;
}) {
  const loaded = useApi<Transaction & { attachments: Attachment[] }>(`transactions/${id}`);
  const { canWrite, user } = useSession();
  const toast = useToast();
  const fallback = !loaded.data && loaded.error && initial ? { ...initial, attachments: [] } : null;
  const data = loaded.data ?? fallback;
  const error = data ? null : loaded.error;
  const label = data ? `${data.category}${data.vendor ? ` (${data.vendor})` : ""} · ${money(data.amount)}` : "";

  const queued = (text: string) => {
    toast({ text, kind: "ok" });
    onChanged();
    onClose();
  };

  const del = async () => {
    if (!confirm("Delete this transaction?")) return;
    try {
      const guard = data ? `?expected_updated_at=${encodeURIComponent(data.updated_at)}` : "";
      await api(`transactions/${id}${guard}`, { method: "DELETE", signal: timeout(SAVE_TIMEOUT_MS) });
    } catch (err) {
      if (!data || !isUnreachable(err)) {
        const text =
          err instanceof ApiError && err.status === 409
            ? "This entry was changed since you opened it. Close and reopen it before deleting."
            : (err as Error).message;
        toast({ text, kind: "error" });
        return;
      }
      const { attachments: _a, ...base } = data;
      await enqueueDelete({ userId: user.id, base, label });
      queued(`No connection: deleting ${label} will sync when you're back online`);
      return;
    }
    onChanged();
    onClose();
    toast({
      text: "Transaction deleted",
      kind: "ok",
      action: {
        label: "Undo",
        run: () => void api(`transactions/${id}/restore`, { method: "POST" }).then(onChanged),
      },
    });
  };

  return (
    <Modal title={`Edit transaction #${id}`} onClose={onClose} wide>
      {error && <div className="alert error">{error}</div>}
      {fallback && (
        <div className="alert warn">
          Can't reach the server, so this is the last copy on this device (receipts aren't shown). Changes are saved
          here and sync when you're back online.
        </div>
      )}
      {!data ? (
        <p className="muted">Loading…</p>
      ) : canWrite ? (
        <TxForm
          key={fallback ? "offline" : "online"}
          existing={data}
          onSaved={() => {
            toast({ text: "Saved", kind: "ok" });
            onChanged();
            onClose();
          }}
          onQueued={queued}
          onDelete={() => void del()}
        />
      ) : (
        <pre className="readonly">{JSON.stringify(data, null, 2)}</pre>
      )}
    </Modal>
  );
}
