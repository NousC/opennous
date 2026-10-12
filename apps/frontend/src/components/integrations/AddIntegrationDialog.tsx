// The API plan's Add integration popup (GET-638). Two panes: a rail with search, the catalogue's
// categories and "Your own data → API"; a grid of the real provider catalogue. Connect opens the
// tool's detail step in the same dialog: what Nous reads, what it never does (only where the code
// guarantees it), who sees it, and the provider's own connect flow, passed in by the page.
import * as React from "react";
import { ArrowLeft, ArrowRight, Check, Lock, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IntegrationLogo, type AvailableProvider } from "@/components/mind/entities";
import { cn } from "@/lib/utils";
import {
  RAIL, type RailKey, catalogCategoryOf, matchesSearch, neverFor, railCounts, railLabel, readsFor, sortByRail, tileLine,
} from "./integrationCatalog";

export type TileState = "open" | "soon" | "locked" | "setup";

export function AddIntegrationDialog({
  open, onOpenChange, providers, isConnected, tileState, selected, onSelect, onBack,
  scopeOf, workspaceName, form, cta, notice, onOpenApi,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: AvailableProvider[];
  isConnected: (p: AvailableProvider) => boolean;
  tileState: (p: AvailableProvider) => TileState;
  /** The tool in the detail step; null shows the grid. */
  selected: AvailableProvider | null;
  onSelect: (p: AvailableProvider) => void;
  onBack: () => void;
  scopeOf: (p: AvailableProvider) => "personal" | "company";
  workspaceName: string;
  /** The provider's own form (API key, webhook panel, install steps), when it has one. */
  form?: React.ReactNode;
  /** The detail step's primary action — the provider's real connect button. */
  cta?: React.ReactNode;
  /** A line above the footer: an error from the connect flow, or why it can't be connected here. */
  notice?: React.ReactNode;
  /** "Your own data → API": the REST connect dialog. Omitted outside the API shell. */
  onOpenApi?: () => void;
}) {
  const [rail, setRail] = React.useState<RailKey>("all");
  const [q, setQ] = React.useState("");
  React.useEffect(() => { if (!open) { setRail("all"); setQ(""); } }, [open]);

  const counts = React.useMemo(() => railCounts(providers), [providers]);
  const tools = React.useMemo(() => sortByRail(providers)
    .filter((p) => (rail === "all" || catalogCategoryOf(p) === rail) && matchesSearch(p, q)), [providers, rail, q]);
  const heading = selected ? `Connect ${selected.display_name}` : "Add an integration";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton
        className="flex h-[min(600px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[820px] flex-col gap-0 overflow-hidden rounded-[14px] p-0 sm:flex-row">
        <DialogDescription className="sr-only">Connect a tool to Nous.</DialogDescription>

        {/* Rail: search, categories, and the API for your own data. */}
        <aside className="flex shrink-0 flex-col gap-0.5 border-b border-hairline bg-muted/30 p-2.5 sm:w-[200px] sm:border-b-0 sm:border-r sm:px-2.5 sm:py-3">
          <label className="mb-1 flex h-[30px] items-center gap-[7px] rounded-lg border border-border bg-card px-[9px] text-muted-foreground sm:mb-2.5">
            <Search className="size-3.5 shrink-0" strokeWidth={1.7} />
            <input type="search" value={q} onChange={(e) => { setQ(e.target.value); if (selected) onBack(); }}
              placeholder="Search tools" aria-label="Search tools"
              className="w-full min-w-0 border-0 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground" />
          </label>
          <div role="tablist" aria-label="Categories" className="flex gap-0.5 overflow-x-auto sm:flex-col">
            {RAIL.map((r) => {
              const on = rail === r.key;
              return (
                <button key={r.key} type="button" role="tab" aria-selected={on}
                  onClick={() => { setRail(r.key); if (selected) onBack(); }}
                  className={cn(
                    "flex h-[30px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[7px] px-2 text-left text-[12.5px] transition-colors duration-fast sm:w-full",
                    on ? "bg-card font-medium text-foreground shadow-[0_0_0_1px_hsl(var(--border)),0_1px_2px_rgba(20,20,18,0.05)]" : "text-ink-2 hover:bg-hover hover:text-foreground",
                  )}>
                  {r.label}
                  <span className="ml-auto pl-2 text-[11.5px] font-normal tabular-nums text-muted-foreground">{counts[r.key]}</span>
                </button>
              );
            })}
          </div>
          <span className="hidden flex-1 sm:block" />
          {onOpenApi && (
            <button type="button" onClick={onOpenApi}
              className="mt-1.5 flex flex-col gap-0.5 rounded-[9px] border border-dashed border-border px-2.5 py-1.5 text-left transition-colors duration-fast hover:bg-hover sm:mt-2 sm:py-2.5">
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                Your own data<ArrowRight className="size-3 text-muted-foreground" strokeWidth={1.8} />
              </span>
              <span className="text-[11.5px] text-muted-foreground">Send it in through the API</span>
            </button>
          )}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-hairline pl-5 pr-3">
            {selected && (
              <button type="button" aria-label="Back to all tools" onClick={onBack}
                className="-ml-2 inline-flex size-7 items-center justify-center rounded-[7px] text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground">
                <ArrowLeft className="size-[15px]" strokeWidth={1.7} />
              </button>
            )}
            <DialogTitle className="m-0 flex-1 truncate text-[14px] font-semibold">{heading}</DialogTitle>
            <button type="button" aria-label="Close" onClick={() => onOpenChange(false)}
              className="inline-flex size-7 items-center justify-center rounded-[7px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
              <X className="size-[15px]" strokeWidth={1.7} />
            </button>
          </div>

          {!selected ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
              {tools.length === 0 ? (
                <div className="py-16 text-center text-[13px] text-muted-foreground">No tools match.</div>
              ) : (
                <div className="grid grid-cols-1 gap-2.5 min-[480px]:grid-cols-2 md:grid-cols-3">
                  {tools.map((p) => {
                    const state = tileState(p);
                    const connected = isConnected(p);
                    return (
                      <div key={p.id} className={cn(
                        "flex min-w-0 flex-col gap-2.5 rounded-xl border border-hairline bg-card p-3.5 transition-shadow duration-fast hover:border-border hover:shadow-[0_2px_8px_-4px_rgba(20,20,18,0.12)]",
                        state !== "open" && "opacity-70",
                      )}>
                        <div className="flex items-center gap-2.5">
                          <IntegrationLogo url={p.logo_url} name={p.display_name} size={36} />
                          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{p.display_name}</span>
                        </div>
                        <span className="line-clamp-2 min-h-9 text-[12px] leading-[1.45] text-muted-foreground">{tileLine(p)}</span>
                        {state === "soon" ? (
                          <span className="inline-flex h-[26px] items-center text-[12px] text-muted-foreground">Coming soon</span>
                        ) : state === "setup" ? (
                          // Self-host: the install has no OAuth app for this tool yet (GET-837).
                          <a href="/settings?section=instance" title="This install needs its OAuth app first. See Instance setup."
                            className="inline-flex h-[26px] items-center self-start text-[12px] text-muted-foreground underline-offset-4 transition-colors duration-fast hover:text-foreground hover:underline">
                            Needs setup
                          </a>
                        ) : connected ? (
                          // Every tool can hold more than one connection, so a connected tile still
                          // opens its connect step — as "add another".
                          <button type="button" onClick={() => onSelect(p)} aria-label={`Connect another ${p.display_name}`}
                            className="inline-flex h-[26px] items-center gap-[5px] self-start text-[12px] text-muted-foreground transition-colors duration-fast hover:text-foreground">
                            <Check className="size-[13px] text-positive" strokeWidth={2} />Connected
                          </button>
                        ) : (
                          <Button variant="outline" size="sm" className="h-[26px] self-start" onClick={() => onSelect(p)} aria-label={`Connect ${p.display_name}`}>
                            {state === "locked" && <Lock className="!size-3" />}Connect
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <DetailStep provider={selected} scope={scopeOf(selected)} workspaceName={workspaceName}
              form={form} cta={cta} notice={notice} onCancel={onBack} />
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function DetailStep({ provider, scope, workspaceName, form, cta, notice, onCancel }: {
  provider: AvailableProvider; scope: "personal" | "company"; workspaceName: string;
  form?: React.ReactNode; cta?: React.ReactNode; notice?: React.ReactNode; onCancel: () => void;
}) {
  const reads = readsFor(provider);
  const never = neverFor(provider);
  // Personal or shared is per tool, decided by the API, not by whoever connects it. Both options
  // show so the choice is legible; the one this tool isn't is disabled and says why.
  const fixedWhy = scope === "personal"
    ? `${provider.display_name} is connected by each person for themselves.`
    : `${provider.display_name} is one connection for everyone in ${workspaceName}.`;
  const seg = (value: "personal" | "company", label: string) => {
    const on = scope === value;
    return (
      <button type="button" role="radio" aria-checked={on} disabled={!on} title={on ? undefined : fixedWhy}
        className={cn(
          "h-[30px] whitespace-nowrap rounded-[7px] px-3 text-[12.5px] font-medium transition-colors duration-fast",
          on ? "bg-card text-foreground shadow-[0_0_0_1px_hsl(var(--border)),0_1px_2px_rgba(20,20,18,0.06)]" : "cursor-not-allowed text-muted-foreground",
        )}>
        {label}
      </button>
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-5 py-6 sm:px-8 sm:py-7">
        <div className="flex items-center gap-3.5">
          <IntegrationLogo url={provider.logo_url} name={provider.display_name} size={52} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[17px] font-semibold tracking-[-0.01em] text-foreground">{provider.display_name}</span>
            <span className="text-[12px] text-muted-foreground">{railLabel(catalogCategoryOf(provider))}</span>
          </div>
        </div>

        {(reads.length > 0 || never) && (
          <div className="flex flex-col gap-2.5 text-[13px]">
            {reads.length > 0 && <span className="text-[12px] font-medium text-ink-2">What Nous reads</span>}
            {reads.map((r) => (
              <div key={r} className="flex items-start gap-2.5">
                <span className="mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[hsl(var(--positive)/0.12)] text-positive">
                  <Check className="size-[11px]" strokeWidth={2.6} />
                </span>
                <span>{r}</span>
              </div>
            ))}
            {never && (
              <>
                <span className={cn("text-[12px] font-medium text-ink-2", reads.length > 0 && "mt-1.5")}>What it never does</span>
                <div className="flex items-start gap-2.5">
                  <span className="mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <X className="size-[11px]" strokeWidth={2.6} />
                  </span>
                  <span>{never}</span>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-ink-2">Who sees it</span>
          <div role="radiogroup" aria-label="Who sees it" className="inline-flex gap-0.5 self-start rounded-[9px] bg-muted p-0.5">
            {seg("personal", "Only me")}
            {seg("company", `Everyone in ${workspaceName}`)}
          </div>
        </div>

        {form && <div className="min-w-0">{form}</div>}
      </div>

      {notice && <div className="px-5 pb-2 sm:px-8">{notice}</div>}
      <div className="flex shrink-0 items-center gap-2.5 border-t border-hairline px-5 py-3.5 sm:px-8">
        <span className="hidden flex-1 text-[12px] text-muted-foreground sm:block">You can disconnect any time from Integrations.</span>
        <span className="flex-1 sm:hidden" />
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        {cta}
      </div>
    </div>
  );
}
