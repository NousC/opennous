import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Linkedin, Trash2, RefreshCw, Search, Download, Upload, FileText, Filter, X, Users } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { relTime, eventTime, tierFromScore, TIER_UI, type IcpTier } from "@/components/mind/shared";
import { PeopleImportModal } from "@/components/contacts/PeopleImportModal";
import { ContactInfo, stageColor, ActivityIcon, DocIcon, mapContact } from "@/components/mind/entities";
import { useColumnWidths, ColResizer } from "@/components/mind/resizableColumns";
import { PageHeader } from "@/components/ui/page-header";
import { RecordOverview } from "@/components/RecordOverview";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const PAGE_SIZE = 100;
const PIPELINE_STAGES = ["identified", "aware", "connected", "interested", "evaluating", "client", "lost", "disqualified", "churned"];
// A "Free User" signup lands in a stage that is NOT one of the sales stages above.
// Those are product users, not deals: tagged, excluded from pipeline, counted separately.
const SALES_STAGE_SET = new Set(PIPELINE_STAGES);
const isProductUserStage = (s?: string | null) => !!s && !SALES_STAGE_SET.has(s.toLowerCase());

// Default widths for the resizable columns. "Last Int." is the elastic flex-1
// column and the action "Enrich" cell is fixed, so neither is listed here.
// Persisted per user in localStorage; see useColumnWidths.
const PEOPLE_COL_DEFAULTS: Record<string, number> = {
  name: 170, company: 115, source: 96, domain: 100, li: 40, stage: 88,
  icp: 42, tier: 76, intent: 92, lastActivity: 130,
};
const PEOPLE_COL_KEYS = ["name","company","domain","li","stage","icp","tier","intent","lastActivity","source"];

// Intent band → pill classes (the "reach out now?" axis). Mirrors Lists.tsx.
const INTENT_TAG: Record<string, string> = {
  "Red-hot": "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  Hot:       "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Warm:      "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Aware:     "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400",
  Dormant:   "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-500",
};

// Tier rank for sorting (best first). Mirrors the lead list.
const TIER_RANK: Record<IcpTier, number> = { tier_1: 4, tier_2: 3, tier_3: 2, not_icp: 1 };
// The tier a contact effectively has: the model's, else derived from the score.
const contactTier = (c: { icpTier: IcpTier | null; icpScore: number | null }): IcpTier | null =>
  c.icpTier ?? tierFromScore(c.icpScore);

// Pretty labels for the first-contact source — the channel a person first came in
// through (LinkedIn / Instantly / Gmail / …). Falls back to a capitalized form.
const SOURCE_LABELS: Record<string, string> = {
  linkedin: "LinkedIn", instantly: "Instantly", smartlead: "Smartlead", gmail: "Gmail",
  heyreach: "HeyReach", lemlist: "Lemlist", emailbison: "EmailBison", cal_com: "Cal.com",
  calendly: "Calendly", import: "Import", airtable_import: "Airtable", manual: "Manual",
  apollo: "Apollo", prospeo: "Prospeo", csv: "CSV", rb2b: "RB2B", slack: "Slack",
};
const sourceLabel = (s?: string | null) =>
  !s ? "—" : (SOURCE_LABELS[s] ?? (s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ")));

// One record, everywhere. Overview leads, because "who is this and is this account
// alive" is the question you arrive with no matter which surface you clicked from — the
// table, the graph, a search. Everything after it is a CHANNEL, and a channel only
// answers "what happened over here".
//
// Company is gone. It was a tab that showed you a different entity's record inside this
// one, which is a link pretending to be a tab.
type DetailTab = "overview" | "activity" | "emails" | "linkedin" | "slack" | "calls" | "notes" | "signals" | "memory";

// ─── PeopleDetail — tabbed contact record ────────────────────────────────────

function PeopleDetail({ contact, token, onBack }: { contact: ContactInfo; token: string; onBack: () => void }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<DetailTab>("overview");
  // The record is a cached React Query (below): reopening an account you've already
  // viewed is instant from cache instead of re-running the heavy /api/contacts/:id
  // endpoint. Fields below are derived from that single response.
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [localOverrides, setLocalOverrides] = useState<Record<string, string | null>>({});
  const [lostMarking, setLostMarking] = useState(false);
  const [lostMarked, setLostMarked] = useState(false);
  const [personalSaving, setPersonalSaving] = useState(false);

  // Record an explicit closed-lost — a real negative the Mind learns from,
  // unlike a contact that simply goes quiet.
  const markLost = async () => {
    if (lostMarking || lostMarked) return;
    if (!window.confirm("Mark this account as closed-lost? It teaches the scoring model from a real loss.")) return;
    setLostMarking(true);
    try {
      await fetch(`${apiUrl}/api/contacts/${contact.id}/mark-lost`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      setLostMarked(true);
    } catch { /* silent */ }
    finally { setLostMarking(false); }
  };

  const { data, isPending: loading, refetch } = useQuery({
    queryKey: ["contact", contact.id],
    queryFn: async () => {
      const r = await fetch(`${apiUrl}/api/contacts/${contact.id}`, { headers: { Authorization: `Bearer ${token}` } });
      return r.ok ? r.json() : null;
    },
    enabled: !!contact.id && !!token,
  });

  // Mark this contact personal/network — not a deal. Keeps the record but pulls them
  // out of pipeline, scoring, and deal-risk. Toggle: pass the desired next state.
  const togglePersonal = async (on: boolean) => {
    if (personalSaving) return;
    setPersonalSaving(true);
    try {
      await fetch(`${apiUrl}/api/contacts/${contact.id}/personal`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ personal: on }),
      });
      await refetch();
    } catch { /* silent */ }
    finally { setPersonalSaving(false); }
  };

  // Soft-delete a note/document (invalidates the claim server-side). Used to clear
  // duplicate briefs from the Notes tab. A real in-app dialog (not the browser's
  // native confirm) collects intent; confirmDeleteNote does the delete + refetch.
  const [noteToDelete, setNoteToDelete] = useState<{ id: string; title: string } | null>(null);
  const [deletingNote, setDeletingNote] = useState(false);
  const confirmDeleteNote = async () => {
    if (!noteToDelete || deletingNote) return;
    setDeletingNote(true);
    try {
      await fetch(`${apiUrl}/api/contacts/${contact.id}/memories/${noteToDelete.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await refetch();
      setNoteToDelete(null);
    } catch { /* refetch reconciles on next open */ }
    finally { setDeletingNote(false); }
  };
  const acts = useMemo(
    () => ((data?.activities ?? []) as any[]).filter((a: any) => a.activity_type !== "icp_scored"),
    [data],
  );
  const mems: any[] = data?.memories ?? [];
  const signals: any[] = data?.signals ?? [];
  const raw = data?.contact ?? null;
  const prediction = data?.prediction ?? null;
  const company = data?.company ?? null;

  const patchContact = async (patchKey: string, value: string) => {
    setSaving(true);
    try {
      await fetch(`${apiUrl}/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [patchKey]: value || null }),
      });
      setLocalOverrides(prev => ({ ...prev, [patchKey]: value || null }));
    } catch { /* silent */ }
    finally { setSaving(false); setEditingField(null); }
  };

  const startEdit = (key: string, current: string | null) => {
    setEditingField(key); setEditValue(current ?? "");
  };

  const get = (patchKey: string, fallback: string | null | undefined) =>
    patchKey in localOverrides ? localOverrides[patchKey] : (fallback ?? null);

  // localOverrides is keyed by PATCH key (jobTitle), the row is keyed by column
  // (job_title). Bridge them so an edit shows the moment you make it rather than after a
  // refetch that never comes.
  const PATCH_TO_COL: Record<string, string> = {
    firstName: "first_name", lastName: "last_name", jobTitle: "job_title",
    linkedinUrl: "linkedin_url", dealStage: "deal_stage", dealValue: "deal_value",
  };
  const contactPatchView = Object.fromEntries(
    Object.entries(localOverrides).map(([k, v]) => [PATCH_TO_COL[k] ?? k, v]),
  );

  const emails  = acts.filter(a => a.source === "gmail" || ["email_sent","email_opened","email_reply","email_bounced"].some(t => a.activity_type?.includes(t)));
  const linkedin = acts.filter(a => a.source === "linkedin" || a.activity_type?.includes("linkedin"));
  const slack   = acts.filter(a => a.source === "slack"    || a.activity_type?.includes("slack"));
  const calls   = acts.filter(a => ["call","meeting"].some(t => a.activity_type?.includes(t)));
  // Documents (meeting briefs, transcripts, notes) live in the notes layer with a
  // doc_type; plain atomic facts are the rest. Documents → Notes tab, facts → Facts.
  const documents = mems.filter((m: any) => m.metadata?.doc_type);
  const facts     = mems.filter((m: any) => !m.metadata?.doc_type);
  // `signals` come from d.signals (signal.* claims) — see fetch above.

  const TABS: { id: DetailTab; label: string; count?: number }[] = [
    { id:"overview",  label:"Overview"                         },
    { id:"activity",  label:"Activity",  count: acts.length    },
    { id:"emails",    label:"Emails",    count: emails.length  },
    { id:"linkedin",  label:"LinkedIn",  count: linkedin.length },
    { id:"slack",     label:"Slack",     count: slack.length   },
    { id:"calls",     label:"Calls",     count: calls.length   },
    { id:"notes",     label:"Notes",     count: documents.length },
    { id:"signals",   label:"Signals",   count: signals.length },
    { id:"memory",    label:"Intel",     count: facts.length   },
  ];

  const tabItems = tab==="activity" ? acts : tab==="emails" ? emails : tab==="linkedin" ? linkedin : tab==="slack" ? slack : tab==="calls" ? calls : [];

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Note delete confirmation — a real in-app dialog, not the browser's native
          confirm. Matches the account-delete modal in the list view. */}
      {noteToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => !deletingNote && setNoteToDelete(null)} />
          <div className="relative z-10 w-full max-w-[420px] rounded-2xl border border-border bg-background shadow-2xl p-6">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-red-500/10 text-red-500">
                <Trash2 className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[16px] font-semibold tracking-tight text-foreground">Delete this note?</h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground/80">{noteToDelete.title}</span> is removed from the
                  record but stays recoverable.
                </p>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                onClick={() => setNoteToDelete(null)}
                disabled={deletingNote}
                className="h-9 px-4 rounded-lg border border-border bg-background text-[13px] font-medium text-foreground/80 hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteNote}
                disabled={deletingNote}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-red-500 text-white text-[13px] font-semibold hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {deletingNote ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="flex-shrink-0 px-8 pt-7 pb-0">
        {/* No back button. An account opens as a TAB now — the thing you came from is
            still sitting next to this, one click away, and a back button would take you
            somewhere you never left. The subtitle is the job title, not the email: the
            email lives in Overview, where you can copy it. */}
        <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{contact.name}</h1>
        <div className="flex items-center gap-2 mt-1 mb-4 flex-wrap">
          {contact.title && <span className="text-[13px] text-muted-foreground">{contact.title}</span>}
          {contact.companyName && <>
            <span className="text-[13px] text-muted-foreground/40">·</span>
            <span className="text-[13px] text-muted-foreground">{contact.companyName}</span>
          </>}
        </div>
        <div className="flex gap-6 border-b border-border overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 pb-2.5 text-[13px] font-medium transition-colors flex-shrink-0 ${
                tab===t.id ? "text-foreground border-b-2 border-foreground -mb-px" : "text-muted-foreground/70 hover:text-foreground/80"
              }`}>
              {t.label}
              {t.count !== undefined && <span className={`text-[11px] ${tab===t.id ? "text-muted-foreground/70" : "text-muted-foreground/50"}`}>{t.count}</span>}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-[13px] text-muted-foreground/70">Loading…</div>
      ) : (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Main content */}
          <div className="flex-1 overflow-y-auto px-8 py-4">
            {tab === "overview" && (
              <RecordOverview
                contact={{ ...raw, ...contactPatchView }}
                company={company}
                prediction={prediction}
                activities={acts}
                pipelineStages={PIPELINE_STAGES}
                onPatch={patchContact}
                onMarkLost={markLost}
                lostState={{ marking: lostMarking, marked: lostMarked }}
                onTogglePersonal={togglePersonal}
                personalSaving={personalSaving}
              />
            )}
            {(tab !== "overview" && tab !== "memory" && tab !== "notes" && tab !== "signals") && (
              tabItems.length === 0
                ? <p className="text-[13px] text-muted-foreground/70 py-12 text-center">Nothing here yet</p>
                : <div className="divide-y divide-border/60">
                    {tabItems.map((a: any) => {
                      const body = a.subtitle || a.raw_data?.text || a.raw_data?.body || null;
                      const title = a.title || a.activity_type?.replace(/_/g," ").toLowerCase();
                      // A held call carries its full AI summary — that belongs in the Notes
                      // document, not as a wall of text in the timeline. Keep the activity to a
                      // one-line gist and link to the full write-up. Everything else clamps to
                      // 3 lines so the feed stays scannable.
                      const isCall = a.activity_type === "meeting_held" || a.activity_type === "call_held";
                      return (
                        <div key={a.id} className="py-3">
                          <div className="flex items-center gap-2.5 mb-1.5">
                            <ActivityIcon source={a.source} type={a.activity_type || ""} />
                            <span className="text-[13px] font-medium text-foreground flex-1 truncate">
                              {title}
                            </span>
                            <span className="text-[12px] text-muted-foreground/70 tabular-nums flex-shrink-0">{eventTime(a.created_at || a.occurred_at, a.activity_type)}</span>
                          </div>
                          {body && (
                            <p className={`text-[13px] text-muted-foreground leading-relaxed pl-[26px] ${isCall ? "line-clamp-1" : "line-clamp-3"}`}>{body}</p>
                          )}
                          {isCall && (
                            <button
                              onClick={() => setTab("notes")}
                              className="pl-[26px] mt-1 inline-flex items-center gap-1 text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors"
                            >
                              <FileText className="h-3 w-3" /> Meeting notes
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
            )}
            {tab === "notes" && (
              documents.length === 0
                ? <p className="text-[13px] text-muted-foreground/70 py-12 text-center">No notes or documents yet</p>
                : <div className="divide-y divide-border/60">
                    {documents.map((m: any) => {
                      const when = m.metadata?.date || m.created_at;
                      const isLinkedInScan = /linkedin post scan|post scan/i.test(String(m.metadata?.title || ""));
                      return (
                        <div key={m.id} onClick={() => window.open(`/note/${m.id}`, "_blank")}
                          title="Open note in a new tab"
                          className="group py-3 flex items-center gap-2.5 cursor-pointer hover:bg-muted/30 -mx-2 px-2 rounded-md transition-colors">
                          {isLinkedInScan
                            ? <Linkedin className="h-4 w-4 text-[#0A66C2] flex-shrink-0" />
                            : <DocIcon source={m.source} />}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <span className="text-[13px] font-medium text-foreground/85 truncate">{m.metadata?.title || m.category}</span>
                              <span className="text-[12px] text-muted-foreground/70 ml-auto flex-shrink-0">{relTime(when)}</span>
                            </div>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); setNoteToDelete({ id: m.id, title: m.metadata?.title || m.category || "this note" }); }}
                            title="Delete note"
                            className="flex-shrink-0 p-1 rounded text-muted-foreground/50 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
            )}
            {tab === "memory" && (
              facts.length === 0
                ? <p className="text-[13px] text-muted-foreground/70 py-12 text-center">No intel yet</p>
                : <div className="divide-y divide-border/60">
                    {facts.map((m: any) => (
                      <div key={m.id} className="py-3">
                        <div className="flex items-baseline gap-2 mb-1">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 capitalize">{m.category?.toLowerCase()}</span>
                          <span className="text-[12px] text-muted-foreground/70 ml-auto">{relTime(m.created_at)}</span>
                        </div>
                        <p className="text-[13px] text-foreground/80 leading-relaxed">{m.content}</p>
                        {Array.isArray(m.metadata?.mentions) && m.metadata.mentions.some((x: any) => x?.entity_id) && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {m.metadata.mentions
                              .filter((x: any) => x?.entity_id && (x.status === "resolved" || x.status === "resolved_stub"))
                              .map((x: any) => (
                                <button
                                  key={x.entity_id}
                                  onClick={() => navigate(`/people/${x.entity_id}`)}
                                  title={x.status === "resolved_stub" ? "Pending identity — click to open" : "Open account"}
                                  className="inline-flex items-center rounded-full bg-secondary/60 hover:bg-secondary px-2 py-0.5 text-[11px] font-medium text-foreground/80 transition-colors"
                                >
                                  @{x.label}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
            )}
            {tab === "signals" && (
              signals.length === 0
                ? <p className="text-[13px] text-muted-foreground/70 py-12 text-center">No signals yet — run signal-scan on this account</p>
                : <div className="divide-y divide-border/60">
                    {signals.map((s: any) => {
                      const col = s.score == null ? "#6b7280" : s.score >= 8 ? "#15803d" : s.score >= 5 ? "#b45309" : "#6b7280";
                      return (
                        <div key={s.signal_class} className="py-3">
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 capitalize">{s.signal_class}</span>
                            {s.score != null && <span className="text-[12px] font-semibold tabular-nums" style={{ color: col }}>{s.score}/10</span>}
                            {s.updated_at && <span className="text-[12px] text-muted-foreground/70 ml-auto">{relTime(s.updated_at)}</span>}
                          </div>
                          <p className="text-[13px] text-foreground/80 leading-relaxed">{s.detected}{s.implies ? ` — ${s.implies}` : ""}</p>
                          {s.angle && <p className="text-[12px] text-muted-foreground italic mt-1">Angle: {s.angle}</p>}
                        </div>
                      );
                    })}
                  </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

// ─── People — standalone page ────────────────────────────────────────────────

export default function People({ embedded = false, leadingTab = null, focusId = null, onOpen = null }: {
  embedded?: boolean; leadingTab?: React.ReactNode;
  // `focusId` renders ONE account's record without touching the route. It is what lets
  // the Accounts page open a person as a TAB beside the graph: several records open at
  // once, each closable, none of them stealing the URL from the others.
  focusId?: string | null;
  // When the host is running tabs, a row click hands the account UP instead of navigating.
  // Navigating away is what made comparing two accounts impossible.
  onOpen?: ((c: { id: string; name: string }) => void) | null;
} = {}) {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = userData?.workspace?.id ?? "";
  const { id: routeId } = useParams();
  const id = focusId ?? routeId;
  const navigate = useNavigate();
  const location = useLocation();

  // Team members (co-founders / colleagues) are hidden from Accounts by default —
  // they're recognised records, not leads. Toggle to bring them into view.
  // Team members are always shown now (tagged with a TEAM badge), never hidden behind
  // a toggle — same treatment as personal contacts.

  const queryClient = useQueryClient();
  const contactsKey = useMemo(() => ["contacts", workspaceId] as const, [workspaceId]);
  // The account list is cached (React Query): returning to it is instant instead of
  // re-fetching up to 2,000 rows every time. refetch() replaces the old load().
  const { data: contacts = [], isPending: loading, refetch } = useQuery({
    queryKey: contactsKey,
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/contacts?workspaceId=${workspaceId}&limit=2000&include_team=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = res.ok ? await res.json() : {};
      return ((data.contacts ?? []) as any[]).map(mapContact) as ContactInfo[];
    },
    enabled: !!token && !!workspaceId,
  });
  // Prefetch a record on row hover so the click opens instantly — same query key
  // PeopleDetail reads, so the open is a cache hit.
  const prefetchContact = useCallback((cid: string) => {
    queryClient.prefetchQuery({
      queryKey: ["contact", cid],
      queryFn: async () => {
        const r = await fetch(`${apiUrl}/api/contacts/${cid}`, { headers: { Authorization: `Bearer ${token}` } });
        return r.ok ? r.json() : null;
      },
    });
  }, [queryClient, token]);

  const [q, setQ] = useState("");
  // One filter builder (same pattern as the lead list) — every filter is a
  // "Where <field> is <value>" row; multiple stack. Persisted per workspace.
  const [pplFilters, setPplFilters] = useState<{ field: string; value: string }[]>(() => {
    try { const v = localStorage.getItem("nous.people.filters"); return v ? JSON.parse(v) : []; }
    catch { return []; }
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [fbField, setFbField] = useState("stage");
  const [fbValue, setFbValue] = useState("");
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState<"lastActivity"|"icp"|"tier"|null>(null);
  const [sortDir, setSortDir] = useState<"asc"|"desc">("asc");
  useEffect(() => { try { localStorage.setItem("nous.people.filters", JSON.stringify(pplFilters)); } catch { /* ignore */ } }, [pplFilters]);
  const { widths, startResize } = useColumnWidths("nous.people.colWidths", PEOPLE_COL_DEFAULTS);
  const colW = (c: string) => widths[c] ?? PEOPLE_COL_DEFAULTS[c];
  // Total content width (all columns + 78px enrich col + px-4 row padding) so the
  // table scrolls horizontally instead of squeezing columns into a fixed width.
  const ROW_MIN = PEOPLE_COL_KEYS.reduce((s,k)=>s+colW(k),0) + 78 + 32;
  const [showImport, setShowImport] = useState(false);
  const [enriching, setEnriching] = useState<Set<string>>(new Set());
  const [enriched, setEnriched] = useState<Set<string>>(new Set());
  const [enrichErr, setEnrichErr] = useState<Set<string>>(new Set());

  // A lead opened from a list may be a cold lead that the People view hides
  // (un-engaged leads aren't in this list). When the id isn't in the loaded
  // list, fetch that one record by id so its full tabbed record still opens.
  const inList = useMemo<ContactInfo | null>(
    () => id ? contacts.find(c => c.id === id) ?? null : null,
    [id, contacts]
  );
  const [fetchedDetail, setFetchedDetail] = useState<ContactInfo | null>(null);
  // A failed detail fetch used to leave `detail` null forever, which renders as an
  // endless "Loading…" — the request had already come back 500. Track the failure
  // so the page can say so.
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    if (!id || inList) { setFetchedDetail(null); setDetailError(null); return; }
    let alive = true;
    setDetailError(null);
    fetch(`${apiUrl}/api/contacts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error(r.status === 404 ? "This account no longer exists." : `Couldn't load this account (${r.status}).`);
        return r.json();
      })
      .then(d => {
        if (!alive) return;
        if (d?.contact) setFetchedDetail(mapContact(d.contact));
        else throw new Error("This account no longer exists.");
      })
      .catch(e => { if (alive) setDetailError(e.message || "Couldn't load this account."); });
    return () => { alive = false; };
  }, [id, inList, token]);
  const detail = inList ?? fetchedDetail;
  // Back goes to wherever you came from (e.g. the lead list), not always Accounts.
  const setDetail = (c: ContactInfo | null) => {
    if (c && onOpen) { onOpen({ id: c.id, name: c.name || "Account" }); return; }
    navigate(c ? `/people/${c.id}` : ((location.state as { from?: string } | null)?.from || "/accounts"));
  };

  const deleteContact = async (cid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    queryClient.setQueryData(contactsKey, (prev: ContactInfo[] = []) => prev.filter(c => c.id !== cid));
    fetch(`${apiUrl}/api/contacts/${cid}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  };

  // Multi-select delete. The delete cascades server-side — every claim, activity,
  // score and identifier for the account goes with it — so a re-import starts clean.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkPersonaling, setBulkPersonaling] = useState(false);
  const [bulkTeaming, setBulkTeaming] = useState(false);
  const toggleSel = (cid: string) => setSelected(prev => {
    const s = new Set(prev); s.has(cid) ? s.delete(cid) : s.add(cid); return s;
  });
  const doBulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkDeleting(true);
    queryClient.setQueryData(contactsKey, (prev: ContactInfo[] = []) => prev.filter(c => !selected.has(c.id)));
    try {
      await fetch(`${apiUrl}/api/contacts/bulk-delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ids }),
      });
    } catch { /* optimistic; refetch reconciles */ }
    setSelected(new Set());
    setBulkDeleting(false);
    setConfirmDelete(false);
    refetch();
  };

  // Multi-select mark-personal. A personal contact is a friend/connection, not a deal:
  // it stays in the graph and this list, just excluded from pipeline/deal logic.
  const doBulkPersonal = async (on: boolean) => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkPersonaling(true);
    queryClient.setQueryData(contactsKey, (prev: ContactInfo[] = []) =>
      prev.map(c => selected.has(c.id) ? { ...c, isPersonal: on } : c));
    try {
      await fetch(`${apiUrl}/api/contacts/bulk-personal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ids, personal: on }),
      });
    } catch { /* optimistic; refetch reconciles */ }
    setSelected(new Set());
    setBulkPersonaling(false);
    refetch();
  };

  // Multi-select mark-team. Same idea as personal: a teammate stays in the graph and
  // this list (tagged), just excluded from pipeline/deal analysis, scoring, and outreach.
  const doBulkTeam = async (on: boolean) => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkTeaming(true);
    queryClient.setQueryData(contactsKey, (prev: ContactInfo[] = []) =>
      prev.map(c => selected.has(c.id) ? { ...c, isInternal: on } : c));
    try {
      await fetch(`${apiUrl}/api/contacts/bulk-internal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ids, internal: on }),
      });
    } catch { /* optimistic; refetch reconciles */ }
    setSelected(new Set());
    setBulkTeaming(false);
    refetch();
  };

  const handleEnrich = async (c: ContactInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    if (enriching.has(c.id) || enriched.has(c.id)) return;
    setEnriching(prev => new Set(prev).add(c.id));
    setEnrichErr(prev => { const s = new Set(prev); s.delete(c.id); return s; });
    try {
      const res = await fetch(`${apiUrl}/api/contacts/${c.id}/enrich`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setEnriched(prev => new Set(prev).add(c.id));
        // Refresh so the new title/seniority/company + ICP score show without a
        // full page reload. A short second pass catches the async claim pipeline.
        refetch();
        setTimeout(() => refetch(), 2500);
      }
      else setEnrichErr(prev => new Set(prev).add(c.id));
    } catch { setEnrichErr(prev => new Set(prev).add(c.id)); }
    finally { setEnriching(prev => { const s = new Set(prev); s.delete(c.id); return s; }); }
  };

  // firstDir = the direction the first click applies. Cycle: off → firstDir →
  // opposite → off. ICP passes "desc" so the first click puts the best fits on top.
  const cycleSort = (col: "lastActivity"|"icp"|"tier", firstDir: "asc"|"desc" = "asc") => {
    if (sortCol !== col) { setSortCol(col); setSortDir(firstDir); }
    else if (sortDir === firstDir) setSortDir(firstDir === "asc" ? "desc" : "asc");
    else { setSortCol(null); setPage(0); }
  };

  // Distinct first-contact sources present in the loaded set — powers the filter.
  const sourceOptions = [...new Set(contacts.map(c => c.source).filter(Boolean) as string[])].sort();
  // The team members who actually own accounts here. Built from the loaded set for
  // the same reason as sourceOptions: an owner nobody owns anything under is a
  // filter that returns nothing.
  const ownerOptions = [...new Map(
    contacts
      .filter(c => c.ownerUserId)
      .map(c => [c.ownerUserId as string, c.ownerName || "Unknown"] as const),
  ).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  // The filterable fields — same shape as the lead-list FB_FIELDS. Each carries
  // its dropdown values AND a client-side matcher, so adding a new column to the
  // filter is just one more entry here. Built with sourceOptions (dynamic).
  const PPL_FIELDS: { key: string; label: string; values: { v: string; l: string }[]; match: (c: ContactInfo, v: string) => boolean }[] = [
    { key: "stage", label: "Stage", values: PIPELINE_STAGES.map(s => ({ v: s, l: s })), match: (c, v) => c.pipelineStage === v },
    { key: "tier", label: "Tier", values: (["tier_1","tier_2","tier_3","not_icp"] as IcpTier[]).map(t => ({ v: t, l: TIER_UI[t].label })), match: (c, v) => contactTier(c) === v },
    { key: "icp", label: "ICP score", values: [{ v: "90", l: "90+" }, { v: "80", l: "80+" }, { v: "70", l: "70+" }, { v: "50", l: "50+" }], match: (c, v) => (c.icpScore ?? -1) >= Number(v) },
    { key: "intent", label: "Intent", values: [{ v: "Red-hot", l: "Red-hot" }, { v: "Hot", l: "Hot" }, { v: "Warm", l: "Warm" }, { v: "Aware", l: "Aware" }], match: (c, v) => (c.intentBand ?? "Dormant") === v },
    { key: "domain", label: "Domain", values: [{ v: "has", l: "Has domain" }, { v: "none", l: "No domain" }], match: (c, v) => v === "has" ? !!c.domain : !c.domain },
    { key: "source", label: "Source", values: sourceOptions.map(s => ({ v: s, l: sourceLabel(s) })), match: (c, v) => c.source === v },
    // Owner — who on the team is carrying this account. Matches on membership, not
    // just the primary: if you and a teammate are both on an account, it shows up
    // under both of you, which is the collision you want to see.
    {
      key: "owner",
      label: "Account Owner",
      values: ownerOptions.map(([id, name]) => ({ v: id, l: name })),
      match: (c, v) => c.ownerUserId === v || c.ownerMembers.some(m => m.user_id === v),
    },
  ];
  const pplFieldDef = PPL_FIELDS.find(f => f.key === fbField) ?? PPL_FIELDS[0];
  const pplLabel = (field: string, value: string) => {
    const f = PPL_FIELDS.find(x => x.key === field);
    return `${f?.label ?? field}: ${f?.values.find(v => v.v === value)?.l ?? value}`;
  };
  const addPplFilter = () => {
    if (!fbValue) return;
    setPplFilters(prev => [...prev.filter(f => f.field !== fbField), { field: fbField, value: fbValue }]);
    setFbValue(""); setFilterOpen(false); setPage(0);
  };
  const removePplFilter = (field: string) => { setPplFilters(prev => prev.filter(f => f.field !== field)); setPage(0); };

  const filtered = contacts.filter(c => {
    const qs = q.toLowerCase();
    if (q && !(c.name.toLowerCase().includes(qs) || (c.email??"").toLowerCase().includes(qs) || (c.companyName??"").toLowerCase().includes(qs))) return false;
    return pplFilters.every(f => { const def = PPL_FIELDS.find(x => x.key === f.field); return def ? def.match(c, f.value) : true; });
  });
  const sorted = [...filtered].sort((a,b) => {
    if (sortCol === "lastActivity") {
      const cmp = (a.lastActivityAt??"").localeCompare(b.lastActivityAt??"");
      return sortDir === "asc" ? cmp : -cmp;
    }
    if (sortCol === "icp") {
      // Unscored contacts sort to the bottom in either direction.
      const av = a.icpScore ?? -1, bv = b.icpScore ?? -1;
      return sortDir === "asc" ? av - bv : bv - av;
    }
    if (sortCol === "tier") {
      // By tier rank, then score within the tier; untiered sink to the bottom.
      const ra = TIER_RANK[contactTier(a) as IcpTier] ?? 0, rb = TIER_RANK[contactTier(b) as IcpTier] ?? 0;
      if (ra !== rb) return sortDir === "asc" ? ra - rb : rb - ra;
      const av = a.icpScore ?? -1, bv = b.icpScore ?? -1;
      return sortDir === "asc" ? av - bv : bv - av;
    }
    return (b.lastActivityAt??"").localeCompare(a.lastActivityAt??"");
  });
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleSearch = (v: string) => { setQ(v); setPage(0); };

  const handleExport = () => {
    const headers = ["Name","Email","Company","Pipeline Stage","Deal Stage","Segment","ICP","Tier","Last Activity","LinkedIn"];
    const rows = contacts.map(c => {
      const t = contactTier(c);
      return [
        c.name, c.email??"", c.companyName??"", c.pipelineStage,
        c.dealStage??"", c.segmentLabel??"",
        c.icpScore!=null?String(c.icpScore):"",
        t ? TIER_UI[t].label : "",
        c.lastActivityAt??"", c.linkedinUrl??""
      ];
    });
    const csv = [headers,...rows].map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    const a = document.createElement("a"); a.href=url; a.download="contacts.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // Sortable + resizable header cell (fixed-width columns). The relative wrapper
  // anchors the drag handle to the cell's right edge; widthKey ties the width to
  // the persisted store (defaults to the sort column name).
  const SortBtn = ({ col, label, widthKey, firstDir = "asc" }: { col:"icp"|"tier"; label:string; widthKey?:string; firstDir?:"asc"|"desc" }) => {
    const wk = widthKey ?? col;
    return (
      <div className="relative flex items-center flex-shrink-0 overflow-hidden" style={{width: colW(wk)}}>
        <button onClick={() => { cycleSort(col, firstDir); setPage(0); }}
          className="w-full min-w-0 text-[11px] font-semibold uppercase tracking-wide flex items-center gap-0.5 group">
          <span className={`truncate min-w-0 ${sortCol===col ? "text-foreground/80" : "text-muted-foreground/70 group-hover:text-foreground/80 transition-colors"}`}>{label}</span>
          {sortCol===col && <span className="text-[10px] text-muted-foreground ml-0.5 flex-shrink-0">{sortDir==="asc"?"↑":"↓"}</span>}
        </button>
        <ColResizer onMouseDown={e=>startResize(wk, e)} />
      </div>
    );
  };

  // Sortable "Last Int." header — a fixed-width, resizable column like the rest
  // (it used to be flex-1 and absorb all slack, which squeezed other columns).
  const SortBtnFlex = ({ col, label, firstDir = "asc" }: { col:"lastActivity"; label:string; firstDir?:"asc"|"desc" }) => (
    <div className="relative flex items-center flex-shrink-0 overflow-hidden" style={{width: colW("lastActivity")}}>
      <button onClick={() => { cycleSort(col, firstDir); setPage(0); }}
        className="w-full min-w-0 text-[11px] font-semibold uppercase tracking-wide flex items-center gap-0.5 group text-left">
        <span className={`truncate min-w-0 ${sortCol===col ? "text-foreground/80" : "text-muted-foreground/70 group-hover:text-foreground/80 transition-colors"}`}>{label}</span>
        {sortCol===col && <span className="text-[10px] text-muted-foreground ml-0.5 flex-shrink-0">{sortDir==="asc"?"↑":"↓"}</span>}
      </button>
      <ColResizer onMouseDown={e=>startResize("lastActivity", e)} />
    </div>
  );

  // Static (non-sortable) but still resizable header cell.
  const PlainHdr = ({ label, widthKey }: { label:string; widthKey:string }) => (
    <div className="relative flex items-center flex-shrink-0 overflow-hidden" style={{width: colW(widthKey)}}>
      <span className="w-full min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">{label}</span>
      <ColResizer onMouseDown={e=>startResize(widthKey, e)} />
    </div>
  );

  // When the route carries an id we're in detail mode — render the record (or a
  // brief loader while the contact resolves), never the list. Avoids flashing the
  // table for a moment before the detail appears.
  if (id) {
    return (
      <div className="h-full bg-background">
        {detail
          ? <PeopleDetail contact={detail} token={token} onBack={() => setDetail(null)} />
          : detailError
            ? <div className="h-full flex flex-col items-center justify-center gap-3">
                <p className="text-[13px] text-muted-foreground">{detailError}</p>
                <button onClick={() => setDetail(null)}
                  className="h-9 px-3.5 rounded-lg border border-border bg-background text-[13px] font-semibold text-foreground/80 hover:bg-muted/50 transition-colors">
                  Back to Accounts
                </button>
              </div>
            : <div className="h-full flex items-center justify-center text-[13px] text-muted-foreground/70">Loading…</div>}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {showImport && <PeopleImportModal workspaceId={workspaceId} token={token} onClose={()=>setShowImport(false)} onDone={()=>{ setShowImport(false); refetch(); }}/>}

      {/* Delete confirmation — a real in-app dialog, not the browser's native confirm. */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => !bulkDeleting && setConfirmDelete(false)} />
          <div className="relative z-10 w-full max-w-[420px] rounded-2xl border border-border bg-background shadow-2xl p-6">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-red-500/10 text-red-500">
                <Trash2 className="h-4.5 w-4.5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[16px] font-semibold tracking-tight text-foreground">
                  Delete {selected.size} account{selected.size === 1 ? '' : 's'}?
                </h2>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                  This permanently removes them and everything Nous knows about them — claims,
                  activities, meetings, notes and scores. It can&apos;t be undone.
                </p>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={bulkDeleting}
                className="h-9 px-4 rounded-lg border border-border bg-background text-[13px] font-medium text-foreground/80 hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={doBulkDelete}
                disabled={bulkDeleting}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-red-500 text-white text-[13px] font-semibold hover:bg-red-600 transition-colors disabled:opacity-50"
              >
                {bulkDeleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete {selected.size}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="px-8 pt-7 flex-shrink-0">
        <PageHeader
          title={embedded ? "Accounts" : "People"}
          actions={
            <>
              <button onClick={handleExport}
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors">
                <Download className="h-3.5 w-3.5" /> Export
              </button>
              <button onClick={() => setShowImport(true)}
                data-tour="import-accounts"
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors">
                <Upload className="h-3.5 w-3.5" /> Import
              </button>
            </>
          }
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {leadingTab}
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70 pointer-events-none" />
              <input value={q} onChange={e=>handleSearch(e.target.value)} placeholder="Search people…" autoFocus
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus:border-foreground/40 outline-none" />
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end flex-shrink-0">
            {/* Active filter chips — one per active filter, removable. */}
            {pplFilters.map(f => (
              <span key={f.field} className="inline-flex items-center gap-1 h-8 pl-2.5 pr-1 rounded-md text-[12px] font-medium bg-foreground text-background capitalize">
                {pplLabel(f.field, f.value)}
                <button onClick={() => removePplFilter(f.field)} className="rounded p-0.5 hover:bg-background/20" aria-label="Remove filter"><X className="h-3 w-3" /></button>
              </span>
            ))}
            {/* Filter builder — same "Where <field> is <value>" pattern as the lead list. */}
            <div className="relative">
              <button onClick={() => setFilterOpen(o => !o)} title="Add a filter"
                className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[12px] font-medium border transition-colors ${
                  filterOpen ? "bg-muted border-border text-foreground" : "bg-background border-border text-muted-foreground hover:text-foreground"
                }`}>
                <Filter className="h-3.5 w-3.5" /> Filter
              </button>
              {filterOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setFilterOpen(false)} />
                  <div className="absolute right-0 top-9 z-30 w-72 rounded-lg border border-border bg-background shadow-xl p-3">
                    <div className="text-[11px] font-medium text-muted-foreground/70 mb-2">Add a filter</div>
                    <div className="flex items-center gap-1.5 text-[12px] mb-2">
                      <span className="text-muted-foreground">Where</span>
                      <select value={fbField} onChange={e => { setFbField(e.target.value); setFbValue(""); }}
                        className="h-8 flex-1 rounded-md border border-border bg-background text-[12px] text-foreground px-2 outline-none focus:border-foreground/40">
                        {PPL_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                      <span className="text-muted-foreground">is</span>
                    </div>
                    <select value={fbValue} onChange={e => setFbValue(e.target.value)}
                      className="h-8 w-full rounded-md border border-border bg-background text-[12px] text-foreground px-2 outline-none focus:border-foreground/40 capitalize">
                      <option value="">Select a value…</option>
                      {pplFieldDef.values.map(v => <option key={v.v} value={v.v}>{v.l}</option>)}
                    </select>
                    <button onClick={addPplFilter} disabled={!fbValue}
                      className="mt-3 w-full h-8 rounded-md bg-foreground text-background text-[12px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-30">
                      Add filter
                    </button>
                    {pplFilters.length > 0 && (
                      <button onClick={() => { setPplFilters([]); setPage(0); setFilterOpen(false); }}
                        className="mt-1.5 w-full h-8 rounded-md border border-border text-[12px] text-muted-foreground hover:text-foreground transition-colors">
                        Clear all filters
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            {selected.size > 0 && (() => {
              // If every selected row is already personal, the action flips to unmark —
              // so mark and unmark both live in this one bar. Mixed selection marks all.
              const allPersonal = contacts.filter(c => selected.has(c.id)).every(c => c.isPersonal);
              return (
                <button onClick={() => doBulkPersonal(!allPersonal)} disabled={bulkPersonaling || bulkDeleting}
                  title={allPersonal
                    ? "Unmark personal — count these as deals again"
                    : "Mark as personal/network — kept in the graph, excluded from deals"}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-semibold bg-background border border-border text-foreground/80 hover:bg-accent transition-colors disabled:opacity-50">
                  {bulkPersonaling && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  {allPersonal ? "Unmark personal" : "Mark personal"}
                </button>
              );
            })()}
            {selected.size > 0 && (() => {
              // Same pattern for team members — mark/unmark from the one bar.
              const allTeam = contacts.filter(c => selected.has(c.id)).every(c => c.isInternal);
              return (
                <button onClick={() => doBulkTeam(!allTeam)} disabled={bulkTeaming || bulkDeleting}
                  title={allTeam
                    ? "Unmark team member — count these as deals again"
                    : "Mark as team member — kept in the graph, excluded from deals"}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-semibold bg-background border border-border text-foreground/80 hover:bg-accent transition-colors disabled:opacity-50">
                  {bulkTeaming && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  {allTeam ? "Unmark team" : "Mark team"}
                </button>
              );
            })()}
            {selected.size > 0 && (
              <button onClick={() => setConfirmDelete(true)} disabled={bulkDeleting}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50">
                {bulkDeleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete {selected.size}
              </button>
            )}
            <span className="text-[12px] text-muted-foreground/70 ml-1 tabular-nums">{sorted.length} of {contacts.length}</span>
            {(() => {
              // Deal vs user counts. Team + personal are excluded; a paying customer is
              // `client`, a signup is a product user. So you always know the real numbers.
              const active = new Set(["identified", "aware", "connected", "interested", "evaluating"]);
              let pipeline = 0, clients = 0, users = 0;
              for (const c of contacts) {
                if (c.isInternal || c.isPersonal) continue;
                const s = (c.pipelineStage || "").toLowerCase();
                if (s === "client") clients++;
                else if (isProductUserStage(c.pipelineStage)) users++;
                else if (active.has(s)) pipeline++;
              }
              return (
                <span className="text-[12px] text-muted-foreground/50 tabular-nums hidden md:inline">
                  · {pipeline} in pipeline · {clients} client{clients === 1 ? "" : "s"} · {users} user{users === 1 ? "" : "s"}
                </span>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Table — full-bleed, fills to the right and bottom (left padding kept) */}
      <div className="flex-1 min-h-0 pl-8 flex flex-col">
        <div className="flex-1 min-h-0 border-t border-l border-border overflow-auto">
          <div style={{ minWidth: ROW_MIN }}>
          {/* Table header — sticky top; Name frozen left */}
          <div className="flex items-center px-4 py-2.5 bg-muted/50 border-b border-border sticky top-0 z-20">
            <div className="relative flex items-center flex-shrink-0 overflow-hidden sticky left-0 z-30 bg-muted/50" style={{width: colW("name")}}>
              <input
                type="checkbox"
                aria-label="Select all on this page"
                checked={pageRows.length > 0 && pageRows.every(c => selected.has(c.id))}
                onChange={() => setSelected(prev => {
                  const s = new Set(prev);
                  const all = pageRows.every(c => s.has(c.id));
                  pageRows.forEach(c => all ? s.delete(c.id) : s.add(c.id));
                  return s;
                })}
                className="mr-2 h-3.5 w-3.5 flex-shrink-0 accent-foreground cursor-pointer"
              />
              <span className="w-full min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">Name</span>
              <ColResizer onMouseDown={e=>startResize("name", e)} />
            </div>
            <PlainHdr label="Company" widthKey="company" />
            <PlainHdr label="Domain"  widthKey="domain" />
            <PlainHdr label="LI"      widthKey="li" />
            <PlainHdr label="Stage"   widthKey="stage" />
            <SortBtn  col="icp"  label="ICP"  firstDir="desc" />
            <SortBtn  col="tier" label="Tier" firstDir="desc" />
            <PlainHdr label="Intent"  widthKey="intent" />
            <SortBtnFlex col="lastActivity" label="Last Interaction" />
            <PlainHdr label="Source"  widthKey="source" />
            {/* Trailing filler — grows only on wide screens, shrinks to 0 (then the
                grid scrolls) so it never steals width from a column being resized. */}
            <div className="flex-1 min-w-0" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 flex-shrink-0 text-right" style={{width:78}}>Enrich</span>
          </div>
          {/* Rows */}
          {loading && contacts.length === 0 && <div className="text-[13px] text-muted-foreground/70 text-center py-12">Loading…</div>}
          {pageRows.map(c => (
            <div key={c.id} onMouseEnter={() => prefetchContact(c.id)} className="flex items-center px-4 py-3 border-b border-border/60 last:border-0 hover:bg-muted/50 transition-colors group">
              <div className="flex items-center flex-shrink-0 min-w-0 pr-3 sticky left-0 z-10 bg-background group-hover:bg-muted/50" style={{width:colW("name")}}>
                <input
                  type="checkbox"
                  aria-label={`Select ${c.name}`}
                  checked={selected.has(c.id)}
                  onChange={() => toggleSel(c.id)}
                  onClick={e => e.stopPropagation()}
                  className="mr-2 h-3.5 w-3.5 flex-shrink-0 accent-foreground cursor-pointer"
                />
                <button onClick={() => setDetail(c)} className="text-left min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <div className="text-[13px] font-medium text-foreground truncate">{c.name}</div>
                    {c.isInternal && (
                      <span className="flex-shrink-0 inline-flex items-center gap-1 h-4 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-orange-500/15 text-orange-600 border border-orange-500/25">
                        <Users className="h-2.5 w-2.5" /> Team
                      </span>
                    )}
                    {c.isPersonal && (
                      <span className="flex-shrink-0 inline-flex items-center h-4 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-muted text-muted-foreground/80 border border-border">
                        Personal
                      </span>
                    )}
                    {!c.isInternal && !c.isPersonal && isProductUserStage(c.pipelineStage) && (
                      <span className="flex-shrink-0 inline-flex items-center h-4 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-sky-500/15 text-sky-600 border border-sky-500/25">
                        User
                      </span>
                    )}
                  </div>
                  {c.title && <div className="text-[12px] text-muted-foreground/70 truncate">{c.title}</div>}
                </button>
              </div>
              <button onClick={() => setDetail(c)} className="text-[13px] text-muted-foreground truncate pr-2 flex-shrink-0 text-left" style={{width:colW("company")}}>{c.companyName ?? "—"}</button>
              <span className="text-[13px] text-muted-foreground/70 truncate pr-2 flex-shrink-0" style={{width:colW("domain")}}>{c.domain ?? "—"}</span>
              <div className="flex-shrink-0" style={{width:colW("li")}}>
                {c.linkedinUrl
                  ? <a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()}
                      className="text-muted-foreground/70 hover:text-foreground transition-colors flex items-center">
                      <Linkedin className="h-3.5 w-3.5" />
                    </a>
                  : <span className="text-muted-foreground/50 text-[12px]">—</span>
                }
              </div>
              <button onClick={() => setDetail(c)} className="text-[13px] pr-2 flex-shrink-0 text-left capitalize" style={{width:colW("stage"),color:stageColor(c.pipelineStage)}}>{c.pipelineStage}</button>
              <button onClick={() => setDetail(c)} className="text-[13px] text-muted-foreground pr-2 flex-shrink-0 text-left tabular-nums" style={{width:colW("icp")}}>{c.icpScore != null ? c.icpScore : "—"}</button>
              <button onClick={() => setDetail(c)} className="flex-shrink-0 pr-2 text-left" style={{width:colW("tier")}}>
                {(() => { const t = contactTier(c); return t
                  ? <span title={TIER_UI[t].play} className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${TIER_UI[t].bg}`}>{TIER_UI[t].label}</span>
                  : <span className="text-muted-foreground/50 text-[12px]">—</span>; })()}
              </button>
              <button onClick={() => setDetail(c)} className="flex-shrink-0 pr-2 text-left" style={{width:colW("intent")}}>
                {(() => { const b = c.intentBand; return b && b !== "Dormant"
                  ? <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${INTENT_TAG[b] ?? INTENT_TAG.Dormant}`}>{b}</span>
                  : <span className="text-muted-foreground/50 text-[12px]">—</span>; })()}
              </button>
              <button onClick={() => setDetail(c)} className="text-[13px] text-muted-foreground flex-shrink-0 truncate pr-2 text-left" style={{width:colW("lastActivity")}}>{relTime(c.lastActivityAt)}</button>
              <span className="text-[13px] text-muted-foreground/70 truncate pr-2 flex-shrink-0" style={{width:colW("source")}}>{sourceLabel(c.source)}</span>
              <div className="flex-1 min-w-0" />
              <div className="flex-shrink-0 flex items-center justify-end gap-2" style={{width:78}}>
                {enriched.has(c.id) ? (
                  <span className="text-[11px] text-emerald-600">enriched</span>
                ) : enrichErr.has(c.id) ? (
                  <span className="text-[11px] text-red-500">failed</span>
                ) : (
                  <button onClick={e => handleEnrich(c, e)} disabled={enriching.has(c.id)}
                    className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 flex items-center gap-0.5">
                    {enriching.has(c.id) ? <RefreshCw className="h-3 w-3 animate-spin"/> : <span>Enrich</span>}
                  </button>
                )}
                <button onClick={e => deleteContact(c.id, e)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-red-500 flex-shrink-0">
                  <Trash2 className="h-3.5 w-3.5"/>
                </button>
              </div>
            </div>
          ))}
          {!loading && sorted.length===0 && <div className="text-[13px] text-muted-foreground/70 text-center py-12">No results</div>}
          </div>
          </div>
        </div>

        {/* Pagination footer */}
        <div className="flex items-center justify-between px-8 py-2.5 border-t border-border flex-shrink-0">
          <span className="text-[12px] text-muted-foreground/70 tabular-nums">page {page+1} of {totalPages} · {sorted.length} people</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p=>p-1)} disabled={page===0}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors disabled:opacity-30">Prev</button>
            <button onClick={() => setPage(p=>p+1)} disabled={page>=totalPages-1}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-background border border-border text-foreground/80 text-[13px] font-semibold hover:bg-muted/50 transition-colors disabled:opacity-30">Next</button>
          </div>
        </div>
    </div>
  );
}
