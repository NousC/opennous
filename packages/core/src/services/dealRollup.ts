// Deal rollup — turning a company's CRM deals into the one set of numbers the forecast
// needs: how much is open, when the nearest one is expected to land, and how much this
// account has already been worth.
//
// WHY THIS EXISTS. We resolved that a "deal" in Nous is a COMPANY (see the forecasting
// build log): the product already treats one account as one deal everywhere. But a CRM
// happily hangs several deals off one company (a new-business deal, a renewal, two closed
// ones from last year). So something has to reduce many CRM deals to one account-level
// answer, and that rule should live in exactly one place rather than being improvised at
// each read site.
//
// Pure — no DB, no clock, no provider specifics. Feed it whatever the CRM returned.

export type CrmDealState = 'won' | 'lost' | 'open';

export interface RollupInput {
  value?: number | null;
  currency?: string | null;
  stage?: string | null;
  /** Providers that expose an explicit open/won/lost field (Pipedrive). Wins over `stage`. */
  status?: string | null;
  close_date?: string | null;
}

export interface DealRollup {
  /** Sum of the OPEN deals. This is what the forecast weighs. null when there are none. */
  openAmount: number | null;
  /** Sum of the WON deals. Historical account value — trains the model, never forecast. */
  wonAmount: number | null;
  currency: string;
  /** Nearest expected close among the open deals — the soonest money could land. */
  closeDate: string | null;
  openDeals: number;
  wonDeals: number;
  /** True when the open deals disagree on currency, so callers can refuse to sum blindly. */
  mixedCurrency: boolean;
}

// Words that mean the deal is over. Checked against a squashed form of the stage string so
// HubSpot's `closedwon`, Attio's `Closed Won` and a hand-typed `closed-won` all land alike.
const WON_RE = /won/;
const LOST_RE = /lost|abandon|cancel|disqualif|churn|dead|nurture/;

/**
 * Is this CRM deal open, won, or lost?
 *
 * `status` wins when present because it is the provider's own explicit answer (Pipedrive
 * ships `open|won|lost`). Otherwise we read the stage NAME, which is free text a customer
 * renames at will, so this is a heuristic and is deliberately conservative: a stage that
 * says "closed" but names no outcome counts as LOST, not open. Guessing "open" would
 * silently inflate the forecast, and an inflated forecast is worse than a cautious one.
 */
export function crmDealState(input: RollupInput): CrmDealState {
  const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');

  const status = squash(input.status);
  if (status === 'won') return 'won';
  if (status === 'lost' || status === 'deleted') return 'lost';
  if (status === 'open') return 'open';

  const stage = squash(input.stage);
  if (!stage) return 'open';
  if (WON_RE.test(stage)) return 'won';
  if (LOST_RE.test(stage)) return 'lost';
  if (stage.includes('closed')) return 'lost';   // "closed", outcome unnamed — see above
  return 'open';
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reduce every CRM deal on one company to a single account-level view.
 *
 * Open deals are SUMMED, not max'd. If Acme has a $50k new-business deal and a $30k
 * renewal both live, the account's contribution to the pipeline is $80k — taking the
 * larger would quietly drop a third of it. (Contrast the pre-existing behaviour elsewhere
 * in the codebase, which takes MAX of a per-contact `deal_value`; that was a workaround
 * for not having deal records linked at all.)
 *
 * The close date is the EARLIEST among open deals, because the forecast question is
 * "what could land by the 31st" and the soonest deal is the one that answers it.
 *
 * Mixed currencies are flagged rather than converted. We have no FX rates and inventing
 * them would produce a confident, wrong number.
 */
export function rollupDeals(deals: RollupInput[]): DealRollup {
  const out: DealRollup = {
    openAmount: null, wonAmount: null, currency: '$', closeDate: null,
    openDeals: 0, wonDeals: 0, mixedCurrency: false,
  };
  if (!Array.isArray(deals) || deals.length === 0) return out;

  const currencies = new Set<string>();
  let openSum = 0, openSeen = false;
  let wonSum = 0, wonSeen = false;

  for (const d of deals) {
    if (!d) continue;
    const state = crmDealState(d);
    const amount = num(d.value);
    // '$' is the fetchers' placeholder for "the CRM gave no currency", not a currency. Counting
    // it made two EUR accounts with one code-less deal "mixed" and left their amounts unset.
    if (d.currency && String(d.currency) !== '$') currencies.add(String(d.currency));

    if (state === 'open') {
      out.openDeals++;
      if (amount != null) { openSum += amount; openSeen = true; }
      // Only an OPEN deal's close date is a forecast date. A won deal's is history.
      const cd = d.close_date ? String(d.close_date) : null;
      if (cd && (out.closeDate === null || cd < out.closeDate)) out.closeDate = cd;
    } else if (state === 'won') {
      out.wonDeals++;
      if (amount != null) { wonSum += amount; wonSeen = true; }
    }
    // lost deals contribute nothing to either figure, by design
  }

  out.openAmount = openSeen ? openSum : null;
  out.wonAmount = wonSeen ? wonSum : null;
  out.mixedCurrency = currencies.size > 1;
  out.currency = currencies.size >= 1 ? [...currencies][0] : '$';
  return out;
}
