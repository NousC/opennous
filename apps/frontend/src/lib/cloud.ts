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

  /** <Route> elements mounted inside the app shell (sidebar and top bar). */
  routes?: ReactNode;
  /** <Route> elements mounted signed in but outside the app shell (the admin tools). */
  fullScreenRoutes?: ReactNode;
  /** <Route> elements mounted at the app root, outside sign-in (the /live dashboard). */
  publicRoutes?: ReactNode;
  /** Cloud versions of public pages; public code renders its own fallback when absent. */
  variants?: Partial<Record<"home" | "docIndex" | "doc" | "reporting" | "accountRecord", CloudComponent>>;
  /** Sidebar rows on the workspace plans. The API plan's rail is public and never changes. */
  nav?: {
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
    /** Priorities' "After your meetings": Home's read (/api/home). Absent → only "To approve". */
    priorities?: { meetings: (args: { ws: string; scope: string; token?: string }) => Promise<InboxRead> };
  };
  /** Where "Contact us" goes (config/contact.ts). Absent → VITE_CONTACT_URL, else the project's site. */
  contactUrl?: string;
  /** The MCP tools Cloud's server adds after `score` (read_brain, write_brain, GET-839). */
  mcpTools?: string[];
  /** The Usage page's billing: checkout, the Stripe portal and invoices (useBilling), and the
   *  plan cards an embedded Usage page shows (billingPanel). The usage meter itself is public. */
  usage?: {
    useBilling?: (args: { token: string; workspaceId: string; reload: () => Promise<void> | void }) => BillingActions;
    billingPanel?: CloudComponent;
  };
}

const mods = import.meta.glob<{ default: CloudRegistry }>("../cloud/index.ts", { eager: true });

export const cloud: CloudRegistry = Object.values(mods)[0]?.default ?? {};

/** True when this build carries the Workspace layer (Cloud), false for an open-source build. */
export const HAS_CLOUD = Object.keys(mods).length > 0;
