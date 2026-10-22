import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Check, Linkedin, Trash2, RefreshCw, Search, Download, Upload, FileText, Filter, X, Users } from "lucide-react";
import { RowMenu } from "@/components/RowMenu";
import { useAuth } from "@/contexts/AuthContext";
import { relTime, eventTime, tierFromScore, TIER_UI, type IcpTier } from "@/components/mind/shared";
import { PeopleImportModal } from "@/components/contacts/PeopleImportModal";
import { ContactInfo, stageColor, ActivityIcon, DocIcon, mapContact } from "@/components/mind/entities";
import PersonDetailView from "@/components/PersonDetailView";
import { EntityAvatar } from "@/components/EntityAvatar";
import { LocationFilter } from "@/components/LocationFilter";
import { ApiTopBarFilter, useInApiShell } from "@/components/shell/ApiTopBar";
import { IcpScore, TierBars } from "@/components/account/TierBits";
import type { TierTab } from "@/components/account/apiAccountModel";
import { ViewTabs } from "@/components/ui/view-tabs";
import { cn } from "@/lib/utils";
import { when } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { RecordOverview } from "@/components/RecordOverview";
import { useTabs } from "@/contexts/TabsContext";
import { ALL_PIPELINE_STAGES, normalizeStage, stageLabel } from "@/config/pipeline";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
// How many people one "Load more" brings in. The list API caps a read at 200, and the page used to
// ask for 2,000, get 200, and then split THOSE into pages of 100 — so it said "page 1 of 2" on a
// workspace with 36,000 people, and nobody past the first 200 could be reached from the list.
const LOAD_SIZE = 200;
type PeoplePage = { rows: ContactInfo[]; total: number | null; applied: string | null; countries: { country: string; accounts: number }[] };
// The funnel, straight from the one definition. Never re-list stages here.
const PIPELINE_STAGES: readonly string[] = ALL_PIPELINE_STAGES;
// A "Free User" signup lands in a stage that is NOT one of the sales stages above.
// Those are product users, not deals: tagged, excluded from pipeline, counted separately.
// This asks normalizeStage rather than a set lookup because the DB still holds
// pre-funnel values: a row on `aware` or `client` is a real deal, and a bare set
// check would mislabel every one of them a product user.
// It must also NAME a user or a trial: other non-funnel values are not product users. A lead
// list writes `cold`, and every LinkedIn engager on one was tagged "User" (GET-820).
const isProductUserStage = (s?: string | null) => !!s && normalizeStage(s) === null && /\buser\b|\btrial\b/i.test(s);

// Intent band → pill classes (the "reach out now?" axis). Mirrors Lists.tsx.
const INTENT_TAG: Record<string, string> = {
  "Red-hot": "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400",
  Hot:       "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  Warm:      "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  Aware:     "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400",
  Dormant:   "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-500",
  // Client axis (won accounts, out of the buying funnel)
  Expansion:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  Active:     "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400",
  "At-risk":  "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400",
};

// Tier rank for sorting (best first). Mirrors the lead list.
const TIER_RANK: Record<IcpTier, number> = { tier_1: 4, tier_2: 3, tier_3: 2, not_icp: 1 };

// ─── Cold-email / outbound-reply rendering ────────────────────────────────────
// A reply to a cold-email or LinkedIn sequence is not a bare "email received" —
// it carries the campaign, the exact step/variant it answers, and an intent
// disposition. Render it like an email (subject as the headline) with that
// provenance as chips, so the timeline can drive feedback loops.
const OUTBOUND_SOURCES = ["instantly", "smartlead", "emailbison", "lemlist", "heyreach"];
const EMAIL_TYPE_LABELS: Record<string, string> = {
  email_received: "Replied", email_sent: "Sent", email_opened: "Opened", email_bounced: "Bounced",
};
// Instantly/HeyReach dispositions → the 3-way intent we surface. Mirrors
// replySignalToSentiment in @nous/core; kept here so the row can colour itself
// even before Phase 2 writes sentiment onto every reply.
const SIGNAL_SENTIMENT: Record<string, string> = {
  positive: "positive", negative: "negative", unsubscribe: "negative",
  do_not_contact: "negative", objection: "neutral", neutral: "neutral",
};
function intentChip(sentiment: string | null): { cls: string; label: string } | null {
  if (!sentiment) return null;
  if (sentiment === "positive") return { cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", label: "Positive" };
  if (sentiment === "negative") return { cls: "bg-red-500/10 text-red-600 dark:text-red-400", label: "Negative" };
  return { cls: "bg-muted text-muted-foreground/80", label: "Neutral" };
}
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

  // Cold-email tools are email channels too — their replies land as
  // source=instantly (etc.) + type=email_received, which matches neither the gmail
  // source nor the type list, so without this the actual reply was invisible in Emails.
  const COLD_EMAIL_SOURCES = ["instantly", "smartlead", "emailbison", "lemlist"];
  const emails  = acts.filter(a => a.source === "gmail" || COLD_EMAIL_SOURCES.includes(a.source) || ["email_sent","email_opened","email_reply","email_received","email_bounced"].some(t => a.activity_type?.includes(t)));
  // HeyReach is LinkedIn automation — its replies belong in the LinkedIn tab.
  const linkedin = acts.filter(a => a.source === "linkedin" || a.source === "heyreach" || a.activity_type?.includes("linkedin"));
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

  if (loading && !data) return (
    <div className="flex h-full bg-background">
      <div className="w-[320px] flex-shrink-0 border-r border-border/60 px-6 py-6">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center text-[16px] font-semibold text-muted-foreground/70 mb-2.5">
          {(contact.name || "?").split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}
        </div>
        <h1 className="text-[19px] font-semibold tracking-tight text-foreground">{contact.name || "Contact"}</h1>
      </div>
      <div className="flex-1 flex items-center justify-center text-[13px] text-muted-foreground/50">Loading…</div>
    </div>
  );
  return <PersonDetailView data={data} onOpenCompany={(cid) => navigate(`/accounts/${cid}`)} />;
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
  const { openTab } = useTabs();
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
  // Search runs on the server: the loaded rows are only the newest few hundred, so filtering them in
  // the browser would say "No results" for anyone who hasn't been in touch lately.
  const [q, setQ] = useState("");
  const [serverQ, setServerQ] = useState("");
  // The market this list is showing, remembered per workspace. Same control and same rule as the
  // Accounts list: a person is in the market their employer is in (GET-312).
  const countryKey = `nous.people.country.${workspaceId}`;
  const [country, setCountry] = useState<string | undefined>(() => {
    try { return localStorage.getItem(countryKey) ?? undefined; } catch { return undefined; }
  });
  useEffect(() => {
    try { setCountry(localStorage.getItem(countryKey) ?? undefined); } catch { setCountry(undefined); }
  }, [countryKey]);
  const chooseCountry = (v: string) => {
    setCountry(v);
    try { localStorage.setItem(countryKey, v); } catch { /* a filter that forgets is still a filter */ }
  };
  useEffect(() => { const t = setTimeout(() => setServerQ(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  // Newest activity first, LOAD_SIZE at a time. The server orders the whole list (not just what is
  // loaded), so "Load more" always continues the same order instead of reshuffling.
  const peopleQuery = useInfiniteQuery({
    queryKey: [...contactsKey, serverQ, country ?? "__ws_default__"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<PeoplePage> => {
      const params = new URLSearchParams({ workspaceId, limit: String(LOAD_SIZE), offset: String(pageParam), include_team: "1" });
      if (serverQ) params.set("search", serverQ);
      if (country) params.set("country", country);
      const res = await fetch(`${apiUrl}/api/contacts?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = res.ok ? await res.json() : {};
      return {
        rows: ((data.contacts ?? []) as any[]).map(mapContact) as ContactInfo[],
        total: typeof data.total === "number" ? data.total : null,
        applied: (data.country ?? null) as string | null,
        countries: (Array.isArray(data.countries) ? data.countries : []) as { country: string; accounts: number }[],
      };
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      // With a total, stop exactly at it; without one (older list path), stop at a short page.
      if (last.total != null) return loaded < last.total ? loaded : undefined;
      return last.rows.length === LOAD_SIZE ? loaded : undefined;
    },
    enabled: !!token && !!workspaceId,
  });
  const { isPending: loading, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = peopleQuery;
  const contacts = useMemo(() => peopleQuery.data?.pages.flatMap(p => p.rows) ?? [], [peopleQuery.data]);
  const totalPeople = peopleQuery.data?.pages[0]?.total ?? null;
  // What the server filtered by — before anyone picks, that is the workspace's own focus.
  const appliedCountry = peopleQuery.data?.pages[0]?.applied ?? null;
  const countryOptions = peopleQuery.data?.pages[0]?.countries ?? [];

  // Optimistic edits apply to every loaded page, whatever search they were loaded under.
  const updateLoaded = useCallback((fn: (rows: ContactInfo[]) => ContactInfo[]) => {
    queryClient.setQueriesData<InfiniteData<PeoplePage>>({ queryKey: contactsKey }, (prev) =>
      prev ? { ...prev, pages: prev.pages.map(p => ({ ...p, rows: fn(p.rows) })) } : prev);
  }, [queryClient, contactsKey]);

  // The active-vs-total counter that used to sit in the footer is gone with it: the list itself now
  // says "showing 200 of 36,282", and that counter was a second request every 20 seconds saying a
  // near-identical thing.

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

  // One filter builder (same pattern as the lead list) — every filter is a
  // "Where <field> is <value>" row; multiple stack. Persisted per workspace.
  const [pplFilters, setPplFilters] = useState<{ field: string; value: string }[]>(() => {
    try { const v = localStorage.getItem("nous.people.filters"); return v ? JSON.parse(v) : []; }
    catch { return []; }
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [fbField, setFbField] = useState("stage");
  const [fbValue, setFbValue] = useState("");
  const [sortCol, setSortCol] = useState<"lastActivity"|"icp"|"tier"|null>(null);
  const [tab, setTab] = useState<TierTab>("all");
  const inApiShell = useInApiShell();
  const [sortDir, setSortDir] = useState<"asc"|"desc">("asc");
  useEffect(() => { try { localStorage.setItem("nous.people.filters", JSON.stringify(pplFilters)); } catch { /* ignore */ } }, [pplFilters]);
  const [showImport, setShowImport] = useState(false);
  // Header controls (Granola-style): a search icon that expands to an input, and an
  // Everyone / People-I-met toggle. "Met" narrows to contacts with real interaction.
  const [searchOpen, setSearchOpen] = useState(false);
  const [peopleView, setPeopleView] = useState<"everyone" | "met">("everyone");
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
  // Name the workspace tab after the person, not a generic "Person" — openTab refreshes
  // the title of the tab the router already opened for this /people/:id path, so an open
  // record reads as "Tobin Marsh" up top. Only on the standalone route (not embedded in
  // the Accounts list, which owns its own tab).
  useEffect(() => {
    if (!embedded && id && detail?.name) openTab(location.pathname, detail.name);
  }, [embedded, id, detail?.name, location.pathname, openTab]);
  // Back goes to wherever you came from (e.g. the lead list), not always Accounts.
  const setDetail = (c: ContactInfo | null) => {
    if (c && onOpen) { onOpen({ id: c.id, name: c.name || "Account" }); return; }
    navigate(c ? `/people/${c.id}` : ((location.state as { from?: string } | null)?.from || "/people"));
  };

  const deleteContact = async (cid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    updateLoaded(rows => rows.filter(c => c.id !== cid));
    fetch(`${apiUrl}/api/contacts/${cid}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  };

  // Single-row kebab actions — the same three moves as the multi-select toolbar.
  const deleteContactRow = (cid: string) => {
    updateLoaded(rows => rows.filter(c => c.id !== cid));
    fetch(`${apiUrl}/api/contacts/${cid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  };
  const markContactClientRow = async (cid: string) => {
    await fetch(`${apiUrl}/api/contacts/${cid}/mark-client`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: contactsKey });
  };
  const markContactPersonalRow = async (cid: string) => {
    await fetch(`${apiUrl}/api/contacts/${cid}/personal`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ personal: true }) }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: contactsKey });
  };

  // Multi-select delete. The delete cascades server-side — every claim, activity,
  // score and identifier for the account goes with it — so a re-import starts clean.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkPersonaling, setBulkPersonaling] = useState(false);
  const [bulkTeaming, setBulkTeaming] = useState(false);
  const [bulkClienting, setBulkClienting] = useState(false);
  const toggleSel = (cid: string) => setSelected(prev => {
    const s = new Set(prev); s.has(cid) ? s.delete(cid) : s.add(cid); return s;
  });
  const doBulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkDeleting(true);
    updateLoaded(rows => rows.filter(c => !selected.has(c.id)));
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
    updateLoaded(rows => rows.map(c => selected.has(c.id) ? { ...c, isPersonal: on } : c));
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
    updateLoaded(rows => rows.map(c => selected.has(c.id) ? { ...c, isInternal: on } : c));
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

  // Multi-select mark-client. Marks each selected contact — and their company — a
  // client (a won deal): pipeline stage flips to `closed_won` and the Mind learns
  // the win. The optimistic row writes the new stage name, never the old `client`.
  const doBulkClient = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkClienting(true);
    updateLoaded(rows => rows.map(c => selected.has(c.id) ? { ...c, stage: "closed_won", pipelineStage: "closed_won" } : c));
    try {
      await fetch(`${apiUrl}/api/contacts/bulk-client`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ids }),
      });
    } catch { /* optimistic; refetch reconciles */ }
    setSelected(new Set());
    setBulkClienting(false);
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
    else { setSortCol(null); }
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
    // Matches on the normalized stage, not the raw column: until the DB is
    // migrated a row can still say `evaluating`, and filtering on "Interested"
    // has to find it.
    { key: "stage", label: "Stage", values: PIPELINE_STAGES.map(s => ({ v: s, l: stageLabel(s) })), match: (c, v) => normalizeStage(c.pipelineStage) === v },
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
    setFbValue(""); setFilterOpen(false);
  };
  const removePplFilter = (field: string) => { setPplFilters(prev => prev.filter(f => f.field !== field)); };

  const filtered = contacts.filter(c => {
    const qs = q.toLowerCase();
    // While the typed query is still debouncing, narrow what is already loaded so typing feels instant;
    // once the server has answered, its rows are the result.
    if (q.trim() !== serverQ && q && !(c.name.toLowerCase().includes(qs) || (c.email??"").toLowerCase().includes(qs) || (c.companyName??"").toLowerCase().includes(qs))) return false;
    // "People I met" narrows to contacts you've actually interacted with (have activity).
    if (peopleView === "met" && !c.lastActivityAt) return false;
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
  const handleSearch = (v: string) => { setQ(v); };

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

  // The tier tabs, counted over what is loaded (the Accounts list does the same).
  const tierTab = (c: ContactInfo): TierTab => {
    const t = contactTier(c);
    return t === "tier_1" ? "t1" : t === "tier_2" ? "t2" : t === "tier_3" ? "t3" : "all";
  };
  const counts = { all: sorted.length, t1: 0, t2: 0, t3: 0 } as Record<TierTab, number>;
  for (const c of sorted) { const t = tierTab(c); if (t !== "all") counts[t]++; }
  const tiers = counts.t1 + counts.t2 + counts.t3 > 0;
  const activeTab: TierTab = tiers ? tab : "all";
  const shown = activeTab === "all" ? sorted : sorted.filter(c => tierTab(c) === activeTab);
  const more = hasNextPage ? "+" : "";
  const tabLabel = (t: string, n: number) => <>{t}<span className="font-normal tabular-nums text-muted-foreground">{n.toLocaleString()}{more}</span></>;
  const arrow = (col: "lastActivity" | "icp" | "tier") =>
    sortCol === col ? <span className="ml-0.5 text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span> : null;
  const sortTh = (col: "lastActivity" | "icp" | "tier", label: string, firstDir: "asc" | "desc", className?: string) => (
    <th className={className} aria-sort={sortCol === col ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
      <button onClick={() => cycleSort(col, firstDir)} className={cn("inline-flex items-center transition-colors hover:text-foreground", sortCol === col && "text-foreground")}>
        {label}{arrow(col)}
      </button>
    </th>
  );
  const tag = (c: ContactInfo) =>
    c.isInternal ? "Team" : c.isPersonal ? "Network" : c.productUser || isProductUserStage(c.pipelineStage) ? "User" : c.notInCrm ? "Not in CRM" : null;
  const locationRows = [{ country: "all", label: "All locations", accounts: null as number | null }, ...countryOptions.map(o => ({ ...o, label: o.country }))];

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {showImport && <PeopleImportModal workspaceId={workspaceId} token={token} onClose={()=>setShowImport(false)} onDone={()=>{ setShowImport(false); refetch(); }}/>}

      {inApiShell && countryOptions.length > 0 && (
        <ApiTopBarFilter active={appliedCountry ? 1 : 0}>
          <div className="px-3 pb-1.5 pt-2 text-[11.5px] font-medium text-muted-foreground">Location</div>
          {locationRows.map(o => {
            const on = o.country === "all" ? !appliedCountry : appliedCountry === o.country;
            return (
              <button key={o.country} onClick={() => chooseCountry(o.country)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-foreground/85 transition-colors hover:bg-hover">
                <Check className={cn("h-3.5 w-3.5 flex-shrink-0", on ? "text-foreground" : "opacity-0")} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.accounts != null && <span className="text-[12px] tabular-nums text-muted-foreground">{o.accounts.toLocaleString()}</span>}
              </button>
            );
          })}
        </ApiTopBarFilter>
      )}

      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        {leadingTab}
        {tiers && (
          <ViewTabs<TierTab>
            aria-label="People views"
            value={activeTab}
            onChange={setTab}
            options={[
              { value: "all", label: <>All <span className="font-normal tabular-nums text-muted-foreground">{(totalPeople ?? counts.all).toLocaleString()}</span></> },
              { value: "t1", icon: <TierBars tier={1} />, label: tabLabel("Tier 1", counts.t1) },
              { value: "t2", icon: <TierBars tier={2} />, label: tabLabel("Tier 2", counts.t2) },
              { value: "t3", icon: <TierBars tier={3} />, label: tabLabel("Tier 3", counts.t3) },
            ]}
          />
        )}
        <span className="flex-1" />
        {!inApiShell && <LocationFilter applied={appliedCountry} options={countryOptions} onChange={chooseCountry} />}
        <label className="relative flex h-7 w-full items-center sm:w-[200px]">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="search" value={q} onChange={e => handleSearch(e.target.value)}
            placeholder="Search people" aria-label="Search people"
            className="h-7 w-full rounded-lg border border-border bg-card pl-8 pr-7 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-foreground/30 [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button onClick={() => handleSearch("")} aria-label="Clear search" className="absolute right-2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[860px] border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="[&>th]:h-[34px] [&>th]:whitespace-nowrap [&>th]:border-b [&>th]:border-border [&>th]:px-3 [&>th]:text-left [&>th]:text-[12px] [&>th]:font-medium [&>th]:text-muted-foreground">
              <th className="w-[32%] !pl-5">Person</th>
              <th className="w-[24%]">Company</th>
              {sortTh("icp", "ICP", "desc")}
              {tiers && sortTh("tier", "Tier", "desc")}
              {sortTh("lastActivity", "Last activity", "asc")}
              <th className="w-10 !pr-4" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {shown.map(c => {
              const t = contactTier(c);
              const tier = t === "tier_1" ? 1 : t === "tier_2" ? 2 : t === "tier_3" ? 3 : null;
              const label = tag(c);
              return (
                <tr key={c.id} tabIndex={0} onClick={() => setDetail(c)} onMouseEnter={() => prefetchContact(c.id)}
                  onKeyDown={e => { if (e.key === "Enter" && e.target === e.currentTarget) setDetail(c); }}
                  className="group cursor-pointer outline-none transition-colors hover:bg-hover focus-visible:bg-hover [&>td]:h-12 [&>td]:whitespace-nowrap [&>td]:border-b [&>td]:border-hairline [&>td]:px-3">
                  <td className="max-w-0 !pl-5">
                    <span className="flex min-w-0 items-center gap-2.5">
                      {/* Their face when one exists: photo from the CRM, else Gravatar (the email is
                          SHA-256 hashed, never sent in clear), else initials. */}
                      <EntityAvatar kind="person" name={c.name} email={c.email} photoUrl={c.photo}
                        className="h-[22px] w-[22px] flex-shrink-0 rounded-full" textClassName="text-[9px] font-semibold text-ink-2" />
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium text-foreground">{c.name}</span>
                          {label && <span className="flex-shrink-0 text-[11.5px] text-muted-foreground">{label}</span>}
                        </span>
                        {c.title && <span className="truncate text-[11.5px] text-muted-foreground">{c.title}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="max-w-0">
                    {c.companyName ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <EntityAvatar kind="company" name={c.companyName} domain={c.domain}
                          className="h-4 w-4 flex-shrink-0 rounded" textClassName="text-[8px] font-semibold" />
                        {c.companyId ? (
                          <button onClick={e => { e.stopPropagation(); navigate(`/accounts/${c.companyId}`); }}
                            title={`Open ${c.companyName}`}
                            className="truncate text-left text-foreground/85 underline-offset-2 hover:text-foreground hover:underline">
                            {c.companyName}
                          </button>
                        ) : <span className="truncate text-foreground/85">{c.companyName}</span>}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td><IcpScore score={c.icpScore} /></td>
                  {tiers && (
                    <td>
                      {tier
                        ? <span className="inline-flex items-center gap-[7px] text-[12.5px]"><TierBars tier={tier} />Tier {tier}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                  )}
                  <td className="text-muted-foreground">{c.lastActivityAt ? when(c.lastActivityAt) : "—"}</td>
                  <td className="!pr-4 text-right" onClick={e => e.stopPropagation()}>
                    <RowMenu onMarkClient={() => markContactClientRow(c.id)} onMarkPersonal={() => markContactPersonalRow(c.id)} onDelete={() => deleteContactRow(c.id)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && contacts.length === 0 && <div className="py-12 text-center text-[13px] text-muted-foreground">Loading…</div>}
        {!loading && shown.length === 0 && (
          <div className="py-12 text-center text-[13px] text-muted-foreground">
            {serverQ ? "No people match" : activeTab !== "all" ? "No people in this tier" : "No people yet"}
          </div>
        )}
      </div>

      {contacts.length > 0 && (
        <div className="flex h-11 flex-shrink-0 items-center gap-2 border-t border-hairline px-5 text-[12px] text-muted-foreground">
          <span className="tabular-nums">
            {shown.length.toLocaleString()} of {activeTab === "all" ? (totalPeople ?? contacts.length).toLocaleString() : `${counts[activeTab].toLocaleString()}${more}`}
          </span>
          <span className="flex-1" />
          {hasNextPage && (
            <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}
              className="inline-flex h-7 items-center rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors hover:bg-hover disabled:opacity-50">
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
