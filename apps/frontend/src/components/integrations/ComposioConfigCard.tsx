import { useEffect, useState } from "react";
import { toast } from "@/components/ui/sonner";

// The "integration engine" setup card. An admin pastes their Composio project API key once;
// the box auto-provisions the Gmail + Calendar auth configs + webhook. After that, every
// member's "Connect Gmail" just works. Composio is otherwise invisible — this is the only
// place it's named.
type Status = {
  configured: boolean;
  source: "workspace" | "env" | "none";
  base_url: string | null;
  authconfig_gmail: boolean;
  authconfig_googlecalendar: boolean;
  webhook_set: boolean;
  webhook_url?: string | null;
};

export function ComposioConfigCard({ apiUrl, token, workspaceId, onConfigured, canManage = true }: { apiUrl: string; token: string; workspaceId: string; onConfigured?: (configured: boolean) => void; canManage?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = () => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/workspace/composio?workspace_id=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Status | null) => { if (d) { setStatus(d); onConfigured?.(!!d.configured); } })
      .catch(() => {});
  };
  useEffect(load, [token, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Full save (needs the API key) — provisions auth configs + tries to register the webhook.
  const save = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/workspace/composio?workspace_id=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ api_key: apiKey.trim(), webhook_secret: webhookSecret.trim() || undefined, workspace_id: workspaceId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.message || data.error || "Couldn't save the Composio key"); return; }
      toast.success(
        `Integration Engine (Composio) ready${data.webhook_set ? "" : " — add the webhook secret below to receive events"}.`,
      );
      setApiKey(""); setWebhookSecret(""); setEditing(false); load();
    } catch (e: any) {
      toast.error(e.message || "Couldn't save the Composio key");
    } finally { setSaving(false); }
  };

  // Webhook-secret-only save (key already stored) — no need to re-paste the key.
  const saveWebhookSecret = async () => {
    if (!webhookSecret.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiUrl}/api/workspace/composio?workspace_id=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ webhook_secret: webhookSecret.trim(), workspace_id: workspaceId }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.message || data.error || "Couldn't save the webhook secret"); return; }
      toast.success("Webhook secret saved — events will now arrive.");
      setWebhookSecret(""); load();
    } catch (e: any) {
      toast.error(e.message || "Couldn't save the webhook secret");
    } finally { setSaving(false); }
  };

  const configured = status?.configured;
  // Only admins manage the integration engine. Members see status only — no paste form,
  // no Reconfigure, no webhook secret.
  const showForm = canManage && (!configured || editing);
  const needsWebhook = canManage && !!configured && !status?.webhook_set;
  const webhookUrl = status?.webhook_url || "";
  const dot = (ok: boolean) => (ok ? "bg-emerald-500" : "bg-muted-foreground/40");
  const copyUrl = () => { if (webhookUrl) { navigator.clipboard?.writeText(webhookUrl); toast.success("Webhook URL copied"); } };

  return (
    <div className="rounded-xl border border-border bg-muted/30 px-4 py-3.5 mb-5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground">Integration Engine (Composio)</div>
          <div className="text-[12px] text-muted-foreground/70">
            {configured
              ? `Connected${status?.source === "env" ? " (server-configured)" : ""}. Members can connect Gmail & Calendar.`
              : canManage
                ? "Create a Composio account, then paste your API key (ak_…) once. We'll set up Gmail & Calendar automatically — your data stays on your infrastructure. Gmail & Calendar stay locked until this is connected."
                : "Not set up yet — ask an admin to connect the integration engine."}
          </div>
        </div>
        {configured && !editing && canManage && (
          <button onClick={() => setEditing(true)}
            className="text-[12px] font-medium text-muted-foreground/70 hover:text-foreground flex-shrink-0">
            Reconfigure
          </button>
        )}
      </div>

      {configured && (
        <div className="flex flex-wrap gap-4 mt-3 text-[12px] text-muted-foreground/80">
          <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${dot(!!status?.authconfig_gmail)}`} />Gmail</span>
          <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${dot(!!status?.authconfig_googlecalendar)}`} />Calendar</span>
          <span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${dot(!!status?.webhook_set)}`} />Webhook</span>
        </div>
      )}

      {/* Webhook not registered yet: show the URL to paste into Composio + a field for the
          signing secret it hands back. Gmail/Calendar connect still works without this, but
          no NEW emails/events flow in until the webhook is set. */}
      {needsWebhook && (
        <div className="mt-3 rounded-lg border border-amber-300/50 bg-amber-50 dark:border-amber-400/20 dark:bg-amber-400/10 px-3 py-2.5">
          <div className="text-[12px] font-medium text-amber-800 dark:text-amber-200">
            Webhook not set — new emails & calendar events won't arrive until it is.
          </div>
          <ol className="mt-1.5 list-decimal pl-4 text-[11.5px] text-amber-800/90 dark:text-amber-200/80 space-y-0.5">
            <li>In Composio → your project → Webhooks, add this URL:</li>
          </ol>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md border border-amber-300/50 bg-background/60 px-2 py-1 text-[11.5px] text-foreground">{webhookUrl}</code>
            <button onClick={copyUrl} className="text-[11.5px] font-medium text-amber-800 dark:text-amber-200 hover:underline flex-shrink-0">Copy</button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder="Paste the webhook signing secret"
              className="flex-1 min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 text-[12.5px] outline-none focus:border-foreground/40"
            />
            <button onClick={saveWebhookSecret} disabled={saving || !webhookSecret.trim()}
              className="rounded-lg bg-foreground text-background px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50 flex-shrink-0">
              {saving ? "Saving…" : "Save secret"}
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="mt-3 space-y-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Composio API key (ak_…)"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-foreground/40"
          />
          <input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder="Webhook signing secret (optional — can add later)"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-foreground/40"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving || !apiKey.trim()}
              className="rounded-lg bg-foreground text-background px-3.5 py-2 text-[13px] font-medium disabled:opacity-50"
            >
              {saving ? "Setting up…" : "Save"}
            </button>
            {editing && (
              <button onClick={() => { setEditing(false); setApiKey(""); setWebhookSecret(""); }}
                className="text-[12px] text-muted-foreground/70 hover:text-foreground">Cancel</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
