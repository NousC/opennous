// WHOSE SIDE IS THIS PERSON ON — answered once, for the whole system (GET-291).
//
// Four bugs in one day came from this question being answered locally, four different ways: calls
// filed on a sibling company, calls filed on the seller's own employee, a customer call dropped
// as "internal", and two customers' calls merged because the only attendee they shared was the CS
// manager who ran both. Each site derived "ours?" from whatever was nearby — the host's email
// domain, a seat lookup, a contact's company row. Each fix passed its tests and the next symptom
// appeared somewhere else.
//
// The fact now has one home, derived from evidence we already hold rather than configuration
// somebody has to remember to fill in:
//
//   seats           — a member login on a corporate domain. One customer's owner is rowan@harborline.example.
//   source accounts — the address a connected source authenticates as. Fellow's is nous@harborline.example.
//
// A domain counts as ours only when TWO independent sources agree, or a person says so. One source
// is a coincidence — a single freelancer seat on a client's domain would otherwise make that
// client's whole staff "internal" and delete them from the pipeline.
//
// Free mail is never a domain: gmail.com as "ours" would swallow half the graph. That is also why
// the two admin seats on this workspace (a gmail and a gmx address) correctly contribute nothing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isFreeEmailDomain, emailDomain } from '../utils/identity.js';

export type DomainSource = 'seat' | 'source_account' | 'manual';

export interface OwnDomainCandidate {
  domain: string;
  sources: DomainSource[];
  evidence: string[];       // the addresses that argued for it, for a human reading the decision
}

// `emailDomain` comes from utils/identity: one rule for "the domain half of an address", already
// used across the codebase and already stripping `www.`. A second copy here is exactly the kind of
// near-duplicate that let four call sites disagree in the first place.

/**
 * The domains this workspace's own people use, from the evidence in the database.
 *
 * Returns every CANDIDATE with the sources behind it — deciding which ones qualify is
 * `qualifyingDomains`, kept separate so the rule can be read and tested without a database.
 */
export async function gatherOwnDomainEvidence(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<OwnDomainCandidate[]> {
  const byDomain = new Map<string, OwnDomainCandidate>();
  const add = (email: string | null | undefined, source: DomainSource) => {
    const d = emailDomain(email);
    if (!d || isFreeEmailDomain(d)) return;
    const c = byDomain.get(d) ?? { domain: d, sources: [], evidence: [] };
    if (!c.sources.includes(source)) c.sources.push(source);
    const addr = String(email).toLowerCase().trim();
    if (!c.evidence.includes(addr)) c.evidence.push(addr);
    byDomain.set(d, c);
  };

  // 1. Seats. A person who can sign in to this workspace works here.
  const { data: members } = await supabase
    .from('workspace_members')
    .select('user_id, users(email)')
    .eq('workspace_id', workspaceId);
  for (const m of (members ?? []) as { users?: { email?: string } | { email?: string }[] }[]) {
    const u = Array.isArray(m.users) ? m.users[0] : m.users;
    add(u?.email, 'seat');
  }

  // 2. The addresses connected sources authenticate as. A note-taker's API key belongs to the
  //    company that pays for it, so the account it reports is the company's own.
  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('account_email')
    .eq('workspace_id', workspaceId)
    .eq('is_verified', true);
  for (const c of (conns ?? []) as { account_email?: string | null }[]) {
    add(c.account_email, 'source_account');
  }

  return [...byDomain.values()];
}

/**
 * Which candidates actually count as ours.
 *
 * Two independent sources, or a person said so. Pure, so the rule that decides whether dozens of people
 * become "internal" can be read in one place and tested without a database.
 */
export function qualifyingDomains(candidates: OwnDomainCandidate[]): OwnDomainCandidate[] {
  return (candidates ?? []).filter(c =>
    c.sources.includes('manual') || new Set(c.sources).size >= 2);
}

/** Record the qualifying domains. Idempotent: re-running merges sources rather than duplicating. */
export async function saveOwnDomains(
  supabase: SupabaseClient,
  workspaceId: string,
  domains: OwnDomainCandidate[],
): Promise<void> {
  if (!domains.length) return;
  const rows = domains.map(d => ({
    workspace_id: workspaceId,
    domain: d.domain,
    sources: d.sources,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('workspace_own_domains')
    .upsert(rows, { onConflict: 'workspace_id,domain' });
  if (error) throw new Error(`failed to save own domains: ${error.message}`);
}

/**
 * The workspace's own domains.
 *
 * A failed read THROWS rather than returning an empty set. An empty set means "nobody here is ours",
 * which turns a company's own staff back into customers — the exact failure this module exists to
 * end. Callers that can tolerate not knowing must say so explicitly by catching.
 */
export async function loadOwnDomains(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('workspace_own_domains')
    .select('domain')
    .eq('workspace_id', workspaceId);
  if (error) throw new Error(`failed to load own domains: ${error.message}`);
  return new Set((data ?? []).map((r: { domain: string }) => String(r.domain).toLowerCase()));
}

/** Is this address one of ours? The one question, in one place. */
export function isOwnEmail(email: string | null | undefined, ownDomains: Set<string> | null | undefined): boolean {
  if (!(ownDomains instanceof Set) || ownDomains.size === 0) return false;
  const d = emailDomain(email);
  return !!d && ownDomains.has(d);
}

/**
 * Work out the workspace's own domains from the evidence, record them, and mark the people on
 * those domains internal. Returns what it found so a caller can print or log it.
 *
 * Lives in core because BOTH the API and the worker need it: the worker sweeps hourly, and connect
 * runs it before the first ingest — a new workspace must know who it is before it files anything,
 * or its first meetings land wrong and self-correct an hour later, which is exactly the window a
 * client forms their first impression in.
 *
 * `markEntityInternal` is imported lazily to keep this module free of a cycle with teamMembers.
 */
export async function recogniseOwnPeople(
  supabase: SupabaseClient,
  workspaceId: string,
  { dryRun = false, confirm = null }: { dryRun?: boolean; confirm?: string | null } = {},
): Promise<{
  candidates: OwnDomainCandidate[];
  qualifying: OwnDomainCandidate[];
  people: Map<string, string>;
  toMark: [string, string][];
  marked: number;
}> {
  const { markEntityInternal, getInternalEntityIds } = await import('./teamMembers.js');

  const candidates = await gatherOwnDomainEvidence(supabase, workspaceId);
  if (confirm) {
    const d = String(confirm).toLowerCase().trim();
    const hit = candidates.find(c => c.domain === d);
    if (hit) { if (!hit.sources.includes('manual')) hit.sources.push('manual'); }
    else candidates.push({ domain: d, sources: ['manual'], evidence: ['(named by hand)'] });
  }

  const qualifying = qualifyingDomains(candidates);
  const empty = { candidates, qualifying, people: new Map<string, string>(), toMark: [] as [string, string][], marked: 0 };
  if (!qualifying.length) return empty;

  const domains = new Set(qualifying.map(q => q.domain));
  const people = new Map<string, string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('entity_identifiers')
      .select('entity_id, value')
      .eq('workspace_id', workspaceId)
      .eq('kind', 'email')
      .eq('status', 'active')
      // Ordered, or the pages are not pages: without it two runs returned 41 and 47 addresses where
      // the truth was 50 — rows repeating on one page and missing from another.
      .order('entity_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`identifier read failed: ${error.message}`);
    for (const row of (data ?? []) as { entity_id: string; value: string }[]) {
      const email = String(row.value || '').toLowerCase();
      if (domains.has(emailDomain(email) ?? '') && !people.has(row.entity_id)) people.set(row.entity_id, email);
    }
    if ((data ?? []).length < PAGE) break;
  }

  const already = await getInternalEntityIds(supabase, workspaceId).catch(() => new Set<string>());
  const toMark = [...people.entries()].filter(([id]) => !already.has(id)) as [string, string][];
  if (dryRun) return { candidates, qualifying, people, toMark, marked: 0 };

  await saveOwnDomains(supabase, workspaceId, qualifying);
  let marked = 0;
  for (const [entityId] of toMark) {
    try { await markEntityInternal(supabase, workspaceId, entityId); marked++; }
    catch { /* one bad row must not stop the rest */ }
  }
  return { candidates, qualifying, people, toMark, marked };
}
