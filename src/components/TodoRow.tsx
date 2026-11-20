import type { ReactNode } from "react";
import { Link } from "react-router";
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
  to,
  below,
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
  /** or makes it a link to where the item can be seen in full */
  to?: string;
  /** full-width content under the row (e.g. the two entries of a possible duplicate) */
  below?: ReactNode;
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
      ) : to ? (
        <Link className="todo-main" to={to}>
          {body}
        </Link>
      ) : (
        <div className="todo-main as-text">{body}</div>
      )}
      {amount != null ? <Amount value={amount} /> : <span />}
      <span className="todo-actions">{children}</span>
      {below && <div className="todo-below">{below}</div>}
    </li>
  );
}
