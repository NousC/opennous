// The one door between the public app and the Workspace (Cloud) layer — GET-754.
//
// Everything that only runs on app.opennous.cloud lives under src/cloud/ (Clerk sign-in
// included, in src/cloud/auth/clerk/). The open-source export is this repo minus that folder, so
// nothing outside src/cloud/ may import from it (scripts/check-cloud-imports.mjs enforces that).
// Instead, src/cloud/index.ts default-exports a CloudRegistry, and public code reads the slots
// it needs from `cloud` below, falling back to the self-host behaviour when a slot is empty.
//
// import.meta.glob with no match returns {}, so a checkout without src/cloud/ still
// typechecks, builds and boots: `cloud` is simply {}.
import type { ComponentType, ElementType, ReactNode } from "react";
import type { ExtraSettingsRow } from "@/components/settings/settingsNav";
import type { BillingActions } from "@/lib/billing";
import type { InboxRead } from "@/components/priorities/inboxModel";
import type { SignInFormProps, SignUpFormProps, InviteSignUpProps, AccountSecurityProps } from "@/contexts/auth/slotTypes";

/** A lazily loaded component, the shape React.lazy takes. Keeps cloud pages out of the main chunk. */
export type Loader<P = object> = () => Promise<{ default: ComponentType<P> }>;

/** A component slot whose props the public caller decides (variants, sections, panels). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CloudComponent = ComponentType<any>;

/** A sidebar row the Workspace layer adds (components/AppSidebar draws it like its own). */
export type CloudNavItem = {
  title: string;
  url: string;
  icon: ElementType;
  end?: boolean;
  /** The Views group's colour square, and when that row is the active one. */
  swatch?: string;
  match?: (path: string, view: string | null) => boolean;
  /** Only on these plan tiers (planTier()); on every workspace tier when absent. */
  tiers?: string[];
};

/** What the sidebar hands the Chats group: whether to show it, and its own group heading. */
export interface RecentsProps {
  show: boolean;
  collapsed: boolean;
  sectionLabel: (text: string, fold?: { open: boolean; toggle: () => void }, action?: ReactNode) => ReactNode;
}

/** A settings rail row the Workspace layer adds: placed before the public row `before` (else at
 *  the end of its group), and shown only when `show` says so for this viewer. */
export type CloudSettingsRow = ExtraSettingsRow;

/** What Settings hands a Workspace-layer section. */
export interface CloudSettingsSectionProps {
  token: string;
  workspaceId: string;
}

/** A top-bar action sits right of Priorities; `inChat` is true inside a conversation on "/". */
export interface TopBarActionProps {
  inChat: boolean;
}

/** A variant the public page may warm ahead of rendering it (see lib/preloadable.ts). */
export type { Preloadable } from "@/lib/preloadable";

/** What AppSidebar hands the Brains group: its plan tier and its own row and heading renderers. */
export interface BrainsNavProps {
  tier: string;
  sectionLabel: (text: string) => ReactNode;
  buttonRow: (opts: { icon: ElementType; label: string; active: boolean; onClick: () => void; badge?: string; badgeDomain?: string | null }) => ReactNode;
  workspaceName: string;
  badgeDomain: string | null;
}

/** What AppSidebar hands a group the Workspace layer adds after the Views (cloud.nav.groups): the
 *  plan tier, whether the rail is collapsed, and the sidebar's own heading, row and tooltip renderers. */
export interface NavGroupProps {
  tier: string;
  collapsed: boolean;
  sectionLabel: (text: string, fold?: { open: boolean; toggle: () => void }, action?: ReactNode) => ReactNode;
  renderItem: (item: { title: string; url: string; icon: ElementType; action?: ReactNode }) => ReactNode;
  withTip: (node: ReactNode, label: string) => ReactNode;
}

/** A small link on a Priorities item to where the job that made it lives (cloud.shell.priorities). */
export type ItemChip = { name: string; href: string; title: string };

/** A Workspace-layer object the Accounts list can be narrowed to (the API's account scope). */
export interface AccountScope {
  /** The query parameter that names it, on the page's URL and on GET /api/companies/list. */
  param: string;
  /** The list answer's field that names it: { id, name }. */
  field: string;
  /** The toolbar chip's words for its name, its tooltip, and the clear button's label. */
  chip: (name: string) => string;
  title: string;
  clearLabel: string;
}

/** The graph narrowed to a Workspace-layer object's accounts: where to read it, its cache key, its banner. */
export interface GraphScope {
  key: string;
  source: { path: string; key: string };
  banner: ReactNode;
}

export interface CloudRegistry {
  /** Clerk sign-in (Cloud). Absent → Supabase Auth, the self-host provider. */
  auth?: {
    clerk?: {
      Provider: Loader<{ children: ReactNode }>;
      SignInForm: Loader<SignInFormProps>;
      SignUpForm: Loader<SignUpFormProps>;
      InviteSignUp: Loader<InviteSignUpProps>;
      AccountSecurity: Loader<AccountSecurityProps>;
      SsoCallback: Loader;
    };
  };

  /** Optional setup controls below an integration's connection status. */
  integrationSetup?: ComponentType<{ provider: string; token: string; workspaceId: string; canManage: boolean }>;
  /** <Route> elements mounted inside the app shell (sidebar and top bar). */
  routes?: ReactNode;
  /** <Route> elements mounted signed in but outside the app shell (the admin tools). */
  fullScreenRoutes?: ReactNode;
  /** <Route> elements mounted at the app root, outside sign-in (the /live dashboard). */
  publicRoutes?: ReactNode;
  /** Cloud versions of public pages; public code renders its own fallback when absent. */
  variants?: Partial<Record<"home" | "docIndex" | "doc" | "reporting", CloudComponent>>;
  /** Sidebar rows. The workspace plans take the groups below; the API plan's rail is public and
   *  takes only `api`. */
  nav?: {
    /** The API plan's main rail, after Events (GTM insights, GET-973). */
    api?: CloudNavItem[];
    /** After Home and Accounts in the main group. */
    main?: CloudNavItem[];
    /** The Views group (Pipeline, Handoff, Customers); the group is hidden when empty. */
    views?: CloudNavItem[];
    /** Before Activity in the Workspace group. */
    workspace?: CloudNavItem[];
    /** The Chats group under the brains. */
    recents?: ComponentType<RecentsProps>;
    /** The sidebar's Brains group (Cloud only, GET-839), drawn with the sidebar's own renderers. */
    brains?: ComponentType<BrainsNavProps>;
    /** Groups after the Views group on the workspace plans (GET-910). */
    groups?: ComponentType<NavGroupProps>[];
  };
  settings?: {
    /** Section id → the whole section. "billing" is the workspace plans' Billing section. */
    sections?: Record<string, ComponentType<CloudSettingsSectionProps>>;
    navRows?: CloudSettingsRow[];
    /** Groups appended to Settings → General (Cloud: Brains, GET-839). */
    generalGroups?: ComponentType[];
    /** Whether this sign-in email is the operator's (Cloud's Admin row). Absent → nobody is. */
    isOwner?: (email: string) => boolean;
  };
  shell?: {
    /** Rendered once in the app shell, after the page (the agent dock). Not over the account-limit wall. */
    overlays?: ComponentType[];
    topBarActions?: ComponentType<TopBarActionProps>[];
    /** Priorities' "After your meetings": Home's read (/api/home). Absent → only "To approve".
     *  `useItemChip` (a hook): where the built-in job that made an item lives, as a small link. */
    priorities?: {
      meetings: (args: { ws: string; scope: string; token?: string }) => Promise<InboxRead>;
      useItemChip?: (args: { ws: string; token: string; open: boolean }) => (builtinKey: string | null) => ItemChip | null;
    };
    /** Workspace-layer pages that draw their own top bar (GET-864). */
    ownsTopBar?: (pathname: string) => boolean;
    /** Workspace-layer pages where typing is the point (a job chat): single-key shortcuts stay off. */
    typingPage?: (pathname: string) => boolean;
  };
  /** Deals open as their own page (/accounts/:id/deals/:dealId, GET-1008) on the workspace plans.
   *  Absent → a deal is listed on its account and never opens (the API plan, the open-source build).
   *  Public code asks hooks/useDealPages, which adds the plan check. */
  dealPages?: boolean;
  /** The Accounts list narrowed to a Workspace-layer object's accounts (?<param>=<id>, GET-873). */
  accounts?: { scope?: AccountScope };
  /** The graph narrowed the same way (GET-858). Null when the URL names none. */
  graph?: { scope?: (params: URLSearchParams) => GraphScope | null };
  /** Where "Contact us" goes (config/contact.ts). Absent → VITE_CONTACT_URL, else the project's site. */
  contactUrl?: string;
  /** The MCP tools Cloud's server adds after `score` (read_brain, write_brain, GET-839; read_intelligence, GET-1042). */
  mcpTools?: string[];
  /** The Usage page's billing: checkout, the Stripe portal and invoices (useBilling). The usage
   *  meter itself is public. */
  usage?: {
    useBilling?: (args: { token: string; workspaceId: string; reload: () => Promise<void> | void }) => BillingActions;
  };
}

const mods = import.meta.glob<{ default: CloudRegistry }>("../cloud/index.ts", { eager: true });

export const cloud: CloudRegistry = Object.values(mods)[0]?.default ?? {};

/** True when this build carries the Workspace layer (Cloud), false for an open-source build. */
export const HAS_CLOUD = Object.keys(mods).length > 0;
