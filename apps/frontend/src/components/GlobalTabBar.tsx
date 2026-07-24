// The workspace tab strip — one closable tab per open page, above the content.
//
// Route-driven: the URL is the active tab, this bar is the set of open ones. Clicking a
// tab navigates; the current route is auto-added as a tab whenever you land on it, so
// opening any destination (from the sidebar, a link, anywhere) puts it up here. Closing
// the active tab falls back to its neighbour. Full-screen surfaces (/graph, /note, the
// admin pages) render outside this shell, so they never get a tab — by construction.

import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useTabs } from "@/contexts/TabsContext";
import { cn } from "@/lib/utils";

// The tabbable destinations → their tab label. A route not listed here simply doesn't
// open a tab (NotFound, admin CMS, etc.) — it still renders, it just isn't a workspace tab.
const STATIC: Record<string, string> = {
  "/":             "Threads",
  "/accounts":     "Accounts",
  "/tasks":        "Tasks",
  "/skills":       "Skills",
  "/activities":   "Activities",
  "/adoption":     "Adoption",
  "/integrations": "Integrations",
  "/webhooks":     "Webhooks",
  "/icp":          "ICP",
  "/settings":     "Settings",
  "/billing":      "Billing",
  "/usage":        "Usage",
  "/keys":         "API Keys",
  "/inbox":        "Inbox",
};

// Vault docs are routes now, one tab each, so they sit on the same line as the pages.
const VAULT_DOC_TITLES: Record<string, string> = {
  positioning: "Positioning",
  icp:         "ICP",
  voice:       "Voice",
  outreach:    "Messaging",
  model:       "ICP model",
};

function resolveTabTitle(pathname: string): string | null {
  if (STATIC[pathname]) return STATIC[pathname];
  if (pathname.startsWith("/vault/")) {
    const slug = pathname.slice("/vault/".length);
    if (VAULT_DOC_TITLES[slug]) return VAULT_DOC_TITLES[slug];
    // Insight docs route as `insights-<category>` — label the tab with the file name.
    if (slug.startsWith("insights-")) {
      const cat = slug.slice("insights-".length);
      return cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : "Vault";
    }
    return "Vault";
  }
  if (pathname.startsWith("/people/"))    return "Person";
  if (pathname.startsWith("/companies/")) return "Company";
  return null;
}

// One tab, whether it's a workspace route tab or a page-contributed tab. onClose is
// omitted for non-closable tabs (a page's base view).
function Tab({ title, active, onSelect, onClose }: {
  title: string; active: boolean; onSelect: () => void; onClose?: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group relative flex items-center gap-1.5 pl-3 pr-1.5 h-9 min-w-0 max-w-[180px] cursor-pointer select-none border-r border-border/60 text-[12.5px] transition-colors",
        active
          ? "bg-background text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
      )}
      title={title}
    >
      <span className="truncate">{title}</span>
      {onClose && (
        <span
          onClick={e => { e.stopPropagation(); onClose(); }}
          className="ml-0.5 p-0.5 rounded shrink-0 text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted transition-all"
        >
          <X className="h-3 w-3" />
        </span>
      )}
      {active && <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-foreground" />}
    </div>
  );
}

export function GlobalTabBar() {
  const { tabs, openTab, closeTab, pageTabs, pageOwnsPath, pageAction } = useTabs();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Whatever route you're on becomes an open tab. This is what makes every navigation —
  // sidebar, link, programmatic — surface as a tab without each caller knowing about tabs.
  useEffect(() => {
    const title = resolveTabTitle(pathname);
    if (title) openTab(pathname, title);
  }, [pathname, openTab]);

  const closeRouteTab = (path: string) => {
    // Work out the neighbour BEFORE removing, so closing the tab you're on lands you
    // somewhere sensible rather than on a blank route.
    const idx = tabs.findIndex(t => t.path === path);
    const next = tabs[idx + 1] ?? tabs[idx - 1] ?? null;
    closeTab(path);
    // Close the last tab and land on the empty state, not forced back onto a page.
    if (path === pathname) navigate(next ? next.path : "/empty");
  };

  // While a page contributes its own tabs (Accounts' graph + records), hide that page's
  // route tab — the contributed ones stand in for it, on the same line.
  const routeTabs = tabs.filter(t => t.path !== pageOwnsPath);

  if (routeTabs.length === 0 && pageTabs.length === 0 && !pageAction) return null;

  return (
    <div className="flex items-stretch h-9 flex-shrink-0 border-b border-border/70 bg-background">
      <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto">
        {routeTabs.map(t => (
          <Tab
            key={t.path}
            title={t.title}
            active={t.path === pathname}
            onSelect={() => navigate(t.path)}
            onClose={() => closeRouteTab(t.path)}
          />
        ))}
        {pageTabs.map(pt => (
          <Tab
            key={`page:${pt.id}`}
            title={pt.title}
            active={pt.active}
            onSelect={pt.onSelect}
            onClose={pt.onClose}
          />
        ))}
      </div>

      {/* A page's right-aligned action (Accounts' "Graph"), part of the bar, not floating. */}
      {pageAction && (
        <button
          onClick={pageAction.onClick}
          className="flex-shrink-0 flex items-center px-3.5 h-9 border-l border-border/60 text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        >
          {pageAction.label}
        </button>
      )}
    </div>
  );
}
