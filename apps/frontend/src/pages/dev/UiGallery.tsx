import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, CheckSquare } from "lucide-react";

import { PageToolbar, PageTopBar } from "@/components/ui/page-top-bar";
import { FilterChips, SegmentedControl, ViewTabs, ViewToggle, type Layout } from "@/components/ui/view-tabs";
import { StatStrip } from "@/components/ui/stat-strip";
import { DataTable, type Column } from "@/components/ui/data-table";
import { OwnerFilter, PersonAvatar, type Person } from "@/components/ui/owner-filter";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Truncate } from "@/components/ui/truncate";
import { Button } from "@/components/ui/button";
import { ChangeApproval } from "@/components/approval/ChangeApproval";
import { Freshness } from "@/components/ui/freshness";
import { usePref } from "@/hooks/usePref";
import { optimistic, useOptimisticMutation } from "@/hooks/useOptimisticMutation";
import { due, money, signed, time, when } from "@/lib/format";

// Fixture data for the gallery only (GET-594).
type Deal = { id: string; name: string; account: string; owner: Person; amount: number | null; stage: string; close: string };
const people: Person[] = [
  { id: "bg", name: "Theo Bramwell", count: 12 },
  { id: "mr", name: "Maya Rossi", count: 8 },
  { id: "jk", name: "Jonas Keller", count: 3 },
];
const deals: Deal[] = [
  { id: "1", name: "Platform annual", account: "Kestrel Payments", owner: people[0], amount: 186000, stage: "Negotiation", close: "14 Oct" },
  { id: "2", name: "Expansion for the Lisbon operations team and the new regional office", account: "Northwind Labs", owner: people[1], amount: 94500, stage: "Contract sent", close: "30 Sep" },
  { id: "3", name: "Team plan", account: "Ardent Health", owner: people[2], amount: 68000, stage: "Security review", close: "31 Oct" },
  { id: "4", name: "Starter", account: "Brightline Studio", owner: people[2], amount: null, stage: "Lead", close: "Not set" },
];
const usd = (n: number | null) => (n === null ? "—" : `$${n.toLocaleString("en-US")}`);
const columns: Column<Deal>[] = [
  { key: "deal", header: "Deal", width: "30%", cell: (d) => <Truncate className="font-medium">{d.name}</Truncate> },
  { key: "account", header: "Account", cell: (d) => d.account, footer: "4 deals" },
  {
    key: "owner",
    header: "Owner",
    cell: (d) => (
      <span className="inline-flex items-center gap-2">
        <PersonAvatar person={d.owner} />
        {d.owner.name.split(" ")[0]}
      </span>
    ),
  },
  { key: "amount", header: "Amount", align: "right", cell: (d) => <span className={d.amount ? "font-medium" : "text-muted-foreground"}>{usd(d.amount)}</span>, footer: "$348,500" },
  { key: "stage", header: "Stage", cell: (d) => d.stage },
  { key: "close", header: "Close date", cell: (d) => d.close },
];

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default function UiGallery() {
  const [view, setView] = useState("pipeline");
  const [chip, setChip] = useState("all");
  const [status, setStatus] = useState("open");
  const [layout, setLayout] = usePref<Layout>("gallery.layout", "list", (v): v is Layout => v === "board" || v === "list");
  const [owners, setOwners] = useState<string[]>([]);

  return (
    <div className="min-h-screen bg-frame p-2">
      <main className="overflow-hidden rounded-xl border border-border bg-background shadow-card">
        <PageTopBar
          icon={<Building2 />}
          crumbs={[{ label: "Accounts", href: "/accounts" }, { label: "Pipeline" }]}
          actions={<Button variant="outline" size="sm">Ask Nous</Button>}
        />
        <PageToolbar>
          <ViewTabs
            aria-label="Account views"
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: "All accounts", count: 128 },
              { value: "pipeline", label: "Pipeline", count: 27, swatch: "bg-[#6E7FC4]" },
              { value: "handoff", label: "Handoff", count: 4, swatch: "bg-warning-dot" },
              { value: "customers", label: "Customers", count: 31, swatch: "bg-positive" },
            ]}
          />
          <div className="flex-1" />
          <OwnerFilter people={people} meId="bg" value={owners} onChange={setOwners} unassignedCount={0} />
          <ViewToggle value={layout} onChange={setLayout} />
        </PageToolbar>

        <div className="flex flex-col gap-8 p-6">
          <Block title="StatStrip">
            <StatStrip
              stats={[
                { label: "Monthly recurring revenue", value: "$84,200", delta: { value: "+3.1%" }, note: "vs last month" },
                { label: "Active customers", value: "31", note: "2 added this month" },
                { label: "MRR at risk", value: "$6,900", tone: "risk", note: "3 customers" },
                { label: "Expansion potential", value: "$18,400", note: "5 customers" },
              ]}
            />
            <div className="max-w-[760px]">
              <StatStrip
                compact
                stats={[
                  { label: "Won this week", value: "3", delta: { value: "+1" } },
                  { label: "Open pipeline", value: "$1.42M", note: "27 deals" },
                  { label: "Meetings today", value: "2", note: "next 14:30" },
                  { label: "Needs attention", value: "6", note: "accounts" },
                ]}
              />
            </div>
          </Block>

          <Block title="FilterChips · SegmentedControl">
            <div className="flex flex-wrap items-center gap-4">
              <FilterChips
                aria-label="Stage"
                value={chip}
                onChange={setChip}
                options={[
                  { value: "all", label: "All stages", count: 27 },
                  { value: "lead", label: "Lead", count: 9, swatch: "bg-[#8C96C4]" },
                  { value: "neg", label: "Negotiation", count: 8, swatch: "bg-positive" },
                ]}
              />
              <SegmentedControl
                aria-label="Status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: "open", label: "Open" },
                  { value: "done", label: "Done" },
                ]}
              />
            </div>
          </Block>

          <Block title="DataTable · grouped, with totals">
            <div className="overflow-hidden rounded-xl border border-border">
              <DataTable
                aria-label="Deals"
                columns={columns}
                rowKey={(d) => d.id}
                onRowClick={() => {}}
                keyboard
                groups={[
                  { key: "neg", label: "Negotiation & follow-ups", meta: "2 · $280,500", swatch: "bg-positive", rows: deals.slice(0, 2) },
                  { key: "qual", label: "Qualification", meta: "2 · $68,000", swatch: "bg-warning-dot", rows: deals.slice(2) },
                ]}
              />
            </div>
          </Block>

          <SharedLogic />

          <Block title="ChangeApproval · one way to approve a CRM change">
            <div className="max-w-[640px]">
              <ChangeApproval
                change={{ field: "Close date", record: "Platform annual", from: "14 Oct", to: "31 Oct", reason: "from Maya on today's call" }}
                onApprove={() => new Promise((r) => setTimeout(r, 400))}
                onSkip={() => {}}
                onUndo={() => new Promise((r) => setTimeout(r, 300))}
              />
            </div>
          </Block>

          <div className="grid grid-cols-3 gap-6">
            <Block title="EmptyState">
              <EmptyState
                icon={<CheckSquare />}
                title="Nothing owed"
                body="Promises made on a call show up here once it's transcribed."
                action={<Button variant="outline" size="sm">New task</Button>}
              />
            </Block>
            <Block title="Truncate · hover the cut name">
              <div className="w-[220px] rounded-lg border border-border px-3 py-2">
                <Truncate className="font-medium">Expansion for the Lisbon operations team and the new regional office</Truncate>
              </div>
            </Block>
            <Block title="Skeleton rows">
              <div className="overflow-hidden rounded-xl border border-border">
                <SkeletonRows />
              </div>
            </Block>
          </div>
        </div>
      </main>
    </div>
  );
}

// ── Shared logic (GET-595): optimistic actions with Undo, freshness, formats ──────────────
type DemoTask = { id: string; title: string };
const DEMO_TASKS: DemoTask[] = [
  { id: "t1", title: "Send Maya the annual pricing" },
  { id: "t2", title: "Introduce Tom to our implementation lead" },
  { id: "t3", title: "Send Rina the residency document" },
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function SharedLogic() {
  const [failNext, setFailNext] = useState(false);
  const tasks = useQuery({ queryKey: ["gallery-tasks"], queryFn: async () => DEMO_TASKS, initialData: DEMO_TASKS, staleTime: Infinity });
  const markDone = useOptimisticMutation<DemoTask>({
    mutationFn: async () => {
      await wait(600);
      if (failNext) {
        setFailNext(false);
        throw new Error("demo failure");
      }
    },
    updates: [optimistic<DemoTask[], DemoTask>(["gallery-tasks"], (old, t) => old?.filter((x) => x.id !== t.id))],
    invalidate: [],
    toast: (t) => ({ title: "Marked done", description: t.title }),
    undo: async () => wait(300),
    errorMessage: "Couldn't mark that done",
  });
  const now = Date.now();
  return (
    <Block title="Shared logic · optimistic + Undo, freshness, formats">
      <div className="grid grid-cols-3 gap-6">
        <div className="overflow-hidden rounded-xl border border-border">
          {(tasks.data ?? []).map((t) => (
            <div key={t.id} className="flex h-[42px] items-center gap-2.5 border-b border-hairline px-4 last:border-b-0">
              <span className="flex-1 truncate text-[13px] font-medium">{t.title}</span>
              <Button size="sm" variant="outline" onClick={() => markDone.mutate(t)}>Mark done</Button>
            </div>
          ))}
          <label className="flex h-9 items-center gap-2 bg-hover px-4 text-xs text-muted-foreground">
            <input type="checkbox" checked={failNext} onChange={(e) => setFailNext(e.target.checked)} />
            Fail the next save
          </label>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
          <Freshness at={now - 12 * 60_000} verb="Synced" source="HubSpot" staleAfterMs={86_400_000} />
          <Freshness at={now - 3 * 86_400_000} verb="Synced" source="HubSpot" staleAfterMs={86_400_000} />
          <Freshness at={now - 2 * 3_600_000} verb="Scored" source="your calls" />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-border p-4 text-[12.5px]">
          <dt className="text-muted-foreground">Table money</dt><dd className="tabular-nums">{money(1421500)}</dd>
          <dt className="text-muted-foreground">Stat money</dt><dd className="tabular-nums">{money(1421500, "stat")}</dd>
          <dt className="text-muted-foreground">Change</dt><dd className="tabular-nums">{signed(3.1, { percent: true })}</dd>
          <dt className="text-muted-foreground">Time</dt><dd className="tabular-nums">{time(now)}</dd>
          <dt className="text-muted-foreground">When</dt><dd>{when(now - 26 * 3_600_000)}</dd>
          <dt className="text-muted-foreground">Due</dt><dd>{due(now + 86_400_000)}</dd>
        </dl>
      </div>
    </Block>
  );
}
