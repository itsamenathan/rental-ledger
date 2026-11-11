import { api, type Attachment, type Transaction } from "../api.ts";
import { useApi, useSession, useToast } from "../hooks.ts";
import { Modal } from "../lib.tsx";
import TxForm from "./TxForm.tsx";

/** Load a transaction and edit it in a dialog. Deleting offers an undo toast. */
export default function TxEditModal({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, error } = useApi<Transaction & { attachments: Attachment[] }>(`transactions/${id}`);
  const { canWrite } = useSession();
  const toast = useToast();

  const del = async () => {
    if (!confirm("Delete this transaction?")) return;
    await api(`transactions/${id}`, { method: "DELETE" });
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
      {!data ? (
        <p className="muted">Loading…</p>
      ) : canWrite ? (
        <TxForm
          existing={data}
          onSaved={() => {
            toast({ text: "Saved", kind: "ok" });
            onChanged();
            onClose();
          }}
          onDelete={() => void del()}
        />
      ) : (
        <pre className="readonly">{JSON.stringify(data, null, 2)}</pre>
      )}
    </Modal>
  );
}
