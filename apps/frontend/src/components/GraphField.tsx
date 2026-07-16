// The customer graph, made ambient — the same constellation that sits behind
// opennous.cloud, carried into the auth pages for funnel cohesion. A faint
// field of source-nodes resolving into person-records, with data flowing along
// the edges. Purely decorative, deterministic, pure SMIL/CSS (no client JS).
// Sits absolute behind the auth card (the wrapper paints the warm base color).

const W = 1440;
const H = 900;

type Cluster = {
  cx: number;
  cy: number;
  r: number;
  n: number;
  seed: number;
  dur: number;
  delay: number;
};

const CLUSTERS: Cluster[] = [
  { cx: 200, cy: 200, r: 116, n: 5, seed: 0.3, dur: 26, delay: 0 },
  { cx: 1210, cy: 270, r: 138, n: 6, seed: 1.1, dur: 32, delay: -6 },
  { cx: 1040, cy: 700, r: 104, n: 4, seed: 2.0, dur: 28, delay: -12 },
  { cx: 340, cy: 720, r: 126, n: 5, seed: 0.8, dur: 30, delay: -3 },
  { cx: 720, cy: 450, r: 168, n: 7, seed: 1.6, dur: 38, delay: -18 },
];

function satellites(c: Cluster) {
  return Array.from({ length: c.n }, (_, i) => {
    const a = (Math.PI * 2 * i) / c.n + c.seed;
    return { x: c.cx + Math.cos(a) * c.r, y: c.cy + Math.sin(a) * c.r, i };
  });
}

const STARS = Array.from({ length: 54 }, (_, i) => ({
  x: (i * 211.7) % W,
  y: (i * 137.9 + (i % 5) * 70) % H,
  r: 0.8 + ((i * 7) % 10) / 10,
  dur: 3 + ((i * 13) % 7),
  delay: -(((i * 17) % 60) / 10),
  i,
}));

export default function GraphField() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <svg
        className="h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        viewBox={`0 0 ${W} ${H}`}
      >
        {STARS.map((s) => (
          <circle
            key={`star-${s.i}`}
            cx={s.x}
            cy={s.y}
            r={s.r}
            fill="#96601f"
            style={{
              animation: `twinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
            }}
          />
        ))}

        {CLUSTERS.map((c, ci) => {
          const sats = satellites(c);
          return (
            <g
              key={ci}
              style={{
                transformOrigin: `${c.cx}px ${c.cy}px`,
                animation: `graph-drift ${c.dur}s ease-in-out ${c.delay}s infinite`,
              }}
            >
              {sats.map((s) => (
                <line
                  key={`e-${ci}-${s.i}`}
                  x1={c.cx}
                  y1={c.cy}
                  x2={s.x}
                  y2={s.y}
                  stroke="#96601f"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  style={{
                    animation: `edge-breathe ${c.dur / 2}s ease-in-out ${s.i * 0.6}s infinite`,
                  }}
                />
              ))}

              {sats.map((s) => {
                const dur = 4.5 + ((s.i + ci) % 4) * 1.3;
                const begin = -((ci * 1.7 + s.i * 0.9) % dur);
                return (
                  <circle key={`p-${ci}-${s.i}`} r="2.2" fill="#E0912B">
                    <animateMotion
                      dur={`${dur}s`}
                      begin={`${begin}s`}
                      repeatCount="indefinite"
                      path={`M ${s.x} ${s.y} L ${c.cx} ${c.cy}`}
                    />
                    <animate
                      attributeName="opacity"
                      values="0;0.65;0"
                      dur={`${dur}s`}
                      begin={`${begin}s`}
                      repeatCount="indefinite"
                    />
                  </circle>
                );
              })}

              {sats.map((s) => (
                <circle
                  key={`s-${ci}-${s.i}`}
                  cx={s.x}
                  cy={s.y}
                  r="3.4"
                  fill="#E0912B"
                  style={{
                    animation: `twinkle ${6 + (s.i % 3)}s ease-in-out ${-s.i * 0.8}s infinite`,
                  }}
                />
              ))}

              <circle
                cx={c.cx}
                cy={c.cy}
                r="13"
                fill="#96601f"
                style={{
                  transformOrigin: `${c.cx}px ${c.cy}px`,
                  animation: `node-pulse ${c.dur / 3}s ease-in-out ${c.delay}s infinite`,
                }}
              />
              <circle cx={c.cx} cy={c.cy} r="6" fill="#96601f" fillOpacity="0.45" />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
