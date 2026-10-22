import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import "@fontsource-variable/host-grotesk";
import "./authLayout.css";

// The sign-in and sign-up pages in the website v2 design (GET-958), so leaving opennous.cloud
// for the app does not change the look. The pages only draw the frame: the form inside is the
// auth provider's (contexts/auth/select.tsx), Clerk's widget on Cloud or the email form on
// self-host, each styled to match.
//
//   SignInLayout  the centred card on the dotted radar, "Start for free" top right
//   SignUpLayout  the form on the left, the dark brand panel on the right

/** The website's tokens. Host Grotesk at 300 for the page, the website's accent for actions. */
export const AUTH_V2 = {
  bg: "#FAF9F6",
  ink: "#0E1116",
  ink2: "#2B303A",
  muted: "#6E7480",
  faint: "#9AA0AA",
  accent: "#C2410C",
  font: "'Host Grotesk Variable', ui-sans-serif, system-ui, -apple-system, sans-serif",
  mono: "'Geist Mono Variable', ui-monospace, monospace",
} as const;

/** A form's heading in the website's light Host Grotesk. The Cloud (Clerk) forms draw it above the
 *  widget; the self-host forms draw their own (contexts/auth/supabase/AuthCard.tsx). */
export function AuthHeading({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="m-0 text-[30px] font-light leading-[1.1] tracking-[-0.03em]" style={{ color: AUTH_V2.ink }}>{title}</h1>
      {sub && <p className="m-0 text-[15px] leading-normal" style={{ color: AUTH_V2.muted }}>{sub}</p>}
    </div>
  );
}

const LEGAL = [
  { label: "Privacy", href: "https://www.opennous.cloud/privacy" },
  { label: "Terms", href: "https://www.opennous.cloud/terms" },
];

/** The dotted ring and the accent dot, the website's mark. */
function Mark({ size = 22, ring = AUTH_V2.ink }: { size?: number; ring?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="9" fill="none" stroke={ring} strokeWidth="1.4" strokeDasharray="1.8 3" />
      <circle cx="11" cy="11" r="3.2" fill={AUTH_V2.accent} />
    </svg>
  );
}

function Wordmark() {
  return (
    <a href="https://www.opennous.cloud" className="flex w-fit items-center gap-2.5 text-[18px] font-normal tracking-[-0.02em]" style={{ color: AUTH_V2.ink }}>
      <Mark />OpenNous
    </a>
  );
}

const pageStyle = { background: AUTH_V2.bg, color: AUTH_V2.ink, fontFamily: AUTH_V2.font, fontWeight: 300 } as const;

export function SignInLayout({ children, signUpHref, signUpLabel = "Start for free" }: { children: ReactNode; signUpHref?: string; signUpLabel?: string }) {
  return (
    <div className="auth-v2 relative flex min-h-screen flex-col overflow-hidden px-5 pb-10 pt-8 antialiased sm:px-16" style={pageStyle}>
      <div aria-hidden="true" className="auth-v2-dots" />
      <div aria-hidden="true" className="auth-v2-sweep" />
      <header className="relative flex items-center justify-between">
        <Wordmark />
        {signUpHref && (
          <Link to={signUpHref} className="text-[15px] font-normal" style={{ color: AUTH_V2.ink2 }}>
            {signUpLabel} <span aria-hidden="true">›</span>
          </Link>
        )}
      </header>
      <main className="relative flex flex-1 items-center justify-center py-14">
        <div className="w-full max-w-[400px] rounded-[10px] bg-white p-7 sm:p-9" style={{ boxShadow: "0 0 0 1px rgba(14,17,22,0.06), 0 30px 60px -24px rgba(60,35,20,0.22), 0 12px 24px -12px rgba(0,0,0,0.08)" }}>
          {children}
        </div>
      </main>
      <footer className="relative flex flex-wrap justify-between gap-3 text-[12px]" style={{ fontFamily: AUTH_V2.mono, color: AUTH_V2.faint }}>
        <span>© OpenNous LLC {new Date().getFullYear()}</span>
        <span className="flex gap-5">{LEGAL.map((l) => <a key={l.label} href={l.href} style={{ color: AUTH_V2.faint }}>{l.label}</a>)}</span>
      </footer>
    </div>
  );
}

const SIGNALS = [
  { name: "deal.stalled", left: "58%", top: "24%", live: true },
  { name: "account.expansion_requested", left: "22%", top: "50%" },
  { name: "account.champion_left", left: "60%", top: "60%" },
];

const AGENTS = [
  { name: "Claude", src: "/provider-logos/claude.svg" },
  { name: "Grok", src: "/provider-logos/grok.png" },
  { name: "Slack", src: "/provider-logos/slack.svg" },
];

export function SignUpLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-v2 flex min-h-screen flex-wrap antialiased" style={pageStyle}>
      <main className="flex min-w-0 flex-[999_1_520px] flex-col px-5 pb-10 pt-8 sm:px-16">
        <Wordmark />
        <div className="flex flex-1 items-center justify-center py-14">
          <div className="w-full max-w-[380px]">{children}</div>
        </div>
        <span className="text-[12px]" style={{ fontFamily: AUTH_V2.mono, color: AUTH_V2.faint }}>© OpenNous LLC {new Date().getFullYear()}</span>
      </main>

      <aside aria-hidden="true" className="relative flex min-h-[420px] flex-[1_1_520px] flex-col justify-end overflow-hidden p-8 sm:p-16" style={{ background: "#0B0D11", color: "#F2F0EB" }}>
        <div className="auth-v2-panel-dots" />
        <div className="auth-v2-panel-sweep" />
        <span className="auth-v2-ring" style={{ width: 280 }} />
        <span className="auth-v2-ring" style={{ width: 480, opacity: 0.7 }} />
        <span className="absolute left-1/2 top-[42%] -ml-9 -mt-9 flex h-[72px] w-[72px] items-center justify-center rounded-full" style={{ background: "#F2F0EB", boxShadow: "0 0 0 10px rgba(240,96,58,0.10), 0 20px 50px rgba(0,0,0,0.5)" }}>
          <Mark size={32} />
        </span>
        {SIGNALS.map((s) => (
          <span key={s.name} className="absolute flex items-center gap-2.5" style={{ left: s.left, top: s.top }}>
            <span className="relative h-2.5 w-2.5">
              {s.live && <span className="auth-v2-ping absolute inset-0 rounded-full bg-[#F0603A]" />}
              <span className="absolute inset-0 rounded-full bg-[#F0603A]" style={{ opacity: s.live ? 1 : 0.6 }} />
            </span>
            <span className="rounded px-2 py-1 text-[11px]" style={{ fontFamily: AUTH_V2.mono, color: s.live ? "#C9CDD5" : "#8C93A0", background: s.live ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.04)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}>{s.name}</span>
          </span>
        ))}
        <div className="relative flex max-w-[30rem] flex-col gap-[18px]">
          <p className="m-0 text-[clamp(1.35rem,1.9vw,1.7rem)] leading-[1.2] tracking-[-0.025em]" style={{ color: "#8C93A0" }}>
            <b className="font-normal" style={{ color: "#F2F0EB" }}>Unlock customer signals for your team and agents.</b> Running in your agent in minutes.
          </p>
          <div className="flex flex-wrap gap-2">
            {AGENTS.map((a) => (
              <span key={a.name} className="flex items-center gap-2 rounded-md py-1.5 pl-[7px] pr-[11px] text-[13px] font-normal" style={{ background: "rgba(255,255,255,0.06)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}>
                <img src={a.src} alt="" className="h-[18px] w-[18px] rounded" />{a.name}
              </span>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
