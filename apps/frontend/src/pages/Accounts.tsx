// Accounts — the record, and everything you have open on it.
//
// Shaped like the Vault, on purpose. The Vault opens documents as tabs you can close;
// Accounts opens the graph and individual records the same way. One gesture across the
// product: a thing you want to look at becomes a tab, and closing it puts you back.
//
// Why this and not a detail drawer or a route change:
//
//   Clicking an account in the graph used to mean LEAVING the graph. So you could not
//   compare two accounts, and you could not keep the picture while you read one. Tabs
//   fix both — open three people beside the graph, flick between them, close them, and
//   the graph is still sitting there settled, not rebuilt.
//
// The base tab is PEOPLE. An account is a person you are selling to: they hold the email,
// the title, the reply, the meeting. A company is context around a person, which is why
// it lives in a column and a detail panel rather than being the row.
import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import People from "./People";
import Galaxy from "./Galaxy";
import { cn } from "@/lib/utils";
import { useTabs, type PageTab } from "@/contexts/TabsContext";

// One record, opened as a tab. Whether you clicked a row or a dot on the graph, you get
// the same account — Overview first, then every channel. Two views of the same person
// would only ever drift apart.
type Rec = { id: string; name: string };

export default function Accounts() {
  const [params, setParams] = useSearchParams();
  const { setPageTabs } = useTabs();
  // The graph tab lives in the URL, so one you were looking at survives a refresh and can
  // be shared. The record tabs are session state: they are a workspace, not a location.
  const graphOpen = params.get("graph") === "1";
  const [recs, setRecs] = useState<Rec[]>([]);
  const [active, setActive] = useState<string>("accounts");   // "accounts" | "graph" | rec id

  const setGraph = (open: boolean) => {
    const p = new URLSearchParams(params);
    if (open) p.set("graph", "1"); else p.delete("graph");
    setParams(p, { replace: true });
    setActive(open ? "graph" : "accounts");
  };

  const openRec = (r: Rec) => {
    if (!r.id) return;
    setRecs(cur => (cur.some(x => x.id === r.id) ? cur : [...cur, r]));
    setActive(r.id);
  };

  const closeRec = (id: string) => {
    setRecs(cur => cur.filter(x => x.id !== id));
    // Fall back to whatever is still open, preferring the graph you were working from.
    setActive(a => (a !== id ? a : (graphOpen ? "graph" : "accounts")));
  };

  // Only people open as a record. Clicking a company or a shared claim in the graph is a
  // navigation gesture, not "show me this account", and opening a company record here
  // would just be the table again.
  const onGraphOpen = (n: { i: string; l: string | null; t: number }) => {
    if (n.t !== 0) return;
    openRec({ id: n.i, name: n.l || "Account" });
  };

  // Accounts' views ride the WORKSPACE tab bar now, on the same line as every other tab —
  // no second row. They stay page-owned (not routes) because the panes below are
  // keep-alive: the graph and the open records are all mounted at once so switching is
  // instant and the graph never rebuilds. Route-driving them would throw that away.
  //
  // The graph is NOT a tab until you open it — it lives as a control in the top right, and
  // only becomes a tab (mounted, keep-alive) once you click it.
  useEffect(() => {
    const pts: PageTab[] = [
      { id: "accounts", title: "Accounts", active: active === "accounts", onSelect: () => setActive("accounts") },
      ...(graphOpen ? [{
        id: "graph", title: "Graph", active: active === "graph",
        onSelect: () => setActive("graph"), onClose: () => setGraph(false),
      }] : []),
      ...recs.map(r => ({
        id: r.id, title: r.name, active: active === r.id,
        onSelect: () => setActive(r.id), onClose: () => closeRec(r.id),
      })),
    ];
    // The graph lives as a right-aligned action on the tab bar until you open it; then it
    // becomes a tab (mounted, keep-alive) and the action goes away.
    const action = graphOpen ? null : { label: "Graph", onClick: () => setGraph(true) };
    setPageTabs(pts, "/accounts", action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, recs, graphOpen]);

  // Clear our tabs off the bar when we leave the page.
  useEffect(() => () => setPageTabs([], null), [setPageTabs]);

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Everything open stays MOUNTED and is hidden, not unmounted. The engine warms a
          simulation and settles it; rebuilding that every time you glance at a record
          would make the graph feel like it reloads on every click. Same for the records:
          flicking between two accounts should be instant, because you opened them to
          compare them. */}
      <div className="flex-1 min-h-0 relative">
        <Pane on={active === "accounts"}>
          <People embedded onOpen={openRec} />
        </Pane>

        {graphOpen && (
          <Pane on={active === "graph"}>
            <Galaxy embedded onOpen={onGraphOpen} />
          </Pane>
        )}

        {recs.map(r => (
          <Pane key={r.id} on={active === r.id}>
            <People embedded focusId={r.id} />
          </Pane>
        ))}
      </div>
    </div>
  );
}

function Pane({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("absolute inset-0", on ? "" : "invisible pointer-events-none")}>
      {children}
    </div>
  );
}
