import { useState, useEffect, useRef, type ComponentType, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sun, Moon, Monitor, LogOut, Plus, Trash2, X,
  Link2, Calendar, Upload, ArrowRight,
  FileText, Megaphone, Map, ScrollText, Image as ImageIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { generateCodename, type SettingsTab } from "@/components/mind/shared";
import { PageHeader } from "@/components/ui/page-header";
import UsageBilling from "@/pages/UsageBilling";
import ApiKeys from "@/pages/ApiKeys";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// The jobs a member can tell their agent they do. Values must stay in lockstep
// with JOB_ROLES in apps/api/src/routes/api/me.mjs — the API rejects anything
// it doesn't recognise, and the agent turns the value into a brief.
const JOB_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: "",                  label: "Not set" },
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

// Operator-only admin tools. The Admin tab + these routes are gated on
// userData.user.is_admin, which the API only reports for allowlisted emails
// (ADMIN_EMAILS, empty on self-host) — so self-hosters never see this.
const ADMIN_LINKS: { label: string; path: string; icon: ComponentType<{ className?: string }> }[] = [
  { label: "CMS",       path: "/admin/cms",       icon: FileText },
  { label: "Updates",   path: "/admin/updates",   icon: Megaphone },
  { label: "Roadmap",   path: "/admin/roadmap",   icon: Map },
  { label: "Changelog", path: "/admin/changelog", icon: ScrollText },
  { label: "Media",     path: "/admin/media",     icon: ImageIcon },
];

// ─── Real brand icons (rendered in currentColor / black) ─────────────────────
const WhatsAppIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347M12.05 21.785h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
  </svg>
);

const GmailIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 010 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
  </svg>
);

// TODO: swap for the real Cal.com brand SVG once you grab it.
// Using Calendar from lucide as a stand-in — it's recognisable and ships in 24x24.
const CalIcon = ({ className }: { className?: string }) => <Calendar className={className} />;

function ThemeIconBtn({
  active, onClick, icon: Icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`inline-flex items-center justify-center h-8 w-8 rounded-md transition-colors ${
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

export default function Settings() {
  const { userData, session, refreshUserData, signOut } = useAuth();
  const navigate = useNavigate();
  const isAdmin = userData?.user?.is_admin === true;
  // Agora (founder contact + the cloud Friends page) is a Nous Cloud community
  // surface — never shown on a self-hosted instance.
  const selfHosted = (userData as { self_hosted?: boolean })?.self_hosted === true;
  const handleSignOut = async () => { try { await signOut(); } catch { /* ignore */ } };
  const { mode, setMode } = useTheme();
  const token = session?.access_token;
  const teamId = userData?.team?.id;
  const workspaceId = userData?.workspace?.id ?? "";

  const [tab, setTab] = useState<SettingsTab>("profile");

  // Cloud-only UI (e.g. the founder support card). Same signal the rest of the
  // app uses to tell Nous Cloud apart from a self-hosted instance.
  const isCloud = !!import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

  // Profile
  const [name, setName] = useState(userData?.user?.name ?? "");
  const [nameSaving, setNameSaving] = useState(false);

  // ── Agent personalization (this member, this workspace) ──
  // The agent reads the same verified record for everyone; these two fields tell
  // it what job the reader is doing on top of it.
  const [jobRole, setJobRole] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentLoaded, setAgentLoaded] = useState(false);

  // Team
  const [members, setMembers] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(userData?.team?.name ?? "");
  const [wsNameSaving, setWsNameSaving] = useState(false);

  // Company name + website are stored on the workspace row so they round-trip
  // cleanly between onboarding (which writes them) and Settings (which edits).
  const [companyName, setCompanyName] = useState(userData?.workspace?.name ?? "");
  const [companyUrl, setCompanyUrl] = useState(userData?.workspace?.website ?? "");
  const [companySaving, setCompanySaving] = useState(false);
  const saveCompany = async () => {
    if (!token || !workspaceId) {
      toast.error("Workspace not ready yet — try again in a moment.");
      return;
    }
    setCompanySaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: companyName.trim() || undefined,
          website: companyUrl.trim(),
        }),
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

  // Agora
  const [msgType, setMsgType] = useState<"idea" | "bug">("idea");
  const [msgText, setMsgText] = useState("");
  const [videoLink, setVideoLink] = useState("");
  const [msgSending, setMsgSending] = useState(false);
  const [friendsOptIn, setFriendsOptIn] = useState(false);

  const submitMsg = async () => {
    if (!msgText.trim() || msgSending) return;
    if (!token) {
      toast.error("Please sign in to send feedback.");
      return;
    }
    setMsgSending(true);
    try {
      const payload = {
        type: msgType,
        message: msgText.trim(),
        videoLink: videoLink.trim() || null,
        companyName: companyName.trim() || null,
        companyUrl: companyUrl.trim() || null,
        context: {
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          url: window.location.href,
        },
      };
      const res = await fetch(`${apiUrl}/api/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      toast.success("Got it. Bennet will reply personally.");
      setMsgText("");
      setVideoLink("");
    } catch (err) {
      console.error("feedback submit failed:", err);
      toast.error("Couldn't send right now. Try again?");
    } finally {
      setMsgSending(false);
    }
  };
  const onLogoUpload = () => toast.message("Logo upload — coming soon.");

  useEffect(() => {
    setName(userData?.user?.name ?? "");
    setWorkspaceName(userData?.team?.name ?? "");
    setCompanyName(userData?.workspace?.name ?? "");
    setCompanyUrl(userData?.workspace?.website ?? "");
  }, [userData]);

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
    } finally { setTeamLoading(false); }
  };

  useEffect(() => {
    if (tab === "team") loadTeam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  // Load this member's agent profile once the profile tab is open.
  useEffect(() => {
    if (tab !== "profile" || !token || !workspaceId || agentLoaded) return;
    fetch(`${apiUrl}/api/me/agent-profile?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        setJobRole(d.job_role ?? "");
        setAgentInstructions(d.agent_instructions ?? "");
      })
      .catch(() => { /* falls back to empty — the agent just stays generic */ })
      .finally(() => setAgentLoaded(true));
  }, [tab, token, workspaceId, agentLoaded]);

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
          agent_instructions: agentInstructions,
        }),
      });
      if (res.ok) toast.success("Your agent has been updated");
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || "Failed to save"); }
    } catch { toast.error("Failed to save"); }
    finally { setAgentSaving(false); }
  };

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
        toast.error(data.error || "Failed to send invitation");
      }
    } finally { setInviting(false); }
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

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: "profile",  label: "Profile"  },
    { id: "team",     label: "Team"     },
    // Moved out of the Setup nav: a key is an account-level knob, not a surface
    // you visit. It belongs next to the rest of them.
    { id: "api-keys", label: "API Keys" },
    // Billing left the sidebar: nobody navigates to billing, they go and find it.
    { id: "usage",    label: "Billing"  },
    ...(selfHosted ? [] : [{ id: "agora" as SettingsTab, label: "Agora" }]),
    ...(isAdmin ? [{ id: "admin" as SettingsTab, label: "Admin" }] : []),
  ];

  // ── shared styles (work in both light + dark) ─────────────────────────────
  const inputCls =
    "w-full bg-background border border-border rounded-lg px-3 py-2 text-[13px] text-foreground " +
    "outline-none focus:border-foreground/40 transition-colors placeholder:text-muted-foreground/70";
  // Light: dark fill + light text (shadcn default). Dark: elevated-dark + white
  // text (Mem0 style), so the button doesn't punch out as bright white.
  const primaryBtn =
    "h-9 px-3.5 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40 flex-shrink-0 " +
    "bg-foreground text-background hover:bg-foreground/90 " +
    "dark:bg-muted dark:text-foreground dark:hover:bg-muted/70 dark:border dark:border-border";
  const fieldLabel = "text-[12px] font-medium text-muted-foreground mb-1.5";
  const contactRowCls =
    "flex items-center gap-2.5 text-[13px] text-foreground/80 hover:text-foreground py-1.5 transition-colors";

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="px-8 py-7">
        <PageHeader
          title="Settings"
          actions={
            <>
              <div className="inline-flex items-center h-9 rounded-lg border border-border bg-background p-0.5">
                <ThemeIconBtn active={mode === "light"}  onClick={() => setMode("light")}  icon={Sun}     label="Light" />
                <ThemeIconBtn active={mode === "system"} onClick={() => setMode("system")} icon={Monitor} label="Match system" />
                <ThemeIconBtn active={mode === "dark"}   onClick={() => setMode("dark")}   icon={Moon}    label="Dark" />
              </div>
              <button
                onClick={handleSignOut}
                aria-label="Log out"
                title="Log out"
                className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-background border border-border text-foreground/80 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </>
          }
        />

        {/* Tabs */}
        <div className="flex gap-6 border-b border-border mb-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`pb-2.5 text-[13px] font-medium transition-colors ${
                tab === t.id
                  ? "text-foreground border-b-2 border-foreground -mb-px"
                  : "text-muted-foreground/70 hover:text-foreground/80"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── API Keys ── the page itself, minus its shell */}
        {tab === "api-keys" && <ApiKeys embedded />}
        {tab === "usage" && <UsageBilling embedded />}

        {/* ── Profile ── */}
        {tab === "profile" && (
          <div className="max-w-sm">
            <h3 className="text-[15px] font-semibold text-foreground mb-5">Profile</h3>
            <div className="space-y-5">
              <div>
                <div className={fieldLabel}>Profile picture</div>
                <div className="flex items-center gap-3.5">
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarSaving}
                    title="Upload a new picture"
                    className="group relative h-12 w-12 shrink-0 rounded-full overflow-hidden border border-border bg-muted flex items-center justify-center"
                  >
                    {userData?.user?.profile_picture_url
                      ? <img src={userData.user.profile_picture_url} alt="" className="h-full w-full object-cover" />
                      : <span className="text-[16px] font-semibold text-muted-foreground/70">{(name || userData?.user?.email || "?").trim().charAt(0).toUpperCase()}</span>}
                    <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Upload className="h-3.5 w-3.5 text-white" />
                    </span>
                  </button>
                  <div className="flex items-center gap-2.5 text-[12px]">
                    <button onClick={() => avatarInputRef.current?.click()} disabled={avatarSaving} className="font-medium text-muted-foreground/80 hover:text-foreground transition-colors">
                      {avatarSaving ? "Saving…" : userData?.user?.profile_picture_url ? "Change" : "Upload"}
                    </button>
                    {userData?.user?.profile_picture_url && (
                      <>
                        <span className="text-muted-foreground/30">·</span>
                        <button onClick={() => saveAvatar(null)} disabled={avatarSaving} className="text-muted-foreground/50 hover:text-foreground transition-colors">
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                  <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={onAvatarPick} />
                </div>
              </div>
              <div>
                <div className={fieldLabel}>Email</div>
                <div className="text-[13px] text-muted-foreground">{userData?.user?.email}</div>
              </div>
              <div>
                <div className={fieldLabel}>Display name</div>
                <div className="flex items-center gap-2">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveName(); }}
                    className={inputCls}
                  />
                  <button onClick={saveName} disabled={nameSaving || !name.trim()} className={primaryBtn}>
                    {nameSaving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <div>
                <div className={fieldLabel}>Workspace codename</div>
                <div className="text-[13px] text-muted-foreground/70">
                  {workspaceId ? generateCodename(workspaceId) : "—"}
                </div>
              </div>
            </div>

            {/* ── Your agent ──
                Everyone in the workspace reads the same verified record. What
                changes is the job you're doing on top of it, so the agent asks
                who you are and what you want it to know. Scoped to you, in this
                workspace — your teammates' agents are unaffected. */}
            <div className="mt-10 pt-8 border-t border-border">
              <h3 className="text-[15px] font-semibold text-foreground mb-1">Your agent</h3>
              <p className="text-[12.5px] text-muted-foreground mb-5 leading-relaxed">
                Your agent works off the same record as everyone else here. Tell it what you
                do and what matters to you, and it will answer for your job. This applies to
                your chats only.
              </p>

              <div className="space-y-5">
                <div>
                  <div className={fieldLabel}>Your role</div>
                  <select
                    value={jobRole}
                    onChange={(e) => setJobRole(e.target.value)}
                    className={inputCls}
                  >
                    {JOB_ROLE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className={fieldLabel}>What should your agent know?</div>
                  <textarea
                    value={agentInstructions}
                    onChange={(e) => setAgentInstructions(e.target.value)}
                    rows={5}
                    maxLength={2000}
                    placeholder={
                      "Anything the record can't tell it. For example:\n" +
                      "I sell to GTM teams at 5-20 person companies. Keep briefs short and lead with the next action. Never write in a salesy tone."
                    }
                    className={`${inputCls} resize-none leading-relaxed`}
                  />
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[11px] text-muted-foreground/60">
                      {agentInstructions.length}/2000
                    </span>
                  </div>
                </div>

                <button
                  onClick={saveAgentProfile}
                  disabled={agentSaving || !agentLoaded}
                  className={primaryBtn}
                >
                  {agentSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Team ── */}
        {tab === "team" && (
          <div className="max-w-lg space-y-7">
            <div>
              <h3 className="text-[15px] font-semibold text-foreground mb-3">Workspace</h3>

              <div className="space-y-3 mb-4">
                <div>
                  <div className={fieldLabel}>Company name</div>
                  <input
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder="Acme, Inc."
                    className={inputCls}
                  />
                </div>
                <div>
                  <div className={fieldLabel}>Company website</div>
                  <input
                    value={companyUrl}
                    onChange={(e) => setCompanyUrl(e.target.value)}
                    placeholder="https://acme.com"
                    inputMode="url"
                    className={inputCls}
                  />
                  <p className="text-[11px] text-muted-foreground/60 mt-1.5">
                    Used to grab your favicon for the Friends gallery — no logo upload needed.
                  </p>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={saveCompany}
                    disabled={companySaving || (!companyName.trim() && !companyUrl.trim())}
                    className={primaryBtn}
                  >
                    {companySaving ? "Saving…" : "Save company"}
                  </button>
                </div>
              </div>

              <div className={fieldLabel}>Workspace name</div>
              <div className="flex items-center gap-2">
                <input
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveWsName(); }}
                  className={inputCls}
                />
                <button onClick={saveWsName} disabled={wsNameSaving || !workspaceName.trim()} className={primaryBtn}>
                  {wsNameSaving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[15px] font-semibold text-foreground">
                  Members{members.length > 0 && <span className="text-muted-foreground/70 font-normal"> · {members.length}</span>}
                </h3>
                <button
                  onClick={() => setShowInvite((v) => !v)}
                  className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />Invite
                </button>
              </div>

              {showInvite && (
                <div className="flex items-center gap-2 mb-4 p-3 rounded-xl border border-border bg-muted/50/60">
                  <input
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleInvite(); if (e.key === "Escape") setShowInvite(false); }}
                    placeholder="email@example.com"
                    autoFocus
                    className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-foreground/40 placeholder:text-muted-foreground/70"
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                    className="bg-background border border-border rounded-lg text-[12px] text-foreground/80 px-2 py-1.5 outline-none"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button onClick={handleInvite} disabled={inviting || !inviteEmail.trim()} className={primaryBtn}>
                    {inviting ? "…" : "Send"}
                  </button>
                  <button onClick={() => setShowInvite(false)} className="text-muted-foreground/50 hover:text-foreground/80">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}

              {teamLoading ? (
                <div className="text-[13px] text-muted-foreground/70 py-4">Loading…</div>
              ) : (
                <div className="rounded-xl border border-border divide-y divide-border/60">
                  {members.map((m) => (
                    <div key={m.id ?? m.user_id} className="flex items-center gap-3 px-3.5 py-2.5 group">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-foreground">{m.name ?? m.users?.name ?? m.user?.name ?? "—"}</div>
                        <div className="text-[11px] text-muted-foreground/70">{m.email ?? m.users?.email ?? m.user?.email ?? ""}</div>
                      </div>
                      <span className="text-[11px] text-muted-foreground/70 flex-shrink-0 capitalize">{m.role}</span>
                      {(m.user_id ?? m.id) !== userData?.user?.id && (
                        <button
                          onClick={() => removeMember(m.user_id ?? m.id)}
                          className="text-muted-foreground/50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  {members.length === 0 && (
                    <div className="text-[13px] text-muted-foreground/70 px-3.5 py-4">No members yet</div>
                  )}
                </div>
              )}
            </div>

            {invitations.length > 0 && (
              <div>
                <h3 className="text-[15px] font-semibold text-foreground mb-3">Pending invitations</h3>
                <div className="rounded-xl border border-border divide-y divide-border/60">
                  {invitations.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-3 px-3.5 py-2.5 group">
                      <span className="flex-1 text-[13px] text-foreground/80">{inv.email}</span>
                      <span className="text-[11px] text-amber-600 flex-shrink-0">Pending</span>
                      {inv.token && (
                        <button
                          onClick={() => {
                            const link = `${window.location.origin}/accept-invitation?token=${inv.token}`;
                            navigator.clipboard?.writeText(link);
                            toast.success("Invite link copied");
                          }}
                          className="text-[11px] text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                        >
                          Copy link
                        </button>
                      )}
                      <button
                        onClick={() => cancelInvitation(inv.id)}
                        className="text-muted-foreground/50 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Agora ── */}
        {tab === "agora" && (
          <div className="space-y-14">
            <div className="flex flex-col lg:flex-row gap-10 lg:items-start">
              {/* LEFT — Minimal unified composer */}
              <div className="flex-1 min-w-0 lg:max-w-xl">
                <div className="inline-flex items-center rounded-full border border-border bg-background p-0.5 text-[11px] font-medium mb-4">
                  <button
                    onClick={() => setMsgType("idea")}
                    className={`px-3 py-1 rounded-full transition-colors ${
                      msgType === "idea" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Idea
                  </button>
                  <button
                    onClick={() => setMsgType("bug")}
                    className={`px-3 py-1 rounded-full transition-colors ${
                      msgType === "bug" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Bug
                  </button>
                </div>

                <textarea
                  value={msgText}
                  onChange={(e) => setMsgText(e.target.value)}
                  rows={7}
                  placeholder={
                    msgType === "idea"
                      ? "What would make Nous indispensable for you?"
                      : "What broke? Steps to reproduce, what you expected, what happened…"
                  }
                  className="w-full bg-transparent border-0 border-b border-border focus:border-foreground/50 px-0 py-2 text-[14px] text-foreground placeholder:text-muted-foreground/60 outline-none resize-none transition-colors leading-relaxed"
                />

                <div className="mt-3 flex items-center gap-2 border-b border-border/60 focus-within:border-foreground/40 transition-colors">
                  <Link2 className="h-3.5 w-3.5 text-muted-foreground/70 flex-shrink-0" />
                  <input
                    type="url"
                    value={videoLink}
                    onChange={(e) => setVideoLink(e.target.value)}
                    placeholder={msgType === "idea" ? "Paste a Loom, Tella, or any video link" : "Paste a CleanShot, screenshot, or video link"}
                    className="flex-1 bg-transparent border-0 py-2 text-[12px] text-foreground placeholder:text-muted-foreground/60 outline-none"
                  />
                </div>

                <div className="flex items-center justify-between gap-4 mt-5">
                  <p className="text-[11px] text-muted-foreground/70 italic">
                    Goes straight to the founder — personal reply.
                  </p>
                  <button
                    onClick={submitMsg}
                    disabled={!msgText.trim() || msgSending}
                    className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground/80 hover:text-foreground disabled:opacity-40 disabled:hover:text-foreground/80 transition-colors group"
                  >
                    {msgSending ? "Sending…" : "Send"}
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-disabled:transform-none" />
                  </button>
                </div>
              </div>

              {/* RIGHT — Founder card. Cloud only: self-hosters shouldn't render the
                  founder's personal phone / Cal / email as their support contact. */}
              {isCloud && (
              <div className="w-full lg:w-[460px] lg:ml-auto lg:flex-shrink-0">
                <div className="rounded-3xl p-7 bg-gray-50 dark:bg-white/[0.04] border border-gray-100 dark:border-white/10">
                  <div className="flex items-start gap-5 mb-5">
                    <div className="h-28 w-28 rounded-2xl bg-white/90 dark:bg-white/10 ring-2 ring-white dark:ring-white/20 overflow-hidden flex-shrink-0">
                      <img src="/founder.jpg" alt="Bennet Glinder" className="h-full w-full object-cover" />
                    </div>
                    <div className="pt-1 min-w-0">
                      <div className="text-[18px] font-semibold text-foreground leading-tight">Bennet Glinder</div>
                      <div className="text-[12px] text-muted-foreground mt-0.5">Founder, Nous</div>
                    </div>
                  </div>
                  <p className="text-[13px] text-foreground/85 leading-relaxed mb-6">
                    Reach me wherever feels right for you. Always up for a chat about GTM,
                    AGI, or whatever's on your mind.
                  </p>
                  {/* Support contacts are read from env so no personal number/email is
                      hardcoded in the (public) source. Cloud sets VITE_SUPPORT_*; each
                      row only renders when its value is present. */}
                  <div className="space-y-1">
                    {import.meta.env.VITE_SUPPORT_WHATSAPP && (
                    <a
                      href={`https://wa.me/${import.meta.env.VITE_SUPPORT_WHATSAPP}`}
                      target="_blank" rel="noopener noreferrer"
                      className={contactRowCls}
                    >
                      <WhatsAppIcon className="h-4 w-4 text-foreground" />
                      <span>{import.meta.env.VITE_SUPPORT_WHATSAPP_DISPLAY || import.meta.env.VITE_SUPPORT_WHATSAPP}</span>
                    </a>
                    )}
                    {import.meta.env.VITE_SUPPORT_EMAIL && (
                    <a
                      href={`mailto:${import.meta.env.VITE_SUPPORT_EMAIL}`}
                      className={contactRowCls}
                    >
                      <GmailIcon className="h-4 w-4 text-foreground" />
                      <span>{import.meta.env.VITE_SUPPORT_EMAIL}</span>
                    </a>
                    )}
                    {import.meta.env.VITE_SUPPORT_CAL && (
                    <a
                      href={import.meta.env.VITE_SUPPORT_CAL}
                      target="_blank" rel="noopener noreferrer"
                      className={contactRowCls}
                    >
                      <CalIcon className="h-4 w-4 text-foreground" />
                      <span>Let's chat about GTM, AGI, or whatever's on your mind</span>
                    </a>
                    )}
                  </div>
                </div>
              </div>
              )}
            </div>

            {/* BOTTOM — Friends, with overlapping logo-wall preview */}
            <section className="pt-2 border-t border-border/60">
              <div className="flex items-start justify-between gap-4 mt-6 mb-5">
                <div>
                  <h3 className="text-[14px] font-semibold text-foreground">Friends</h3>
                  <p className="text-[12px] text-muted-foreground/80 mt-1 max-w-md">
                    Your logo on the Friends page at opennous.cloud — alongside the others using Nous.
                  </p>
                </div>
                <Switch checked={friendsOptIn} onCheckedChange={setFriendsOptIn} />
              </div>

              {/* Overlapping logo stack (placeholders — real favicons go here once Friends ships) */}
              <div className="flex items-center">
                {["◆", "○", "△", "▢", "✦"].map((glyph, i) => (
                  <div
                    key={i}
                    className={`h-11 w-11 rounded-full bg-muted/60 ring-2 ring-background flex items-center justify-center text-muted-foreground/50 text-[14px] ${i > 0 ? "-ml-3" : ""}`}
                    style={{ zIndex: 10 - i }}
                  >
                    {glyph}
                  </div>
                ))}
                <div
                  className={`-ml-3 h-11 w-11 rounded-full ring-2 ring-background flex items-center justify-center text-[10px] font-medium border-2 border-dashed transition-colors ${
                    friendsOptIn
                      ? "border-foreground/50 text-foreground/80 bg-background"
                      : "border-border text-muted-foreground/60 bg-background"
                  }`}
                  style={{ zIndex: 1 }}
                >
                  {friendsOptIn ? "you" : "+"}
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground/50 mt-3 italic">
                Placeholders — real logos appear here once Friends ships.
              </p>

              {friendsOptIn && (
                <label className="inline-flex items-center gap-2 mt-5 text-[12px] text-muted-foreground hover:text-foreground cursor-pointer">
                  <Upload className="h-3.5 w-3.5" />
                  Upload your logo (SVG or PNG)
                  <input type="file" accept="image/svg+xml,image/png" className="hidden" onChange={onLogoUpload} />
                </label>
              )}
            </section>
          </div>
        )}

        {/* ── Admin (operator-only — hidden unless is_admin) ── */}
        {tab === "admin" && isAdmin && (
          <div className="max-w-md">
            <h3 className="text-[15px] font-semibold text-foreground mb-1.5">Admin</h3>
            <p className="text-[12px] text-muted-foreground mb-5">
              Operator tools for the hosted product. Only you can see this.
            </p>
            <div className="space-y-1.5">
              {ADMIN_LINKS.map((l) => (
                <button
                  key={l.path}
                  onClick={() => navigate(l.path)}
                  className="group flex w-full items-center justify-between rounded-lg border border-border bg-background px-3.5 py-3 text-left hover:bg-muted/40 transition-colors"
                >
                  <span className="flex items-center gap-3">
                    <l.icon className="h-4 w-4 text-muted-foreground/70" />
                    <span className="text-[13px] font-medium text-foreground">{l.label}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-foreground transition-colors" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
