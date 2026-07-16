// Workspace tabs — the set of pages you have open, like browser tabs.
//
// This owns ONE thing: the ordered list of open tabs. It deliberately does NOT own
// which tab is active — the URL does. A tab is just {path, title}; "active" is
// whichever tab's path matches the current location. That keeps every page on a real
// route (route-driven tabs), so a tab is a bookmark you can close, not a second source
// of truth that could disagree with the address bar.
//
// Persisted to localStorage so your open tabs survive a refresh, the same way the
// sidebar's collapsed state does.

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

export type WorkspaceTab = { path: string; title: string };

// A tab contributed by the active page itself, rendered on the same line as the
// workspace tabs. This exists for one reason: pages like Accounts keep several views
// (the graph, open records) MOUNTED at once so switching is instant and the graph never
// rebuilds. Those can't be route-driven without losing that, so the page owns them and
// just hands the bar something to render. `ownsPath` is the workspace tab to hide while
// these are up (the page's own route tab, which these replace).
export type PageTab = {
  id: string;
  title: string;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
};

// A right-aligned action a page can put on the tab bar (e.g. Accounts' "Graph"), so it
// reads as part of the bar rather than floating over the page.
export type PageAction = { label: string; onClick: () => void };

type TabsContextValue = {
  tabs: WorkspaceTab[];
  openTab: (path: string, title: string) => void;
  closeTab: (path: string) => void;
  pageTabs: PageTab[];
  pageOwnsPath: string | null;
  pageAction: PageAction | null;
  setPageTabs: (tabs: PageTab[], ownsPath?: string | null, action?: PageAction | null) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);
const STORAGE_KEY = "nous.tabs.v1";

export function TabsProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<{ tabs: PageTab[]; ownsPath: string | null; action: PageAction | null }>(
    { tabs: [], ownsPath: null, action: null },
  );
  const setPageTabs = useCallback(
    (tabs: PageTab[], ownsPath: string | null = null, action: PageAction | null = null) => {
      setPage({ tabs, ownsPath, action });
    },
    [],
  );

  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(t => t && typeof t.path === "string") : [];
    } catch { return []; }
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs)); } catch { /* ignore */ }
  }, [tabs]);

  // Add the tab if it's new; if it already exists, only refresh a changed title
  // (dynamic pages like a person whose name loaded after the tab opened).
  const openTab = useCallback((path: string, title: string) => {
    setTabs(prev => {
      const existing = prev.find(t => t.path === path);
      if (!existing) return [...prev, { path, title }];
      if (existing.title !== title) return prev.map(t => (t.path === path ? { ...t, title } : t));
      return prev;
    });
  }, []);

  const closeTab = useCallback((path: string) => {
    setTabs(prev => prev.filter(t => t.path !== path));
  }, []);

  return (
    <TabsContext.Provider value={{ tabs, openTab, closeTab, pageTabs: page.tabs, pageOwnsPath: page.ownsPath, pageAction: page.action, setPageTabs }}>
      {children}
    </TabsContext.Provider>
  );
}

export function useTabs() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("useTabs must be used within a TabsProvider");
  return ctx;
}
