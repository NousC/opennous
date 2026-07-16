import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Mail, Linkedin, Key, Copy, CheckCircle2, ArrowRight, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { watchOAuthPopup } from "@/lib/oauthPopup";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// Lightweight setup for a teammate who JOINED an existing workspace (role member).
// The workspace itself (ICP, playbook, data, positioning) is already set up by the
// owner and shared — a member must NOT redo that. All a member needs is to connect
// THEIR OWN accounts (so their touches attribute to them and stay private to them)
// and mint THEIR member-scoped agent key. See PRIVACY_MODEL.md.
export default function MemberSetup() {
  const { session, userData } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const teamName = userData?.team?.name || "the team";

  const [gmailDone, setGmailDone] = useState(false);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [liDone, setLiDone] = useState(false);
  const [liBusy, setLiBusy] = useState(false);

  const [keyName] = useState("My agent");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reflect a LinkedIn account that's already connected for this workspace.
  const refreshLinkedIn = useCallback(async () => {
    if (!token || !workspaceId) return;
    try {
      const res = await fetch(`${apiUrl}/api/linkedin/status?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json().catch(() => ({}));
      if (d?.connected) setLiDone(true);
    } catch { /* non-fatal */ }
  }, [token, workspaceId]);

  useEffect(() => { refreshLinkedIn(); }, [refreshLinkedIn]);

  const connectGmail = async () => {
    if (!token || !workspaceId) return;
    setGmailBusy(true);
    try {
      const url = `${apiUrl}/api/oauth/google/gmail/authorize?workspaceId=${workspaceId}&connectionName=${encodeURIComponent("Gmail")}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error("Couldn't start the Gmail connection");
      const data = await resp.json();
      const authUrl = data.authUrl || data.authorization_url;
      if (!authUrl) throw new Error("No authorization URL returned");
      const w = 600, h = 700;
      window.open(authUrl, "gmailOAuth", `width=${w},height=${h},left=${window.screenX + (window.outerWidth - w) / 2},top=${window.screenY + (window.outerHeight - h) / 2}`);
      watchOAuthPopup({ onClose: () => { setGmailBusy(false); setGmailDone(true); toast.success("Gmail connected"); } });
    } catch (err: any) { toast.error(err.message || "Failed to connect Gmail"); setGmailBusy(false); }
  };

  const connectLinkedIn = async () => {
    if (!token || !workspaceId) return;
    setLiBusy(true);
    try {
      const res = await fetch(`${apiUrl}/api/linkedin/connect?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || e.error || "Couldn't start LinkedIn connection"); }
      const { url } = await res.json();
      const w = 600, h = 700;
      window.open(url, "LinkedInUnipile", `width=${w},height=${h},left=${window.screenX + (window.outerWidth - w) / 2},top=${window.screenY + (window.outerHeight - h) / 2}`);
      const onMessage = (e: MessageEvent) => {
        if (e.data?.type !== "linkedin_auth") return;
        window.removeEventListener("message", onMessage);
        setLiBusy(false);
        if (e.data.success) { setLiDone(true); toast.success("LinkedIn connected"); }
        else toast.error("LinkedIn connection failed. Please try again.");
      };
      window.addEventListener("message", onMessage);
      watchOAuthPopup({ onClose: () => { window.removeEventListener("message", onMessage); setLiBusy(false); refreshLinkedIn(); } });
    } catch (err: any) { toast.error(err.message || "Failed to connect LinkedIn"); setLiBusy(false); }
  };

  const createKey = async () => {
    if (!token || !workspaceId) return;
    setCreating(true);
    try {
      const res = await fetch(`${apiUrl}/api/workspace/api-keys`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName, workspace_id: workspaceId }),
      });
      const data = await res.json();
      if (data.key) setRevealed(data.key);
      else throw new Error(data.error || "Couldn't create your key");
    } catch (err: any) { toast.error(err.message || "Failed to create key"); }
    finally { setCreating(false); }
  };

  const copyKey = () => {
    if (!revealed) return;
    navigator.clipboard.writeText(revealed);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  const Row = ({ icon, title, desc, done, busy, onClick, cta }: {
    icon: React.ReactNode; title: string; desc: string; done: boolean; busy: boolean; onClick: () => void; cta: string;
  }) => (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-background p-4">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/70">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-foreground">{title}</p>
        <p className="text-[12px] text-muted-foreground/80">{desc}</p>
      </div>
      {done ? (
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Connected</span>
      ) : (
        <Button onClick={onClick} disabled={busy} className="h-8 rounded-lg bg-primary px-3 text-[13px] text-primary-foreground hover:bg-primary/90">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : cta}
        </Button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-muted/30 flex items-center justify-center p-6">
      <div className="w-full max-w-[560px] rounded-2xl border border-border bg-background p-7 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">Welcome to {teamName}</p>
        <h1 className="mt-1 text-[19px] font-bold text-foreground">Two quick steps to make it yours</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground/90">
          Your team's workspace is already set up, so you're skipping the heavy part. Connect your own accounts so your
          conversations flow in under you, then grab your agent key. Your raw emails and messages stay private to you.
        </p>

        <div className="mt-6 space-y-2.5">
          <Row icon={<Mail className="h-4 w-4" />} title="Connect your Gmail" desc="Your emails attribute to you, and stay private to you." done={gmailDone} busy={gmailBusy} onClick={connectGmail} cta="Connect" />
          <Row icon={<Linkedin className="h-4 w-4" />} title="Connect your LinkedIn" desc="Your DMs and connections, tracked under your name." done={liDone} busy={liBusy} onClick={connectLinkedIn} cta="Connect" />

          {/* Agent key */}
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-center gap-4">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/70"><Key className="h-4 w-4" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-foreground">Get your agent key</p>
                <p className="text-[12px] text-muted-foreground/80">Your own key, scoped to you. Paste it into Claude Code / your MCP client.</p>
              </div>
              {!revealed && (
                <Button onClick={createKey} disabled={creating} className="h-8 rounded-lg bg-primary px-3 text-[13px] text-primary-foreground hover:bg-primary/90">
                  {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create key"}
                </Button>
              )}
            </div>
            {revealed && (
              <div className="mt-3 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
                <p className="text-[12px] font-medium text-emerald-700">Copy it now — this is the only time it's shown.</p>
                <div className="flex gap-2">
                  <input value={revealed} readOnly className="flex-1 rounded-lg border border-emerald-200 bg-background px-3 py-2 font-mono text-[12px] text-foreground outline-none" />
                  <button onClick={copyKey} className="rounded-lg border border-emerald-200 bg-background px-3 py-2 hover:bg-emerald-50">
                    {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4 text-muted-foreground/70" />}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <button onClick={() => navigate("/ops")} className="text-[12px] text-muted-foreground/70 hover:text-foreground">Skip for now</button>
          <Button onClick={() => navigate("/ops")} className="h-9 rounded-lg bg-primary px-4 text-[13px] text-primary-foreground hover:bg-primary/90">
            Go to workspace <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
