// Six small numbers a CS rep opens a customer for, in the Overview's own tiles (two rows of three,
// like the row above them). Every one comes from the CRM except the two names; the tile's tooltip
// says so. A field the CRM does not hold yet reads "—", never a guess.
//
// Renewal is the end of a committed subscription term (cs.renewal_date); a customer billed month to
// month has none and reads "Monthly" (cs.term_months 1). The active-users change is ours, today
// against our snapshot from about 30 days ago, and shows only when the payload carries it
// (cs.active_users_trend): no history, no arrow.
import type { ReactNode } from "react";
import { Trend } from "@/components/customers/CrmHealth";
import { Tile, TileStrip } from "@/components/record/OverviewParts";
import { crmName } from "@/lib/crm";
import { num, type CsBag } from "@/components/account/parts";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const longDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const civil = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  // A civil date is a calendar day; parsed as UTC it renders a day early west of Greenwich.
  const d = civil ? new Date(+civil[1], +civil[2] - 1, +civil[3]) : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export function CustomerStrip({ cs, customerSince, ae }: {
  cs: CsBag | null;
  /** The earliest won deal's close date, when the deals are loaded. */
  customerSince: string | null;
  ae: string | null;
}) {
  const mrr = num(cs?.mrr);
  const users = num(cs?.active_users_30d);
  const total = num(cs?.total_users);
  const trend = num(cs?.active_users_trend);
  const renewal = longDate(typeof cs?.renewal_date === "string" ? cs.renewal_date : null);
  const monthly = !renewal && num(cs?.term_months) === 1;
  const tiles: { label: string; value: ReactNode; crm: boolean }[] = [
    { label: "MRR", value: mrr != null ? usd(mrr) : "—", crm: true },
    { label: "Renewal", value: renewal ?? (monthly ? "Monthly" : "—"), crm: true },
    { label: "Customer since", value: longDate(customerSince) ?? "—", crm: true },
    {
      label: "Active users (30d)",
      value: users != null ? (
        <>
          {users.toLocaleString("en-US")}
          {total != null && total > 0 && <span className="text-[12px] text-muted-foreground/70"> of {total.toLocaleString("en-US")}</span>}
          {trend != null && <span className="ml-1.5 text-[11.5px] font-medium" title="Change against about 30 days ago"><Trend v={trend} /></span>}
        </>
      ) : "—",
      crm: true,
    },
    { label: "CS owner", value: (cs?.owner_name as string | null | undefined) || "—", crm: false },
    { label: "AE", value: ae || "—", crm: false },
  ];
  const from = `From ${crmName()}`;
  return (
    <TileStrip className="grid-cols-2">
      {tiles.map(t => (
        <Tile key={t.label} label={t.label} value={t.value} empty={t.value === "—"} title={t.crm ? from : undefined} />
      ))}
    </TileStrip>
  );
}
