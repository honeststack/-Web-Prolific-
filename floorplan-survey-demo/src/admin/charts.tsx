import { useEffect, useId, useRef, useState } from "react";

const SERIES = ["var(--series-1)", "var(--series-2)"];

/** Single-series vertical bars with hover tooltips and a table view as the accessible twin. */
export function Histogram({ rows, xLabel, yMax, title, formatTip, seriesIndex = 0 }: { rows: { answered: number; items: number }[]; xLabel: string; yMax?: number; title: string; formatTip?: (row: { answered: number; items: number }) => string; seriesIndex?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const max = yMax ?? Math.max(1, ...rows.map((r) => r.items));
  const tip = formatTip ?? ((row) => `回答数 ${row.answered}：${row.items.toLocaleString()} 問`);
  if (asTable) {
    return (
      <div className="chart">
        <ChartHead title={title} asTable onToggle={() => setAsTable(false)} />
        <div className="table-scroll short">
          <table className="data-table">
            <thead>
              <tr>
                <th className="num">{xLabel}</th>
                <th className="num">問題数</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.answered}>
                  <td className="num">{row.answered}</td>
                  <td className="num">{row.items.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  const labelEvery = Math.max(1, Math.ceil(rows.length / 12));
  return (
    <div className="chart">
      <ChartHead title={title} onToggle={() => setAsTable(true)} />
      <div className="hist" role="img" aria-label={`${title}。${rows.map((r) => `${r.answered}回答: ${r.items}問`).join("、")}`}>
        <div className="hist-grid" aria-hidden="true">
          <span style={{ bottom: "100%" }}>{max.toLocaleString()}</span>
          <span style={{ bottom: "50%" }}>{Math.round(max / 2).toLocaleString()}</span>
          <span style={{ bottom: "0%" }}>0</span>
        </div>
        <div className="hist-bars">
          {rows.map((row, i) => (
            <div className="hist-col" key={row.answered} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <div className="hist-track">
                <div className={`hist-bar ${seriesIndex === 1 ? "series-2" : ""} ${hover === i ? "is-hover" : ""}`} style={{ height: `${(row.items / max) * 100}%` }} />
              </div>
              <span className="hist-x">{i % labelEvery === 0 ? row.answered : ""}</span>
              {hover === i && (
                <div className="chart-tip" style={i > rows.length / 2 ? { right: 0 } : { left: 0 }}>
                  {tip(row)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="chart-axis">{xLabel}</p>
    </div>
  );
}

function ChartHead({ title, asTable, onToggle }: { title: string; asTable?: boolean; onToggle: () => void }) {
  return (
    <div className="chart-head">
      <h3>{title}</h3>
      <button className="link-button" onClick={onToggle}>
        {asTable ? "グラフ表示" : "表で見る"}
      </button>
    </div>
  );
}

export interface LineSeries {
  name: string;
  points: { x: number; y: number }[];
}

/** Two-line comparison on one axis, with a legend, end labels and a crosshair tooltip. */
export function LineChart({ series, xLabel, yLabel, title }: { series: LineSeries[]; xLabel: string; yLabel: string; title: string }) {
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [W, setW] = useState(800);
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, [asTable]);
  const H = 280;
  const showEndLabels = W >= 520;
  const pad = { left: 40, right: showEndLabels ? 124 : 12, top: 14, bottom: 30 };
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const xMax = Math.max(1, ...allX);
  const yMax = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)));
  const yStep = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((step) => yMax / step <= 5) ?? 1000;
  const niceY = Math.ceil(yMax / yStep) * yStep;
  const x = (value: number) => pad.left + (value / xMax) * (W - pad.left - pad.right);
  const y = (value: number) => H - pad.bottom - (value / niceY) * (H - pad.top - pad.bottom);
  const ticks = Array.from({ length: niceY / yStep + 1 }, (_, i) => i * yStep);
  const xTicks = [0.25, 0.5, 0.75, 1].map((f) => Math.round(f * xMax));

  const nearest = series[0]?.points.reduce((best, p) => (hoverX !== null && Math.abs(p.x - hoverX) < Math.abs(best.x - hoverX) ? p : best), series[0].points[0]);

  if (asTable) {
    const xs = series[0]?.points.map((p) => p.x) ?? [];
    return (
      <div className="chart">
        <ChartHead title={title} asTable onToggle={() => setAsTable(false)} />
        <div className="table-scroll short">
          <table className="data-table">
            <thead>
              <tr>
                <th className="num">{xLabel}</th>
                {series.map((s) => (
                  <th className="num" key={s.name}>
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {xs.map((value, i) => (
                <tr key={value}>
                  <td className="num">{value}</td>
                  {series.map((s) => (
                    <td className="num" key={s.name}>
                      {s.points[i]?.y ?? "-"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="chart">
      <ChartHead title={title} onToggle={() => setAsTable(true)} />
      <div className="chart-legend">
        {series.map((s, i) => (
          <span key={s.name}>
            <i style={{ background: SERIES[i] }} />
            {s.name}
          </span>
        ))}
      </div>
      <div className="line-wrap" ref={wrapRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-labelledby={titleId}
          onMouseMove={(event) => {
            const rect = svgRef.current!.getBoundingClientRect();
            const px = ((event.clientX - rect.left) / rect.width) * W;
            setHoverX(Math.max(0, Math.min(xMax, ((px - pad.left) / (W - pad.left - pad.right)) * xMax)));
          }}
          onMouseLeave={() => setHoverX(null)}
        >
          <title id={titleId}>{title}</title>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={W - pad.right} y1={y(tick)} y2={y(tick)} className="grid-line" />
              <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" className="axis-text">
                {tick}
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <text key={tick} x={x(tick)} y={H - 10} textAnchor="middle" className="axis-text">
              {tick.toLocaleString()}
            </text>
          ))}
          {series.map((s, i) => (
            <path key={s.name} d={s.points.map((p, k) => `${k ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join("")} fill="none" stroke={SERIES[i]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) => {
            const end = s.points[s.points.length - 1];
            return end && showEndLabels ? (
              <text key={s.name} x={x(end.x) + 8} y={y(end.y) + 4} className="end-label">
                {s.name} {end.y}
              </text>
            ) : null;
          })}
          {nearest && hoverX !== null && (
            <g>
              <line x1={x(nearest.x)} x2={x(nearest.x)} y1={pad.top} y2={H - pad.bottom} className="crosshair" />
              {series.map((s, i) => {
                const p = s.points.find((q) => q.x === nearest.x);
                return p ? <circle key={s.name} cx={x(p.x)} cy={y(p.y)} r="4.5" fill={SERIES[i]} stroke="var(--surface)" strokeWidth="2" /> : null;
              })}
            </g>
          )}
        </svg>
        {nearest && hoverX !== null && (
          <div className="chart-tip line-tip" style={{ left: `${(x(nearest.x) / W) * 100}%` }}>
            <strong>
              {nearest.x.toLocaleString()} {xLabel}
            </strong>
            {series.map((s, i) => (
              <span key={s.name}>
                <i style={{ background: SERIES[i] }} />
                {s.name}：{s.points.find((q) => q.x === nearest.x)?.y ?? "-"}
              </span>
            ))}
          </div>
        )}
      </div>
      <p className="chart-axis">
        {xLabel}（縦軸：{yLabel}）
      </p>
    </div>
  );
}
