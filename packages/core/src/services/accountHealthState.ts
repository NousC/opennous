import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountHealth } from './accountHealth.js';
import { claimDomainOf } from '../db/claimCategories.js';

// What state an account is in, and WHY (GET-290).
//
// The first version stamped `account_health` onto the account: the last customer call overwrote it.
// Right for one call, wrong for an account — a risk raised in March vanished because an unrelated
// training call happened in June, and a risk nobody has mentioned since January would have stood
// forever.
//
// So health is a PROJECTION over claims, like everything else in the graph. Each customer call
// writes its signals as ordinary categorised claims (the same `saveNote` path extraction uses);
// standing is DERIVED from the open ones, with decay. That makes it explainable by construction —
// "at risk because these two things, said on these dates" — and it makes a resolved risk resolve
// itself by simply not being said again.
//
// Pure derivation here; the reader below is the ONE function every surface calls. Two places
// computing "health" slightly differently is the most expensive bug shape we have.

/** How a health signal is tagged on the claim, so health can find its own among all facts. */
export const HEALTH_SIGNAL = {
  risk: 'health_risk',
  expansion: 'health_expansion',
  adoption: 'health_adoption',
} as const;

export type HealthSignalKind = keyof typeof HEALTH_SIGNAL;

/**
 * The claim category each kind is filed under.
 *
 * Until GET-401 these were BORROWED: risk went in as `pain`, expansion as `buying_signal`, adoption
 * as `status_quo`, with the real kind hidden in `metadata.signal_type`. The Intel tab then showed
 * "Corwin formally cancelled" as a Pain and "Add-on-Module" as a Buying Signal on an account that
 * had bought years ago — and `buying_signal` is read by name by the stage worker, so a customer's
 * expansion ask was nudging a pipeline it is not in. The taxonomy now has a home for each kind, so
 * the category says what the tag used to. The tag is still stamped for readers written before the
 * categories existed; the reader below switches to the category in GET-402.
 */
export const HEALTH_CATEGORY: Record<HealthSignalKind, string> = {
  risk: 'risk_signal',
  expansion: 'expansion_signal',
  adoption: 'adoption',
};

export interface HealthDriver {
  kind: HealthSignalKind;
  text: string;
  quote: string;
  at: string;              // when the call happened, not when we wrote it
  sourceRef: string | null;
}

export interface DerivedHealth {
  standing: 'positive' | 'neutral' | 'at_risk';
  /** Why it stands there — newest first. Empty when nothing is open. */
  drivers: HealthDriver[];
  risks: HealthDriver[];
  expansion: HealthDriver[];
  adoption: HealthDriver[];
  /** The most recent customer call we read for this account. */
  lastReadAt: string | null;
  /** Signals older than the window, kept out of standing but worth showing as history. */
  staleCount: number;
}

/**
 * How long a signal speaks for.
 *
 * A risk nobody has repeated in four months is history, not a live problem — a CS lead who sees
 * January's churn scare on today's list stops trusting the list. An expansion ask goes stale faster:
 * "could we add the second rooftop" is a live opening for a quarter, not a year.
 */
export const HEALTH_WINDOW_DAYS: Record<HealthSignalKind, number> = {
  risk: 120,
  expansion: 90,
  adoption: 180,
};

const DAY = 86_400_000;

/** Derive an account's standing from its health signals. Pure — the same input always answers the same. */
export function deriveAccountHealth(signals: HealthDriver[], now: Date = new Date()): DerivedHealth {
  const fresh: Record<HealthSignalKind, HealthDriver[]> = { risk: [], expansion: [], adoption: [] };
  let stale = 0;
  let lastReadAt: string | null = null;

  for (const s of signals) {
    const t = Date.parse(s.at);
    if (!Number.isFinite(t)) continue;
    if (!lastReadAt || s.at > lastReadAt) lastReadAt = s.at;
    const ageDays = (now.getTime() - t) / DAY;
    if (ageDays > HEALTH_WINDOW_DAYS[s.kind]) { stale++; continue; }
    fresh[s.kind].push(s);
  }

  const newestFirst = (a: HealthDriver, b: HealthDriver) => b.at.localeCompare(a.at);
  for (const k of Object.keys(fresh) as HealthSignalKind[]) fresh[k].sort(newestFirst);

  // An open risk decides the standing on its own: an account with a live churn signal is not
  // "positive" because someone also asked about a second site. Expansion only lifts an account
  // that has nothing against it.
  const standing: DerivedHealth['standing'] =
    fresh.risk.length ? 'at_risk' : fresh.expansion.length ? 'positive' : 'neutral';

  return {
    standing,
    drivers: [...fresh.risk, ...fresh.expansion].sort(newestFirst),
    risks: fresh.risk,
    expansion: fresh.expansion,
    adoption: fresh.adoption,
    lastReadAt,
    staleCount: stale,
  };
}

/** The claims one health read contributes, ready for `saveNote`. */
export function healthSignalsToSave(
  health: AccountHealth,
  opts: { at: string; sourceRef?: string | null; source?: string },
): { kind: HealthSignalKind; category: string; content: string; quote: string }[] {
  const out: { kind: HealthSignalKind; category: string; content: string; quote: string }[] = [];
  for (const r of health.risks) out.push({ kind: 'risk', category: HEALTH_CATEGORY.risk, content: r.text, quote: r.quote });
  for (const e of health.expansion) out.push({ kind: 'expansion', category: HEALTH_CATEGORY.expansion, content: e.text, quote: e.quote });
  // Adoption is one sentence about how they use it, not a list — file it as the account's status quo.
  if (health.adoption) out.push({ kind: 'adoption', category: HEALTH_CATEGORY.adoption, content: health.adoption, quote: '' });
  return out;
}

/**
 * A departure is a risk, and it is the one risk that arrives without a health read.
 *
 * Every other signal here comes from a business review or a training call — someone sat down and
 * read the account. A staff change arrives in the middle of any conversation ("Torvald left last
 * month"), and it is the classic churn signal: the person who chose us is gone, and the person who
 * replaced them did not.
 *
 * Only `left` counts. A new hire is training demand and a reorganisation resets relationships;
 * neither should turn an account red, and treating them as risk would make the standing useless
 * within a week.
 *
 * It decays on the risk window like everything else, which is right: a departure does not un-happen,
 * but its risk fades as the relationship re-forms. If this proves noisy the refinement is to count
 * only departures of people who held authority — that needs the claim-to-claim link from GET-326,
 * and is deliberately not guessed at here.
 */
function departureAsRisk(value: any, fallbackAt: string | null): HealthDriver | null {
  if (String(value?.category ?? '') !== 'staff_change') return null;
  const meta = value?.metadata ?? {};
  if (String(meta.change ?? '') !== 'left') return null;
  const text = String(value?.content ?? '').trim();
  const at = String(meta.occurred_at ?? fallbackAt ?? '');
  if (!text || !at) return null;
  return { kind: 'risk', text, quote: String(meta.quote ?? '').trim(), at, sourceRef: meta.source_ref ? String(meta.source_ref) : null };
}

const KIND_BY_TAG: Record<string, HealthSignalKind> = {
  [HEALTH_SIGNAL.risk]: 'risk',
  [HEALTH_SIGNAL.expansion]: 'expansion',
  [HEALTH_SIGNAL.adoption]: 'adoption',
};

/**
 * Which health kind a claim is, read off the claim (GET-402).
 *
 * The CATEGORY decides since GET-401: `risk_signal` is a risk and `expansion_signal` an opening,
 * whoever wrote them — a Fellow health read, the CRM-corpus miner, or Noema on a plain inbound
 * email. The tag decides only where the category cannot: `adoption` is also an ordinary extracted
 * category ("Odalys is the only one who uses the dashboard"), and only the health read's one-line summary
 * carries `health_adoption`; and a row written before the categories existed, in a workspace the
 * backfill has not reached, still says `pain` with the kind in the tag.
 *
 * A declined expansion is NOT an opening. It carries the category (the CS page reads it as a
 * suppression) and it must never raise standing, which is why the stance is checked here and not
 * left to the writer's discretion — the miner used to guarantee this by omitting the tag, and a
 * writer that forgets is now caught by the reader.
 */
export function healthKindOf(value: any): HealthSignalKind | null {
  const category = String(value?.category ?? '').toLowerCase();
  const meta = value?.metadata ?? {};
  if (category === 'risk_signal') return 'risk';
  if (category === 'expansion_signal') return String(meta.stance ?? '') === 'declined' ? null : 'expansion';
  // The tag route is only for a row whose category cannot decide. It is NOT a way for a deal- or
  // product-domain claim to become a health driver: a `pain` tagged health_risk is a row the
  // backfill has not reached, and is read; a `buying_signal` tagged health_expansion is the
  // pre-GET-401 shape and is read the same way — but a category from the deal domain that
  // carries a health tag by accident tomorrow must not move standing (GET-409). So the fallback
  // is allowed only for the exact borrowed shapes, never for the domain in general.
  const tagKind = KIND_BY_TAG[String(meta.signal_type ?? '')] ?? null;
  if (!tagKind) return null;
  const borrowed = LEGACY_CATEGORY_FOR[tagKind];
  return category === borrowed || claimDomainOf(category) === 'customer' ? tagKind : null;
}

/** The category each kind was filed under before GET-401 — the only non-customer rows the tag may read. */
const LEGACY_CATEGORY_FOR: Record<HealthSignalKind, string> = { risk: 'pain', expansion: 'buying_signal', adoption: 'status_quo' };

/**
 * THE reader. Every surface — the account page, the Accounts list, the weekly digest, the agent —
 * answers "how is this account doing" through this and nothing else.
 */
export async function getAccountHealth(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<DerivedHealth> {
  const { data } = await supabase
    .from('claims')
    .select('value, last_observed_at')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .like('property', 'note.%')
    .is('invalid_at', null)
    .limit(1000);

  const signals: HealthDriver[] = [];
  for (const row of (data as { value: any; last_observed_at: string | null }[] | null) ?? []) {
    const meta = row?.value?.metadata ?? {};
    // A departure counts even though no health read produced it.
    const departure = departureAsRisk(row?.value, row.last_observed_at);
    if (departure) { signals.push(departure); continue; }
    const kind = healthKindOf(row?.value);
    if (!kind) continue;
    signals.push({
      kind,
      text: String(row.value?.content ?? '').trim(),
      quote: String(meta.quote ?? '').trim(),
      at: String(meta.occurred_at ?? row.last_observed_at ?? ''),
      sourceRef: meta.source_ref ? String(meta.source_ref) : null,
    });
  }
  return deriveAccountHealth(signals.filter(s => s.text && s.at), now);
}
