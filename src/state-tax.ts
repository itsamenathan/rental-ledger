/** Shared by the State tax page and the To do list (server/services/state-tax.ts). */
import { fmtDate } from "./format.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** When a quarter's return is due, in words. */
export function dueText(q: { due_date: string; days_left: number; status: string }) {
  if (q.status === "overdue") return `Overdue by ${plural(-q.days_left, "day")} (due ${fmtDate(q.due_date)})`;
  if (q.days_left === 0) return "Due today";
  return `Due ${fmtDate(q.due_date)}${q.days_left <= 31 ? ` (in ${plural(q.days_left, "day")})` : ""}`;
}
