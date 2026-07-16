// Routines — the work the agent does without being asked.
//
// The other half of Tasks. An open task is a promise a PERSON made; a routine is
// standing instructions for the AGENT. Same page, because they're the same
// question — what is owed, and by whom — and the answer is more useful when both
// halves are in one place.
//
// A routine is three things and no more: a name, a prompt, and a trigger. The
// prompt is the whole configuration surface. There is no builder, no step editor,
// no branch — you tell it what to do in the words you'd use to a colleague, and it
// has your entire graph to do it with. That restraint IS the design.
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus, Play, Pencil, Trash2, CalendarClock, Clock, X } from "lucide-react";
import { format } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Run = { id: string; status: string; thread_id: string | null; started_at: string; error?: string | null };
type Routine = {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  trigger_kind: "clock" | "before_meeting";
  trigger_label: string;
  next_run_at: string | null;
  unseen: number;
  last_run: Run | null;
  // The schedule itself, so editing opens on what it actually is rather than on
  // defaults that would silently reschedule it the moment you saved.
  frequency: string | null;
  at_time: string | null;
  day_of_week: number | null;
  day_of_month: number | null;
  offset_minutes: number | null;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const OFFSETS = [
  { minutes: 15,   label: "15 minutes before" },
  { minutes: 60,   label: "1 hour before" },
  { minutes: 180,  label: "3 hours before" },
  { minutes: 1440, label: "1 day before" },
  { minutes: 10080, label: "1 week before" },
];

// The browser knows the user's zone; "07:00" is meaningless without it, and a
// founder in Berlin should not be briefed on London's clock.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Two examples, so the empty state teaches the shape instead of describing it. */
const EXAMPLES = [
  {
    name: "Weekly pipeline review",
    prompt: "Review my pipeline. What moved this week, what slipped, and who has gone quiet that shouldn't have? "
          + "Tell me the three accounts to chase on Monday and why, citing what each one last said.",
    trigger_kind: "clock" as const,
    frequency: "weekly",
    at_time: "07:00",
    day_of_week: 1,
  },
  {
    name: "Follow-up drafts",
    prompt: "For every call I had yesterday, tell me what was promised, by whom, and what I should send to follow up. "
          + "Quote the moment in the transcript where each promise was made.",
    trigger_kind: "clock" as const,
    frequency: "daily",
    at_time: "08:00",
  },
];

export function RoutinesPanel() {
  const { session, userData } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id;

  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [composing, setComposing] = useState<"new" | Routine | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const authHeaders = token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : undefined;

  const load = useCallback(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/routines?workspaceId=${workspaceId}&tz=${encodeURIComponent(TZ)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? r.json() : { routines: [] }))
      .then(d => setRoutines(d.routines ?? []))
      .catch(() => setRoutines([]));
  }, [token, workspaceId]);

  useEffect(() => { load(); }, [load]);

  const runNow = async (r: Routine) => {
    setBusy(r.id);
    try {
      const resp = await fetch(`${apiUrl}/api/routines/${r.id}/run`, { method: "POST", headers: authHeaders });
      const out = await resp.json();
      if (out.thread_id) navigate(`/?thread=${out.thread_id}`);
      else load();
    } catch { /* the row will show the error on next load */ }
    setBusy(null);
  };

  const toggle = async (r: Routine) => {
    setRoutines(rs => rs?.map(x => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) ?? null);
    await fetch(`${apiUrl}/api/routines/${r.id}`, {
      method: "PATCH", headers: authHeaders, body: JSON.stringify({ enabled: !r.enabled }),
    }).catch(() => {});
    load();
  };

  const saveRoutine = async (body: Draft) => {
    const target = composing;
    if (target && target !== "new") {
      // Editing: PATCH the fields. The server recomputes next_run_at, so a routine
      // moved from 07:00 to 09:00 doesn't keep firing at 07:00 until its next run.
      await fetch(`${apiUrl}/api/routines/${target.id}`, {
        method: "PATCH", headers: authHeaders, body: JSON.stringify({ ...body, timezone: TZ }),
      }).catch(() => {});
    } else {
      await fetch(`${apiUrl}/api/routines`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ ...body, workspaceId, timezone: TZ }),
      }).catch(() => {});
    }
    setComposing(null);
    load();
  };

  const remove = async (r: Routine) => {
    setRoutines(rs => rs?.filter(x => x.id !== r.id) ?? null);
    await fetch(`${apiUrl}/api/routines/${r.id}`, { method: "DELETE", headers: authHeaders }).catch(() => {});
  };

  if (routines === null) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground/60 mt-10">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading routines
      </div>
    );
  }

  return (
    <div>
      {composing && (
        <Composer
          key={composing === "new" ? "new" : composing.id}
          initial={composing === "new" ? null : composing}
          onCancel={() => setComposing(null)}
          onSave={saveRoutine}
        />
      )}

      {routines.length === 0 && !composing ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <CalendarClock className="h-7 w-7 text-muted-foreground/50 mx-auto mb-3" strokeWidth={1.5} />
          <p className="text-[13px] font-medium text-foreground/80 mb-1">Nothing scheduled</p>
          <p className="text-[12px] text-muted-foreground/70 mb-4">
            A routine is a prompt and a time. The agent runs it against your whole graph.
          </p>
          <button
            onClick={() => setComposing("new")}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border text-[12.5px] text-foreground hover:bg-muted/50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> New routine
          </button>
        </div>
      ) : routines.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          {/* Same table language as Accounts and the op log. */}
          <div className="flex items-center gap-4 px-4 py-2.5 bg-muted/50 border-b border-border">
            <span className="w-[14px] flex-shrink-0" />
            <span className="flex-1 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Routine</span>
            <span className="w-52 flex-shrink-0 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">When</span>
            <span className="w-44 flex-shrink-0 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Last run</span>
            <span className="w-[124px] flex-shrink-0" />
          </div>

          {routines.map(r => (
            <div
              key={r.id}
              className={cn(
                "group flex items-center gap-4 px-4 py-3 border-b border-border/60 last:border-0 hover:bg-accent transition-colors",
                !r.enabled && "opacity-45",
              )}
            >
              <span className="w-[14px] flex-shrink-0 text-muted-foreground/50">
                {r.trigger_kind === "before_meeting"
                  ? <CalendarClock className="h-3.5 w-3.5" />
                  : <Clock className="h-3.5 w-3.5" />}
              </span>

              <div className="flex-1 min-w-0">
                <button
                  onClick={() => setComposing(r)}
                  title="Edit this routine"
                  className="text-[13px] text-foreground leading-snug truncate hover:underline text-left max-w-full"
                >
                  {r.name}
                  {r.unseen > 0 && (
                    <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-foreground align-middle" />
                  )}
                </button>
                {/* The prompt IS the routine, so it stays on the row. You should not
                    have to open a dialog to learn what this thing will do at 7am. */}
                <p className="text-[12px] text-muted-foreground/55 leading-snug truncate mt-0.5">
                  {r.prompt}
                </p>
              </div>

              <span className="w-52 flex-shrink-0 min-w-0 text-[12px] truncate">
                <span className="text-muted-foreground">{r.trigger_label}</span>
                {r.next_run_at && r.enabled && (
                  <span className="text-muted-foreground/50 block truncate">
                    next {format(new Date(r.next_run_at), "EEE d MMM, HH:mm")}
                  </span>
                )}
              </span>

              <span className="w-44 flex-shrink-0 min-w-0 text-[12px] truncate">
                {r.last_run?.status === "error" ? (
                  <span className="text-red-600/80" title={r.last_run.error ?? ""}>
                    Failed {format(new Date(r.last_run.started_at), "MMM d")}
                  </span>
                ) : r.last_run?.thread_id ? (
                  <button
                    onClick={() => navigate(`/?thread=${r.last_run!.thread_id}`)}
                    className="text-muted-foreground/70 hover:text-foreground transition-colors truncate"
                  >
                    {format(new Date(r.last_run.started_at), "MMM d, HH:mm")} — read it
                  </button>
                ) : (
                  <span className="text-muted-foreground/40">Never</span>
                )}
              </span>

              {/* Controls stay quiet until you're on the row. */}
              <span className="w-[124px] flex-shrink-0 flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => runNow(r)}
                  disabled={busy === r.id}
                  title="Run now"
                  className="p-1.5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => setComposing(r)}
                  title="Edit"
                  className="p-1.5 rounded-md text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => toggle(r)}
                  title={r.enabled ? "Pause" : "Resume"}
                  className="px-1.5 py-1 rounded-md text-[11px] text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  {r.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  onClick={() => remove(r)}
                  title="Delete"
                  className="p-1.5 rounded-md text-muted-foreground/70 hover:text-red-600 hover:bg-muted/60 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}

          {/* Add sits at the foot of the table it adds to. */}
          {!composing && (
            <button
              onClick={() => setComposing("new")}
              className="w-full flex items-center gap-2 px-4 py-2.5 bg-muted/25 border-t border-border/60 text-[12.5px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5" /> New routine
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── The composer ────────────────────────────────────────────────────────────
// Inline, not a modal. Creating a routine is writing a sentence and picking a time;
// a dialog that dims the page implies more ceremony than that deserves.

type Draft = {
  name: string;
  prompt: string;
  trigger_kind: "clock" | "before_meeting";
  frequency: string;
  at_time: string;
  day_of_week: number;
  day_of_month: number;
  offset_minutes: number;
};

function Composer({
  initial, onCancel, onSave,
}: {
  initial: Routine | null;
  onCancel: () => void;
  onSave: (d: Draft) => Promise<void>;
}) {
  // Editing opens on what the routine IS. Falling back to defaults per-field (rather
  // than only when `initial` is absent) matters: a before_meeting routine has no
  // frequency, and switching it to a clock schedule mid-edit needs one to land on.
  const [d, setD] = useState<Draft>({
    name:           initial?.name ?? "",
    prompt:         initial?.prompt ?? "",
    trigger_kind:   initial?.trigger_kind ?? "clock",
    frequency:      initial?.frequency ?? "weekly",
    at_time:        (initial?.at_time ?? "07:00").slice(0, 5),   // the column is TIME — "07:00:00"
    day_of_week:    initial?.day_of_week ?? 1,
    day_of_month:   initial?.day_of_month ?? 1,
    offset_minutes: initial?.offset_minutes ?? 60,
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(p => ({ ...p, [k]: v }));

  const valid = d.name.trim() && d.prompt.trim();

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    await onSave(d);
    setSaving(false);
  };

  const field = "w-full bg-transparent border border-border rounded-lg px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/45 focus:outline-none focus:border-foreground/40 transition-colors";
  const select = "bg-transparent border border-border rounded-lg px-2.5 py-1.5 text-[12.5px] text-foreground focus:outline-none focus:border-foreground/40 transition-colors";

  return (
    <div className="mt-5 rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <input
          autoFocus
          value={d.name}
          onChange={e => set("name", e.target.value)}
          placeholder="Weekly pipeline review"
          className={field}
        />
        <button onClick={onCancel} className="p-1.5 mt-0.5 text-muted-foreground/60 hover:text-foreground transition-colors">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <textarea
        value={d.prompt}
        onChange={e => set("prompt", e.target.value)}
        rows={4}
        placeholder="What should the agent do? Write it the way you'd say it to a colleague — it has your whole graph to work with."
        className={cn(field, "resize-none leading-relaxed")}
      />

      {/* Examples, load-on-click. The fastest way to learn what a good prompt looks
          like is to read one and edit it. Not offered while editing — nobody wants
          to overwrite their routine by brushing a chip. */}
      {!d.prompt && !initial && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {EXAMPLES.map(ex => (
            <button
              key={ex.name}
              onClick={() => setD(p => ({ ...p, ...ex }))}
              className="text-[11.5px] px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            >
              {ex.name}
            </button>
          ))}
        </div>
      )}

      {/* When. */}
      <div className="flex flex-wrap items-center gap-2 mt-4">
        <select
          value={d.trigger_kind}
          onChange={e => set("trigger_kind", e.target.value as Draft["trigger_kind"])}
          className={select}
        >
          <option value="clock">On a schedule</option>
          <option value="before_meeting">Before every meeting</option>
        </select>

        {d.trigger_kind === "clock" ? (
          <>
            <select value={d.frequency} onChange={e => set("frequency", e.target.value)} className={select}>
              {["daily", "weekly", "monthly", "quarterly"].map(f => (
                <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>
              ))}
            </select>

            {d.frequency === "weekly" && (
              <select
                value={d.day_of_week}
                onChange={e => set("day_of_week", Number(e.target.value))}
                className={select}
              >
                {DAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}
              </select>
            )}

            {(d.frequency === "monthly" || d.frequency === "quarterly") && (
              <select
                value={d.day_of_month}
                onChange={e => set("day_of_month", Number(e.target.value))}
                className={select}
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>Day {n}</option>
                ))}
              </select>
            )}

            <input
              type="time"
              value={d.at_time}
              onChange={e => set("at_time", e.target.value)}
              className={select}
            />
          </>
        ) : (
          <select
            value={d.offset_minutes}
            onChange={e => set("offset_minutes", Number(e.target.value))}
            className={select}
          >
            {OFFSETS.map(o => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
          </select>
        )}

        <span className="text-[11.5px] text-muted-foreground/50">{TZ}</span>
      </div>

      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={save}
          disabled={!valid || saving}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-foreground text-background text-[12.5px] font-medium disabled:opacity-40 transition-opacity"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {initial ? "Save changes" : "Schedule it"}
        </button>
        <button onClick={onCancel} className="text-[12.5px] text-muted-foreground hover:text-foreground transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}
