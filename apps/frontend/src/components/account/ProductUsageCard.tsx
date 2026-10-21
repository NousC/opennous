// Product usage on the account's Overview (GET-751): what the daily PostHog pull read for this
// account, rolled up from its people's work emails. Active users over 30 days against the 30
// before, who was active this week, when the product last did something for them, and their key
// events. Null until PostHog has written usage for the account, so a CRM-only account shows nothing.
import { ListCard } from "@/components/ui/list";
import { CardHead, Tile } from "@/components/record/OverviewParts";
import { Trend } from "@/components/customers/CrmHealth";
import { day, when } from "@/lib/format";

export type ProductUsage = {
  active_users_30d: number | null;
  active_users_7d: number | null;
  active_users_prev_30d: number | null;
  total_users: number | null;
  usage_30d: number | null;
  usage_prev_30d: number | null;
  last_used_at: string | null;
  key_events: { name: string; count_30d: number; users_30d: number; first_seen: string | null }[];
  updated_at: string | null;
};

const fmt = (n: number | null) => (n == null ? "—" : n.toLocaleString("en-US"));

/** Days since a moment, or null. */
const daysSince = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
};

export function ProductUsageCard({ usage }: { usage: ProductUsage | null | undefined }) {
  if (!usage) return null;
  const active = usage.active_users_30d;
  const change = active != null && usage.active_users_prev_30d != null ? active - usage.active_users_prev_30d : null;
  const quiet = daysSince(usage.last_used_at);
  return (
    <ListCard className="min-w-0">
      <CardHead title="Product usage" right={usage.updated_at ? <span className="text-[12px] text-muted-foreground/60" title="Read from PostHog once a day">PostHog · {when(usage.updated_at)}</span> : null} />
      <div className="grid grid-cols-2 gap-0.5 sm:grid-cols-4">
        <Tile
          label="Active users (30d)"
          empty={active == null}
          value={<>
            {fmt(active)}
            {usage.total_users != null && usage.total_users > 0 && <span className="text-[12px] text-muted-foreground/70"> of {fmt(usage.total_users)}</span>}
            {change != null && <span className="ml-1.5 text-[11.5px] font-medium" title="Against the 30 days before"><Trend v={change} /></span>}
          </>}
        />
        <Tile label="Active this week" value={fmt(usage.active_users_7d)} empty={usage.active_users_7d == null} />
        <Tile
          label="Last used"
          value={usage.last_used_at ? day(usage.last_used_at) : "—"}
          empty={!usage.last_used_at}
          sub={quiet != null && quiet >= 14 ? `Quiet for ${quiet} days` : undefined}
          subTone={quiet != null && quiet >= 14 ? "risk" : undefined}
        />
        <Tile
          label="Events (30d)"
          value={fmt(usage.usage_30d)}
          empty={usage.usage_30d == null}
          sub={usage.usage_prev_30d != null ? `${fmt(usage.usage_prev_30d)} the 30 days before` : undefined}
        />
      </div>
      {usage.key_events.length > 0 && (
        <ul className="mt-1 divide-y divide-border/60 px-2 pb-1">
          {usage.key_events.map(k => (
            <li key={k.name} className="flex min-w-0 items-center gap-2 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/85">{k.name}</span>
              <span className="tabular-nums text-muted-foreground/80">
                {k.count_30d > 0 ? `${fmt(k.count_30d)} in 30 days by ${k.users_30d} ${k.users_30d === 1 ? "user" : "users"}` : "Not used in 30 days"}
              </span>
              {k.first_seen && <span className="hidden text-[12px] text-muted-foreground/60 sm:inline">first {day(k.first_seen)}</span>}
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );
}
