// The API plan's Integrations pages (GET-631): Personal and Shared are the same page — a toolbar
// with the two views and "Add integration", then one card grid. Identical cards on both sides:
// logo, name, account line, status, last sync, and an icon-only manage menu. No descriptions, no
// counts — on the cards or on the Personal / Shared tabs. Presentational only; Integrations.tsx owns the data and the flows.
import * as React from "react";
import { Link } from "react-router-dom";
import { Plus, SlidersVertical } from "lucide-react";
import { IntegrationLogo } from "@/components/mind/entities";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { progressTitle, syncPercent, type SourceStatus, type SyncProgress } from "./sourceCardModel";

export type ManageAction = { label: string; onSelect: () => void; destructive?: boolean; disabled?: boolean };

const tabClass = (on: boolean) => cn(
  "inline-flex h-7 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-2.5 text-[12.5px] font-medium transition-colors duration-fast",
  on ? "bg-muted text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]" : "text-ink-2 hover:bg-hover hover:text-foreground",
);

/** Personal / Shared (links between the two routes) and Add integration on the right. */
export function SourcesToolbar({ side, onAdd }: {
  side: "personal" | "company"; onAdd: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
      <nav aria-label="Integration views" className="flex gap-0.5">
        <Link to="/integrations" aria-current={side === "personal" ? "page" : undefined} className={tabClass(side === "personal")}>
          Personal
        </Link>
        <Link to="/company-sources" aria-current={side === "company" ? "page" : undefined} className={tabClass(side === "company")}>
          Shared
        </Link>
      </nav>
      <span className="flex-1" />
      <Button size="sm" onClick={onAdd} data-tour="add-integration" aria-label="Add integration">
        <Plus className="!size-[13px]" strokeWidth={2} /><span className="hidden sm:inline">Add integration</span>
      </Button>
    </div>
  );
}

const chipClass: Record<SourceStatus["kind"], string> = {
  live: "bg-[hsl(var(--positive)/0.1)] text-positive",
  syncing: "bg-muted text-ink-2",
  warn: "bg-[hsl(var(--warning-dot)/0.14)] text-warning",
};
const dotClass: Record<SourceStatus["kind"], string> = {
  live: "bg-positive",
  syncing: "bg-brand",
  warn: "bg-warning-dot",
};

export function SourceCard({ logoUrl, name, account, status, synced, actions, manageHint, progress }: {
  logoUrl?: string; name: string; account: string; status: SourceStatus; synced: string;
  /** A running sync's progress: a thin bar under the account line while the chip says Syncing (in the gap, so the card keeps its height). */
  progress?: SyncProgress | null;
  /** The manage menu. Empty: the button shows disabled with `manageHint` as its tooltip. */
  actions: (ManageAction | "separator" | { note: string })[];
  manageHint?: string;
}) {
  const canManage = actions.some((a) => typeof a === "object" && "onSelect" in a);
  const pct = status.kind === "syncing" ? syncPercent(progress) : null;
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-hairline bg-card pb-2.5 pl-4 pr-3 pt-3.5 shadow-[0_1px_2px_rgba(20,20,18,0.03)]">
      <div className="flex items-start gap-[11px]">
        <IntegrationLogo url={logoUrl} name={name} size={32} />
        <div className="relative flex min-w-0 flex-1 flex-col leading-[1.3]">
          <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
          <span className="truncate text-[12px] text-muted-foreground">{account}</span>
          {pct !== null && (
            <span role="progressbar" aria-label={`${name} sync`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
              title={progressTitle(progress)} className="absolute inset-x-0 -bottom-[7px] block h-[3px] overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.max(2, pct)}%` }} />
            </span>
          )}
        </div>
        <span className={cn("inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium", chipClass[status.kind])}>
          <span aria-hidden className={cn("size-1.5 rounded-full", dotClass[status.kind])} />
          {status.label}
        </span>
      </div>
      <div className="flex items-center gap-2 border-t border-hairline pt-2 text-[12px] text-muted-foreground">
        <span className="truncate">{synced}</span>
        <span className="flex-1" />
        {canManage ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`Manage ${name}`}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground">
                <SlidersVertical className="size-[15px]" strokeWidth={1.7} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              {actions.map((a, i) => a === "separator"
                ? <DropdownMenuSeparator key={i} />
                : "note" in a
                  ? <DropdownMenuLabel key={i} className="text-[11.5px] font-normal text-muted-foreground">{a.note}</DropdownMenuLabel>
                  : (
                    <DropdownMenuItem key={i} disabled={a.disabled} onSelect={a.onSelect}
                      className={cn("text-[12.5px]", a.destructive && "text-destructive focus:text-destructive")}>
                      {a.label}
                    </DropdownMenuItem>
                  ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button type="button" aria-label={`Manage ${name}`} disabled title={manageHint}
            className="inline-flex size-7 shrink-0 cursor-not-allowed items-center justify-center rounded-[7px] text-muted-foreground opacity-40">
            <SlidersVertical className="size-[15px]" strokeWidth={1.7} />
          </button>
        )}
      </div>
    </article>
  );
}

/** The dashed card that ends every grid. */
export function AddSourceCard({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex min-h-[110px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/60 text-[13px] font-medium text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground">
      <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-muted">
        <Plus className="size-[15px]" strokeWidth={1.7} />
      </span>
      Add integration
    </button>
  );
}

export function SourceGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">{children}</div>;
}
