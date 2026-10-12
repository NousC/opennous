// The chart primitives, in one place.
//
// Adoption, Usage and Billing each grew their own copy of the same three ideas — round the
// axis to a number a person would choose, draw at the width the card actually gives you,
// let the reader interrogate the marks. Three copies is three places for a chart to start
// disagreeing with the one next to it, which is exactly the thing a founder notices.
import { useLayoutEffect, useRef, useState } from "react";
import { format } from "date-fns";

/**
 * Round an axis up to a number a person would actually choose (10, 25, 50, 100…) and step
 * it evenly. An axis topping out at "86" is the raw max leaking through; a real axis is a
 * scale you can read a value off.
 */
export function niceScale(max: number, targetTicks = 4) {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return { top, ticks };
}

/** The chart must be drawn at the width it will actually occupy — otherwise the SVG keeps
 *  its own aspect ratio and floats, centred, inside a wider card. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width) setW(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Follows the theme, so a chart drawn in dark mode isn't a navy bar on a navy card. */
export function useIsDark() {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  useLayoutEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export const CREDIT_FILL = { light: "#1e3a5f", dark: "#7ba7d9" };

export type CreditDay = { day: string; credits: number; calls?: number; cost_usd?: number };

/**
 * Credits consumed per day. The plain version of the chart on Usage — no second axis, no
 * stack — for the places where the question is only "how much, and when".
 */
export function CreditsChart({ daily, height = 200 }: { daily: CreditDay[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, boxW] = useWidth<HTMLDivElement>();
  const dark = useIsDark();

  const W = Math.max(boxW || 480, 300), H = height;
  const PAD_L = 38, PAD_R = 10, PAD_B = 26, PAD_T = 12;

  const { top, ticks } = niceScale(Math.max(1, ...daily.map(d => d.credits)));
  const innerW = W - PAD_L - PAD_R;
  const stepX = innerW / Math.max(daily.length, 1);
  const centerX = (i: number) => PAD_L + i * stepX + stepX / 2;
  const y = (v: number) => PAD_T + (1 - v / top) * (H - PAD_T - PAD_B);

  const barW = Math.max(2, Math.min(stepX - 3, 22));
  const labelEvery = Math.max(1, Math.ceil(daily.length / Math.max(2, Math.floor(innerW / 62))));
  const fill = dark ? CREDIT_FILL.dark : CREDIT_FILL.light;

  if (!daily.length) return null;

  return (
    <div className="relative w-full" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Credits consumed per day">
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)}
              className="stroke-border" strokeWidth={1}
              strokeDasharray={t === 0 ? "0" : "2 4"} strokeOpacity={t === 0 ? 1 : 0.6} />
            <text x={PAD_L - 7} y={y(t) + 3} textAnchor="end"
              className="fill-muted-foreground/70 text-[9px] tabular-nums">{t}</text>
          </g>
        ))}

        {daily.map((d, i) => (
          <rect key={d.day} x={centerX(i) - barW / 2} y={y(d.credits)}
            width={barW} height={Math.max(H - PAD_B - y(d.credits), d.credits > 0 ? 1.5 : 0)}
            rx={2} fill={fill} fillOpacity={hover === null || hover === i ? 0.92 : 0.42} />
        ))}

        {hover !== null && (
          <line x1={centerX(hover)} x2={centerX(hover)} y1={PAD_T} y2={H - PAD_B}
            className="stroke-foreground/25" strokeWidth={1} />
        )}

        {/* Hit targets, wider than the marks. */}
        {daily.map((d, i) => (
          <rect key={d.day} x={PAD_L + i * stepX} y={0} width={stepX} height={H} fill="transparent"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}

        {daily.map((d, i) => {
          const isLast = i === daily.length - 1;
          if (i % labelEvery !== 0 && !isLast) return null;
          if (!isLast && daily.length - 1 - i < labelEvery / 2) return null;
          return (
            <text key={d.day} x={centerX(i)} y={H - PAD_B + 13}
              textAnchor={isLast ? "end" : i === 0 ? "start" : "middle"}
              className="fill-muted-foreground/70 text-[9px]">
              {format(new Date(`${d.day}T00:00:00`), "MMM d")}
            </text>
          );
        })}
      </svg>

      {hover !== null && daily[hover] && (
        <div className="pointer-events-none absolute right-0 top-0 rounded-lg border border-border bg-background px-3 py-2 shadow-md">
          <p className="mb-1 text-[11px] font-medium text-foreground">
            {format(new Date(`${daily[hover].day}T00:00:00`), "EEE, MMM d")}
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: fill }} />
            Credits
            <span className="ml-3 tabular-nums text-foreground/80">{daily[hover].credits.toLocaleString()}</span>
          </p>
          {/* Credits, never dollars. What a day cost US is our margin, not the customer's
              bill — they bought credits, and a raw model cost sitting under the number they
              were charged only invites the comparison. */}
          {daily[hover].calls != null && (
            <p className="mt-0.5 text-[10.5px] tabular-nums text-muted-foreground/50">
              {daily[hover].calls} calls
            </p>
          )}
        </div>
      )}
    </div>
  );
}
