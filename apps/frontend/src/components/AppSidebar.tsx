import React, { useState, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { VersionWidget } from "@/components/VersionWidget";
import {
  Activity,
  Users,
  Plug,
  Webhook,
  TrendingUp,
  MessagesSquare,
  ListTodo,
  Sparkles,
  BookOpen,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { NavLink } from "@/components/NavLink";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import type { PlanFeatures } from "@/config/plans";
import { SidebarWorkspaceSelector } from "@/components/SidebarWorkspaceSelector";

// `feature` is the plan flag that has to be on for the item to appear. Omit it and
// the item is always shown. The server enforces the same flags (plans.mjs +
// access.mjs) — hiding a link here is a courtesy, not a security boundary.
type NavItem = {
  title: string;
  url: string;
  icon: React.ElementType;
  feature?: keyof PlanFeatures;
};

// The sidebar has three groups and they are the product, read top to bottom:
//
//   THE WORK       what you do every day. Ask, look, act.
//   CONTEXT        what the agent knows. The model it scores on, the documents it
//                  reads, the procedures it can run.
//   WORKSPACE      is it healthy, is it being used, is it connected. Operational.
//                  You check it; you don't live in it.
//
// Anything you touch once (Install, keys, billing) is not a surface. It lives in
// Settings, behind the profile row.

// THE WORK — Threads is first because for a team with no agent of their own it IS
// the interface: they do not browse, they ask. Skills sits with them rather than under
// Context, because a skill is a thing the agent DOES, not a thing it knows.
const workNavItems: NavItem[] = [
  { title: "Threads",  url: "/",         icon: MessagesSquare, feature: "inAppAgent" },
  { title: "Accounts", url: "/accounts", icon: Users          },
  { title: "Tasks",    url: "/tasks",    icon: ListTodo,       feature: "tasks"      },
  { title: "Skills",   url: "/skills",   icon: Sparkles,       feature: "skills"     },
];

// WORKSPACE — the operational layer. Activities moved down here from the top: it is
// the log of what happened, which you check, not a place you work.
//
// Health belongs in this group and does not exist yet. When it does, it goes
// directly under Activities with a red dot when a sync breaks. That dot is the
// product: nobody else tells you your agent has been answering from stale data.
//
// Graph is NOT here: it moved into Accounts as a view toggle, where a rendering of
// the record belongs. The full-screen war-room still exists at /graph, but it is not
// a place you navigate to from the nav — it is what the Graph view expands into.
const workspaceItems: NavItem[] = [
  { title: "Activities",   url: "/activities",   icon: Activity, feature: "activities" },
  { title: "Adoption",     url: "/adoption",     icon: TrendingUp, feature: "adoption" },
  { title: "Integrations", url: "/integrations", icon: Plug       },
  { title: "Webhooks",     url: "/webhooks",     icon: Webhook    },
];

// Bottom — the Vault sits on the floor, the way a vault switcher does in Obsidian.
// It is not a daily surface: you go there to correct what the agents read, and then
// you leave.
//
// Usage & Billing left the sidebar for Settings. Nobody NAVIGATES to billing.
// Install left too — it is reachable from Settings → API Keys → "Installation guide".
const bottomNavItems: NavItem[] = [
  { title: "Vault", url: "/vault", icon: BookOpen },
];

export function AppSidebar() {
  const { userData } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Persist the collapsed state so a page reload keeps the sidebar as the user left it.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("nous.sidebar.collapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("nous.sidebar.collapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
  }, [collapsed]);

  // What this plan can see. `planLoading` matters: until the first response lands
  // we do NOT hide anything, because hiding first and revealing later means a
  // Custom customer watches half their product flicker in on every cold load. Show
  // everything, then settle.
  const { can, loading: planLoading } = usePlan();
  const visible = useCallback(
    (item: NavItem) => planLoading || !item.feature || can(item.feature),
    [planLoading, can],
  );

  // Lead lists / CRM sync / triggers / reports are HEADLESS (2026-07-14): the backends
  // and MCP tools stay live (the AIOS prospecting skills write into lead lists), but they
  // are no longer product surface — no nav item, no page. The whole Lists dropdown, its
  // fetch, and its create/rename/delete handlers used to live here behind a hardwired
  // `false`; removed. See internal/ONBOARDING.md §2.
  // Kept on self-host. There's no bill, but the page still answers "how big is my
  // graph" and explains why it's free (your key, your extraction bill) — and a
  // self-hoster who never sees that never learns what Cloud would actually be
  // buying them.
  const visibleBottomNavItems = bottomNavItems.filter(visible);

  // Threads and Tasks are the agent's surfaces, so they only exist on Custom.
  const visibleWorkNavItems = workNavItems.filter(visible);
  const hasThreads = visible(workNavItems[0]);


  // WORKSPACE — operational. Integrations and Webhooks are ungated (a graph you
  // cannot feed is not a product), Adoption is Custom.
  const visibleWorkspaceItems = workspaceItems.filter(visible);

  const isItemActive = (url: string) => {
    if (url === "/") return location.pathname === "/";
    return location.pathname === url || location.pathname.startsWith(url + "/");
  };

  const renderNavItem = (item: NavItem) => {
    const active = isItemActive(item.url);
    const iconColor = active ? "text-gray-900 dark:text-white" : "text-gray-800 dark:text-white/50";

    return (
      <li key={item.title}>
        <NavLink
          to={item.url}
          end={item.url === "/"}
          className={`group flex w-full items-center rounded-lg px-2.5 py-1.5 transition-all duration-150 ${
            collapsed ? "justify-center" : ""
          } ${active ? "bg-gray-200/60 dark:bg-white/[0.07]" : "hover:bg-gray-100/70 dark:hover:bg-white/[0.04]"}`}
          activeClassName=""
        >
          <div className="flex items-center gap-3">
            <item.icon
              className={`h-[17px] w-[17px] flex-shrink-0 transition-colors ${iconColor}`}
              strokeWidth={active ? 2 : 1.75}
            />
            {!collapsed && (
              <span
                className={`text-[13px] leading-tight truncate transition-colors ${
                  active
                    ? "text-gray-900 dark:text-white font-semibold"
                    : "text-gray-700 dark:text-white/50 group-hover:text-gray-900 dark:group-hover:text-white"
                }`}
              >
                {item.title}
              </span>
            )}
          </div>
        </NavLink>
      </li>
    );
  };

  return (
    <aside
      className={`flex-shrink-0 h-screen flex flex-col bg-[#FCFCFC] dark:bg-[#0d0d0d] border-r border-gray-200/60 dark:border-white/[0.08] overflow-hidden transition-all duration-200 ${
        collapsed ? "w-[60px]" : "w-[260px]"
      }`}
    >
      {/* Header: Workspace + collapse toggle */}
      <div className={collapsed ? "flex flex-col items-center gap-1.5 px-2 pt-3 pb-2" : "flex items-center gap-2 px-3 pt-3 pb-2"}>
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="p-1.5 rounded-md text-gray-400 dark:text-muted-foreground hover:text-gray-600 dark:hover:text-foreground hover:bg-gray-100/70 dark:hover:bg-white/[0.05] transition-colors"
            title="Expand sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}
        <div className={collapsed ? "" : "flex-1 min-w-0"}>
          <SidebarWorkspaceSelector collapsed={collapsed} />
        </div>
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="p-1.5 rounded-md text-gray-400 dark:text-muted-foreground hover:text-gray-600 dark:hover:text-foreground hover:bg-gray-100/70 dark:hover:bg-white/[0.05] transition-colors flex-shrink-0"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* THE WORK — Threads first. For a team with no agent of their own it IS the
          interface: they do not browse, they ask. Setup is gone from here entirely;
          connecting a tool is something you do once, not a surface you live in. */}
      <nav className="px-2.5 pt-4">
        <ul className="flex flex-col gap-0.5">
          {/* Threads — a plain nav item now. The recent-conversations list moved OUT of
              the sidebar and INTO the Threads page itself, as a collapsible inner panel
              (the Vault pattern): the list belongs next to the thing it opens, not in the
              global nav where it competed with every other destination. Custom-only —
              Threads IS the in-app agent, the surface that runs on our Sonnet bill. */}
          {hasThreads && renderNavItem(workNavItems[0])}

          {/* Accounts always. Tasks only with the agent — a task list the agent
              cannot work is just a to-do app. */}
          {visibleWorkNavItems.filter((i) => i.url !== "/").map(renderNavItem)}

        </ul>
      </nav>

      {/* Spacer — pushes the operational layer + Vault to the floor */}
      <div className="flex-1" />

      {/* Self-host version / update status (only renders when self_hosted) */}
      <VersionWidget collapsed={collapsed} />

      {/* WORKSPACE — the operational layer, docked at the bottom just above the Vault.
          Is it healthy, is it being used, is it connected. You check these; you don't
          live in them, so they sit out of the daily flow, at the floor. */}
      {visibleWorkspaceItems.length > 0 && (
        <nav className="px-2.5 pb-1">
          {!collapsed && (
            <div className="px-2.5 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-white/30">
                Workspace
              </span>
            </div>
          )}
          <ul className="flex flex-col gap-0.5 mt-0.5">
            {visibleWorkspaceItems.map(renderNavItem)}
          </ul>
        </nav>
      )}

      {/* Bottom: the Vault sits on the floor, directly below the operational layer. */}
      <nav className="px-2.5 pb-1">
        <ul className="flex flex-col gap-0.5">
          {visibleBottomNavItems.map(renderNavItem)}
        </ul>
      </nav>

      {/* Profile row */}
      <div className="px-2.5 pb-3 pt-1">
        <div className="mx-1.5 mb-2 border-t border-gray-200/60 dark:border-white/[0.08]" />
        <button
          onClick={() => navigate("/settings")}
          className={`group flex w-full items-center rounded-lg px-2.5 py-2 transition-all duration-150 hover:bg-gray-100/70 dark:hover:bg-white/8 ${
            collapsed ? "justify-center" : "gap-2.5"
          }`}
        >
          <Avatar className="h-6 w-6 flex-shrink-0 border border-gray-200/60 dark:border-white/10">
            <AvatarImage src={userData?.user?.profile_picture_url || undefined} alt={userData?.user?.name || "User"} />
            <AvatarFallback className="text-[10px] font-semibold bg-gray-900 text-white">
              {((userData?.user?.name || userData?.user?.email || "U").charAt(0)).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <span className="text-[13px] text-gray-700 dark:text-white/50 group-hover:text-gray-900 dark:group-hover:text-white truncate leading-tight transition-colors">
              {userData?.user?.name || userData?.user?.email?.split("@")[0] || "Account"}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
