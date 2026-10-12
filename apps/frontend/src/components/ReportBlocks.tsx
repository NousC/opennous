// The report block vocabulary, and the one place they are drawn.
//
// A document used to be `{ label, body }` — labelled markdown prose, nothing else. That is
// why every report read like an essay: there was nowhere to put a number, a series or a
// colour, so the agent could only write paragraphs. No prompt fixes a data model.
//
// THE DIVISION OF LABOUR, which is the whole point: the agent supplies DATA (what is true);
// this file supplies PIXELS (what it looks like). An agent that emits its own HTML or chart
// code produces a different-looking report every run, and two reports never match. Here it
// physically cannot — it picks a block and fills it, and the design is ours.
//
// The same tokens drive the PDF export later, so a report on screen and the same report in
// someone's inbox are the same document. And the same blocks answer a single question inline
// in chat (`AnswerBlocks`), so a table in a widget and a table in a report never disagree.
import { useMemo, type ReactNode } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell,
} from "recharts";
import { Prose } from "@/components/AgentMarkdown";
import { cn } from "@/lib/utils";

// ─── The design system ──────────────────────────────────────────────────────
//
// One accent, two semantic colours, one neutral ramp. The model never picks a colour:
// "won" is the same green in every report in the product, and risk is the same amber,
// so a reader learns the language once.
export const REPORT_COLORS = {
  accent: "#FF5C00",          // the brand orange — primary series, section numbers
  good: "#2E7D66",            // won / healthy — never anything else
  risk: "#C5793C",            // watch / exposed
  bad: "#B95050",             // lost / at risk
  neutral: "#94A3B8",
};
// A ranked bar chart reads better as one colour with the leader emphasised than as a
// rainbow — colour should mean something, and in a ranking it means nothing.
const SERIES = [REPORT_COLORS.accent, REPORT_COLORS.good, REPORT_COLORS.risk, REPORT_COLORS.bad, "#4B6F8F", "#7967A8"];

type Unit = "usd" | "pct" | "days" | "count" | null;
type Tone = "good" | "risk" | "bad" | "neutral";

export type ReportBlock =
  | { type: "prose"; body: string }
  // A metric is a raw number + a unit, formatted by the same `fmt` that formats the chart
  // axis beside it. `text` is the escape hatch for a headline that genuinely is not a number
  // ("3 of 11"); a plain string `value` is what documents written before this carried.
  | { type: "metrics"; items: { label: string; value?: number | string; text?: string; unit?: Unit; note?: string | null; tone?: Tone | null }[] }
  | { type: "chart"; variant?: "bar" | "column" | "grouped" | "line"; title?: string | null;
      data: { label: string; value?: number; [k: string]: unknown }[];
      series?: { key: string; label: string; color?: "accent" | "good" | "risk" | "bad" }[];
      unit?: Unit }
  // `units` is one per column. A unit column carries raw numbers, formatted here like money
  // anywhere else; tables written before it existed carry strings and render as they did.
  | { type: "table"; headers: string[]; rows: (string | number)[][]; emphasis?: number | null; units?: Unit[]; more?: number; more_label?: string }
  | { type: "callout"; tone?: "good" | "risk" | "bad" | "neutral"; title?: string | null; body: string }
  // The four story blocks (GET-416). Appearance is decided here, once; the skill decides only
  // which claim each carries.
  | { type: "evidence"; title?: string | null; rows: { account: string; quote: string; became: string; at?: string | null }[]; more?: number; more_label?: string }
  | { type: "path"; tone?: "good" | "risk" | "bad" | "neutral"; title?: string | null; cohort?: string | null; compare?: string | null;
      steps: { label: string; pct?: number | null; n?: number | null }[] }
  | { type: "columns"; title?: string | null; more?: number; more_label?: string;
      columns: { title: string; tone?: "good" | "risk" | "bad" | "neutral"; cards: { account: string; text: string; quote?: string | null; value?: number | null; unit?: Unit }[] }[] }
  | { type: "bullets"; heading?: string | null; lines: string[]; tone?: Tone | null }
  | { type: "split"; left: ReportBlock[]; right: ReportBlock[] }
  | { type: "timeline"; title?: string | null; events: { at: string; source?: string | null; event: string; meaning?: string | null; tone?: "good" | "risk" | "bad" | "neutral" }[] };

export type ReportSection = { label: string; kicker?: string; body?: string; blocks?: ReportBlock[] };

// ─── Formatting ─────────────────────────────────────────────────────────────
//
// Done here, not by the model. A model asked to format $1,340,000 as $1.34M in its head is
// right most of the time, and the times it is wrong you cannot see.
const fmt = (v: number, unit?: string | null) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  if (unit === "usd") {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (Math.abs(v) >= 1_000) return `$${Math.round(v / 1_000)}k`;
    return `$${Math.round(v)}`;
  }
  if (unit === "pct") return `${Math.round(v * 10) / 10}%`;
  if (unit === "days") return `${Math.round(v * 10) / 10}d`;
  return v.toLocaleString();
};

const CALLOUT_TONE: Record<string, { bar: string; bg: string }> = {
  good:    { bar: REPORT_COLORS.good, bg: "bg-emerald-500/[0.07]" },
  risk:    { bar: REPORT_COLORS.risk, bg: "bg-amber-500/[0.07]" },
  bad:     { bar: REPORT_COLORS.bad,  bg: "bg-red-500/[0.06]" },
  neutral: { bar: REPORT_COLORS.neutral, bg: "bg-muted/40" },
};

const tick = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };

function ChartBlock({ b }: { b: Extract<ReportBlock, { type: "chart" }> }) {
  const series = useMemo(
    () => (b.series?.length ? b.series : [{ key: "value", label: b.title ?? "Value" }]),
    [b.series, b.title],
  );
  const rows = Array.isArray(b.data) ? b.data : [];
  // Three bars is a sentence pretending to be a chart. Below four points the table or the
  // sentence is the better carrier, so the block renders as nothing and the section stands
  // on its other blocks.
  if (rows.length < 2) return null;

  const variant = b.variant ?? "bar";
  const color = (s: { color?: string }, i: number) =>
    s.color ? (REPORT_COLORS[s.color as keyof typeof REPORT_COLORS] ?? SERIES[i % SERIES.length]) : SERIES[i % SERIES.length];

  return (
    <figure>
      {b.title && <figcaption className="mb-6 text-[15px] font-semibold leading-snug text-foreground">{b.title}</figcaption>}
      <div className="py-2" style={{ height: variant === "bar" ? Math.max(220, rows.length * 54) : 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          {variant === "line" ? (
            <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: -14 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} minTickGap={18} />
              <YAxis tick={tick} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmt(v, b.unit)} />
              <Tooltip formatter={(v: number) => fmt(v, b.unit)} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
              {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => (
                <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={color(s, i)}
                  strokeWidth={2} dot={false} isAnimationActive={false} />
              ))}
            </LineChart>
          ) : variant === "bar" ? (
            // Horizontal: the shape for a RANKING, because the labels are words and words
            // read horizontally.
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 0 }} barCategoryGap="28%">
              <XAxis type="number" hide />
              {/* Category labels FLUSH LEFT, not right-ragged against the bars.
                  Recharts anchors a vertical axis tick at the axis line and ends the text
                  there, so a list of stage names arrives right-aligned and the eye has no
                  edge to start from. A custom tick draws each label at x=0 instead, which
                  gives the chart the same left margin as the paragraph above it. */}
              <YAxis
                type="category" dataKey="label" tickLine={false} axisLine={false} width={210}
                tick={({ y, payload }) => (
                  <text x={0} y={y} dy={4} textAnchor="start" fontSize={12.5} fill="hsl(var(--foreground))" opacity={0.85}>
                    {String(payload.value).length > 34 ? `${String(payload.value).slice(0, 33)}…` : payload.value}
                  </text>
                )}
              />
              <Tooltip formatter={(v: number) => fmt(v, b.unit)} contentStyle={{ fontSize: 12, borderRadius: 8 }} cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} />
              <Bar dataKey="value" radius={[0, 5, 5, 0]} isAnimationActive={false}
                label={{ position: "right", fontSize: 12.5, fontWeight: 600, fill: "hsl(var(--foreground))", formatter: (v: number) => fmt(v, b.unit) }}>
                {rows.map((_, i) => <Cell key={i} fill={i === 0 ? REPORT_COLORS.accent : `${REPORT_COLORS.accent}B3`} />)}
              </Bar>
            </BarChart>
          ) : (
            <BarChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: -14 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: "hsl(var(--border))" }} />
              <YAxis tick={tick} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmt(v, b.unit)} />
              <Tooltip formatter={(v: number) => fmt(v, b.unit)} contentStyle={{ fontSize: 12, borderRadius: 8 }} cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} />
              {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={color(s, i)} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function TableBlock({ b }: { b: Extract<ReportBlock, { type: "table" }> }) {
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (!b.headers?.length || !rows.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[14px]">
        <thead>
          <tr>
            {b.headers.map((h, i) => (
              <th key={i} className={cn(
                "border-b-2 border-foreground/80 px-3 py-2 text-left text-[13.5px] font-semibold text-foreground first:pl-0 last:pr-0",
                (b.units?.[i]) && "text-right",
              )}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-border/60 last:border-b-2 last:border-foreground/30">
              {r.map((c, ci) => {
                const unit = b.units?.[ci] ?? null;
                return (
                  <td key={ci} className={cn(
                    "px-3 py-2.5 align-top text-foreground/90 leading-[1.5] first:pl-0 last:pr-0",
                    // The first column is a NAME, and a name that wraps to two lines is a table
                    // nobody can scan. It gets the width it needs; the prose columns give.
                    ci === 0 && "whitespace-nowrap font-medium text-foreground",
                    // A unit column is a column of figures: right-aligned digits, never wrapped.
                    unit && "whitespace-nowrap text-right tabular-nums",
                    // The emphasis column is the one a reader scans — a priority, a delta.
                    b.emphasis === ci && "font-semibold",
                  )}>{typeof c === "number" && unit ? fmt(c, unit) : String(c ?? "")}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <MoreFooter n={b.more} label={b.more_label} shown={rows.length} />
    </div>
  );
}

// "Showing 4 of 120 — the rest is on the Customer Success page." A preview list without this
// line reads as the whole book, and a reader who later finds 116 more stops trusting the four.
function MoreFooter({ n, label, shown }: { n?: number; label?: string; shown: number }) {
  if (!n || n <= 0) return null;
  return (
    <p className="mt-2 text-[13px] text-muted-foreground">{shown} of {shown + n} shown{label ? `; the rest is on ${label}.` : "."}</p>
  );
}

// The metric row is as wide as its cards. A fixed four-column grid left two cards sharing
// half a row, and put a fifth alone on a line of its own.
const METRIC_COLS: Record<number, string> = {
  1: "",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-3 lg:grid-cols-5",
};

/** One block. An unknown type renders nothing rather than breaking the document. */
/**
 * How a citation marker resolves. Without `citeIndex` a [ct7k2] token has no row to point at
 * and Prose drops it — which is what erased every marker in a reopened document (GET-197).
 */
export type CiteProps = {
  onCite?: (n: number) => void;
  citeIndex?: (token: string) => number | undefined;
  citeTitle?: (n: number) => string | undefined;
};

export function Block({ b, onCite, citeIndex, citeTitle }: { b: ReportBlock } & CiteProps) {
  switch (b?.type) {
    case "prose":
      // Report body text: 15px on 1.65, the size a document is read at rather than a chat.
      return (
        <div className="report-prose [&_.prose]:text-[15px] [&_.prose]:leading-[1.65] [&_.prose_p]:my-3 [&_.prose_li]:my-1">
          <Prose text={b.body} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} doc />
        </div>
      );

    case "metrics": {
      const items = (b.items ?? []).slice(0, 5);
      if (!items.length) return null;
      // Figures sit in a bordered band, divided cell by cell, so a row of numbers reads as one
      // object rather than four floating columns. The number is set like the section title:
      // same family, same weight, same tightness, so the eye reads them as the same voice.
      return (
        <div className={cn("report-metrics grid divide-x divide-border/60 rounded-lg border border-border/70", METRIC_COLS[items.length])}>
          {items.map((m, i) => (
            <div key={i} className="flex flex-col px-6 py-6">
              <div className="text-[30px] font-semibold leading-[1.18] tracking-[-0.02em] tabular-nums"
                style={{ color: m.tone && m.tone !== "neutral" ? TONE_COLOR[m.tone] : undefined }}>
                {typeof m.value === "number" ? fmt(m.value, m.unit) : (m.text ?? m.value ?? "")}
              </div>
              <div className="mt-2 text-[14px] leading-snug text-foreground/70">{m.label}</div>
              {m.note && <div className="mt-1 text-[13px] leading-snug text-muted-foreground/70">{m.note}</div>}
            </div>
          ))}
        </div>
      );
    }

    case "chart": return <ChartBlock b={b} />;
    case "table": return <TableBlock b={b} />;

    case "callout": {
      const tone = CALLOUT_TONE[b.tone ?? "neutral"] ?? CALLOUT_TONE.neutral;
      return (
        <div className="report-callout border-l-2 pl-5" style={{ borderColor: tone.bar }}>
          <div className="min-w-0 flex-1">
            {b.title && <div className="mb-1 text-[15px] font-semibold text-foreground">{b.title}</div>}
            <div className="text-[15px] leading-[1.65] text-foreground/90">
              <Prose text={b.body} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} doc />
            </div>
          </div>
        </div>
      );
    }

    case "bullets": return <BulletsBlock b={b} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} />;
    case "split": return (
      <div className="grid grid-cols-1 gap-x-14 gap-y-12 md:grid-cols-2 md:items-start">
        <div className="flex min-w-0 flex-col gap-10">{b.left.map((x, i) => <Block key={i} b={x} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} />)}</div>
        <div className="flex min-w-0 flex-col gap-10">{b.right.map((x, i) => <Block key={i} b={x} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} />)}</div>
      </div>
    );
    case "evidence": return <EvidenceBlock b={b} />;
    case "path": return <PathBlock b={b} />;
    case "columns": return <ColumnsBlock b={b} />;
    case "timeline": return <TimelineBlock b={b} />;

    default: return null;
  }
}

const TONE_COLOR: Record<string, string> = { good: REPORT_COLORS.good, risk: REPORT_COLORS.risk, bad: REPORT_COLORS.bad, neutral: REPORT_COLORS.neutral };
const Caption = ({ text }: { text?: string | null }) => (text ? <div className="mb-2 text-[12px] font-medium text-muted-foreground">{text}</div> : null);

// Three to six lines under a heading. "In brief" opens a section; "Takeaways" closes it with
// what this means and what to do. A section that ends on a paragraph trails off; one that ends
// on takeaways hands the reader something to carry.
function BulletsBlock({ b, onCite, citeIndex, citeTitle }: { b: Extract<ReportBlock, { type: "bullets" }> } & CiteProps) {
  return (
    <div className="report-bullets">
      {b.heading && <h3 className="mb-3 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-foreground">{b.heading}</h3>}
      <ul className="space-y-2 pl-5">
        {b.lines.map((l, i) => (
          <li key={i} className="list-disc text-[15px] leading-[1.65] text-foreground/90 marker:text-foreground/50">
            <Prose text={l} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} doc />
          </li>
        ))}
      </ul>
    </div>
  );
}

// The proof strip. A number the reader cannot trace is an assertion; a name, a quote and what
// it became is evidence. Under a chart, two to four rows, one line each — never a table (a
// table invites scanning; this invites reading one sentence).
function EvidenceBlock({ b }: { b: Extract<ReportBlock, { type: "evidence" }> }) {
  return (
    <figure className="report-evidence">
      {b.title && <h4 className="mb-3 text-[15px] font-semibold leading-snug text-foreground">{b.title}</h4>}
      <div className="space-y-5">
        {b.rows.map((r, i) => (
          <div key={i}>
            <blockquote className="border-l-2 border-foreground/25 pl-5 text-[16px] leading-[1.55] text-foreground/90">
              “{r.quote}”
            </blockquote>
            <figcaption className="mt-1.5 pl-5 text-[13px] leading-snug text-muted-foreground">
              {r.account}{r.at ? `, ${r.at}` : ""} · {r.became}
            </figcaption>
          </div>
        ))}
      </div>
      {b.more ? <p className="mt-3 text-[13px] text-muted-foreground">{b.rows.length} of {b.rows.length + b.more} shown{b.more_label ? `; the remainder is on ${b.more_label}.` : "."}</p> : null}
    </figure>
  );
}

// The path a cohort took, step by step, with the share of the cohort at each. The bar under
// each step is that share; the compare line is the same path in the other cohort, because a
// pattern both cohorts share is not a pattern of either.
function PathBlock({ b }: { b: Extract<ReportBlock, { type: "path" }> }) {
  const color = TONE_COLOR[b.tone ?? "bad"];
  return (
    <div className="report-path">
      {b.title && <h4 className="mb-3 text-[15px] font-semibold leading-snug text-foreground">{b.title}</h4>}
      <ol className="space-y-2.5">
        {b.steps.map((st, i) => (
          <li key={i} className="grid grid-cols-[28px_1fr_120px] items-center gap-x-3">
            <span className="text-[13px] tabular-nums text-muted-foreground">{i + 1}.</span>
            <div className="min-w-0">
              <div className="text-[14.5px] leading-snug text-foreground">{st.label}</div>
              {typeof st.pct === "number" && (
                <div className="mt-1.5 h-[6px] w-full overflow-hidden rounded-sm bg-muted"><div className="h-full rounded-sm" style={{ width: `${Math.max(2, Math.min(100, st.pct))}%`, background: color }} /></div>
              )}
            </div>
            <div className="text-right text-[13.5px] tabular-nums text-foreground/80">
              {typeof st.pct === "number" ? fmt(st.pct, "pct") : ""}{typeof st.n === "number" ? <span className="text-muted-foreground"> · {st.n}</span> : null}
            </div>
          </li>
        ))}
      </ol>
      {(b.cohort || b.compare) && (
        <p className="mt-3 text-[13.5px] leading-snug text-muted-foreground">
          {b.cohort ? `Shares are ${b.cohort}.` : ""}{b.cohort && b.compare ? " " : ""}{b.compare ? `${b.compare}.` : ""}
        </p>
      )}
    </div>
  );
}

// Two lists side by side, each a title and a few cards — at risk beside asking for more. The
// tone colours the rail, never the text; a card is an account, one line, and the quote under
// it when the line rests on one.
function ColumnsBlock({ b }: { b: Extract<ReportBlock, { type: "columns" }> }) {
  const shown = b.columns.reduce((n, c) => n + c.cards.length, 0);
  return (
    <div className="report-columns">
      {b.title && <h4 className="mb-3 text-[15px] font-semibold leading-snug text-foreground">{b.title}</h4>}
      <div className="grid grid-cols-1 gap-x-14 gap-y-10 md:grid-cols-2">
        {b.columns.map((c, i) => (
          <div key={i} className="min-w-0">
            <h4 className="mb-2.5 text-[15px] font-semibold leading-snug text-foreground">{c.title} <span className="font-normal text-muted-foreground">({c.cards.length})</span></h4>
            <ul className="divide-y divide-border/60">
              {c.cards.map((k, j) => (
                <li key={j} className="py-2.5 first:pt-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[14.5px] font-medium text-foreground">{k.account}</span>
                    {typeof k.value === "number" && <span className="flex-shrink-0 text-[13.5px] tabular-nums text-muted-foreground">{fmt(k.value, k.unit)}</span>}
                  </div>
                  <div className="text-[14px] leading-snug text-foreground/85">{k.text}</div>
                  {k.quote && <div className="mt-0.5 text-[13.5px] italic leading-snug text-muted-foreground">“{k.quote}”</div>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {b.more ? <p className="mt-3 text-[13px] text-muted-foreground">{shown} of {shown + b.more} shown{b.more_label ? `; the rest is on ${b.more_label}.` : "."}</p> : null}
    </div>
  );
}

// One account reconstructed in time: date · source · what happened · what it meant. The
// proof that the reconstruction is real, so it reads as a record, not a chart.
function TimelineBlock({ b }: { b: Extract<ReportBlock, { type: "timeline" }> }) {
  return (
    <div className="report-timeline">
      {b.title && <h4 className="mb-3 text-[15px] font-semibold leading-snug text-foreground">{b.title}</h4>}
      <ol className="divide-y divide-border/60">
        {b.events.map((e, i) => (
          <li key={i} className="grid grid-cols-[110px_1fr] gap-x-4 py-2.5 first:pt-0">
            <div className="text-[13.5px] tabular-nums text-muted-foreground">{e.at}{e.source && <div className="text-[12.5px]">{e.source}</div>}</div>
            <div className="min-w-0">
              <div className="text-[14.5px] leading-snug text-foreground">{e.event}</div>
              {e.meaning && <div className="mt-0.5 text-[13.5px] leading-snug text-muted-foreground">{e.meaning}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A report section's chrome: the number and short name small above, the thesis as the title,
 * then the body. One frame for the dock and the preview, so a report looks the same wherever
 * it is opened (GET-416). The `label` written before kickers existed may carry "05 — " itself;
 * the frame strips it and prints its own.
 */
export function ReportSectionFrame({ sec, index, children }: { sec: ReportSection; index: number; children: ReactNode }) {
  const m = /^\s*(\d{1,2})\s*[—–·-]\s*(.*)$/.exec(sec.label ?? "");
  const thesis = m ? m[2] : sec.label;
  // The FORMAL name is the heading and the quantified finding is the line under it (GET-416).
  // A provocative conclusion as the heading reads as an article; "02 · Revenue Activity and
  // Coverage" over "Pipeline converts at 40% from Discovery Call" reads as an intelligence
  // product, and gives a reader both the map and the finding.
  const title = sec.kicker ?? thesis;
  const headline = sec.kicker ? thesis : null;
  return (
    // A SECTION IS A PAGE. The rule above it is the page edge, and it needs air on both sides
    // or it reads as a stray line: 128px of it above, 112 below.
    <section className="report-section border-t border-border/70 pb-28 pt-32 first:border-t-0 first:pt-0">
      <h2 className="text-[28px] font-semibold leading-[1.18] tracking-[-0.02em] text-foreground">
        {index > 0 && <span className="mr-2.5 font-normal tabular-nums text-muted-foreground/60">{String(index).padStart(2, "0")}</span>}
        {title}
      </h2>
      {/* The finding runs the full measure and carries weight: it is the sentence a reader
          quotes back, not a caption. */}
      {headline && <p className="mt-4 text-[19px] font-semibold leading-[1.45] tracking-[-0.01em] text-foreground/80">{headline}</p>}
      <div className="mt-14">{children}</div>
    </section>
  );
}

/** A section's body: its blocks, or the legacy markdown when it predates them. */
export function SectionBody({ sec, onCite, citeIndex, citeTitle }: { sec: ReportSection } & CiteProps) {
  if (Array.isArray(sec.blocks) && sec.blocks.length) {
    // ONE gap between blocks, set here.
    //
    // Every block used to carry its own `my-4` — except `prose`, which carried nothing, so
    // two paragraphs in a row collided while a paragraph after a chart had 16px. The visible
    // symptom: a bold lead-in like "**What stands out**" sat tighter to the paragraph above
    // it than to the list it introduces, which inverts the hierarchy it exists to create.
    // Same reasoning as the RHYTHM block in AgentMarkdown: one system, not two.
    return (
      <div className="flex flex-col gap-12">
        {sec.blocks.map((b, i) => <Block key={i} b={b} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} />)}
      </div>
    );
  }
  // Every document written before blocks existed still renders exactly as it did.
  return <Prose text={sec.body ?? ""} onCite={onCite} citeIndex={citeIndex} citeTitle={citeTitle} doc />;
}

/**
 * A widget: the answer to ONE question, drawn inside the chat message that answered it.
 *
 * Not a document. It is not saved, has no title bar and does not dock — it belongs to the
 * message, and replays from the turn's own tool_calls when the thread is reopened. The
 * border is the same weight as a document stub beside it, so the two read as one family.
 */
export function AnswerBlocks({ title, summary, blocks, onCite }: {
  title?: string | null;
  /** One to three sentences under the title: what the blocks found. The widget has to stand
   *  on its own when somebody scrolls back to it with the conversation forgotten, and a
   *  chart with no sentence around it is a number nobody can act on. */
  summary?: string | null;
  blocks: ReportBlock[];
  onCite?: (n: number) => void;
}) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  return (
    // No margin of its own: the gap to whatever sits above belongs to the seam, and the
    // message that hosts it sets one rhythm for every part (see Home.tsx).
    <div className="rounded-2xl border border-border/70 bg-card px-4 py-4">
      {(title || summary) && (
        // The masthead. A widget is a small document, so it opens like one: the name at
        // document scale, the finding under it, and a rule closing the head off from the
        // blocks. At 13.5px the title read as a bold label on a panel — the same size as the
        // words inside the table under it, which is why nothing announced itself as a report.
        <header className="mb-4 border-b border-border/60 pb-3">
          {title && (
            <h3 className="text-[19px] font-semibold leading-[1.25] tracking-[-0.015em] text-foreground">
              {title}
            </h3>
          )}
          {summary && (
            // No measure cap. 62ch is the right line length for a page of prose and wrong for
            // a caption inside a card: at 13px it stopped the text halfway across a 1250px
            // widget and read as broken layout. Two sentences do not need protecting from
            // their own width.
            <p className="mt-1.5 text-[13px] leading-[1.55] text-muted-foreground">{summary}</p>
          )}
        </header>
      )}
      <div className="flex flex-col gap-4">
        {blocks.map((b, i) => <Block key={i} b={b} onCite={onCite} />)}
      </div>
    </div>
  );
}
