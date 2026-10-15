// API keys (GET-629). Keys are created inline: name, access, Create key. The new secret goes
// straight to the clipboard and the new row says so; there is no dialog and no reveal screen.
// If the browser refuses the clipboard, the secret is shown once under the create row instead,
// so it is never lost. Rotate hands its new secret over the same way.
//
// Rendered as its own page at /keys, and embedded in Settings (and the personal workspace),
// where it drops the page shell so it doesn't nest a header inside a header.

import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Check, Clock, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApiTopBar } from "@/components/shell/apiTopBarContext";
import {
  KEYS_CHANGED_EVENT, KeyApiError, KeyNameInput, RevokeKeyDialog, RotateKeyDialog, SecretOnce, createdMessage, lastUsedPhrase, revokedToast,
  rotatedMessage, useKeyApi, useSecretHandoff,
} from "@/components/keys/keyActions";
import {
  ACCESS_OPTIONS, EXPIRY_OPTIONS, accessLabel, canManageKey, expiresInLabel, expiringSoon, extendErrorMessage, extendedExpiry,
  isExpired, maskedKey, prefixOf, renameErrorMessage, type ApiKeyRow, type Capability,
} from "@/lib/apiKeys";
import { day, when } from "@/lib/format";
import { cn } from "@/lib/utils";

const field =
  "h-[30px] rounded-lg border border-border bg-card px-2.5 text-[12.5px] text-foreground shadow-none outline-none placeholder:text-muted-foreground focus:border-foreground focus:shadow-[0_0_0_3px_rgba(20,20,18,0.06)] focus:ring-0 focus:ring-offset-0";

/** A row as the page holds it: the list row, minus any secret. */
function rowOf(created: ApiKeyRow & { key?: string }): ApiKeyRow {
  const { key, ...row } = created;
  return { ...row, key_prefix: row.key_prefix ?? (key ? prefixOf(key) : null), last_used_at: row.last_used_at ?? null };
}

export default function ApiKeys({ embedded = false }: { embedded?: boolean } = {}) {
  const api = useKeyApi();
  const navigate = useNavigate();
  // The page itself (GET-629) on every plan since GET-660; the API plan's bar or the app's top bar
  // names it. Embedded in another surface it keeps its card.
  const inShell = !embedded;
  const handoff = useSecretHandoff();

  const [keys, setKeys] = React.useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [name, setName] = React.useState("");
  const [needName, setNeedName] = React.useState(false);
  const [capability, setCapability] = React.useState<Capability>("read_write");
  const [expiry, setExpiry] = React.useState(0);
  const [creating, setCreating] = React.useState(false);
  // The row just created or rotated (highlighted), and whether its secret reached the clipboard.
  const [fresh, setFresh] = React.useState<{ id: string; copied: boolean } | null>(null);
  // A secret the clipboard refused, shown once under the create row until dismissed.
  const [unshown, setUnshown] = React.useState<string | null>(null);
  const [rotating, setRotating] = React.useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = React.useState<ApiKeyRow | null>(null);
  // The row whose name is being edited in place (E1).
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  // "Rename" was chosen for this row: the field opens once the menu has fully closed, so the
  // closing menu can't take the focus back from it.
  const renameNext = React.useRef<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    if (!api.ready) return;
    setLoading(true);
    try { setKeys(await api.list()); }
    catch { toast.error("Couldn't load your keys."); }
    finally { setLoading(false); }
  }, [api]);

  React.useEffect(() => { void load(); }, [load]);
  // A revoke undone from the toast brings the key back: reload so it reappears in its place.
  React.useEffect(() => {
    const onChanged = () => { void load(); };
    window.addEventListener(KEYS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(KEYS_CHANGED_EVENT, onChanged);
  }, [load]);
  // No keys yet: the create row is the next step, so it takes the focus (GET-639).
  const empty = !loading && keys.length === 0;
  React.useEffect(() => { if (empty) nameRef.current?.focus(); }, [empty]);
  useApiTopBar({ onRefresh: load, refreshing: loading, enabled: !embedded });

  const create = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    // Create key is always clickable (GET-869): a greyed button with no reason read as broken.
    // With no name yet it says so and puts the cursor in the field.
    if (!n) { setNeedName(true); nameRef.current?.focus(); return; }
    if (creating || !api.ready) return;
    setCreating(true);
    try {
      const created = await api.create({ name: n, capability, ...(expiry > 0 ? { expires_in_days: expiry } : {}) });
      // You minted it, so you may rotate and revoke it.
      const row = { ...rowOf(created), can_manage: true };
      setKeys((ks) => [row, ...ks.filter((k) => k.id !== row.id)]);
      setUnshown(null);
      setName(""); setCapability("read_write"); setExpiry(0);
      const copied = await handoff(created.key, createdMessage(row), setUnshown);
      setFresh({ id: row.id, copied });
    } catch {
      toast.error("Couldn't create the key. Nothing changed.");
    } finally {
      setCreating(false);
    }
  };

  const rotate = async (key: ApiKeyRow) => {
    try {
      const created = await api.rotate(key);
      const row = { ...rowOf(created), can_manage: key.can_manage };
      setKeys((ks) => ks.map((k) => (k.id === key.id ? row : k)));
      setRotating(null);
      setUnshown(null);
      const copied = await handoff(created.key, rotatedMessage(row.name), setUnshown);
      setFresh({ id: row.id, copied });
    } catch {
      toast.error("Couldn't rotate the key. The current one still works.");
    }
  };

  // Confirmed in RevokeKeyDialog with the name typed. The toast offers Undo for ten seconds.
  const revoke = async (key: ApiKeyRow) => {
    try {
      await api.revoke(key.id);
      setKeys((ks) => ks.filter((k) => k.id !== key.id));
      setRevoking(null);
      revokedToast(key.name, { id: key.id, restore: api.restore });
    } catch {
      toast.error("Couldn't revoke the key. It still works.");
    }
  };

  // Optimistic: the row shows the new name at once and goes back if the API refuses it.
  const rename = async (key: ApiKeyRow, next: string) => {
    const prev = key.name;
    setRenamingId(null);
    setKeys((ks) => ks.map((k) => (k.id === key.id ? { ...k, name: next } : k)));
    try {
      await api.rename(key.id, next);
      toast("Key renamed", { description: `${prev} is now ${next}` });
    } catch (e) {
      setKeys((ks) => ks.map((k) => (k.id === key.id && k.name === next ? { ...k, name: prev } : k)));
      toast.error(renameErrorMessage(e instanceof KeyApiError ? e.code : null));
    }
  };

  // Extend from the expiring-soon banner (E3), optimistic: the key leaves the banner at once and
  // comes back if the API refuses.
  const extend = async (key: ApiKeyRow, days: number) => {
    const prev = key.expires_at ?? null;
    const guess = extendedExpiry(prev, days);
    setKeys((ks) => ks.map((k) => (k.id === key.id ? { ...k, expires_at: guess } : k)));
    try {
      const out = await api.extend(key.id, days);
      setKeys((ks) => ks.map((k) => (k.id === key.id ? { ...k, expires_at: out.expires_at } : k)));
      toast("Key extended", { description: `${key.name} now expires ${day(out.expires_at)}` });
    } catch (e) {
      setKeys((ks) => ks.map((k) => (k.id === key.id && k.expires_at === guess ? { ...k, expires_at: prev } : k)));
      toast.error(extendErrorMessage(e instanceof KeyApiError ? e.code : null));
    }
  };

  const soon = expiringSoon(keys);

  const body = (
    <div className={cn("flex min-h-0 flex-col", !inShell && "overflow-hidden rounded-2xl border border-border/70 bg-card")}>
      <form onSubmit={create} className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-4 sm:px-5">
        <label htmlFor="key-name" className="sr-only">Key name</label>
        <input
          id="key-name" ref={nameRef} value={name} onChange={(e) => { setName(e.target.value); setNeedName(false); }}
          aria-invalid={needName || undefined}
          placeholder="e.g. claude-code" autoComplete="off" spellCheck={false}
          className={cn(field, "min-w-0 flex-1 basis-[200px] sm:max-w-[320px]", needName && "border-destructive/60")}
        />
        <Select value={capability} onValueChange={(v) => setCapability(v as Capability)}>
          <SelectTrigger aria-label="Access" className={cn(field, "w-auto gap-2")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACCESS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value} className="text-[12.5px]">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={String(expiry)} onValueChange={(v) => setExpiry(Number(v))}>
          <SelectTrigger aria-label="Expires" className={cn(field, "w-auto gap-2 text-ink-2")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY_OPTIONS.map((o) => <SelectItem key={o.days} value={String(o.days)} className="text-[12.5px]">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={creating || !api.ready}>Create key</Button>
        {needName
          ? <span className="ml-1 text-[12px] text-destructive">Name the key first, e.g. claude-code.</span>
          : <span className="ml-1 hidden text-[12px] text-muted-foreground md:inline">Copied to your clipboard when created.</span>}
        {unshown && <SecretOnce secret={unshown} onDone={() => setUnshown(null)} className="mt-2 w-full" />}
      </form>

      {soon.length > 0 && (
        <div className="flex flex-col gap-1.5 border-b border-hairline px-4 py-3 sm:px-5">
          {soon.map((k) => (
            <div key={k.id}
              className="flex items-center gap-2.5 rounded-[10px] border border-warning/25 bg-warning/[0.07] py-2 pl-3 pr-2 text-[13px]">
              <Clock className="h-4 w-4 shrink-0 text-warning" strokeWidth={1.7} />
              <Link to={`/keys/${k.id}`} className="min-w-0 flex-1 truncate hover:underline">
                <span className="font-mono text-[12px] text-foreground">{k.name}</span>{" "}
                <span className="text-ink-2">{expiresInLabel(k.expires_at!)}</span>
              </Link>
              {canManageKey(k) && (
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => void extend(k, 90)}>Extend 90 days</Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="relative overflow-x-auto">
        {loading && !keys.length ? (
          <div className="flex flex-col">
            {[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse border-b border-hairline bg-muted/40" />)}
          </div>
        ) : keys.length ? (
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-left text-[11.5px] font-normal text-muted-foreground/70">
                <th className="h-[34px] w-[22%] whitespace-nowrap px-3 pl-4 font-medium sm:pl-5">Name</th>
                <th className="h-[34px] whitespace-nowrap px-3 font-medium">Key</th>
                <th className="h-[34px] whitespace-nowrap px-3 font-medium">Access</th>
                <th className="h-[34px] whitespace-nowrap px-3 font-medium">Last used</th>
                <th className="h-[34px] whitespace-nowrap px-3 font-medium">Created</th>
                <th className="h-[34px] w-9 px-3 pr-4"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const isFresh = fresh?.id === k.id;
                const expired = isExpired(k.expires_at);
                return (
                  <tr
                    key={k.id}
                    onClick={() => navigate(`/keys/${k.id}`)}
                    className={cn("cursor-pointer border-b border-hairline last:border-b-0 transition-colors duration-fast hover:bg-hover", isFresh && "bg-hover")}
                  >
                    <td className="h-12 whitespace-nowrap px-3 pl-4 sm:pl-5">
                      {renamingId === k.id ? (
                        <KeyNameInput
                          name={k.name} className="-ml-2 w-full max-w-[220px]"
                          onSave={(n) => void rename(k, n)} onCancel={() => setRenamingId(null)}
                        />
                      ) : (
                        <Link to={`/keys/${k.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-foreground hover:underline">
                          {k.name}
                        </Link>
                      )}
                    </td>
                    <td className="h-12 whitespace-nowrap px-3">
                      <span className="font-mono text-[12px] text-ink-2">{maskedKey(k.key_prefix)}</span>
                      {isFresh && fresh.copied && (
                        <span className="ml-2 inline-flex items-center gap-1 text-[12px] font-medium text-positive">
                          <Check className="h-3 w-3" strokeWidth={2.4} />Copied to your clipboard
                        </span>
                      )}
                    </td>
                    <td className="h-12 whitespace-nowrap px-3">
                      <span className="inline-flex h-5 items-center rounded-md bg-muted px-[7px] text-[11.5px] text-ink-2">{accessLabel(k.capability)}</span>
                      {k.expires_at && (
                        <span className={cn("ml-2 text-[12px]", expired ? "text-risk" : "text-muted-foreground")}>
                          {expired ? "Expired" : `Expires ${day(k.expires_at)}`}
                        </span>
                      )}
                    </td>
                    <td className="h-12 whitespace-nowrap px-3 text-muted-foreground">{k.last_used_at ? when(k.last_used_at) : "Never"}</td>
                    <td className="h-12 whitespace-nowrap px-3 text-muted-foreground">{when(k.created_at)}</td>
                    <td className="h-12 px-3 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <button type="button" aria-label={`More actions for ${k.name}`}
                            className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                            <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end" className="w-40 rounded-[10px] p-1"
                          onCloseAutoFocus={(e) => {
                            if (!renameNext.current) return;
                            e.preventDefault();
                            setRenamingId(renameNext.current);
                            renameNext.current = null;
                          }}
                        >
                          <DropdownMenuItem className="text-[12.5px]" onSelect={() => navigate(`/keys/${k.id}`)}>Open</DropdownMenuItem>
                          {canManageKey(k) && (
                            <>
                              <DropdownMenuItem className="text-[12.5px]" onSelect={() => { renameNext.current = k.id; }}>Rename</DropdownMenuItem>
                              <DropdownMenuItem className="text-[12.5px]" onSelect={() => setRotating(k)}>Rotate</DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-[12.5px] text-risk focus:text-risk" onSelect={() => setRevoking(k)}>Revoke</DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          // The form above already makes a key; the empty state just says so (round 2).
          <EmptyState
            bordered={false}
            title="No API keys yet"
            body="Name one above to create it."
          />
        )}
      </div>

      <RevokeKeyDialog
        keyName={revoking?.name ?? ""}
        lastUsed={revoking?.last_used_at ? lastUsedPhrase(revoking.last_used_at) : null}
        open={!!revoking}
        onOpenChange={(o) => { if (!o) setRevoking(null); }}
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
      />
      <RotateKeyDialog
        keyName={rotating?.name ?? ""}
        open={!!rotating}
        onOpenChange={(o) => { if (!o) setRotating(null); }}
        onConfirm={() => (rotating ? rotate(rotating) : undefined)}
      />
    </div>
  );

  if (embedded) return body;
  return <div className="h-full overflow-y-auto bg-background">{body}</div>;
}
