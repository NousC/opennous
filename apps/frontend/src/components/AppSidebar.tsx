import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { VersionWidget } from "@/components/VersionWidget";
import {
  Home as HomeIcon,
  Search,
  PanelLeft,
  Network,
  Building2,
  Activity,
  BarChart3,
  Plug,
  Webhook,
  Radio,
  Users2,
  ChevronRight,
  Settings as SettingsIcon,
  KeyRound,
  BookOpen,
  ArrowUpRight,
  Users,
} from "lucide-react";
import { usePref } from "@/hooks/usePref";
import { usePlan } from "@/hooks/usePlan";
import { BackfillPill } from "@/components/BackfillPill";
import { InviteMemberButton } from "@/components/InviteMemberButton";
import { isApiTier, planTier } from "@/config/plans";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/contexts/AuthContext";
import { activeTeam } from "@/lib/activeTeam";
import { SidebarWorkspaceSelector } from "@/components/SidebarWorkspaceSelector";
import { useCredits } from "@/hooks/useCredits";
import { DOCS_URL } from "@/config/agentEndpoints";
import { cloud, type CloudNavItem } from "@/lib/cloud";
import { RAIL_STROKE, railActive, railGroupLabel, railIcon, railIconActive, railIdle, railLabel, railLabelActive, railRow } from "@/components/shell/rail";
import { faviconUrl } from "@/lib/externalImages";

// The sidebar reads top to bottom as one idea: ASK → SPACES → SURFACES.
//   ASK    — Home (the agent front door), Accounts, People. Chat is NOT a nav item:
//            you start a conversation from the composer on Home, and the ones you've
//            already had are listed under RECENTS below Spaces. Two doors to the same
//            room read as two rooms, so there's one.
//   BRAINS — the company's knowledge, one row per brain (GET-431; was SPACES).
//   RECENTS — your last conversations with the agent, straight into /chat.
//   FOOT   — quiet per-person surfaces (Activity · Graph · Reporting · ICP, plus
//            Coaching for SDR/BDR) and the profile row into Settings. Reporting + ICP
//            live here because they are per-person surfaces (Reporting is framed by
//            your role); the Company space keeps the founder's org-wide cut.
// Colours stay deliberately quiet — grey ink on our warm near-white surface — so
// the content, not the chrome, carries the weight. The rail collapses to an icon
// strip via the top-left toggle; the choice sticks per browser.
type NavItem = { title: string; url: string; icon: React.ElementType; end?: boolean; children?: NavItem[] };

// PEOPLE IS NOT A DESTINATION (GET-426). It was a nav row whose list view rendered the
// Accounts page — the only real thing behind it was /people/:id, and you reach a person the
// way you think of one: through the account they work at. A top-level row that opens someone
// else's page is a row that teaches the wrong model of the product.

// Custom (teams) plan — the full in-app experience: Home worklist + conversational agent.
// Accounts is a place you look things up. The rest of this rail — Tasks and Insights after
// Accounts, the Views group (Pipeline, Handoff, Customers) and Reporting at the top of Workspace —
// is the Workspace layer's (cloud.nav, GET-754), so a build without it shows only what it has.
// The workspace rail is split by JOB, not by data type (the market-ready redesign, Oct 2026):
// the places a rep or a CSM spends the day on top, the read on the business under "Team".
const workNavItemsCustom: NavItem[] = [
  { title: "Home",      url: "/",          icon: HomeIcon,   end: true },
  { title: "Accounts",  url: "/accounts",  icon: Building2 },
];

type ViewItem = NavItem & { swatch: string; match: (path: string, view: string | null) => boolean };

/** The Workspace layer's rows for this plan tier, in the sidebar's shape. */
function cloudRows(items: CloudNavItem[] | undefined, tier: string): CloudNavItem[] {
  return (items ?? []).filter((i) => !i.tiers || i.tiers.includes(tier));
}

// The footer's power-user surfaces on the Workspace plan. There is no Workspace group any more and
// no Automations row on either plan (GET-864). /automations still opens
// for old links.
// Workspace plan (GET-872): Activity sits in the footer; Graph, Reporting, Forecast and Insights in a
// collapsible Workspace group under the Workspace layer's groups.
const footerNavItemsWorkspace: NavItem[] = [
  { title: "Activity", url: "/activity", icon: Activity },
  // The Workspace sees the same events the API plan does (GET-942): what happened, and where it is sent.
  { title: "Events", url: "/events", icon: Radio },
];
const workspaceGroupItems: NavItem[] = [
  { title: "Graph", url: "/graph", icon: Network },
];
// Core (plugin) plan — the agent lives in the operator's own coding tool, so there is no
// in-app chat. Sources moved into Settings with every other plan's (GET-426): connecting one
// is something you do at the start and then twice a year, which is a setting, not a rail row.
// Home is the FEED of everything the engine wrote, with the setup checklist on top of it
// until setup is done.
// API plan — the operator brings their own agent, so the app is not where the work
// happens: it is where you see what we connected to and what we read (GET-482). Home is
// the activity ledger, Accounts is the record, and your sources are the two rows that
// change what either of them contains. No inbox, no tasks — those are the app
// doing the work for you, which is the Workspace plan (GET-908).
const workNavItemsApi: NavItem[] = [
  { title: "Home",     url: "/",         icon: HomeIcon, end: true },
  { title: "Accounts", url: "/accounts", icon: Building2 },
  // What happened, as events an engineer can pull or subscribe to (GET-939).
  { title: "Events",   url: "/events",   icon: Radio },
];
// The API plan redesign (GET-620): integrations are a group of their own, the four places that
// change what the record contains or who reads it, with API keys beside the webhooks. Usage and
// billing sits under them on its own. No counts on any row.
const integrationNavItemsApi: NavItem[] = [
  { title: "Personal", url: "/integrations",    icon: Plug },
  { title: "Shared",   url: "/company-sources", icon: Users2 },
  { title: "Webhooks", url: "/webhooks",        icon: Webhook },
  { title: "API keys", url: "/keys",            icon: KeyRound },
];

/** "https://www.acme.example/about" → "acme.example"; null when there's nothing usable. */
function domainOf(website?: string | null): string | null {
  const d = String(website ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
  return d.includes(".") ? d : null;
}

/**
 * The Space row's mark (GET-220): the company's own logo, from the website saved in
 * Admin → General, in the same 17px square the letter badge used. Same source as every
 * other company logo in the app (EntityAvatar). Google answers an unknown domain with a
 * tiny default globe rather than an error, so an image under 32px counts as "no logo" and
 * the orange letter comes back — as it does with no website or a failed load.
 */
function SpaceMark({ letter, domain }: { letter: string; domain: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [domain]);
  const favicon = faviconUrl(domain);
  if (favicon && !failed) {
    return (
      <img
        src={favicon}
        alt=""
        referrerPolicy="no-referrer"
        onLoad={(e) => { if (e.currentTarget.naturalWidth < 32) setFailed(true); }}
        onError={() => setFailed(true)}
        className="h-[17px] w-[17px] flex-shrink-0 rounded-[5px] bg-white object-contain"
      />
    );
  }
  return (
    <span className="flex h-[17px] w-[17px] flex-shrink-0 items-center justify-center rounded-[5px] bg-[#FF5C00] text-[10px] font-bold text-white">{letter}</span>
  );
}
// OpenNous v1 (GET-211): Reporting (/reporting) and Coaching (/coaching) are off the footer.
// Their pages and the extraction feeding them keep running — flip to true to bring one back.

const Recents = cloud.nav?.recents;
const Brains = cloud.nav?.brains;

export function AppSidebar() {
  const { session, userData } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Custom (teams) plan gets the full in-app nav; everyone else is on the Core (plugin)
  // plan — Install + Workflows instead of Home + Chat, and no in-app agent.
  const { plan, selfHosted } = usePlan();
  // Three plans now (GET-480): the API rail is its own shape, Workspace and Custom share
  // the full one.
  const api = isApiTier(plan);
  // Brains (GET-431) are Cloud's, drawn by its BrainsNav (GET-839). Recents are the in-app agent's thread list, so they follow the agent: Custom is the plan
  // where it runs in the app.
  const tier = planTier(plan);
  const showRecents = tier === "custom";
  // The API plan's rail, then the Workspace layer's rows for it (GTM insights, GET-973).
  const workNavItems = api ? [...workNavItemsApi, ...(cloud.nav?.api ?? [])] : workNavItemsCustom;
  // Main rail on the workspace plans: Home, Accounts, then the Workspace layer's Tasks and Insights.
  const mainItems = api ? workNavItems : [...workNavItems, ...cloudRows(cloud.nav?.main, tier)];
  // Workspace (GET-665): on the workspace plan Reporting (the Workspace layer's) leads it; the API
  // plan has no Activity row because Activity is its Home.
  // Workspace footer: Activity and Graph, then Cloud's Reporting and Forecast (they sat in the old Workspace group).
  const footerItemsWorkspace = api ? [] : footerNavItemsWorkspace;
  const workspaceItems = api ? [] : [...workspaceGroupItems, ...cloudRows(cloud.nav?.workspace, tier)];
  const viewNavItems = cloudRows(cloud.nav?.views, tier).filter((v): v is ViewItem => !!v.swatch && !!v.match);
  const showViews = !api && viewNavItems.length > 0;
  // Every plan gets the Workspace section (Activity, Automations, Graph), collapsible; the API plan
  // used to carry two unlabelled icons at the foot instead (product decision, GET-661).
  const viewParam = new URLSearchParams(location.search).get("view");

  // Group folds stick per workspace (usePref, GET-595).
  const [viewsOpen, setViewsOpen] = usePref<boolean>("sidebar.views.open", true, (v): v is boolean => typeof v === "boolean");
  const [integrationsOpen, setIntegrationsOpen] = usePref<boolean>("sidebar.integrations.open", true, (v): v is boolean => typeof v === "boolean");
  const [workspaceOpen, setWorkspaceOpen] = usePref<boolean>("sidebar.workspace.open", true, (v): v is boolean => typeof v === "boolean");
  // API plan: the credits card in the foot, from the same payload the Usage page reads.
  const credits = useCredits(api);

  // A choice you made sticks. With no choice yet, a narrow window starts collapsed: the open rail
  // is 232px, which on a phone leaves the page about a third of the screen.
  const [collapsed, setCollapsed] = useState(() => {
    const narrow = typeof window !== "undefined" && window.innerWidth < 900;
    try {
      const v = localStorage.getItem("nous.sidebar.collapsed");
      return v === null ? narrow : v === "1";
    } catch { return narrow; }
  });
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("nous.sidebar.collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const workspaceName = userData?.workspace?.name || activeTeam(userData)?.name || "General";
  const openSearch = () => window.dispatchEvent(new CustomEvent("open-command-palette"));

  // An open chat lives at "/" too (?thread / ?chat / ?ask); the chat's own row is the active one
  // then, not Home.
  const inChat = location.pathname === "/" && ["thread", "chat", "ask"].some((k) => new URLSearchParams(location.search).has(k));
  const isItemActive = (url: string, end?: boolean) => {
    if (url === "/" && inChat) return false;
    if (end || url === "/") return location.pathname === url;
    return location.pathname === url || location.pathname.startsWith(url + "/");
  };

  // ── Item shells: the ⌘K palette's row language (GET-658, polish round 2; shell/rail.ts). The
  //    rail sits on the warm grey frame; the active row is one flat soft band, the way the palette
  //    marks its highlighted result, with no ring, shadow or bolding. Labels in full ink, icons a
  //    step quieter. Collapsed drops the label and rides a tooltip. ──
  const rowBase = railRow;
  const rowPad = collapsed ? "justify-center px-0 py-[7px]" : "gap-2.5 px-2 py-[6px]";
  const idleBg = railIdle;
  const activeBg = railActive;
  const iconIdle = railIcon;
  const iconActive = railIconActive;
  const labelIdle = railLabel;
  const labelActive = railLabelActive;

  const withTip = (node: React.ReactNode, label: string) =>
    collapsed ? (
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
      </Tooltip>
    ) : node;

  const renderOpenItem = (item: NavItem, activeOverride?: boolean, lead?: React.ReactNode) => {
    const active = activeOverride ?? isItemActive(item.url, item.end);
    return (
      <li key={item.title}>
        {withTip(
          <NavLink
            to={item.url}
            end={item.end || item.url === "/"}
            className={`${rowBase} ${rowPad} ${active ? activeBg : idleBg}`}
            activeClassName=""
          >
            {lead && !collapsed ? lead : (
              <item.icon className={`h-[15px] w-[15px] flex-shrink-0 transition-colors ${active ? iconActive : iconIdle}`} strokeWidth={RAIL_STROKE} />
            )}
            <span className={`truncate text-[13px] leading-tight transition-all duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${collapsed ? "w-0 opacity-0" : "opacity-100"} ${active ? labelActive : labelIdle}`}>{item.title}</span>
          </NavLink>,
          item.title
        )}
        {item.children && !collapsed && (active || item.children.some((c) => isItemActive(c.url, c.end))) && (
          <ul className="mt-0.5 flex flex-col gap-0.5 pl-[24px]">
            {item.children.map((child) => {
              const ca = isItemActive(child.url, child.end);
              return (
                <li key={child.title}>
                  <NavLink to={child.url} className={`${rowBase} ${rowPad} ${ca ? activeBg : idleBg}`} activeClassName="">
                    <child.icon className={`h-[14px] w-[14px] flex-shrink-0 transition-colors ${ca ? iconActive : iconIdle}`} strokeWidth={RAIL_STROKE} />
                    <span className={`truncate text-[12.5px] leading-tight transition-colors ${ca ? labelActive : labelIdle}`}>{child.title}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  const buttonRow = (opts: {
    icon: React.ElementType; label: string; active: boolean; onClick: () => void; badge?: string;
    /** With `badge`: render this domain's logo in the badge's place, the letter as fallback. */
    badgeDomain?: string | null;
  }) => {
    const { icon: Icon, label, active, onClick, badge, badgeDomain } = opts;
    return withTip(
      <button onClick={onClick} className={`${rowBase} ${rowPad} ${active ? activeBg : idleBg}`}>
        {badge ? (
          <SpaceMark letter={badge} domain={badgeDomain ?? null} />
        ) : (
          <Icon className={`h-[15px] w-[15px] flex-shrink-0 ${active ? iconActive : iconIdle}`} strokeWidth={RAIL_STROKE} />
        )}
        {!collapsed && <span className={`truncate text-[13px] leading-tight ${active ? labelActive : labelIdle}`}>{label}</span>}
      </button>,
      label
    );
  };

  // A group heading. Foldable groups carry a chevron and remember their state; collapsed, the
  // heading becomes a hairline between groups.
  const sectionLabel = (text: string, fold?: { open: boolean; toggle: () => void }, action?: React.ReactNode) =>
    collapsed ? (
      <div className="mx-2 my-2.5 border-t border-border" />
    ) : (
      <div className="group/label flex items-center gap-1 pb-1 pl-2 pr-1 pt-4">
        {fold ? (
          <button
            onClick={fold.toggle}
            aria-expanded={fold.open}
            className={`-ml-1 flex items-center gap-1 rounded px-1 py-0.5 transition-colors duration-fast hover:text-foreground ${railGroupLabel}`}
          >
            {text}
            {/* The chevron shows on hover, and stays while the group is folded so it can be found. */}
            <ChevronRight className={`h-3 w-3 transition-[transform,opacity] duration-fast ${fold.open ? "rotate-90 opacity-0 group-hover/label:opacity-100" : ""}`} strokeWidth={2} />
          </button>
        ) : (
          <span className={railGroupLabel}>{text}</span>
        )}
        <span className="flex-1" />
        {action}
      </div>
    );

  // API plan only: Automations and the Graph stay quiet icons in the foot (its rail has no
  // Workspace group).

  const userName = userData?.user?.name || userData?.user?.email?.split("@")[0] || "Account";
  const userEmail = userData?.user?.email || "";


  return (
    <aside
      // THE WIDTH ANIMATES, slowly and on purpose. It used to jump, which reads as a redraw
      // rather than a move — you cannot tell whether the rail closed or the page reloaded.
      // 420ms on a long ease-out: the curve spends most of its time at the end, so it leaves
      // quickly and SETTLES, which is what makes a slow motion read as weight rather than
      // lag. The labels fade over the first half so they are gone before the edge reaches
      // them, rather than being clipped on the way past.
      className={`flex h-screen flex-shrink-0 flex-col overflow-hidden bg-frame transition-[width] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        collapsed ? "w-[52px]" : "w-[232px]"
      }`}
    >
      {/* Header: workspace switcher + collapse toggle. */}
      <div className={`flex items-center px-2.5 pb-1 pt-2.5 ${collapsed ? "flex-col gap-1.5" : "gap-1"}`}>
        {!collapsed && <div className="min-w-0 flex-1"><SidebarWorkspaceSelector /></div>}
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${iconIdle} transition-colors duration-fast hover:text-foreground ${idleBg}`}
            >
              <PanelLeft className="h-4 w-4" strokeWidth={RAIL_STROKE} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>{collapsed ? "Expand" : "Collapse"}</TooltipContent>
        </Tooltip>
      </div>
      {collapsed && (
        <div className="flex justify-center px-2 pb-1">
          <SidebarWorkspaceSelector collapsed />
        </div>
      )}

      {/* Search — opens the ⌘K command palette (people, accounts, jump-to). */}
      <div className="px-2.5 pb-1.5 pt-1.5">
        {collapsed ? (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button onClick={openSearch} aria-label="Search"
                className={`mx-auto flex h-8 w-8 items-center justify-center rounded-lg ${iconIdle} transition-colors duration-fast hover:text-foreground ${idleBg}`}>
                <Search className="h-[15px] w-[15px]" strokeWidth={RAIL_STROKE} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>Search</TooltipContent>
          </Tooltip>
        ) : (
          // The palette's own input, closed: no shadow, a quiet glass and placeholder, the key in
          // the same outlined chip as the palette's ESC.
          <button onClick={openSearch}
            className="group flex h-8 w-full items-center gap-2 rounded-lg border border-border/70 bg-card pl-2 pr-1.5 text-left transition-colors duration-fast hover:border-border">
            <Search className="h-[14px] w-[14px] flex-shrink-0 text-muted-foreground/50" strokeWidth={RAIL_STROKE} />
            <span className="flex-1 truncate text-[13px] text-muted-foreground/60">Search</span>
            <kbd aria-hidden className="flex-shrink-0 rounded-md border border-border px-1.5 py-px text-[10.5px] font-medium text-muted-foreground/50">⌘K</kbd>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
        {/* MAIN — the work and the read on the business. */}
        <nav aria-label="Main" className="pt-1">
          <ul className="flex flex-col gap-px">{mainItems.map((i) => renderOpenItem(i))}</ul>
        </nav>

        {/* VIEWS — Pipeline, Handoff, Customers: the lists you live in. */}
        {showViews && sectionLabel("Views", { open: viewsOpen || collapsed, toggle: () => setViewsOpen((o) => !o) })}
        {showViews && (viewsOpen || collapsed) && (
          <ul className="flex flex-col gap-px">
            {viewNavItems.map((v) =>
              renderOpenItem(
                v,
                v.match(location.pathname, viewParam),
                <span className="flex h-4 w-[15px] flex-shrink-0 items-center justify-center">
                  <span className={`h-2 w-2 rounded-[2.5px] shadow-[inset_0_0_0_1px_rgba(20,20,18,0.08)] ${v.swatch}`} />
                </span>,
              ),
            )}
          </ul>
        )}

        {/* API plan — Integrations (personal, shared, webhooks, keys). Usage and billing is in the footer. */}
        {api && sectionLabel("Integrations", { open: integrationsOpen || collapsed, toggle: () => setIntegrationsOpen((o) => !o) })}
        {api && (integrationsOpen || collapsed) && (
          <ul className="flex flex-col gap-px">{integrationNavItemsApi.map((i) => renderOpenItem(i))}</ul>
        )}

        {/* The Workspace layer's groups after the views (cloud.nav.groups); the API plan has none. */}
        {!api && cloud.nav?.groups?.map((Group, i) => (
          <Group key={i} tier={tier} collapsed={collapsed} sectionLabel={sectionLabel} withTip={withTip}
            renderItem={(item) => renderOpenItem(item)} />
        ))}

        {/* WORKSPACE (GET-872): Graph, Reporting, Forecast, Insights, collapsible, under the groups above. */}
        {!api && workspaceItems.length > 0 && sectionLabel("Workspace", { open: workspaceOpen || collapsed, toggle: () => setWorkspaceOpen((o) => !o) })}
        {!api && workspaceItems.length > 0 && (workspaceOpen || collapsed) && (
          <ul className="flex flex-col gap-px">{workspaceItems.map((i) => renderOpenItem(i))}</ul>
        )}

        {/* BRAINS — the company's own knowledge of how it sells (GET-431): Cloud's (GET-839). */}
        {Brains && (
          <Brains tier={tier} sectionLabel={(t) => sectionLabel(t)} buttonRow={buttonRow}
            workspaceName={workspaceName} badgeDomain={domainOf(userData?.workspace?.website)} />
        )}

        {/* CHATS — your conversations with Ask Nous: the Workspace layer's (GET-754). Mounted on the
            workspace plans, shown where the agent runs in the app (Custom). */}
        {/* Hidden for now (GET-872); chats come back once there's a better place for them. */}
        {false && !api && Recents && <Recents show={showRecents} collapsed={collapsed} sectionLabel={sectionLabel} />}
      </div>

      {/* Self-host version / update status (only renders when self_hosted) */}
      <VersionWidget collapsed={collapsed} />

      {/* FOOT — the history import while it runs, invite, then you. */}
      <div className="px-2.5 pb-3 pt-1">
        {/* The backfill, wherever you are (GET-517). Not on the API plan: its progress sits next
            to Get started on Activity (GET-549), and two of the same pill is one too many. */}
        {tier !== "api" && (
          <div className="pb-1.5">
            <BackfillPill collapsed={collapsed} reviewHref="/settings?section=billing" />
          </div>
        )}
        {/* API plan: the month's credits, then the API docs (GET-620). */}
        {api && credits && !collapsed && !selfHosted && (
          // Over the allowance (GET-733): red, and "Upgrade needed" opens Usage on the bundles. No
          // pop-up at sign-in: the card is where it is said, on every page.
          <NavLink
            to={credits.over ? "/usage?upgrade=1" : "/usage"}
            className={`mb-1.5 block rounded-[10px] bg-card px-[11px] pb-[11px] pt-2.5 transition-shadow duration-fast ${credits.over
              ? "shadow-[0_0_0_1px_hsl(var(--risk)/0.45),0_1px_2px_rgba(20,20,18,0.04)] hover:shadow-[0_0_0_1px_hsl(var(--risk)/0.8),0_1px_2px_rgba(20,20,18,0.04)]"
              : "shadow-[0_0_0_1px_hsl(var(--border)),0_1px_2px_rgba(20,20,18,0.04)] hover:shadow-[0_0_0_1px_hsl(var(--foreground)/0.2),0_1px_2px_rgba(20,20,18,0.04)]"}`}
            activeClassName=""
          >
            <span className="flex items-baseline gap-1.5 text-[12px]">
              <span className="flex-1 font-medium text-foreground">Credits</span>
              <span className="tabular-nums">
                <span className={`font-medium ${credits.over ? "text-risk" : "text-foreground"}`}>{credits.used}</span>
                {credits.included && <span className="text-muted-foreground"> / {credits.included}</span>}
              </span>
            </span>
            {credits.included && (
              <span className="mt-[9px] block h-[3px] overflow-hidden rounded-full bg-muted" aria-hidden>
                <span className={`block h-full rounded-full ${credits.over ? "bg-risk" : "bg-foreground"}`} style={{ width: `${credits.pct}%` }} />
              </span>
            )}
            {credits.over ? (
              <span className="mt-[7px] flex items-center justify-between text-[11px]">
                <span className="font-medium text-risk">{credits.stopped ? "Paused · Upgrade needed" : "Upgrade needed"}</span>
                <ArrowUpRight className="h-3 w-3 text-risk" strokeWidth={1.8} />
              </span>
            ) : credits.resets && <span className="mt-[7px] block text-[11px] text-muted-foreground">{credits.resets}</span>}
          </NavLink>
        )}
        {api && withTip(
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className={`${rowBase} ${rowPad} ${idleBg}`}
          >
            <BookOpen className={`h-[15px] w-[15px] flex-shrink-0 ${iconIdle}`} strokeWidth={RAIL_STROKE} />
            {!collapsed && <span className={`flex-1 truncate text-[13px] leading-tight ${labelIdle}`}>API docs</span>}
            {!collapsed && <ArrowUpRight className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" strokeWidth={1.8} />}
          </a>,
          "API docs",
        )}
        {/* Graph, then Usage and billing; no Usage on self-host, where nothing is billed (GET-839). */}
        {/* No Usage and billing row on the API plan (GET-872): the credits meter above opens it. */}
        {api && <ul className="flex flex-col gap-px">{renderOpenItem({ title: "Graph", url: "/graph", icon: Network })}</ul>}
        {/* Workspace plan: Activity, Graph, Reporting and Forecast, where the Workspace group used to be (GET-864). */}
        {!api && footerItemsWorkspace.length > 0 && <ul className="flex flex-col gap-px">{footerItemsWorkspace.map((i) => renderOpenItem(i))}</ul>}
        {/* Invite a member (GET-571) — founders and admins; the member onboards their own sources. */}
        <InviteMemberButton collapsed={collapsed} />
        <div className={`mt-1.5 flex items-center gap-1 border-t border-border/60 pt-1.5 ${collapsed ? "flex-col" : ""}`}>
          {withTip(
            <button
              onClick={() => navigate("/settings")}
              className={`${rowBase} ${collapsed ? "justify-center px-0 py-1.5" : "min-w-0 flex-1 gap-[9px] px-1.5 py-1"} ${idleBg}`}
            >
              <Avatar className="h-6 w-6 flex-shrink-0 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]">
                <AvatarImage src={userData?.user?.profile_picture_url || undefined} alt={userName} />
                <AvatarFallback className="bg-card text-[11px] font-medium text-muted-foreground/80">
                  {userName.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {!collapsed && (
                <span className="flex min-w-0 flex-col text-left leading-tight">
                  <span className="truncate text-[13px] text-foreground">{userName}</span>
                  {userEmail && <span className="truncate text-[11.5px] text-muted-foreground/60">{userEmail}</span>}
                </span>
              )}
            </button>,
            userName
          )}
          {!collapsed && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => navigate("/settings")}
                  aria-label="Settings"
                  className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors duration-fast ${location.pathname.startsWith("/settings") ? `${activeBg} text-foreground` : `${iconIdle} ${idleBg} hover:text-foreground`}`}
                >
                  <SettingsIcon className="h-4 w-4" strokeWidth={RAIL_STROKE} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>Settings</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </aside>
  );
}
