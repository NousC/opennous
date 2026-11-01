// Who a mailbox actually talks to (GET-1087), with no model.
//
// A workspace with no CRM and no notetaker has nobody in the graph, and the Gmail sweep only files
// mail against people already there, so the sync would file nothing. A conversation is two-way: we
// wrote to them AND they wrote back. Requiring both is what keeps newsletters, cold pitches and
// everyone we mailed once out of the graph, and it means each person we create lands on People,
// which only shows people who answered. Internal and automated addresses go through the same
// filters live mail uses; creating the person and the account is resolveContact's job.

import { isFreeEmailDomain, loadOwnDomains, getInternalIdentities, syncOnlyStore } from '@nous/core';
import { isBulkEmail, machineSenderReason, isRoleInbox } from '../utils/emailIdentity.mjs';
import { nameFromEmail } from '../utils/resolveMeeting.mjs';
import { resolveContact } from '../utils/resolveContact.mjs';

// The busiest people first; a mailbox rarely reaches this and the search queries are bounded by it.
export const MAX_DISCOVERED = 2000;

const ADDRESS_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const addressesIn = (v) => (Array.isArray(v) ? v.join(',') : String(v ?? '')).match(ADDRESS_RE)?.map(a => a.toLowerCase()) ?? [];

/** An address that can be a person outside the team. Pure. */
export function isExternalPerson(address, { internal = new Set(), ownDomains = new Set() } = {}) {
  const a = String(address ?? '').toLowerCase();
  const domain = a.split('@')[1];
  if (!domain || internal.has(a)) return false;
  if (ownDomains.has(domain) && !isFreeEmailDomain(domain)) return false;
  if (machineSenderReason(a) || isBulkEmail(null, a)) return false;
  return !isRoleInbox(a);
}

/** The outside people this mailbox wrote to, busiest first. Pure. */
export function sentCounterparts(messages, scope) {
  const counts = new Map();
  for (const m of messages) {
    for (const a of new Set(addressesIn([m.to, m.recipients, m.cc].flat().filter(Boolean)))) {
      if (isExternalPerson(a, scope)) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DISCOVERED).map(([a]) => a);
}

/** "Mara Velde <mara@x.example>" → "Mara Velde". Pure. */
export function displayName(header) {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>/.exec(String(header ?? ''));
  const name = m?.[1]?.trim();
  return name && !name.includes('@') ? name : null;
}

/** Of the people we wrote to, who wrote back, and under what name. Pure. Map<address, name|null>. */
export function repliedAmong(messages, candidates) {
  const wanted = new Set(candidates);
  const out = new Map();
  for (const m of messages) {
    const labels = [].concat(m.labelIds ?? m.label_ids ?? []).map(String);
    if (labels.includes('SENT') || labels.includes('CATEGORY_PROMOTIONS')) continue;
    const sender = m.sender ?? m.from ?? '';
    const [from] = addressesIn(sender);
    if (!from || !wanted.has(from)) continue;
    const name = displayName(sender);
    if (!out.has(from) || (name && !out.get(from))) out.set(from, name);
  }
  return out;
}

/** The team's addresses and domains, for the filters above. */
export async function internalScope(supabase, workspaceId, mailbox) {
  const internal = new Set(mailbox ? [String(mailbox).toLowerCase()] : []);
  for (const idy of await getInternalIdentities(supabase, workspaceId).catch(() => [])) {
    if (idy.kind === 'email' && idy.value) internal.add(String(idy.value).trim().toLowerCase());
  }
  const ownDomains = await loadOwnDomains(supabase, workspaceId).catch(() => new Set());
  const own = String(mailbox ?? '').split('@')[1]?.toLowerCase();
  if (own && !isFreeEmailDomain(own)) ownDomains.add(own);
  return { internal, ownDomains };
}

/**
 * Create the people in a conversation and put them on the run's store, so this run's filing can
 * see them before they have the inbound email that makes them show on the contacts view.
 * Returns how many were created. resolveContact creates the account from the domain and matches
 * an existing person first, so a re-run creates nobody twice.
 */
export async function createConversationPeople(supabase, workspaceId, people) {
  const store = syncOnlyStore();
  let created = 0;
  for (const [email, name] of people) {
    const nm = name || nameFromEmail(email) || '';
    const [first_name, ...rest] = nm.split(/\s+/).filter(Boolean);
    if (!first_name || first_name.length < 2) continue;   // never an email-only record
    try {
      const r = await resolveContact(supabase, workspaceId,
        { email, first_name, last_name: rest.join(' ') || null, source: 'gmail' }, { createIfMissing: true });
      if (r?.contact?.id) store?.discovered.set(email, { id: r.contact.id, company_id: r.contact.company_id ?? null });
      if (r?.created) created++;
    } catch (e) { console.warn('[MAIL_DISCOVERY] create failed:', e?.message || e); }
  }
  return created;
}
