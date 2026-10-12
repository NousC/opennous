// What a job title says about someone's place in a buying decision (GET-276).
//
// A title is not evidence of how someone feels about us, but it is good evidence of where they
// sit: a dealership's General Manager signs, its Controller holds the budget, a Sales Associate
// uses the product. Before this, one regex decided "decision maker or not" in two places
// (committee.ts and the account API), it missed "General Manager", and nothing ranked people at
// all, so the org chart laid every contact out in one flat row.
//
// One reading, used everywhere: a TIER for layout and a buying ROLE as a fallback when no
// conversation has told us more. Anything evidence-based (a CHAMPIONS edge, a budget-holder
// statement) always wins over the title.

export type TitleTier = 'executive' | 'leadership' | 'manager' | 'staff';
export type TitleRole = 'decision_maker' | 'economic_buyer';

export interface TitleRead {
  /** Where they sit; null when there is no title to read. */
  tier: TitleTier | null;
  /** The buying role the title implies, or null (an influencer or user until evidence says more). */
  role: TitleRole | null;
}

// Order matters: the first match wins, so money holders are read before the generic
// "director"/"chief" rules, and senior phrases before the bare word "manager".
const RULES: Array<[RegExp, TitleTier, TitleRole | null]> = [
  [/\bcfo\b|chief financial/i, 'executive', 'economic_buyer'],
  [/controller|comptroller|treasurer|finance director|director,? (of )?finance|\bvp,? (of )?finance/i, 'leadership', 'economic_buyer'],
  [/(?<!product )owner|founder|\bceo\b|chief|president|dealer principal|\bprincipal\b|managing director|managing partner|\bpartner\b(?!.*manager)|chairman|\bcoo\b|\bcto\b|\bcmo\b|\bcro\b/i, 'executive', 'decision_maker'],
  [/general manager|\bgm\b|\bvp\b|vice president|\bdirector\b|head of/i, 'leadership', 'decision_maker'],
  [/general sales manager|\bgsm\b/i, 'leadership', null],
  [/manager|\blead\b|supervisor|team lead/i, 'manager', null],
  [/associate|advisor|adviser|consultant|specialist|representative|\brep\b|developer|coordinator|assistant|analyst|agent|salesperson|receptionist|administrator|clerk|technician|engineer/i, 'staff', null],
];

export function readTitle(title: string | null | undefined): TitleRead {
  const t = String(title ?? '').trim();
  if (!t) return { tier: null, role: null };
  for (const [re, tier, role] of RULES) if (re.test(t)) return { tier, role };
  return { tier: 'staff', role: null };
}

export const TIER_ORDER: TitleTier[] = ['executive', 'leadership', 'manager', 'staff'];
