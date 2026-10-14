// The settings rail, as data (GET-625). Pure on purpose: no React, no icons, no aliases
// into the app, so the plan rules can be pinned by a plain `node --test`.
//
// Order here IS the order shown, grouped by `group`. A row with `show: false` is dropped from
// the list entirely, so it is not reachable either: resolveSection only accepts ids in this list,
// and a ?section= link to a hidden one (models, changes, spend, adoption, categories, config) lands
// on Account. Only a caller that mounts <Settings forceSection=…> bypasses that. Flip `show` to
// bring a section back.

export type SettingsGroup = "Account" | "Connections" | "Agent" | "Workspace" | "Analytics" | "Agents" | "Data" | "Support";

export interface SettingsNavItem {
  /** The `?section=` id. */
  id: string;
  label: string;
  group: SettingsGroup;
  /** When set, the row leaves Settings for this path instead of switching section. */
  href?: string;
  /** Routable but not in the rail: its page is reached from the sidebar, and old links still land. */
  unlisted?: boolean;
}

export interface SettingsNavInput {
  /** planTier(): the API plan, or Custom (the in-app one). */
  tier: "api" | "custom";
  /** Founder, or an owner/admin of the workspace. */
  isWorkspaceAdmin: boolean;
  /** The operator account — the only one that sees the Workspace layer's Admin row. */
  isOwner: boolean;
  /** A self-hosted install: its owner/admins get Instance setup (GET-837). */
  selfHosted?: boolean;
  /** The workspace has RevBoxes (API and Workspace plans, GET-864): Context and Signals show. */
  revboxes?: boolean;
}

export const GROUP_ORDER: SettingsGroup[] = ["Account", "Connections", "Agent", "Workspace", "Analytics", "Agents", "Data", "Support"];

type Row = SettingsNavItem & { show?: boolean };

/** A row added from outside (the Workspace layer's, lib/cloud.ts): placed before the row `before`,
 *  or at the end of its group; `show` decides per viewer, absent = shown. */
export type ExtraSettingsRow = SettingsNavItem & { before?: string; show?: (input: SettingsNavInput) => boolean };

export function settingsNav(input: SettingsNavInput, extra: ExtraSettingsRow[] = []): SettingsNavItem[] {
  const { tier, isWorkspaceAdmin } = input;
  // Self-host: the sidebar already holds Integrations, Webhooks and API keys, Repo is a Cloud API
  // plan option, and nothing is billed, so Settings keeps only what lives nowhere else (GET-839).
  const selfHosted = !!input.selfHosted;
  // Core is the API plan (CORE_PLAN_IDS = ['api']).
  const core = tier === "api";
  // Who manages the agent. On API the agent is the operator's own, in their coding tool; on
  // Custom we run it for them. Only a plan where the customer runs the in-app agent themselves
  // gets the Agent group — none of the two sold today, so it stays dark until one does.
  const selfManagedAgent = !core && tier !== "custom";
  const rows: Row[] = [
    // Account — who you are, what you hear about, how you sign in.
    { id: "profile",         label: "Account",               group: "Account" },
    { id: "notifications",   label: "Notifications",         group: "Account", show: !selfHosted },
    { id: "security",        label: "Security",              group: "Account" },
    // Connections — how data flows in and out. Sources are two pages (GET-239); the personal one
    // keeps the `integrations` id so every existing ?section= link still lands.
    // Each one is a standalone page on every plan (GET-625 follow-up on API, GET-660 on Custom), so
    // the row goes there and both plans see the same page.
    // On API the sidebar's Integrations group already holds these four (GET-620), so the rail does
    // not repeat them (GET-857); unlisted, not hidden, so a ?section= link still reaches the page.
    { id: "integrations",    label: "Personal integrations", group: "Connections", href: "/integrations", show: !selfHosted, unlisted: core },
    { id: "company-sources", label: "Shared integrations",   group: "Connections", href: "/company-sources", show: !selfHosted, unlisted: core },
    { id: "webhooks",        label: "Webhooks",              group: "Connections", href: "/webhooks", show: !selfHosted, unlisted: core },
    { id: "api-keys",        label: "API keys",              group: "Connections", href: "/keys", show: !selfHosted, unlisted: core },
    // Raw evidence goes to the operator's own git on the API plan; on Custom it lives with us.
    { id: "repo",            label: "Repo",                  group: "Connections", show: core && !selfHosted },
    // Agent — the Workspace layer adds Memory and Skills ahead of Automations.
    { id: "sequences",       label: "Automations",           group: "Agent", show: selfManagedAgent },
    // Workspace — admins only (GET-430). The Workspace layer's models, changes, spend and adoption
    // rows sit before Billing (off in v1, GET-211).
    // Self-host: what nous.env has configured, AI models, integrations, email (GET-837).
    { id: "instance",        label: "Instance setup",        group: "Workspace", show: !!input.selfHosted && isWorkspaceAdmin },
    // What every RevBox job may read (GET-858), then the workspace's signals right below it (GET-862).
    // Both follow the revboxes feature, so they show on API and Workspace alike (GET-864), to
    // members too: jobs and signals are not admin-only.
    { id: "context",         label: "Context",               group: "Workspace", show: !!input.revboxes },
    { id: "signals",         label: "Signals",               group: "Workspace", show: !!input.revboxes },
    { id: "general",         label: "General",               group: "Workspace", show: isWorkspaceAdmin },
    { id: "members",         label: "Members",               group: "Workspace", show: isWorkspaceAdmin },
    // Billing IS the Usage page on every plan (GET-660), so the row says so and goes there.
    { id: "billing",         label: "Usage and billing",     group: "Workspace", href: "/usage", show: isWorkspaceAdmin && !selfHosted },
    // Support — the operator's Admin row is the Workspace layer's (cloud/settings/navRows, GET-761).
  ];
  for (const { show, before, ...row } of extra) {
    const at = before ? rows.findIndex((r) => r.id === before) : -1;
    const placed: Row = { ...row, show: show ? show(input) : true };
    if (at >= 0) rows.splice(at, 0, placed);
    else rows.push(placed);
  }
  return rows
    .filter((r) => r.show !== false)
    .map(({ show: _show, href, ...item }) => (href ? { ...item, href } : item));
}

/** Old deep links → where the content lives now. */
export const SECTION_ALIASES: Record<string, string> = {
  team: "general", usage: "billing", "access-log": "governance",
  privacy: "profile", brains: "general", market: "general",
};

/** The section a `?section=` value lands on: aliased, then the fallback when it is not in the rail. */
export function resolveSection(raw: string | null | undefined, items: SettingsNavItem[], fallback = "profile"): string {
  const s = raw || fallback;
  const aliased = SECTION_ALIASES[s] ?? s;
  return items.some((i) => i.id === aliased) ? aliased : fallback;
}

/** The rail grouped for rendering, empty groups dropped. */
export function groupNav(items: SettingsNavItem[]): { group: SettingsGroup; items: SettingsNavItem[] }[] {
  return GROUP_ORDER
    .map((group) => ({ group, items: items.filter((i) => i.group === group && !i.unlisted) }))
    .filter((g) => g.items.length > 0);
}
