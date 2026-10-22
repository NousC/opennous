// Deal qualification (GET-1004): what we KNOW about a deal, letter by letter, next to how it feels.
//
// Deal health reads momentum: a warm buyer and a moving deal. It cannot say whether we know who signs,
// how and when they decide, or what the paperwork is, so a deal can read Healthy while nobody has
// asked. This reads the same intel against MEDDICC, one letter at a time:
//
//   confirmed  a fact on the record answers it (the claim is cited)
//   partial    something points at it, but it is not settled (a senior person, no named role)
//   unknown    nothing on the record; the letter carries the question that would answer it
//
// Derived only from what the record already holds, so nobody fills in a form. The claims are the
// ones the health card reads (team-readable, quotes redacted per viewer), and no letter is ever
// "confirmed" by a guess: a likely champion is partial until a conversation names them.
import { isBuyerResponse } from './engagement.mjs';

const SENIOR = /c[_\s-]?suite|c[_\s-]?level|chief|\bcxo\b|founder|owner|president|\bceo\b|\bcfo\b|managing director/i;
const PAPER_PERSON = /legal|counsel|procurement|purchasing|contracts?\b/i;
// Words that mean the paperwork itself came up, not a feature that happens to mention a contract.
// Read only on the categories where signing steps live (a pain about "contract renewals" is not one).
const PAPER_WORDS = /\b(contracts?|msa|dpa|nda|redlines?|procurement|legal review|security review|security questionnaire|vendor (?:form|onboarding|review)|purchase order|po|sign(?:ed|ing)?[\s-]off|signatures?|e-?sign(?:ature)?|terms and conditions|order form)\b/i;
const PAPER_CATEGORIES = new Set(['blocker', 'objection', 'timeline', 'buying_signal']);
const SIGN_OFF = /\b(approv(?:e|es|ed|al|ing)|sign[\s-]?off|signs? (?:off|the contract)|board|committee|budget holder|final say|has to (?:approve|sign))\b/i;
// A number with a unit, a percentage, or a measure of change; never a bare year or quarter.
const MEASURABLE = /\d+(?:[.,]\d+)?\s*(?:%|x\b|percent|hours?|hrs?|minutes?|mins?|days?|weeks?|months?|deals?|leads?|reps?|calls?|k\b|m\b)|[$€£]\s?\d|\b(?:double|halve|triple|cut .{0,30}\bby\b|from .{0,30}\bto\b)|\b(?:conversion|win|close|response|churn) rate\b/i;

const textOf = (n) => String(n?.content ?? n?.label ?? '').trim();
const clip = (s, max = 90) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const byNewest = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
const roleOf = (n) => n?.metadata?.role || '';
const openNote = (n) => !/^(resolved|closed|done|dismissed)$/i.test(String(n?.metadata?.status ?? ''));

const LETTERS = [
  { key: 'metrics', letter: 'M', label: 'Metrics', ask: 'What result would make this a success for them, in numbers?' },
  { key: 'economic_buyer', letter: 'E', label: 'Economic buyer', ask: 'Who signs off on the budget for this?' },
  { key: 'decision_criteria', letter: 'D', label: 'Decision criteria', ask: 'What does it have to do for them to say yes?' },
  { key: 'decision_process', letter: 'D', label: 'Decision process', ask: 'What are the steps to a decision, and by when?' },
  { key: 'paper_process', letter: 'P', label: 'Paper process', ask: 'What does it take to sign: contract, legal, security, procurement?' },
  { key: 'pain', letter: 'I', label: 'Identified pain', ask: 'What is this costing them today?' },
  { key: 'champion', letter: 'C', label: 'Champion', ask: 'Who on their side is pushing for this internally?' },
  { key: 'competition', letter: 'C', label: 'Competition', ask: 'What else are they looking at, including doing nothing?' },
];

/**
 * MEDDICC for one deal from its intel.
 *
 * `notes`: the deal's claims (extracted intel carries `category`, `metadata.role`, `metadata.status`).
 * `stakeholders`: [{ id, title, seniority }]. `engagedIds`: people in conversation in the last 45
 * days (multiThread's rule), so a senior title alone never stands in for a buyer. `activity`: the
 * deal's activity rows, to find who on their side writes most. `closeDate`: the CRM's close date
 * when the deal has one.
 */
export function computeQualification({ notes = [], stakeholders = [], engagedIds = [], activity = [], closeDate = null } = {}) {
  const intel = (notes || []).filter(n => n && n.source === 'signal_extraction');
  const cat = (c) => intel.filter(n => String(n.category || '').toLowerCase() === c).sort(byNewest);
  const engaged = new Set(engagedIds || []);
  const people = stakeholders || [];
  const authority = cat('authority');
  const departed = new Set(cat('staff_change').filter(n => n.metadata?.change === 'left').map(n => n.entity_id).filter(Boolean));
  const holding = (role) => authority.filter(n => roleOf(n) === role && !(n.entity_id && departed.has(n.entity_id)));

  const out = {};
  const set = (key, status, reason, evidence = []) => { out[key] = { status, reason, evidence: evidence.map(n => n.id).filter(Boolean) }; };

  // M — a goal or a result they stated, measurable when it carries a number.
  const goals = [...cat('goal'), ...cat('performance')].sort(byNewest);
  const measurable = goals.filter(n => MEASURABLE.test(textOf(n)));
  if (measurable.length) set('metrics', 'confirmed', clip(textOf(measurable[0])), measurable);
  else if (goals.length) set('metrics', 'partial', `A goal, but no number on it: ${clip(textOf(goals[0]), 70)}`, goals);
  else set('metrics', 'unknown', 'No goal or target on record');

  // E — named as the economic buyer in a conversation. A decision maker, or a senior person in
  // conversation, points at one without settling who holds the money.
  const buyers = holding('economic_buyer');
  const deciders = holding('decision_maker');
  const seniorsTalking = people.filter(s => engaged.has(s.id) && (SENIOR.test(s.seniority || '') || SENIOR.test(s.title || '')));
  if (buyers.length) set('economic_buyer', 'confirmed', clip(textOf(buyers[0])), buyers);
  else if (deciders.length) set('economic_buyer', 'partial', `A decision maker is named, not who holds the budget: ${clip(textOf(deciders[0]), 60)}`, deciders);
  else if (seniorsTalking.length) set('economic_buyer', 'partial', `${seniorsTalking.map(s => s.title).filter(Boolean)[0] || 'A senior person'} is in conversation, but nobody is named as the one who signs`);
  else set('economic_buyer', 'unknown', 'Nobody is named as the one who signs');

  // D — what it must do to win: hard requirements they stated.
  const reqs = cat('requirement');
  if (reqs.length) set('decision_criteria', 'confirmed', reqs.length === 1 ? clip(textOf(reqs[0])) : `${reqs.length} requirements stated, latest: ${clip(textOf(reqs[0]), 60)}`, reqs);
  else set('decision_criteria', 'unknown', 'No requirement for a yes on record');

  // D — how and when: a timeline, the approvals standing in the way, a close date.
  const timelines = cat('timeline');
  const approvals = [...cat('blocker'), ...cat('objection')].filter(n => openNote(n) && SIGN_OFF.test(textOf(n)));
  const process = [...timelines, ...approvals];
  const parts = [timelines.length && 'a timeline', approvals.length && 'who has to approve', closeDate && 'a close date'].filter(Boolean);
  if (parts.length >= 2) set('decision_process', 'confirmed', `Known: ${parts.join(', ')}`, process);
  else if (parts.length === 1) set('decision_process', 'partial', `Only ${parts[0]} so far${timelines[0] ? `: ${clip(textOf(timelines[0]), 60)}` : ''}`, process);
  else set('decision_process', 'unknown', 'No timeline, approval steps or close date on record');

  // P — the paperwork came up, or someone from legal or procurement is on the deal.
  const paper = intel.filter(n => PAPER_CATEGORIES.has(String(n.category || '').toLowerCase()) && PAPER_WORDS.test(textOf(n))).sort(byNewest);
  const paperPeople = people.filter(s => PAPER_PERSON.test(s.title || ''));
  if (paper.length) set('paper_process', 'confirmed', clip(textOf(paper[0])), paper);
  else if (paperPeople.length) set('paper_process', 'partial', `${paperPeople[0].title} is on the deal, but the steps to sign have not come up`);
  else set('paper_process', 'unknown', 'Contract, legal and procurement steps have not come up');

  // I — a pain they stated.
  const pains = cat('pain');
  if (pains.length) set('pain', 'confirmed', pains.length === 1 ? clip(textOf(pains[0])) : `${pains.length} pains stated, latest: ${clip(textOf(pains[0]), 60)}`, pains);
  else set('pain', 'unknown', 'No pain on record');

  // C — named as the champion in a conversation. The person who talks most is a likely one only.
  const champs = holding('champion');
  const written = new Map();
  for (const a of activity || []) if (a?.contact_id && isBuyerResponse(a)) written.set(a.contact_id, (written.get(a.contact_id) || 0) + 1);
  const mostActive = people.filter(s => engaged.has(s.id)).sort((a, b) => (written.get(b.id) || 0) - (written.get(a.id) || 0))[0];
  if (champs.length) set('champion', 'confirmed', clip(textOf(champs[0])), champs);
  else if (mostActive && (written.get(mostActive.id) || 0) >= 3) set('champion', 'partial', `Likely ${mostActive.name || mostActive.title || 'the most active person'}, the most active in conversation, but not named as the champion`);
  else set('champion', 'unknown', 'Nobody is named as pushing for this on their side');

  // C — who else they are looking at. Silence is not "no competition".
  const rivals = cat('competitor');
  const names = [...new Set(rivals.map(n => String(n.metadata?.competitor ?? n.metadata?.entity ?? n.label ?? '').trim()).filter(Boolean))];
  if (rivals.length) set('competition', 'confirmed', names.length ? `Named: ${names.slice(0, 3).join(', ')}` : clip(textOf(rivals[0])), rivals);
  else set('competition', 'unknown', 'No alternative named, which is not the same as none');

  const items = LETTERS.map(l => ({ ...l, ...out[l.key], ask: out[l.key].status === 'confirmed' ? null : l.ask }));
  const confirmed = items.filter(i => i.status === 'confirmed').length;
  return { framework: 'meddicc', label: 'MEDDICC', confirmed, partial: items.filter(i => i.status === 'partial').length, total: items.length, items };
}
