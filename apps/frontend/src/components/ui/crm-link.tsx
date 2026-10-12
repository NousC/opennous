import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCrm } from "@/hooks/useCrm";

/** The connected CRM's mark: a small square in its brand colour with its initial (GET-602). */
export function CrmMark({ className }: { className?: string }) {
  const crm = useCrm();
  if (!crm.provider) return null;
  return (
    <span
      aria-hidden
      style={{ background: crm.color }}
      className={cn("inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[4px] text-[8px] font-bold text-white", className)}
    >
      {crm.label.charAt(0)}
    </span>
  );
}

/**
 * "View in HubSpot ↗" — named after the workspace's own CRM, never a fixed one. Renders nothing
 * without a link (the record isn't in a CRM yet, or the portal isn't known).
 */
export function CrmLink({ href, label, className }: { href: string | null | undefined; label?: string; className?: string }) {
  const crm = useCrm();
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12.5px] font-medium text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground",
        className,
      )}
    >
      <CrmMark />
      {label ?? `View in ${crm.provider ? crm.label : "CRM"}`}
      <ArrowUpRight className="h-3 w-3 text-muted-foreground" />
    </a>
  );
}

/**
 * The connected CRM's name as text, reactive (GET-602): "HubSpot", or `fallback` ("your CRM" by
 * default; "CRM" where the name starts a label, e.g. a column header).
 */
export function CrmName({ fallback = "your CRM" }: { fallback?: string }) {
  const crm = useCrm();
  return <>{crm.provider ? crm.label : fallback}</>;
}
