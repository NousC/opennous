// The right-hand panel of the flow editor — one per step type, plus the trigger (GET-523).
//
// Every text a step sends can carry variables: {{account.name}}, {{steps.s1.output}}. Type {{
// for a list under the field, or use the braces button beside it; both offer only what THIS
// step can read — the trigger's, and the agent steps above it. A variable from below is a value
// that does not exist yet when the step runs, and is marked in amber like a typo.
import { useContext, useEffect, useRef, useState } from "react";
import { Braces, Check, Coins, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { PreviewContext, shown } from "@/lib/automationPreview";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StepMark, ToolLogo, TriggerMark } from "@/components/AutomationMarks";
import {
  JOBS, SIGNAL_OPTIONS, SIGNAL_OPTION_LABELS, FREQUENCY_LABEL, OFFSET_LABEL,
  type Job, type Payload, type Tool,
} from "@/lib/automations";
import {
  HEALTH_STATES, HUBSPOT_ACTIONS, JOB_INCLUDES, JOB_LABEL, OPS, STEP_LABEL, stepTitle, triggerDef,
  type Flow, type Rule, type Step, type StepConfig, type TriggerConfig,
} from "@/lib/flows";

// One field style for the whole panel: quiet at rest, white and outlined when you are in it.
export const field = "h-9 w-full rounded-[10px] border border-transparent bg-foreground/[0.04] px-3 text-[13px] text-foreground placeholder:text-muted-foreground/50 transition-colors hover:bg-foreground/[0.06] focus:border-foreground/20 focus:bg-background focus:outline-none";
const area = "w-full resize-none rounded-[12px] border border-transparent bg-foreground/[0.04] px-3 py-2.5 text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/50 transition-colors hover:bg-foreground/[0.06] focus:border-foreground/20 focus:bg-background focus:outline-none";
const label = "mb-1.5 block text-[12px] font-medium text-foreground/60";

/** The panel's head: what this is, big enough to be the answer to "what am I editing". */
function PanelHead({ mark, kicker, title, onBack, onRemove }: {
  mark: React.ReactNode; kicker: string; title: string; onBack?: () => void; onRemove?: () => void;
}) {
  return (
    <div className="mb-6 flex items-center gap-3">
      {onBack && (
        <button onClick={onBack} aria-label="Back" className="-ml-1.5 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {mark}
      <div className="min-w-0 flex-1">
        <p className="text-[11.5px] text-muted-foreground/70">{kicker}</p>
        <p className="truncate text-[14px] font-medium text-foreground">{title}</p>
      </div>
      {onRemove && (
        <button onClick={onRemove} aria-label="Remove step" title="Remove step" className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** A titled block in the panel. */
function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      {title && <h3 className="text-[12px] font-medium text-foreground/60">{title}</h3>}
      {children}
    </section>
  );
}

/** Where a group of variables comes from, drawn beside its name: the tool, our record, or an AI step. */
export type VarSource = { tool?: Tool; opennous?: boolean; ai?: boolean; note?: string };
type Vars = { group: string; vars: [string, string][]; source?: VarSource }[];

/** A group's source mark, small enough to sit beside a heading. */
function SourceDot({ source }: { source?: VarSource }) {
  if (source?.tool) return <ToolLogo tool={source.tool} className="h-4 w-4 rounded-[4px] border border-border/60" textClassName="text-[7px] font-semibold" />;
  if (source?.opennous) return <img src="/nous-logo.svg" alt="OpenNous" className="h-4 w-4 rounded-[4px] border border-border/60 bg-white p-[2px]" />;
  if (source?.ai) return <span className="flex h-4 w-4 items-center justify-center rounded-[4px] bg-foreground/[0.07]"><Sparkles className="h-2.5 w-2.5 text-foreground/55" /></span>;
  return null;
}

/** A variable group's heading: where it comes from, then what it is. */
function GroupHead({ group, source }: { group: string; source?: VarSource }) {
  return (
    <p className="flex items-center gap-1.5 px-2 pb-1 text-[11px] text-muted-foreground/80">
      <SourceDot source={source} />
      <span className="font-medium text-foreground/70">{group}</span>
      {source?.note && <span className="truncate text-muted-foreground/60">· {source.note}</span>}
    </p>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-9 w-full items-center rounded-[10px] bg-foreground/[0.05] p-[3px]">
      {options.map(([k, l]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={cn("h-full flex-1 rounded-[8px] px-3 text-[12.5px] transition-all",
            value === k ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted-foreground hover:text-foreground")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** The braces button: every variable this step can read, grouped; a click inserts it. */
function VarMenu({ vars, onPick }: { vars: Vars; onPick: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  if (!vars.length) return null;
  // A HubSpot portal brings hundreds of fields: past a handful, the list gets a search.
  const total = vars.reduce((n, g) => n + g.vars.length, 0);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? vars.map(g => ({ ...g, vars: g.vars.filter(([k, l]) => k.toLowerCase().includes(needle) || l.toLowerCase().includes(needle)) })).filter(g => g.vars.length)
    : vars;
  return (
    <Popover open={open} onOpenChange={o => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Insert a variable"
          aria-label="Insert a variable"
          className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Braces className="h-3 w-3" /> Variable
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[360px] w-64 overflow-y-auto p-1">
        {total > 15 && (
          <div className="sticky top-0 z-10 bg-popover p-1">
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search variables"
              className="h-7 w-full rounded-md bg-foreground/[0.05] px-2 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
        )}
        {!shown.length && <p className="px-2 py-3 text-[12px] text-muted-foreground">No variable matches.</p>}
        {shown.map(g => (
          <div key={g.group} className="py-1">
            <GroupHead group={g.group} source={g.source} />
            {g.vars.map(([k, l]) => (
              <button
                key={k}
                onClick={() => { onPick(`{{${k}}}`); setOpen(false); }}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] text-foreground/85 hover:bg-muted/50"
              >
                <span className="truncate">{l}</span>
                <span className="ml-2 truncate font-mono text-[10.5px] text-muted-foreground/60">{k.replace(/^steps\.[^.]+\./, "")}</span>
              </button>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// A variable as it sits in text: {{account.name}}, spaces inside the braces allowed.
const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;
// Whether a text holds any variable at all (no /g: .test on a global regex carries state).
const HAS_TOKEN = /\{\{\s*[\w.-]+\s*\}\}/;
// An opened {{ the cursor is still inside: what has been typed after it so far.
const OPEN_TOKEN = /\{\{\s*([\w.-]*)$/;

/** Pasted text without the indentation it brought along (a chat, a doc, a terminal). */
function dedent(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(l => l.replace(/[ \t]+$/, ""));
  const indents = lines.filter(l => l.trim()).map(l => (l.match(/^[ \t]*/)?.[0].length ?? 0));
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map(l => l.slice(cut)).join("\n");
}

/**
 * The text again, behind the field, with each variable marked: known ones tinted, anything that
 * is not a variable this step can read in amber — a typo or a step that comes later. The text
 * itself is transparent here; the field on top draws it, so the two must wrap identically.
 */
function Marks({ text, known, single }: { text: string; known: Set<string>; single: boolean }) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    out.push(text.slice(last, at));
    out.push(
      <mark key={at} className={cn("rounded-[4px] text-transparent", known.has(m[1]) ? "bg-sky-500/15 dark:bg-sky-400/20" : "bg-amber-500/25")}>
        {m[0]}
      </mark>,
    );
    last = at + m[0].length;
  }
  // A trailing newline keeps the last empty line's height, as the textarea draws it.
  out.push(text.slice(last) + (single ? "" : "\n"));
  return <>{out}</>;
}

/**
 * The field as it will be sent, variables filled from a real trigger. A variable with no value
 * for this sample says so in amber, rather than vanishing the way it will in the email.
 */
function FilledPreview({ text, labels }: { text: string; labels: Map<string, string> }) {
  const preview = useContext(PreviewContext);
  if (!preview) return null;
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    parts.push(text.slice(last, at));
    const value = shown(preview.vars[m[1]]);
    parts.push(value
      ? <span key={at} className="rounded-[4px] bg-sky-500/10 dark:bg-sky-400/15">{value}</span>
      : <span key={at} className="rounded-[4px] bg-amber-500/15 px-0.5 text-amber-700 dark:text-amber-400">{labels.get(m[1]) ?? m[1]} · empty</span>);
    last = at + m[0].length;
  }
  parts.push(text.slice(last));
  return (
    <div className="mb-1.5 overflow-hidden rounded-[10px] border border-border/70 bg-background">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>Preview with</span>
        {preview.samples.length ? (
          <select
            value={preview.sample?.entity_id ?? ""}
            onChange={e => preview.pick(e.target.value)}
            className="min-w-0 max-w-[60%] truncate rounded-md bg-transparent py-0.5 text-[11px] font-medium text-foreground focus:outline-none"
          >
            {preview.samples.map(x => (
              <option key={x.entity_id} value={x.entity_id}>
                {x.name}{x.at ? ` · ${new Date(x.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
              </option>
            ))}
          </select>
        ) : <span className="text-muted-foreground/70">no recent trigger to preview with</span>}
        {preview.loading && <Loader2 className="ml-auto h-3 w-3 animate-spin" />}
      </div>
      <div className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-[13px] leading-relaxed text-foreground/90">
        {text.trim() ? parts : <span className="text-muted-foreground/60">Nothing written yet.</span>}
      </div>
    </div>
  );
}

/**
 * A text field that takes variables. Type {{ and the variables this step can read open under
 * the field, narrowing as you type; Enter, Tab or a click puts in the whole token and closes
 * it. The braces button still lists them all. Variables in the text are marked.
 */
export function VarField({ label: text, value, onChange, vars, multiline = false, rows = 4, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; vars: Vars;
  multiline?: boolean; rows?: number; placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const v = value ?? "";
  const preview = useContext(PreviewContext);
  const [previewing, setPreviewing] = useState(false);
  const flat = vars.flatMap(g => g.vars.map(([k, l]) => ({ k, l, group: g.group })));
  const known = new Set(flat.map(x => x.k));
  const [open, setOpen] = useState<{ start: number; q: string } | null>(null);
  const [hi, setHi] = useState(0);
  const q = open?.q.toLowerCase() ?? "";
  const matches = open
    ? flat.filter(x => !q || x.k.toLowerCase().includes(q) || x.l.toLowerCase().includes(q)).slice(0, 8)
    : [];

  const detect = (text: string, caret: number | null) => {
    const m = caret == null ? null : text.slice(0, caret).match(OPEN_TOKEN);
    const next = m && flat.length ? { start: caret! - m[0].length, q: m[1] } : null;
    setOpen(prev => {
      if (!next || !prev || prev.q !== next.q) setHi(0);
      return next;
    });
  };

  const place = (next: string, caret: number) => {
    onChange(next);
    requestAnimationFrame(() => { const el = ref.current; el?.focus(); el?.setSelectionRange(caret, caret); });
  };

  // From the braces button: at the cursor.
  const insert = (token: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? v.length;
    const end = el?.selectionEnd ?? at;
    place(v.slice(0, at) + token + v.slice(end), at + token.length);
  };

  // From the list under the field: replaces the {{ and whatever was typed after it.
  const pick = (k: string) => {
    if (!open) return;
    const caret = ref.current?.selectionStart ?? v.length;
    let after = v.slice(caret);
    if (/^\s*\}\}/.test(after)) after = after.replace(/^\s*\}\}/, "");
    const token = `{{${k}}}`;
    setOpen(null);
    place(v.slice(0, open.start) + token + after, open.start + token.length);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || !matches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(h => (h + 1) % matches.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(h => (h - 1 + matches.length) % matches.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[hi].k); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(null); }
  };

  // The marks scroll with the text.
  const sync = () => {
    const el = ref.current, b = back.current;
    if (!el || !b) return;
    b.scrollTop = el.scrollTop;
    b.scrollLeft = el.scrollLeft;
  };
  useEffect(sync, [v]);

  const shell = cn(
    "relative w-full border border-transparent bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.06] focus-within:border-foreground/20 focus-within:bg-background",
    multiline ? "rounded-[12px]" : "h-9 rounded-[10px]",
  );
  // Shared by the field and the marks behind it: same box, same font, same wrapping.
  const text13 = multiline
    ? "px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words"
    : "px-3 text-[13px] leading-9 whitespace-pre";
  const common = {
    ref, value: v, placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart); },
    onSelect: (e: React.SyntheticEvent<HTMLInputElement & HTMLTextAreaElement>) => { detect(e.currentTarget.value, e.currentTarget.selectionStart); sync(); },
    onPaste: (e: React.ClipboardEvent) => {
      const raw = e.clipboardData.getData("text");
      const clean = multiline ? dedent(raw).replace(/^\n+|\n+$/g, "") : raw.replace(/\s*\n\s*/g, " ");
      if (clean !== raw) { e.preventDefault(); insert(clean); }
    },
    onKeyDown, onScroll: sync,
    onBlur: () => setOpen(null),
    "aria-autocomplete": "list" as const,
    "aria-expanded": !!(open && matches.length),
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-medium text-foreground/60">{text}</span>
        <div className="flex items-center gap-0.5">
          {preview && HAS_TOKEN.test(v) && (
            <button
              type="button"
              onClick={() => setPreviewing(p => !p)}
              aria-pressed={previewing}
              title={previewing ? "Hide the preview" : "Preview with a real deal"}
              className={cn("flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors hover:bg-accent hover:text-foreground",
                previewing ? "text-foreground" : "text-muted-foreground")}
            >
              {previewing ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />} Preview
            </button>
          )}
          <VarMenu vars={vars} onPick={insert} />
        </div>
      </div>
      {previewing && preview && <FilledPreview text={v} labels={new Map(flat.map(x => [x.k, x.l]))} />}
      <div className={shell}>
        <div ref={back} aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden text-transparent", text13)}>
          <Marks text={v} known={known} single={!multiline} />
        </div>
        {multiline
          ? <textarea {...common} rows={rows} className={cn("relative block w-full resize-none bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none", text13)} />
          : <input {...common} className={cn("relative block h-full w-full bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none", text13)} />}
        {open && matches.length > 0 && (
          <div role="listbox" className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[280px] overflow-y-auto rounded-[10px] border border-border bg-popover p-1 shadow-lg">
            {matches.map((x, i) => (
              <button
                key={x.k}
                type="button"
                role="option"
                aria-selected={i === hi}
                // mousedown, not click: a click lands after the field's blur has closed the list.
                onMouseDown={e => { e.preventDefault(); pick(x.k); }}
                onMouseEnter={() => setHi(i)}
                className={cn("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12.5px] text-foreground/85",
                  i === hi && "bg-muted/60")}
              >
                <span className="truncate">{x.l} <span className="text-muted-foreground/60">· {x.group}</span></span>
                <span className="ml-2 truncate font-mono text-[10.5px] text-muted-foreground/60">{x.k.replace(/^steps\.[^.]+\./, "")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Trigger ──────────────────────────────────────────────────────────────────

/**
 * Where a trigger comes from — the first thing you pick, the way adding a step starts with the
 * tool. A tool (Fathom, Gmail, HubSpot…) shows its logo; a trigger that belongs to no tool
 * (account signals, a schedule, a webhook) shows an icon.
 */
type Source = {
  key: string; label: string; tool?: Tool; glyph?: string; triggers: string[]; kind?: "meeting" | "crm";
  /** A category of tools (Meeting notetaker): open it, pick the tool, then its trigger. */
  children?: Source[]; parent?: string;
};

// Every CRM we sync deals from, and what a deal can do.
const CRMS: Tool[] = [{ slug: "hubspot", label: "HubSpot" }, { slug: "attio", label: "Attio" }];
const DEAL_TRIGGERS = ["deal_stage_changed", "deal_closed_won", "deal_closed_lost", "deal_stalled", "deal_created"];

// Every recorder we read, in the order people name them.
const NOTETAKERS: Tool[] = [
  { slug: "fathom", label: "Fathom" }, { slug: "granola", label: "Granola" }, { slug: "fireflies", label: "Fireflies" },
  { slug: "fellow", label: "Fellow" }, { slug: "ringcentral", label: "RingCentral" }, { slug: "otter", label: "Otter" },
  { slug: "zoom", label: "Zoom" },
];

function sourcesFor(tools: { meeting: Tool[]; crm: Tool[] }): Source[] {
  // Your recorders and CRMs as they are connected; with none connected, the usual pair, so the
  // picker still says what these triggers are about.
  // Connected recorders first, then the rest we can read.
  const connected = tools.meeting.map(t => t.slug);
  const recorders = [...NOTETAKERS.filter(t => connected.includes(t.slug)), ...NOTETAKERS.filter(t => !connected.includes(t.slug))];
  // The CRMs we sync, connected ones first (Salesforce comes back later). Like the notetakers,
  // they are one category you open, so the list stays one row per kind of tool.
  const crmConnected = tools.crm.map(t => t.slug);
  const crmList = [...CRMS.filter(t => crmConnected.includes(t.slug)), ...CRMS.filter(t => !crmConnected.includes(t.slug))];
  // The order people reach for them: run it yourself, the plumbing, what we detect, then the
  // tools — CRM, Google, recorders — and PostHog last.
  return [
    { key: "manual", label: "Manual", glyph: "manual", triggers: ["manual"] },
    { key: "webhook", label: "Webhook", glyph: "webhook_in", triggers: ["webhook_in"] },
    { key: "clock", label: "Schedule", glyph: "clock", triggers: ["clock"] },
    { key: "signals", label: "Account signals", glyph: "health_changed",
      triggers: ["account_signal", "health_changed", "champion_quiet", "committee_joined", "icp_tier_changed", "expansion_signal", "promise_overdue"] },
    { key: "crm", label: "CRM", glyph: "deal_stage_changed", triggers: DEAL_TRIGGERS,
      // Any field of any HubSpot object can fire one (GET-781): HubSpot only, it keeps field history.
      children: crmList.map(t => ({ key: t.slug, label: t.label, tool: t, triggers: t.slug === "hubspot" ? [...DEAL_TRIGGERS, "hubspot_field_changed"] : DEAL_TRIGGERS, kind: "crm" as const, parent: "crm" })) },
    { key: "gcal", label: "Google Calendar", tool: { slug: "gcal", label: "Google Calendar" }, triggers: ["before_meeting"] },
    { key: "gmail", label: "Gmail", tool: { slug: "gmail", label: "Gmail" }, triggers: ["email_received", "reply_owed", "thread_quiet"] },
    { key: "notetaker", label: "Meeting notetaker", glyph: "call_ended", triggers: ["call_ended"],
      children: recorders.map(t => ({ key: t.slug, label: t.label, tool: t, triggers: ["call_ended"], kind: "meeting" as const, parent: "notetaker" })) },
    { key: "posthog", label: "PostHog", tool: { slug: "posthog", label: "PostHog" }, triggers: ["posthog_event"] },
  ];
}

/** Every source, with a category's tools in place of the category. */
const flatten = (sources: Source[]): Source[] => sources.flatMap(s => s.children ?? [s]);

/** Which source a saved trigger belongs to: its picked tool when it has one. */
function sourceOf(kind: string, picked: string[], sources: Source[]): Source | null {
  const own = flatten(sources).filter(s => s.triggers.includes(kind));
  return own.find(s => s.tool && picked.includes(s.tool.slug)) ?? own[0] ?? null;
}

function SourceMark({ source, size = "sm" }: { source: Source; size?: "sm" | "lg" }) {
  return source.tool
    ? <TriggerMark when="" tools={[source.tool]} size={size} />
    : <TriggerMark when={source.glyph ?? ""} size={size} />;
}

/** A trigger's own settings, under it once it is picked. */
/** Which account signals fire it (GET-686): none picked means any of them. */
export function SignalPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const flip = (k: string) => onChange(value.includes(k) ? value.filter(x => x !== k) : [...value, k]);
  return (
    <div className="flex flex-wrap gap-1.5">
      <button onClick={() => onChange([])}
        className={cn("h-7 rounded-full border px-2.5 text-[12px] transition-colors",
          !value.length ? "border-foreground bg-foreground text-background" : "border-border/80 text-foreground/80 hover:border-foreground/40")}>
        Any signal
      </button>
      {/* A kind no longer offered (a next step, GET-954) still shows while picked, so it can be unpicked. */}
      {[...SIGNAL_OPTIONS, ...SIGNAL_OPTION_LABELS.filter(([k]) => value.includes(k) && !SIGNAL_OPTIONS.some(([o]) => o === k))].map(([k, l]) => {
        const on = value.includes(k);
        return (
          <button key={k} onClick={() => flip(k)}
            className={cn("h-7 rounded-full border px-2.5 text-[12px] transition-colors",
              on ? "border-foreground bg-foreground text-background" : "border-border/80 text-foreground/80 hover:border-foreground/40")}>
            {l}
          </button>
        );
      })}
    </div>
  );
}

function TriggerSettings({ kind, c, set }: { kind: string; c: TriggerConfig; set: (p: TriggerConfig) => void }) {
  return (<>
    {kind === "before_meeting" && (
      <Section title="How long before">
        <select value={String(c.offset ?? 30)} onChange={e => set({ offset: e.target.value })} className={field}>
          {Object.entries(OFFSET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Section>
    )}
    {kind === "clock" && (
      <Section title="Schedule">
        <div className="flex items-center gap-2">
          <select value={c.frequency ?? "daily"} onChange={e => set({ frequency: e.target.value })} className={cn(field, "flex-1")}>
            {Object.entries(FREQUENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="time" value={c.at ?? "08:00"} onChange={e => set({ at: e.target.value })} aria-label="At" className={cn(field, "w-[110px]")} />
        </div>
      </Section>
    )}
    {kind === "account_signal" && (
      <Section title="Which signals">
        <SignalPicker value={c.signals ?? []} onChange={v => set({ signals: v })} />
      </Section>
    )}
    {kind === "health_changed" && (
      <Section title="When it turns">
        <select value={c.to ?? "at_risk"} onChange={e => set({ to: e.target.value })} className={field}>
          {HEALTH_STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Section>
    )}
    {kind === "hubspot_field_changed" && (
      <Section title="The field to watch">
        <HubspotFieldTrigger c={c} set={set} />
      </Section>
    )}
    {kind === "posthog_event" && (
      <Section title="Event">
        <input value={c.event ?? ""} onChange={e => set({ event: e.target.value })} placeholder="usage_dropped" className={cn(field, "font-mono text-[12.5px]")} />
      </Section>
    )}
    {(kind === "deal_stalled" || kind === "thread_quiet" || kind === "champion_quiet") && (
      <Section title="After">
        <div className="flex items-center gap-2">
          <input type="number" min={1} value={c.days ?? (kind === "deal_stalled" ? 14 : 7)} onChange={e => set({ days: Number(e.target.value) })} className={cn(field, "w-[88px]")} />
          <span className="text-[13px] text-muted-foreground">days</span>
        </div>
      </Section>
    )}
    {kind === "reply_owed" && (
      <Section title="After">
        <div className="flex items-center gap-2">
          <input type="number" min={1} value={c.hours ?? 24} onChange={e => set({ hours: Number(e.target.value) })} className={cn(field, "w-[88px]")} />
          <span className="text-[13px] text-muted-foreground">hours</span>
        </div>
      </Section>
    )}
    {kind === "deal_stage_changed" && (
      <Section title="Into stage">
        <input value={c.stage ?? ""} onChange={e => set({ stage: e.target.value })} placeholder="Any stage" className={field} />
      </Section>
    )}
    {kind === "webhook_in" && <p className="text-[12.5px] text-muted-foreground">Its address appears here once saved.</p>}
  </>);
}

/**
 * WHEN — tool first, like adding a step. The list is where triggers come from; open one and
 * only its triggers show, each with its logo, and the one you pick opens its settings below.
 * Picking a trigger inside Fathom picks Fathom: the source is the tool.
 */
/** When a HubSpot field changes (GET-781): the object, the field, and optionally its new or old value. */
function HubspotFieldTrigger({ c, set }: { c: TriggerConfig; set: (patch: Partial<TriggerConfig>) => void }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const ws = userData?.workspace?.id ?? "";
  const api = import.meta.env.VITE_API_URL ?? "";
  const [objects, setObjects] = useState<{ connected: boolean; objects: { id: string; label: string; custom?: boolean }[] } | null>(null);
  const [fields, setFields] = useState<{ name: string; label: string; type: string | null }[] | null>(null);
  useEffect(() => {
    if (!token || !ws) return;
    fetch(`${api}/api/workflows/hubspot/objects?workspaceId=${ws}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { connected: false, objects: [] })).then(setObjects).catch(() => setObjects({ connected: false, objects: [] }));
  }, [api, token, ws]);
  useEffect(() => {
    if (!token || !ws || !c.object) { setFields(null); return; }
    fetch(`${api}/api/workflows/hubspot/objects/${encodeURIComponent(c.object)}/fields?workspaceId=${ws}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { fields: [] })).then(d => setFields(d.fields ?? [])).catch(() => setFields([]));
  }, [api, token, ws, c.object]);
  if (objects && !objects.connected) return <p className="text-[12.5px] text-muted-foreground">HubSpot isn't connected.</p>;
  const nameField = (list: { name: string }[]) => ["name", "company_name", "dealname", "email"].find(n => list.some(f => f.name === n)) ?? "hs_object_id";
  return (
    <div className="space-y-3">
      <select value={c.object ?? ""} className={field} onChange={e => {
        const o = objects?.objects.find(x => x.id === e.target.value);
        set({ object: o?.id ?? "", object_label: o?.label ?? "", property: "", property_label: "", to: "", from: "" });
      }}>
        <option value="">{objects ? "Pick an object" : "Loading…"}</option>
        {(objects?.objects ?? []).map(o => <option key={o.id} value={o.id}>{o.label}{o.custom ? " (custom)" : ""}</option>)}
      </select>
      {c.object && (
        <select value={c.property ?? ""} className={field} onChange={e => {
          const f = fields?.find(x => x.name === e.target.value);
          set({ property: f?.name ?? "", property_label: f?.label ?? "", name_property: nameField(fields ?? []) });
        }}>
          <option value="">{fields ? "Pick the field" : "Loading fields…"}</option>
          {(fields ?? []).map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
        </select>
      )}
      {c.property && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-muted-foreground">Changes to</span>
            <input value={c.to ?? ""} onChange={e => set({ to: e.target.value })} placeholder="Any value" className={field} />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-muted-foreground">From</span>
            <input value={c.from ?? ""} onChange={e => set({ from: e.target.value })} placeholder="Any value" className={field} />
          </label>
        </div>
      )}
      <p className="text-[11.5px] leading-snug text-muted-foreground">Checked every few minutes. Each change runs this once, with the old and new value as {"{{signal.text}}"}.</p>
    </div>
  );
}

export function TriggerPanel({ flow, data, tools, onChange }: {
  flow: Flow; data: Payload; tools: { meeting: Tool[]; crm: Tool[] };
  onChange: (kind: string, config: TriggerConfig) => void;
}) {
  const { kind, config: c } = flow.trigger;
  const sources = sourcesFor(tools);
  const current = kind ? sourceOf(kind, c.tools ?? [], sources) : null;
  const [open, setOpen] = useState<string | null>(current?.key ?? null);
  const [q, setQ] = useState("");
  const live = new Map((data.triggers ?? []).map(t => [t.key, t.live !== false]));
  const set = (patch: TriggerConfig) => onChange(kind, { ...c, ...patch });
  const label = (k: string) => triggerDef(k)?.label ?? k;

  /** Pick a trigger from a source: a recorder or CRM trigger remembers which tool. */
  const choose = (src: Source, k: string) => {
    const keep = k === kind ? c : {};
    onChange(k, src.kind && src.tool ? { ...keep, tools: [src.tool.slug] } : { ...keep, tools: undefined });
  };

  const row = "flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2 text-left transition-colors";
  const soon = (k: string) => live.get(k) === false && <span className="text-[11px] text-muted-foreground/50">soon</span>;

  const src = [...sources, ...flatten(sources)].find(s => s.key === open) ?? null;

  // A category (Meeting notetaker): its tools, the way AI lists ChatGPT and Claude.
  if (src?.children) {
    return (
      <div>
        <PanelHead onBack={() => setOpen(null)} mark={<SourceMark source={src} size="lg" />} kicker="Trigger" title={src.label} />
        <div className="-mx-2 space-y-0.5">
          {src.children.map(ch => {
            const on = current?.key === ch.key;
            const has = (src.key === "crm" ? tools.crm : tools.meeting).some(t => t.slug === ch.key);
            return (
              <button
                key={ch.key}
                onClick={() => { choose(ch, ch.triggers[0]); setOpen(ch.key); }}
                className={cn(row, on ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]")}
              >
                <SourceMark source={ch} />
                <span className={cn("min-w-0 flex-1 text-[13px]", on ? "font-medium text-foreground" : "text-foreground/85")}>{ch.label}</span>
                {!has && <span className="text-[11px] text-muted-foreground/50">not connected</span>}
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (src) {
    return (
      <div>
        <PanelHead onBack={() => setOpen(src.parent ?? null)} mark={<SourceMark source={src} size="lg" />} kicker="Trigger" title={src.label} />
        <div className="-mx-2 space-y-0.5">
          {src.triggers.map(k => {
            const on = k === kind && current?.key === src.key;
            return (
              <button key={k} onClick={() => choose(src, k)} className={cn(row, on ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]")}>
                <SourceMark source={src} />
                <span className={cn("min-w-0 flex-1 text-[13px]", on ? "font-medium text-foreground" : "text-foreground/85")}>{label(k)}</span>
                {soon(k)}
              </button>
            );
          })}
        </div>
        {current?.key === src.key && kind && (
          <div className="mt-6 space-y-4"><TriggerSettings kind={kind} c={c} set={set} /></div>
        )}
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const hits = needle
    ? flatten(sources).flatMap(s => s.triggers.map(k => ({ s, k }))).filter(({ s, k }) => `${s.label} ${label(k)}`.toLowerCase().includes(needle))
    : [];

  return (
    <div>
      <PanelHead mark={current ? <SourceMark source={current} size="lg" /> : <TriggerMark when="" size="lg" />} kicker="Trigger" title={kind ? label(kind) : "When should this run?"} />
      <div className="mb-3 flex h-9 items-center gap-2 rounded-[10px] bg-foreground/[0.04] px-3">
        <Search className="h-3.5 w-3.5 text-muted-foreground/60" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" className="h-full w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none" />
      </div>
      <div className="-mx-2 space-y-0.5">
        {needle ? (
          hits.length ? hits.map(({ s, k }) => (
            <button key={`${s.key}:${k}`} onClick={() => { choose(s, k); setOpen(s.key); setQ(""); }} className={cn(row, "hover:bg-foreground/[0.03]")}>
              <SourceMark source={s} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">{label(k)}</span>
              <span className="text-[11px] text-muted-foreground/60">{s.label}</span>
            </button>
          )) : <p className="px-2.5 py-2 text-[12.5px] text-muted-foreground">Nothing matches.</p>
        ) : sources.map(s => {
          const on = current?.key === s.key || current?.parent === s.key;
          return (
            <button
              key={s.key}
              onClick={() => { if (!s.children && s.triggers.length === 1) choose(s, s.triggers[0]); setOpen(s.key); }}
              className={cn(row, on ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.03]")}
            >
              <SourceMark source={s} />
              <span className={cn("min-w-0 flex-1 text-[13px]", on ? "font-medium text-foreground" : "text-foreground/85")}>{s.label}</span>
              {s.children || s.triggers.length > 1
                ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                : soon(s.triggers[0])}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

export type Mailbox = { id: string; kind: "gmail" | "smtp"; email: string | null };

/** Where an email goes from (GET-716): a Gmail account holds a draft; SMTP sends once you approve. */
function SendFrom({ mailboxes, value, onChange, allowNone = false, none = false, onNone }: {
  mailboxes: Mailbox[]; value?: Mailbox | null; onChange: (m: Mailbox | null) => void;
  allowNone?: boolean; none?: boolean; onNone?: (v: boolean) => void;
}) {
  // No choice = the account owner's Gmail (GET-722): yours on your accounts, theirs on theirs.
  const current = none ? "none" : value?.id ?? "owner";
  const picked = mailboxes.find(m => m.id === current) ?? null;
  return (
    <div>
      <span className={label}>Send from</span>
      <select value={current} className={field} onChange={e => {
        const v = e.target.value;
        if (v === "none") { onNone?.(true); return; }
        onNone?.(false);
        onChange(v === "owner" ? null : mailboxes.find(m => m.id === v) ?? null);
      }}>
        <option value="owner">Account owner's Gmail</option>
        {mailboxes.map(m => <option key={m.id} value={m.id}>{m.kind === "gmail" ? "Gmail" : "SMTP"} · {m.email ?? "mailbox"}</option>)}
        {allowNone && <option value="none">Nowhere, just write it</option>}
      </select>
      <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
        {current === "none" ? "Written and kept on the run."
          : current === "owner" ? "A draft in the Gmail of whoever owns the account; if they have none connected, in yours. You send it."
          : picked?.kind === "smtp" ? "SMTP has no drafts: it waits in Approvals, and approving sends it from this mailbox."
          : "A draft in that Gmail, to the people on the call. You send it."}
      </p>
    </div>
  );
}

type PanelProps = {
  mailboxes?: Mailbox[];
  step: Step; flow: Flow; vars: Vars; triggerKind: string;
  /** Model keys this workspace has connected; the agent can run on one of them. */
  models: Tool[];
  lockedBy: (j: Job) => string | null;
  set: (patch: StepConfig) => void;
};

const PICKABLE_JOBS = ["follow_up", "call_summary", "premeeting_brief", "account_summary", "deal_handoff"];

/**
 * AI — which model, what it does, how, and a real call to prove it. The model list comes from
 * the key you connected, so it is what that key can actually use; Test runs the step once on it.
 */
// The AI step (GET-710), in one of two shapes. OpenNous: pick the job from a dropdown, add your own
// instructions, and (for a follow-up) where the draft goes. AI: write your own instructions. No
// model, no settings, no "what it reads": OpenNous writes every run and builds what it reads from
// the trigger. What it costs is said at the top.
const JOB_CREDITS: Record<string, string> = {
  follow_up: "1–2", call_summary: "4–7", premeeting_brief: "4–7", account_summary: "4–7", deal_handoff: "4–7",
};

function AgentPanel({ step, flow, vars, set, mailboxes }: PanelProps) {
  const c = step.config;
  const opennous = c.mode === "pick";
  // What a run of this step costs, measured on real runs at the plan's rate (one credit per $0.005
  // of model cost, GET-721). A long transcript sits at the top of the range.
  const range = opennous ? (JOB_CREDITS[c.job ?? ""] ?? "2–7") : "2–7";
  const cost = (
    <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <Coins className="h-3.5 w-3.5" strokeWidth={1.8} /> Usually {range} credits a run
    </p>
  );
  if (!opennous) {
    return (<>
      {cost}
      <StepInputs step={step} flow={flow} set={set} />
      <VarField label="Instructions" multiline rows={10} value={c.prompt ?? ""} onChange={v => set({ prompt: v })} vars={vars}
        placeholder="Find anything they said about budget or timing. If they named a date, draft a one-line nudge for that week." />
    </>);
  }
  const jobs = JOBS.filter(j => PICKABLE_JOBS.includes(j.id));
  return (<>
    {cost}
    <StepInputs step={step} flow={flow} set={set} />
    <label className="block">
      <span className={label}>Action</span>
      <select value={c.job ?? ""} onChange={e => set({ job: e.target.value })} className={field}>
        {!c.job && <option value="">Pick one</option>}
        {jobs.map(j => <option key={j.id} value={j.id}>{JOB_LABEL[j.id] ?? j.name}</option>)}
      </select>
    </label>
    {c.job && JOB_INCLUDES[c.job] && (
      <div>
        <span className={label}>What's included</span>
        <ul className="space-y-1">
          {JOB_INCLUDES[c.job].map(x => (
            <li key={x} className="flex items-start gap-2 text-[12.5px] leading-snug text-foreground/80">
              <Check className="mt-[2px] h-3 w-3 flex-shrink-0 text-muted-foreground/60" strokeWidth={2} />{x}
            </li>
          ))}
        </ul>
      </div>
    )}
    <VarField label="Additional instructions" multiline rows={3} value={c.extra ?? ""} onChange={v => set({ extra: v })} vars={vars}
      placeholder={c.job === "follow_up" ? "Anything else, e.g. mention the pilot pricing, or write in German." : "Anything else it should cover or leave out."} />
    {c.job === "follow_up" && (
      flow.steps.some(x => x.type === "gmail" || x.type === "email") ? (
        <p className="text-[11.5px] text-muted-foreground">Your email step below sends it.</p>
      ) : (
        <SendFrom mailboxes={mailboxes ?? []} value={c.send_from} onChange={m => set({ send_from: m, draft_in: "gmail" })}
          allowNone none={c.draft_in === "none"} onNone={v => set({ draft_in: v ? "none" : "gmail" })} />
      )
    )}
  </>);
}



const COMMON_PROPS: Record<string, string[]> = {
  update_deal: ["dealstage", "amount", "closedate", "hs_next_step", "description"],
  update_contact: ["lifecyclestage", "hs_lead_status", "jobtitle", "phone"],
  update_company: ["lifecyclestage", "description", "industry", "numberofemployees"],
};

// The fields "Based on what was discussed" may set, by default (mirrors core AI_FIELD_DEFAULTS).
const AI_FIELD_DEFAULTS: Record<string, string[]> = {
  update_deal: ["hs_next_step", "closedate", "amount", "description"],
  update_contact: ["jobtitle", "phone", "city"],
  update_company: ["description", "numberofemployees", "city"],
};

/** Which fields the AI may fill (GET-715): the defaults, or your own list. */
function AiFieldsPicker({ action, value, onChange }: { action: string; value?: string[]; onChange: (v: string[]) => void }) {
  const list = value?.length ? value : AI_FIELD_DEFAULTS[action] ?? [];
  const [adding, setAdding] = useState("");
  const add = () => { const n = adding.trim(); if (n && !list.includes(n)) onChange([...list, n]); setAdding(""); };
  return (
    <div>
      <p className="mb-2 text-[11.5px] leading-snug text-muted-foreground">
        The AI reads the conversation and fills a field only when something said supports it, with the quote. Nothing said, nothing written.
      </p>
      <span className={label}>It may update</span>
      <div className="flex flex-wrap gap-1.5">
        {list.map(f => (
          <span key={f} className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.05] px-2 py-0.5 font-mono text-[11.5px] text-foreground/80">
            {f}
            <button onClick={() => onChange(list.filter(x => x !== f))} aria-label={`Remove ${f}`} className="text-muted-foreground/60 hover:text-foreground"><X className="h-3 w-3" /></button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input list={`ai-${action}`} value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add(); }}
          placeholder="Add a field" className={cn(field, "w-[180px] font-mono text-[12px]")} />
        <datalist id={`ai-${action}`}>{(COMMON_PROPS[action] ?? []).map(n => <option key={n} value={n} />)}</datalist>
        <button onClick={add} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><Plus className="h-3 w-3" /> Add</button>
      </div>
    </div>
  );
}

// Where each HubSpot action lands (GET-708), said under the picker so nobody has to guess.
const HUBSPOT_WHERE: Record<string, string> = {
  read: "Reads records for a window of days and compares them to the period before. The next steps get a short table.",
  note: "On the deal, the company and the people this run is about.",
  task: "On the deal, the company and the people this run is about.",
  update_deal: "The deal that fired it, else the account's open deal.",
  update_contact: "The person the run is about: who was on the call, or who raised the signal.",
  update_company: "The account's company record.",
};

/** What a Read records step hands the next steps right now (GET-787): the real table, nothing run or saved. */
function ReadPreview({ config }: { config: Step["config"] }) {
  const { session, userData } = useAuth();
  const [out, setOut] = useState<{ busy: boolean; text?: string; error?: string } | null>(null);
  const ready = !!config.object && (config.fields ?? []).length > 0;
  const run = async () => {
    setOut({ busy: true });
    const r = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/workflows/hubspot/read-preview?workspaceId=${userData?.workspace?.id ?? ""}`, {
      method: "POST", headers: { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" }, body: JSON.stringify({ config }),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setOut(d?.ok ? { busy: false, text: d.text } : { busy: false, error: String(d?.reason ?? "Couldn't read HubSpot.").replace(/_/g, " ") });
  };
  return (
    <div>
      <button type="button" onClick={() => void run()} disabled={!ready || out?.busy}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50">
        {out?.busy && <Loader2 className="h-3 w-3 animate-spin" />}Preview what it reads
      </button>
      {out?.error && <p className="mt-1.5 text-[12px] text-risk">{out.error}</p>}
      {out?.text && <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.04] p-2.5 font-mono text-[11px] leading-relaxed text-foreground/85">{out.text}</pre>}
    </div>
  );
}

/**
 * Context (GET-791): which outputs from the steps above an AI step reads. Any Read records step and
 * any earlier AI step, picked from one dropdown. Unset, every Read step above it (as before).
 */
function StepInputs({ step, flow, set }: { step: Step; flow: Flow; set: (patch: Partial<Step["config"]>) => void }) {
  const [open, setOpen] = useState(false);
  const at = flow.steps.findIndex(x => x.id === step.id);
  const sources = flow.steps.slice(0, Math.max(0, at)).map((s, i) => ({ s, i }))
    .filter(({ s }) => s.type === "agent" || (s.type === "hubspot" && s.config.action === "read"))
    .map(({ s, i }) => {
      const read = s.type === "hubspot";
      return { id: s.id, step: s, read, name: read ? (s.config.object_label ?? "HubSpot records") : "AI output", where: `Step ${i + 1} · ${read ? "HubSpot" : "AI"}` };
    });
  if (!sources.length) return null;
  const off = step.config.inputs_off ?? [];
  const chosen = step.config.inputs ?? sources.filter(x => x.read && !off.includes(x.id)).map(x => x.id);
  const picked = sources.filter(x => chosen.includes(x.id));
  const toggle = (id: string) => set({ inputs: chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id], inputs_off: undefined });
  return (
    <div>
      <span className={label}>Context</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={cn(field, "flex items-center gap-2 text-left")}>
            {picked.length ? (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <StepMark type={picked[0].step.type} />
                <span className="truncate">{picked.map(x => x.name).join(", ")}</span>
              </span>
            ) : <span className="flex-1 text-muted-foreground/60">Nothing from earlier steps</span>}
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1">
          {sources.map(x => (
            <button key={x.id} type="button" onClick={() => toggle(x.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50">
              <StepMark type={x.step.type} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-foreground/85">{x.name}</span>
                <span className="block text-[11px] text-muted-foreground">{x.where}</span>
              </span>
              <Check className={cn("h-3.5 w-3.5 flex-shrink-0", chosen.includes(x.id) ? "text-foreground" : "text-transparent")} strokeWidth={2} />
            </button>
          ))}
        </PopoverContent>
      </Popover>
      <span className="mt-1 block text-[11.5px] text-muted-foreground">Passed in on its own. Anything else goes in from Variable.</span>
      {picked.filter(x => x.read).map(x => <div key={x.id} className="mt-2"><ReadPreview config={x.step.config} /></div>)}
    </div>
  );
}

type HsObject = { id: string; label: string; custom?: boolean };
type HsField = { name: string; label: string; type: string | null };

/** HubSpot · Read records (GET-773): the object, its fields, the name field, the date field, the window. */
function HubspotReadFields({ c, set }: { c: Step["config"]; set: (patch: Partial<Step["config"]>) => void }) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const ws = userData?.workspace?.id ?? "";
  const api = import.meta.env.VITE_API_URL ?? "";
  const [objects, setObjects] = useState<{ connected: boolean; objects: HsObject[] } | null>(null);
  const [fields, setFields] = useState<HsField[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!token || !ws) return;
    fetch(`${api}/api/workflows/hubspot/objects?workspaceId=${ws}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { connected: false, objects: [] })).then(setObjects).catch(() => setObjects({ connected: false, objects: [] }));
  }, [api, token, ws]);
  useEffect(() => {
    if (!token || !ws || !c.object) { setFields(null); return; }
    setFields(null);
    fetch(`${api}/api/workflows/hubspot/objects/${encodeURIComponent(c.object)}/fields?workspaceId=${ws}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { fields: [] })).then(d => setFields(d.fields ?? [])).catch(() => setFields([]));
  }, [api, token, ws, c.object]);
  // Sensible defaults once the fields are in: the "date" field to window on, a name to group by.
  useEffect(() => {
    if (!fields?.length) return;
    const has = (n: string) => fields.some(f => f.name === n);
    const patch: Partial<Step["config"]> = {};
    if (!c.date_property) patch.date_property = has("date") ? "date" : has("metric_date") ? "metric_date" : "hs_createdate";
    if (!c.group_by) patch.group_by = has("company_name") ? "company_name" : has("name") ? "name" : has("dealname") ? "dealname" : "hs_object_id";
    if (Object.keys(patch).length) set(patch);
  }, [fields, c.date_property, c.group_by, set]);
  if (objects && !objects.connected) return <p className="text-[12.5px] text-muted-foreground">HubSpot isn't connected.</p>;
  const numeric = (fields ?? []).filter(f => f.type === "number");
  const dates = (fields ?? []).filter(f => f.type === "date" || f.type === "datetime");
  const chosen = new Set(c.fields ?? []);
  const toggle = (f: HsField) => {
    const next = chosen.has(f.name) ? (c.fields ?? []).filter(n => n !== f.name) : [...(c.fields ?? []), f.name];
    set({ fields: next, field_labels: (fields ?? []).filter(x => next.includes(x.name)).map(x => ({ name: x.name, label: x.label })) });
  };
  const shown = numeric.filter(f => !q || `${f.label} ${f.name}`.toLowerCase().includes(q.toLowerCase()));
  return (<>
    <label className="block">
      <span className={label}>Object</span>
      <select value={c.object ?? ""} className={field} onChange={e => {
        const o = objects?.objects.find(x => x.id === e.target.value);
        set({ object: o?.id ?? "", object_label: o?.label ?? "", fields: [], field_labels: [], group_by: "", date_property: "" });
      }}>
        <option value="">{objects ? "Pick what to read" : "Loading…"}</option>
        {(objects?.objects ?? []).map(o => <option key={o.id} value={o.id}>{o.label}{o.custom ? " (custom)" : ""}</option>)}
      </select>
    </label>
    {c.object && (<>
      <label className="block">
        <span className={label}>Time window</span>
        <select value={c.window ?? "yesterday"} className={field} onChange={e => set({ window: e.target.value as Step["config"]["window"] })}>
          <option value="yesterday">Last 24 hours</option>
          <option value="last_7_days">Last 7 days</option>
          <option value="last_30_days">Last 30 days</option>
        </select>
        <span className="mt-1 block text-[11.5px] text-muted-foreground">Whole days, up to midnight.</span>
      </label>
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-[12.5px] text-foreground">Compare with the period before</span>
        <Switch checked={c.compare !== false} onCheckedChange={v => set({ compare: v })} aria-label="Compare with the period before" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className={label}>Date field</span>
          <select value={c.date_property ?? ""} className={field} onChange={e => set({ date_property: e.target.value })}>
            {dates.map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={label}>One row per</span>
          <select value={c.group_by ?? ""} className={field} onChange={e => set({ group_by: e.target.value })}>
            <option value="hs_object_id">Record</option>
            {(fields ?? []).filter(f => f.type === "string" || f.type === "enumeration").map(f => <option key={f.name} value={f.name}>{f.label}</option>)}
          </select>
        </label>
      </div>
      <div>
        <span className={label}>Numbers to read {chosen.size ? <span className="font-normal text-muted-foreground">· {chosen.size} picked</span> : null}</span>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search fields, e.g. count" className={cn(field, "mb-1.5")} />
        <div className="max-h-[240px] space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
          {fields === null ? <p className="px-2 py-1.5 text-[12px] text-muted-foreground">Loading fields…</p>
            : !shown.length ? <p className="px-2 py-1.5 text-[12px] text-muted-foreground">No number fields match.</p>
            : shown.map(f => (
              <label key={f.name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[12.5px] hover:bg-hover">
                <input type="checkbox" checked={chosen.has(f.name)} onChange={() => toggle(f)} />
                <span className="min-w-0 flex-1 truncate">{f.label}</span>
              </label>
            ))}
        </div>
      </div>
      <ReadPreview config={c} />
    </>)}
  </>);
}

function HubspotPanel({ step, flow, vars, set }: PanelProps) {
  const c = step.config;
  const props: { name: string; value: string }[] = c.properties ?? [];
  const setProp = (i: number, patch: Partial<{ name: string; value: string }>) =>
    set({ properties: props.map((p, j) => j === i ? { ...p, ...patch } : p) });
  return (<>
    <label className="block">
      <span className={label}>Action</span>
      <select value={c.action ?? "note"} onChange={e => set({ action: e.target.value })} className={field}>
        {HUBSPOT_ACTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </label>
    <p className="-mt-1 text-[11.5px] leading-snug text-muted-foreground">{HUBSPOT_WHERE[c.action ?? "note"]}</p>
    {c.action === "read" && <HubspotReadFields c={c} set={set} />}
    {c.action === "task" && (<>
      <div>
        <span className={label}>Tasks</span>
        <Seg value={c.task_from === "call" ? "call" : "one"} options={[["call", "The call's next steps"], ["one", "One you write"]]} onChange={v => set({ task_from: v })} />
        {c.task_from === "call" && (
          <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
            One task for each next step we owe from the call, due when it was promised.{flow.trigger.kind !== "call_ended" ? " Only after a call: pick When a call ends." : ""}
          </p>
        )}
      </div>
      {c.task_from !== "call" && (<>
        <VarField label="Title" value={c.title} onChange={v => set({ title: v })} vars={vars} placeholder="Save plan: {{account.name}}" />
        <VarField label="Notes" multiline rows={4} value={c.body} onChange={v => set({ body: v })} vars={vars} />
      </>)}
      <label className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">Due in</span>
        <input type="number" min={0} value={c.due_days ?? 1} onChange={e => set({ due_days: Number(e.target.value) })} className={cn(field, "w-[80px]")} />
        <span className="text-[12px] text-muted-foreground">days{c.task_from === "call" ? ", when no date was said" : ""}</span>
      </label>
    </>)}
    {c.action === "note" && (
      <VarField label="Note" multiline rows={6} value={c.body} onChange={v => set({ body: v })} vars={vars} placeholder="Leave empty to write what the AI step wrote" />
    )}
    {String(c.action ?? "").startsWith("update_") && (
      <div>
        <span className={label}>Fields</span>
        <Seg value={c.fill === "ai" ? "ai" : "fields"} options={[["ai", "Based on what was discussed"], ["fields", "Fields you set"]]} onChange={v => set({ fill: v })} />
      </div>
    )}
    {String(c.action ?? "").startsWith("update_") && c.fill === "ai" && (
      <AiFieldsPicker action={c.action ?? "update_deal"} value={c.ai_fields} onChange={v => set({ ai_fields: v })} />
    )}
    {String(c.action ?? "").startsWith("update_") && c.fill !== "ai" && (
      <div>
        <span className={label}>Fields</span>
        <div className="space-y-2">
          {props.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input list={`hs-${c.action}`} value={p.name} onChange={e => setProp(i, { name: e.target.value })} placeholder="property" className={cn(field, "w-[140px] font-mono text-[12px]")} />
              <input value={p.value} onChange={e => setProp(i, { value: e.target.value })} placeholder="{{steps…output}}" className={field} />
              <button onClick={() => set({ properties: props.filter((_, j) => j !== i) })} aria-label="Remove" className="text-muted-foreground/60 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
          <datalist id={`hs-${c.action}`}>{(COMMON_PROPS[c.action] ?? []).map(n => <option key={n} value={n} />)}</datalist>
          <button onClick={() => set({ properties: [...props, { name: "", value: "" }] })} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
            <Plus className="h-3 w-3" /> Field
          </button>
        </div>
      </div>
    )}
  </>);
}

function MessagePanel({ step, vars, set, withSubject, withMode, mailboxes }: PanelProps & { withSubject: boolean; withMode?: boolean }) {
  const c = step.config;
  return (<>
    {step.type === "gmail" && (
      <SendFrom mailboxes={mailboxes ?? []} value={c.send_from} onChange={m => set({ send_from: m })} />
    )}
    {withMode && <Seg value={c.mode ?? "draft"} options={[["draft", "Draft"], ["send", "Send"]]} onChange={m => set({ mode: m })} />}
    <VarField label="To" value={c.to} onChange={v => set({ to: v })} vars={vars} placeholder="{{person.email}}" />
    <VarField label="Cc" value={c.cc} onChange={v => set({ cc: v })} vars={vars} placeholder="optional" />
    {withSubject && <VarField label="Subject" value={c.subject} onChange={v => set({ subject: v })} vars={vars} placeholder="Following up" />}
    <VarField label="Body" multiline rows={7} value={c.body} onChange={v => set({ body: v })} vars={vars} />
    {step.type === "email" && (
      <div>
        <span className={label}>Attachment</span>
        <Seg
          value={c.attach === "none" ? "none" : "pdf"}
          options={[["pdf", "AI output as PDF"], ["none", "No attachment"]]}
          onChange={a => set({ attach: a })}
        />
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {c.attach === "none"
            ? "Nothing attached. Put {{…output}} in the body to send the AI's words in the email itself."
            : "The AI step's output, as \"<Account> Account Brief.pdf\"."}
        </p>
      </div>
    )}
    {withMode && c.mode === "send" && (
      <p className="text-[11.5px] text-muted-foreground">Sends as you. Keep an Approval above it.</p>
    )}
  </>);
}

type SlackTargets = { connected: boolean; error?: string; channels: { id: string; name: string; private: boolean; member: boolean }[]; people: { id: string; name: string; email: string | null }[] };

/** The connected Slack's channels and people, for the Slack step (GET-771). */
function useSlackTargets() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const ws = userData?.workspace?.id ?? "";
  const [data, setData] = useState<SlackTargets | null>(null);
  useEffect(() => {
    if (!token || !ws) return;
    let alive = true;
    fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/slack/targets?workspaceId=${encodeURIComponent(ws)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : { connected: false, channels: [], people: [] })).then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ connected: false, channels: [], people: [] }); });
    return () => { alive = false; };
  }, [token, ws]);
  return { data, token, ws };
}

const SLACK_WORDS: Record<string, string> = {
  slack_not_in_channel: "The Nous app isn't in that channel. In Slack, type /invite @Nous in it, then try again.",
  slack_not_connected: "Slack isn't connected. Connect it in Sources.",
  slack_channel_not_found: "Slack can't see that channel. If it's private, invite the Nous app: type /invite @Nous in the channel.",
  slack_is_archived: "That channel is archived in Slack. Pick another one.",
  slack_user_not_found: "Slack can't find that person.",
  slack_invalid_auth: "The Slack connection expired. Reconnect Slack in Sources.",
  slack_missing_scope: "The Slack connection is missing a permission. Reconnect Slack in Sources.",
};

function SlackPanel({ step, vars, set }: PanelProps) {
  const c = step.config;
  const { data, token, ws } = useSlackTargets();
  const dm = c.action === "dm";
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string } | null>(null);
  const chosen = data?.channels.find(ch => ch.id === c.channel_id) ?? (c.channel ? data?.channels.find(ch => ch.name === String(c.channel).replace(/^#/, "")) : undefined);
  const sendTest = async () => {
    setTest({ busy: true });
    const r = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/slack/test`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: ws, ...(dm ? { user_id: c.user_id } : { channel_id: chosen?.id ?? c.channel_id }) }),
    }).catch(() => null);
    const out = r ? await r.json().catch(() => ({})) : {};
    setTest(out?.ok ? { busy: false, ok: true, text: dm ? `Sent to ${c.user_name ?? "them"}.` : `Posted in #${chosen?.name ?? c.channel}.` }
      : { busy: false, ok: false, text: SLACK_WORDS[out?.reason] ?? `Slack said: ${String(out?.reason ?? "no answer").replace(/^slack_/, "").replace(/_/g, " ")}` });
  };
  if (data && !data.connected) return (
    <p className="rounded-lg bg-foreground/[0.04] px-3 py-2.5 text-[12.5px] text-muted-foreground">
      Slack isn't connected. <a href="/company-sources?connect=slack" className="text-foreground underline underline-offset-2">Connect Slack</a> in Sources, then pick where this posts.
    </p>
  );
  return (<>
    <div className="flex h-8 items-center rounded-lg bg-foreground/[0.05] p-[3px] text-[12.5px]">
      {([["channel", "Post in a channel"], ["dm", "Send a direct message"]] as const).map(([k, l]) => (
        <button key={k} type="button" onClick={() => { set({ action: k }); setTest(null); }}
          className={cn("h-full flex-1 rounded-[6px] transition-colors", (k === "dm") === dm ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted-foreground hover:text-foreground")}>
          {l}
        </button>
      ))}
    </div>
    {!data ? (
      <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Reading your Slack…</p>
    ) : dm ? (
      <label className="block">
        <span className={label}>Person</span>
        <select value={c.user_id ?? ""} className={field} onChange={e => {
          const p = data.people.find(x => x.id === e.target.value);
          set({ user_id: p?.id ?? null, user_name: p?.name ?? null }); setTest(null);
        }}>
          <option value="">Pick a person</option>
          {data.people.map(p => <option key={p.id} value={p.id}>{p.name}{p.email ? ` · ${p.email}` : ""}</option>)}
        </select>
      </label>
    ) : (
      <label className="block">
        <span className={label}>Channel</span>
        <select value={chosen?.id ?? ""} className={field} onChange={e => {
          const ch = data.channels.find(x => x.id === e.target.value);
          set({ channel_id: ch?.id ?? null, channel: ch?.name ?? "" }); setTest(null);
        }}>
          <option value="">Pick a channel</option>
          {data.channels.map(ch => <option key={ch.id} value={ch.id}>{ch.private ? "🔒 " : "#"}{ch.name}{ch.member ? "" : "  (invite the bot first)"}</option>)}
        </select>
        {chosen && !chosen.member && (
          <span className="mt-1.5 block text-[11.5px] leading-snug text-muted-foreground">The Nous app isn't in #{chosen.name} yet. In Slack, type <span className="font-mono text-foreground">/invite @Nous</span> in the channel.</span>
        )}
        {data.error && <span className="mt-1.5 block text-[11.5px] text-risk">Slack said: {data.error.replace(/_/g, " ")}</span>}
      </label>
    )}
    <VarField label="Message" multiline rows={6} value={c.text} onChange={v => set({ text: v })} vars={vars}
      placeholder="Leave empty to send what the AI step wrote." />
    <div className="flex items-center gap-3">
      <button type="button" onClick={() => void sendTest()} disabled={test?.busy || (dm ? !c.user_id : !(chosen?.id ?? c.channel_id))}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] text-foreground transition-colors hover:bg-accent disabled:opacity-50">
        {test?.busy && <Loader2 className="h-3 w-3 animate-spin" />}Send a test message
      </button>
      {test?.text && <span className={cn("text-[12px] leading-snug", test.ok ? "text-muted-foreground" : "text-risk")}>{test.text}</span>}
    </div>
  </>);
}

function WebhookPanel({ step, set }: PanelProps) {
  return (<>
    <label className="block">
      <span className={label}>URL</span>
      <input value={step.config.url ?? ""} onChange={e => set({ url: e.target.value })} placeholder="https://…" className={field} />
    </label>
    <p className="text-[11.5px] text-muted-foreground">Receives the variables and step outputs as JSON.</p>
  </>);
}

function OnlyIfPanel({ step, vars, set }: PanelProps) {
  const c = step.config;
  const rules: Rule[] = c.rules ?? [];
  const fields = vars.flatMap(g => g.vars.map(([k, l]) => ({ k, l: `${g.group} · ${l}` })));
  const setRule = (i: number, patch: Partial<Rule>) => set({ rules: rules.map((r, j) => j === i ? { ...r, ...patch } : r) });
  return (<>
    <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      Carry on when
      <select value={c.match ?? "all"} onChange={e => set({ match: e.target.value })} className={cn(field, "h-[28px] w-auto")}>
        <option value="all">all</option><option value="any">any</option>
      </select>
      of these hold
    </div>
    <div className="space-y-2.5">
      {rules.map((r, i) => (
        <div key={i} className="space-y-1.5 rounded-xl border border-border p-2.5">
          <div className="flex items-center gap-2">
            <select value={r.field} onChange={e => setRule(i, { field: e.target.value })} className={field}>
              {!fields.some(f => f.k === r.field) && <option value={r.field}>{r.field || "Pick a field"}</option>}
              {fields.map(f => <option key={f.k} value={f.k}>{f.l}</option>)}
            </select>
            <button onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} aria-label="Remove rule" className="text-muted-foreground/60 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="flex items-center gap-2">
            <select value={r.op} onChange={e => setRule(i, { op: e.target.value })} className={cn(field, "w-[140px]")}>
              {OPS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {r.op !== "set" && r.op !== "not_set" && (
              <input value={r.value} onChange={e => setRule(i, { value: e.target.value })} placeholder="value" className={field} />
            )}
          </div>
        </div>
      ))}
      <button onClick={() => set({ rules: [...rules, { field: fields[0]?.k ?? "", op: "is", value: "" }] })} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
        <Plus className="h-3 w-3" /> Rule
      </button>
    </div>
  </>);
}

function WaitPanel({ step, set }: PanelProps) {
  const c = step.config;
  return (<>
    <Seg value={c.mode ?? "duration"} options={[["duration", "For a while"], ["until_reply", "Until they reply"]]} onChange={m => set({ mode: m })} />
    <label className="flex items-center gap-2">
      <span className="text-[12px] text-muted-foreground">{c.mode === "until_reply" ? "At most" : "For"}</span>
      <input type="number" min={1} value={c.amount ?? 1} onChange={e => set({ amount: Number(e.target.value) })} className={cn(field, "w-[80px]")} />
      <select value={c.unit ?? "days"} onChange={e => set({ unit: e.target.value })} className={cn(field, "w-[110px]")}>
        <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
      </select>
    </label>
    {c.mode === "until_reply" && <p className="text-[11.5px] text-muted-foreground">A reply ends the run.</p>}
  </>);
}

function ApprovalPanel() {
  return <p className="text-[13px] leading-relaxed text-muted-foreground">Held on Home until you approve. Rejecting ends the run.</p>;
}

export function StepPanel(props: PanelProps & { onRemove: () => void; index: number }) {
  const { step, flow, onRemove, index } = props;
  return (
    <div>
      <PanelHead
        mark={<StepMark type={step.type} model={step.config.model} size="lg" />}
        kicker={`Step ${index + 1} · ${STEP_LABEL[step.type]}`}
        title={stepTitle(step)}
        onRemove={onRemove}
      />
      <div className="space-y-5">
        {step.type === "agent" && <AgentPanel {...props} />}
        {step.type === "hubspot" && <HubspotPanel {...props} />}
        {step.type === "gmail" && <MessagePanel {...props} withSubject withMode />}
        {step.type === "email" && <MessagePanel {...props} withSubject />}
        {step.type === "slack" && <SlackPanel {...props} />}
        {step.type === "webhook" && <WebhookPanel {...props} />}
        {step.type === "only_if" && <OnlyIfPanel {...props} />}
        {step.type === "wait" && <WaitPanel {...props} />}
        {step.type === "approval" && <ApprovalPanel />}
        {step.type === "agent" && step.config.mode === "pick" && step.config.job === "follow_up" && step.config.draft_in !== "none"
          && !flow.steps.some(x => x.type === "gmail" || x.type === "email") && (
          // The OpenNous follow-up's own draft always waits for a person (GET-739): no switch.
          <div className="border-t border-border/60 pt-4">
            <span className="block text-[13px] font-medium text-foreground">Always waits for your approval</span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">The email is drafted only once you approve it, and you can edit it first.</span>
          </div>
        )}
        {["hubspot", "gmail", "email", "slack", "webhook"].includes(step.type) && !(step.type === "hubspot" && step.config.action === "read") && (
          // Human in the loop, per step (GET-713): on, the run waits in Approvals with exactly
          // what this step would do; off, it runs straight away.
          <label className="flex cursor-pointer items-start justify-between gap-3 border-t border-border/60 pt-4">
            <span>
              <span className="block text-[13px] font-medium text-foreground">Require approval</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
                {step.config.approval ? "Waits in Approvals until you approve it." : "Runs straight away."}
              </span>
            </span>
            <Switch checked={!!step.config.approval} onCheckedChange={v => props.set({ approval: v })} aria-label="Require approval" />
          </label>
        )}
      </div>
    </div>
  );
}
