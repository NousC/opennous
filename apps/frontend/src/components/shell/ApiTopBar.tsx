// The API plan's top bar (GET-621): one bar on every API-plan page.
//
//   left  — the page's icon and title, with its parent as a breadcrumb link when it has one
//   right — Get started (until setup is done) · Filter | Connect agent (no refresh button)
//
// The shell (StandardLayout) renders it for the API plan and wraps the page in the provider, so a
// page only says what is its own:
//
//   useApiTopBar({ title: account.name, parent: { label: "Accounts", href: "/accounts" }, onRefresh: load, refreshing: loading });
//   <ApiTopBarFilter active={n}>…the page's filter rows…</ApiTopBarFilter>
//
// Title, icon and parent default from the route, so most pages pass nothing but their reload.
// A page with no filter still shows the Filter button, disabled, so the bar never shifts between
// pages. A page with no reload of its own refreshes every query on screen.
//
// Outside the provider (every other plan) the hooks are no-ops and ApiTopBarFilter renders
// nothing, so pages can call them unconditionally.

import * as React from "react";
import { createPortal } from "react-dom";
import { Link, matchPath, useLocation } from "react-router-dom";
import {
  Activity, BarChart3, Building2, ChevronDown, Filter, Home as HomeIcon, KeyRound, Plug,
  Pencil, SquareTerminal, Code2, Users2, Webhook, ArrowUpRight, Zap, Network, Radio, Lightbulb } from "lucide-react";
import { InlineEditInput } from "@/components/ui/inline-edit-input";
import { PageTopBar, type Crumb } from "@/components/ui/page-top-bar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DOCS_URL } from "@/config/agentEndpoints";
import { ClientLogo } from "@/components/connect/shared";
import { cn } from "@/lib/utils";
import { railTintFor } from "@/components/shell/rail";
import { ApiTopBarContext, type ConnectKind, type Ctx, type Parent, type Slots } from "./apiTopBarContext";

export { useApiTopBar, useInApiShell, useOpenConnect, type ConnectKind } from "./apiTopBarContext";

// Get started is a whole page's worth of code; the shell loads it when the bar first draws.
const GetStartedButton = React.lazy(() => import("@/pages/GetStarted").then((m) => ({ default: m.GetStartedButton })));
// The Connect agent dialogs load the first time one is asked for.
const ConnectDialogs = React.lazy(() => import("@/components/connect/ConnectDialogs").then((m) => ({ default: m.ConnectDialogs })));

type RouteMeta = { title: string; icon: React.ElementType; parent?: Parent };

const INTEGRATIONS: Parent = { label: "Integrations", href: "/integrations" };

// The API plan's pages, in the order the sidebar lists them. A path not here gets no bar.
const ROUTES: [pattern: string, meta: RouteMeta][] = [
  ["/",                { title: "Home",              icon: HomeIcon }],
  ["/activity",        { title: "Activity",          icon: Activity }],
  ["/inbox", { title: "Inbox", icon: Activity }],
  ["/tasks", { title: "Inbox", icon: Activity }],
  ["/accounts",        { title: "Accounts",          icon: Building2 }],
  ["/accounts/:id",    { title: "Account",           icon: Building2, parent: { label: "Accounts", href: "/accounts" } }],
  ["/events",          { title: "Events",            icon: Radio }],
  // The Workspace layer's page on this plan (GET-973); a build without it never routes here.
  ["/gtm-insights",      { title: "Insights",          icon: Lightbulb }],
  ["/gtm-insights/:key", { title: "Insight",           icon: Lightbulb, parent: { label: "Insights", href: "/gtm-insights" } }],
  ["/contacts",        { title: "Contacts",          icon: Users2 }],
  ["/contacts/:id",    { title: "Contact",           icon: Users2,    parent: { label: "Contacts", href: "/contacts" } }],
  ["/integrations",    { title: "Personal",          icon: Plug,      parent: INTEGRATIONS }],
  ["/company-sources", { title: "Shared",            icon: Users2,    parent: INTEGRATIONS }],
  ["/webhooks",        { title: "Webhooks",          icon: Webhook }],
  ["/keys",            { title: "API keys",          icon: KeyRound }],
  ["/keys/:id",        { title: "Key",               icon: KeyRound,  parent: { label: "API keys", href: "/settings?section=api-keys" } }],
  ["/workflows",     { title: "Workflows",         icon: Zap }],
  ["/workflows/:id", { title: "Workflow",          icon: Zap,       parent: { label: "Workflows", href: "/workflows" } }],
  ["/graph",           { title: "Graph",             icon: Network }],
  ["/usage",           { title: "Usage and billing", icon: BarChart3 }],
  ["/billing",         { title: "Usage and billing", icon: BarChart3 }],
];

/** The bar's defaults for a path, or null when the path is not an API-plan page. */
export function apiTopBarRoute(pathname: string): RouteMeta | null {
  for (const [pattern, meta] of ROUTES) if (matchPath({ path: pattern, end: true }, pathname)) return meta;
  return null;
}

const iconButton =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-ink-2 shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-45";

/**
 * The page's filter, behind the bar's Filter button. `children` is the popover's content;
 * `active` is how many filters are on (shown on the button). Renders nothing outside the shell.
 */
export function ApiTopBarFilter({ active = 0, children, className }: { active?: number; children: React.ReactNode; className?: string }) {
  const ctx = React.useContext(ApiTopBarContext);
  React.useEffect(() => {
    if (!ctx) return;
    ctx.setFilterCount((n) => n + 1);
    return () => ctx.setFilterCount((n) => n - 1);
  }, [ctx]);
  if (!ctx?.filterSlot) return null;
  return createPortal(
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={active ? `Filter, ${active} on` : "Filter"}
          className={cn(iconButton, active > 0 && "w-auto gap-1 px-2 text-foreground")}
        >
          <Filter className="h-3.5 w-3.5" strokeWidth={1.8} />
          {active > 0 && <span className="text-[11px] font-medium tabular-nums">{active}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className={cn("w-60 p-0", className)}>{children}</PopoverContent>
    </Popover>,
    ctx.filterSlot,
  );
}

/** Wraps the API-plan page area. Renders the bar itself when the path is an API-plan page. */
export function ApiTopBarProvider({ children }: { children: React.ReactNode }) {
  const [slots, setSlots] = React.useState<Slots | null>(null);
  const [, setRefresh] = React.useState<(() => void) | null>(null);
  const [filterSlot, setFilterSlot] = React.useState<HTMLElement | null>(null);
  const [filterCount, setFilterCount] = React.useState(0);
  const [connect, setConnect] = React.useState<ConnectKind | null>(null);
  // Mounted from the first open on, so closing animates instead of vanishing.
  const [connectUsed, setConnectUsed] = React.useState(false);
  React.useEffect(() => { if (connect) setConnectUsed(true); }, [connect]);
  const { pathname } = useLocation();
  const route = apiTopBarRoute(pathname);
  const barShown = !!route;
  const ctx = React.useMemo<Ctx>(
    () => ({ setSlots, setRefresh, filterSlot, setFilterCount, openConnect: setConnect, barShown }),
    [filterSlot, barShown],
  );

  return (
    <ApiTopBarContext.Provider value={ctx}>
      {route && (
        <ApiTopBar
          route={route}
          slots={slots}
          hasFilter={filterCount > 0}
          filterSlotRef={setFilterSlot}
          onConnect={setConnect}
        />
      )}
      {children}
      {connectUsed && (
        <React.Suspense fallback={null}>
          <ConnectDialogs open={connect} onClose={() => setConnect(null)} />
        </React.Suspense>
      )}
    </ApiTopBarContext.Provider>
  );
}

function ApiTopBar({ route, slots, hasFilter, filterSlotRef, onConnect }: {
  route: RouteMeta;
  slots: Slots | null;
  hasFilter: boolean;
  filterSlotRef: (el: HTMLElement | null) => void;
  onConnect: (kind: ConnectKind) => void;
}) {
  const { pathname } = useLocation();
  const Icon = route.icon;
  const parent = slots?.parent === null ? null : slots?.parent ?? route.parent ?? null;
  const title = slots?.title || route.title;
  const rename = slots?.rename;
  // A page that lets its title be renamed (a key) gets it edited in place, right in the bar.
  const titleLabel: React.ReactNode = !rename ? title : rename.editing ? (
    <InlineEditInput
      value={title} label="Name" validate={rename.validate} maxLength={80}
      onSave={rename.onSave} onCancel={rename.onCancel}
      className="w-[24vw] sm:w-[280px]"
    />
  ) : (
    <button
      type="button" onClick={rename.onEdit} title="Rename"
      className="group inline-flex max-w-full items-center gap-1.5 rounded-md text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate">{title}</span>
      <Pencil aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" strokeWidth={1.8} />
      <span className="sr-only">Rename</span>
    </button>
  );
  // While the title is being edited the parent crumb steps aside, so the field has the room on a phone.
  const crumbs: Crumb[] = parent && !rename?.editing ? [{ label: parent.label, href: parent.href }, { label: titleLabel }] : [{ label: titleLabel }];

  return (
    <PageTopBar
      className="bg-background pr-3 sm:pr-4"
      icon={<Icon strokeWidth={1.6} className={railTintFor(pathname) ?? undefined} />}
      crumbs={crumbs}
      actions={
        <>
          <React.Suspense fallback={null}><GetStartedButton variant="segments" /></React.Suspense>
          <span ref={filterSlotRef} className="contents" />
          {!hasFilter && (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                {/* A disabled button swallows hover, so the tooltip rides a wrapper. */}
                <span tabIndex={0} className="inline-flex rounded-lg">
                  <button disabled aria-label="Filter" className={iconButton}>
                    <Filter className="h-3.5 w-3.5" strokeWidth={1.8} />
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">Nothing to filter on this page</TooltipContent>
            </Tooltip>
          )}
          <span aria-hidden className="mx-0.5 hidden h-[18px] w-px shrink-0 bg-border sm:block" />
          {/* API keys live in Settings under Account (GET-1030), not up here. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* On a phone it is an icon button, so the page title keeps its room. */}
              <button aria-label="Connect agent"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-foreground bg-foreground px-0 text-[12.5px] font-medium text-background shadow-[0_1px_2px_rgba(20,20,18,0.18)] transition-opacity duration-fast hover:opacity-90 sm:w-auto sm:px-2.5">
                <Plug className="h-3.5 w-3.5 sm:hidden" strokeWidth={1.9} aria-hidden />
                <span className="hidden sm:inline">Connect agent</span>
                <ChevronDown className="hidden h-3.5 w-3.5 opacity-80 sm:block" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-[300px]">
              <ConnectRow icon={SquareTerminal} title="MCP server" hint="Claude Code, Cursor, Codex" logos={["claude", "cursor", "codex"]} onSelect={() => onConnect("mcp")} />
              <ConnectRow icon={Code2} title="REST API" hint="n8n, Zapier, your own code" logos={["n8n", "zapier"]} onSelect={() => onConnect("api")} />
              <DropdownMenuSeparator className="my-1" />
              <DropdownMenuItem asChild className="rounded-lg px-2 py-1.5 text-[12.5px] text-ink-2 focus:bg-hover focus:text-foreground">
                <a href={DOCS_URL} target="_blank" rel="noreferrer" className="flex items-center justify-between">
                  Docs<ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.8} />
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    />
  );
}

function ConnectRow({ icon: Icon, title, hint, logos, onSelect }: { icon: React.ElementType; title: string; hint: string; logos?: string[]; onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2.5 rounded-lg p-2 text-[13px] focus:bg-hover focus:text-foreground">
      <span className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-card text-ink-2 shadow-[inset_0_0_0_1px_hsl(var(--border))]">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-[11.5px] text-muted-foreground">{hint}</span>
      </span>
      {/* The platforms it connects, as their own logos (GET-661). */}
      {logos && (
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          {logos.map((l) => <ClientLogo key={l} id={l} size={14} />)}
        </span>
      )}
    </DropdownMenuItem>
  );
}
