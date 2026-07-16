// Contrastive signal discovery — the data-driven candidate source for the
// Scorecard. Sweeps a won/lost cohort for features whose presence separates
// winners from losers by lift, and turns the strongest into new signal
// proposals. Deterministic (no LLM). Used by the nightly learning loop AND the
// "build from closed deals" onboarding. See docs/icp-from-closed-deals.md.

export interface DiscoveryEpisode {
  features: Record<string, unknown>;
  /** 0–1 outcome score (legacy fallback when no disposition). */
  outcome?: number;
  /** 'won' | 'lost' | 'no_opportunity' | null. no_opportunity should be excluded
   *  by the caller; if present here it is treated as a loss. */
  disposition?: string | null;
  /** When the deal resolved (ISO). Drives recency weighting — recent deals count
   *  more, so the ICP follows where the business is going. Omit → equal weight. */
  at?: string | null;
}

// Recency: a deal's vote decays with age so a pivot shifts the ICP. The newest
// deal in the cohort counts 1.0; one HALF_LIFE_DAYS older counts 0.5.
const HALF_LIFE_DAYS = 180;
const DISC_DAY_MS = 86_400_000;
// Volume confidence: a signal backed by more (recency-weighted) deals is sturdier.
// withW/(withW+VOL_K) shrinks a thin-evidence signal's weight toward ±1.
const VOL_K = 5;

export interface DiscoverySignalRef {
  active?: boolean;
  rule?: { feature?: string } | null;
}

export interface SignalProposal {
  action: 'add';
  signal: { key: string; label: string; weight: number; rule: { feature: string; op: string; value: unknown } };
  note: string;
}

const dslug = (s: unknown) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// Properties that are identity/metadata or outcome-leaky — never ICP signals.
// (A name or "enrichment_status: complete" predicts nothing; an Apollo account
// id is noise; pipeline_stage / deal_* are downstream of the outcome.)
export const NON_FEATURE_PROPS = new Set([
  'name', 'first_name', 'last_name', 'full_name', 'email', 'phone', 'domain',
  'company', 'linkedin_url', 'what_they_do', 'website', 'avatar_url',
  'enrichment_status', 'enrichment_source', 'icp_score',
  'pipeline_stage', 'deal_stage', 'deal_value', 'total_income', 'lead_source',
  // Descriptive text matched by contains_any exclusions — never an exact-match signal.
  'keywords', 'description',
]);

// True when a property is identity/metadata/outcome-leaky and must not become a
// signal. Covers the explicit set PLUS structural patterns so vendor ids and
// timestamps (apollo_account_id, hubspot_id, enriched_at, created_at, …) can't
// leak in. NOTE: real features (industry, size_band, funding_stage, signal.*,
// pipe.lead_source/channel/…) match none of these.
export function isNonFeatureProp(prop: string): boolean {
  if (NON_FEATURE_PROPS.has(prop)) return true;
  if (/_id$/.test(prop)) return true;                                   // any *_id (apollo_account_id, hubspot_id)
  if (/_at$/.test(prop)) return true;                                   // any *_at timestamp
  if (/^(apollo|clearbit|hubspot|attio|salesforce|pipedrive|crm)[._]/i.test(prop)) return true; // vendor fields
  if (/(^|[._])(enrich|enriched|avatar|photo|image|uuid|external)/i.test(prop)) return true;
  return false;
}

/** Map a lift ratio to a signal weight (−10..10), in bands. */
export function weightFromLift(lift: number): number {
  if (lift >= 3) return 8;
  if (lift >= 2) return 6;
  if (lift >= 1.5) return 4;
  if (lift <= 0.33) return -8;
  if (lift <= 0.5) return -6;
  if (lift <= 0.66) return -4;
  return 0;
}

function labelForDiscovery(feature: string, value: unknown): string {
  const f = feature.replace(/^signal\./, '').replace(/[._]/g, ' ').trim();
  const title = f.replace(/\b\w/g, c => c.toUpperCase());
  return typeof value === 'boolean' ? title : `${title}: ${String(value).replace(/_/g, ' ')}`;
}

export function discoverSignals(
  episodes: DiscoveryEpisode[],
  signals: DiscoverySignalRef[],
): SignalProposal[] {
  const rows = episodes.map(e => {
    const t = e.at ? new Date(e.at).getTime() : null;
    return {
      features: e.features,
      win: e.disposition ? e.disposition === 'won' : (e.outcome ?? 0) >= 0.5,
      t: t != null && Number.isFinite(t) ? t : null,
    };
  });
  if (rows.length < 8) return [];

  const totalN = rows.length;
  const totalWins = rows.filter(r => r.win).length;
  if (totalWins === 0 || totalWins === totalN) return []; // no contrast

  // Recency weight per deal, relative to the newest deal in the cohort.
  const times = rows.map(r => r.t).filter((t): t is number => t != null);
  const newest = times.length ? Math.max(...times) : null;
  const weights = rows.map(r => {
    if (r.t == null || newest == null) return 1;
    const ageDays = Math.max(0, (newest - r.t) / DISC_DAY_MS);
    return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  });
  const totalWinsW = rows.reduce((s, r, i) => s + (r.win ? weights[i] : 0), 0);
  const totalW = weights.reduce((s, w) => s + w, 0);

  // Tally (feature == value) candidates — booleans ("has X") and short categoricals.
  // Track raw count (for the hard threshold) and recency-weighted sums (for lift + volume).
  const cand = new Map<string, { feature: string; value: unknown; withN: number; withW: number; winWithW: number }>();
  rows.forEach((r, i) => {
    const w = weights[i];
    for (const [f, v] of Object.entries(r.features)) {
      if (v == null) continue;
      if (isNonFeatureProp(f)) continue; // identity/metadata/vendor-id, never a signal
      const isBool = typeof v === 'boolean';
      const isCat = typeof v === 'string' && v.length <= 40;
      if (!isBool && !isCat) continue;
      if (isBool && v === false) continue; // only presence of a signal
      const key = `${f}::${String(v)}`;
      let c = cand.get(key);
      if (!c) { c = { feature: f, value: v, withN: 0, withW: 0, winWithW: 0 }; cand.set(key, c); }
      c.withN++;
      c.withW += w;
      if (r.win) c.winWithW += w;
    }
  });

  const scored = new Set(
    signals.filter(s => s.active !== false).map(s => s.rule?.feature).filter(Boolean) as string[],
  );
  const out: { feature: string; value: unknown; lift: number; weight: number; withN: number }[] = [];
  for (const c of cand.values()) {
    const nWithout = totalN - c.withN;
    if (c.withN < 4 || nWithout < 4) continue;        // hard minimum of REAL deals
    if (scored.has(c.feature)) continue;               // already scored on this
    const withoutW = totalW - c.withW;
    if (c.withW <= 0 || withoutW <= 0) continue;
    const wrWith = c.winWithW / c.withW;               // recency-weighted win rates
    const wrWithout = (totalWinsW - c.winWithW) / withoutW;
    if (wrWithout <= 0) continue;
    const lift = wrWith / wrWithout;
    if (lift < 1.5 && lift > 0.66) continue;           // not discriminative
    const base = weightFromLift(lift);
    if (base === 0) continue;
    // Volume-weighted confidence — a signal backed by more weighted deals keeps
    // more of its band weight; thin evidence is shrunk toward ±1.
    const conf = c.withW / (c.withW + VOL_K);
    const weight = Math.sign(base) * Math.max(1, Math.round(Math.abs(base) * conf));
    out.push({ feature: c.feature, value: c.value, lift, weight, withN: c.withN });
  }
  // Rank by confidence-scaled strength so sturdy, strongly-separating signals win.
  out.sort((a, b) => (Math.abs(b.weight) * Math.abs(Math.log(b.lift))) - (Math.abs(a.weight) * Math.abs(Math.log(a.lift))));
  return out.slice(0, 5).map(d => ({
    action: 'add' as const,
    signal: {
      key: `disc_${dslug(d.feature)}${typeof d.value === 'string' ? '_' + dslug(d.value) : ''}`,
      label: labelForDiscovery(d.feature, d.value),
      weight: d.weight,
      rule: { feature: d.feature, op: '==', value: d.value },
    },
    note: `discovered: ${d.lift.toFixed(1)}× lift over ${d.withN} deals`,
  }));
}
