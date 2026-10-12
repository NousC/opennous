// One task, opened (GET-808): the same dialog as "New task", so a task reads the same when you
// make it and when you look at it. The record it hangs on in the header, the task large, then the
// chips: who owns it, when it is due (change it here) and whether it is done. Under them, where it
// came from: the source with its date and link, the sentence it was said in, who it is for.
// The footer closes it or ticks it off.
import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EntityAvatar } from "@/components/EntityAvatar";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/contexts/AuthContext";
import { day } from "@/lib/format";
import { cn } from "@/lib/utils";
import { resolveDue } from "@/components/reporting/shared";
import { CHIP, ChipMenu, MENU_ITEM } from "./NewTaskDialog";
import { parseDay, snoozeDays } from "./taskModel";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

const toolOf = (t: any): string | null => {
  const url = String(t?.source_url ?? "");
  for (const k of ["fellow", "fireflies", "fathom", "granola", "hubspot", "gmail"]) if (url.includes(k) || String(t?.source_ref ?? "").includes(k)) return k[0].toUpperCase() + k.slice(1);
  return null;
};

export function TaskDialog({ task, open, onOpenChange, recordName, recordDomain, onToggle, onDue }: {
  task: any | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account or person the task hangs on, for the header. */
  recordName?: string | null;
  recordDomain?: string | null;
  onToggle?: (t: any, next: "open" | "done") => void;
  /** A new due day was saved: the page updates its row. */
  onDue?: (t: any, dueAt: string | null) => void;
}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const wsId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const [menu, setMenu] = useState<null | "due">(null);
  const [customDue, setCustomDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [dueAt, setDueAt] = useState<string | null>(task?.due_at ?? null);
  useEffect(() => { setDueAt(task?.due_at ?? null); setMenu(null); setCustomDue(""); }, [task?.id, task?.due_at]);
  if (!task) return null;

  const done = task.status === "done";
  const owner: string | null = task.assignee?.name ?? task.owner_label ?? task.owner_name ?? null;
  const ownerAvatar: string | null = task.assignee?.avatar ?? null;
  const due = resolveDue({ ...task, due_at: dueAt });
  const days = snoozeDays();
  const quote = typeof task.quote === "string" && task.quote.trim() ? task.quote.trim() : null;
  const said = task.occurred_at ?? task.recorded_at ?? null;
  const tool = toolOf(task);
  const property = String(task.id ?? "").includes(":") ? String(task.id).slice(String(task.id).indexOf(":") + 1) : "";

  const setDue = async (v: string) => {
    setMenu(null); setCustomDue("");
    if (!token || !wsId || !property) return;
    const prev = dueAt;
    setDueAt(v || null); setSaving(true);
    try {
      const r = await fetch(`${apiUrl}/api/tasks/${task.entity_id}/${encodeURIComponent(property)}/due`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId: wsId, due_at: v || null }),
      });
      if (!r.ok) throw new Error(String(r.status));
      onDue?.(task, v || null);
      toast(v ? `Due ${day(parseDay(v) ?? v)}` : "Due date removed");
    } catch {
      setDueAt(prev);
      toast.error("Couldn't change the due date. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const dueDay = dueAt ? parseDay(String(dueAt).slice(0, 10)) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-32px)] max-w-[560px] gap-0 overflow-hidden p-0" hideCloseButton>
        <div className="flex min-w-0 items-center gap-2 pl-4 pr-3.5 pt-3">
          {recordName && (
            <span className={cn(CHIP, "h-6 bg-transparent px-1 text-xs hover:bg-transparent")}>
              <EntityAvatar kind="company" name={recordName} domain={recordDomain ?? null}
                className="size-4 flex-shrink-0 rounded-[4px]" textClassName="text-[7px] font-semibold" />
              <span className="truncate">{recordName}</span>
            </span>
          )}
          {recordName && <ChevronRight className="size-3.5 flex-shrink-0 text-input" />}
          <DialogTitle className="truncate text-xs font-normal text-muted-foreground">Task</DialogTitle>
          <span className="flex-1" />
          <button type="button" onClick={() => onOpenChange(false)} aria-label="Close"
            className="-mr-1 flex size-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-hover hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
        <DialogDescription className="sr-only">The task, who owns it, when it is due and where it came from.</DialogDescription>

        <div className="px-4 pb-2 pt-3.5">
          <p className={cn("text-[15px] leading-snug tracking-[-0.01em] [overflow-wrap:anywhere]", done ? "text-muted-foreground line-through" : "text-foreground")}>{task.title}</p>
          {task.description && <p className="mt-1.5 text-[13px] leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]">{task.description}</p>}
        </div>

        <div className="flex flex-wrap gap-1.5 px-4 pb-3.5 pt-1.5">
          <span className={CHIP}>
            <EntityAvatar kind="person" name={owner ?? "Unassigned"} photoUrl={ownerAvatar} className="h-4 w-4 flex-shrink-0 rounded-full" textClassName="text-[7px] font-medium" />
            <span className="truncate">{owner ?? "Unassigned"}</span>
          </span>
          <ChipMenu label="Due date" open={menu === "due"} onOpenChange={(o) => setMenu(o ? "due" : null)} width="w-[230px]"
            trigger={<>
              {saving && <Loader2 className="size-3 animate-spin" />}
              {dueDay ? <span className={cn(due.overdue && !done && "text-risk")}>{`${format(dueDay, "EEE")}, ${day(dueDay)}`}</span>
                : due.phrase ? <span>{due.phrase}</span> : <span className="text-ink-2">No due date</span>}
            </>}>
            <button type="button" onClick={() => void setDue(days.today)} className={MENU_ITEM}>
              <span className="flex-1">Today</span><span className="text-xs tabular-nums text-muted-foreground">{day(days.today)}</span>
            </button>
            <button type="button" onClick={() => void setDue(days.tomorrow)} className={MENU_ITEM}>
              <span className="flex-1">Tomorrow</span><span className="text-xs tabular-nums text-muted-foreground">{day(days.tomorrow)}</span>
            </button>
            <button type="button" onClick={() => void setDue(days.nextMonday)} className={MENU_ITEM}>
              <span className="flex-1">Next Monday</span><span className="text-xs tabular-nums text-muted-foreground">{day(days.nextMonday)}</span>
            </button>
            <div className="mx-0.5 my-1 h-px bg-hairline" />
            <div className="flex items-center gap-1.5 px-2 pb-1 pt-1">
              <input type="date" value={customDue} onChange={(e) => setCustomDue(e.target.value)} aria-label="Pick a date"
                onKeyDown={(e) => { if (e.key === "Enter" && customDue) { e.preventDefault(); void setDue(customDue); } }}
                className="h-7 min-w-0 flex-1 rounded-[7px] border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
              <Button type="button" size="sm" disabled={!customDue} onClick={() => void setDue(customDue)}>Set</Button>
            </div>
            {dueAt && (
              <>
                <div className="mx-0.5 my-1 h-px bg-hairline" />
                <button type="button" onClick={() => void setDue("")} className={cn(MENU_ITEM, "text-ink-2")}>No due date</button>
              </>
            )}
          </ChipMenu>
          <span className={cn(CHIP, done ? "text-positive" : "")}>{done ? "Done" : "Open"}</span>
        </div>

        {(task.source_title || task.source_url || quote || task.for_name || said) && (
          <div className="space-y-1.5 px-4 pb-4">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground/70">
              <span>From</span>
              <span className="min-w-0 truncate text-foreground/80">{task.source_title ?? (tool ? `a ${tool} conversation` : "a conversation")}</span>
              {said && <span>· {day(said)}</span>}
              {task.source_url && (
                <a href={task.source_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-ink-2 underline decoration-border underline-offset-2 hover:text-foreground">
                  Open {tool ?? "source"} <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {quote && <p className="text-[12.5px] italic leading-snug text-muted-foreground [overflow-wrap:anywhere]">“{quote}”</p>}
            {(task.for_name || task.asked_by) && (
              <p className="text-[12px] text-muted-foreground/70">
                {task.for_name ? `${task.awaiting_them ? "Waiting on" : "For"} ${task.for_name}` : null}
                {task.for_name && task.asked_by ? " · " : null}
                {task.asked_by ? `asked by ${task.asked_by}` : null}
              </p>
            )}
            {done && task.completed_reason && <p className="text-[12px] text-muted-foreground/70">Closed: {task.completed_reason}</p>}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-hairline py-2.5 pl-4 pr-3.5">
          <span className="text-xs text-muted-foreground/60">{task.recorded_at ? `Created ${day(task.recorded_at)}` : null}</span>
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Close</Button>
          {onToggle && (
            <Button type="button" size="sm" onClick={() => { onToggle(task, done ? "open" : "done"); onOpenChange(false); }}>
              {done ? "Reopen" : "Mark done"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
