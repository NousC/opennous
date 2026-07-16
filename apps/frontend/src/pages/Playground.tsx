import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import {
  Plus, Send, Trash2, Loader2, ChevronRight, ChevronDown,
  MessageSquare, Wrench, AlertTriangle, CheckCircle2, ArrowLeft,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

// ─── Types ──────────────────────────────────────────────────────────────────

type Thread = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type ToolCall = {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: ToolCall[] | null;
  created_at: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function dayLabel(date: Date) {
  if (isToday(date))     return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "MMM d");
}

function groupThreadsByDay(threads: Thread[]) {
  const map = new Map<string, Thread[]>();
  for (const t of threads) {
    const k = dayLabel(new Date(t.updated_at));
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(t);
  }
  return [...map.entries()];
}

const SUGGESTIONS = [
  "What's our ICP?",
  "Who has gone quiet that I should follow up with?",
  "What do we know about my most recent contact?",
  "Give me prep for my next meeting — pick someone in the evaluating stage.",
];

// ─── Right panel: tool-call trace card ──────────────────────────────────────

function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = call.status === "error" ? AlertTriangle : CheckCircle2;
  const color = call.status === "error" ? "text-red-600" : "text-emerald-600";

  // A compact summary of what came back, picked per-tool.
  const summary = useMemo(() => {
    const o = call.output as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return null;
    if ("error" in o) return String(o.error);
    if (call.name === "get_playbook") {
      const n     = (o as any).count;
      const cats  = (o as any).by_category;
      const top   = cats && typeof cats === "object" ? Object.entries(cats).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(" · ") : "";
      return [n != null ? `${n} fact${n === 1 ? "" : "s"}` : null, top].filter(Boolean).join(" · ");
    }
    if (call.name === "get_account") {
      const claims = Array.isArray((o as any).claims) ? (o as any).claims.length : null;
      const name   = (o as any).entity?.name ?? (o as any).entity?.primary_identifier;
      return [name, claims != null ? `${claims} claims` : null].filter(Boolean).join(" · ");
    }
    if (call.name === "get_context") {
      const tokens = (o as any).token_count ?? (o as any).budget_tokens;
      const items  = Array.isArray((o as any).timeline) ? (o as any).timeline.length : null;
      return [tokens ? `${tokens} tokens` : null, items != null ? `${items} timeline items` : null].filter(Boolean).join(" · ");
    }
    if (call.name === "query") {
      const n = Array.isArray((o as any).items) ? (o as any).items.length : null;
      return n != null ? `${n} observations` : null;
    }
    if (call.name === "attention") {
      const n = Array.isArray((o as any).items) ? (o as any).items.length : null;
      return n != null ? `${n} items` : null;
    }
    if (call.name === "verify") {
      const fresh = (o as any).after?.freshness;
      return fresh ? `freshness: ${fresh}` : null;
    }
    if (call.name === "classify") {
      const s = (o as any).summary;
      if (!s) return null;
      return `${s.total ?? 0} total · ${s.net_new ?? 0} net-new`;
    }
    return null;
  }, [call]);

  return (
    <div className="rounded-lg border border-border/60 bg-background overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", color)} />
        <span className="text-[12px] font-mono font-semibold text-foreground/90">{call.name}</span>
        <span className="text-[11px] text-muted-foreground/70 flex-1 truncate">{summary ?? "—"}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/70 shrink-0">{call.duration_ms}ms</span>
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/60" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />}
      </button>
      {open && (
        <div className="border-t border-border/60 bg-muted/30 px-3 py-2.5 space-y-2.5">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">input</p>
            <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
{JSON.stringify(call.input, null, 2)}
            </pre>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">output</p>
            <pre className="text-[11px] font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed max-h-96 overflow-y-auto">
{JSON.stringify(call.output, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Playground() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const h = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // The assistant message id that JUST arrived from the server in this session.
  // Only that one gets the streaming/typewriter animation — replaying history
  // on thread-switch shouldn't visually re-type everything.
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Load threads on mount ──
  const loadThreads = useCallback(async () => {
    if (!workspaceId || !token) return;
    try {
      const r = await fetch(`${apiUrl}/api/playground/threads?workspaceId=${workspaceId}`, { headers: h });
      if (!r.ok) return;
      const d = await r.json();
      setThreads(d.threads ?? []);
    } catch { /* silent */ }
  }, [apiUrl, h, token, workspaceId]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  // ── When the active thread changes, load its messages ──
  useEffect(() => {
    if (!activeThreadId || !workspaceId) { setMessages([]); return; }
    setLoadingMessages(true);
    fetch(`${apiUrl}/api/playground/threads/${activeThreadId}/messages?workspaceId=${workspaceId}`, { headers: h })
      .then(r => (r.ok ? r.json() : { messages: [] }))
      .then(d => setMessages(d.messages ?? []))
      .catch(() => setMessages([]))
      .finally(() => setLoadingMessages(false));
  }, [activeThreadId, apiUrl, h, workspaceId]);

  // ── Auto-scroll on new messages ──
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  // ── New thread ──
  const newThread = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const r = await fetch(`${apiUrl}/api/playground/threads`, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!r.ok) { toast.error("Failed to create thread"); return; }
      const d = await r.json();
      setThreads(prev => [d.thread, ...prev]);
      setActiveThreadId(d.thread.id);
      setMessages([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch { toast.error("Failed to create thread"); }
  }, [apiUrl, h, workspaceId]);

  // ── Delete thread ──
  const deleteThread = useCallback(async (id: string) => {
    if (!workspaceId) return;
    try {
      const r = await fetch(`${apiUrl}/api/playground/threads/${id}?workspaceId=${workspaceId}`, {
        method: "DELETE", headers: h,
      });
      if (!r.ok) { toast.error("Failed to delete"); return; }
      setThreads(prev => prev.filter(t => t.id !== id));
      if (activeThreadId === id) { setActiveThreadId(null); setMessages([]); }
    } catch { toast.error("Failed to delete"); }
  }, [activeThreadId, apiUrl, h, workspaceId]);

  // ── Send message ──
  const send = useCallback(async (text: string) => {
    const message = text.trim();
    if (!message || !workspaceId || sending) return;

    // Ensure we have a thread to send in.
    let threadId = activeThreadId;
    if (!threadId) {
      try {
        const r = await fetch(`${apiUrl}/api/playground/threads`, {
          method: "POST", headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
        if (!r.ok) { toast.error("Failed to start thread"); return; }
        const d = await r.json();
        setThreads(prev => [d.thread, ...prev]);
        threadId = d.thread.id;
        setActiveThreadId(threadId);
      } catch { toast.error("Failed to start thread"); return; }
    }

    setSending(true);
    setDraft("");
    // Optimistic user message
    const optimisticUser: Message = {
      id: `optimistic-${Date.now()}`,
      role: "user", content: message, tool_calls: null,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimisticUser]);

    try {
      const r = await fetch(`${apiUrl}/api/playground/chat`, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, threadId, message }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "chat_failed");
      // Replace the optimistic message with the real pair from the server.
      setMessages(prev => [
        ...prev.filter(m => m.id !== optimisticUser.id),
        d.userMessage, d.assistantMessage,
      ]);
      // Mark the assistant message for the typewriter animation.
      setStreamingMessageId(d.assistantMessage.id);
      // Bump the thread to the top of the sidebar.
      setThreads(prev => {
        const idx = prev.findIndex(t => t.id === threadId);
        if (idx < 0) return prev;
        const updated = { ...prev[idx], updated_at: new Date().toISOString(),
          title: prev[idx].title === "New chat" ? message.slice(0, 80) : prev[idx].title };
        return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
      });
    } catch (e: any) {
      toast.error(e?.message || "Chat failed");
      // Roll back the optimistic message on failure.
      setMessages(prev => prev.filter(m => m.id !== optimisticUser.id));
      setDraft(message);
    } finally {
      setSending(false);
    }
  }, [activeThreadId, apiUrl, h, sending, workspaceId]);

  // ── Right-panel data: EVERY tool call across the whole conversation ──
  // Grouped by assistant turn so the user can see how each question fired —
  // critical for the "see the substrate working" promise. Newest at the top.
  const traceTurns = useMemo(() => {
    const turns: Array<{ messageId: string; ts: string; calls: ToolCall[] }> = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        turns.push({ messageId: m.id, ts: m.created_at, calls: m.tool_calls });
      }
    }
    return turns.reverse();
  }, [messages]);
  const totalCalls = useMemo(() => traceTurns.reduce((n, t) => n + t.calls.length, 0), [traceTurns]);

  const grouped = useMemo(() => groupThreadsByDay(threads), [threads]);

  // Personalize the greeting. Pull first name from /me; fall back to "there".
  const firstName = useMemo(() => {
    const full = (userData?.user?.name as string | undefined)?.trim();
    if (!full) return "there";
    return full.split(/\s+/)[0];
  }, [userData]);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* ── Top chrome — back-to-dashboard pill + title strip ── */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-border/60 bg-background/95 backdrop-blur shrink-0">
        <Link
          to="/ops"
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border/60 bg-background text-[12px] font-semibold text-foreground/80 hover:bg-accent transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="font-semibold tracking-wide">Playground</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-muted-foreground/70">read-only</span>
        </div>
        <div className="w-[140px]" />
      </div>

      <div className="flex-1 grid grid-cols-[240px_1fr_420px] min-h-0">
        {/* ── LEFT: thread list ── */}
        <aside className="border-r border-border/60 flex flex-col min-h-0 bg-muted/20">
          <div className="p-3 border-b border-border/60">
            <button
              onClick={newThread}
              className="w-full inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-primary text-primary-foreground text-[12px] font-semibold hover:bg-primary/90 transition-colors">
              <Plus className="h-3.5 w-3.5" /> New chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {threads.length === 0 ? (
              <p className="text-[11px] text-muted-foreground/70 px-2 py-3">No chats yet. Start one above.</p>
            ) : grouped.map(([label, group]) => (
              <div key={label} className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 px-2 mb-1">{label}</p>
                {group.map(t => (
                  <div
                    key={t.id}
                    className={cn(
                      "group flex items-start gap-1.5 rounded-md mx-0 px-2 py-2 cursor-pointer transition-colors",
                      activeThreadId === t.id ? "bg-accent" : "hover:bg-muted/60"
                    )}
                    onClick={() => setActiveThreadId(t.id)}
                  >
                    <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground/70 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] truncate text-foreground/90 leading-tight">{t.title || "New chat"}</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5 tabular-nums">
                        {format(new Date(t.updated_at), "MMM d, yyyy, h:mm:ss a")}
                      </p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); deleteThread(t.id); }}
                      title="Delete chat"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-background transition-opacity self-start">
                      <Trash2 className="h-3 w-3 text-muted-foreground/70 hover:text-red-600" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </aside>

        {/* ── CENTER: chat ── */}
        <main className="flex flex-col min-h-0">
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6">
            {activeThreadId === null && messages.length === 0 ? (
              <EmptyState firstName={firstName} onPick={text => send(text)} />
            ) : loadingMessages ? (
              <div className="flex items-center justify-center py-12 text-[12px] text-muted-foreground/70">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
              </div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-5">
                {messages.map(m => (
                  <Bubble
                    key={m.id}
                    msg={m}
                    // Only the just-arrived assistant message gets the typewriter
                    // animation; replayed history renders instantly.
                    animate={m.id === streamingMessageId}
                  />
                ))}
                {sending && <TypingIndicator />}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-border/60 px-8 py-4 bg-background">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-background px-3 py-2 focus-within:border-foreground/40 transition-colors">
                <textarea
                  ref={inputRef}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); }
                  }}
                  placeholder="What do we know about…"
                  rows={1}
                  disabled={sending}
                  className="flex-1 resize-none bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none py-1.5 max-h-40"
                />
                <button
                  onClick={() => send(draft)}
                  disabled={!draft.trim() || sending}
                  className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg bg-primary text-primary-foreground disabled:opacity-30 hover:bg-primary/90 transition-colors">
                  {sending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Send className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-2 text-center">
                Read-only — the agent inspects your workspace but never writes. Enter to send · Shift+Enter for new line.
              </p>
            </div>
          </div>
        </main>

        {/* ── RIGHT: live context trace — every API call across the turn ── */}
        <aside className="border-l border-border/60 flex flex-col min-h-0 bg-muted/20">
          <div className="px-4 py-3 border-b border-border/60 flex items-center gap-2">
            <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[12px] font-semibold text-foreground">Context</span>
            <span className="text-[11px] text-muted-foreground/70 ml-auto tabular-nums">
              {totalCalls === 0 ? "no calls yet" : `${totalCalls} call${totalCalls === 1 ? "" : "s"} · ${traceTurns.length} turn${traceTurns.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
            {traceTurns.length === 0 ? (
              <div className="text-[12px] text-muted-foreground/70 px-2 py-6 text-center leading-relaxed">
                The agent's API calls will appear here.<br />
                <span className="text-[11px]">Each shows the input, output, and latency.</span>
              </div>
            ) : (
              traceTurns.map(turn => (
                <div key={turn.messageId} className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 px-1 tabular-nums">
                    {format(new Date(turn.ts), "h:mm:ss a")} · {turn.calls.length} call{turn.calls.length === 1 ? "" : "s"}
                  </p>
                  <div className="space-y-1.5">
                    {turn.calls.map((c, i) => <ToolCallCard key={i} call={c} />)}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

// ── Typewriter: progressively reveals a target string, char by char.
// We fake streaming because the API is request-response — feels native enough.
// Per the user: the assistant message should "stream in" rather than pop.
function useTypewriter(target: string, enabled: boolean, charsPerTick = 4, tickMs = 18) {
  const [shown, setShown] = useState(enabled ? "" : target);
  const targetRef = useRef(target);
  useEffect(() => { targetRef.current = target; }, [target]);

  useEffect(() => {
    if (!enabled) { setShown(target); return; }
    setShown("");
    let cancelled = false;
    let i = 0;
    const tick = () => {
      if (cancelled) return;
      i = Math.min(i + charsPerTick, targetRef.current.length);
      setShown(targetRef.current.slice(0, i));
      if (i < targetRef.current.length) setTimeout(tick, tickMs);
    };
    tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return shown;
}

// ── A clean three-dot typing indicator while the model+tools are running.
// Better than the previous "Asking the substrate…" — matches the chat idiom.
function TypingIndicator() {
  return (
    <div className="flex items-end gap-2 py-1">
      <div className="flex items-end gap-1 h-5">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "0ms" }} />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "120ms" }} />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: "240ms" }} />
      </div>
    </div>
  );
}

function Bubble({ msg, animate }: { msg: Message; animate: boolean }) {
  const isUser = msg.role === "user";
  const streamed = useTypewriter(msg.content, !isUser && animate);

  if (isUser) {
    // Keep the user message in a pill bubble — visually distinguishes turns.
    return (
      <div className="flex justify-end">
        <div className="rounded-2xl px-4 py-2.5 max-w-[85%] text-[13px] leading-relaxed whitespace-pre-wrap break-words bg-primary text-primary-foreground">
          {msg.content}
        </div>
      </div>
    );
  }

  // Assistant: no bubble. Just clean rendered markdown directly on the canvas.
  // The streamed body is rendered through ReactMarkdown so partial fragments
  // (e.g. an in-progress bold tag) still degrade gracefully.
  return (
    <div className="flex flex-col gap-1.5 max-w-[90%]">
      <div className="prose prose-sm dark:prose-invert max-w-none text-[13.5px] leading-relaxed text-foreground
                      prose-p:my-2 prose-p:leading-relaxed
                      prose-strong:font-semibold prose-strong:text-foreground
                      prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5
                      prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[12px]
                      prose-code:before:content-[''] prose-code:after:content-['']
                      prose-pre:bg-muted prose-pre:text-foreground prose-pre:text-[12px]
                      prose-a:text-foreground prose-a:underline prose-a:underline-offset-2">
        <ReactMarkdown>{streamed}</ReactMarkdown>
      </div>
      {msg.tool_calls && msg.tool_calls.length > 0 && (
        <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1 flex-wrap">
          <Wrench className="h-2.5 w-2.5" />
          {msg.tool_calls.length} Nous {msg.tool_calls.length === 1 ? "call" : "calls"}
          <span className="text-muted-foreground/40">·</span>
          <span className="font-mono">{msg.tool_calls.map(c => c.name).join(", ")}</span>
        </p>
      )}
    </div>
  );
}

function EmptyState({ firstName, onPick }: { firstName: string; onPick: (text: string) => void }) {
  return (
    <div className="max-w-2xl mx-auto pt-16 sm:pt-24">
      <div className="text-center mb-10">
        <h1 className="text-[40px] sm:text-[48px] font-semibold tracking-tight text-foreground leading-tight">
          Hey {firstName}!
        </h1>
        <p className="text-[14px] text-muted-foreground mt-3 max-w-md mx-auto leading-relaxed">
          See Nous in action. Ask about any person, company, or pattern — the agent inspects your workspace with the same six tools your real agents would.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {SUGGESTIONS.map(s => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="text-left rounded-xl border border-border/60 bg-background px-4 py-3 hover:border-border hover:bg-accent transition-colors">
            <p className="text-[12px] text-foreground/85 leading-relaxed">{s}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
