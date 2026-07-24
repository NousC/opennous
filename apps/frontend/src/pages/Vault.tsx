// Vault — the documents every agent reads, and the model it scores on.
//
// A real folder tree, like a terminal or an editor: a chevron folder, plain filenames
// inside it, no per-file icons. Obsidian has no icons next to filenames either, and
// the reason is the same — an icon on every row is noise pretending to be structure.
// The folder IS the structure.
//
//   context/
//     positioning
//     icp
//     voice
//     messaging
//   ICP model              ← not a document. The model, drawn.
//
// The ICP model lives HERE and not in its own nav item, because it is context: the
// weights Nous learned from closed-won and closed-lost. `icp.md` is what you TELL it.
// The ICP model is what it LEARNED. Same subject, opposite directions, and they belong
// side by side so the difference between the two is impossible to miss.
//
// It renders as the GRAPH, not as a table of weights. A table of weights is a
// spreadsheet. What you actually want to see is the shape: every scored account laid
// out by the claims it shares, so the CLUSTERS ARE THE PATTERNS. Where the good scores
// cluster is your real ICP — and if that disagrees with icp.md, icp.md is wrong.
//
// Two writers, kept apart. A document whose source is `claude_code` is a MIRROR of a
// file in their repo. Editing it here works — the save echoes `source` and `file_path`
// back so the next sync knows where it lands — but the repo stays the author. Get that
// backwards and the next sync silently eats the edit.
import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import Intelligence from "./Intelligence";
import {
  FileText, ChevronRight, PanelLeftClose, PanelLeft,
  Calendar, AlignLeft, GitBranch, Target, Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

type Doc = {
  id: string; kind?: string; category?: string; title: string; source?: string;
  file_path?: string | null; version: number; updated_at: string | null;
};

// Two folders, two directions. `context` is authored by the user (or onboarding)
// and mirrored INTO Nous. `insights` is authored by Nous — extracted from calls —
// and can be mirrored OUT to the repo. Same editor, opposite source of truth.
type Item = { name: string; title: string; file: string };
const CONTEXT: Item[] = [
  { name: "positioning", title: "Positioning", file: "positioning" },
  { name: "icp",         title: "ICP",         file: "icp"         },
  { name: "voice",       title: "Voice",       file: "voice"       },
  { name: "outreach",    title: "Messaging",   file: "messaging"   },
];
const INSIGHTS: Item[] = [
  { name: "product",     title: "Product",     file: "product"     },
  { name: "positioning", title: "Positioning", file: "positioning" },
  { name: "market",      title: "Market",      file: "market"      },
  { name: "buyer",       title: "Buyer",       file: "buyer"       },
];

const MODEL = "__model__"; // the ICP model pseudo-file

// The open doc is a composite key: "ctx:<name>" or "ins:<name>" (or MODEL). The URL
// keeps them apart with an `insights-` prefix, because both folders hold a
// "positioning" file and a bare slug would collide.
const groupOf = (active: string) => (active.startsWith("ins:") ? "ins" : "ctx") as "ins" | "ctx";
const nameOf = (active: string) => active.slice(4);
const specOf = (active: string): Item => {
  const list = groupOf(active) === "ins" ? INSIGHTS : CONTEXT;
  return list.find(x => x.name === nameOf(active)) ?? list[0];
};
const toSlug = (active: string) =>
  active === MODEL ? "model" : groupOf(active) === "ins" ? `insights-${nameOf(active)}` : nameOf(active);
const fromSlug = (slug?: string): string => {
  if (slug === "model") return MODEL;
  if (slug && slug.startsWith("insights-")) {
    const n = slug.slice("insights-".length);
    return INSIGHTS.some(i => i.name === n) ? `ins:${n}` : "ctx:positioning";
  }
  if (slug && CONTEXT.some(c => c.name === slug)) return `ctx:${slug}`;
  return "ctx:positioning";
};

type Buf = { body: string; loaded: boolean; dirty: boolean; saving: boolean };

// One typography scale, shared by the rendered view and the editor. If they differ by
// a pixel, clicking into the document makes the text jump and the illusion that you
// are editing the page dies instantly.
const TYPE = "text-[15.5px] leading-[1.75] text-foreground/85";

export default function Vault() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";

  // The open document is the URL now (/vault/:doc), so each doc is a tab on the workspace
  // bar instead of a second row Vault owns. `model` is the ICP-model pseudo-file.
  const navigate = useNavigate();
  const { doc: docParam } = useParams<{ doc?: string }>();
  const active: string = docParam === "model" ? MODEL : fromSlug(docParam);
  const open = (k: string) => navigate(`/vault/${toSlug(k)}`);

  const [ctxDocs, setCtxDocs] = useState<Doc[] | null>(null);
  const [insDocs, setInsDocs] = useState<Doc[] | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [ctxOpen, setCtxOpen] = useState(true);
  const [insOpen, setInsOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [bufs, setBufs] = useState<Record<string, Buf>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const ta = useRef<HTMLTextAreaElement | null>(null);

  const load = useCallback(() => {
    if (!token || !workspaceId) return;
    const h = { headers: { Authorization: `Bearer ${token}` } };
    fetch(`${apiUrl}/api/foundations?workspaceId=${workspaceId}`, h)
      .then(r => (r.ok ? r.json() : null)).then(d => setCtxDocs(d?.foundations ?? [])).catch(() => setCtxDocs([]));
    fetch(`${apiUrl}/api/insights?workspaceId=${workspaceId}`, h)
      .then(r => (r.ok ? r.json() : null)).then(d => setInsDocs(d?.insights ?? [])).catch(() => setInsDocs([]));
  }, [token, workspaceId]);
  useEffect(() => { load(); }, [load]);

  const docsLoaded = ctxDocs !== null && insDocs !== null;
  const byKey = new Map<string, Doc>();
  (ctxDocs ?? []).forEach(d => byKey.set(`ctx:${d.kind}`, d));
  (insDocs ?? []).forEach(d => byKey.set(`ins:${d.category}`, d));

  const isModel = active === MODEL;
  const doc = active && !isModel ? byKey.get(active) : undefined;
  const buf = active && !isModel ? bufs[active] : undefined;

  useEffect(() => {
    if (!active || isModel || !docsLoaded || bufs[active]?.loaded) return;
    const d = byKey.get(active);
    if (!d) { setBufs(b => ({ ...b, [active]: { body: "", loaded: true, dirty: false, saving: false } })); return; }
    const base = groupOf(active) === "ins" ? "insights" : "foundations";
    fetch(`${apiUrl}/api/${base}/${d.id}?workspaceId=${workspaceId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(j => setBufs(b => ({ ...b, [active]: { body: j?.foundation?.body_md ?? j?.insight?.body_md ?? "", loaded: true, dirty: false, saving: false } })))
      .catch(() => setBufs(b => ({ ...b, [active]: { body: "", loaded: true, dirty: false, saving: false } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, docsLoaded]);

  const save = useCallback(async (key: string, body: string) => {
    const d = byKey.get(key);
    const s = specOf(key);
    setBufs(b => ({ ...b, [key]: { ...b[key], saving: true } }));
    const payload = groupOf(key) === "ins"
      ? { base: "insights", body: { body_md: body } }
      : { base: "foundations", body: { body_md: body, title: s.title, source: d?.source ?? "nous", file_path: d?.file_path ?? null } };
    await fetch(`${apiUrl}/api/${payload.base}/${s.name}?workspaceId=${workspaceId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload.body),
    }).catch(() => {});
    setBufs(b => ({ ...b, [key]: { ...b[key], saving: false, dirty: false } }));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxDocs, insDocs, token, workspaceId, load]);

  const type = (key: string, body: string) => {
    setBufs(b => ({ ...b, [key]: { ...b[key], body, dirty: true } }));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => save(key, body), 900);
  };


  // Leaving edit mode whenever the open doc changes (you navigated to another tab).
  useEffect(() => { setEditing(false); }, [active]);

  const startEditing = () => {
    setEditing(true);
    requestAnimationFrame(() => {
      const el = ta.current; if (!el) return;
      el.focus(); el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  return (
    <div className="h-full flex bg-background overflow-hidden">
      {/* ── The tree. A folder, filenames, no icons. ─────────────────────────── */}
      {treeOpen && (
        <nav className="w-[236px] flex-shrink-0 border-r border-border flex flex-col bg-muted/25">
          <div className="flex items-center justify-between pl-4 pr-2 h-12 flex-shrink-0">
            <span className="text-[13px] font-semibold text-foreground/80">Vault</span>
            <button
              onClick={() => setTreeOpen(false)}
              title="Collapse"
              className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
            >
              <PanelLeftClose className="h-[17px] w-[17px]" strokeWidth={1.75} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2 text-[13.5px]">
            {/* context/ — authored by you, mirrored into Nous. */}
            <button
              onClick={() => setCtxOpen(o => !o)}
              className="w-full flex items-center gap-1 rounded-md px-1.5 py-[6px] hover:bg-accent/50 transition-colors"
            >
              <ChevronRight
                className={cn("h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40 transition-transform duration-150", ctxOpen && "rotate-90")}
                strokeWidth={2}
              />
              <span className="text-foreground/70">context</span>
            </button>
            {ctxOpen && (
              <ul className="ml-[9px] border-l border-border/60 pl-1.5">
                {CONTEXT.map(k => {
                  const key = `ctx:${k.name}`;
                  const d = byKey.get(key);
                  return (
                    <li key={key}>
                      <button
                        onClick={() => open(key)}
                        className={cn(
                          "w-full text-left rounded-md px-2 py-[6px] truncate transition-colors",
                          active === key ? "bg-accent text-foreground font-medium"
                            : d ? "text-foreground/65 hover:bg-accent/50" : "text-muted-foreground/40 hover:bg-accent/50",
                        )}
                      >
                        {k.file}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* insights/ — learned by Nous from calls, mirrored out to you. */}
            <button
              onClick={() => setInsOpen(o => !o)}
              className="mt-1 w-full flex items-center gap-1 rounded-md px-1.5 py-[6px] hover:bg-accent/50 transition-colors"
            >
              <ChevronRight
                className={cn("h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40 transition-transform duration-150", insOpen && "rotate-90")}
                strokeWidth={2}
              />
              <span className="text-foreground/70">insights</span>
            </button>
            {insOpen && (
              <ul className="ml-[9px] border-l border-border/60 pl-1.5">
                {INSIGHTS.map(k => {
                  const key = `ins:${k.name}`;
                  const d = byKey.get(key);
                  return (
                    <li key={key}>
                      <button
                        onClick={() => open(key)}
                        className={cn(
                          "w-full text-left rounded-md px-2 py-[6px] truncate transition-colors",
                          active === key ? "bg-accent text-foreground font-medium"
                            : d ? "text-foreground/65 hover:bg-accent/50" : "text-muted-foreground/40 hover:bg-accent/50",
                        )}
                      >
                        {k.file}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* The model. Sits below the folders because it is not a document — it is
                what the documents produced. */}
            <button
              onClick={() => open(MODEL)}
              className={cn(
                "mt-1.5 w-full flex items-center gap-2 rounded-md px-1.5 py-[6px] transition-colors",
                active === MODEL ? "bg-accent text-foreground font-medium" : "text-foreground/65 hover:bg-accent/50",
              )}
            >
              <Target className="h-[14px] w-[14px] flex-shrink-0 text-muted-foreground/45" strokeWidth={1.75} />
              <span>ICP model</span>
            </button>
          </div>
        </nav>
      )}

      {/* ── The pane ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* The doc tabs moved up to the workspace tab bar (each is its own route). All
            that stays here is the Expand control when the tree is folded — no second
            tab row. Mirrors the Threads page. */}
        {!treeOpen && (
          <div className="h-12 flex-shrink-0 flex items-center border-b border-border/70 px-2">
            <button
              onClick={() => setTreeOpen(true)}
              title="Expand"
              className="p-1.5 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-accent transition-colors"
            >
              <PanelLeft className="h-[17px] w-[17px]" strokeWidth={1.75} />
            </button>
          </div>
        )}

        {isModel ? (
          <IcpModel />
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-[700px] mx-auto px-12 pt-10 pb-24">
              <div className="flex items-center justify-between gap-4 mb-7">
                <span className="text-[12.5px] text-muted-foreground/35">
                  {doc?.file_path ?? `${groupOf(active) === "ins" ? "insights" : "context"} / ${specOf(active).file}.md`}
                </span>
                <span className="text-[11.5px] text-muted-foreground/35 tabular-nums flex-shrink-0">
                  {buf?.saving ? "Saving" : buf?.dirty ? "Unsaved" : doc ? "Saved" : ""}
                </span>
              </div>
              <h1 className="text-[30px] font-semibold text-foreground leading-[1.2] tracking-[-0.01em] mb-7">
                {specOf(active).title}
              </h1>

              <dl className="mb-9 space-y-0.5">
                <Prop icon={AlignLeft} label="type" value={groupOf(active) === "ins" ? "insight" : "context"} />
                <Prop icon={GitBranch} label="source"
                  value={!doc ? (groupOf(active) === "ins" ? "not yet learned" : "not written")
                    : groupOf(active) === "ins" ? "Nous (from calls)"
                      : doc.source === "claude_code" ? "Claude Code" : "Nous"} muted={!doc} />
                <Prop icon={AlignLeft} label="version" value={doc ? String(doc.version) : "—"} muted={!doc} />
                <Prop icon={Calendar} label="updated"
                  value={doc?.updated_at ? format(new Date(doc.updated_at), "MM/dd/yyyy") : "—"} muted={!doc?.updated_at} />
              </dl>

              <div className="border-t border-border/50 mb-8" />

              {!buf?.loaded ? (
                <div className="space-y-3">
                  {[...Array(7)].map((_, i) => (
                    <div key={i} className="h-4 bg-muted/40 rounded" style={{ width: `${70 + (i % 3) * 10}%` }} />
                  ))}
                </div>
              ) : editing ? (
                <textarea
                  ref={ta}
                  value={buf.body}
                  onChange={e => type(active, e.target.value)}
                  onBlur={() => setEditing(false)}
                  spellCheck={false}
                  placeholder="Start typing. It saves itself."
                  className={cn("w-full min-h-[55vh] bg-transparent border-0 p-0 outline-none resize-none placeholder:text-muted-foreground/25", TYPE)}
                />
              ) : buf.body ? (
                <article onClick={startEditing} className={cn("cursor-text", PROSE)}>
                  <ReactMarkdown>{buf.body}</ReactMarkdown>
                </article>
              ) : groupOf(active) === "ins" ? (
                <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
                  <Sparkles className="h-5 w-5 mx-auto text-muted-foreground/25 mb-3" strokeWidth={1.5} />
                  <p className="text-[14px] text-foreground/70 mb-1.5">Nothing learned yet.</p>
                  <p className="text-[13px] text-muted-foreground/50 max-w-[420px] mx-auto leading-relaxed">
                    This fills itself from your calls. Every transcript is mined for what it
                    taught us about our {specOf(active).title.toLowerCase()}. After your next
                    call, it appears here.
                  </p>
                </div>
              ) : (
                <button onClick={startEditing} className="w-full text-left group">
                  <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center transition-colors group-hover:border-foreground/20 group-hover:bg-accent/20">
                    <FileText className="h-5 w-5 mx-auto text-muted-foreground/25 mb-3" strokeWidth={1.5} />
                    <p className="text-[14px] text-foreground/70 mb-1.5">Nothing here yet.</p>
                    <p className="text-[13px] text-muted-foreground/50 max-w-[400px] mx-auto leading-relaxed">
                      Every agent that touches an account reads this document first.
                      Until it exists, they are guessing.
                    </p>
                  </div>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── The ICP model ──────────────────────────────────────────────────────────────
//
// What Nous learned from your closed deals: the win drivers, the loss drivers, and the
// weights. `icp.md` is what you TELL it. This is what it WORKED OUT. Same subject,
// opposite directions, which is exactly why they belong side by side in the Vault.
//
// It is a page and not a graph, and that is deliberate.
//
// A graph of the model would be the better artefact — accounts as nodes, signals as
// hubs, an edge wherever a signal fired, so the accounts that share win-drivers pull
// together and the cluster IS the pattern. We cannot draw it yet, because
// `predictions.fired_signals` is null on every row: nothing records WHICH signals fired
// on WHICH account. The scorer evaluates `scorecard_signals.rule` against each entity
// and then throws the matches away.
//
// Until that is persisted, the only thing available to lay accounts out by is shared
// claims — which are co-mentioned tools (clay, zapier, linkedin), not ICP patterns. A
// picture built on that is a lie with a legend on it, so we do not draw one.
function IcpModel() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <Intelligence />
    </div>
  );
}

const PROSE = [
  "prose dark:prose-invert max-w-none",
  "prose-headings:font-semibold prose-headings:tracking-[-0.01em] prose-headings:text-foreground",
  "prose-h1:text-[24px] prose-h1:mt-10 prose-h1:mb-4",
  "prose-h2:text-[19px] prose-h2:mt-9 prose-h2:mb-3",
  "prose-h3:text-[16px] prose-h3:mt-7 prose-h3:mb-2",
  "prose-p:text-[15.5px] prose-p:leading-[1.75] prose-p:text-foreground/85 prose-p:my-4",
  "prose-li:text-[15.5px] prose-li:leading-[1.75] prose-li:text-foreground/85 prose-li:my-1",
  "prose-strong:text-foreground prose-strong:font-semibold",
  "prose-a:text-foreground prose-a:underline prose-a:decoration-border prose-a:underline-offset-2",
  "prose-code:text-foreground prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
  "prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:text-foreground/70 prose-blockquote:not-italic prose-blockquote:font-normal",
  "prose-hr:border-border/50 prose-hr:my-9",
].join(" ");

function Prop({ icon: Icon, label, value, muted }: {
  icon: typeof AlignLeft; label: string; value: string; muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-[7px] -mx-2 hover:bg-accent/40 transition-colors">
      <Icon className="h-[15px] w-[15px] flex-shrink-0 text-muted-foreground/35" strokeWidth={1.75} />
      <dt className="w-[104px] flex-shrink-0 text-[13.5px] text-muted-foreground/55">{label}</dt>
      <dd className={cn("min-w-0 flex-1 text-[13.5px] tabular-nums", muted ? "text-muted-foreground/35" : "text-foreground/80")}>
        {value}
      </dd>
    </div>
  );
}
