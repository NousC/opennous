// Docs data: the shapes /api/docs returns and the hooks that fetch them (GET-197).
//
// The server decides where a document is filed (packages/core/src/db/documents.ts); this side
// only draws what it is handed, so the tree can never disagree with the document.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import type { ReportSection } from "@/components/ReportBlocks";
import { freshAccessToken } from "@/lib/freshToken";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type DocKind = "account_summary" | "call_summary" | "call_score" | "brief" | "plan" | "report" | "meeting_brief" | "objection_prep" | "call" | "brain_page";
export type DocCadence = "weekly" | "monthly" | "quarterly" | "one_off";

export type EntityLabel = {
  id: string;
  type: "person" | "company" | "deal" | "workspace";
  name: string | null;
  domain: string | null;
  email: string | null;
  title: string | null;
  photo_url?: string | null;
};

export type DocSummary = {
  id: string;
  kind: DocKind;
  series: string | null;
  cadence: DocCadence | null;
  title: string;
  headline: string | null;
  subject_entity_id: string | null;
  period_start: string | null;
  period_end: string | null;
  skill: string | null;
  version: number;
  status: "live" | "superseded" | "deleted";
  word_count: number;
  created_at: string;
  updated_at: string;
};

export type DocRow = DocSummary & {
  sections: ReportSection[];
  body_md: string;
  content_hash: string | null;
  generated_from: string[];
  author_user_id: string | null;
  written_by: string;
  supersedes_id: string | null;
};

export type DocSource = {
  ordinal: number;
  cite_key: string | null;
  ref: string;
  system: string;
  detail: string | null;
  occurred_at: string | null;
  quote: string | null;
  speaker: string | null;
  evidence_kind: string | null;
  derived: boolean;
  cited: boolean;
  section_indexes: number[];
};

export type DocDetail = {
  document: DocRow;
  subject: EntityLabel | null;
  sources: DocSource[];
  mentions: EntityLabel[];
  outgoing: DocSummary[];
  backlinks: DocSummary[];
  versions: { id: string; version: number; status: string; created_at: string; title: string }[];
  related: DocSummary[];
  chunks: number;
  can_manage: boolean;
};

export type DocTree = {
  // `calls` is optional so a tree from an API that predates call pages still renders.
  accounts: { entity: EntityLabel; documents: DocSummary[]; calls?: DocSummary[]; people: { entity: EntityLabel; documents: DocSummary[] }[] }[];
  reports: Record<DocCadence, DocSummary[]>;
  other: DocSummary[];
};

export type DocSearchHit = {
  document: DocSummary;
  section_index: number;
  heading: string | null;
  snippet: string;
  score: number;
  ref: string;
  subject: EntityLabel | null;
};

export const KIND_LABEL: Record<DocKind, string> = {
  brief: "Brief",
  plan: "Account plan",
  report: "Report",
  meeting_brief: "Meeting brief",
  objection_prep: "Objection prep",
  call: "Call",
  // The three an automation writes (GET-426). A chip reading "account_summary" is the
  // column name leaking onto the page.
  account_summary: "Account summary",
  call_summary: "Call summary",
  call_score: "Call score",
  // A GTM brain page (GET-431). Search can surface one; it lives at /brain/gtm/<path>.
  brain_page: "Brain page",
};

export const CADENCE_LABEL: Record<DocCadence, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  one_off: "One-off",
};

export const SERIES_LABEL: Record<string, string> = {
  pipeline: "Pipeline",
  forecast: "Forecast",
  win_loss: "Win/loss",
  market_read: "Market read",
  team: "Team",
  role: "Role",
  changes: "What changed",
};

function useApi() {
  const { session, userData } = useAuth();
  const token = session?.access_token;
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id ?? "";
  const call = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const sep = path.includes("?") ? "&" : "?";
    // MINT THE TOKEN AT THE MOMENT OF THE CALL. session.access_token is a React mirror
    // refreshed on a 30s interval, and a background tab has its timers throttled to a
    // minute or worse — so a tab left open returns a token Clerk rotated out, and the
    // request comes back 401 invalid_token. freshAccessToken() asks Clerk directly.
    const fresh = (await freshAccessToken()) ?? token;
    const r = await fetch(`${apiUrl}${path}${sep}workspaceId=${encodeURIComponent(workspaceId)}`, {
      ...init,
      headers: { Authorization: `Bearer ${fresh}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!r.ok) throw Object.assign(new Error(`docs_${r.status}`), { status: r.status });
    return r.json();
  };
  return { call, ready: Boolean(token && workspaceId), workspaceId, token };
}

export function useDocTree() {
  const { call, ready, workspaceId } = useApi();
  return useQuery({
    queryKey: ["docs", "tree", workspaceId] as const,
    enabled: ready,
    queryFn: async () => (await call<{ tree: DocTree }>("/api/docs/tree")).tree,
    staleTime: 30_000,
  });
}

export function useDoc(id: string | null) {
  const { call, ready, workspaceId } = useApi();
  return useQuery({
    queryKey: ["docs", "doc", workspaceId, id] as const,
    enabled: ready && Boolean(id),
    queryFn: () => call<DocDetail>(`/api/docs/${id}`),
    retry: (count, err) => (err as { status?: number })?.status !== 404 && count < 2,
  });
}

export function useDocSearch(q: string) {
  const { call, ready, workspaceId } = useApi();
  const query = q.trim();
  return useQuery({
    queryKey: ["docs", "search", workspaceId, query] as const,
    enabled: ready && query.length >= 2,
    queryFn: async () => (await call<{ results: DocSearchHit[] }>(`/api/docs/search?q=${encodeURIComponent(query)}`)).results,
    staleTime: 60_000,
  });
}

/** The documents about one account, for its account page. */
export function useAccountDocs(entityId: string | null | undefined) {
  const { call, ready, workspaceId } = useApi();
  return useQuery({
    queryKey: ["docs", "account", workspaceId, entityId] as const,
    enabled: ready && Boolean(entityId),
    queryFn: async () => (await call<{ docs: DocSummary[] }>(`/api/docs?subject=${entityId}`)).docs,
  });
}

export function useDocMutations() {
  const { call, workspaceId } = useApi();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["docs"] });
  return {
    workspaceId,
    rename: async (id: string, title: string) => {
      await call(`/api/docs/${id}`, { method: "PATCH", body: JSON.stringify({ title, workspaceId }) });
      await refresh();
    },
    /** Correct one section's text. Prose only — a section of blocks refuses (GET-426). */
    editSection: async (id: string, section: number, body: string) => {
      await call(`/api/docs/${id}`, { method: "PATCH", body: JSON.stringify({ section, body, workspaceId }) });
      await refresh();
    },
    remove: async (id: string) => {
      await call(`/api/docs/${id}`, { method: "DELETE" });
      await refresh();
    },
  };
}

// ── Display helpers ──────────────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The name a document goes by INSIDE a folder that already names its account. "Brief — Harborline"
 * under the Harborline folder is the account said twice; "Brief" is the document.
 */
export function shortTitle(doc: Pick<DocSummary, "title" | "kind">, accountName?: string | null): string {
  let t = String(doc.title ?? "").trim();
  if (accountName) {
    const esc = accountName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`\\s*[—–-]\\s*${esc}\\s*$`, "i"), "").replace(new RegExp(`^${esc}\\s*[—–-]\\s*`, "i"), "").trim();
  }
  if (!t || UUID_RE.test(t) || (accountName && t.toLowerCase() === accountName.toLowerCase())) return KIND_LABEL[doc.kind];
  return t;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : fullFmt.format(d);
}

export function fmtFull(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/**
 * The date a document speaks for. A call is dated by the CALL, not by the day we wrote the page —
 * a backfilled September 2025 call written today must not read "Sep 16, 2026" in every list.
 */
export function docDate(doc: Pick<DocSummary, "kind" | "period_start" | "created_at">): string {
  return (doc.kind === "call" && doc.period_start) ? doc.period_start : doc.created_at;
}

export function fmtPeriod(doc: Pick<DocSummary, "period_start" | "period_end">): string | null {
  if (!doc.period_start || !doc.period_end) return null;
  return `${fullFmt.format(new Date(doc.period_start))} – ${fullFmt.format(new Date(doc.period_end))}`;
}

/**
 * The NAME of each source — the meeting title, the email subject — the same way the chat's
 * source panel names its rows. /api/evidence/detail takes twelve refs per call, so a document
 * citing thirty sources asks in batches rather than naming only the first twelve.
 */
/** The part of /api/evidence/detail a row needs. */
type EvidenceDetailData = { title?: string | null; transcript?: boolean };

export function useEvidenceTitles(refs: string[]) {
  const { call, ready, workspaceId } = useApi();
  const unique = [...new Set(refs.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["docs", "evidence-titles", workspaceId, unique.join("|")] as const,
    enabled: ready && unique.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const out: Record<string, EvidenceDetailData> = {};
      const batches: string[][] = [];
      for (let i = 0; i < unique.length; i += 12) batches.push(unique.slice(i, i + 12));
      await Promise.all(batches.map(async batch => {
        try {
          const r = await call<{ details?: Record<string, EvidenceDetailData> }>("/api/evidence/detail", {
            method: "POST",
            body: JSON.stringify({ workspaceId, refs: batch.map(ref => ({ ref })) }),
          });
          Object.assign(out, r.details ?? {});
        } catch { /* a batch that fails leaves its rows named by kind */ }
      }));
      return out;
    },
  });
}
