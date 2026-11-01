// Documents — what the agent writes for the operator, as objects a person files and an agent
// retrieves (GET-197). Schema: supabase/migrations/2026_09_13_documents.sql.
//
// ⚠️ ONE PLACE FOR EVERY RULE ABOUT A DOCUMENT. The Edda wiki this is modelled on shipped with
// its write path building page paths one way and its read path another, so "Outgoing links"
// read 0 on every nested page and nothing complained. The same shape bit this repo six times
// in one day (see the two-places-one-rule note in AGENTS memory). So: how a document is
// flattened to text, which folder a report lives in, what its ref looks like, how it is
// chunked, which version it replaces, which sources it cites — each is ONE function here, and
// the API, the agent tools, the backfill and the tree all call it rather than re-deriving.

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedBatch, embed } from '../embed.js';
import { citeKey } from '../evidenceDetail.js';

// The three ARTIFACTS an automation produces (GET-426) join the kinds the agent already
// writes. They live here rather than in a table of their own because a generated summary is a
// document in every way that matters — it has a subject, a period, sections, sources and
// versions — and giving it a second home would mean two answers to "what has been written
// about this account", which is the shape of bug this file exists to prevent.
export type DocumentKind =
  | 'brief' | 'plan' | 'report' | 'meeting_brief' | 'objection_prep' | 'call'
  | 'account_summary' | 'call_summary' | 'call_score'
  // A written page in a brain (GET-431), filed by `brain_id` + `brain_path` — see db/brains.ts.
  | 'brain_page';
export type DocumentCadence = 'weekly' | 'monthly' | 'quarterly' | 'one_off';
export type DocumentStatus = 'live' | 'superseded' | 'deleted';

export const DOCUMENT_KINDS: DocumentKind[] = [
  'brief', 'plan', 'report', 'meeting_brief', 'objection_prep', 'call',
  'account_summary', 'call_summary', 'call_score', 'brain_page',
];

/** What a person calls this kind. The feed heads every row with it. */
export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  brief: 'Brief', plan: 'Plan', report: 'Report', meeting_brief: 'Meeting brief',
  objection_prep: 'Objection prep', call: 'Call notes',
  account_summary: 'Account summary', call_summary: 'Call summary', call_score: 'Call score',
  brain_page: 'Brain page',
};

export interface DocumentBlock { type: string; [k: string]: unknown }
export interface DocumentSection { label: string; body?: string; blocks?: DocumentBlock[] }

export interface DocumentSourceInput {
  system: string;
  ref: string;
  detail?: string | null;
  when?: string | null;
  quote?: string | null;
  speaker?: string | null;
  kind?: string | null;
  derived?: boolean;
}

export interface DocumentSummary {
  id: string;
  kind: DocumentKind;
  series: string | null;
  cadence: DocumentCadence | null;
  title: string;
  headline: string | null;
  subject_entity_id: string | null;
  period_start: string | null;
  period_end: string | null;
  skill: string | null;
  version: number;
  status: DocumentStatus;
  word_count: number;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow extends DocumentSummary {
  workspace_id: string;
  sections: DocumentSection[];
  body_md: string;
  content_hash: string | null;
  generated_from: string[];
  author_user_id: string | null;
  thread_id: string | null;
  written_by: string;
  supersedes_id: string | null;
  legacy_claim_id: string | null;
  deleted_at: string | null;
}

const SUMMARY_COLS = 'id, kind, series, cadence, title, headline, subject_entity_id, period_start, period_end, skill, version, status, word_count, created_at, updated_at';
const ROW_COLS = `${SUMMARY_COLS}, workspace_id, sections, body_md, content_hash, generated_from, author_user_id, thread_id, written_by, supersedes_id, legacy_claim_id, deleted_at`;

// ── Refs ─────────────────────────────────────────────────────────────────────
//
// A document is a SOURCE too: an answer can cite last month's pipeline report, and the chip
// opens it at the section that said so. The ref is the only identity a citation carries, so
// it is built and parsed here and nowhere else.

const DOC_REF_RE = /^nous:\/\/doc\/([0-9a-f-]{36})(?:#s(\d+))?$/i;

export function documentRef(documentId: string, sectionIndex?: number | null): string {
  return sectionIndex == null ? `nous://doc/${documentId}` : `nous://doc/${documentId}#s${sectionIndex}`;
}

export function parseDocumentRef(ref: string | null | undefined): { documentId: string; sectionIndex: number | null } | null {
  const m = DOC_REF_RE.exec(String(ref ?? '').trim());
  return m ? { documentId: m[1].toLowerCase(), sectionIndex: m[2] != null ? Number(m[2]) : null } : null;
}

const ACCOUNT_REF_RE = /^nous:\/\/account\/([0-9a-f-]{36})$/i;
function accountIdFromRef(ref: string): string | null {
  const m = ACCOUNT_REF_RE.exec(ref.trim());
  return m ? m[1].toLowerCase() : null;
}

// ── Period and cadence ───────────────────────────────────────────────────────
//
// The folder a report lives in — Weekly, Monthly, Quarterly, One-off — is decided by the
// length of the window it covers, once, when it is written. A 30-day read is monthly whether
// the title says "September" or "last 30 days".

const DAY = 86_400_000;

export function documentCadence(kind: DocumentKind, periodStart?: string | null, periodEnd?: string | null): DocumentCadence | null {
  if (kind !== 'report') return null;
  if (!periodStart || !periodEnd) return 'one_off';
  const days = (Date.parse(periodEnd) - Date.parse(periodStart)) / DAY;
  if (!Number.isFinite(days) || days <= 0) return 'one_off';
  if (days <= 9) return 'weekly';
  if (days >= 26 && days <= 35) return 'monthly';
  if (days >= 84 && days <= 96) return 'quarterly';
  return 'one_off';
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fourteen: 14, thirty: 30, sixty: 60, ninety: 90,
};

/**
 * The window a document's title names, for documents written before the period was a field.
 * "last 30 days", "last six months", "this quarter", "weekly". Null when the title names no
 * window — a guess would file a report in the wrong folder, which is worse than One-off.
 */
export function inferPeriodFromTitle(title: string, writtenAt: string): { start: string; end: string } | null {
  const t = String(title ?? '').toLowerCase();
  const end = new Date(writtenAt);
  if (!Number.isFinite(end.getTime())) return null;
  const back = (days: number) => ({ start: new Date(end.getTime() - days * DAY).toISOString(), end: end.toISOString() });
  const m = /\b(?:last|past|trailing)\s+(\d+|[a-z]+)\s+(day|week|month|quarter)s?\b/.exec(t);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
    if (n) return back(n * ({ day: 1, week: 7, month: 30, quarter: 91 } as const)[m[2] as 'day' | 'week' | 'month' | 'quarter']);
  }
  if (/\b(?:this|last|past)\s+week\b|\bweekly\b/.test(t)) return back(7);
  if (/\b(?:this|last|past)\s+month\b|\bmonthly\b/.test(t)) return back(30);
  if (/\b(?:this|last|past)\s+quarter\b|\bquarterly\b|\bq[1-4]\b/.test(t)) return back(91);
  return null;
}

// A skill is the most reliable signal of WHICH recurring document a report is. Keyed by the
// skill names in plugin-skills.json.
const SERIES_BY_SKILL: Record<string, string> = {
  'revenue-report': 'pipeline',
  'review-pipeline': 'pipeline',
  'forecast': 'forecast',
  'win-loss': 'win_loss',
  'market-read': 'market_read',
  'team-report': 'team',
  'role-report': 'role',
  'whats-changed': 'changes',
};

export const SERIES_LABELS: Record<string, string> = {
  pipeline: 'Pipeline', forecast: 'Forecast', win_loss: 'Win/loss', market_read: 'Market read',
  team: 'Team', role: 'Role', changes: "What's changed",
};

export function seriesFor(skill: string | null | undefined, title?: string | null): string | null {
  if (skill && SERIES_BY_SKILL[skill]) return SERIES_BY_SKILL[skill];
  const t = String(title ?? '').toLowerCase();
  if (/win\s*\/?\s*loss/.test(t)) return 'win_loss';
  if (/market read|voice of (the )?market/.test(t)) return 'market_read';
  if (/forecast/.test(t)) return 'forecast';
  if (/pipeline|revenue/.test(t)) return 'pipeline';
  if (/team report/.test(t)) return 'team';
  return null;
}

// ── Text ─────────────────────────────────────────────────────────────────────
//
// A report section built only from blocks used to be flattened as `## label\n${x.body}` —
// and `x.body` was undefined, so the literal word "undefined" is what got embedded and what
// `read_document` handed the agent. A chart is data; written out as its rows it is perfectly
// good text for a reader and for search.

function formatValue(v: unknown, unit?: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v == null ? '' : String(v);
  const n = Math.round(v * 100) / 100;
  switch (unit) {
    case 'usd': return `$${n.toLocaleString('en-US')}`;
    case 'pct': return `${n}%`;
    case 'days': return `${n} days`;
    default: return n.toLocaleString('en-US');
  }
}

const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function blockToMarkdown(block: DocumentBlock): string {
  const b = block as Record<string, any>;
  switch (b?.type) {
    case 'prose':
      return String(b.body ?? '').trim();
    case 'callout':
      return [b.title ? `**${String(b.title).trim()}**` : '', String(b.body ?? '').trim()].filter(Boolean).join('\n');
    case 'metrics':
      return (Array.isArray(b.items) ? b.items : [])
        .map((m: any) => `- ${m.label}: ${m.text ?? formatValue(m.value, m.unit)}${m.note ? ` (${m.note})` : ''}`)
        .join('\n');
    case 'chart': {
      const series: { key: string; label: string }[] = Array.isArray(b.series) && b.series.length
        ? b.series : [{ key: 'value', label: '' }];
      const rows = (Array.isArray(b.data) ? b.data : []).map((d: any) => {
        const vals = series.map(s => `${s.label ? `${s.label} ` : ''}${formatValue(d[s.key], b.unit)}`).join(', ');
        return `- ${d.label}: ${vals}`;
      });
      return [b.title ? `**${String(b.title).trim()}**` : '', ...rows].filter(Boolean).join('\n');
    }
    case 'table': {
      const headers: string[] = Array.isArray(b.headers) ? b.headers.map(String) : [];
      if (!headers.length) return '';
      const units: unknown[] = Array.isArray(b.units) ? b.units : [];
      const rows = (Array.isArray(b.rows) ? b.rows : [])
        .map((r: unknown[]) => `| ${headers.map((_, i) => cell(formatValue(r?.[i], units[i]))).join(' | ')} |`);
      return [`| ${headers.map(cell).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows].join('\n');
    }
    default:
      return '';
  }
}

/** One section as plain text: its prose, then its blocks written out. Never "undefined". */
export function sectionText(section: DocumentSection): string {
  const parts = [typeof section.body === 'string' ? section.body.trim() : ''];
  for (const b of Array.isArray(section.blocks) ? section.blocks : []) parts.push(blockToMarkdown(b));
  return parts.filter(Boolean).join('\n\n');
}

export function renderDocumentMarkdown(doc: { headline?: string | null; sections: DocumentSection[] }): string {
  return [
    doc.headline ? String(doc.headline).trim() : '',
    ...doc.sections.map(s => `## ${s.label}\n${sectionText(s)}`),
  ].filter(Boolean).join('\n\n');
}

/**
 * A markdown document as sections, split on its `##` headings. For documents that arrive as
 * one string (save_note, the v1 note rows) so they read and chunk like everything else. Text
 * before the first heading becomes the opening section; a leading `#` title line is dropped.
 */
export function sectionsFromMarkdown(md: string, fallbackLabel = 'Summary'): DocumentSection[] {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  if (/^#\s+/.test(lines[0] ?? '')) lines.shift();
  const sections: DocumentSection[] = [];
  let label = fallbackLabel;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ label, body });
    buf = [];
  };
  for (const line of lines) {
    const h = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { flush(); label = h[1].trim(); continue; }
    buf.push(line);
  }
  flush();
  return sections;
}

/** The v1 `doc_type` of a note, as a document kind — or null when it is not a document we write. */
export function documentKindFromDocType(docType: string | null | undefined): DocumentKind | null {
  switch (String(docType ?? '')) {
    case 'account_brief': return 'brief';
    case 'account_plan': return 'plan';
    case 'report': return 'report';
    case 'meeting_brief': return 'meeting_brief';
    case 'objection_prep': return 'objection_prep';
    default: return null;
  }
}

const CITE_RE = /\[(c[a-z0-9]{4})\](?!\()/g;
const LEGACY_RE = /\[(\d{1,2})\](?!\()/g;
const GROUP_RE = /\[(c[a-z0-9]{4}(?:\s*[,;]\s*c[a-z0-9]{4})+)\]/g;

/** "[cbvq8, clf45]" → "[cbvq8][clf45]". A grouped bracket renders as raw text and counts as no citation. */
export function splitCiteGroups(text: string): string {
  return String(text ?? '').replace(GROUP_RE, (_m, inner: string) => inner.split(/\s*[,;]\s*/).map(t => `[${t}]`).join(''));
}

function normalizeSectionCites(sections: DocumentSection[]): DocumentSection[] {
  return sections.map(sec => ({
    ...sec,
    ...(typeof sec.body === 'string' ? { body: splitCiteGroups(sec.body) } : {}),
    ...(Array.isArray(sec.blocks)
      ? { blocks: sec.blocks.map(b => (b && typeof (b as Record<string, unknown>).body === 'string' ? { ...b, body: splitCiteGroups(String((b as Record<string, unknown>).body)) } : b)) }
      : {}),
  }));
}
/** Plain [n] markers — how documents cited before cite tokens. */
export function legacyMarkersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of String(text ?? '').matchAll(LEGACY_RE)) out.add(Number(m[1]));
  return out;
}
export function citeTokensIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(CITE_RE)) out.add(m[1]);
  return out;
}

const wordCount = (text: string) => (text.match(/[A-Za-z0-9][\w'’-]*/g) ?? []).length;

// ── Chunks ───────────────────────────────────────────────────────────────────
//
// A section is the natural passage: it has a label a reader recognises and a thesis of its
// own. Long ones are packed by paragraph so a hit still lands on the part that matched.

const CHUNK_CHARS = 1500;
const MAX_CHUNKS = 80;

export interface DocumentChunk { chunk_index: number; section_index: number; heading: string; content: string }

export function chunkDocument(sections: DocumentSection[]): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  sections.forEach((section, sectionIndex) => {
    const text = sectionText(section);
    if (!text) return;
    const paragraphs = text.split(/\n{2,}/);
    let buf = '';
    const flush = () => {
      if (buf.trim()) chunks.push({ chunk_index: chunks.length, section_index: sectionIndex, heading: section.label, content: buf.trim() });
      buf = '';
    };
    for (const p of paragraphs) {
      if (p.length > CHUNK_CHARS) {
        flush();
        for (let i = 0; i < p.length; i += CHUNK_CHARS) {
          buf = p.slice(i, i + CHUNK_CHARS);
          flush();
        }
        continue;
      }
      if (buf.length + p.length + 2 > CHUNK_CHARS) flush();
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    flush();
  });
  return chunks.slice(0, MAX_CHUNKS).map((c, i) => ({ ...c, chunk_index: i }));
}

// ── Write ────────────────────────────────────────────────────────────────────

export interface WriteDocumentInput {
  kind: DocumentKind;
  title: string;
  headline?: string | null;
  sections: DocumentSection[];
  subjectEntityId?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  series?: string | null;
  generatedFrom?: string[] | null;
  authorUserId?: string | null;
  skill?: string | null;
  threadId?: string | null;
  writtenBy?: string;
  sources?: DocumentSourceInput[];
  /** Accounts the document is about besides its subject — a report naming five deals. */
  mentionEntityIds?: string[];
  createdAt?: string;
  legacyClaimId?: string | null;
  /** A brain page's home (GET-431): which brain, and where in it ("Playbooks/Competitors/Acme"). */
  brainId?: string | null;
  brainPath?: string | null;
  /** Default true: a new brief on the same account replaces the live one. */
  supersede?: boolean;
}

/**
 * Which live document this one replaces, if any.
 *
 * A brief or a plan is ABOUT an account, so a newer one on the same account is the next
 * version of it. A report is about a WINDOW: September's monthly pipeline report must not
 * retire August's, but regenerating September's must — so a report supersedes only the same
 * series over the same window (ends within two days of each other, same cadence).
 *
 * A call page is about ONE call, and an account has many: the second call on Acme must not
 * retire the first. So a call supersedes only its own series (`call:<source>:<meeting id>`),
 * which is what a re-analysed call writes.
 */
async function findSuperseded(
  supabase: SupabaseClient, workspaceId: string,
  doc: { kind: DocumentKind; subject_entity_id: string | null; series: string | null; cadence: DocumentCadence | null; period_end: string | null; title: string; brain_id?: string | null; brain_path?: string | null },
): Promise<{ id: string; version: number } | null> {
  let q = supabase.from('documents').select('id, version, period_end, title')
    .eq('workspace_id', workspaceId).eq('status', 'live').eq('kind', doc.kind)
    .order('created_at', { ascending: false }).limit(20);
  // A brain page is its PATH: the next write to "Decisions" is Decisions' next version.
  if (doc.kind === 'brain_page') {
    if (!doc.brain_id || !doc.brain_path) return null;
    const { data } = await q.eq('brain_id', doc.brain_id).eq('brain_path', doc.brain_path);
    return data?.[0] ? { id: data[0].id, version: data[0].version } : null;
  }
  if (doc.kind === 'call') {
    if (!doc.series) return null;
    const { data } = await q.eq('series', doc.series);
    return data?.[0] ? { id: data[0].id, version: data[0].version } : null;
  }
  if (doc.kind !== 'report') {
    if (!doc.subject_entity_id) return null;
    q = q.eq('subject_entity_id', doc.subject_entity_id);
    const { data } = await q;
    return data?.[0] ? { id: data[0].id, version: data[0].version } : null;
  }
  q = doc.subject_entity_id ? q.eq('subject_entity_id', doc.subject_entity_id) : q.is('subject_entity_id', null);
  q = doc.series ? q.eq('series', doc.series) : q.is('series', null);
  if (doc.cadence) q = q.eq('cadence', doc.cadence);
  const { data } = await q;
  const end = doc.period_end ? Date.parse(doc.period_end) : null;
  const match = (data ?? []).find((d: any) => {
    // A report with no series and no window is identified only by its name.
    if (!doc.series && end == null) return d.title === doc.title;
    if (end == null || !d.period_end) return false;
    return Math.abs(Date.parse(d.period_end) - end) <= 2 * DAY;
  });
  return match ? { id: match.id, version: match.version } : null;
}

export async function writeDocument(supabase: SupabaseClient, workspaceId: string, input: WriteDocumentInput): Promise<DocumentRow> {
  if (!DOCUMENT_KINDS.includes(input.kind)) throw new Error(`unknown document kind: ${input.kind}`);
  // A section with text and no heading is kept under "Summary": an answer written as one plain
  // paragraph used to be dropped here, and the steps after it read nothing (GET-788).
  const sections = normalizeSectionCites((input.sections ?? [])
    .filter(s => s && (String(s.label ?? '').trim() || String(s.body ?? '').trim()))
    .map(s => (String(s.label ?? '').trim() ? s : { ...s, label: 'Summary' })));
  const bodyMd = renderDocumentMarkdown({ headline: input.headline, sections });
  const createdAt = input.createdAt ?? new Date().toISOString();
  const series = input.series ?? (input.kind === 'report' ? seriesFor(input.skill, input.title) : null);
  const cadence = documentCadence(input.kind, input.periodStart, input.periodEnd);
  const subject = input.subjectEntityId ?? null;

  const previous = input.supersede === false ? null : await findSuperseded(supabase, workspaceId, {
    kind: input.kind, subject_entity_id: subject, series, cadence, period_end: input.periodEnd ?? null, title: input.title,
    brain_id: input.brainId ?? null, brain_path: input.brainPath ?? null,
  });

  const { data: doc, error } = await supabase.from('documents').insert({
    workspace_id: workspaceId,
    kind: input.kind,
    series,
    cadence,
    title: String(input.title).trim().slice(0, 300),
    headline: input.headline ? String(input.headline).trim() : null,
    sections,
    body_md: bodyMd,
    word_count: wordCount(bodyMd),
    content_hash: createHash('sha256').update(bodyMd).digest('hex'),
    subject_entity_id: subject,
    period_start: input.periodStart ?? null,
    period_end: input.periodEnd ?? null,
    generated_from: (input.generatedFrom ?? []).map(String).filter(Boolean).slice(0, 8),
    author_user_id: input.authorUserId ?? null,
    skill: input.skill ?? null,
    thread_id: input.threadId ?? null,
    written_by: input.writtenBy ?? 'web_agent',
    status: 'live',
    supersedes_id: previous?.id ?? null,
    version: previous ? previous.version + 1 : 1,
    legacy_claim_id: input.legacyClaimId ?? null,
    brain_id: input.brainId ?? null,
    brain_path: input.brainPath ?? null,
    created_at: createdAt,
    updated_at: createdAt,
  }).select(ROW_COLS).single();
  if (error) throw error;
  const row = doc as unknown as DocumentRow;

  if (previous) {
    await supabase.from('documents').update({ status: 'superseded', updated_at: createdAt })
      .eq('id', previous.id).eq('workspace_id', workspaceId);
  }

  // Everything below enriches the document; none of it may lose the document if it fails.
  await Promise.all([
    writeSources(supabase, workspaceId, row, input.sources ?? []).catch(e => console.error('[documents] sources', e?.message ?? e)),
    writeLinks(supabase, workspaceId, row, input, previous?.id ?? null).catch(e => console.error('[documents] links', e?.message ?? e)),
    writeChunks(supabase, workspaceId, row).catch(e => console.error('[documents] chunks', e?.message ?? e)),
  ]);
  return row;
}

async function writeSources(supabase: SupabaseClient, workspaceId: string, doc: DocumentRow, sources: DocumentSourceInput[]) {
  // Which sections carry which token, so the panel can say where a source is used.
  const tokensBySection = doc.sections.map(s => citeTokensIn(sectionText(s)));
  const headlineTokens = citeTokensIn(doc.headline ?? '');
  // A document written before cite tokens existed carries plain [1] [2] markers, numbered
  // against the turn's sources in first-seen order. Those count as citations of the nth source.
  const legacy = ![...tokensBySection, headlineTokens].some(set => set.size > 0);
  const numbersBySection = legacy ? doc.sections.map(s => legacyMarkersIn(sectionText(s))) : [];
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const s of sources) {
    // A source with no pointer still holds its place in a legacy numbering, so it gets a
    // stand-in ref rather than being dropped (which would shift every number after it).
    const ref = String(s?.ref ?? '').trim() || (legacy && s?.system ? `legacy:${s.system}|${s.detail ?? ''}` : '');
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const key = citeKey(ref);
    const n: number = rows.length + 1;
    const sectionIndexes: number[] = legacy
      ? numbersBySection.flatMap((set, i) => (set.has(n) ? [i] : []))
      : key ? tokensBySection.flatMap((set, i) => (set.has(key) ? [i] : [])) : [];
    rows.push({
      workspace_id: workspaceId,
      document_id: doc.id,
      ordinal: rows.length,
      cite_key: key,
      ref,
      system: String(s.system ?? 'Nous').slice(0, 60),
      detail: s.detail ? String(s.detail).slice(0, 300) : null,
      occurred_at: s.when && Number.isFinite(Date.parse(s.when)) ? new Date(s.when).toISOString() : null,
      quote: s.quote ? String(s.quote).slice(0, 1200) : null,
      speaker: s.speaker ? String(s.speaker).slice(0, 120) : null,
      evidence_kind: s.kind ? String(s.kind).slice(0, 60) : null,
      derived: !!s.derived,
      cited: sectionIndexes.length > 0 || (!!key && headlineTokens.has(key)),
      section_indexes: sectionIndexes,
    });
    if (rows.length >= 200) break;
  }
  if (!rows.length) return;
  const { error } = await supabase.from('document_sources').insert(rows);
  if (error) throw error;
}

/**
 * Give a document written without evidence the sources of the turn that wrote it. Used by the
 * backfill: every document migrated from a note had `sources: []`, while the chat message that
 * produced it still holds the tool calls it read. Refuses a document that already has sources.
 */
export async function attachDocumentSources(supabase: SupabaseClient, workspaceId: string, documentId: string, sources: DocumentSourceInput[]) {
  const { count } = await supabase.from('document_sources').select('id', { count: 'exact', head: true }).eq('document_id', documentId);
  if ((count ?? 0) > 0) return { attached: 0, skipped: 'has_sources' as const };
  const { data } = await supabase.from('documents').select(ROW_COLS).eq('workspace_id', workspaceId).eq('id', documentId).maybeSingle();
  if (!data) return { attached: 0, skipped: 'not_found' as const };
  await writeSources(supabase, workspaceId, data as unknown as DocumentRow, sources);
  const { count: after } = await supabase.from('document_sources').select('id', { count: 'exact', head: true }).eq('document_id', documentId);
  return { attached: after ?? 0 };
}

async function writeLinks(supabase: SupabaseClient, workspaceId: string, doc: DocumentRow, input: WriteDocumentInput, supersededId: string | null) {
  const links: Record<string, unknown>[] = [];
  const entityEdges = new Set<string>();
  const addEntity = (kind: 'about' | 'mentions', id: string | null | undefined) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    if (entityEdges.has(key)) return;
    entityEdges.add(key);
    links.push({ workspace_id: workspaceId, document_id: doc.id, kind, target_entity_id: id });
  };
  addEntity('about', doc.subject_entity_id);
  const mentioned = new Set<string>([
    ...(input.mentionEntityIds ?? []),
    ...(input.sources ?? []).map(s => accountIdFromRef(String(s?.ref ?? ''))).filter((x): x is string => !!x),
  ]);
  for (const id of mentioned) if (id !== doc.subject_entity_id) addEntity('mentions', id);

  const docTargets = new Set<string>();
  for (const s of input.sources ?? []) {
    const parsed = parseDocumentRef(s?.ref);
    if (parsed && parsed.documentId !== doc.id) docTargets.add(parsed.documentId);
  }
  for (const id of docTargets) links.push({ workspace_id: workspaceId, document_id: doc.id, kind: 'links_to', target_document_id: id });
  if (supersededId) links.push({ workspace_id: workspaceId, document_id: doc.id, kind: 'supersedes', target_document_id: supersededId });
  if (!links.length) return;

  // A mentioned account can have been deleted since the turn read it; insert one by one on a
  // foreign-key failure rather than lose every edge to one stale id.
  const { error } = await supabase.from('document_links').insert(links);
  if (!error) return;
  for (const l of links) await supabase.from('document_links').insert(l).then(() => null, () => null);
}

async function writeChunks(supabase: SupabaseClient, workspaceId: string, doc: DocumentRow) {
  const chunks = chunkDocument(doc.sections);
  if (!chunks.length) return;
  const vectors: (number[] | null)[] = [];
  for (let i = 0; i < chunks.length; i += 64) {
    const batch = chunks.slice(i, i + 64).map(c => `${doc.title}\n${c.heading}\n${c.content}`);
    const out = await embedBatch(batch);
    for (let j = 0; j < batch.length; j++) vectors.push(out?.[j] ?? null);
  }
  const { error } = await supabase.from('document_chunks').insert(chunks.map((c, i) => ({
    workspace_id: workspaceId,
    document_id: doc.id,
    ...c,
    embedding: vectors[i] ? JSON.stringify(vectors[i]) : null,
  })));
  if (error) throw error;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export interface ListDocumentsFilters {
  kinds?: DocumentKind[];
  subjectEntityIds?: string[];
  series?: string | null;
  cadence?: DocumentCadence | null;
  /** Documents whose window ENDS on or after this — "the last 30 days". */
  since?: string | null;
  until?: string | null;
  titleContains?: string | null;
  includeSuperseded?: boolean;
  limit?: number;
}

export async function listDocuments(supabase: SupabaseClient, workspaceId: string, f: ListDocumentsFilters = {}): Promise<DocumentSummary[]> {
  let q = supabase.from('documents').select(SUMMARY_COLS).eq('workspace_id', workspaceId);
  q = f.includeSuperseded ? q.neq('status', 'deleted') : q.eq('status', 'live');
  // Brain pages live in their brain (GET-431). They have no subject, so without this they
  // would read as workspace reports and land in the Pages index.
  if (f.kinds?.length) q = q.in('kind', f.kinds);
  else q = q.neq('kind', 'brain_page');
  if (f.subjectEntityIds?.length) q = q.in('subject_entity_id', f.subjectEntityIds);
  if (f.series) q = q.eq('series', f.series);
  if (f.cadence) q = q.eq('cadence', f.cadence);
  // A document's date is the end of the window it covers, or when it was written if it covers none.
  if (f.since) q = q.or(`period_end.gte.${f.since},and(period_end.is.null,created_at.gte.${f.since})`);
  if (f.until) q = q.or(`period_end.lte.${f.until},and(period_end.is.null,created_at.lte.${f.until})`);
  if (f.titleContains) q = q.ilike('title', `%${f.titleContains.replace(/[%_]/g, '')}%`);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(Math.min(f.limit ?? 100, 500));
  if (error) throw error;
  return (data ?? []) as unknown as DocumentSummary[];
}

/**
 * Domains for a set of company ids, from the `companies` projection.
 *
 * The one place that knows a company's domain is a COLUMN and not a claim. labelEntities uses
 * it for anything with an entity label; callers that hold bare company ids on their rows — the
 * tasks feed, where a row has a company_id and no entity — use it directly. Batched at 200
 * because a PostgREST `.in()` over a thousand uuids is a 37KB URL and comes back Bad Request.
 */
export async function companyDomains(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await supabase.from('companies')
      .select('id, domain').eq('workspace_id', workspaceId).in('id', unique.slice(i, i + 200));
    if (error) throw new Error(`companyDomains failed: ${error.message}`);
    for (const c of data ?? []) if (c.domain) out.set(c.id as string, String(c.domain));
  }
  return out;
}

export interface EntityLabel { id: string; type: 'person' | 'company' | 'deal' | 'workspace'; name: string | null; domain: string | null; email: string | null; title: string | null; photo_url: string | null }

/** Names for a set of entities in two queries. A document headed by an id is one nobody opens. */
export async function labelEntities(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, EntityLabel>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, EntityLabel>();
  for (let i = 0; i < unique.length; i += 200) {
    const slice = unique.slice(i, i + 200);
    const [{ data: ents }, { data: claims }] = await Promise.all([
      supabase.from('entities').select('id, type').eq('workspace_id', workspaceId).in('id', slice),
      supabase.from('claims').select('entity_id, property, value').eq('workspace_id', workspaceId).in('entity_id', slice)
        .in('property', ['name', 'full_name', 'first_name', 'last_name', 'domain', 'website', 'email', 'title', 'role', 'photo_url'])
        .is('invalid_at', null),
    ]);
    // A calendar attendee can arrive with no display name and its email only as an identifier
    // (an attendee at a customer's own domain). That email is the only honest label such a person has.
    const { data: emailIds } = await supabase.from('entity_identifiers').select('entity_id, value')
      .eq('workspace_id', workspaceId).in('entity_id', slice).eq('kind', 'email').eq('status', 'active');
    const identifierEmail = new Map<string, string>();
    for (const r of emailIds ?? []) if (r.value && !identifierEmail.has(r.entity_id)) identifierEmail.set(r.entity_id, String(r.value));
    const props = new Map<string, Record<string, string>>();
    for (const c of claims ?? []) {
      const v = typeof c.value === 'string' ? c.value : (c.value as any)?.value;
      if (typeof v !== 'string' || !v.trim()) continue;
      const m = props.get(c.entity_id) ?? {};
      m[c.property] = v.trim();
      props.set(c.entity_id, m);
    }
    // A COMPANY'S DOMAIN IS NOT A CLAIM. It is a column on the `companies` projection, and
    // almost no company entity carries the claim — measured on one workspace's graph,
    // labelEntities found a domain for a small minority of document subjects while `companies`
    // had one for every company it was asked about. Every caller that wanted a logo was therefore patching
    // this join back on afterwards, in its own way, and the callers that forgot drew initials.
    // One query, here, so there is one answer to "what is this account's domain".
    const projected = await companyDomains(supabase, workspaceId,
      (ents ?? []).filter(e => e.type === 'company').map(e => e.id));
    for (const e of ents ?? []) {
      const m = props.get(e.id) ?? {};
      // The claim wins when there is one — it is the thing a human or an extractor asserted.
      const rawDomain = m.domain ?? m.website ?? projected.get(e.id) ?? '';
      const domain = rawDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || null;
      const personName = [m.first_name, m.last_name].filter(Boolean).join(' ') || null;
      const email = m.email ?? identifierEmail.get(e.id) ?? null;
      // A person is never labelled with a company domain — that reads as a second company
      // filed under People. Their email names them; a company falls back to its domain.
      const name = e.type === 'person'
        ? m.name ?? m.full_name ?? personName ?? email ?? null
        : m.name ?? m.full_name ?? personName ?? domain ?? email ?? null;
      out.set(e.id, {
        id: e.id,
        type: e.type,
        name,
        domain,
        email,
        title: m.title ?? m.role ?? null,
        photo_url: m.photo_url ?? null,
      });
    }
  }
  return out;
}

export interface DocumentSourceRow {
  ordinal: number; cite_key: string | null; ref: string; system: string; detail: string | null;
  occurred_at: string | null; quote: string | null; speaker: string | null; evidence_kind: string | null;
  derived: boolean; cited: boolean; section_indexes: number[];
}

export interface DocumentDetail {
  document: DocumentRow;
  subject: EntityLabel | null;
  sources: DocumentSourceRow[];
  mentions: EntityLabel[];
  /** Documents this one links to (cited as a source). */
  outgoing: DocumentSummary[];
  /** Documents that link to this one. */
  backlinks: DocumentSummary[];
  /** Every version of this document, newest first, this one included. */
  versions: Pick<DocumentSummary, 'id' | 'version' | 'status' | 'created_at' | 'title'>[];
  /** Other live documents about the same account. */
  related: DocumentSummary[];
  chunks: number;
}

/**
 * What each document was WRITTEN FROM — the calls, threads and messages under it, never
 * another document — so a citation of our summary can land on the call it summarises
 * (GET-428).
 *
 * Cited rows first, then the rest. A call summary files its one transcript with
 * `cited: false`, because nothing in the body carries a marker, and that transcript is still
 * the whole of what the summary came from. Filtering on `cited` alone is how every call
 * summary ended up citing itself.
 */
export async function documentRawSources(
  supabase: SupabaseClient, documentIds: string[],
): Promise<Map<string, DocumentSourceRow[]>> {
  const ids = [...new Set(documentIds.filter(Boolean))];
  const out = new Map<string, DocumentSourceRow[]>();
  if (!ids.length) return out;
  const { data } = await supabase.from('document_sources')
    .select('document_id, ordinal, cite_key, ref, system, detail, occurred_at, quote, speaker, evidence_kind, derived, cited, section_indexes')
    .in('document_id', ids).like('ref', 'source://%')
    .order('ordinal', { ascending: true });
  for (const row of (data ?? []) as unknown as (DocumentSourceRow & { document_id: string })[]) {
    const list = out.get(row.document_id) ?? [];
    list.push(row);
    out.set(row.document_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.cited) - Number(a.cited) || a.ordinal - b.ordinal);
  return out;
}

export async function getDocument(supabase: SupabaseClient, workspaceId: string, id: string): Promise<DocumentDetail | null> {
  const { data: doc } = await supabase.from('documents').select(ROW_COLS)
    .eq('workspace_id', workspaceId).eq('id', id).neq('status', 'deleted').maybeSingle();
  if (!doc) return null;
  const row = doc as unknown as DocumentRow;

  const [{ data: sources }, { data: outLinks }, { data: inLinks }, { count: chunks }] = await Promise.all([
    supabase.from('document_sources')
      .select('ordinal, cite_key, ref, system, detail, occurred_at, quote, speaker, evidence_kind, derived, cited, section_indexes')
      .eq('document_id', id).order('ordinal', { ascending: true }),
    supabase.from('document_links').select('kind, target_entity_id, target_document_id').eq('document_id', id),
    supabase.from('document_links').select('kind, document_id').eq('workspace_id', workspaceId)
      .eq('target_document_id', id).eq('kind', 'links_to'),
    supabase.from('document_chunks').select('id', { count: 'exact', head: true }).eq('document_id', id),
  ]);

  const mentionIds = (outLinks ?? []).filter(l => l.kind === 'mentions' && l.target_entity_id).map(l => l.target_entity_id as string);
  const outgoingIds = (outLinks ?? []).filter(l => l.kind === 'links_to' && l.target_document_id).map(l => l.target_document_id as string);
  const backlinkIds = [...new Set((inLinks ?? []).map(l => l.document_id as string))];

  const summaries = async (ids: string[]) => {
    if (!ids.length) return [] as DocumentSummary[];
    const { data } = await supabase.from('documents').select(SUMMARY_COLS)
      .eq('workspace_id', workspaceId).in('id', ids).neq('status', 'deleted');
    return (data ?? []) as unknown as DocumentSummary[];
  };

  const [labels, outgoing, backlinks, versions, related] = await Promise.all([
    labelEntities(supabase, workspaceId, [row.subject_entity_id ?? '', ...mentionIds]),
    summaries(outgoingIds),
    summaries(backlinkIds),
    versionChain(supabase, workspaceId, row),
    row.subject_entity_id
      ? supabase.from('documents').select(SUMMARY_COLS).eq('workspace_id', workspaceId).eq('status', 'live')
          .eq('subject_entity_id', row.subject_entity_id).neq('id', row.id)
          .order('created_at', { ascending: false }).limit(12)
          .then(r => (r.data ?? []) as unknown as DocumentSummary[])
      : Promise.resolve([] as DocumentSummary[]),
  ]);

  return {
    document: row,
    subject: row.subject_entity_id ? labels.get(row.subject_entity_id) ?? null : null,
    sources: (sources ?? []) as DocumentSourceRow[],
    mentions: mentionIds.map(i => labels.get(i)).filter((x): x is EntityLabel => !!x),
    outgoing,
    backlinks,
    versions,
    related,
    chunks: chunks ?? 0,
  };
}

/** The whole version chain through `supersedes_id`, both directions, newest first. */
async function versionChain(supabase: SupabaseClient, workspaceId: string, doc: DocumentRow) {
  type V = { id: string; version: number; status: DocumentStatus; created_at: string; title: string; supersedes_id: string | null };
  const cols = 'id, version, status, created_at, title, supersedes_id';
  const chain: V[] = [{ id: doc.id, version: doc.version, status: doc.status, created_at: doc.created_at, title: doc.title, supersedes_id: doc.supersedes_id }];
  let back = doc.supersedes_id;
  for (let i = 0; back && i < 30; i++) {
    const { data } = await supabase.from('documents').select(cols).eq('workspace_id', workspaceId).eq('id', back).neq('status', 'deleted').maybeSingle();
    if (!data) break;
    chain.push(data as V);
    back = (data as V).supersedes_id;
  }
  let fwd: string | null = doc.id;
  for (let i = 0; fwd && i < 30; i++) {
    const { data }: { data: V | null } = await supabase.from('documents').select(cols).eq('workspace_id', workspaceId).eq('supersedes_id', fwd).neq('status', 'deleted').maybeSingle();
    if (!data) break;
    chain.unshift(data);
    fwd = data.id;
  }
  return chain.map(({ supersedes_id: _s, ...v }) => v);
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface DocumentSearchHit {
  document: DocumentSummary;
  section_index: number;
  heading: string | null;
  /** The passage that matched — not the top of the document. */
  snippet: string;
  score: number;
  ref: string;
}

/**
 * Passages across every live document, by meaning and by exact words, fused with reciprocal
 * rank (k=60) so neither ranking dominates. One hit per document: its best passage.
 */
export async function searchDocuments(
  supabase: SupabaseClient, workspaceId: string, query: string,
  opts: { limit?: number; kinds?: DocumentKind[]; subjectEntityIds?: string[] } = {},
): Promise<DocumentSearchHit[]> {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const limit = Math.min(opts.limit ?? 8, 30);
  const pool = Math.max(limit * 4, 24);
  const vector = await embed(q);
  const [vec, fts] = await Promise.all([
    vector
      ? supabase.rpc('search_document_chunks', { p_workspace_id: workspaceId, p_embedding: JSON.stringify(vector), p_limit: pool, p_threshold: 0.2 })
          .then(r => (r.error ? [] : r.data ?? []), () => [])
      : Promise.resolve([]),
    supabase.rpc('search_document_chunks_fts', { p_workspace_id: workspaceId, p_query: q, p_limit: pool })
      .then(r => (r.error ? [] : r.data ?? []), () => []),
  ]);

  type ChunkHit = { chunk_id: string; document_id: string; section_index: number; heading: string | null; content: string };
  const fused = new Map<string, { hit: ChunkHit; score: number }>();
  for (const list of [vec as ChunkHit[], fts as ChunkHit[]]) {
    list.forEach((h, rank) => {
      const cur = fused.get(h.chunk_id) ?? { hit: h, score: 0 };
      cur.score += 1 / (60 + rank);
      fused.set(h.chunk_id, cur);
    });
  }
  const bestPerDoc = new Map<string, { hit: ChunkHit; score: number }>();
  for (const f of fused.values()) {
    const cur = bestPerDoc.get(f.hit.document_id);
    if (!cur || f.score > cur.score) bestPerDoc.set(f.hit.document_id, f);
  }
  const ranked = [...bestPerDoc.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];

  const docs = await listDocumentsByIds(supabase, workspaceId, ranked.map(r => r.hit.document_id));
  const hits: DocumentSearchHit[] = [];
  for (const r of ranked) {
    const d = docs.get(r.hit.document_id);
    if (!d) continue;
    if (opts.kinds?.length && !opts.kinds.includes(d.kind)) continue;
    if (opts.subjectEntityIds?.length && !opts.subjectEntityIds.includes(d.subject_entity_id ?? '')) continue;
    hits.push({
      document: d,
      section_index: r.hit.section_index,
      heading: r.hit.heading,
      snippet: r.hit.content.slice(0, 900),
      score: Math.round(r.score * 10000) / 10000,
      ref: documentRef(d.id, r.hit.section_index),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

async function listDocumentsByIds(supabase: SupabaseClient, workspaceId: string, ids: string[]) {
  const { data } = await supabase.from('documents').select(SUMMARY_COLS)
    .eq('workspace_id', workspaceId).in('id', [...new Set(ids)]).eq('status', 'live');
  return new Map(((data ?? []) as unknown as DocumentSummary[]).map(d => [d.id, d]));
}

/**
 * The documents on an account, as the compact previews an account read carries: the brief
 * skill reads the last brief through these, which is what lets briefs compound. With an id
 * and a ref, so the agent can open one and cite it.
 */
export async function documentPreviews(supabase: SupabaseClient, workspaceId: string, entityId: string, limit = 8) {
  const [{ data: about }, { data: mentioned }] = await Promise.all([
    supabase.from('documents').select('id, kind, title, headline, body_md, created_at, period_end')
      .eq('workspace_id', workspaceId).eq('subject_entity_id', entityId).eq('status', 'live')
      .order('created_at', { ascending: false }).limit(limit),
    supabase.from('document_links').select('document_id').eq('workspace_id', workspaceId)
      .eq('target_entity_id', entityId).eq('kind', 'mentions').limit(limit),
  ]);
  const mentionIds = (mentioned ?? []).map(m => m.document_id).filter(id => !(about ?? []).some(a => a.id === id));
  const { data: others } = mentionIds.length
    ? await supabase.from('documents').select('id, kind, title, headline, body_md, created_at, period_end')
        .eq('workspace_id', workspaceId).in('id', mentionIds).eq('status', 'live')
    : { data: [] as any[] };
  return [...(about ?? []), ...(others ?? [])].map(d => {
    const text = String(d.headline || d.body_md || '').replace(/\s+/g, ' ').trim();
    return {
      type: d.kind as string,
      title: d.title as string,
      date: (d.created_at as string) ?? null,
      snippet: text.length > 200 ? `${text.slice(0, 200)}…` : text,
      document_id: d.id as string,
      source_ref: documentRef(d.id),
      ...(mentionIds.includes(d.id) ? { mentioned_in: true } : {}),
    };
  });
}

// ── The tree ─────────────────────────────────────────────────────────────────
//
// Two shelves, decided by the operator (2026-09-13):
//   Accounts   → a folder per account → its documents, and a People folder holding the
//                account's people, each with their own briefs.
//   Documents  → Reports → Weekly · Monthly · Quarterly · One-off, plus whatever else is
//                about the whole book rather than one account.
// Every placement is derived from the document's own fields, so a document is always in
// exactly one folder and the folder can never disagree with the document.

export interface TreePerson { entity: EntityLabel; documents: DocumentSummary[] }
/** `calls` holds the account's call pages (GET-236) — every call on the account, in its own folder. */
export interface TreeAccount { entity: EntityLabel; documents: DocumentSummary[]; calls: DocumentSummary[]; people: TreePerson[] }
export interface DocumentTree {
  accounts: TreeAccount[];
  reports: Record<DocumentCadence, DocumentSummary[]>;
  other: DocumentSummary[];
}

/**
 * PAGES IS A REPORTS INDEX, NOT A FILING CABINET (GET-349).
 *
 * In a busy workspace nearly every document is about one account — most of them call summaries —
 * and that is from a few weeks of backfilled meetings. At a full year it becomes thousands of call
 * pages against a handful of reports: an index where the thing you came for cannot be found.
 *
 * A call summary is not a document you browse to. You arrive at it from the account, the person or
 * the meeting, and those surfaces now carry it.
 *
 * The filter is structural rather than a list of kinds someone has to remember to extend: a report
 * is the only kind with no subject, and every other kind always has one. So `subject_entity_id IS
 * NULL` already means "this is about the workspace", and a new document kind cannot quietly appear
 * in the wrong place.
 */
export async function documentTree(
  supabase: SupabaseClient, workspaceId: string,
  opts: { visible?: (entityId: string) => boolean; peoplePerAccount?: number; workspaceOnly?: boolean } = {},
): Promise<DocumentTree> {
  const all = await listDocuments(supabase, workspaceId, { limit: 500 });
  // Nothing is deleted and nothing stops existing — one list stops showing them, and every
  // document keeps its own URL.
  const docs = opts.workspaceOnly ? all.filter(d => !d.subject_entity_id) : all;
  const visible = opts.visible ?? (() => true);
  const subjectIds = [...new Set(docs.map(d => d.subject_entity_id).filter((x): x is string => !!x))];

  // People with documents → the company they work at, so their briefs sit inside it.
  const labels = await labelEntities(supabase, workspaceId, subjectIds);
  const personIds = subjectIds.filter(id => labels.get(id)?.type === 'person');
  const employerOf = new Map<string, string>();
  if (personIds.length) {
    const { data } = await supabase.from('relationships').select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at').in('from_entity_id', personIds).is('valid_to', null);
    for (const r of data ?? []) if (!employerOf.has(r.from_entity_id)) employerOf.set(r.from_entity_id, r.to_entity_id);
  }
  const companyIds = [...new Set([
    ...subjectIds.filter(id => labels.get(id)?.type === 'company'),
    ...employerOf.values(),
  ])].filter(visible);

  // Everyone at those companies, so an account folder shows its people even before anyone
  // has been briefed on them.
  const peopleByCompany = new Map<string, string[]>();
  if (companyIds.length) {
    const { data } = await supabase.from('relationships').select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'works_at').in('to_entity_id', companyIds).is('valid_to', null).limit(5000);
    for (const r of data ?? []) {
      const list = peopleByCompany.get(r.to_entity_id) ?? [];
      if (!list.includes(r.from_entity_id)) list.push(r.from_entity_id);
      peopleByCompany.set(r.to_entity_id, list);
    }
  }
  const cap = opts.peoplePerAccount ?? 50;
  const extraIds = [...companyIds, ...[...peopleByCompany.values()].flatMap(l => l.slice(0, cap))].filter(id => !labels.has(id));
  for (const [id, l] of await labelEntities(supabase, workspaceId, extraIds)) labels.set(id, l);

  const accounts = new Map<string, TreeAccount>();
  const account = (id: string) => {
    let a = accounts.get(id);
    if (!a) {
      const entity = labels.get(id);
      if (!entity) return null;
      a = { entity, documents: [], calls: [], people: [] };
      accounts.set(id, a);
    }
    return a;
  };
  const person = (a: TreeAccount, id: string) => {
    let p = a.people.find(x => x.entity.id === id);
    if (!p) {
      const entity = labels.get(id);
      if (!entity) return null;
      p = { entity, documents: [] };
      a.people.push(p);
    }
    return p;
  };

  const tree: DocumentTree = { accounts: [], reports: { weekly: [], monthly: [], quarterly: [], one_off: [] }, other: [] };
  for (const d of docs) {
    const sid = d.subject_entity_id;
    if (!sid) {
      if (d.kind === 'report') tree.reports[d.cadence ?? 'one_off'].push(d);
      else tree.other.push(d);
      continue;
    }
    if (!visible(sid)) continue;
    const label = labels.get(sid);
    if (label?.type === 'person') {
      const employer = employerOf.get(sid);
      const a = employer && visible(employer) ? account(employer) : account(sid);
      if (!a) continue;
      // A call belongs to the account's Calls folder whoever it was filed on.
      if (d.kind === 'call') { a.calls.push(d); continue; }
      if (a.entity.id === sid) a.documents.push(d);
      else person(a, sid)?.documents.push(d);
      continue;
    }
    const a = account(sid);
    if (a) (d.kind === 'call' ? a.calls : a.documents).push(d);
    else tree.other.push(d);
  }

  for (const a of accounts.values()) {
    for (const pid of (peopleByCompany.get(a.entity.id) ?? []).slice(0, cap)) {
      if (visible(pid)) person(a, pid);
    }
    // People with documents first, then by name.
    a.people.sort((x, y) => (y.documents.length - x.documents.length) || String(x.entity.name ?? '').localeCompare(String(y.entity.name ?? '')));
  }
  const newest = (a: TreeAccount) => Math.max(0, ...[...a.documents, ...a.calls, ...a.people.flatMap(p => p.documents)].map(d => Date.parse(d.created_at)));
  tree.accounts = [...accounts.values()].sort((x, y) => newest(y) - newest(x));
  return tree;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/** Rename. The only edit a read-only document takes. */
export async function renameDocument(supabase: SupabaseClient, workspaceId: string, id: string, title: string) {
  const clean = String(title ?? '').trim().slice(0, 300);
  if (!clean) throw new Error('title_required');
  const { data, error } = await supabase.from('documents').update({ title: clean, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', id).neq('status', 'deleted').select(SUMMARY_COLS).maybeSingle();
  if (error) throw error;
  return data as unknown as DocumentSummary | null;
}

/**
 * Edit a section's text (GET-426).
 *
 * A PERSON'S EDIT REPLACES THE BODY AND NOTHING ELSE. A section can be prose or a list of
 * blocks; an editor that round-trips the whole object would have to understand charts and
 * tables to hand them back unharmed, and the first thing it got wrong would be silent. So an
 * edit writes `body` on the one section it touches and leaves any blocks alone — which means
 * a section built from blocks is not editable as text, and that is the honest limit rather
 * than a lossy save.
 *
 * The flattened text is rewritten too, because search reads that and a document whose search
 * text disagrees with its page is worse than one nobody edited.
 */
export async function editDocumentSection(
  supabase: SupabaseClient, workspaceId: string, id: string, index: number, body: string,
): Promise<DocumentRow | null> {
  const { data: row, error: readErr } = await supabase.from('documents')
    .select('sections').eq('workspace_id', workspaceId).eq('id', id).neq('status', 'deleted').maybeSingle();
  if (readErr) throw readErr;
  if (!row) return null;

  const sections = Array.isArray(row.sections) ? [...(row.sections as DocumentSection[])] : [];
  const target = sections[index];
  if (!target) throw new Error('section_not_found');
  if (Array.isArray(target.blocks) && target.blocks.length) throw new Error('section_has_blocks');

  sections[index] = { ...target, body: String(body ?? '') };
  const { data, error } = await supabase.from('documents')
    .update({ sections, body_md: sections.map(sectionText).join('\n\n'), updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', id).select('*').maybeSingle();
  if (error) throw error;
  return data as unknown as DocumentRow | null;
}

/**
 * Delete is a status, not a row removal. If the deleted document was the live version, the
 * one it replaced comes back — deleting a bad regeneration should not leave the account with
 * no brief at all.
 */
export async function deleteDocument(supabase: SupabaseClient, workspaceId: string, id: string) {
  const now = new Date().toISOString();
  const { data: doc } = await supabase.from('documents').select('id, status, supersedes_id')
    .eq('workspace_id', workspaceId).eq('id', id).neq('status', 'deleted').maybeSingle();
  if (!doc) return false;
  await supabase.from('documents').update({ status: 'deleted', deleted_at: now, updated_at: now })
    .eq('workspace_id', workspaceId).eq('id', id);
  if (doc.status === 'live' && doc.supersedes_id) {
    await supabase.from('documents').update({ status: 'live', updated_at: now })
      .eq('workspace_id', workspaceId).eq('id', doc.supersedes_id).eq('status', 'superseded');
  }
  return true;
}
