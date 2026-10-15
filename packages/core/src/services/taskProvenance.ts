// Where a task came from, who it is for, and which deal it belongs to — stamped ON WRITE.
//
// A task row used to be a bare instruction: "Sabine to send data-warehouse sign-up information."
// Everything a reader needs to act on it was in the extractor's hands at the moment it was
// written — the call's title and date, the link back to the note-taker, the person who asked,
// the person waiting on it, the account's open deal — and only the source ID survived.
//
// Recovering any of that on READ is a lookup per task against a table of well over a hundred thousand rows (GET-385
// measured it; the obvious `raw->>thread_id` query has no index and times out on its own). So
// the rule is: the writer stamps it once, for free, and the reader renders what is on the row.
// Every field here is optional. A task written before this exists still renders; it just says
// less.
//
// Three writers share this shape: the call health read (callScore.mjs), the Gmail Read
// (noema/gmailRead.mjs) and the message action-item miner (signals/index.mjs). They agree on
// the field names by importing this file, not by convention.

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadDealCandidates } from './crmAgent.js';

/** The provenance fields on an `action_item.*` claim value. All optional; all additive. */
export interface TaskProvenanceFields {
  /** One sentence of context: what exactly, and why. Never a restatement of the title. */
  description: string | null;
  /** The person waiting on it, as named in the source. */
  for_name: string | null;
  /** That person's entity, when a name on the call resolves to exactly one contact. */
  for_entity_id: string | null;
  /** Who raised it — the asker, not the owner. "Torben asked" on a task Sabine owes. */
  asked_by: string | null;
  /** The source, as a person would name it: the call's title, the email's subject. */
  source_title: string | null;
  /** A link back to the source system (the Fellow/Fireflies page, the thread), when one exists. */
  source_url: string | null;
  /** When it was SAID — the call's date, the message's send time. Not when we extracted it. */
  occurred_at: string | null;
  /** The deal it belongs to, and how that was decided. */
  deal_id: string | null;
  deal_link: DealLink | null;
}

/**
 * How a task came to be on a deal.
 *   filed          — the source conversation was filed to this deal in the CRM (observation_deals)
 *   only_open_deal — the account had exactly one open deal when the task was written
 * Null means we did not guess: an account with two open deals gets no deal on its tasks, and the
 * deal page shows them as "on the account, not filed to this deal", the way Conversations does.
 */
export type DealLink = 'filed' | 'only_open_deal';

const clean = (v: unknown, max = 400): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** A blank provenance block. Writers spread this first so every field is present, even as null. */
export function emptyTaskProvenance(): TaskProvenanceFields {
  return {
    description: null, for_name: null, for_entity_id: null, asked_by: null,
    source_title: null, source_url: null, occurred_at: null, deal_id: null, deal_link: null,
  };
}

/**
 * Tidy a model's answers into the stored shape. The model is asked for `context`, `for` and
 * `asked_by` in its own words; this is where they are trimmed and where a description that just
 * repeats the title is dropped rather than shown twice.
 */
export function provenanceFromModel(
  raw: { context?: unknown; for?: unknown; asked_by?: unknown } | null | undefined,
  title: string | null | undefined,
): Pick<TaskProvenanceFields, 'description' | 'for_name' | 'asked_by'> {
  const description = clean(raw?.context);
  const t = clean(title)?.toLowerCase() ?? '';
  return {
    description: description && description.toLowerCase() !== t ? description : null,
    for_name: clean(raw?.for, 120),
    asked_by: clean(raw?.asked_by, 120),
  };
}

/** A person as the writers know them: whatever the `contacts` projection or the call roster gives. */
export interface NamedPerson {
  id?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

const fullName = (p: NamedPerson): string =>
  clean(p.name) ?? [p.first_name, p.last_name].filter(Boolean).join(' ').trim();

/**
 * The one person a name refers to, or null.
 *
 * "Torben" resolves when exactly one Torben is on the call; "Torben Ashdown" resolves against the
 * full name. Two Johns resolve to nobody — a wrong "for" is worse than none, because the row would
 * then say, with confidence, that a task is for a person it was never about.
 */
export function matchPersonByName(name: string | null | undefined, people: NamedPerson[]): NamedPerson | null {
  const n = clean(name)?.toLowerCase();
  if (!n) return null;
  const tokens = n.split(/\s+/);
  const one = (xs: NamedPerson[]) => (xs.length === 1 ? xs[0] : null);
  // A full name: the person whose full name it is, or whose name it begins ("Torben A" → Torben Ashdown).
  if (tokens.length > 1) {
    return one(people.filter(p => fullName(p).toLowerCase() === n))
      ?? one(people.filter(p => fullName(p).toLowerCase().startsWith(n)));
  }
  // A first name alone: everyone whose first name it is. Two of them, and it is nobody.
  return one(people.filter(p => fullName(p).toLowerCase().split(/\s+/)[0] === n));
}

/**
 * Which deal a task belongs to, decided from the account at write time.
 *
 * `filedDealIds` is what the CRM says about the SOURCE conversation (observation_deals). When
 * the rep filed the call or the thread to one deal, the task follows it. Otherwise the account's
 * open deals decide: exactly one, and the task is on it; none or several, and the task stays on
 * the account with no deal — the deal page can still show it, marked as not filed.
 */
export async function dealForTask(
  supabase: SupabaseClient,
  workspaceId: string,
  { companyEntityId, filedDealIds = [] }: { companyEntityId: string | null | undefined; filedDealIds?: string[] },
): Promise<{ deal_id: string | null; deal_link: DealLink | null }> {
  const filed = [...new Set(filedDealIds.filter(Boolean))];
  if (filed.length === 1) return { deal_id: filed[0], deal_link: 'filed' };
  if (!companyEntityId) return { deal_id: null, deal_link: null };
  try {
    const candidates = await loadDealCandidates(supabase, workspaceId, companyEntityId);
    return pickOnlyOpenDeal(candidates.map(c => ({ id: c.dealEntityId, status: c.status })));
  } catch {
    return { deal_id: null, deal_link: null };
  }
}

/** The pure half of dealForTask: one open deal → that deal; anything else → no guess. */
export function pickOnlyOpenDeal(
  deals: { id: string; status: string | null | undefined }[],
): { deal_id: string | null; deal_link: DealLink | null } {
  const open = deals.filter(d => (d.status ?? 'open') === 'open');
  if (open.length === 1) return { deal_id: open[0].id, deal_link: 'only_open_deal' };
  return { deal_id: null, deal_link: null };
}

/** The company a contact belongs to, for writers that hold only the person. */
export async function companyOfContact(supabase: SupabaseClient, workspaceId: string, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null;
  const { data } = await supabase.from('contacts').select('company_id')
    .eq('workspace_id', workspaceId).eq('id', contactId).maybeSingle();
  return (data as { company_id?: string | null } | null)?.company_id ?? null;
}
