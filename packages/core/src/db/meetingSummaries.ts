/**
 * Internal meeting summaries (GET-445): one consistent record of every call with only the team on
 * it. Sections, in the order set on 2026-09-25: Summary, Accounts, Insights, Decisions,
 * Next steps, Open issues.
 *
 * Every item carries a SCOPE — our own business ("company") or one client ("account:<Name>") — so a
 * fact about one customer's HubSpot never reads as a fact about ours. Client-specific decisions and open
 * issues sit with that client under Insights; the Decisions section, and the brain's Decisions log
 * it feeds, hold only decisions about our own business.
 *
 * Stored as a `call_summary` document per call, filed by series `internal:<source_ref>` on the first
 * internal attendee: versioned, searchable, citable. The markdown is written in one fixed shape so
 * the brain can read it back (parseMeetingSummaryMarkdown) without a second store.
 *
 * Internal insights never enter `insight_items`, which is the customer Insights board: what the team
 * concluded is not what the market said.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeDocument, sectionText, type DocumentRow, type DocumentSection } from './documents.js';

export type SummaryScope = string;   // "company" | "account:<Name>"

export interface InternalMeetingSummary {
  summary: string[];
  accounts: { name: string; relationship: string; context: string }[];
  insights: { scope: SummaryScope; from?: string | null; group: string; points: string[] }[];
  decisions: { scope: SummaryScope; from?: string | null; topic: string; decision: string; owner: string | null; status: 'decided' | 'deferred'; quote: string | null }[];
  next_steps: { scope: SummaryScope; owner: string | null; action: string; due: string | null }[];
  open_issues: { scope: SummaryScope; issue: string }[];
}

export const INTERNAL_INSIGHT_GROUPS = [
  'Product', 'Market', 'Positioning', 'Pricing', 'Customers', 'Sales & Pipeline',
  'Distribution', 'Competitors', 'Team & Operations', 'Fundraising',
];

/** The prompt, as reviewed on 2026-09-25 (run on the 18 Sep two-founder call). */
export function buildInternalMeetingSummaryPrompt(input: {
  company: string; title: string; date?: string | null; participants: string[]; team?: string[]; transcript: string;
}): string {
  return [
    'ROLE',
    `You are the chief of staff at ${input.company}, preparing the official record of an internal meeting.`,
    'Every participant is on our team. The reader is an executive who did not attend and must know',
    'the outcome, the commitments and the open issues in under two minutes.',
    '',
    'MEETING',
    `${input.title}${input.date ? ` · ${input.date}` : ''} · Participants on record: ${input.participants.join(', ') || 'none recorded'}`,
    `Our team (anyone speaking is one of them): ${(input.team ?? []).join(', ') || 'not listed'}`,
    '',
    'HOW TO READ THE TRANSCRIPT',
    '- It is machine-transcribed. Speaker labels can be missing or wrong ("Them", "Speaker 2") and names',
    '  can be misspelled. Map every person to the names above; never invent a participant.',
    '- When a point is revisited, the LAST position taken is the one that counts. Record the final state,',
    '  not the path to it.',
    '- Merge repeats. Each point appears once, in the section where it belongs.',
    '',
    'DEFINITIONS (apply strictly)',
    '- DECISION: a choice between alternatives that the team committed to. It qualifies if it was explicitly',
    '  agreed, or stated by the accountable person without objection. An explicit postponement ("not now",',
    '  "after the demo", "park this") is a decision with status "deferred".',
    '  NOT a decision: an opinion, a proposal nobody agreed to, a fact, a task. Anything with a doer and a time',
    '  ("Theo lists the features today after lunch") is a NEXT STEP, never a decision.',
    '- INSIGHT: a conclusion about the business that holds beyond this meeting. Test: would it still be',
    '  worth knowing next month?',
    '- NEXT STEP: a specific action a named person accepted. Test: can someone check next week whether it',
    '  was done?',
    '- OPEN ISSUE: a question raised and not resolved, a blocker, or a risk someone named.',
    '- SCOPE: who or what an item applies to. Every insight, decision, next step and open issue has one.',
    '  "account:<Name>" = anything that describes or serves ONE customer or prospect: their people, data,',
    '  systems, region, needs and requests, and anything we build, configure or deliver for them alone',
    '  (their demo, their report, their import, their settings, a commitment to them).',
    '  "company" = a change to OUR product, process, positioning or pricing that applies to every client,',
    '  or a conclusion about our market. If one client prompted it, set "from" to that client; "from" is',
    '  only for company items.',
    '  Test: would this still be true or still be done if that client left tomorrow? Yes = company. No = account.',
    '  Examples, all account:Harborline: "remove the People page from Rowan\'s workspace" (one client\'s setup);',
    '  "the workspace is ready for Rowan by Monday" (a deadline to one client); "backfill 6 months of Harborline',
    '  data" (work on one client\'s data); "reports for Rowan are EU-only". Company: "the workspace shows',
    '  only active accounts" (how the product works for everyone); "the API plan is priced per task".',
    '  Before you file a decision under "company", check it names no client, no client person and no',
    '  client deadline. If it does, it is that client\'s.',
    '',
    'OUTPUT',
    'Return ONE JSON object with exactly these keys, in this order. No text outside the JSON.',
    '{',
    '  "summary": [string],',
    '  "accounts": [{ "name": string, "relationship": "customer"|"prospect"|"partner", "context": string }],',
    '  "insights": [{ "scope": string, "from": string|null, "group": string, "points": [string] }],',
    '  "decisions": [{ "scope": string, "from": string|null, "topic": string, "decision": string,',
    '                  "owner": string|null, "status": "decided"|"deferred", "quote": string }],',
    '  "next_steps": [{ "scope": string, "owner": string|null, "action": string, "due": string|null }],',
    '  "open_issues": [{ "scope": string, "issue": string }]',
    '}',
    '',
    'SECTION RULES',
    '1. summary: the most consequential points first. As many bullets as the meeting warrants: two for a',
    '   short check-in, up to eight for a dense working session. Never empty. Each bullet states an outcome,',
    '   a position or a fact, not a description of the discussion. Include every figure stated. A bullet',
    '   about one client names the client.',
    '   Write "Harborline demo set for Monday; EU-only reporting confirmed",',
    '   not "The team discussed the Harborline demo".',
    '   accounts: every customer, prospect or partner the meeting was about, with one line of context.',
    '   Name the COMPANY ("Harborline"), never a person ("Rowan"); put the person in the context line.',
    '   Use the same name in every scope ("account:Harborline"). Leave out a company nobody named.',
    '   (who they are to us, where the relationship stands). Competitors are NOT accounts; they belong in',
    '   insights under Competitors.',
    `2. insights: give each point its scope, then group it under one topic, using this vocabulary where it fits: ${INTERNAL_INSIGHT_GROUPS.join(', ')}.`,
    '   Create a new group (1-3 words) only when none fits. Include only groups that were discussed;',
    '   order groups by share of meeting time.',
    '3. decisions: "topic" is the question the decision answers (3-6 words). "decision" is the answer,',
    '   stated as the rule going forward. "owner" is who is accountable, if named. "quote" is the shortest',
    '   verbatim line (max 20 words) from the transcript that shows the commitment.',
    '4. next_steps: one action per item, starting with a verb. If two people share one action, list both',
    '   owners on one item ("Theo Bramwell, Avery Castellan"). "due" only if a date or day was said, as',
    '   YYYY-MM-DD, with the time after it if one was said ("2026-09-18 17:00"). "After this call", "right',
    '   away" or "today" is the meeting\'s own date.',
    '   A next step is new work. Do not restate a decision as a next step.',
    '5. open_issues: one sentence each, framed as the question or risk that remains.',
    '',
    'STANDARDS',
    '- Business executive register: declarative, specific, quantified. Conclusion first.',
    '- No narrative or chronology ("first they discussed", "then the conversation moved to").',
    '- No reported speech ("Theo said that Avery thought"). Attribute only owners of decisions and',
    '  next steps.',
    '- No evaluative adjectives ("great", "exciting", "crucial", "significant", "key").',
    '- One idea per bullet, one sentence, under 25 words.',
    '- Say whose it is. "Harborline\'s HubSpot holds 400+ loss reasons", never "HubSpot holds 400+ loss reasons".',
    '- Never infer or embellish. If it was not said, leave it out. An empty list is a valid answer.',
    '- Write in the language of the meeting.',
    '',
    'TRANSCRIPT',
    input.transcript.slice(0, 180_000),
  ].join('\n');
}

const str = (v: unknown) => String(v ?? '').trim();
const strs = (v: unknown, max = 12) => (Array.isArray(v) ? v : []).map(str).filter(Boolean).slice(0, max);
const scopeOf = (v: unknown): SummaryScope => {
  const s = str(v);
  const m = /^account\s*:\s*(.+)$/i.exec(s);
  return m ? `account:${m[1].trim()}` : 'company';
};
const rec = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/** The model's answer → a summary, or null when it cannot be read (not "an empty meeting"). */
export function parseInternalMeetingSummary(text: string): InternalMeetingSummary | null {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!o || typeof o !== 'object' || !Array.isArray(o.summary)) return null;
  const list = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(rec) : []);
  return {
    summary: strs(o.summary, 10),
    accounts: list('accounts').map(x => ({ name: str(x.name), relationship: str(x.relationship) || 'customer', context: str(x.context) })).filter(x => x.name),
    insights: list('insights').map(x => ({ scope: scopeOf(x.scope), from: str(x.from) || null, group: str(x.group), points: strs(x.points) })).filter(x => x.group && x.points.length),
    decisions: list('decisions').map(x => ({
      scope: scopeOf(x.scope), from: str(x.from) || null, topic: str(x.topic), decision: str(x.decision),
      owner: str(x.owner) || null, status: (str(x.status) === 'deferred' ? 'deferred' : 'decided') as 'decided' | 'deferred', quote: str(x.quote) || null,
    })).filter(x => x.decision),
    next_steps: list('next_steps').map(x => ({ scope: scopeOf(x.scope), owner: str(x.owner) || null, action: str(x.action), due: str(x.due) || null })).filter(x => x.action),
    open_issues: list('open_issues').map(x => ({ scope: scopeOf(x.scope), issue: str(x.issue) })).filter(x => x.issue),
  };
}

// ── The fixed markdown shape ────────────────────────────────────────────────
//
// Insights:   ### Our business | ### <Client>      (scope)
//             #### <Group>                          (topic)
//             - point  _(from Harborline)_
//             #### Decisions  → a table (Decision | Description | Owner | Status | Said)
//             #### Open issues
// Decisions:  a table (Decision | Description | Owner | Company | Said) — our own decisions only.
//
// Decisions are tables because a list of bold topics, dashes and block quotes read as noise
// (product decision, 2026-09-25); the quote stays, as its own column, so every decision still cites itself.

const OUR = 'Our business';
const clientOf = (scope: SummaryScope) => (scope.startsWith('account:') ? scope.slice('account:'.length) : null);
const fromTag = (from?: string | null) => (from ? ` _(from ${from})_` : '');
/** A table cell: one line, no pipes. */
const cell = (v: string | null | undefined) => String(v ?? '').replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim() || '—';
/** A quote as said: the model sometimes wraps it in its own quotes, which doubled them on the page. */
export const cleanQuote = (q: string | null | undefined) => String(q ?? '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
const said = (q: string | null | undefined) => (cleanQuote(q) ? `“${cell(cleanQuote(q))}”` : '—');

function companyDecisionTable(ds: InternalMeetingSummary['decisions']): string {
  return [
    '| Decision | Description | Owner | Company | Said |',
    '| --- | --- | --- | --- | --- |',
    ...ds.map(d => `| **${cell(d.topic || 'Decision')}** | ${d.status === 'deferred' ? '**Deferred.** ' : ''}${cell(d.decision)} | ${cell(d.owner)} | ${cell(d.from)} | ${said(d.quote)} |`),
  ].join('\n');
}

function clientDecisionTable(ds: InternalMeetingSummary['decisions']): string {
  return [
    '| Decision | Description | Owner | Status | Said |',
    '| --- | --- | --- | --- | --- |',
    ...ds.map(d => `| **${cell(d.topic || 'Decision')}** | ${cell(d.decision)} | ${cell(d.owner)} | ${d.status === 'deferred' ? 'Deferred' : 'Decided'} | ${said(d.quote)} |`),
  ].join('\n');
}

export function meetingSummarySections(m: InternalMeetingSummary): DocumentSection[] {
  const none = '_None._';
  const clients = [...new Set([
    ...m.insights.map(i => clientOf(i.scope)), ...m.decisions.map(d => clientOf(d.scope)), ...m.open_issues.map(o => clientOf(o.scope)),
  ].filter((c): c is string => !!c))];

  const groupBlock = (items: InternalMeetingSummary['insights']) => {
    const groups = new Map<string, string[]>();
    for (const i of items) groups.set(i.group, [...(groups.get(i.group) ?? []), ...i.points.map(p => `- ${p}${fromTag(i.from)}`)]);
    return [...groups].map(([g, pts]) => `#### ${g}\n${pts.join('\n')}`);
  };
  const insightParts: string[] = [];
  const ours = m.insights.filter(i => i.scope === 'company');
  if (ours.length) insightParts.push(`### ${OUR}\n${groupBlock(ours).join('\n\n')}`);
  for (const c of clients) {
    const scope = `account:${c}`;
    const blocks = groupBlock(m.insights.filter(i => i.scope === scope));
    const decs = m.decisions.filter(d => d.scope === scope);
    const issues = m.open_issues.filter(o => o.scope === scope);
    if (decs.length) blocks.push(`#### Decisions\n\n${clientDecisionTable(decs)}`);
    if (issues.length) blocks.push(`#### Open issues\n${issues.map(o => `- ${o.issue}`).join('\n')}`);
    if (blocks.length) insightParts.push(`### ${c}\n${blocks.join('\n\n')}`);
  }

  const companyDecisions = m.decisions.filter(d => d.scope === 'company');
  const companyIssues = m.open_issues.filter(o => o.scope === 'company');
  const sections: DocumentSection[] = [
    { label: 'Summary', body: m.summary.length ? m.summary.map(p => `- ${p}`).join('\n') : none },
  ];
  if (m.accounts.length) {
    sections.push({ label: 'Accounts', body: m.accounts.map(a => `- **${a.name}** (${a.relationship}) — ${a.context}`).join('\n') });
  }
  sections.push(
    { label: 'Insights', body: insightParts.length ? insightParts.join('\n\n') : none },
    { label: 'Decisions', body: companyDecisions.length ? companyDecisionTable(companyDecisions) : none },
    { label: 'Next steps', body: m.next_steps.length
      ? m.next_steps.map(n => `- ${n.owner ? `**${n.owner}** — ` : ''}${n.action}${n.due ? ` _(by ${n.due})_` : ''}${clientOf(n.scope) ? ` · ${clientOf(n.scope)}` : ''}`).join('\n')
      : none },
  );
  if (companyIssues.length) sections.push({ label: 'Open issues', body: companyIssues.map(o => `- ${o.issue}`).join('\n') });
  return sections;
}

/** What the brain reads back out of a stored summary: its company decisions and its insights by scope. */
export interface ParsedMeetingSummary {
  decisions: { topic: string; decision: string; meta: string | null; quote: string | null }[];
  insights: { scope: string; group: string; points: string[] }[];
}

const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const isTableRow = (line: string) => /^\s*\|/.test(line) && !/^\s*\|\s*-{3}/.test(line) && !/^\s*\|\s*Decision\s*\|/.test(line);
const unbold = (v: string) => v.replace(/^\*\*|\*\*$/g, '').replace(/^\*\*Deferred\.\*\*\s*/, '').trim();

export function parseMeetingSummarySections(sections: DocumentSection[]): ParsedMeetingSummary {
  const bodyOf = (label: string) => sectionText(sections.find(s => s.label === label) ?? { label, body: '' });
  const decisions: ParsedMeetingSummary['decisions'] = [];
  const lines = bodyOf('Decisions').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i])) {
      // | Decision | Description | Owner | Company | Said |
      const [topic, desc, owner, company, quote] = tableCells(lines[i]);
      const deferred = /^\*\*Deferred\.\*\*/.test(desc ?? '');
      const meta = [owner && owner !== '—' ? owner : null, deferred ? 'Deferred' : null, company && company !== '—' ? `from ${company}` : null].filter(Boolean).join(' · ');
      decisions.push({ topic: unbold(topic ?? ''), decision: unbold(desc ?? ''), meta: meta || null, quote: quote && quote !== '—' ? cleanQuote(quote) : null });
      continue;
    }
    // The list shape the first summaries were written in.
    const m = /^- \*\*(.+?)\*\* — (.+?)(?: _\((.+)\)_)?$/.exec(lines[i]);
    if (!m) continue;
    const q = /^\s*> (.*)\s*$/.exec(lines[i + 1] ?? '');
    decisions.push({ topic: m[1], decision: m[2], meta: m[3] ?? null, quote: q ? cleanQuote(q[1]) : null });
  }
  const insights: ParsedMeetingSummary['insights'] = [];
  let scope = '', group = '';
  const push = (text: string) => {
    const last = insights[insights.length - 1];
    if (last && last.scope === scope && last.group === group) last.points.push(text);
    else insights.push({ scope, group, points: [text] });
  };
  for (const l of bodyOf('Insights').split('\n')) {
    const h3 = /^###\s+(.+)$/.exec(l);
    const h4 = /^####\s+(.+)$/.exec(l);
    if (h3 && !l.startsWith('####')) { scope = h3[1].trim(); group = ''; continue; }
    if (h4) { group = h4[1].trim(); continue; }
    if (!scope || !group) continue;
    if (isTableRow(l)) {
      const [topic, desc, owner, status] = tableCells(l);
      push(`${unbold(topic ?? '')} — ${unbold(desc ?? '')}${[owner !== '—' ? owner : null, status === 'Deferred' ? 'Deferred' : null].filter(Boolean).length ? ` _(${[owner !== '—' ? owner : null, status === 'Deferred' ? 'Deferred' : null].filter(Boolean).join(' · ')})_` : ''}`);
      continue;
    }
    const p = /^- (.+)$/.exec(l);
    if (p) push(p[1]);
  }
  return { decisions, insights };
}

export const OUR_BUSINESS = OUR;

const seriesFor = (sourceRef: string) => `internal:${sourceRef}`;

/**
 * Save a call's summary. A re-run replaces the previous one as its next version. `supersede: false`
 * because a call summary otherwise supersedes by subject, and two meetings on the same teammate are
 * two meetings, not two versions of one.
 */
export async function saveInternalMeetingSummary(
  supabase: SupabaseClient, workspaceId: string,
  input: { sourceRef: string; title: string; occurredAt?: string | null; subjectEntityId: string; summary: InternalMeetingSummary; system?: string | null },
): Promise<DocumentRow> {
  const series = seriesFor(input.sourceRef);
  const { data: prev, error } = await supabase.from('documents').select('id, version')
    .eq('workspace_id', workspaceId).eq('kind', 'call_summary').eq('series', series).eq('status', 'live')
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  const doc = await writeDocument(supabase, workspaceId, {
    kind: 'call_summary',
    title: input.title,
    headline: input.summary.summary[0] ?? null,
    sections: meetingSummarySections(input.summary),
    subjectEntityId: input.subjectEntityId,
    series,
    periodStart: input.occurredAt ?? null,
    periodEnd: input.occurredAt ?? null,
    generatedFrom: input.system ? [input.system] : [],
    writtenBy: 'routine',
    skill: 'internal-meeting-summary',
    sources: [{ system: input.system ?? 'Recording', ref: input.sourceRef, detail: input.title, when: input.occurredAt ?? null }],
    supersede: false,
  });
  if (prev?.[0]) {
    const now = new Date().toISOString();
    const { error: e1 } = await supabase.from('documents').update({ status: 'superseded', updated_at: now })
      .eq('workspace_id', workspaceId).eq('id', prev[0].id);
    if (e1) throw e1;
    const { error: e2 } = await supabase.from('documents').update({ supersedes_id: prev[0].id, version: prev[0].version + 1 })
      .eq('workspace_id', workspaceId).eq('id', doc.id);
    if (e2) throw e2;
  }
  return doc;
}

/** The live summaries for a set of calls, by source_ref. Batched: a `.in()` over hundreds is a URL too long. */
export async function internalMeetingSummaries(
  supabase: SupabaseClient, workspaceId: string, sourceRefs: string[],
): Promise<Map<string, DocumentRow>> {
  const out = new Map<string, DocumentRow>();
  const series = [...new Set(sourceRefs)].map(seriesFor);
  for (let i = 0; i < series.length; i += 100) {
    const { data, error } = await supabase.from('documents')
      .select('id, title, headline, sections, series, version, created_at, updated_at, status, kind, word_count')
      .eq('workspace_id', workspaceId).eq('kind', 'call_summary').eq('status', 'live').in('series', series.slice(i, i + 100));
    if (error) throw error;
    for (const d of data ?? []) out.set(String(d.series).slice('internal:'.length), d as unknown as DocumentRow);
  }
  return out;
}
