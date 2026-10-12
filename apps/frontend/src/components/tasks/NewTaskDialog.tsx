// A task typed by a person: what, for which account, by when, and whose. One dialog for the Tasks
// page's "New task" and an Insights topic's "Create a task", so a task reads the same wherever it
// was made.
//
// Drawn the way the interface refresh's States board draws it (GET-607): the account in the header,
// a big title, then chips for the deal, the owner and the due day, and a footer with "Create
// another" and ⌘↵. The account is searched the way the Accounts page searches
// (GET /api/companies/list?q=), or, from a topic, picked from that topic's own accounts. The page
// sends its own id for the task, so a double click or a retry files one task, not two.
//
// The API takes a title, an account, a deal, an owner and a day (parseNewTask); it has no notes
// field yet, so the form has no notes box: anything typed there would be dropped.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Loader2, Search, X } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/ui/owner-filter";
import { EntityAvatar } from "@/components/EntityAvatar";
import { day } from "@/lib/format";
import { cn } from "@/lib/utils";
import { parseDay, snoozeDays, type TaskRecord } from "./taskModel";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

/**
 * An account the dialog can put a task on. `id` is null when the caller only knows its name. A
 * person page locks the dialog to that person (`kind: "person"`, GET-785): the API files a task on a
 * person as readily as on a company, and a person has no deals of its own to pick from.
 */
export type AccountChoice = { id: string | null; name: string; domain?: string | null; hint?: string | null; kind?: "company" | "person"; photoUrl?: string | null };
export type Member = { id: string; name: string; avatar: string | null };
export type TaskSource = { kind: "manual" | "insight" | "close_loop"; key?: string; title?: string | null };
type DealChoice = { id: string; name: string };

const newId = () => {
  try { if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID(); } catch { /* older browser */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
};

/**
 * The workspace's members, for an owner picker. Settings' read first (GET /api/workspaces/:id/members),
 * because /api/home/members asks the users table for an `avatar_url` column it does not have and
 * comes back empty against the live database; that one is the fallback (it is what the preview serves).
 */
export async function fetchMembers(token: string, workspaceId: string): Promise<Member[]> {
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const r = await fetch(`${apiUrl}/api/workspaces/${workspaceId}/members`, { headers });
    const d = r.ok ? await r.json() : null;
    type Row = { user_id: string; users?: { name?: string | null; email?: string | null; profile_picture_url?: string | null } | { name?: string | null; email?: string | null; profile_picture_url?: string | null }[] | null };
    const rows = (Array.isArray(d?.members) ? d.members : []) as Row[];
    const out = rows.filter((m) => m.user_id).map((m) => {
      const u = Array.isArray(m.users) ? m.users[0] : m.users;
      return { id: m.user_id, name: u?.name || u?.email?.split("@")[0] || "Member", avatar: u?.profile_picture_url ?? null };
    });
    if (out.length) return out;
  } catch { /* try the other read */ }
  try {
    const r = await fetch(`${apiUrl}/api/home/members?workspaceId=${workspaceId}`, { headers });
    const d = r.ok ? await r.json() : null;
    return Array.isArray(d?.members) ? (d.members as Member[]) : [];
  } catch { return []; }
}

/**
 * An account's id from its name and domain, for a list that carries names only (an older Insights
 * board). By domain first, then an exact, single name match: two accounts with one name is a guess,
 * and a guess files the task on the wrong record.
 */
export async function resolveAccountId(a: AccountChoice, token: string, workspaceId: string): Promise<string | null> {
  if (a.id) return a.id;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    if (a.domain) {
      const r = await fetch(`${apiUrl}/api/companies/by-domain?workspaceId=${workspaceId}&domain=${encodeURIComponent(a.domain)}`, { headers });
      const d = r.ok ? await r.json() : null;
      if (d?.company?.id) return d.company.id;
    }
    const r = await fetch(`${apiUrl}/api/companies/list?workspaceId=${workspaceId}&q=${encodeURIComponent(a.name)}&country=all&limit=10`, { headers });
    const d = r.ok ? await r.json() : null;
    const hits = ((d?.companies ?? []) as { id: string; name: string | null }[])
      .filter((c) => (c.name ?? "").trim().toLowerCase() === a.name.trim().toLowerCase());
    return hits.length === 1 ? hits[0].id : null;
  } catch { return null; }
}

const ERRORS: Record<string, string> = {
  title_required: "Give the task a name.",
  entity_id_required: "Pick the account it is for.",
  entity_not_found: "That account isn't in this workspace any more.",
  invalid_due_at: "That due date isn't a real day.",
  invalid_deal_id: "That deal can't be found. Pick another or none.",
  owner_not_a_member: "That person isn't on this workspace.",
  feature_not_in_plan: "Tasks are on the Workspace plan.",
};

// The palette's quiet chip (GET-658): a soft fill, no outline.
export const CHIP = "inline-flex h-7 max-w-full items-center gap-1.5 whitespace-nowrap rounded-lg bg-muted/60 px-[9px] text-[12.5px] text-foreground transition-colors duration-fast hover:bg-muted data-[state=open]:bg-muted disabled:opacity-50";
// The search popup's row: 13px, the soft hover band, 8px radius.
export const MENU_ITEM = "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground transition-colors duration-fast hover:bg-hover";

/** A chip that opens a small menu. */
export function ChipMenu({ trigger, children, open, onOpenChange, className, width = "w-[240px]", label }: {
  trigger: ReactNode; children: ReactNode; open: boolean; onOpenChange: (o: boolean) => void;
  className?: string; width?: string; label: string;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={label} className={cn(CHIP, className)}>{trigger}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn(width, "p-1")}>{children}</PopoverContent>
    </Popover>
  );
}

/** The track-and-thumb switch of the States board: 28 by 16. */
function MiniSwitch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={cn("relative h-4 w-7 flex-shrink-0 rounded-full transition-colors duration-fast", on ? "bg-foreground" : "bg-input")}>
      <span className={cn("absolute top-0.5 size-3 rounded-full bg-card shadow-sm transition-[left] duration-fast", on ? "left-[14px]" : "left-0.5")} />
    </button>
  );
}

export function NewTaskDialog({
  open, onOpenChange, token, workspaceId, onCreated,
  heading = "New task", description, initialTitle = "", accounts, suggestions = [], source = { kind: "manual" },
  defaultOwnerId = null, meId = null, meName = null, initialAccount = null,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; token: string; workspaceId: string;
  onCreated: (task: TaskRecord, created: boolean) => void;
  heading?: string; description?: string; initialTitle?: string;
  /** A fixed list to pick from (a topic's accounts). Without it, accounts are searched. */
  accounts?: AccountChoice[];
  /** Shown before anything is typed in the search: the accounts already on your list. */
  suggestions?: AccountChoice[];
  source?: TaskSource;
  defaultOwnerId?: string | null; meId?: string | null;
  /** The viewer's name, for the owner chip before the member list arrives. */
  meName?: string | null;
  /** Open with this account picked (C from an account page, `?new=1&account=<id>`). */
  initialAccount?: AccountChoice | null;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [account, setAccount] = useState<AccountChoice | null>(null);
  const [deal, setDeal] = useState<DealChoice | null>(null);
  const [deals, setDeals] = useState<DealChoice[]>([]);
  const [due, setDue] = useState("");
  // "" is the caller: the API makes a task its creator's unless it names someone else.
  const ownerDefault = defaultOwnerId && defaultOwnerId !== meId ? defaultOwnerId : "";
  const [ownerId, setOwnerId] = useState<string>(ownerDefault);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<AccountChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [another, setAnother] = useState(false);
  const [menu, setMenu] = useState<null | "account" | "deal" | "owner" | "due">(null);
  const [customDue, setCustomDue] = useState("");
  const clientId = useRef(newId());
  const titleRef = useRef<HTMLInputElement>(null);
  const days = snoozeDays();

  // A fresh form each time it opens: a new id, the prefilled title and account.
  useEffect(() => {
    if (!open) return;
    clientId.current = newId();
    setTitle(initialTitle);
    setAccount(initialAccount ?? (accounts?.length === 1 ? accounts[0] : null));
    setDeal(null);
    setDue(""); setQ(""); setFound([]); setError(null); setBusy(false); setMenu(null);
    setOwnerId(ownerDefault);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // The account can arrive after the form opens (C from an account page resolves its name).
  useEffect(() => { if (open && initialAccount) setAccount((a) => a ?? initialAccount); }, [open, initialAccount]);

  useEffect(() => {
    if (!open || !token || !workspaceId) return;
    let alive = true;
    // Without the list the task is still yours: "Me" needs no lookup.
    void fetchMembers(token, workspaceId).then((m) => { if (alive) setMembers(m); });
    return () => { alive = false; };
  }, [open, token, workspaceId]);

  // The account's open deals, for the Deal chip. None, or an account known by name only: no chip.
  useEffect(() => {
    setDeal(null); setDeals([]);
    if (!open || !account?.id || account.kind === "person" || !token || !workspaceId) return;
    let alive = true;
    fetch(`${apiUrl}/api/companies/${account.id}/deals?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return;
        const rows = ((d?.deals ?? []) as { id: string; name: string | null; status?: string | null; implied?: boolean }[])
          .filter((x) => x.id && x.name && !x.implied && (x.status ?? "open") === "open");
        setDeals(rows.map((x) => ({ id: x.id, name: x.name as string })));
      })
      .catch(() => { /* the chip just doesn't show */ });
    return () => { alive = false; };
  }, [open, account?.id, token, workspaceId]);

  // Search as you type, a beat after the last key, and only for the answer to the latest query.
  useEffect(() => {
    if (accounts || !open) return;
    const needle = q.trim();
    if (!needle) { setFound([]); setSearching(false); return; }
    setSearching(true);
    let alive = true;
    const t = window.setTimeout(() => {
      fetch(`${apiUrl}/api/companies/list?workspaceId=${workspaceId}&q=${encodeURIComponent(needle)}&country=all&limit=8`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive) return;
          setFound(((d?.companies ?? []) as { id: string; name: string | null; domain: string | null }[])
            .filter((c) => c.id && c.name).map((c) => ({ id: c.id, name: c.name as string, domain: c.domain })));
        })
        .catch(() => { if (alive) setFound([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [q, accounts, open, token, workspaceId]);

  const choices = useMemo(() => {
    if (accounts) {
      const n = q.trim().toLowerCase();
      return n ? accounts.filter((a) => a.name.toLowerCase().includes(n)) : accounts;
    }
    return q.trim() ? found : suggestions;
  }, [accounts, q, found, suggestions]);

  const others = members.filter((m) => m.id !== meId);
  const me: Member = members.find((m) => m.id === meId) ?? { id: meId ?? "me", name: meName || "Me", avatar: null };
  const owner = ownerId ? members.find((m) => m.id === ownerId) ?? null : me;
  const canSave = !!title.trim() && !!account && !busy;
  const lockedAccount = !!accounts && accounts.length === 1;

  const submit = async () => {
    if (!canSave || !account) return;
    setBusy(true); setError(null);
    const entityId = await resolveAccountId(account, token, workspaceId);
    if (!entityId) { setBusy(false); setError("Couldn't find this account's record. Pick another."); return; }
    try {
      const r = await fetch(`${apiUrl}/api/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId, title: title.trim(), entityId, due_at: due || null, source,
          ...(deal ? { deal_id: deal.id } : {}),
          ...(ownerId ? { owner_user_id: ownerId } : {}), client_id: clientId.current,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.task) throw new Error(ERRORS[d?.error] ?? "Couldn't save the task. Try again.");
      onCreated(d.task as TaskRecord, d.created !== false);
      if (another) {
        // Same account, deal, owner and day: the next promise from the same call.
        clientId.current = newId();
        setTitle("");
        titleRef.current?.focus();
      } else {
        onOpenChange(false);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dueDay = due ? parseDay(due) : null;
  const pickDue = (v: string) => { setDue(v); setMenu(null); setCustomDue(""); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-[560px] gap-0 overflow-hidden p-0"
        hideCloseButton
        onOpenAutoFocus={(e) => { e.preventDefault(); titleRef.current?.focus(); }}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }}>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {/* The account, then what this is. */}
          <div className="flex min-w-0 items-center gap-2 pl-4 pr-3.5 pt-3">
            {lockedAccount && account ? (
              <span className={cn(CHIP, "h-6 bg-transparent px-1 text-xs hover:bg-transparent")}>
                <EntityAvatar kind={account.kind ?? "company"} name={account.name} domain={account.domain ?? null} photoUrl={account.photoUrl ?? null}
                  className={cn("size-4 flex-shrink-0", account.kind === "person" ? "rounded-full" : "rounded-[4px]")} textClassName="text-[7px] font-semibold" />
                <span className="truncate">{account.name}</span>
              </span>
            ) : (
              <ChipMenu label="Account" open={menu === "account"} onOpenChange={(o) => { setMenu(o ? "account" : null); if (!o) setQ(""); }}
                className="h-6 min-w-0 text-xs" width="w-[280px]"
                trigger={account ? (
                  <>
                    <EntityAvatar kind="company" name={account.name} domain={account.domain ?? null}
                      className="size-4 flex-shrink-0 rounded-[4px]" textClassName="text-[7px] font-semibold" />
                    <span className="truncate">{account.name}</span>
                  </>
                ) : (
                  <span className="text-ink-2">Choose an account</span>
                )}>
                {(!accounts || accounts.length > 6) && (
                  <div className="mb-1 flex items-center gap-2 border-b border-hairline px-2 pb-1.5">
                    <Search className="size-3.5 flex-shrink-0 text-muted-foreground" />
                    <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={accounts ? "Filter this topic's accounts" : "Search accounts"}
                      aria-label="Search accounts"
                      className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none" />
                    {searching && <Loader2 className="size-3.5 flex-shrink-0 animate-spin text-muted-foreground" />}
                  </div>
                )}
                <div className="max-h-[220px] overflow-y-auto">
                  {choices.map((a, i) => (
                    <button type="button" key={`${a.id ?? a.name}-${i}`} onClick={() => { setAccount(a); setMenu(null); setQ(""); }} className={MENU_ITEM}>
                      <EntityAvatar kind="company" name={a.name} domain={a.domain ?? null}
                        className="size-[18px] flex-shrink-0 rounded-[5px]" textClassName="text-[8px] font-semibold" />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      {a.hint && <span className="flex-shrink-0 text-xs text-muted-foreground">{a.hint}</span>}
                      {account?.name === a.name && <Check className="size-3.5 flex-shrink-0" strokeWidth={2.4} />}
                    </button>
                  ))}
                  {!choices.length && (
                    <p className="px-2 py-2 text-xs text-muted-foreground">
                      {accounts ? "No account matches." : q.trim() ? (searching ? "Searching…" : "No account matches.") : "Type a name to find the account."}
                    </p>
                  )}
                </div>
              </ChipMenu>
            )}
            <ChevronRight className="size-3.5 flex-shrink-0 text-input" />
            <DialogTitle className="truncate text-xs font-normal text-muted-foreground">{heading}</DialogTitle>
            <span className="flex-1" />
            <button type="button" onClick={() => onOpenChange(false)} aria-label="Close"
              className="-mr-1 flex size-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
          {description
            ? <DialogDescription className="px-4 pt-2 text-xs text-muted-foreground">{description}</DialogDescription>
            : <DialogDescription className="sr-only">Name the task, then pick its account, owner and due day.</DialogDescription>}

          <div className="px-4 pb-3 pt-3.5">
            <label htmlFor="new-task-title" className="sr-only">Task title</label>
            <input id="new-task-title" ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300}
              placeholder="Send Dana the pilot quote"
              className="w-full border-0 bg-transparent p-0 text-[15px] tracking-[-0.01em] text-foreground placeholder:text-muted-foreground/60 focus:outline-none" />
          </div>

          <div className="flex flex-wrap gap-1.5 px-4 pb-3.5">
            {deals.length > 0 && (
              <ChipMenu label="Deal" open={menu === "deal"} onOpenChange={(o) => setMenu(o ? "deal" : null)}
                trigger={<><span className="text-muted-foreground/70">Deal</span><span className="truncate">{deal ? deal.name : "None"}</span></>}>
                <button type="button" onClick={() => { setDeal(null); setMenu(null); }} className={MENU_ITEM}>
                  <span className="flex-1 text-ink-2">No deal</span>{!deal && <Check className="size-3.5" strokeWidth={2.4} />}
                </button>
                {deals.map((x) => (
                  <button type="button" key={x.id} onClick={() => { setDeal(x); setMenu(null); }} className={MENU_ITEM}>
                    <span className="min-w-0 flex-1 truncate">{x.name}</span>{deal?.id === x.id && <Check className="size-3.5 flex-shrink-0" strokeWidth={2.4} />}
                  </button>
                ))}
              </ChipMenu>
            )}

            <ChipMenu label="Owner" open={menu === "owner"} onOpenChange={(o) => setMenu(o ? "owner" : null)}
              trigger={<><PersonAvatar person={{ id: owner?.id ?? "me", name: owner?.name ?? "Me" }} /><span className="truncate">{owner?.name?.split(/\s+/)[0] ?? "Me"}</span></>}>
              <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">Owner</p>
              {[{ key: "", m: me }, ...others.map((m) => ({ key: m.id, m }))].map(({ key, m }) => (
                <button type="button" key={key || "me"} onClick={() => { setOwnerId(key); setMenu(null); }} className={MENU_ITEM}>
                  <PersonAvatar person={{ id: m.id, name: m.name }} />
                  <span className="min-w-0 flex-1 truncate">{key ? m.name : "Me"}</span>
                  {ownerId === key && <Check className="size-3.5 flex-shrink-0" strokeWidth={2.4} />}
                </button>
              ))}
            </ChipMenu>

            <ChipMenu label="Due date" open={menu === "due"} onOpenChange={(o) => setMenu(o ? "due" : null)} width="w-[230px]"
              trigger={<>{dueDay ? `${format(dueDay, "EEE")}, ${day(dueDay)}` : <span className="text-ink-2">No due date</span>}</>}>
              <button type="button" onClick={() => pickDue(days.tomorrow)} className={MENU_ITEM}>
                <span className="flex-1">Tomorrow</span><span className="text-xs tabular-nums text-muted-foreground">{day(days.tomorrow)}</span>
              </button>
              <button type="button" onClick={() => pickDue(days.nextMonday)} className={MENU_ITEM}>
                <span className="flex-1">Next Monday</span><span className="text-xs tabular-nums text-muted-foreground">{day(days.nextMonday)}</span>
              </button>
              <div className="mx-0.5 my-1 h-px bg-hairline" />
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-1">
                <input type="date" min={days.today} value={customDue} onChange={(e) => setCustomDue(e.target.value)} aria-label="Pick a date"
                  onKeyDown={(e) => { if (e.key === "Enter" && customDue) { e.preventDefault(); pickDue(customDue); } }}
                  className="h-7 min-w-0 flex-1 rounded-[7px] border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
                <Button type="button" size="sm" disabled={!customDue} onClick={() => pickDue(customDue)}>Set</Button>
              </div>
              {due && (
                <>
                  <div className="mx-0.5 my-1 h-px bg-hairline" />
                  <button type="button" onClick={() => pickDue("")} className={cn(MENU_ITEM, "text-ink-2")}>No due date</button>
                </>
              )}
            </ChipMenu>
          </div>

          {error && <p role="alert" className="px-4 pb-3 text-xs text-risk">{error}</p>}

          <div className="flex items-center gap-2 border-t border-hairline py-2.5 pl-4 pr-3.5">
            <MiniSwitch on={another} onChange={setAnother} label="Create another" />
            <span className="text-xs text-muted-foreground/70">Create another</span>
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!canSave}>
              {busy && <Loader2 className="!size-3.5 animate-spin" />}
              Create task
              <span className="ml-0.5 hidden gap-0.5 sm:inline-flex">
                {["⌘", "↵"].map((k) => (
                  <kbd key={k} className="inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-background/15 px-[3px] font-mono text-[10px] font-normal text-background/80">{k}</kbd>
                ))}
              </span>
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
