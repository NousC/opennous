// The small pieces a deal is drawn from, shared by the board's cards and the list's rows.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "@/components/ui/owner-filter";
import { EntityAvatar } from "@/components/EntityAvatar";
import type { DealFlag } from "./dealModel";
import { faviconUrl } from "@/lib/externalImages";

/** The account's logo in the palette's tile (24px, 6px radius, hairline inset), the way Home's rows
 *  and the ⌘K palette lead a row. `size` 18 or 20 for a table cell. */
export function AccountTile({ name, domain, size = 24, className }: { name: string | null | undefined; domain: string | null | undefined; size?: 18 | 20 | 24; className?: string }) {
  const box = size === 24 ? "h-6 w-6 rounded-md" : size === 20 ? "h-5 w-5 rounded-[5px]" : "h-[18px] w-[18px] rounded-[5px]";
  return (
    <EntityAvatar kind="company" name={name ?? "?"} domain={domain ?? null}
      className={cn(box, "flex-shrink-0 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]", className)}
      textClassName={size === 24 ? "text-[10px] font-medium" : "text-[8.5px] font-medium"} />
  );
}

/** The account's favicon, or its initial when it has no domain or the image fails. */
export function AccountLogo({ name, domain, size = 16, className }: { name: string | null; domain: string | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  const favicon = faviconUrl(domain);
  if (favicon && !broken) {
    return (
      <img src={favicon} alt="" onError={() => setBroken(true)}
        className={cn("flex-shrink-0 rounded-[4px] bg-white object-contain ring-1 ring-hairline", className)} style={style} />
    );
  }
  return (
    <span className={cn("flex flex-shrink-0 items-center justify-center rounded-[4px] bg-muted font-semibold text-ink-2", className)}
      style={{ ...style, fontSize: Math.max(8, Math.round(size * 0.53)) }}>
      {(name ?? "?").trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** The deal owner (the AE in the CRM), as a tinted initial circle with the name on hover. Same
 *  tint as the owner filter, so a person reads as one face everywhere. */
export function OwnerAvatar({ name, size = 18 }: { name: string | null | undefined; size?: number }) {
  if (!name) return null;
  return (
    <span title={name} className="inline-flex flex-shrink-0">
      <PersonAvatar person={{ id: name, name }} size={size} />
    </span>
  );
}

// Nous deal health, never the CRM's: the tooltip says whose number it is and why it is what it is.
// Just the number in the quiet tone, no chip around it (GET-658); red only under 50, where the deal
// counts as at risk.

export function DealHealthBadge({ score, reason }: { score: number | null | undefined; reason?: string | null }) {
  if (score == null || Number.isNaN(Number(score))) return null;
  const h = Math.round(Number(score));
  return (
    <span title={`Nous deal health ${h}/100${reason ? `. ${reason}` : ""}`}
      className={cn("inline-flex flex-shrink-0 cursor-help items-center text-[11.5px] tabular-nums",
        h < 50 ? "text-risk" : "text-muted-foreground/70")}>
      {h}
    </span>
  );
}

// The flag as words in its tone, no filled chip (GET-658): "Quiet 21 days" in red reads on its own.
const FLAG_TONE: Record<DealFlag["tone"], string> = {
  risk: "text-risk",
  warning: "text-warning",
  neutral: "text-muted-foreground/80",
};

export function DealFlagChip({ flag, className }: { flag: DealFlag | null; className?: string }) {
  if (!flag) return null;
  const t = FLAG_TONE[flag.tone];
  return (
    <span title={flag.title}
      className={cn("inline-flex min-w-0 max-w-full flex-shrink-0 items-center self-start text-[11.5px]", t, className)}>
      <span className="truncate">{flag.text}</span>
    </span>
  );
}
