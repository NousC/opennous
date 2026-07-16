import { useState, useEffect, CSSProperties } from "react";
import { Link, useLocation } from "react-router-dom";
import { Moon, Sun, Github } from "lucide-react";
import { SEOHead } from "@/components/SEOHead";
import { NousLegalFooter } from "@/components/landing/NousLegalFooter";

const WEBHOOK_URL = import.meta.env.VITE_WAITLIST_WEBHOOK_URL || "";
const BUILD_START = new Date("2026-04-19");

function useFonts() {
  useEffect(() => {
    if (document.getElementById("nous-fonts")) return;
    const link = document.createElement("link");
    link.id = "nous-fonts";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&family=Inter:wght@300;400;500&display=swap";
    document.head.appendChild(link);
  }, []);
}

export interface Theme {
  bg: string; surface: string; surfaceAlt: string;
  text: string; muted: string; accent: string;
  border: string; accentBg: string; inputBg: string;
  dark: boolean;
}

export const mkTheme = (dark: boolean): Theme => dark ? {
  bg: "radial-gradient(ellipse 90% 65% at 50% 35%, #0F1C2E 0%, #0A1422 40%, #060D18 100%)",
  surface: "#111D2B", surfaceAlt: "#0E1828",
  text: "#DCE8F4", muted: "#3A5570", accent: "#6BA8C8",
  border: "#1A2E42", accentBg: "#132030", inputBg: "#0E1828", dark,
} : {
  bg: "radial-gradient(ellipse 90% 65% at 50% 35%, #ECF1FA 0%, #E0E8F2 35%, #D4DDED 70%, #C9D4E5 100%)",
  surface: "#FFFFFF", surfaceAlt: "#F4F7FC",
  text: "#0C1827", muted: "#7A9AB2", accent: "#4A80A6",
  border: "#D4DDED", accentBg: "#EDF5FA", inputBg: "#FFFFFF", dark,
};

// ─── Icons ───────────────────────────────────────────────────────────
const LiIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
  </svg>
);

// ─── Waitlist Modal ───────────────────────────────────────────────────
const WaitlistModal = ({ isOpen, onClose, t }: { isOpen: boolean; onClose: () => void; t: Theme }) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  useEffect(() => {
    if (!isOpen) { setStatus("idle"); setName(""); setEmail(""); setCompany(""); }
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setStatus("loading");
    try {
      const res = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, company }) });
      if (res.ok) {
        if (WEBHOOK_URL) fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, company, source: "nous_waitlist", submittedAt: new Date().toISOString() }) }).catch(() => {});
        setStatus("success");
      } else setStatus("error");
    } catch { setStatus("error"); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 24px" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(12,24,39,0.55)", backdropFilter: "blur(10px)" }} onClick={onClose} />
      <div style={{ position: "relative", background: t.surface, border: `1px solid ${t.border}`, borderRadius: "20px", padding: "36px", width: "100%", maxWidth: "420px", boxShadow: "0 24px 64px rgba(12,24,39,0.22)" }}>
        <button onClick={onClose} style={{ position: "absolute", top: "16px", right: "20px", color: t.muted, background: "none", border: "none", fontSize: "20px", cursor: "pointer" }}>×</button>
        {status === "success" ? (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: t.accentBg, border: `1px solid ${t.border}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontFamily: "JetBrains Mono, monospace", fontSize: "16px", color: t.accent }}>✓</div>
            <h3 style={{ fontFamily: "Instrument Serif, Georgia, serif", fontSize: "22px", color: t.text, marginBottom: "8px" }}>You're on the list.</h3>
            <p style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.muted }}>We'll reach out when ready.</p>
          </div>
        ) : (
          <>
            <p style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: t.accent, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: "8px" }}>— Waitlist</p>
            <h3 style={{ fontFamily: "Instrument Serif, Georgia, serif", fontSize: "26px", color: t.text, marginBottom: "4px" }}>Join the waitlist</h3>
            <p style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: t.muted, marginBottom: "28px" }}>Be first when we launch.</p>
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {([["Name", "text", name, setName, "Your name"], ["Email", "email", email, setEmail, "you@company.com"], ["Company", "text", company, setCompany, "Company name"]] as const).map(([label, type, val, set, ph]) => (
                <div key={label}>
                  <label style={{ display: "block", fontFamily: "JetBrains Mono, monospace", fontSize: "10px", color: t.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "5px" }}>{label}</label>
                  <input type={type} required value={val} onChange={e => (set as (v: string) => void)(e.target.value)} placeholder={ph}
                    style={{ width: "100%", height: "42px", padding: "0 14px", background: t.inputBg, border: `1px solid ${t.border}`, borderRadius: "9px", fontFamily: "JetBrains Mono, monospace", fontSize: "13px", color: t.text, outline: "none" }} />
                </div>
              ))}
              {status === "error" && <p style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "11px", color: "#E05555" }}>Something went wrong. Try again.</p>}
              <button type="submit" disabled={status === "loading"} style={{ height: "42px", background: t.text, color: t.surface, border: "none", borderRadius: "9px", fontFamily: "JetBrains Mono, monospace", fontSize: "13px", cursor: "pointer", opacity: status === "loading" ? 0.6 : 1 }}>
                {status === "loading" ? "Joining..." : "Join waitlist →"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

// ─── Left Nav ─────────────────────────────────────────────────────────
const LEFT_LINKS: { label: string; href: string | null }[] = [
  { label: "Home",           href: "/" },
  { label: "Why",            href: "/why" },
  { label: "Infrastructure", href: "/infrastructure" },
  { label: "Pricing",        href: "/plans" },
  { label: "Waitlist",       href: "/waitlist" },
];

const LeftNav = ({ t, onToggleDark, onOpenWaitlist }: { t: Theme; onToggleDark: () => void; onOpenWaitlist: () => void }) => {
  const location = useLocation();
  const isActive = (href: string | null) =>
    href === "/" ? location.pathname === "/" : href ? location.pathname.startsWith(href) : false;

  const lnk = (href: string | null): CSSProperties => ({
    fontFamily: "Inter, sans-serif", fontSize: "12.5px", letterSpacing: "0.005em",
    fontWeight: isActive(href) ? 500 : 400,
    color: isActive(href) ? t.text : t.muted,
    textDecoration: "none", padding: "5px 0",
    background: "none", border: "none", cursor: "pointer",
    display: "block", textAlign: "left", transition: "color 0.15s",
  });

  return (
    <nav style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: "172px", display: "flex", flexDirection: "column", padding: "30px 38px", zIndex: 200, pointerEvents: "none" }}>
      <Link to="/" style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: "7px", textDecoration: "none" }}>
        <img src="/nous-logo.svg" alt="Nous" style={{ height: "15px", filter: t.dark ? "brightness(0) invert(1) opacity(0.6)" : "brightness(0) saturate(0) opacity(0.65)" }} />
        <span style={{ fontFamily: "Instrument Serif, Georgia, serif", fontSize: "16px", color: t.text, letterSpacing: "-0.02em" }}>nous</span>
      </Link>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: "1px", pointerEvents: "auto" }}>
        {LEFT_LINKS.map(item =>
          item.href ? (
            <Link key={item.label} to={item.href} style={lnk(item.href)}>{item.label}</Link>
          ) : (
            <button key={item.label} onClick={onOpenWaitlist} style={lnk(null)}>{item.label}</button>
          )
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", pointerEvents: "auto" }}>
        <button onClick={onToggleDark} style={{ width: "28px", height: "28px", display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: `1px solid ${t.border}`, borderRadius: "7px", cursor: "pointer", color: t.muted }}>
          {t.dark ? <Sun size={12} /> : <Moon size={12} />}
        </button>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "9px", color: t.muted, letterSpacing: "0.1em" }}>2026</span>
      </div>
    </nav>
  );
};

// ─── Right Nav ────────────────────────────────────────────────────────
const RIGHT_UPPER: { label: string; href: string | null }[] = [
  { label: "About", href: "/about" },
  { label: "Talk",  href: "/talk" },
];
const RIGHT_LOWER = [
  { label: "Roadmap",         href: "/roadmap" },
  { label: "Updates",         href: "/updates" },
  { label: "Convictions",     href: "/convictions" },
  { label: "Journal",          href: "/journal" },
  { label: "Nous research", href: "https://github.com/nous-gtm/nous-research" },
];

const RightNav = ({ t, onOpenWaitlist }: { t: Theme; onOpenWaitlist: () => void }) => {
  const location = useLocation();
  const isActive = (href: string | null) =>
    href ? (href === "/" ? location.pathname === "/" : location.pathname.startsWith(href)) : false;
  const daysBuild = Math.floor((Date.now() - BUILD_START.getTime()) / 86400000);

  const lnk = (href: string | null): CSSProperties => ({
    fontFamily: "Inter, sans-serif", fontSize: "12.5px", letterSpacing: "0.005em",
    fontWeight: isActive(href) ? 500 : 400,
    color: isActive(href) ? t.text : t.muted,
    textDecoration: "none", padding: "5px 0",
    background: "none", border: "none", cursor: "pointer",
    display: "block", textAlign: "right", transition: "color 0.15s",
  });

  return (
    <nav style={{ position: "fixed", right: 0, top: 0, bottom: 0, width: "172px", zIndex: 200, pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: "50%", right: "38px", transform: "translateY(-50%)", display: "flex", flexDirection: "column", alignItems: "flex-end", pointerEvents: "auto" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", alignItems: "flex-end", marginBottom: "32px" }}>
          {RIGHT_UPPER.map(item =>
            item.href ? (
              <Link key={item.label} to={item.href} style={lnk(item.href)}>{item.label}</Link>
            ) : (
              <button key={item.label} onClick={onOpenWaitlist} style={lnk(null)}>{item.label}</button>
            )
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "1px", alignItems: "flex-end" }}>
          {RIGHT_LOWER.map(item =>
            item.href.startsWith("http") ? (
              <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer" style={lnk(item.href)}>{item.label}</a>
            ) : (
              <Link key={item.label} to={item.href} style={lnk(item.href)}>{item.label}</Link>
            )
          )}
        </div>
      </div>

      <div style={{ position: "absolute", bottom: "30px", right: "38px", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "10px", pointerEvents: "auto" }}>
        <div style={{ display: "flex", gap: "12px", color: t.muted }}>
          <a href="https://github.com/nous-gtm" target="_blank" rel="noreferrer" style={{ color: t.muted, display: "flex" }}>
            <Github size={14} />
          </a>
          <a href="https://www.linkedin.com/company/opennous/" target="_blank" rel="noreferrer" style={{ color: t.muted, display: "flex" }}>
            <LiIcon size={14} />
          </a>
        </div>
        <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "9px", color: t.muted, letterSpacing: "0.06em" }}>
          Day {daysBuild}
        </span>
      </div>
    </nav>
  );
};

// ─── Layout ───────────────────────────────────────────────────────────
interface NousPageLayoutProps {
  seoTitle: string;
  seoDescription: string;
  children: (theme: Theme) => React.ReactNode;
}

export function NousPageLayout({ seoTitle, seoDescription, children }: NousPageLayoutProps) {
  const [dark, setDark] = useState(false);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const t = mkTheme(dark);
  useFonts();

  return (
    <div style={{ minHeight: "100vh", background: t.bg }}>
      <SEOHead title={seoTitle} description={seoDescription} />
      <style>{`* { box-sizing: border-box; } a:hover, button:hover { opacity: 0.75; }`}</style>

      <LeftNav t={t} onToggleDark={() => setDark(d => !d)} onOpenWaitlist={() => setWaitlistOpen(true)} />
      <RightNav t={t} onOpenWaitlist={() => setWaitlistOpen(true)} />
      <WaitlistModal isOpen={waitlistOpen} onClose={() => setWaitlistOpen(false)} t={t} />

      <main style={{ padding: "90px 210px 140px", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: "100%", maxWidth: "660px" }}>
          {children(t)}
        </div>
      </main>
      <NousLegalFooter scheme={dark ? "dark" : "light"} />
    </div>
  );
}
