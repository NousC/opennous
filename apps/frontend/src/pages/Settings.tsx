import { useState, useEffect, useRef, useMemo, Suspense, type ChangeEvent, type ReactNode } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import {
  Trash2, Copy, Check, Upload, ChevronDown, MoreHorizontal, Lock, Globe,
} from "lucide-react";
import { AccountSecurity } from "@/contexts/auth/select";
import { useAuth } from "@/contexts/AuthContext";
import { usePlan } from "@/hooks/usePlan";
import { InstanceSetup } from "@/components/settings/InstanceSetup";
import { isCorePlan, planTier } from "@/config/plans";
import { PREVIEW } from "@/lib/preview";
import { useTheme } from "@/contexts/ThemeContext";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { type SettingsTab } from "@/components/mind/shared";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import UsageBilling from "@/pages/UsageBilling";
import ApiKeys from "@/pages/ApiKeys";
import Integrations from "@/pages/Integrations";
import Webhooks from "@/pages/Webhooks";
import { AutomationsPanel } from "@/components/AutomationsPanel";
import { RepositoriesPane } from "@/components/settings/RepoPane";
import MarketFocus from "@/pages/MarketFocus";
import { ApiActivity } from "@/components/settings/ApiActivity";
import { activeTeam } from "@/lib/activeTeam";
import { cloud } from "@/lib/cloud";
import { cn } from "@/lib/utils";
import { PageTopBar } from "@/components/ui/page-top-bar";
import { SettingsPage, SettingsGroup, SettingsRow, fieldCls, smallSwitchCls } from "@/components/settings/SettingsKit";
import { SecurityPreview } from "@/components/settings/SettingsSecurity";
import {
  effectiveNotifPrefs, notifRowsFor, isOn as isNotifOn, modeOf as notifModeOf,
  setOn as setNotifOn, setMode as setNotifMode, type NotifPrefs,
} from "@/components/settings/notificationPrefs";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/view-tabs";
import { PersonAvatar } from "@/components/ui/owner-filter";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { when } from "@/lib/format";
import { SettingsRail } from "@/components/settings/SettingsRail";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsNav, resolveSection, type SettingsGroup as NavGroup, type SettingsNavItem } from "@/components/settings/settingsNav";
import { faviconUrl } from "@/lib/externalImages";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// The jobs a member can tell their agent they do. Values must stay in lockstep
// with JOB_ROLES in apps/api/src/routes/api/me.mjs — the API rejects anything
// it doesn't recognise, and the agent turns the value into a brief.
const JOB_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "",                  label: "Not set" },
  // One role that means every lens — the champion who bought this and is standing it up, who
  // needs the SDR's view and the CS read and the leadership roll-up without holding nine
  // separate roles that go stale the moment a tenth is added.
  { value: "ambassador",        label: "Ambassador (all views)" },
  { value: "founder",           label: "Founder" },
  { value: "sales",             label: "Sales" },
  { value: "account_executive", label: "Account executive" },
  { value: "sdr",               label: "SDR" },
  { value: "revops",            label: "RevOps" },
  { value: "marketing",         label: "Marketing" },
  { value: "customer_success",  label: "Customer success" },
  { value: "agency",            label: "Agency / consultant" },
  { value: "engineer",          label: "Engineer" },
  { value: "other",             label: "Other" },
];

// A small segmented control for the agent's formatting preferences.
function Seg({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-border/70 p-0.5">
      {options.map(o => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={"rounded-md px-3 py-1 text-[12.5px] transition-colors " + (value === o.v ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground")}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

// Resize/crop an uploaded image to a centered 256x256 square and return a small
// JPEG data URL. Keeps the stored avatar tiny (~20-40KB) so it fits the users
// table's profile_picture_url column with no object-storage bucket to configure.
function fileToAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no canvas"));
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// ── shared styles (work in both light + dark) ───────────────────────────────
// The invite row's fields: the 32px field of the boards, sized by the row rather than fixed.
const inviteFieldCls =
  "h-8 min-w-0 rounded-lg border border-input bg-card px-2.5 text-[13px] text-foreground outline-none " +
  "transition-colors duration-fast placeholder:text-muted-foreground/70 focus:border-foreground/30";
// The select fields of the rows: the shared Select (the menu every popup uses), at the 32px field
// size. Radix reserves "" for "no value", so an empty choice rides on NONE.
const selectCls =
  "h-8 rounded-lg bg-card px-2.5 text-[13px] focus:ring-0 focus:ring-offset-0 focus:border-foreground/30 data-[placeholder]:text-muted-foreground";
const NONE = "__none";
// A value you can change in place: reads as text, opens a menu.
const ghostSelectCls =
  "inline-flex h-[26px] max-w-[200px] items-center gap-1 rounded-[7px] px-2 text-[12.5px] text-foreground " +
  "transition-colors duration-fast hover:bg-hover";

// A section is wrapped in this shell: the settings page kit (GET-625) — a
// centered ~680px column (the top bar names it). `wide` is for the app pages embedded here (integrations,
// webhooks, keys), which bring their own lists and need the room.
function SectionShell({ title, description, children, wide }: {
  title?: string; description?: string; children: ReactNode; wide?: boolean;
}) {
  return <SettingsPage title={title} description={description} wide={wide}>{children}</SettingsPage>;
}

// The GTM roles a founder can assign to a teammate (excludes "Not set" and "Other").
const ASSIGNABLE_ROLES = JOB_ROLE_OPTIONS.filter((o) => o.value && o.value !== "other");

// A multi-select of a member's role(s). The founder picks any combination; each becomes a
// tab on that person's Reporting page, and SDR/BDR unlock Coaching.
function MemberRoleEditor({ roles, onChange, disabled }: { roles: string[]; onChange: (r: string[]) => void; disabled?: boolean }) {
  const toggle = (v: string) => onChange(roles.includes(v) ? roles.filter((r) => r !== v) : [...roles, v]);
  const label = roles.length === 0 ? "Set roles" : roles.map((r) => ASSIGNABLE_ROLES.find((o) => o.value === r)?.label ?? r).join(", ");
  if (disabled) {
    return <span className="block max-w-[200px] truncate text-[12.5px] text-muted-foreground">{roles.length ? label : "—"}</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={ghostSelectCls + (roles.length ? "" : " text-muted-foreground")}>
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
        {ASSIGNABLE_ROLES.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={roles.includes(o.value)}
            onCheckedChange={() => toggle(o.value)}
            onSelect={(e) => e.preventDefault()}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Running the workspace lives here, under Workspace (GET-430). It spent a while as the space's
// Admin group, which made the sidebar carry two kinds of thing: where the company's knowledge
// is, and where the company is administered. The sidebar is for the first; this is the second.
// `embedded` + `forceSection` stay so another surface can still mount a single panel.
export default function Settings({ embedded = false, forceSection }: { embedded?: boolean; forceSection?: SettingsTab } = {}) {
  const { userData, session, refreshUserData, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // The operator account. Cloud's Admin row and section (cloud/settings) are for it alone; which
  // account that is, the Workspace layer decides (GET-761). Server-side, the /admin/* routes and
  // APIs are still gated on is_admin (ADMIN_EMAILS). An open-source build has no operator.
  const isOwner = cloud.settings?.isOwner?.(userData?.user?.email ?? "") ?? false;
  // Workspace admin = the founder or anyone with an owner/admin role in the workspace.
  // /me already reports both, so this is known on first paint (no fetch, no flash).
  const myWsRole = String(userData?.workspace_role ?? "").toLowerCase();
  const isWorkspaceAdmin = !!userData?.is_founder || ["founder", "owner", "admin"].includes(myWsRole);
  const handleSignOut = async () => { try { await signOut(); } catch { /* ignore */ } };
  const { mode, setMode, theme } = useTheme();
  const token = session?.access_token;
  const teamId = activeTeam(userData)?.id;
  const workspaceId = userData?.workspace?.id ?? "";

  // ── The rail (GET-625). The registry and its plan rules live in settingsNav.ts so they can be
  // tested without React: API vs Custom, admin gating, the hidden sections staying hidden.
  // Core = the API plan (CORE_PLAN_IDS). It is where Repo shows, and where Billing is the
  // Usage page.
  const { planId: __planIdForNav, selfHosted, can: canForNav } = usePlan();
  const core = isCorePlan(__planIdForNav);
  const tier = planTier(__planIdForNav);
  const SECTIONS = useMemo(
    () => settingsNav({ tier, isWorkspaceAdmin, isOwner, selfHosted, can: canForNav }, cloud.settings?.navRows),
    [tier, isWorkspaceAdmin, isOwner, selfHosted, canForNav],
  );

  // Two surfaces, one component. `/connect` shows the PERSONAL groups; `/settings` shows
  // everything. (`/connect` now redirects to /settings, so the personal scope only remains for
  // a caller that mounts this under that path.)
  const location = useLocation();
  const scope: "personal" | "workspace" = !embedded && location.pathname.startsWith("/connect") ? "personal" : "workspace";
  const PERSONAL_GROUPS: NavGroup[] = ["Account", "Connections", "Agent"];
  const inScope = scope === "personal" ? SECTIONS.filter(s => PERSONAL_GROUPS.includes(s.group)) : SECTIONS;
  const fallback: SettingsTab = "profile";
  const basePath = scope === "personal" ? "/connect" : "/settings";

  // Resolve the active section from `?section=`, honouring the legacy aliases (team → general,
  // usage → billing, privacy → profile, brains/market → general) so old deep links keep working.
  // Anything unknown or out of the rail falls back to Account.
  const section: SettingsTab = forceSection ?? (resolveSection(searchParams.get("section"), inScope, fallback) as SettingsTab);
  // The Workspace layer's sections (GET-754); "billing" is its Billing for the workspace plans.
  const CloudSection = cloud.settings?.sections?.[section];
  const CloudBilling = cloud.settings?.sections?.billing;
  const goto = (id: SettingsTab) => navigate(`${basePath}?section=${id}`);
  const activeItem = inScope.find(s => s.id === section);

  // A row that is its own page (integrations, webhooks, keys, billing — on every plan since
  // GET-660) is never rendered here: an old /settings?section=… link goes to that page with its
  // query intact, because the pages read it (?connect= on Integrations; ?plan / ?interval / ?code
  // on the Usage page, from the backfill pill and the drip email's annual-checkout link).
  const pageHref = activeItem?.href;
  useEffect(() => {
    if (embedded || forceSection || !pageHref) return;
    navigate(`${pageHref}${location.search}`, { replace: true });
  }, [embedded, forceSection, pageHref, location.search, navigate]);
  // A connect link for a tool that lives on the other Sources page: go there and connect it
  // there, so the new connection appears in the list you are looking at.
  const forwardSource = (side: "personal" | "company", slug: string) =>
    navigate(`${basePath}?section=${side === "company" ? "company-sources" : "integrations"}&connect=${encodeURIComponent(slug)}`, { replace: true });

  // (ICP model moved to the company surface — components/IcpModel.tsx — its single home.)

  // Profile
  const [name, setName] = useState(userData?.user?.name ?? "");
  const [nameSaving, setNameSaving] = useState(false);

  // ── Agent personalization (this member, this workspace) ──
  const [jobRole, setJobRole] = useState("");
  const [agentPrefs, setAgentPrefs] = useState<{ format?: string; length?: string }>({});
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentLoaded, setAgentLoaded] = useState(false);

  // ── Notifications (this member, this workspace) ──
  // What the member stored (null until loaded / never set). The shown prefs merge it over the
  // role's defaults on every render, so a role that resolves after the load still counts.
  const [notifStored, setNotif] = useState<Partial<NotifPrefs> | null>(null);
  const notif = useMemo(() => effectiveNotifPrefs(notifStored, isWorkspaceAdmin), [notifStored, isWorkspaceAdmin]);
  const [notifLoaded, setNotifLoaded] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);

  // Team. The plan decides HOW a member is onboarded: on the API plan the TEAM layer
  // is off, so members are headless — they self-provision over the CLI (`nous join`) and
  // work through their own agent, never as an in-app seat. So we hide the email invite and
  // lead with the CLI link. On the Growth-family plans (inAppAgent on) members are real
  // in-app collaborators, so the email invite leads and the CLI link is a secondary path.
  // `can` treats the pre-load state as open, so we default to showing the email invite
  // until the plan resolves (never hide it from a Growth admin mid-load).
  const { can: canFeature, loading: planLoading } = usePlan();
  const memberIsInApp = planLoading || canFeature("inAppAgent");
  const [members, setMembers] = useState<any[]>([]);
  const [memberRoles, setMemberRoles] = useState<Record<string, string[]>>({});
  const [invitations, setInvitations] = useState<any[]>([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");   // workspace role: member | admin
  const [inviteGtmRole, setInviteGtmRole] = useState("");   // GTM role (AE/SDR/…), pre-assigned
  const [inviting, setInviting] = useState(false);
  const [joinCmd, setJoinCmd] = useState<string | null>(null);
  const [joinGenerating, setJoinGenerating] = useState(false);
  const [joinCopied, setJoinCopied] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(activeTeam(userData)?.name ?? "");
  const [wsNameSaving, setWsNameSaving] = useState(false);

  // Company name + website are stored on the workspace row so they round-trip
  // cleanly between onboarding (which writes them) and Settings (which edits).
  const [companyName, setCompanyName] = useState(userData?.workspace?.name ?? "");
  const [companyUrl, setCompanyUrl] = useState(userData?.workspace?.website ?? "");
  const [companyTimezone, setCompanyTimezone] = useState(userData?.workspace?.timezone ?? "");
  const [companySaving, setCompanySaving] = useState(false);

  // ── Privacy & data (GDPR export + self-service erasure) ──
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const myEmail = userData?.user?.email ?? "";

  const exportMyData = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/users/me/export`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "nous-export.json"; a.click();
      URL.revokeObjectURL(url);
      toast.success("Your data export downloaded.");
    } catch { toast.error("Couldn't export right now — try again."); }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`${apiUrl}/api/users/me`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) throw new Error();
      toast.success("Your account has been deleted.");
      setTimeout(() => signOut(), 800);
    } catch { toast.error("Couldn't delete your account — contact support."); setDeleting(false); }
  };
  const saveCompany = async () => {
    if (!token || !workspaceId) {
      toast.error("Workspace not ready yet — try again in a moment.");
      return;
    }
    setCompanySaving(true);
    try {
      // Only send timezone when it actually changed — an unconditional send
      // turns EVERY name/website save into a 500 on a deployment whose DB
      // hasn't run the timezone migration yet (PostgREST rejects the column).
      const savedTz = String(userData?.workspace?.timezone ?? "").trim();
      const body: Record<string, unknown> = {
        name: companyName.trim() || undefined,
        website: companyUrl.trim(),
      };
      if (companyTimezone.trim() !== savedTz) body.timezone = companyTimezone.trim() || null;
      const res = await fetch(`${apiUrl}/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      toast.success("Company saved.");
      refreshUserData();
    } catch (err: any) {
      console.error("saveCompany failed:", err);
      toast.error(err?.message || "Couldn't save right now.");
    } finally {
      setCompanySaving(false);
    }
  };

  useEffect(() => {
    setName(userData?.user?.name ?? "");
    setWorkspaceName(activeTeam(userData)?.name ?? "");
    setCompanyName(userData?.workspace?.name ?? "");
    setCompanyUrl(userData?.workspace?.website ?? "");
    setCompanyTimezone(userData?.workspace?.timezone ?? "");
  }, [userData]);

  const [accessLog, setAccessLog] = useState<any[]>([]);
  const [accessLogLoading, setAccessLogLoading] = useState(false);
  const [openVisibility, setOpenVisibility] = useState(true);
  const [isWsAdmin, setIsWsAdmin] = useState(false);
  const [govEstate, setGovEstate] = useState<any>(null);
  const [govSources, setGovSources] = useState<any[]>([]);
  const [govMembers, setGovMembers] = useState<any[]>([]);
  // Model access policy — which models may run in this workspace — lives on the Model
  // providers page under the space's Admin root, where a vendor toggle writes the allowlist.
  // It was half-here before: the state and the save existed, nothing rendered them.
  const loadAccessLog = async () => {
    if (!workspaceId || !token) return;
    setAccessLogLoading(true);
    try {
      // no-store: the visibility toggle must reflect the live saved value, never a
      // heuristically-cached older response.
      const opts = { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" as RequestCache };
      const [logRes, setRes, memRes, govRes] = await Promise.all([
        fetch(`${apiUrl}/api/workspaces/${workspaceId}/access-log`, opts),
        fetch(`${apiUrl}/api/workspaces/${workspaceId}/settings`, opts),
        fetch(`${apiUrl}/api/workspaces/${workspaceId}/members`, opts),
        fetch(`${apiUrl}/api/workspaces/${workspaceId}/governance`, opts),
      ]);
      if (logRes.ok) setAccessLog((await logRes.json()).log ?? []);
      if (setRes.ok) {
        const s = await setRes.json();
        setOpenVisibility(s.open_account_visibility !== false);
      }
      if (memRes.ok) {
        const ms = (await memRes.json()).members ?? [];
        const me = ms.find((m: any) => (m.user_id ?? m.users?.id) === userData?.user?.id);
        setIsWsAdmin(me ? ["owner", "admin"].includes(me.role) : false);
      }
      if (govRes.ok) {
        const g = await govRes.json();
        setGovEstate(g.estate ?? null);
        setGovSources(g.sources ?? []);
        setGovMembers(g.members ?? []);
      }
    } finally { setAccessLogLoading(false); }
  };
  const [confirmVisOpen, setConfirmVisOpen] = useState(false);
  const [pendingVis, setPendingVis] = useState(true);
  const requestToggle = (next: boolean) => {
    if (!isWsAdmin) return;
    setPendingVis(next);
    setConfirmVisOpen(true);
  };
  const applyVisibility = async () => {
    const next = pendingVis;
    setConfirmVisOpen(false);
    setOpenVisibility(next);
    try {
      const res = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/visibility`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ open: next }),
      });
      if (!res.ok) setOpenVisibility(!next);
    } catch { setOpenVisibility(!next); }
  };

  // Export the audit log as CSV — the sovereignty receipt: who did what, when.
  const exportAuditLog = () => {
    if (!accessLog.length) return;
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = accessLog.map((e) => [
      new Date(e.at).toISOString(),
      e.action,
      e.actor_name ?? "",
      e.member_name ?? "",
      e.account_name ?? e.meta_label ?? "",
      e.via ?? "",
    ].map(esc).join(","));
    const csv = ["timestamp,action,actor,member,target,via", ...rows].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `nous-audit-log-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const loadTeam = async () => {
    if (!teamId || !token) return;
    setTeamLoading(true);
    try {
      const h = { Authorization: `Bearer ${token}` };
      const [mRes, iRes] = await Promise.all([
        fetch(`${apiUrl}/api/teams/${teamId}/members`, { headers: h }),
        fetch(`${apiUrl}/api/teams/${teamId}/invitations`, { headers: h }),
      ]);
      if (mRes.ok) setMembers((await mRes.json()).members ?? []);
      if (iRes.ok) setInvitations((await iRes.json()).invitations ?? []);
      // Each member's assigned role(s) — the founder edits these below.
      if (workspaceId) {
        const rRes = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/member-roles`, { headers: h });
        if (rRes.ok) setMemberRoles((await rRes.json()).roles ?? {});
      }
    } finally { setTeamLoading(false); }
  };

  // The founder assigns a member's role(s) — drives their Reporting tabs + the Coaching gate.
  const saveMemberRoles = async (uid: string, roles: string[]) => {
    setMemberRoles((prev) => ({ ...prev, [uid]: roles }));
    if (!workspaceId || !token) return;
    try {
      await fetch(`${apiUrl}/api/workspaces/${workspaceId}/members/${uid}/roles`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ roles }),
      });
    } catch { /* optimistic */ }
  };

  useEffect(() => {
    if (section === "members") loadTeam();
    if (section === "governance") loadAccessLog();
    // Keyed on workspaceId/teamId AND whether a token exists — token and userData
    // populate on independent async paths, so on a hard reload the token can arrive
    // AFTER workspaceId. The loaders guard on both; without a token dependency they'd
    // bail once and never retry, leaving the visibility toggle stuck on its default.
    // We key on `!!token` (a boolean), NOT `token` itself: it flips false→true once
    // and stays true across the ~30s rotations, so this never re-fires on rotation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, workspaceId, teamId, !!token]);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);

  const saveAvatar = async (value: string | null) => {
    if (!token) return;
    setAvatarSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile_picture_url: value }),
      });
      if (res.ok) { toast.success(value ? "Profile picture updated" : "Profile picture removed"); refreshUserData(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || "Couldn't save picture"); }
    } finally { setAvatarSaving(false); }
  };

  const onAvatarPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file"); return; }
    setAvatarSaving(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      await saveAvatar(dataUrl);
    } catch { toast.error("Couldn't process that image"); setAvatarSaving(false); }
  };

  const saveName = async () => {
    if (!token) return;
    setNameSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) { toast.success("Name updated"); refreshUserData(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || "Failed to update name"); }
    } finally { setNameSaving(false); }
  };

  // The member's own role, as the founder set it on the Members page. Read-only here: it
  // decides how the agent works for them (an SDR and an AE get different briefs), so seeing
  // it on their Account page is how they find out what the agent thinks they do.
  const [myRoles, setMyRoles] = useState<string[]>([]);
  useEffect(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/me/agent-profile?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setMyRoles(Array.isArray(d.member_roles) ? d.member_roles : []); })
      .catch(() => {});
  }, [token, workspaceId]);

  // Load this member's agent profile once the Your-agent section is open.
  useEffect(() => {
    if (section !== "agent" || !token || !workspaceId || agentLoaded) return;
    fetch(`${apiUrl}/api/me/agent-profile?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        setJobRole(d.job_role ?? "");
        // agent_instructions / agent_name / agent_rules are no longer read — the Behaviour
        // surface is gone and personalisation is learned. agent_prefs stays for memory consent.
        setAgentPrefs(d.agent_prefs ?? {});
      })
      .catch(() => { /* falls back to empty — the agent just stays generic */ })
      .finally(() => setAgentLoaded(true));
  }, [section, token, workspaceId, agentLoaded]);

  const saveAgentProfile = async () => {
    if (!token || !workspaceId) return;
    setAgentSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/me/agent-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId,
          job_role: jobRole || null,
          agent_prefs: agentPrefs,
        }),
      });
      if (res.ok) toast.success("Your agent has been updated");
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || "Failed to save"); }
    } catch { toast.error("Failed to save"); }
    finally { setAgentSaving(false); }
  };

  // Load notification prefs once the Notifications section is open. A member who
  // never set them reads as the all-on defaults.
  useEffect(() => {
    if (section !== "notifications" || !token || !workspaceId || notifLoaded) return;
    fetch(`${apiUrl}/api/me/notification-prefs?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.notification_prefs) setNotif(d.notification_prefs);
      })
      .catch(() => { /* keep the defaults */ })
      .finally(() => setNotifLoaded(true));
  }, [section, token, workspaceId, notifLoaded]);

  const saveNotifPrefs = async (next: NotifPrefs) => {
    setNotif(next); // optimistic
    if (!token || !workspaceId) return;
    setNotifSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/me/notification-prefs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId, notification_prefs: next }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.error || "Couldn't save"); }
    } catch { toast.error("Couldn't save"); }
    finally { setNotifSaving(false); }
  };
  const setDigest = (v: boolean) => saveNotifPrefs({ ...notif, daily_digest: v });

  const saveWsName = async () => {
    if (!token || !teamId) return;
    setWsNameSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/teams/${teamId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: workspaceName.trim() }),
      });
      if (res.ok) { toast.success("Workspace name updated"); refreshUserData(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || "Failed to update workspace name"); }
    } finally { setWsNameSaving(false); }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !teamId || !token) return;
    setInviting(true);
    try {
      const res = await fetch(`${apiUrl}/api/teams/${teamId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.emailSent) {
          toast.success(`Invitation email sent to ${inviteEmail}`);
        } else if (data.inviteLink) {
          // Email isn't configured (or the provider rejected it) — hand the
          // owner the link so the invite still works.
          await navigator.clipboard?.writeText(data.inviteLink).catch(() => {});
          toast.success(`Invite created. Email couldn't be sent, so the link was copied to your clipboard — share it with ${inviteEmail}.`, { duration: 9000 });
        } else {
          toast.success(`Invitation created for ${inviteEmail}.`);
        }
        setInviteEmail(""); setShowInvite(false); await loadTeam();
      } else {
        // seat_limit_reached (402, Starter) and other errors carry a human message.
        toast.error(data.message || data.error || "Failed to send invitation");
      }
    } finally { setInviting(false); }
  };

  // Mint a reusable join token and surface the `npx @opennous/cli join …` command a
  // teammate runs to self-provision a member-scoped workspace inside their own agent.
  const generateJoinCommand = async () => {
    if (!teamId || !token) return;
    setJoinGenerating(true);
    try {
      const res = await fetch(`${apiUrl}/api/teams/${teamId}/join-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          role: inviteRole,                              // member | admin
          job_role: inviteGtmRole || undefined,          // pre-assign the GTM role
          invitee_name: inviteName.trim() || undefined,
          invitee_email: inviteEmail.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.command) {
        setJoinCmd(data.command);
        setJoinCopied(false);
        await navigator.clipboard?.writeText(data.command).catch(() => {});
        setJoinCopied(true);
        toast.success(`Invite ready${inviteName ? ` for ${inviteName}` : ""} — command copied. Send it to them.`);
      } else {
        toast.error(data.message || data.error || "Couldn't create a join link");
      }
    } finally { setJoinGenerating(false); }
  };

  const cancelInvitation = async (id: string) => {
    if (!teamId || !token || !confirm("Cancel this invitation?")) return;
    await fetch(`${apiUrl}/api/teams/${teamId}/invitations/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await loadTeam();
  };

  const removeMember = async (userId: string) => {
    if (!teamId || !token || !confirm("Remove this member from the team?")) return;
    await fetch(`${apiUrl}/api/teams/${teamId}/members/${userId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    await loadTeam();
  };

  // Two role labels only, Admin and Member. The founder + any owner/admin read as
  // "Admin"; everyone else is "Member".
  const roleLabel = (role?: string) =>
    ["founder", "owner", "admin"].includes(String(role ?? "").toLowerCase()) ? "Admin" : "Member";
  // The value the role <select> shows — collapses every role onto the two we expose.
  const roleValue = (role?: string) =>
    ["founder", "owner", "admin"].includes(String(role ?? "").toLowerCase()) ? "admin" : "member";

  const changeMemberRole = async (userId: string, role: string) => {
    if (!teamId || !token) return;
    try {
      const res = await fetch(`${apiUrl}/api/teams/${teamId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error();
      toast.success(role === "admin" ? "Promoted to admin" : "Changed to member");
      await loadTeam();
    } catch { toast.error("Couldn't update the role — try again."); }
  };

  // General: one Save for the company row (workspace record) and the workspace name (team).
  const companyDomain = companyUrl.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
  const companyDirty =
    companyName.trim() !== String(userData?.workspace?.name ?? "").trim() ||
    companyUrl.trim() !== String(userData?.workspace?.website ?? "").trim() ||
    companyTimezone.trim() !== String(userData?.workspace?.timezone ?? "").trim();
  const wsNameDirty = !!workspaceName.trim() && workspaceName.trim() !== String(activeTeam(userData)?.name ?? "").trim();
  const generalDirty = companyDirty || wsNameDirty;
  const saveGeneral = async () => {
    if (companyDirty) await saveCompany();
    if (wsNameDirty) await saveWsName();
  };

  const onRailSelect = (it: SettingsNavItem) => (it.href ? navigate(it.href) : goto(it.id as SettingsTab));
  const planLabel = tier === "custom" ? "Custom plan" : "API plan";
  // On its way to the section's own page (the effect above): draw nothing rather than flash the
  // panel it no longer has.
  if (!embedded && !forceSection && pageHref) return null;

  return (
    <div className={embedded ? "flex h-full w-full bg-background text-foreground" : "flex h-screen w-full flex-col overflow-hidden bg-frame text-foreground md:flex-row"}>
      {/* ─── LEFT — the settings rail, in place of the app sidebar (GET-625). ─── */}
      {!embedded && (
        <SettingsRail
          items={inScope}
          active={section}
          onSelect={onRailSelect}
          onBack={() => navigate("/")}
          onSignOut={handleSignOut}
          workspaceName={userData?.workspace?.name || activeTeam(userData)?.name || ""}
          planLabel={planLabel}
        />
      )}

      {/* ─── RIGHT — the active section, in the same white panel as every app page ─── */}
      <main className={embedded ? "min-w-0 flex-1 overflow-y-auto" : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2 pt-0 md:pl-0 md:pt-2"}>
       <div className={embedded ? "" : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-black/[0.06] bg-background shadow-card dark:border-white/[0.06]"}>
        {!embedded && <PageTopBar crumbs={[{ label: activeItem?.label ?? "Settings" }]} />}
        <div className={embedded ? "" : "min-h-0 flex-1 overflow-y-auto"}>

          {/* ── Account (GET-636, board SettingsAccount): profile, preferences, privacy. ── */}
          {section === "profile" && (
            <SectionShell title="Account" description="How you appear to your team.">
              <SettingsGroup title="Profile">
                <SettingsRow
                  label="Photo"
                  leading={
                    <button
                      type="button"
                      onClick={() => avatarInputRef.current?.click()}
                      disabled={avatarSaving}
                      aria-label="Upload a new photo"
                      className="group relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted"
                    >
                      {userData?.user?.profile_picture_url
                        ? <img src={userData.user.profile_picture_url} alt="" className="h-full w-full object-cover" />
                        : <span className="text-[12px] font-medium text-muted-foreground/80">{(name || userData?.user?.email || "?").trim().charAt(0).toUpperCase()}</span>}
                      <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-fast group-hover:opacity-100">
                        <Upload className="h-3.5 w-3.5 text-white" />
                      </span>
                    </button>
                  }
                >
                  <Button variant="outline" onClick={() => avatarInputRef.current?.click()} disabled={avatarSaving}>
                    {avatarSaving ? "Saving…" : "Upload"}
                  </Button>
                  {userData?.user?.profile_picture_url && (
                    <Button variant="ghost" onClick={() => saveAvatar(null)} disabled={avatarSaving}>Remove</Button>
                  )}
                  <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={onAvatarPick} />
                </SettingsRow>
                <SettingsRow label="Display name" htmlFor="settings-display-name">
                  <input
                    id="settings-display-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) saveName(); }}
                    className={fieldCls}
                  />
                  {name.trim() !== (userData?.user?.name ?? "").trim() && (
                    <Button onClick={saveName} disabled={nameSaving || !name.trim()}>{nameSaving ? "Saving…" : "Save"}</Button>
                  )}
                </SettingsRow>
                <SettingsRow label="Email">
                  <span className="truncate text-[12px] text-muted-foreground/70">{userData?.user?.email}</span>
                </SettingsRow>
                {/* Read-only: the founder sets roles on Members. They decide how the agent briefs
                    this person, so this is where they find out what it thinks they do. */}
                <SettingsRow label="Role" hint={isWorkspaceAdmin ? "Set on Members" : "Set by your admin"}>
                  {myRoles.length ? (
                    <span className="flex flex-wrap justify-end gap-1.5">
                      {myRoles.map(r => (
                        <span key={r} className="inline-flex h-5 items-center rounded-md bg-muted px-[7px] text-[11.5px] text-ink-2">
                          {JOB_ROLE_OPTIONS.find(o => o.value === r)?.label ?? r.replace(/_/g, " ")}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-[12px] text-muted-foreground/60">Not set</span>
                  )}
                </SettingsRow>
              </SettingsGroup>

              <SettingsGroup title="Preferences">
                <SettingsRow label="Theme" hint={mode === "system" ? `Following your system, currently ${theme}` : undefined}>
                  <SegmentedControl
                    aria-label="Theme"
                    value={mode}
                    onChange={(v) => setMode(v)}
                    options={[
                      { value: "light", label: "Light" },
                      { value: "system", label: "System" },
                      { value: "dark", label: "Dark" },
                    ]}
                  />
                </SettingsRow>
              </SettingsGroup>

              {/* Privacy and data used to be its own page. It is two actions about the account
                  you are already looking at, so it sits at the foot of it. */}
              <SettingsGroup title="Privacy & data">
                <SettingsRow label="Export my data" hint="Everything Nous holds about you, as JSON">
                  <Button variant="outline" onClick={exportMyData}>Export</Button>
                </SettingsRow>
                <SettingsRow label="Delete account" hint="Removes you and revokes your integrations">
                  <Button variant="ghost" className="text-risk hover:text-risk" onClick={() => setDeleteOpen(true)}>Delete account</Button>
                </SettingsRow>
              </SettingsGroup>

              <AlertDialog open={deleteOpen} onOpenChange={(o) => { setDeleteOpen(o); if (!o) setDeleteText(""); }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently deletes your account and revokes your connected integrations.
                      If you're the only member of your workspace, all of its data is deleted too.
                      This can't be undone. Type <span className="font-semibold text-foreground">{myEmail}</span> to confirm.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <input
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    placeholder={myEmail}
                    aria-label="Type your email to confirm"
                    className={fieldCls + " sm:w-full"}
                  />
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={deleting || deleteText.trim().toLowerCase() !== myEmail.toLowerCase()}
                      onClick={(e) => { e.preventDefault(); deleteAccount(); }}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {deleting ? "Deleting…" : "Permanently delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </SectionShell>
          )}

          {/* ── Notifications (GET-636, board SettingsNotifications). The API-plan alerts are
              emailed (GET-635); the rest are saved now and apply as each channel ships. ── */}
          {section === "notifications" && (
            <SectionShell title="Notifications" description="What Nous tells you, and where.">
              <SettingsGroup title="Email">
                <SettingsRow label="Daily digest" hint="A morning summary of what needs you today, in one email.">
                  <Switch aria-label="Daily digest" className={smallSwitchCls} checked={notif.daily_digest} onCheckedChange={setDigest} disabled={!notifLoaded} />
                </SettingsRow>
              </SettingsGroup>
              <SettingsGroup title="Notify me about">
                {notifRowsFor(core).map((r) => {
                  const on = isNotifOn(notif, r.key);
                  return (
                    <SettingsRow key={r.key} label={r.label} hint={r.desc}>
                      {/* Custom picks where it lands; the API plan has no in-app inbox to choose. */}
                      {!core && on && (
                        <SegmentedControl
                          aria-label={`${r.label} channel`}
                          value={notifModeOf(notif, r.key)}
                          onChange={(m) => saveNotifPrefs(setNotifMode(notif, r.key, m))}
                          options={[
                            { value: "email", label: "Email" },
                            { value: "app", label: "App" },
                            { value: "both", label: "Both" },
                          ]}
                        />
                      )}
                      <Switch
                        aria-label={r.label}
                        className={smallSwitchCls}
                        checked={on}
                        disabled={!notifLoaded}
                        onCheckedChange={(v) => saveNotifPrefs(setNotifOn(notif, r.key, v))}
                      />
                    </SettingsRow>
                  );
                })}
              </SettingsGroup>
              {notifSaving && <p className="mt-3 text-[11.5px] text-muted-foreground/60">Saving…</p>}
            </SectionShell>
          )}

          {/* ── Security (GET-636, board SettingsSecurity). The auth provider's own account UI
              (GET-577): Clerk's sign-in method + sessions on Cloud, change-password + sign-out on
              self-host Supabase Auth. In the preview there is no provider, so it says so. ── */}
          {section === "security" && (
            <SectionShell title="Security" description="How you sign in, and where you're signed in.">
              {PREVIEW ? <SecurityPreview /> : (
                <Suspense fallback={null}>
                  <AccountSecurity theme={theme} />
                </Suspense>
              )}
            </SectionShell>
          )}

          {/* ── General (GET-637, board SettingsGeneral): what the company is, and where it sells. ── */}
          {section === "general" && (
            <SectionShell title="General" description="What the company is, and where it sells.">
              <SettingsGroup title="Company">
                <SettingsRow
                  label="Logo"
                  hint={companyDomain ? "Pulled from your website" : "Add your website to pull it in"}
                >
                  <span className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-card text-[13px] font-medium text-muted-foreground/80 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.6)]">
                    {faviconUrl(companyDomain)
                      ? <img src={faviconUrl(companyDomain)!} alt="" className="h-5 w-5 object-contain" />
                      : (companyName || workspaceName || "?").trim().charAt(0).toUpperCase()}
                  </span>
                </SettingsRow>
                <SettingsRow label="Company name" htmlFor="g-name">
                  <input id="g-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme, Inc." className={fieldCls} />
                </SettingsRow>
                <SettingsRow label="Company website" htmlFor="g-web">
                  <input id="g-web" value={companyUrl} onChange={(e) => setCompanyUrl(e.target.value)} placeholder="https://acme.com" inputMode="url" className={fieldCls} />
                </SettingsRow>
                <SettingsRow label="Workspace name" htmlFor="g-ws">
                  <input
                    id="g-ws"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && generalDirty) saveGeneral(); }}
                    className={fieldCls}
                  />
                </SettingsRow>
                {/* Deadlines like "by Friday" in meetings and emails resolve against this calendar. */}
                <SettingsRow label="Timezone" htmlFor="g-tz">
                  <Select value={companyTimezone || NONE} onValueChange={(v) => setCompanyTimezone(v === NONE ? "" : v)}>
                    <SelectTrigger id="g-tz" className={cn(selectCls, "w-full sm:w-[260px]")}><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-80">
                      <SelectItem value={NONE}>Server default</SelectItem>
                      {/* Intl.supportedValuesOf is in every modern browser but not in this tsconfig's lib target, hence the cast */}
                      {(typeof (Intl as any).supportedValuesOf === "function" ? ((Intl as any).supportedValuesOf("timeZone") as string[]) : []).map((tz) => (
                        <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
                {generalDirty && (
                  <div className="flex justify-end gap-2 px-2 pb-0.5 pt-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setCompanyName(userData?.workspace?.name ?? "");
                        setCompanyUrl(userData?.workspace?.website ?? "");
                        setCompanyTimezone(userData?.workspace?.timezone ?? "");
                        setWorkspaceName(activeTeam(userData)?.name ?? "");
                      }}
                    >
                      Discard
                    </Button>
                    <Button onClick={saveGeneral} disabled={companySaving || wsNameSaving}>
                      {companySaving || wsNameSaving ? "Saving…" : "Save"}
                    </Button>
                  </div>
                )}
              </SettingsGroup>

              {/* Market focus was a page of its own for one control. Set once by an admin, so it
                  sits here with the company. */}
              <SettingsGroup title="Market focus">
                <div className="px-2 py-2"><MarketFocus /></div>
              </SettingsGroup>

              {cloud.settings?.generalGroups?.map((Group, i) => <Group key={i} />)}
            </SectionShell>
          )}

          {/* ── Instance setup (self-host only, GET-837) ── */}
          {section === "instance" && (
            <SectionShell title="Instance setup" description="What this install has configured.">
              <InstanceSetup />
            </SectionShell>
          )}

          {/* ── Members (GET-637, board SettingsMembers) ── */}
          {section === "members" && (
            <SectionShell title="Members" description="Who works in this workspace.">
              {/* Invite a teammate: set their name, access and GTM role now and hand them ONE
                  command. When they run `nous join` they are already scoped to their role. */}
              {isWorkspaceAdmin && (
                <SettingsGroup title="Invite a teammate">
                  <div className="flex flex-wrap items-center gap-2 px-2 py-2">
                    <label htmlFor="m-name" className="sr-only">Name</label>
                    <input id="m-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Name" className={inviteFieldCls + " flex-[1_1_100px]"} />
                    <label htmlFor="m-email" className="sr-only">Email</label>
                    <input id="m-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="email@example.com" className={inviteFieldCls + " flex-[1_1_150px]"} />
                    <label htmlFor="m-access" className="sr-only">Workspace access</label>
                    <Select value={inviteRole} onValueChange={setInviteRole}>
                      <SelectTrigger id="m-access" title="Workspace access" className={cn(selectCls, "w-[104px] flex-none")}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <label htmlFor="m-role" className="sr-only">GTM role</label>
                    {/* Unset shows the placeholder; "Not set" clears a pick. */}
                    <Select value={inviteGtmRole} onValueChange={(v) => setInviteGtmRole(v === NONE ? "" : v)}>
                      <SelectTrigger id="m-role" title="GTM role" className={cn(selectCls, "w-[136px] flex-none")}><SelectValue placeholder="GTM role" /></SelectTrigger>
                      <SelectContent>
                        {JOB_ROLE_OPTIONS.map((o) => <SelectItem key={o.value || NONE} value={o.value || NONE}>{o.value ? o.label : "Not set"}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button onClick={generateJoinCommand} disabled={joinGenerating}>{joinGenerating ? "Creating…" : "Create invite"}</Button>
                  </div>
                  {joinCmd && (
                    <div className="px-2 pb-1">
                      <button
                        type="button"
                        onClick={async () => { await navigator.clipboard?.writeText(joinCmd).catch(() => {}); setJoinCopied(true); toast.success("Copied."); }}
                        className="flex w-full items-center justify-between gap-2 rounded-lg bg-muted px-2.5 py-2 text-left font-mono text-[11.5px] text-foreground transition-colors duration-fast hover:bg-hover"
                        title="Copy"
                      >
                        <span className="truncate">{joinCmd}</span>
                        {joinCopied ? <Check className="h-3.5 w-3.5 flex-shrink-0 text-positive" /> : <Copy className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
                      </button>
                    </div>
                  )}
                </SettingsGroup>
              )}

              <SettingsGroup title="People" bodyClassName="overflow-x-auto">
                {teamLoading && members.length === 0 ? (
                  <div className="px-2 py-2 text-[13px] text-muted-foreground/70">Loading…</div>
                ) : (
                  <table className="w-full min-w-[560px] border-collapse text-[13px]">
                    <thead>
                      <tr className="text-left text-[11.5px] text-muted-foreground/70">
                        <th className="h-8 px-2 font-normal">Name</th>
                        <th className="h-8 px-2 font-normal">Access</th>
                        <th className="h-8 px-2 font-normal">GTM role</th>
                        <th className="h-8 w-12 px-2"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => {
                        const uid = m.user_id ?? m.id;
                        const isSelf = uid === userData?.user?.id;
                        const isFounder = String(m.role ?? "").toLowerCase() === "founder";
                        const mName = m.name ?? m.users?.name ?? m.user?.name ?? "—";
                        const mEmail = m.email ?? m.users?.email ?? m.user?.email ?? "";
                        const avatar = m.profile_picture_url ?? m.users?.profile_picture_url ?? m.user?.profile_picture_url ?? null;
                        // Only an admin, and only on someone who isn't the founder or themselves.
                        const canEditRole = isWorkspaceAdmin && !isFounder && !isSelf;
                        return (
                          <tr key={m.id ?? m.user_id} className="transition-colors duration-fast hover:bg-hover [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg">
                            <td className="h-10 px-2">
                              {/* The palette's row: avatar, the name, its email beside it in the quiet tone. */}
                              <span className="flex min-w-0 items-center gap-2.5">
                                {avatar
                                  ? <img src={avatar} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                                  : <PersonAvatar person={{ id: String(uid), name: mName === "—" ? mEmail : mName }} size={24} />}
                                <span className="flex min-w-0 items-baseline gap-2">
                                  <span className="truncate text-foreground">
                                    {mName}{isSelf && <span className="ml-1 text-muted-foreground/60">(you)</span>}
                                  </span>
                                  <span className="truncate text-[11.5px] text-muted-foreground/70">{mEmail}</span>
                                </span>
                              </span>
                            </td>
                            <td className="h-10 px-2">
                              {canEditRole ? (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button type="button" aria-label={`Access for ${mName}`} className={ghostSelectCls}>
                                      {roleLabel(m.role)}<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="start" className="w-36">
                                    <DropdownMenuRadioGroup value={roleValue(m.role)} onValueChange={(v) => changeMemberRole(uid, v)}>
                                      <DropdownMenuRadioItem value="admin">Admin</DropdownMenuRadioItem>
                                      <DropdownMenuRadioItem value="member">Member</DropdownMenuRadioItem>
                                    </DropdownMenuRadioGroup>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              ) : (
                                <span className="inline-flex h-[26px] items-center px-2 text-[12.5px] text-ink-2">
                                  {isFounder ? "Founder" : roleLabel(m.role)}
                                </span>
                              )}
                            </td>
                            <td className="h-10 px-2">
                              {/* GTM role(s): they drive this person's Reporting tabs and Coaching. */}
                              <MemberRoleEditor roles={memberRoles[uid] ?? []} onChange={(r) => saveMemberRoles(uid, r)} disabled={!isWorkspaceAdmin} />
                            </td>
                            <td className="h-10 px-2 text-right">
                              {isWorkspaceAdmin && !isSelf && !isFounder && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button type="button" aria-label={`More for ${mName}`} className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
                                      <MoreHorizontal className="h-4 w-4" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem className="text-risk focus:text-risk" onSelect={() => removeMember(uid)}>
                                      <Trash2 className="mr-2 h-3.5 w-3.5" />Remove from workspace
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {/* Pending invitations sit in the same list, greyed, until they are accepted. */}
                      {invitations.map((inv) => (
                        <tr key={inv.id} className="text-muted-foreground/70 transition-colors duration-fast hover:bg-hover [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg">
                          <td className="h-10 px-2">
                            <span className="flex min-w-0 items-center gap-2.5">
                              <PersonAvatar person={{ id: String(inv.id), name: String(inv.email ?? "?") }} size={24} />
                              <span className="flex min-w-0 items-baseline gap-2">
                                <span className="truncate text-foreground/80">{inv.email}</span>
                                <span className="truncate text-[11.5px]">{inv.created_at ? `Invited ${when(inv.created_at)}` : "Invited"}</span>
                              </span>
                            </span>
                          </td>
                          <td className="h-10 px-2">{roleLabel(inv.role)}</td>
                          <td className="h-10 px-2">—</td>
                          <td className="h-10 px-2 text-right">
                            <span className="inline-flex items-center gap-1">
                              {inv.token && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    navigator.clipboard?.writeText(`${window.location.origin}/accept-invitation?token=${inv.token}`);
                                    toast.success("Invite link copied");
                                  }}
                                >
                                  Copy link
                                </Button>
                              )}
                              <Button variant="ghost" size="sm" onClick={() => cancelInvitation(inv.id)}>Revoke</Button>
                            </span>
                          </td>
                        </tr>
                      ))}
                      {members.length === 0 && invitations.length === 0 && (
                        <tr><td colSpan={4} className="px-2 py-2 text-[13px] text-muted-foreground/70">No members yet</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </SettingsGroup>
            </SectionShell>
          )}

          {/* ── Embedded full pages ── Integrations + Webhooks keep their own header
              (title + actions), so they render straight into the pane. API keys and
              Billing drop their header when embedded, so they get a title tile here to
              match every other section. */}
          {section === "governance" && (
            <SectionShell title="Governance" wide>
              {/* ── The estate at a glance — everything Nous holds for this workspace.
                  Same strip as the Overview / connect page: tiny label on top, one big
                  number, one quiet sub-line; divided cells in a single frame. ── */}
              {govEstate && (
                <div className="mb-6 flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-card sm:flex-row">
                  {[
                    { label: "Accounts",     value: (govEstate.accounts ?? 0).toLocaleString(),     sub: `${(govEstate.people ?? 0).toLocaleString()} people` },
                    { label: "Observations", value: (govEstate.observations ?? 0).toLocaleString(), sub: `${(govEstate.sources ?? 0).toLocaleString()} sources` },
                    { label: "Members",      value: (govEstate.members ?? 0).toLocaleString(),      sub: "in this workspace" },
                  ].map((t, i, arr) => (
                    <div key={t.label} className={`flex-1 px-5 py-4 ${i < arr.length - 1 ? "border-b border-hairline sm:border-b-0 sm:border-r" : ""}`}>
                      <div className="truncate text-[11px] font-medium text-muted-foreground/55">{t.label}</div>
                      <div className="mt-2 text-[26px] font-semibold leading-none tabular-nums tracking-tight text-foreground">{t.value}</div>
                      <div className="mt-1.5 truncate text-[11.5px] text-muted-foreground/60">{t.sub}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Access control — who can see the accounts. Presented as two
                  selectable modes rather than a bare switch: the active mode is
                  ringed and checked; picking the other opens the confirm dialog. ── */}
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <div className="text-[11px] font-medium text-muted-foreground/60">Access control</div>
                <span className="text-[10.5px] text-muted-foreground/50">{isWsAdmin ? "Governs account visibility" : "Owner or admin only"}</span>
              </div>
              <div className="mb-6 grid gap-2.5 sm:grid-cols-2">
                {[
                  { open: false, icon: Lock,  title: "Owner-scoped", desc: "Reps see only the accounts they own or are in touch with. You and other admins always see everything." },
                  { open: true,  icon: Globe, title: "Open to everyone", desc: "Every rep, and their agents, sees every account and person. Accounts still keep an owner." },
                ].map((o) => {
                  const active = openVisibility === o.open;
                  const Icon = o.icon;
                  return (
                    <button
                      key={o.title}
                      type="button"
                      disabled={!isWsAdmin || active}
                      onClick={() => requestToggle(o.open)}
                      aria-pressed={active}
                      className={`group relative flex flex-col gap-2.5 rounded-xl border p-4 text-left transition-all ${
                        active
                          ? "border-foreground/25 bg-card shadow-sm ring-1 ring-foreground/15"
                          : "border-border bg-card/40 hover:border-foreground/20 hover:bg-card"
                      } ${!isWsAdmin ? "cursor-not-allowed opacity-70" : active ? "cursor-default" : "cursor-pointer"}`}
                    >
                      <div className="flex w-full items-center justify-between">
                        <span className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${active ? "bg-foreground text-background" : "bg-muted text-muted-foreground/70"}`}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className={`flex h-4 w-4 items-center justify-center rounded-full border transition-colors ${active ? "border-foreground bg-foreground text-background" : "border-border text-transparent"}`}>
                          <Check className="h-2.5 w-2.5" strokeWidth={3} />
                        </span>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-foreground">{o.title}</span>
                          {active && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground/70">Active</span>}
                        </div>
                        <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground/75">{o.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* ── Team & ownership — who owns and touches what ── */}
              {govMembers.length > 0 && (
                <div className="mb-6">
                  <div className="mb-2.5 flex items-center justify-between gap-3">
                    <div className="text-[11px] font-medium text-muted-foreground/60">Team &amp; ownership</div>
                    <span className="text-[10.5px] text-muted-foreground/50">{govMembers.length} {govMembers.length === 1 ? "member" : "members"}</span>
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-border/70 bg-card p-2">
                    {govMembers.map((m) => (
                      <div key={m.user_id} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-fast hover:bg-hover">
                        <div className="h-6 w-6 flex-shrink-0 rounded-full bg-muted overflow-hidden flex items-center justify-center text-[10.5px] font-medium text-muted-foreground/70">
                          {m.avatar ? <img src={m.avatar} alt="" className="h-full w-full object-cover" /> : (m.name?.charAt(0).toUpperCase() || "?")}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] text-foreground">{m.name}</span>
                            <span className="inline-flex flex-shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground/70 capitalize">{m.role}</span>
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-5 sm:gap-7">
                          {[
                            { label: "Owns", value: m.accounts_owned },
                            { label: "In touch", value: m.accounts_in_touch },
                            { label: "Observations", value: m.observations },
                          ].map((c) => (
                            <div key={c.label} className="text-right">
                              <div className="text-[14px] font-semibold leading-none text-foreground tabular-nums">{(c.value ?? 0).toLocaleString()}</div>
                              <div className="mt-1 text-[9.5px] text-muted-foreground/55">{c.label}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}


              {/* ── Access log — the provenance trail ── */}
              <div className="mb-2.5 flex items-center justify-between gap-3">
                <div className="text-[11px] font-medium text-muted-foreground/60">Access log</div>
                {accessLog.length > 0 && (
                  <button
                    onClick={exportAuditLog}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <Upload className="h-3 w-3" /> Export CSV
                  </button>
                )}
              </div>

              <AlertDialog open={confirmVisOpen} onOpenChange={setConfirmVisOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {pendingVis ? "Let everyone see all accounts?" : "Restrict accounts to their owners?"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {pendingVis
                        ? "Every rep in this workspace will be able to see every account and person, and so will their agents. Accounts keep their owner. This does not open up message contents — emails and DMs stay private to whoever is in touch with the account, and to admins. You can switch this back at any time."
                        : "Reps will only see the accounts they own or are in touch with, on the Accounts and People pages. You and other admins will still see everything. This controls which accounts are listed, not what is inside them. You can switch this back at any time."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={applyVisibility}>
                      {pendingVis ? "Open to everyone" : "Restrict to owners"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              {accessLogLoading ? (
                <div className="rounded-xl border border-border bg-card px-4 py-6 text-center text-[13px] text-muted-foreground/60">Loading…</div>
              ) : accessLog.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-[13px] text-muted-foreground/50">No access events yet.</div>
              ) : (
                <div className="overflow-hidden rounded-2xl border border-border/70 bg-card p-2">
                  {accessLog.map((e) => {
                    const acct = e.account_name || "an account";
                    const who = e.member_name || "someone";
                    const actor = e.actor_name || "Someone";
                    const label = e.meta_label || "a source";
                    const keyLabel = e.meta_label ? `API key "${e.meta_label}"` : "an API key";
                    const isCred = ["apikey.created", "apikey.revoked", "cli.token_issued", "integration.connect", "integration.disconnect"].includes(e.action);
                    const sentence =
                      e.action === "ownership.assigned" ? `${actor} assigned ${who} as owner of ${acct}`
                      : e.action === "ownership.removed" ? `${actor} removed ${who} from ${acct}`
                      : e.action === "access.granted" ? `${who} gained access to ${acct}`
                      : e.action === "apikey.created" ? `${actor} created ${keyLabel}`
                      : e.action === "apikey.revoked" ? `${actor} revoked ${keyLabel}`
                      : e.action === "cli.token_issued" ? `${actor} signed in with the CLI`
                      : e.action === "integration.connect" ? `${actor} connected ${label}`
                      : e.action === "integration.disconnect" ? `${actor} disconnected ${label}`
                      : e.action === "member.role_changed" ? `${actor} made ${who} ${e.meta_label === "admin" ? "an admin" : "a member"}`
                      : `${actor} — ${e.action}`;
                    const tag = e.via === "manual" ? "manual" : e.via === "co-attendance" ? "co-attendance"
                      : e.action.startsWith("integration.") ? "integration"
                      : e.action === "member.role_changed" ? "role"
                      : isCred ? "credential" : null;
                    const isActorEvent = isCred || e.action === "member.role_changed";
                    const avatarName = isActorEvent ? actor : who;
                    const avatarImg = isActorEvent ? null : e.member_avatar;
                    return (
                      <div key={e.id} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-fast hover:bg-hover">
                        <div className="h-6 w-6 flex-shrink-0 rounded-full bg-muted overflow-hidden flex items-center justify-center text-[10.5px] font-medium text-muted-foreground/70">
                          {avatarImg ? <img src={avatarImg} alt="" className="h-full w-full object-cover" /> : (avatarName.charAt(0).toUpperCase() || "?")}
                        </div>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="truncate text-[13px] text-foreground">{sentence}</span>
                          {tag && <span className="inline-flex flex-shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[9.5px] font-medium text-muted-foreground/70">{tag}</span>}
                        </div>
                        <div className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground/50">
                          {new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionShell>
          )}

          {/* Automations — the built-in automations OpenNous ships (on/off) plus the user's own
              custom sequences. Rendered inside the standard section shell so the title sits like
              every other settings page. */}
          {section === "sequences" && (
            <SectionShell title="Workflows" wide>
              <AutomationsPanel />
            </SectionShell>
          )}

          {/* Insights config (watch-topic categories) moved to the company surface → Categories tab. */}
          {section === "integrations" && <SectionShell wide><Integrations embedded scope="personal" onWrongScope={forwardSource} /></SectionShell>}
          {section === "company-sources" && <SectionShell wide><Integrations embedded scope="company" onWrongScope={forwardSource} /></SectionShell>}
          {section === "webhooks"     && <SectionShell wide><Webhooks embedded /></SectionShell>}
          {/* Full width, like the other connection pages (GET-668). */}
          {/* Agent activity (GET-898, GET-900): when, how often and about what agents called the API and MCP. */}
          {section === "activity-log" && <SectionShell title="Agent activity" wide><ApiActivity /></SectionShell>}
          {section === "repo"         && <RepositoriesPane token={token ?? ""} workspaceId={workspaceId} />}
          {/* The Workspace layer's sections (memory, skills, config, models, changes, spend,
              adoption, reporting, insights, categories, agents, runs), each with its own shell. */}
          {CloudSection && section !== "billing" && (
            <Suspense fallback={null}><CloudSection token={token ?? ""} workspaceId={workspaceId} /></Suspense>
          )}
          {section === "api-keys"     && (
            <SectionShell title="API keys" wide>
              <ApiKeys embedded />
            </SectionShell>
          )}
          {/* Billing. Custom gets the contract view (GET-637); on the API plan this section
              redirects to /usage above, and an embedded caller still gets the Usage page. */}
          {section === "billing"      && (
            core || !CloudBilling ? (
              <SectionShell title="Usage and billing" wide>
                <UsageBilling embedded />
              </SectionShell>
            ) : (
              <Suspense fallback={null}><CloudBilling token={token ?? ""} workspaceId={workspaceId} /></Suspense>
            )
          )}

        </div>
       </div>
      </main>
    </div>
  );
}
