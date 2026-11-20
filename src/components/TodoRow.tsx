import type { ReactNode } from "react";
import { Amount } from "../lib.tsx";

/**
 * One To do item. Every kind uses the same shape: what it's about (with its date and, in the all-properties view,
 * its property) on the first line, what's wrong on the second, the amount if there is one, then what you can do.
 */
export default function TodoRow({
  title,
  when,
  property,
  note,
  amount,
  onOpen,
  children,
}: {
  title: ReactNode;
  /** date or month the item is about */
  when?: string;
  /** property name, only when the list covers several */
  property?: string;
  note?: ReactNode;
  amount?: number;
  /** makes the text a button (opens the entry) */
  onOpen?: () => void;
  /** actions */
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className="todo-what">
        <strong>{title}</strong>
        {when && <span className="muted small"> · {when}</span>}
        {property && <span className="badge">{property}</span>}
      </span>
      {note && <span className="todo-note">{note}</span>}
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button className="todo-main" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="todo-main as-text">{body}</div>
      )}
      {amount != null ? <Amount value={amount} /> : <span />}
      <span className="todo-actions">{children}</span>
    </li>
  );
}
