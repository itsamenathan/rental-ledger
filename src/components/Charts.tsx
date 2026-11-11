import { useEffect, useRef, useState } from "react";
import { money, money0, monthLabel, moneyCompact } from "../format.ts";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Rounded data-end, square at the baseline. */
function columnPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export interface MonthPoint {
  month: string;
  income: number;
  expense: number;
  net: number;
}

/** Income vs expenses by month: two series, legend, hover tooltip, table view. */
export function MonthlyChart({ data, onPick }: { data: MonthPoint[]; onPick?: (month: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const height = 240;
  const m = { t: 12, r: 8, b: 26, l: 52 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.income, d.expense)), 0));
  const band = iw / data.length;
  const bar = Math.min(18, (band - 10) / 2);
  const y = (v: number) => m.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <div className="legend">
          <span>
            <i className="key s1" /> Income
          </span>
          <span>
            <i className="key s2" /> Expenses
          </span>
        </div>
        <button className="link small" onClick={() => setAsTable((t) => !t)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Income</th>
              <th className="num">Expenses</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.month}>
                <td>
                  {onPick ? (
                    <button className="link" onClick={() => onPick(d.month)}>
                      {monthLabel(d.month, "long")}
                    </button>
                  ) : (
                    monthLabel(d.month, "long")
                  )}
                </td>
                <td className="num">{money(d.income)}</td>
                <td className="num">{money(d.expense)}</td>
                <td className="num">{money(d.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-plot">
          <svg width={width} height={height} role="img" aria-label="Monthly income and expenses">
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid" x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
                <text className="tick" x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {moneyCompact(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = m.l + band * i + band / 2;
              return (
                <g key={d.month} className={hover !== null && hover !== i ? "dim" : ""}>
                  <path className="s1-fill" d={columnPath(cx - bar - 1, y(d.income), bar, m.t + ih - y(d.income))} />
                  <path className="s2-fill" d={columnPath(cx + 1, y(d.expense), bar, m.t + ih - y(d.expense))} />
                  <text className="tick" x={cx} y={height - 8} textAnchor="middle">
                    {width < 480 ? monthLabel(d.month).slice(0, 1) : monthLabel(d.month)}
                  </text>
                  <rect
                    x={m.l + band * i}
                    y={m.t}
                    width={band}
                    height={ih}
                    fill="transparent"
                    style={onPick ? { cursor: "pointer" } : undefined}
                    onClick={() => onPick?.(d.month)}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onTouchStart={() => setHover(i)}
                  />
                </g>
              );
            })}
            <line className="axis" x1={m.l} x2={width - m.r} y1={m.t + ih} y2={m.t + ih} />
          </svg>
          {hover !== null && (
            <div
              className="tooltip"
              style={{ left: Math.min(width - 170, Math.max(0, m.l + band * hover + band / 2 - 80)), top: 4 }}
            >
              <strong>{monthLabel(data[hover]!.month, "long")}</strong>
              <div>
                <i className="key s1" /> Income <b>{money0(data[hover]!.income)}</b>
              </div>
              <div>
                <i className="key s2" /> Expenses <b>{money0(data[hover]!.expense)}</b>
              </div>
              <div className="tt-net">
                Net <b>{money0(data[hover]!.net)}</b>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Single-series horizontal bars (e.g. expenses by category). Values labeled at the bar tip. */
export function HBars({
  rows,
  onPick,
}: {
  rows: { label: string; value: number; sub?: string; key: string | number }[];
  onPick?: (key: string | number) => void;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="hbars">
      {rows.map((r) => (
        <li key={r.key}>
          <button className="hbar-row" onClick={() => onPick?.(r.key)} disabled={!onPick} title={r.sub}>
            <span className="hbar-label">{r.label}</span>
            <span className="hbar-track">
              <span className="hbar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
            <span className="hbar-value">{money0(r.value)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

function niceDomain(lo: number, hi: number) {
  const span = niceMax(Math.max(Math.abs(lo), Math.abs(hi), 1));
  const step = span / 4;
  return [Math.floor(Math.min(lo, 0) / step) * step, Math.ceil(Math.max(hi, 0) / step) * step, step] as const;
}

export interface CumulativeSeries {
  label: string;
  /** cumulative values per month; null = no data yet (future months) */
  values: (number | null)[];
  /** "current" is the colored hero line; "compare" is the muted reference */
  role: "current" | "compare";
}

/** Running total by month for this year vs last year: two lines, end labels, crosshair tooltip, table view. */
export function CumulativeChart({
  series,
  months,
  onPick,
}: {
  series: CumulativeSeries[];
  months: string[];
  onPick?: (month: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const height = 220;
  const m = { t: 14, r: 92, b: 26, l: 56 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const [lo, hi, step] = niceDomain(Math.min(0, ...all), Math.max(0, ...all));
  const y = (v: number) => m.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const band = iw / months.length;
  const x = (i: number) => m.l + band * i + band / 2;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + 1e-6; v += step) ticks.push(v);
  const path = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
      .filter(Boolean)
      .map((p, i) => `${i ? "L" : "M"}${p}`)
      .join("");
  const last = (vals: (number | null)[]) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i;
    return -1;
  };
  // keep the two end labels from colliding
  const ends = series.map((s) => ({ s, i: last(s.values) })).filter((e) => e.i >= 0);
  const labelY = ends.map((e) => y(e.s.values[e.i]!));
  if (labelY.length === 2 && Math.abs(labelY[0]! - labelY[1]!) < 26) {
    const mid = (labelY[0]! + labelY[1]!) / 2;
    const up = labelY[0]! <= labelY[1]! ? 0 : 1;
    labelY[up] = mid - 13;
    labelY[1 - up] = mid + 13;
  }

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <div className="legend">
          {series.map((s) => (
            <span key={s.label}>
              <i className={`key line ${s.role}`} /> {s.label}
            </span>
          ))}
        </div>
        <button className="link small" onClick={() => setAsTable((t) => !t)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Through</th>
              {series.map((s) => (
                <th key={s.label} className="num">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {months.map((mo, i) => (
              <tr key={mo}>
                <td>{monthLabel(mo, "long")}</td>
                {series.map((s) => (
                  <td key={s.label} className="num">
                    {s.values[i] == null ? "—" : money0(s.values[i])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-plot">
          <svg width={width} height={height} role="img" aria-label="Running profit by month, this year vs last year">
            {ticks.map((t) => (
              <g key={t}>
                <line className={t === 0 ? "axis" : "grid"} x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
                <text className="tick" x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {moneyCompact(t)}
                </text>
              </g>
            ))}
            {months.map((mo, i) => (
              <text key={mo} className="tick" x={x(i)} y={height - 8} textAnchor="middle">
                {width < 480 ? monthLabel(mo).slice(0, 1) : monthLabel(mo)}
              </text>
            ))}
            {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} />}
            {[...series].reverse().map((s) => (
              <path key={s.label} className={`line ${s.role}`} d={path(s.values)} />
            ))}
            {ends.map((e, k) => (
              <g key={e.s.label}>
                <circle className={`dot ${e.s.role}`} cx={x(e.i)} cy={y(e.s.values[e.i]!)} r={4.5} />
                <text className="end-label" x={x(e.i) + 10} y={labelY[k]} dy="0.32em">
                  <tspan className="end-name">{e.s.label}</tspan>
                  <tspan x={x(e.i) + 10} dy="1.15em">
                    {money0(e.s.values[e.i])}
                  </tspan>
                </text>
              </g>
            ))}
            {hover !== null &&
              series.map((s) =>
                s.values[hover] == null ? null : (
                  <circle key={s.label} className={`dot ${s.role}`} cx={x(hover)} cy={y(s.values[hover]!)} r={4} />
                ),
              )}
            {months.map((mo, i) => (
              <rect
                key={mo}
                x={m.l + band * i}
                y={m.t}
                width={band}
                height={ih}
                fill="transparent"
                style={onPick ? { cursor: "pointer" } : undefined}
                onClick={() => onPick?.(mo)}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onTouchStart={() => setHover(i)}
              />
            ))}
          </svg>
          {hover !== null && (
            <div className="tooltip" style={{ left: Math.min(width - 180, Math.max(0, x(hover) - 85)), top: 4 }}>
              <strong>Through {monthLabel(months[hover]!, "long")}</strong>
              {series.map((s) => (
                <div key={s.label}>
                  <i className={`key line ${s.role}`} /> {s.label}{" "}
                  <b>{s.values[hover] == null ? "—" : money0(s.values[hover])}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface StackSeries {
  label: string;
  values: number[];
}

/** Monthly totals split into a few series (stacked columns). Series order = color order = stack order. */
export function StackedMonthly({
  series,
  months,
  onPick,
}: {
  series: StackSeries[];
  months: string[];
  onPick?: (month: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const height = 240;
  const m = { t: 12, r: 8, b: 26, l: 52 };
  const iw = width - m.l - m.r;
  const ih = height - m.t - m.b;
  const totals = months.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = niceMax(Math.max(...totals, 0));
  const band = iw / months.length;
  const bar = Math.min(28, band - 8);
  const y = (v: number) => m.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const yearTotal = (s: StackSeries) => s.values.reduce((a, v) => a + v, 0);
  const slot = (k: number) => (k < 4 ? `s${k + 1}` : "sother");

  return (
    <div className="chart" ref={ref}>
      <div className="chart-head">
        <div className="legend">
          {series.map((s, k) => (
            <span key={s.label}>
              <i className={`key ${slot(k)}`} /> {s.label} <b className="legend-value">{money0(yearTotal(s))}</b>
            </span>
          ))}
        </div>
        <button className="link small" onClick={() => setAsTable((t) => !t)}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>Month</th>
              {series.map((s) => (
                <th key={s.label} className="num">
                  {s.label}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {months.map((mo, i) => (
              <tr key={mo}>
                <td>{monthLabel(mo, "long")}</td>
                {series.map((s) => (
                  <td key={s.label} className="num">
                    {money0(s.values[i])}
                  </td>
                ))}
                <td className="num">{money0(totals[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-plot">
          <svg width={width} height={height} role="img" aria-label="Monthly expenses by category">
            {ticks.map((t) => (
              <g key={t}>
                <line className="grid" x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />
                <text className="tick" x={m.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
                  {moneyCompact(t)}
                </text>
              </g>
            ))}
            {months.map((mo, i) => {
              const cx = m.l + band * i + band / 2;
              let base = 0;
              const top = series.reduce((k, s, j) => ((s.values[i] ?? 0) > 0 ? j : k), -1);
              return (
                <g key={mo} className={hover !== null && hover !== i ? "dim" : ""}>
                  {series.map((s, k) => {
                    const v = s.values[i] ?? 0;
                    if (v <= 0) return null;
                    const y0 = y(base);
                    base += v;
                    const y1 = y(base);
                    const h = Math.max(0, y0 - y1 - (k === top ? 0 : 2)); // 2px gap between segments
                    return k === top ? (
                      <path key={s.label} className={`${slot(k)}-fill`} d={columnPath(cx - bar / 2, y1, bar, h)} />
                    ) : (
                      <rect
                        key={s.label}
                        className={`${slot(k)}-fill`}
                        x={cx - bar / 2}
                        y={y1 + 2}
                        width={bar}
                        height={h}
                      />
                    );
                  })}
                  <text className="tick" x={cx} y={height - 8} textAnchor="middle">
                    {width < 480 ? monthLabel(mo).slice(0, 1) : monthLabel(mo)}
                  </text>
                  <rect
                    x={m.l + band * i}
                    y={m.t}
                    width={band}
                    height={ih}
                    fill="transparent"
                    style={onPick ? { cursor: "pointer" } : undefined}
                    onClick={() => onPick?.(mo)}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onTouchStart={() => setHover(i)}
                  />
                </g>
              );
            })}
            <line className="axis" x1={m.l} x2={width - m.r} y1={m.t + ih} y2={m.t + ih} />
          </svg>
          {hover !== null && (
            <div
              className="tooltip"
              style={{ left: Math.min(width - 200, Math.max(0, m.l + band * hover + band / 2 - 95)), top: 4 }}
            >
              <strong>{monthLabel(months[hover]!, "long")}</strong>
              {[...series].reverse().map((s) => {
                const k = series.indexOf(s);
                return (
                  <div key={s.label}>
                    <i className={`key ${slot(k)}`} /> {s.label} <b>{money0(s.values[hover] ?? 0)}</b>
                  </div>
                );
              })}
              <div className="tt-net">
                Total <b>{money0(totals[hover])}</b>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
