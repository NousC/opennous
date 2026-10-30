// The app's top bar (GET-598, interface refresh): one 48px bar above every standard page,
// breadcrumb on the left, Priorities and (on Cloud) Ask Nous on the right. The breadcrumb comes from the
// route; a page that knows better (an account's name, a deal's name) passes its own with
// useTopBarCrumbs, and it is cleared when that page unmounts.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  Activity, BarChart3, Brain, Building2, Columns3, GraduationCap, HeartHandshake, Inbox, ListChecks,
  Home as HomeIcon, KeyRound, Lightbulb, MessageCircle, Network, Plug, Radio, Webhook, Zap, UserRound, Trophy,
} from "lucide-react";
import { PageTopBar, type Crumb } from "@/components/ui/page-top-bar";
import { PrioritiesButton } from "@/components/shell/PrioritiesButton";
import { isApiTier } from "@/config/plans";
import { apiTopBarRoute } from "@/components/shell/ApiTopBar";
import { usePlan } from "@/hooks/usePlan";
import { cloud } from "@/lib/cloud";
import { railTintFor } from "@/components/shell/rail";
import { useDealPages } from "@/hooks/useDealPages";

type Override = { crumbs: Crumb[] } | null;
const TopBarContext = createContext<{
  override: Override; set: (o: Override) => void;
  /** The spot right after the breadcrumb, for a page to portal into (the record navigator). */
  slot: HTMLElement | null; setSlot: (el: HTMLElement | null) => void;
} | null>(null);

export function TopBarProvider({ children }: { children: ReactNode }) {
  const [override, set] = useState<Override>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ override, set, slot, setSlot }), [override, slot]);
  return <TopBarContext.Provider value={value}>{children}</TopBarContext.Provider>;
}

/** The element right after the breadcrumb, for createPortal; null outside the app shell. */
export function useTopBarSlot(): HTMLElement | null {
  return useContext(TopBarContext)?.slot ?? null;
}

/** A page's own breadcrumb, e.g. [{label:"Accounts", href:"/accounts"}, {label: account.name}]. */
export function useTopBarCrumbs(crumbs: Crumb[] | null) {
  const ctx = useContext(TopBarContext);
  const key = JSON.stringify(crumbs?.map((c) => [typeof c.label === "string" ? c.label : "", c.href ?? ""]));
  useEffect(() => {
    if (!ctx || !crumbs) return;
    ctx.set({ crumbs });
    return () => ctx.set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

// Most specific first. The icon is the section's; the label its rail name.
const SECTIONS: { prefix: string; icon: typeof HomeIcon; label: string }[] = [
  { prefix: "/pipeline", icon: Columns3, label: "Pipeline" },
  { prefix: "/customers", icon: HeartHandshake, label: "Customers" },
  { prefix: "/accounts", icon: Building2, label: "Accounts" },
  { prefix: "/contacts", icon: UserRound, label: "Contacts" },
  { prefix: "/tasks", icon: ListChecks, label: "Tasks" },
  { prefix: "/inbox", icon: Inbox, label: "Inbox" },
  { prefix: "/reporting", icon: BarChart3, label: "Reporting" },
  { prefix: "/coaching", icon: GraduationCap, label: "Coaching" },
  { prefix: "/insights", icon: Lightbulb, label: "Insights" },
  { prefix: "/win-loss", icon: Trophy, label: "Win/loss" },
  { prefix: "/rev-plays", icon: Zap, label: "Rev Plays" },
  { prefix: "/activity", icon: Activity, label: "Activity" },
  { prefix: "/graph", icon: Network, label: "Graph" },
  { prefix: "/brain", icon: Brain, label: "Brain" },
  { prefix: "/integrations", icon: Plug, label: "Integrations" },
  // The pages both plans share (GET-660): the API plan's bar names them the same way.
  { prefix: "/company-sources", icon: Plug, label: "Integrations" },
  { prefix: "/events", icon: Radio, label: "Events" },
  { prefix: "/webhooks", icon: Webhook, label: "Webhooks" },
  { prefix: "/keys", icon: KeyRound, label: "API keys" },
  { prefix: "/usage", icon: BarChart3, label: "Usage and billing" },
  { prefix: "/billing", icon: BarChart3, label: "Usage and billing" },
];

export function AppTopBar() {
  const ctx = useContext(TopBarContext);
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const { plan } = usePlan();
  const dealPages = useDealPages();

  const inChat = pathname === "/" && ["thread", "ask", "chat"].some((k) => params.has(k));
  const section = SECTIONS.find((s) => pathname === s.prefix || pathname.startsWith(s.prefix + "/"));
  const Icon = inChat ? MessageCircle : section?.icon ?? HomeIcon;
  const fallback: Crumb[] = inChat
    ? [{ label: "Chats" }]
    : section
      ? pathname === section.prefix
        ? [{ label: section.label }]
        : [{ label: section.label, href: section.prefix }, { label: dealPages && pathname.includes("/deals/") ? "Deal" : "Details" }]
      : [{ label: pathname === "/" ? "Home" : "Nous" }];
  const crumbs = ctx?.override?.crumbs ?? fallback;
  // The API plan's pages draw their own bar (ApiTopBar, GET-621) with the same title; two bars
  // naming the page twice is one too many (polish pass, GET-657). Its other paths keep this one.
  // A Workspace-layer page may draw its own breadcrumb bar on every plan (cloud.shell.ownsTopBar, GET-864).
  const apiBar = (isApiTier(plan) && !!apiTopBarRoute(pathname)) || !!cloud.shell?.ownsTopBar?.(pathname);

  if (apiBar) return null;
  return (
    <PageTopBar
      icon={<Icon className={inChat ? undefined : railTintFor(pathname) ?? undefined} />}
      crumbs={crumbs}
      after={ctx ? <span ref={ctx.setSlot} className="contents" /> : undefined}
      actions={
        <>
          <PrioritiesButton />
          {/* The Workspace layer's actions: Ask Nous, which opens the page agent (GET-754). */}
          {cloud.shell?.topBarActions?.map((Action, i) => <Action key={i} inChat={inChat} />)}
        </>
      }
    />
  );
}
