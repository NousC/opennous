// Usage and billing on the API plan (GET-633, board Usage). The plan and what it includes, the
// credits meter, the backfill allowance, credits per day, calls per key (C1) and invoices. All of
// it read from the same endpoints the page always used; nothing here is a placeholder.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BackfillCard } from "@/components/BackfillCard";
import { CONTACT_URL } from "@/config/contact";
import { SELF_SERVE_TIERS, isApiTier } from "@/config/plans";
import { day, num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dailyBars, fillPct, keyCreditsCell, planLine, type DayCredits, type PlanState } from "@/lib/usagePlan";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type ApiUsageState = PlanState & {
  aiCredits?: (NonNullable<PlanState["aiCredits"]> & {
    state?: "ok" | "warn" | "over" | "restricted";
    nextTier?: { credits: number; priceUsd: number } | null;
    notLiveReason?: "no_plan" | "canceled" | "payment_failed" | null;
    /** A failed card still inside its grace (GET-698): reading continues until graceUntil. */
    paymentFailed?: boolean;
    graceUntil?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    /** Roughly how many days until reading pauses, at this period's pace (GET-733). */
    daysUntilStop?: number | null;
  }) | null;
  stripe?: { customer: boolean; subscription: boolean } | null;
  planName?: string;
  /** The Custom plan's quote on file: price, credits and what it bought. Null on the API plan. */
  customPlan?: { priceUsd: number | null; credits: number | null; basics: string[]; custom: string[]; customLabel?: string } | null;
};

export type ApiInvoice = {
  id: string; number: string | null; amount: number; currency: string; status: string;
  created: string; url: string | null; pdf: string | null;
};

// Credits per key come from the read ledger (E6): what Nous billed for conversations a key's writes
// cited. Null = the source cannot tell (reads from before keys were stamped), shown as "—".

const card = "relative overflow-hidden rounded-xl border border-border bg-card";
const th = "h-[34px] whitespace-nowrap border-b border-border px-3 text-[12px] font-medium text-muted-foreground first:pl-4 last:pr-4";
const td = "h-[42px] whitespace-nowrap border-b border-hairline px-3 first:pl-4 last:pr-4";

function Stat({ label, used, of, tone = "ink", children }: {
  label: string; used: number; of: number | null; tone?: "ink" | "grey" | "risk"; children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[20px] font-medium tabular-nums tracking-[-0.02em] text-foreground">
        {num(used)}
        {of != null && <span className="ml-1 text-[12px] font-normal tracking-normal text-muted-foreground">of {num(of)}</span>}
      </span>
      {of != null && (
        <span className="h-1 overflow-hidden rounded-sm bg-muted">
          <span className={cn("block h-1 rounded-sm", tone === "grey" ? "bg-muted-foreground/60" : tone === "risk" ? "bg-risk" : "bg-foreground")}
            style={{ width: `${fillPct(used, of)}%` }} />
        </span>
      )}
      {children}
    </div>
  );
}

type ChartView = "all" | "conversations" | "ai";

/**
 * Credits, last 30 days (GET-721). All, or split: conversations read from your sources, and AI work
 * (drafts, summaries, the agent, automations). Hover a day for its numbers; the readout replaces the
 * old "Peak on" line.
 */
function CreditsChart({ daily, since }: { daily: DayCredits[] | null; since?: string | null }) {
  const [view, setView] = useState<ChartView>("all");
  const [hover, setHover] = useState<number | null>(null);
  if (daily === null) return (
    <section className={cn(card, "px-4 pb-3 pt-4")}><div className="h-[150px] animate-pulse rounded-md bg-muted/40" /></section>
  );
  const val = (d: DayCredits) => view === "conversations" ? (d.reads ?? 0) : view === "ai" ? (d.ai ?? 0) : (d.credits || 0);
  const max = Math.max(0, ...daily.map(val));
  const total = daily.reduce((n, d) => n + val(d), 0);
  const shown = hover != null ? daily[hover] : null;
  const axis = daily.length ? [daily[0], daily[Math.floor((daily.length - 1) / 2)], daily[daily.length - 1]].map(d => day(d.day)) : [];
  const VIEWS: [ChartView, string][] = [["all", "All"], ["conversations", "Conversations"], ["ai", "AI work"]];
  return (
    <section className={cn(card, "px-4 pb-3 pt-4")}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="section-title">{since ? "Credits this period" : "Credits, last 30 days"}</h2>
        <span className="flex-1" />
        <div className="flex h-[26px] items-center rounded-lg bg-foreground/[0.05] p-[3px]">
          {VIEWS.map(([k, l]) => (
            <button key={k} onClick={() => setView(k)}
              className={cn("h-full rounded-[6px] px-2.5 text-[12px] transition-colors",
                view === k ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted-foreground hover:text-foreground")}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {/* The readout: the hovered day, else the window's total for this view. */}
      <p className="mb-2 min-h-[18px] text-[12px] tabular-nums text-muted-foreground">
        {shown ? (<>
          <span className="font-medium text-foreground">{day(shown.day)} · {num(val(shown))} credits</span>
          {view === "all" && <> · {num(shown.reads ?? 0)} conversations · {num(shown.ai ?? 0)} AI work{shown.automations ? ` (${num(shown.automations)} automations)` : ""}</>}
          {view === "ai" && shown.automations ? <> · {num(shown.automations)} from automations</> : null}
        </>) : <>{num(total)} credits {since ? `since ${day(since)}` : "in 30 days"}</>}
      </p>
      {max === 0 ? (
        <div className="flex h-[120px] items-center justify-center border-b border-border text-[12px] text-muted-foreground">No usage yet.</div>
      ) : (
        <>
          <div className="flex h-[120px] items-end gap-[2px] border-b border-border sm:gap-1" onMouseLeave={() => setHover(null)}>
            {daily.map((d, i) => {
              const h = max > 0 ? (val(d) / max) * 100 : 0;
              const aiPart = view === "all" && d.credits ? Math.min(1, (d.ai ?? 0) / d.credits) : 0;
              return (
                <span key={d.day} onMouseEnter={() => setHover(i)}
                  className="flex h-full min-w-[2px] flex-1 cursor-default flex-col justify-end">
                  <span className={cn("flex w-full flex-col overflow-hidden rounded-t-[2px] transition-opacity duration-fast", hover != null && hover !== i && "opacity-40")}
                    style={{ height: `${h}%` }}>
                    {aiPart > 0 && <span className="w-full bg-[#E0560B]" style={{ height: `${aiPart * 100}%` }} />}
                    <span className={cn("w-full flex-1", view === "ai" ? "bg-[#E0560B]" : "bg-foreground")} />
                  </span>
                </span>
              );
            })}
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[12px] tabular-nums text-muted-foreground">
            {axis.map((a, i) => <span key={i}>{a}</span>)}
          </div>
          {view === "all" && (
            <div className="mt-2 flex gap-4 text-[11.5px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-foreground" />Conversations</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-[#E0560B]" />AI work</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function money(amount: number, currency: string) {
  const v = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${v}` : `${v} ${currency}`;
}

export function ApiUsage({
  state, invoices, creditDaily, token, workspaceId, action, onPortal, onSubscribe, onBackfillStarted,
}: {
  state: ApiUsageState;
  invoices: ApiInvoice[];
  creditDaily: DayCredits[] | null;
  token: string;
  workspaceId: string;
  action: string | null;
  onPortal: () => void;
  onSubscribe: (credits: number) => void;
  onBackfillStarted: () => void;
}) {
  const [picking, setPicking] = useState(false);


  const ai = state.aiCredits ?? null;
  // The Custom plan reads the same page (GET-660): its quote stands where the API plan's bundle
  // does, and the next move is a conversation, not a credits picker. Pricing logic is unchanged.
  const custom = !isApiTier(state.plan);
  const cp = state.customPlan ?? null;
  const apiLine = planLine(state, SELF_SERVE_TIERS);
  const line = custom
    ? {
        name: state.planName || "Custom plan",
        price: cp?.priceUsd != null ? `$${cp.priceUsd.toLocaleString()} a month` : "Quoted",
        renews: apiLine.renews,
        credits: ai?.included != null && ai.included > 0 ? ai.included : cp?.credits ?? null,
      }
    : apiLine;
  const included = line.credits;
  const used = ai?.used ?? 0;
  const pct = included ? Math.round((used / included) * 100) : 0;
  const next = ai?.nextTier ?? null;
  const hasStripe = !!state.stripe?.customer;
  const backfill = ai?.backfill ?? null;
  const busy = (credits: number) => action === `subscribe:api:${credits}`;
  const resetDay = ai?.periodEnd ? day(ai.periodEnd) : state.subscription?.current_period_end ? day(state.subscription.current_period_end) : null;
  const overLimit = ai?.state === "over" || ai?.state === "restricted";
  // From the sidebar's "Upgrade needed" (GET-733): open on the bundles, nothing bought until a click.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("upgrade") === "1") setPicking(true);
  }, []);

  const picker = (
    <Popover open={picking} onOpenChange={setPicking}>
      <PopoverTrigger asChild>
        {ai?.needsPlan ? (
          <Button size="sm">{ai.notLiveReason === "canceled" ? "Pick a plan" : "Choose a plan"}</Button>
        ) : (
          <button type="button" className="text-[12px] text-muted-foreground underline-offset-2 transition-colors duration-fast hover:text-foreground hover:underline">
            Change credits
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1.5">
        {SELF_SERVE_TIERS.map((b) => {
          const current = !ai?.needsPlan && b.credits === included;
          return (
            <button key={b.credits} type="button" disabled={!!action || current}
              onClick={() => { onSubscribe(b.credits); }}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[12.5px] tabular-nums transition-colors duration-fast",
                current ? "text-foreground" : "text-ink-2 hover:bg-hover hover:text-foreground",
                "disabled:cursor-default",
              )}>
              <span>{num(b.credits)} credits</span>
              <span className="text-muted-foreground">{busy(b.credits) ? "…" : current ? "Current" : `$${b.priceUsd}`}</span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );

  // What the credits meter says under its bar: the plain line, or the state that needs acting on.
  const notice = ai?.needsPlan ? (
    ai.notLiveReason === "payment_failed" ? (
      <span className="text-[11.5px] text-risk">Your last payment didn't go through, so reading has stopped. Update your card in Stripe.</span>
    ) : (
      <span className="text-[11.5px] text-foreground">
        {ai.notLiveReason === "canceled" ? "Your subscription has ended, so reading has stopped." : "Choose a plan to start reading."}
      </span>
    )
  ) : ai?.paymentFailed ? (
    <span className="text-[11.5px] text-risk">
      Your last payment didn't go through. Reading continues{ai.graceUntil ? ` until ${day(ai.graceUntil)}` : ""}; update your card in Stripe to keep it running.
    </span>
  ) : ai?.state === "restricted" ? (
    <span className="text-[11.5px] text-risk">
      You're at {pct}%. Reading has paused until {resetDay ?? "your next period"}. Upgrade to keep reading now.
    </span>
  ) : ai?.state === "over" ? (
    <span className="text-[11.5px] text-risk">
      You're at {pct}%. Everything keeps running until 120%
      {ai.daysUntilStop != null ? <>, about <span className="font-medium">{ai.daysUntilStop === 0 ? "today" : `${ai.daysUntilStop} day${ai.daysUntilStop === 1 ? "" : "s"}`}</span> at this pace</> : null}
      , then reading pauses until {resetDay ?? "your next period"}.
    </span>
  ) : ai?.state === "warn" ? (
    <span className="text-[11.5px] text-warning">You're at {pct}% of this month's credits.</span>
  ) : custom ? (
    <span className="text-[11.5px] text-muted-foreground">
      {included == null && "No limit. "}One credit is one conversation read: an email thread, a call, or 10 minutes of a meeting.
    </span>
  ) : (
    <span className="text-[11.5px] text-muted-foreground">Reads and API calls are free. Credits are spent when Nous processes a conversation.</span>
  );

  const includes = custom ? (cp?.basics ?? []) : [
    included != null ? `${num(included)} credits a month` : null,
    "Unlimited API reads",
    "Unlimited seats",
  ].filter(Boolean) as string[];
  // Custom: what was built for this account, under its own label.
  const builtForYou = custom ? (cp?.custom ?? []) : [];

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 p-4 sm:p-5">
      {/* Offered once: a workspace whose backfill already ran is not asked again (GET-733). */}
      <BackfillCard onStarted={onBackfillStarted} hideIfRan />

      {/* The plan: name, price, renewal and the way to change it; what it includes beside it. */}
      <section className={cn(card, "flex flex-wrap")}>
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1.5 px-5 py-[18px]">
          <span className="text-[12px] text-muted-foreground">Your plan</span>
          <span className="text-[20px] font-medium tracking-[-0.02em] text-foreground">
            {line.name}
            {line.price && <span className="font-normal text-muted-foreground"> · {line.price}</span>}
          </span>
          {!ai?.needsPlan && (line.renews || !custom) && (
            <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
              {line.renews && <span>{line.renews}</span>}
              {line.renews && !custom && <span aria-hidden>·</span>}
              {!custom && picker}
            </span>
          )}
          <span className="mt-2.5 flex flex-wrap gap-2">
            {hasStripe && (
              <Button variant="outline" size="sm" onClick={onPortal} disabled={!!action}>
                {action === "portal" ? "Opening…" : (
                  <>{ai?.notLiveReason === "payment_failed" || ai?.paymentFailed ? "Update payment method" : "Manage subscription in Stripe"}
                    <ArrowUpRight className="!size-3 text-muted-foreground" /></>
                )}
              </Button>
            )}
            {ai?.needsPlan && !custom && picker}
            {!custom && !ai?.needsPlan && next && (ai?.state === "over" || ai?.state === "restricted") && (
              <Button size="sm" onClick={() => onSubscribe(next.credits)} disabled={!!action}>
                {busy(next.credits) ? "Opening…" : `Move to ${num(next.credits)} credits · $${next.priceUsd}`}
              </Button>
            )}
            <Button variant={custom ? "outline" : "ghost"} size="sm" asChild>
              <a href={CONTACT_URL} target="_blank" rel="noreferrer">{custom ? "Talk to us" : "Talk to us about volume"}</a>
            </Button>
          </span>
          {custom && !hasStripe && (
            <span className="mt-1 text-[11.5px] text-muted-foreground/70">Billed by invoice. We'll send each one to your billing contact.</span>
          )}
        </div>
        {(includes.length > 0 || builtForYou.length > 0) && (
        <div className="grid flex-[1_1_280px] grid-cols-2 content-center gap-x-4 gap-y-2.5 border-t border-hairline bg-hover px-5 py-[18px] sm:border-l sm:border-t-0">
          {includes.map((t) => (
            <span key={t} className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <Check className="h-3.5 w-3.5 flex-shrink-0 text-foreground" strokeWidth={1.7} />{t}
            </span>
          ))}
          {builtForYou.length > 0 && (
            <span className="col-span-2 pt-1 text-[11.5px] text-muted-foreground/70">{cp?.customLabel ?? "Custom integrations"}</span>
          )}
          {builtForYou.map((t) => (
            <span key={`c-${t}`} className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <Check className="h-3.5 w-3.5 flex-shrink-0 text-foreground" strokeWidth={1.7} />{t}
            </span>
          ))}
        </div>
        )}
      </section>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))]">
        <Stat label="Credits" used={used} of={included} tone={overLimit ? "risk" : "ink"}>
          {notice}
        </Stat>
        {backfill && (
          <Stat label="Backfill credits" used={backfill.used} of={backfill.allowance} tone="grey">
            <span className="text-[11.5px] text-muted-foreground">Included in your plan. Not counted against this month.</span>
          </Stat>
        )}
      </div>

      <CreditsChart daily={creditDaily} since={ai?.periodStart ?? null} />

      <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))]">
        {/* No By key: usage is not metered per key (product decision, GET-665). */}

        <section className="min-w-0">
          <h2 className="section-title mb-2">Invoices</h2>
          <div className={cn(card, "overflow-x-auto")}>
            {invoices.length === 0 ? (
              <p className="px-4 py-6 text-[12.5px] text-muted-foreground">No invoices yet.</p>
            ) : (
              <table className="w-full min-w-[300px] border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={cn(th, "text-left")}>Date</th>
                    <th className={cn(th, "hidden text-left sm:table-cell")}>Number</th>
                    <th className={cn(th, "text-right")}>Amount</th>
                    <th className={cn(th, "text-left")}>Status</th>
                    <th className={cn(th, "text-right")}><span className="sr-only">Download</span></th>
                  </tr>
                </thead>
                <tbody className="[&_tr:last-child_td]:border-0">
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      {/* An epoch "now" makes day() always print the year: "1 Oct 2026", as invoices read. */}
                      <td className={cn(td, "tabular-nums")}>{day(i.created, new Date(0))}</td>
                      <td className={cn(td, "hidden tabular-nums text-muted-foreground sm:table-cell")}>{i.number ?? ""}</td>
                      <td className={cn(td, "text-right tabular-nums")}>{money(i.amount, i.currency)}</td>
                      <td className={td}>
                        <span className={cn("text-[12px] font-medium",
                          i.status === "paid" ? "text-positive" : i.status === "open" ? "text-warning" : "text-muted-foreground")}>
                          {i.status === "paid" ? "Paid" : i.status === "open" ? "Due" : i.status.charAt(0).toUpperCase() + i.status.slice(1)}
                        </span>
                      </td>
                      <td className={cn(td, "text-right")}>
                        {(i.pdf || i.url) && (
                          <a href={i.pdf ?? i.url ?? "#"} target="_blank" rel="noreferrer"
                            className="text-[12px] font-medium text-foreground hover:underline">{i.pdf ? "PDF" : "View"}</a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
