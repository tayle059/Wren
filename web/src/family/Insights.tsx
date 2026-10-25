import { useState } from 'react';
import { useData, useFamily } from './Family';
import { shortDate, to12h } from './format';

interface InsightsData {
  activities: { activity: string; label: string; mean: number; plays: number }[];
  signals: {
    date: string;
    turns: number;
    words_per_turn: number;
    unique_ratio: number;
    repeats: number;
    engaged_minutes: number;
    sessions_offered: number;
    sessions_accepted: number;
    distress_events: number;
  }[];
  sundown: { hist: number[]; peakHour: number | null; windowStart: string | null };
  bestTimes: { part: string; avg: number; n: number }[];
}

export function Insights() {
  const { pid, name } = useFamily();
  const { data } = useData<InsightsData>(`/patients/${pid}/insights`);
  if (!data) return <div className="screen-loading" />;

  const signals = data.signals;
  const metrics = [
    { key: 'engaged_minutes', label: 'Minutes talking with Wren', fmt: (v: number) => v.toFixed(0) },
    { key: 'words_per_turn', label: 'Words per reply', fmt: (v: number) => v.toFixed(1) },
    { key: 'unique_ratio', label: 'Vocabulary variety', fmt: (v: number) => `${Math.round(v * 100)}%` },
    { key: 'repeats', label: 'Repeated questions', fmt: (v: number) => v.toFixed(0) },
    { key: 'distress_events', label: 'Unsettled moments', fmt: (v: number) => v.toFixed(0) },
  ] as const;

  return (
    <div className="screen insights">
      <header className="screen-head">
        <div>
          <p className="kicker">What Wren is learning</p>
          <h1>Insights</h1>
        </div>
      </header>

      <section className="card">
        <h2>What {name} enjoys most</h2>
        <p className="muted small">
          Wren tries activities and learns from how {name} responds: joining in, saying more, laughing. Favorites get offered more often, and
          others still now and then.
        </p>
        <Bars
          items={data.activities.map((a) => ({
            label: a.label,
            value: a.plays ? a.mean : null,
            note: a.plays ? `${a.plays} session${a.plays === 1 ? '' : 's'}` : 'Not tried yet',
          }))}
        />
        {data.bestTimes[0] && data.bestTimes[0].n >= 3 && (
          <p className="callout">
            Most engaged in the <b>{data.bestTimes[0].part}</b>.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Restless hours</h2>
        <p className="muted small">Anxious or unsettled moments by time of day, over the last two weeks.</p>
        <HourChart hist={data.sundown.hist} peak={data.sundown.peakHour} />
        {data.sundown.windowStart ? (
          <p className="callout warm">
            {name} often becomes restless from about <b>{to12h(data.sundown.windowStart)}</b>. Wren can start the calming session just before then.
          </p>
        ) : (
          <p className="muted small">No clear pattern yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Everyday signals</h2>
        <p className="muted small">
          Gentle measures from ordinary conversation. They’re not a diagnosis, but slow changes over weeks are worth mentioning to {name}’s doctor.
        </p>
        {signals.length < 2 ? (
          <p className="muted">Signals appear after a couple of days.</p>
        ) : (
          <div className="multiples">
            {metrics.map((m) => (
              <Spark key={m.key} label={m.label} points={signals.map((s) => ({ date: s.date, v: s[m.key] }))} fmt={m.fmt} />
            ))}
          </div>
        )}
        <details className="table-view">
          <summary>See the numbers</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  {metrics.map((m) => (
                    <th key={m.key}>{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.date}>
                    <td>{shortDate(s.date)}</td>
                    {metrics.map((m) => (
                      <td key={m.key}>{m.fmt(s[m.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
  );
}

function Bars({ items }: { items: { label: string; value: number | null; note: string }[] }) {
  const sorted = [...items].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return (
    <ul className="bars" role="list">
      {sorted.map((it) => (
        <li key={it.label} title={it.value === null ? `${it.label}: not tried yet` : `${it.label}: ${Math.round(it.value * 100)}% engagement · ${it.note}`}>
          <span className="bar-label">{it.label}</span>
          <span className="bar-track">{it.value !== null && <span className="bar-fill" style={{ width: `${Math.max(3, it.value * 100)}%` }} />}</span>
          <span className="bar-value">{it.value === null ? '–' : `${Math.round(it.value * 100)}%`}</span>
          <span className="bar-note">{it.note}</span>
        </li>
      ))}
    </ul>
  );
}

const HOURS = Array.from({ length: 17 }, (_, i) => i + 6); // 6am .. 10pm

function HourChart({ hist, peak }: { hist: number[]; peak: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...HOURS.map((h) => hist[h]));
  const W = 680;
  const H = 150;
  const bw = W / HOURS.length;
  const label = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 26}`} role="img" aria-label="Unsettled moments by hour of day">
        <line x1="0" x2={W} y1={H} y2={H} className="axis" />
        {HOURS.map((h, i) => {
          const v = hist[h];
          const bh = (v / max) * (H - 12);
          return (
            <g key={h} onPointerEnter={() => setHover(h)} onPointerLeave={() => setHover(null)}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {v > 0 && (
                <rect
                  x={i * bw + 3}
                  y={H - bh}
                  width={bw - 6}
                  height={bh}
                  rx="4"
                  className="hour-bar"
                  data-peak={h === peak}
                  opacity={hover === null || hover === h ? 1 : 0.5}
                />
              )}
              {i % 2 === 0 && (
                <text x={i * bw + bw / 2} y={H + 18} textAnchor="middle" className="tick">
                  {label(h)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((HOURS.indexOf(hover) + 0.5) / HOURS.length) * 100}%` }}>
          <b>{to12h(`${String(hover).padStart(2, '0')}:00`)}</b> · {hist[hover]} moment{hist[hover] === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function Spark({ label, points, fmt }: { label: string; points: { date: string; v: number }[]; fmt: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 240;
  const H = 64;
  const vals = points.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * (W - 8) + 4;
  const y = (v: number) => H - 6 - ((v - min) / span) * (H - 14);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const half = Math.floor(points.length / 2);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  const before = avg(vals.slice(0, half));
  const after = avg(vals.slice(half));
  const delta = before === 0 ? 0 : (after - before) / Math.abs(before);
  const trend = Math.abs(delta) < 0.1 ? 'steady' : delta > 0 ? 'rising' : 'falling';
  const shown = hover ?? points.length - 1;
  return (
    <figure className="spark">
      <figcaption>{label}</figcaption>
      <p className="spark-value">
        {fmt(points[shown].v)} <span className="muted small">{hover === null ? 'latest' : shortDate(points[shown].date)}</span>
      </p>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${label}, ${trend}`}
      >
        <path d={d} className="spark-line" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="crosshair" />}
        <circle cx={x(shown)} cy={y(points[shown].v)} r="4.5" className="spark-dot" />
      </svg>
      <p className="spark-trend" data-trend={trend}>
        {trend === 'steady' ? 'Steady' : trend === 'rising' ? 'Rising lately' : 'Falling lately'}
      </p>
    </figure>
  );
}
