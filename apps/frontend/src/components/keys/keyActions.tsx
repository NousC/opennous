// What the keys page and the key detail page both do to a key (GET-629, GET-630, GET-639):
// call the API, hand a new secret over (clipboard first, shown once inline if that fails),
// the two confirms (rotate, revoke with the name typed), and the inline rename field (E1).

import * as React from "react";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { InlineEditInput } from "@/components/ui/inline-edit-input";
import { cn } from "@/lib/utils";
import { when } from "@/lib/format";
import {
  KEY_NAME_MAX, UNDO_TOAST_MS, accessLabel, keyNameError, restoreErrorMessage, rotateExpiryDays, revokeConfirmed, writeSecret,
  type ApiKeyRow, type Capability, type KeyRequestsPage, type KeyUsage,
} from "@/lib/apiKeys";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export class KeyApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** The key endpoints, bound to the signed-in user and their workspace. */
export function useKeyApi() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId: string = userData?.workspace?.id ?? "";

  return React.useMemo(() => {
    const ws = `workspace_id=${encodeURIComponent(workspaceId)}`;
    const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(`${apiUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new KeyApiError(res.status, data?.error ?? "request_failed");
      return data as T;
    };
    return {
      ready: !!token && !!workspaceId,
      list: async () => {
        const d = await call<{ api_keys?: ApiKeyRow[]; apiKeys?: ApiKeyRow[] }>(`/api/workspace/api-keys?${ws}`);
        return d.api_keys ?? d.apiKeys ?? [];
      },
      create: (body: { name: string; capability: Capability; expires_in_days?: number }) =>
        call<ApiKeyRow & { key: string }>(`/api/workspace/api-keys`, {
          method: "POST",
          body: JSON.stringify({ ...body, workspace_id: workspaceId }),
        }),
      rotate: (key: Pick<ApiKeyRow, "id" | "expires_at" | "created_at">) => {
        const days = rotateExpiryDays(key);
        return call<ApiKeyRow & { key: string }>(`/api/workspace/api-keys/${key.id}/rotate`, {
          method: "POST",
          body: JSON.stringify({ workspace_id: workspaceId, ...(days > 0 ? { expires_in_days: days } : {}) }),
        });
      },
      rename: (id: string, name: string) =>
        call<{ id: string; name: string }>(`/api/workspace/api-keys/${id}?${ws}`, {
          method: "PATCH",
          body: JSON.stringify({ name, workspace_id: workspaceId }),
        }),
      revoke: (id: string) => call<{ success: boolean }>(`/api/workspace/api-keys/${id}?${ws}`, { method: "DELETE" }),
      extend: (id: string, days: number) =>
        call<{ id: string; name: string; expires_at: string }>(`/api/workspace/api-keys/${id}/extend`, {
          method: "POST",
          body: JSON.stringify({ days, workspace_id: workspaceId }),
        }),
      restore: (id: string) =>
        call<ApiKeyRow>(`/api/workspace/api-keys/${id}/restore`, {
          method: "POST",
          body: JSON.stringify({ workspace_id: workspaceId }),
        }),
      usage: (id: string) => call<KeyUsage>(`/api/keys/${id}/usage?${ws}`),
      requests: (id: string, before?: string | null) =>
        call<KeyRequestsPage>(`/api/keys/${id}/requests?${ws}&limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`),
    };
  }, [token, workspaceId]);
}

/**
 * Hands a fresh secret to the person: onto the clipboard, with a toast whose "Copy again" works
 * while they stay on this page. When the clipboard refuses, `onUnshown` gets the secret so the
 * page can show it once inline — it is never dropped. Toasts carrying a secret close when the
 * page unmounts, so the secret does not outlive the page.
 */
export function useSecretHandoff() {
  const toastIds = React.useRef(new Set<string | number>());
  React.useEffect(() => {
    const ids = toastIds.current;
    return () => { ids.forEach((id) => toast.dismiss(id)); ids.clear(); };
  }, []);

  const copyAgain = React.useCallback(async (secret: string, onUnshown: (s: string) => void) => {
    if (await writeSecret(secret)) toast("Key copied");
    else onUnshown(secret);
  }, []);

  return React.useCallback(async (secret: string, msg: { title: string; description: string; fallbackTitle: string; fallbackDescription: string }, onUnshown: (s: string) => void) => {
    const copied = await writeSecret(secret);
    if (!copied) {
      onUnshown(secret);
      toast(msg.fallbackTitle, { description: msg.fallbackDescription });
      return false;
    }
    const id = toast.success(msg.title, {
      description: msg.description,
      duration: 12_000,
      action: { label: "Copy again", onClick: () => { void copyAgain(secret, onUnshown); } },
      onDismiss: (t) => { toastIds.current.delete(t.id); },
      onAutoClose: (t) => { toastIds.current.delete(t.id); },
    });
    toastIds.current.add(id);
    return true;
  }, [copyAgain]);
}

/** The toast copy for a new key and a rotated one. */
export const createdMessage = (row: { name: string; capability?: Capability | null }) => ({
  title: "Key copied",
  description: "It won't be shown again",
  fallbackTitle: "Key created",
  fallbackDescription: `${row.name} · ${accessLabel(row.capability)} · copy it now, it won't be shown again`,
});

export const rotatedMessage = (name: string) => ({
  title: "Key rotated",
  description: `The old secret for ${name} stopped working just now. New key copied.`,
  fallbackTitle: "Key rotated",
  fallbackDescription: `The old secret for ${name} stopped working just now. Copy the new one now.`,
});

/** "2m ago", "yesterday", "on 2 Oct": the revoke confirm's "It was last used …". */
export function lastUsedPhrase(at: string): string {
  const w = when(at);
  if (w === "Yesterday") return "yesterday";
  return /ago$|now$/.test(w) ? w : `on ${w}`;
}

/** Fired after a key comes back, so a keys list on screen (even one mounted after the revoke) reloads. */
export const KEYS_CHANGED_EVENT = "nous:api-keys-changed";

/**
 * "Key revoked", with Undo for ten seconds (E2). The toast outlives the page that revoked the key
 * (key detail navigates to /keys), so Undo calls the API itself and announces the change rather
 * than reaching into a page that may be gone.
 */
export function revokedToast(name: string, undo?: { id: string; restore: (id: string) => Promise<unknown> }) {
  toast("Key revoked", {
    description: `${name} · requests now return 401`,
    duration: undo ? UNDO_TOAST_MS : undefined,
    action: undo ? {
      label: "Undo",
      onClick: () => {
        undo.restore(undo.id).then(
          () => {
            window.dispatchEvent(new CustomEvent(KEYS_CHANGED_EVENT, { detail: { id: undo.id } }));
            toast.success("Key restored", { description: `${name} works again` });
          },
          (e) => toast.error(restoreErrorMessage(e instanceof KeyApiError ? e.code : null)),
        );
      },
    } : undefined,
  });
}

/** The secret, shown once, when the clipboard could not take it. */
export function SecretOnce({ secret, onDone, className }: { secret: string; onDone: () => void; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    if (await writeSecret(secret)) { setCopied(true); setTimeout(() => setCopied(false), 1400); }
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <input
        readOnly value={secret} aria-label="New API key"
        onFocus={(e) => e.currentTarget.select()}
        className="h-[30px] min-w-0 flex-1 basis-[260px] rounded-lg border border-border bg-card px-2.5 font-mono text-[12px] text-foreground outline-none focus:border-foreground"
      />
      <Button size="sm" variant="outline" onClick={copy}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>Done</Button>
      <span className="w-full text-[12px] text-muted-foreground">Shown once. It won't be shown again.</span>
    </div>
  );
}

function ConfirmShell({ open, onOpenChange, title, children, foot }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; children: React.ReactNode; foot: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[440px] gap-0 overflow-hidden rounded-[14px] p-0">
        <div className="border-b border-hairline py-3.5 pl-5 pr-12">
          <DialogTitle className="truncate text-[14px] font-semibold leading-tight tracking-normal">{title}</DialogTitle>
        </div>
        <div className="flex flex-col gap-3.5 px-5 pb-[18px] pt-4 text-[13px]">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-hairline bg-muted/40 py-3 pl-5 pr-4">{foot}</div>
      </DialogContent>
    </Dialog>
  );
}

/** Revoke, with the key's name typed to confirm (GET-639). */
export function RevokeKeyDialog({ keyName, lastUsed, open, onOpenChange, onConfirm }: {
  keyName: string; lastUsed?: string | null; open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => Promise<void> | void;
}) {
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (!open) { setTyped(""); setBusy(false); } }, [open]);
  const ok = revokeConfirmed(typed, keyName);
  const go = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };
  return (
    <ConfirmShell
      open={open} onOpenChange={onOpenChange} title={`Revoke ${keyName}?`}
      foot={<>
        <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
        <Button variant="destructive" disabled={!ok || busy} onClick={go}>Revoke key</Button>
      </>}
    >
      <DialogDescription className="text-[13px] text-ink-2">
        Anything using this key gets a 401 from the next request.{lastUsed ? ` It was last used ${lastUsed}.` : ""}
      </DialogDescription>
      <div>
        <label htmlFor="revoke-confirm" className="mb-1.5 block text-[12px] font-medium text-ink-2">
          Type <span className="font-mono text-foreground">{keyName}</span> to confirm
        </label>
        <input
          id="revoke-confirm" autoFocus autoComplete="off" spellCheck={false}
          value={typed} onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void go(); }}
          className="h-[34px] w-full rounded-[9px] border border-border bg-card px-2.5 font-mono text-[12.5px] text-foreground outline-none focus:border-foreground focus:shadow-[0_0_0_3px_rgba(20,20,18,0.06)]"
        />
      </div>
    </ConfirmShell>
  );
}

/** Rotate confirm: the old secret dies the moment the new one is issued. */
export function RotateKeyDialog({ keyName, open, onOpenChange, onConfirm }: {
  keyName: string; open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (!open) setBusy(false); }, [open]);
  const go = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };
  return (
    <ConfirmShell
      open={open} onOpenChange={onOpenChange} title={`Rotate ${keyName}?`}
      foot={<>
        <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
        <Button disabled={busy} onClick={go}>Rotate key</Button>
      </>}
    >
      <DialogDescription className="text-[13px] text-ink-2">
        A new secret is issued with the same name and access, and copied to your clipboard. The current one stops working immediately.
      </DialogDescription>
    </ConfirmShell>
  );
}

/** The inline rename field for a key (E1), with the API's name rule (1 to 60 characters). */
export function KeyNameInput(props: { name: string; onSave: (name: string) => void; onCancel: () => void; className?: string }) {
  return <InlineEditInput {...props} value={props.name} label={`Rename ${props.name}`} validate={keyNameError} maxLength={KEY_NAME_MAX + 20} />;
}
