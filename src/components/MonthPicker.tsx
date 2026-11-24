import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { monthLabel, monthTitle, thisMonth } from "../format.ts";

/** The month's title as a button: opens a year and 12 months to jump to, instead of stepping with the arrows. */
export default function MonthPicker({ ym, to }: { ym: string; to: (ym: string) => string }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(ym.slice(0, 4)));
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const now = thisMonth();
  return (
    <div className="month-picker" ref={box}>
      <h1>
        <button
          className="month-title"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setYear(Number(ym.slice(0, 4)));
            setOpen((o) => !o);
          }}
        >
          {monthTitle(ym)} <span aria-hidden="true">▾</span>
        </button>
      </h1>
      {open && (
        <div className="month-pop" role="dialog" aria-label="Pick a month">
          <div className="month-pop-year">
            <button className="icon-btn" onClick={() => setYear(year - 1)} aria-label="Previous year">
              ‹
            </button>
            <strong>{year}</strong>
            <button className="icon-btn" onClick={() => setYear(year + 1)} aria-label="Next year">
              ›
            </button>
          </div>
          <div className="month-pop-grid">
            {Array.from({ length: 12 }, (_, i) => {
              const m = `${year}-${String(i + 1).padStart(2, "0")}`;
              return (
                <Link
                  key={m}
                  to={to(m)}
                  className={`${m === ym ? "on" : ""} ${m === now ? "now" : ""}`}
                  aria-current={m === ym ? "date" : undefined}
                  onClick={() => setOpen(false)}
                >
                  {monthLabel(m)}
                </Link>
              );
            })}
          </div>
          {now !== ym && (
            <Link className="link small" to={to(now)} onClick={() => setOpen(false)}>
              This month
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
