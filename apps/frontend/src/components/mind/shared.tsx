// Shared infra used by Mind.tsx and its lazy-loaded popup chunks.
// Kept here (not in Mind.tsx) so popup chunks don't pull Mind back in,
// which would defeat the whole point of code-splitting.

import { useState, type ReactNode } from "react";
import { X, Copy, Check } from "lucide-react";

// ─── PopupModal ───────────────────────────────────────────────────────────────
// The chrome every Mind popup sits inside. Used by Companies, People,
// Integrations, CrmSync, Memories, and Settings popups.

export function PopupModal({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-background border border-border shadow-2xl flex flex-col"
        style={{ width: Math.min(900, window.innerWidth - 32), maxHeight: "88vh", fontFamily: "'JetBrains Mono',monospace" }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/40 flex-shrink-0">
          <span className="text-[9px] text-muted-foreground/40 tracking-widest">{label}</span>
          <button onClick={onClose} className="text-muted-foreground/40 hover:text-foreground/70 transition-colors">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>
  );
}

// ─── CopyButton ───────────────────────────────────────────────────────────────
// Small floating copy icon used inside code blocks (Settings → SDK / MCP
// instructions, ConnectModal).

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
      className="absolute top-2 right-2 text-muted-foreground/40 hover:text-foreground/70 transition-colors"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ADJECTIVES = ["Crow","Atlas","Iron","Amber","Onyx","Cobalt","Steel","Jade","Silver","Bronze","Copper","Crimson","Indigo","Obsidian","Granite","Marble","Basalt","Quartz","Flint","Cinder"];
const NOUNS      = ["Marigold","Oracle","Cipher","Nexus","Vector","Prism","Signal","Archive","Beacon","Matrix","Cortex","Lattice","Fulcrum","Apex","Vertex","Zenith","Meridian","Axis","Core","Sluice"];

// Deterministic per-workspace codename — shown on Mind dashboard + Profile tab.
export function generateCodename(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h) ^ seed.charCodeAt(i);
  const abs = Math.abs(h);
  return `${ADJECTIVES[abs % ADJECTIVES.length]}-of-${NOUNS[(abs >> 8) % NOUNS.length]}-${(abs % 99) + 1}`;
}

// ── ICP tiers ──────────────────────────────────────────────────────────────
// The actionable class on top of the raw score. Mirrors the core thresholds
// (scorecard.ts DEFAULT_TIER_THRESHOLDS) so the UI and the model agree.
export type IcpTier = "tier_1" | "tier_2" | "tier_3" | "not_icp";

export function tierFromScore(score: number | null | undefined): IcpTier | null {
  if (score == null || Number.isNaN(Number(score))) return null;
  const s = Number(score);
  if (s >= 85) return "tier_1";
  if (s >= 70) return "tier_2";
  if (s >= 50) return "tier_3";
  return "not_icp";
}

// Label, color, and the recommended play per tier — one source for every tier UI.
export const TIER_UI: Record<IcpTier, { label: string; color: string; bg: string; play: string }> = {
  tier_1:  { label: "Tier 1",  color: "#15803d", bg: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400",   play: "Work by hand — deep personalization, 1:1 outreach." },
  tier_2:  { label: "Tier 2",  color: "#ca8a04", bg: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",   play: "Queue to automation — base sequence with variables." },
  tier_3:  { label: "Tier 3",  color: "#ea580c", bg: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400", play: "Nurture — low-cost touch; watch for a signal to promote." },
  not_icp: { label: "Not ICP", color: "#6b7280", bg: "bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400",        play: "Suppress — outside the profile, do not spend." },
};

// Compact relative-time string ("Today", "3d ago", "Jan 15").
export function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d < 0) return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Timeline timestamp that keeps the clock time for meetings/calls (and any
// future-dated event) — "Jun 18, 3:00 PM" instead of relTime's bare "Jun 18".
// For everything else, falls back to the compact relative string.
export function eventTime(iso: string | null, type?: string): string {
  if (!iso) return "—";
  const t = type || "";
  const isMeeting = t.includes("meeting") || t.includes("call");
  const isFuture = new Date(iso).getTime() > Date.now();
  if (!isMeeting && !isFuture) return relTime(iso);
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ─── Types shared across popups ───────────────────────────────────────────────

export type SettingsTab = "profile" | "team" | "agora" | "api-keys" | "billing" | "usage" | "admin";
