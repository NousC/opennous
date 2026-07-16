// Home — the agent. This is the front door of the product now, not a demo.
//
// The promise: your agent works off one verified record, and you can see where
// every fact came from. So the chat is built around the evidence, not around the
// chat bubble. As the agent works you watch it read the graph — which tool it
// reached for, what came back, which system that came from — and only then does
// the answer type in above it.
//
// Backed by /api/playground/chat/stream (SSE). Threads and messages are the same
// rows the old Playground wrote, so history carries over.
import { useState, useEffect, useMemo, useRef, useCallback, memo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import {
  Plus, ArrowUp, Trash2, Loader2, MessageSquare, ChevronDown,
  Check, AlertTriangle, History, Mail, Calendar, Linkedin, Slack,
  Mic, Database, Send, Upload, User, Settings2, Circle,
  PanelLeft, PanelLeftClose, CalendarClock,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { ApprovalCard, type PendingAction } from "@/components/ApprovalCard";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// ─── Types ──────────────────────────────────────────────────────────────────

type Thread = {
  id: string; title: string | null; created_at: string; updated_at: string;
  // Present when the agent produced the thread on a schedule (a 06:00 brief), not you.
  routine?: string | null; unseen?: boolean;
};

/** One piece of evidence behind an answer: what a connected system told us. */
type Source = { system: string; detail: string; when: string | null; derived?: boolean };

/** One tool the agent ran, and the evidence it came back with. */
type Step = {
  name: string;
  status: "running" | "ok" | "error";
  duration_ms?: number;
  sources?: Source[];
  // Records the tool returned. Distinct from sources.length: a rollup reads
  // hundreds of rows and cites none, and the panel must not call that empty.
  rows?: number;
  error?: string;
};

type ToolCall = {
  name: string;
  rows?: number;
  input: Record<string, unknown>;
  output: unknown;
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
  sources?: Source[];
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: ToolCall[] | null;
  created_at: string;
};

// ─── Prompt cards — what you can ask, shown before the first message ─────────
//
// The card sells the job; the prompt is what lands in the composer. Showing the
// raw prompt on the card meant reading a truncated sentence, so the card says
// what it DOES and the full prompt appears in the box — where you can edit it
// before sending, because "my most recent contact" is rarely what you meant.
// The card sells the job; the prompt is what lands in the composer, editable —
// "my most recent contact" is rarely what you meant.
type PromptGroup = "All" | "Prep" | "Accounts" | "Pipeline" | "ICP";
const PROMPT_GROUPS: PromptGroup[] = ["All", "Prep", "Accounts", "Pipeline", "ICP"];

const PROMPT_CARDS: { title: string; group: Exclude<PromptGroup, "All">; prompt: string }[] = [
  {
    title: "Meeting prep",
    group: "Prep",
    prompt: "Prepare me for my next meeting — who it's with, what changed since we last spoke, and what to open with.",
  },
  {
    title: "Pre-call brief",
    group: "Prep",
    prompt: "Run the meeting-brief skill on the person I'm meeting next.",
  },
  {
    title: "Account brief",
    group: "Accounts",
    prompt: "Give me a full brief on my most recent contact — who they are, what we know, and what I should do next.",
  },
  {
    title: "What's changed",
    group: "Accounts",
    prompt: "What's changed across my accounts in the last two weeks that I haven't acted on?",
  },
  {
    title: "Needs attention",
    group: "Accounts",
    prompt: "What has gone quiet that I should follow up with, and why does it matter?",
  },
  {
    title: "Funnel shape",
    group: "Pipeline",
    prompt: "Analyse my pipeline from actual activity — where are people dropping off, and who's driving the most movement?",
  },
  {
    title: "Where we lose",
    group: "Pipeline",
    prompt: "Where in the funnel are we losing the most, and what do the conversations say about why?",
  },
  {
    title: "Our ICP",
    group: "ICP",
    prompt: "What's our ICP, and which of my accounts actually match it?",
  },
  {
    title: "Best-fit accounts",
    group: "ICP",
    prompt: "Which accounts score highest against our ICP, and what do they have in common?",
  },
];

/** Morning, afternoon, evening — the app should know what time you sat down. */
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// A tool name → what the agent is doing, in words a person would use.
const TOOL_VERBS: Record<string, string> = {
  get_playbook: "Reading our playbook",
  get_context:  "Assembling context",
  get_account:  "Pulling the account record",
  query:        "Searching across accounts",
  attention:    "Checking what needs attention",
  verify:       "Verifying a fact",
  classify:     "Checking these leads against our history",
  search:       "Searching what people said",
  calendar:     "Reading the calendar",
  // Skills, and the tools that reach outside the workspace.
  load_skill:           "Loading a skill",
  scrape_linkedin_posts: "Reading their recent posts",
  read_website:         "Reading their website",
  save_note:            "Saving this to the record",
};
const toolVerb = (name: string) => TOOL_VERBS[name] ?? `Running ${name}`;

function dayLabel(d: Date) {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "MMM d");
}

// ─── Sources — the proof, rendered ──────────────────────────────────────────

// The real logo of every system we can pull from — you should recognise where a
// fact came from before you've read a word of it. Falls back to a lucide glyph
// for the things that have no brand (an import, a manual note, Nous itself).
const SYSTEM_LOGOS: Record<string, string> = {
  Gmail:      "/provider-logos/gmail.svg",
  Calendar:   "/provider-logos/google.svg",
  LinkedIn:   "/provider-logos/linkedin.png",
  Slack:      "/provider-logos/slack.svg",
  Fireflies:  "/provider-logos/fireflies.svg",
  HubSpot:    "/provider-logos/hubspot.svg",
  Salesforce: "/provider-logos/salesforce.svg",
  Attio:      "/provider-logos/attio.svg",
  Pipedrive:  "/provider-logos/pipedrive.svg",
  Apollo:     "/provider-logos/apollo.svg",
  Instantly:  "/provider-logos/instantly.svg",
  Smartlead:  "/provider-logos/smartlead.png",
  HeyReach:   "/provider-logos/heyreach.png",
  Calendly:   "/provider-logos/calendly.svg",
  "Cal.com":  "/provider-logos/cal_com.svg",
  Notion:     "/provider-logos/notion.svg",
  Airtable:   "/provider-logos/airtable.svg",
  // Nous derived it rather than observing it — our own mark, and only used when
  // there's no upstream tool to credit.
  Nous:       "/provider-logos/nous-mark.svg",
  Agent:      "/provider-logos/nous-mark.svg",
};

const SYSTEM_GLYPHS: Record<string, { icon: typeof Mail; color: string }> = {
  Import:  { icon: Upload,    color: "text-muted-foreground" },
  CSV:     { icon: Upload,    color: "text-muted-foreground" },
  Manual:  { icon: User,      color: "text-muted-foreground" },
  System:  { icon: Settings2, color: "text-muted-foreground" },
};

/** One system's mark, at a given size. */
function SystemMark({ system, className = "h-3.5 w-3.5" }: { system: string; className?: string }) {
  const logo = SYSTEM_LOGOS[system];
  if (logo) return <img src={logo} alt="" className={cn(className, "object-contain")} />;
  const { icon: Icon, color } = SYSTEM_GLYPHS[system] ?? { icon: Circle, color: "text-muted-foreground" };
  return <Icon className={cn(className, color)} />;
}

/** The small marks shown inline in the collapsed summary. */
function SystemMarks({ systems }: { systems: string[] }) {
  return (
    <span className="inline-flex items-center -space-x-1 mr-0.5">
      {systems.slice(0, 5).map(sys => (
        <span key={sys} title={sys}
          className="inline-flex items-center justify-center h-[18px] w-[18px] rounded-full border border-border bg-background">
          <SystemMark system={sys} className="h-2.5 w-2.5" />
        </span>
      ))}
    </span>
  );
}

/**
 * The evidence behind one answer.
 *
 * While the agent works this is the live trace — you watch it read the graph.
 * Once the answer lands it collapses to a single line UNDER the answer ("Pulled
 * from Fireflies, Gmail and LinkedIn"), which opens into every record it used:
 * the system it came from, what that record said, and when. Answer first, proof
 * underneath — the way a person states a conclusion, then shows their working.
 */
function SourcePanel({ steps, live = false }: { steps: Step[]; live?: boolean }) {
  const [open, setOpen] = useState(false);

  const sources = useMemo(() => steps.flatMap(s => s.sources ?? []), [steps]);
  const systems = useMemo(() => [...new Set(sources.map(s => s.system))], [sources]);
  const running = steps.some(s => s.status === "running");
  // How many records the tools actually returned — a different question from how
  // many we can cite. A rollup answers from 47 accounts and links to none of them.
  const rows = useMemo(() => steps.reduce((n, s) => n + (s.rows ?? 0), 0), [steps]);

  if (steps.length === 0) return null;

  // Mid-turn: the steps ARE the story. Show them working, top to bottom.
  if (live && running) {
    return (
      <div className="mb-3 space-y-1.5">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            {s.status === "running"
              ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-muted-foreground/70" />
              : s.status === "error"
                ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                : <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
            <span>{toolVerb(s.name)}</span>
            {s.status === "ok" && (s.sources?.length ?? 0) > 0 && (
              <span className="text-muted-foreground/60">
                · {s.sources!.length} source{s.sources!.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }

  // Three states, and they mean genuinely different things:
  //
  //   1. We can name the systems      → "Pulled from Gmail, Fireflies…"
  //   2. We read real records but no  → "Read 47 records across your accounts"
  //      single one is worth linking     (a rollup: pipeline health, counts)
  //   3. The record is actually empty → "Nothing on record yet"
  //
  // Collapsing 2 into 3 is what made the panel claim "found nothing on record"
  // directly under an answer built from hundreds of rows. It read as broken
  // because it WAS wrong: there was plenty on record.
  const summary = systems.length > 0
    ? `Pulled from ${systems.slice(0, 3).join(", ")}${systems.length > 3 ? ` and ${systems.length - 3} more` : ""}`
    : rows > 0
      ? `Read ${rows.toLocaleString()} record${rows === 1 ? "" : "s"} across your accounts`
      : "Nothing on record yet";

  return (
    <div className="mt-4">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground hover:text-foreground transition-colors">
        {systems.length > 0
          ? <SystemMarks systems={systems} />
          : <Check className="h-3.5 w-3.5 text-emerald-600" />}
        <span>{summary}</span>
        {sources.length > 0 && (
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        )}
      </button>

      {open && sources.length > 0 && (
        <div className="mt-2 rounded-xl border border-border/60 bg-muted/20 divide-y divide-border/50">
          {sources.map((s, i) => (
            <div key={i} className="px-3 py-2.5 flex gap-3">
              {/* The logo, then the system, then what it actually told us. */}
              <span className="shrink-0 inline-flex items-center justify-center h-6 w-6 rounded-md border border-border bg-background mt-px">
                <SystemMark system={s.system} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">
                    {s.system}
                  </span>
                  {/* Nous didn't witness this — it read it out of the record above.
                      Say so, rather than passing a derivation off as an observation. */}
                  {s.derived && (
                    <span className="text-[10px] text-muted-foreground/60">extracted by Nous</span>
                  )}
                  {s.when && (
                    <span className="text-[11px] text-muted-foreground/60 ml-auto shrink-0">
                      {format(new Date(s.when), "MMM d, yyyy")}
                    </span>
                  )}
                </div>
                <p className="text-[12.5px] text-foreground/80 leading-relaxed break-words mt-0.5">
                  {s.detail}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Message bubbles ────────────────────────────────────────────────────────

// Memoized: the smoother re-renders this on every animation frame while text is
// streaming, so it must not also re-parse when unrelated state (steps, sending)
// changes.
const Prose = memo(({ text }: { text: string }) => (
  <div className="prose prose-sm dark:prose-invert max-w-none text-[14px] leading-relaxed text-foreground
                  prose-p:my-2.5 prose-p:leading-relaxed
                  prose-strong:font-semibold prose-strong:text-foreground
                  prose-ol:my-2 prose-ul:my-2 prose-li:my-1
                  prose-headings:text-[15px] prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
                  prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[12.5px]
                  prose-code:before:content-[''] prose-code:after:content-['']
                  prose-pre:bg-muted prose-pre:text-foreground prose-pre:text-[12.5px]
                  prose-a:text-foreground prose-a:underline prose-a:underline-offset-2">
    <ReactMarkdown>{text}</ReactMarkdown>
  </div>
));
Prose.displayName = "Prose";

function Bubble({
  msg, actions, token, apiUrl, onActionDecided,
}: {
  msg: Message;
  actions: PendingAction[];
  token: string;
  apiUrl: string;
  onActionDecided: () => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="rounded-2xl px-4 py-2.5 max-w-[80%] text-[14px] leading-relaxed whitespace-pre-wrap break-words bg-muted text-foreground">
          {msg.content}
        </div>
      </div>
    );
  }

  // A persisted turn carries the sources it was answered from — same panel the
  // user watched fill in live, replayed from the record.
  const steps: Step[] = (msg.tool_calls ?? []).map(t => ({
    name: t.name,
    status: t.status,
    duration_ms: t.duration_ms,
    sources: t.sources ?? [],
    rows: t.rows ?? 0,
    error: t.error,
  }));

  // Answer first, then anything it wants to SEND, then the proof underneath.
  //
  // The draft sits between the answer and the evidence deliberately: it is the
  // thing you have to act on, and burying it under a sources panel would be a way
  // of hiding the one part of the page with consequences.
  return (
    <div className="max-w-none">
      <Prose text={msg.content} />
      {actions.map(a => (
        <ApprovalCard
          key={a.id}
          action={a}
          token={token}
          apiUrl={apiUrl}
          onDecided={onActionDecided}
        />
      ))}
      <SourcePanel steps={steps} />
    </div>
  );
}

// ─── Threads panel ────────────────────────────────────────────────────────────
//
// The recent-conversations list, moved OUT of the app's left nav and INTO the Threads
// page as its own collapsible column — the Vault pattern. A list of conversations
// belongs next to the conversation, not in the global nav where it competed with every
// other destination. Yours to fold away (the state sticks, per-workspace); collapsed,
// it's a thin rail with just New-chat and expand.

// The open panel only. When collapsed it is not rendered at all (no leftover rail) —
// the expand control lives in the page's top bar instead, exactly as the Vault does.
// Styling mirrors the Vault tree so the two two-pane surfaces read as one system.
function ThreadsPanel({
  onCollapse, threads, activeId, onSelect, onNew, onDelete,
}: {
  onCollapse: () => void;
  threads: Thread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="w-[236px] flex-shrink-0 border-r border-border flex flex-col min-h-0 bg-muted/25">
      <div className="flex items-center justify-between pl-4 pr-2 h-12 flex-shrink-0">
        <span className="text-[13px] font-semibold text-foreground">Threads</span>
        <div className="flex items-center gap-0.5">
          <button onClick={onNew} title="New chat"
            className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors">
            <Plus className="h-[17px] w-[17px]" strokeWidth={1.75} />
          </button>
          <button onClick={onCollapse} title="Collapse"
            className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors">
            <PanelLeftClose className="h-[17px] w-[17px]" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {threads.length === 0 ? (
          <p className="px-2 py-6 text-[12px] text-muted-foreground/60 leading-relaxed">
            No conversations yet. Ask something to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {threads.map(t => {
              const selected = activeId === t.id;
              return (
                <li key={t.id}>
                  <div
                    onClick={() => onSelect(t.id)}
                    className={cn(
                      "group flex items-center gap-1.5 rounded-md pl-2 pr-1 py-[6px] text-[12.5px] cursor-pointer transition-colors",
                      selected
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                    )}
                    title={t.routine ? `${t.routine} — ran on a schedule` : (t.title ?? "New chat")}
                  >
                    {t.routine
                      ? <CalendarClock className={cn("h-3.5 w-3.5 shrink-0", t.unseen ? "text-foreground" : "text-muted-foreground/40")} />
                      : <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />}
                    <span className="truncate flex-1">{t.title || "New chat"}</span>
                    {t.routine && t.unseen && (
                      <span className="h-1.5 w-1.5 rounded-full bg-foreground shrink-0" />
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onDelete(t.id); }}
                      title="Delete thread"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground/50 hover:text-red-600 transition-all shrink-0"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Home() {
  const { session, userData } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const queryClient = useQueryClient();
  const threadsKey = useMemo(() => ["threads", workspaceId] as const, [workspaceId]);
  // Thread list is cached: switching to Threads / back to it is instant. Optimistic
  // create/rename/delete below update the cache via setQueryData.
  const { data: threads = [] } = useQuery({
    queryKey: threadsKey,
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/playground/threads?workspaceId=${workspaceId}`, { headers: authHeaders });
      if (!r.ok) return [] as Thread[];
      const d = await r.json();
      return (d.threads ?? []) as Thread[];
    },
    enabled: !!workspaceId && !!token,
  });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // The inner threads panel — yours to fold away, and it sticks (same localStorage
  // pattern as the app sidebar's collapsed state).
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return localStorage.getItem("nous.threads.paneOpen") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("nous.threads.paneOpen", panelOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [panelOpen]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // The turn in flight: what the agent is doing, and what it has written so far.
  // Drafts the agent has proposed in this thread and nobody has decided yet.
  // They belong to the LAST assistant turn — that is the turn that wrote them, and
  // pending_actions is keyed by thread rather than by message.
  const [actions, setActions] = useState<PendingAction[]>([]);

  const [liveSteps, setLiveSteps] = useState<Step[]>([]);
  const [liveText, setLiveText] = useState("");

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Sending the first message in a new chat creates the thread and sets it
  // active, which would otherwise fire the "load this thread's messages" effect
  // below and clobber the message we just optimistically rendered with an empty
  // list from the DB. We own the state for a thread we just created, so tell the
  // effect to skip it exactly once.
  const skipLoadRef = useRef<string | null>(null);

  // ── Typing smoother ──
  // The model's tokens arrive in bursts — a whole clause lands in one SSE frame,
  // then nothing for 200ms. Painting each frame the moment it arrives makes the
  // answer lurch. So tokens go into a buffer and we drain it on every animation
  // frame, a few characters at a time, which reads as typing.
  //
  // The drain rate is proportional to how far behind we are: a big burst catches
  // up fast, a trickle stays smooth. It never falls behind the model.
  const pendingRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const streamOpenRef = useRef(false);

  const pumpText = useCallback(() => {
    if (rafRef.current !== null) return; // already draining
    const step = () => {
      const pending = pendingRef.current;
      if (pending.length > 0) {
        // Drain fast. The buffer exists to hide the model's chunk boundaries, not
        // to throttle it — at a sixth per frame it was holding text back long
        // after it had arrived, which reads as a slow agent rather than a smooth
        // one. A third per frame (min 6 chars) still smooths the bursts, but the
        // text lands about as fast as the model produces it.
        const n = Math.max(6, Math.ceil(pending.length / 3));
        pendingRef.current = pending.slice(n);
        setLiveText(t => t + pending.slice(0, n));
      }
      if (streamOpenRef.current || pendingRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  /** Resolve once every buffered character has been shown. */
  const flushText = useCallback(
    () =>
      new Promise<void>(resolve => {
        const check = () => {
          if (pendingRef.current.length === 0) resolve();
          else requestAnimationFrame(check);
        };
        check();
      }),
    [],
  );

  // Never leave a frame loop running behind us.
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  // Thread list is a cached React Query (defined above) — no manual load effect.

  useEffect(() => {
    if (!activeThreadId || !workspaceId) { setMessages([]); return; }
    // A thread we just created mid-send already has its messages on screen.
    // Loading it from the DB here would wipe them and make the user's own
    // message vanish until the turn finished.
    if (skipLoadRef.current === activeThreadId) { skipLoadRef.current = null; return; }
    fetch(`${apiUrl}/api/playground/threads/${activeThreadId}/messages?workspaceId=${workspaceId}`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : { messages: [] }))
      .then(d => setMessages(d.messages ?? []))
      .catch(() => setMessages([]));
  }, [activeThreadId, authHeaders, workspaceId]);

  // Follow the answer as it streams — but only while the user is already at the
  // bottom. If they've scrolled up to re-read their own question or an earlier
  // turn, don't yank them back down on every token.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) el.scrollTop = el.scrollHeight;
  }, [messages, liveText, liveSteps]);

  // A card loads its prompt into the composer rather than firing it. These
  // prompts are starting points ("my most recent contact") and you usually want
  // to swap in a real name before sending — so hand it to the user, cursor at
  // the end, and let them decide.
  const loadPrompt = useCallback((prompt: string) => {
    setDraft(prompt);
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Defer so React has committed the new value before we move the caret.
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = el.value.length;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
    });
  }, []);

  // The sidebar selects a thread by URL (/?thread=…), because the two components
  // are siblings and the URL is the one piece of state they share. A bare "/" means
  // a new chat, which is why the nav item needs no "New chat" button beside it.
  useEffect(() => {
    const t = searchParams.get("thread");
    if (t && t !== activeThreadId) setActiveThreadId(t);
    if (!t && activeThreadId) {
      // Navigated back to a bare /: reset to a blank chat.
      setActiveThreadId(null);
      setMessages([]);
      setLiveSteps([]);
      setLiveText("");
    }
  }, [searchParams]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Tasks hands work over as ?ask=… — load it into the composer (never send it),
  // so the prompt arrives editable and the user stays in control of what runs.
  useEffect(() => {
    const ask = searchParams.get("ask");
    if (!ask) return;
    loadPrompt(ask);
    // Consume it, so a reload doesn't re-arm the same prompt.
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, loadPrompt]);

  // ── The "/" picker — discovery, not a second invocation path ──
  //
  // Skills are model-invoked: ask for a brief in your own words and the agent
  // reaches for the skill itself. But nothing tells you they exist, so "/" opens
  // the library in the composer. Picking one writes plain English into the box —
  // it does NOT fire a command. The model still matches the skill from its
  // catalog exactly as it would if you'd typed the sentence yourself, so there's
  // one code path and no new way for this to fail.
  const [skills, setSkills] = useState<{ name: string; description: string; est_cost_usd: number | null }[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [promptGroup, setPromptGroup] = useState<PromptGroup>("All");
  const visiblePrompts = useMemo(
    () => (promptGroup === "All" ? PROMPT_CARDS : PROMPT_CARDS.filter(c => c.group === promptGroup)),
    [promptGroup],
  );

  useEffect(() => {
    if (!workspaceId) return;
    fetch(`${apiUrl}/api/skills?workspaceId=${workspaceId}`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : { skills: [] }))
      .then(d => setSkills(d.skills ?? []))
      .catch(() => setSkills([]));
  }, [workspaceId, authHeaders]);

  // Only while "/" is the whole draft — once you're writing a sentence, "/" is
  // just a character, and a menu popping up mid-thought is an interruption.
  const slashQuery = useMemo(() => {
    const m = /^\/([a-z0-9-]*)$/i.exec(draft);
    return m ? m[1].toLowerCase() : null;
  }, [draft]);

  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : skills.filter(s => s.name.toLowerCase().includes(slashQuery))),
    [slashQuery, skills],
  );
  const slashOpen = slashQuery !== null && slashMatches.length > 0 && !sending;

  useEffect(() => { setSlashIdx(0); }, [slashQuery]);

  const loadActions = useCallback((threadId: string | null) => {
    if (!token || !workspaceId || !threadId) { setActions([]); return; }
    fetch(`${apiUrl}/api/actions?workspaceId=${workspaceId}&threadId=${threadId}`, {
      headers: authHeaders,
    })
      .then(r => (r.ok ? r.json() : { actions: [] }))
      .then(d => setActions(d.actions ?? []))
      .catch(() => { /* a chat must not break over a draft list */ });
  }, [token, workspaceId, authHeaders]);

  useEffect(() => { loadActions(activeThreadId); }, [activeThreadId, loadActions]);

  const newChat = useCallback(() => {
    setActiveThreadId(null);
    setMessages([]);
    setLiveSteps([]);
    setLiveText("");
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const deleteThread = useCallback(async (id: string) => {
    if (!workspaceId) return;
    try {
      const r = await fetch(`${apiUrl}/api/playground/threads/${id}?workspaceId=${workspaceId}`, {
        method: "DELETE", headers: authHeaders,
      });
      if (!r.ok) { toast.error("Failed to delete"); return; }
      queryClient.setQueryData(threadsKey, (prev: Thread[] = []) => prev.filter(t => t.id !== id));
      if (activeThreadId === id) newChat();
    } catch { toast.error("Failed to delete"); }
  }, [activeThreadId, authHeaders, newChat, workspaceId]);

  // ── Send: open the SSE stream and render the agent working ──
  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || !workspaceId || sending) return;

    // Your message goes up FIRST, before any network call. It's the one thing
    // that should never wait on a round-trip.
    setSending(true);
    setDraft("");
    // The composer auto-grows as you type; collapse it again once sent.
    if (inputRef.current) inputRef.current.style.height = "auto";
    setLiveSteps([]);
    setLiveText("");
    pendingRef.current = "";
    streamOpenRef.current = true;

    const optimisticUser: Message = {
      id: `optimistic-${Date.now()}`,
      role: "user", content, tool_calls: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimisticUser]);

    // A chat needs a thread; create one lazily on the first message so an
    // abandoned empty chat never litters the history.
    let threadId = activeThreadId;
    if (!threadId) {
      try {
        const r = await fetch(`${apiUrl}/api/playground/threads`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
        if (!r.ok) { toast.error("Failed to start chat"); setSending(false); return; }
        const d = await r.json();
        queryClient.setQueryData(threadsKey, (prev: Thread[] = []) => [d.thread, ...prev]);
        threadId = d.thread.id as string;
        // We own this thread's messages already — don't let the load effect
        // overwrite them with an empty list from the DB.
        skipLoadRef.current = threadId;
        setActiveThreadId(threadId);
      } catch {
        toast.error("Failed to start chat");
        setMessages(prev => prev.filter(m => m.id !== optimisticUser.id));
        setSending(false);
        return;
      }
    }

    try {
      const res = await fetch(`${apiUrl}/api/playground/chat/stream`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, threadId, message: content }),
      });
      if (!res.ok || !res.body) throw new Error("Chat failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Collected here so the persisted assistant row can be rendered with the
      // same sources the user just watched arrive.
      let finalAssistant: Message | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find(l => l.startsWith("data: "));
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }

          switch (ev.type) {
            case "user_message":
              // Swap the optimistic bubble for the persisted row.
              setMessages(prev => prev.map(m => (m.id === optimisticUser.id ? ev.message : m)));
              break;
            case "tool_start":
              setLiveSteps(prev => [...prev, { name: ev.name, status: "running" }]);
              break;
            case "tool_end":
              setLiveSteps(prev => {
                const next = [...prev];
                // Close the most recent running step with this tool's name.
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].name === ev.name && next[i].status === "running") {
                    next[i] = {
                      name: ev.name, status: ev.status,
                      duration_ms: ev.duration_ms, sources: ev.sources ?? [],
                      rows: ev.rows ?? 0, error: ev.error,
                    };
                    break;
                  }
                }
                return next;
              });
              break;
            case "text":
              // Into the buffer — the frame loop decides when it appears.
              pendingRef.current += ev.text;
              pumpText();
              break;
            case "done":
              finalAssistant = ev.assistantMessage;
              // The turn may have proposed a draft. Fetch it, or the message sits
              // there saying "ready to review" with nothing to review.
              loadActions(threadId ?? activeThreadId);
              break;
            case "error":
              toast.error(ev.message || "Chat failed");
              break;
          }
        }
      }

      // The server has finished, but the smoother may still be typing out the
      // last few characters. Let it land before swapping the live text for the
      // persisted message — otherwise the tail snaps into place.
      streamOpenRef.current = false;
      await flushText();

      if (finalAssistant) setMessages(prev => [...prev, finalAssistant!]);
      setLiveText("");
      setLiveSteps([]);

      queryClient.setQueryData(threadsKey, (prev: Thread[] = []) => {
        const i = prev.findIndex(t => t.id === threadId);
        if (i < 0) return prev;
        const updated = {
          ...prev[i],
          updated_at: new Date().toISOString(),
          title: prev[i].title === "New chat" ? content.slice(0, 80) : prev[i].title,
        };
        return [updated, ...prev.slice(0, i), ...prev.slice(i + 1)];
      });
    } catch (e: any) {
      toast.error(e?.message || "Chat failed");
      setMessages(prev => prev.filter(m => m.id !== optimisticUser.id));
      setDraft(content);
      setLiveText("");
      setLiveSteps([]);
    } finally {
      // Always close the buffer, or the frame loop keeps spinning on a dead stream.
      streamOpenRef.current = false;
      pendingRef.current = "";
      setSending(false);
    }
  }, [activeThreadId, authHeaders, sending, workspaceId]);

  const firstName = useMemo(() => {
    const full = (userData?.user?.name as string | undefined)?.trim();
    return full ? full.split(/\s+/)[0] : "there";
  }, [userData]);

  const grouped = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const t of threads) {
      const k = dayLabel(new Date(t.updated_at));
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
    return [...map.entries()];
  }, [threads]);

  const isEmpty = messages.length === 0 && !sending;

  // Picking a skill hands you a sentence, not a command — with the object left
  // blank, because "brief me" is only ever half the request.
  const pickSkill = (name: string) => loadPrompt(`Run the ${name} skill on `);

  const composer = (
    <div className="relative rounded-2xl border border-border bg-background shadow-sm focus-within:border-foreground/30 transition-colors">
      {slashOpen && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-background shadow-lg overflow-hidden z-20">
          <p className="px-3 pt-2.5 pb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
            Skills
          </p>
          {slashMatches.map((s, i) => (
            <button
              key={s.name}
              onMouseEnter={() => setSlashIdx(i)}
              onClick={() => pickSkill(s.name)}
              className={cn(
                "w-full flex items-baseline gap-3 px-3 py-2 text-left transition-colors",
                i === slashIdx ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <span className="font-mono text-[13px] text-foreground flex-shrink-0">/{s.name}</span>
              <span className="text-[12px] text-muted-foreground truncate">{s.description}</span>
              {s.est_cost_usd ? (
                <span className="ml-auto font-mono text-[11px] text-muted-foreground/60 tabular-nums flex-shrink-0">
                  ~${Number(s.est_cost_usd).toFixed(2)}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          // Grow with the content up to the max height, then scroll.
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 192)}px`;
        }}
        onKeyDown={e => {
          // While the picker is up it owns the keys — otherwise Enter would send
          // a message that is literally just "/".
          if (slashOpen) {
            if (e.key === "ArrowDown") {
              e.preventDefault(); setSlashIdx(i => (i + 1) % slashMatches.length); return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault(); setSlashIdx(i => (i - 1 + slashMatches.length) % slashMatches.length); return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault(); pickSkill(slashMatches[slashIdx].name); return;
            }
            if (e.key === "Escape") { e.preventDefault(); setDraft(""); return; }
          }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); }
        }}
        placeholder="Ask about any person, company, or pattern…   /  for skills"
        rows={1}
        autoFocus
        disabled={sending}
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none max-h-48 overflow-y-auto"
      />
      <div className="flex items-center justify-end px-2.5 pb-2.5">
        <button
          onClick={() => send(draft)}
          disabled={!draft.trim() || sending}
          aria-label="Send"
          className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-foreground text-background disabled:opacity-25 hover:opacity-90 transition-opacity">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );

  // min-h-0 throughout: a flex-1 child in a flex column refuses to shrink below
  // its content without it, so the message list would grow past the viewport and
  // never scroll.
  return (
    <div className="h-full min-h-0 flex bg-background">
      {/* Recent conversations live here now, in a collapsible panel next to the chat —
          not in the global left nav. Selecting one drives the URL (?thread=…), which is
          the single piece of state the panel and the chat share; New chat clears it.
          When collapsed the panel is gone entirely — the expand control moves into the
          top bar below, mirroring the Vault. */}
      {panelOpen && (
        <ThreadsPanel
          onCollapse={() => setPanelOpen(false)}
          threads={threads}
          activeId={activeThreadId}
          onSelect={(id) => setSearchParams({ thread: id })}
          onNew={() => { setSearchParams({}); newChat(); }}
          onDelete={deleteThread}
        />
      )}

      <div className="flex-1 min-h-0 flex flex-col">
      {/* Collapsed: the expand toggle (and New chat) live here, in a top bar — the same
          place the Vault puts its Expand control. No floating rail. */}
      {!panelOpen && (
        <div className="h-12 flex-shrink-0 flex items-center gap-0.5 border-b border-border/70 px-2">
          <button onClick={() => setPanelOpen(true)} title="Expand"
            className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors">
            <PanelLeft className="h-[17px] w-[17px]" strokeWidth={1.75} />
          </button>
          <button onClick={() => { setSearchParams({}); newChat(); }} title="New chat"
            className="p-1.5 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-colors">
            <Plus className="h-[17px] w-[17px]" strokeWidth={1.75} />
          </button>
        </div>
      )}
      {isEmpty ? (
        // ── First run: the greeting, the composer, and what you can ask ──
        //
        // The column stays centred in the page; the TEXT inside it is left-aligned
        // to the composer and the chips below it, so the whole block reads off one
        // edge rather than three.
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 pt-[12vh] pb-16">
            <h1 className="text-[32px] font-semibold tracking-tight text-foreground mb-6">
              {greeting()}, {firstName}
            </h1>

            {composer}

            {/* Filter first, then the prompts — the chips keep the grid short
                instead of making you read nine cards to find the one you want. */}
            <div className="flex items-center gap-1.5 mt-7 mb-3">
              {PROMPT_GROUPS.map(g => (
                <button
                  key={g}
                  onClick={() => setPromptGroup(g)}
                  className={cn(
                    "px-3 py-1 rounded-full text-[12px] border transition-colors",
                    promptGroup === g
                      ? "border-foreground/25 bg-muted text-foreground"
                      : "border-border/70 text-muted-foreground hover:text-foreground hover:border-border",
                  )}
                >
                  {g}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {visiblePrompts.map(c => (
                <button
                  key={c.title}
                  onClick={() => loadPrompt(c.prompt)}
                  className="text-left rounded-xl border border-border/70 bg-background px-3.5 py-3 hover:border-foreground/25 hover:bg-muted/40 transition-all">
                  <p className="text-[13px] font-medium text-foreground leading-tight">{c.title}</p>
                  {/* The prompt itself, truncated — you should see what you're
                      about to send, not a description of it. */}
                  <p className="text-[12px] text-muted-foreground leading-snug mt-1 line-clamp-2">
                    {c.prompt}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        // ── Active chat ──
        <>
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6">
            <div className="max-w-2xl mx-auto py-4 space-y-6">
              {messages.map((m, i) => {
                // Only the last assistant message shows drafts — the earlier turns
                // already had theirs decided, and a stack of stale cards up the page
                // would be noise you have to scroll past.
                const isLastAssistant =
                  m.role === "assistant" &&
                  i === messages.map(x => x.role).lastIndexOf("assistant");
                return (
                  <Bubble
                    key={m.id}
                    msg={m}
                    actions={isLastAssistant ? actions : []}
                    token={token}
                    apiUrl={apiUrl}
                    onActionDecided={() => loadActions(activeThreadId)}
                  />
                );
              })}

              {/* The turn in flight. While the agent reads the graph the steps
                  lead; once it starts writing, the answer leads and the proof
                  settles underneath it — same shape as a finished turn. */}
              {sending && (
                <div>
                  {/* While it's still reading the graph, the steps ARE the story.
                      The moment it starts writing, they give way to the answer —
                      and the proof appears only when the answer has landed, on
                      the persisted message. Showing sources mid-stream spoils the
                      reveal and competes with the text for attention. */}
                  {!liveText && <SourcePanel steps={liveSteps} live />}
                  {liveText && <Prose text={liveText} />}
                  {!liveText && liveSteps.length === 0 && (
                    <div className="flex items-center gap-1 h-5">
                      {[0, 120, 240].map(d => (
                        <span key={d}
                          className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce"
                          style={{ animationDelay: `${d}ms` }} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="px-6 pb-5 flex-shrink-0">
            <div className="max-w-2xl mx-auto">{composer}</div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}
