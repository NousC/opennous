// What the account is doing, for the reader of one conversation (GET-1033).
//
// The extractor saw a conversation and nothing else about the account, so it read every line on its
// own: a customer comparing two data sources for the bot they built was filed as "evaluating a
// competitor" with their own bot as the competitor, and "no tool is a silver bullet" became an
// objection. A rep reading the same line knows the account. This is that knowledge, built from what
// is already on file (no model call): who they are, the people, their stack and their own tools,
// and what they are doing with us. It is context for reading, never a source of facts.
import { listNotes, teamReadContext } from '@nous/core';

const BRIEF_CHARS = 2500;
const PEOPLE = 10;
const STACK = 8;
const WITH_US = 6;
// What they are doing with us: the reasons they are here and where the deal stands.
const WITH_US_CATEGORIES = new Set(['goal', 'pain', 'buying_signal', 'requirement', 'use_case', 'timeline']);

const day = (ts) => (ts ? String(ts).slice(0, 10) : 'undated');

/** The brief as prompt text, or '' when nothing is on file. Pure. */
export function buildAccountBrief({ account = null, people = [], notes = [] } = {}) {
  const live = (notes ?? []).filter(n => n && !n.superseded_by && n.content && n.freshness !== 'expired' && !n.metadata?.doc_type)
    .sort((a, b) => String(b.said_at ?? '').localeCompare(String(a.said_at ?? '')));
  const lines = [];
  if (account?.name) {
    const bits = [account.industry, account.stage ? `deal stage: ${account.stage}` : null].filter(Boolean);
    lines.push(`Account: ${account.name}${bits.length ? ` (${bits.join(', ')})` : ''}`);
  }
  const ppl = (people ?? []).filter(p => p?.name).slice(0, PEOPLE);
  if (ppl.length) lines.push(`People on file: ${ppl.map(p => `${p.name}${p.job_title ? `, ${p.job_title}` : ''}`).join('; ')}`);
  const seen = new Set();
  const stack = live.filter(n => n.category === 'tech_stack').filter(n => {
    const k = String(n.metadata?.tool ?? n.label ?? n.content).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, STACK);
  if (stack.length) lines.push(`Their stack and their own tools:\n${stack.map(n => `- ${n.content}`).join('\n')}`);
  const withUs = live.filter(n => WITH_US_CATEGORIES.has(n.category)).slice(0, WITH_US);
  if (withUs.length) lines.push(`What they are doing with us:\n${withUs.map(n => `- [${day(n.said_at)}] ${n.content}`).join('\n')}`);
  const text = lines.join('\n');
  return text.length > BRIEF_CHARS ? `${text.slice(0, BRIEF_CHARS)} …` : text;
}

/** The prompt block, or '' when there is no brief. Pure. */
export function accountBriefBlock(brief) {
  if (!brief) return '';
  return `ACCOUNT CONTEXT — what is already known about this account. Read every statement below in the light of it: what they are building, which tools are their own, who is who. It is context only: never record a fact from it.
<<<
${brief}
>>>

`;
}

/** The brief for a person and their account, from what is on file. '' on any failure. */
export async function loadAccountBrief(supabase, workspaceId, { contactId = null, companyId = null } = {}) {
  try {
    const ids = [contactId, companyId].filter(Boolean);
    if (!ids.length) return '';
    const [{ data: acct }, { data: people }, notes] = await Promise.all([
      companyId
        ? supabase.from('entity_list_rows').select('name, industry, stage').eq('workspace_id', workspaceId).eq('entity_id', companyId).maybeSingle()
        : Promise.resolve({ data: null }),
      companyId
        ? supabase.from('entity_list_rows').select('name, job_title').eq('workspace_id', workspaceId).eq('kind', 'person').eq('company_id', companyId)
          .order('last_activity_at', { ascending: false, nullsFirst: false }).limit(PEOPLE)
        : Promise.resolve({ data: [] }),
      listNotes(supabase, workspaceId, { entityIds: ids, limit: 300 }, teamReadContext(workspaceId)).catch(() => []),
    ]);
    return buildAccountBrief({ account: acct, people: people ?? [], notes });
  } catch (err) {
    console.warn('[ACCOUNT_BRIEF] failed:', err?.message ?? err);
    return '';
  }
}
