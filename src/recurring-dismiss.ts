import { api, dismissRecurring, type RecurringAlert } from "./api.ts";
import { useToast } from "./hooks.ts";

/** "It's fine" for a recurring alert (this month only, or stop tracking the bill), with Undo in the toast. */
export function useDismissAlert(onChanged: () => void) {
  const toast = useToast();
  const fail = (e: unknown) => toast({ text: (e as Error).message, kind: "error" });
  return async (a: RecurringAlert, whole: boolean) => {
    try {
      const { id } = await dismissRecurring(a.series_key, whole ? null : a.month);
      toast({
        text: whole ? `Stopped tracking ${a.label}` : "Got it, won't flag that again",
        kind: "ok",
        action: {
          label: "Undo",
          run: () => void api(`recurring/dismissals/${id}`, { method: "DELETE" }).then(onChanged, fail),
        },
      });
      onChanged();
    } catch (e) {
      fail(e);
    }
  };
}
