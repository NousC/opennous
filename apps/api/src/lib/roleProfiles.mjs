// Who this person is at work, and what that changes.
//
// RevOps and Customer Success are not the same job. They read the same graph, share the same
// ICP and the same accounts, and want almost nothing in common from it: one wants the pattern
// across four hundred accounts and where the funnel leaks, the other wants the six customers
// who might not renew. An agent that answers both the same way is answering neither.
//
// ── Why this is DATA and not an agent per role ──
//
// The obvious move is a specialist agent per role behind an orchestrator. It is the wrong
// shape here, for four reasons that are specific rather than stylistic:
//
//   1. They would share ~95% of their context — same graph, same tools, same skills. What
//      differs is EMPHASIS, not capability, and emphasis is a parameter.
//   2. Thirteen prompts drift. This exact subsystem was already drifting: ROLE_TAGS lived in
//      query.mjs AND in RoleReporting.tsx with a "keep the two in sync" comment on it, which
//      is a second source of truth with a sticky note attached. Both now read this file.
//   3. A person is not one role. A founder carries the AE book; a RevOps lead at twenty people
//      is also the analyst and the SDR manager. `expandRoles` already models that, and routing
//      to one specialist would force a choice the data does not.
//   4. An orchestrator plus a specialist is two model calls per turn. This is sixty tokens.
//
// ── The shape of a profile, and why it stops where it does ──
//
// Sophisticated enough to genuinely personalise, short enough to stay true. Each role gets:
//
//   who          who this person actually is at work — what they carry, what they are judged
//                on, how they spend the day. The rest of the profile follows FROM this, and
//                without it the agent is matching a title rather than understanding a job.
//                "This is a CRO" and "this person owns the number across three teams and is
//                judged quarterly on whether the engine delivered" are not the same
//                instruction, and only the second one changes an answer.
//   objective    the one thing they are measured on. Everything else hangs off it.
//   prioritise   what to surface FIRST in any answer.
//   report       what a report written for them leads with.
//   avoid        what to leave out. This is the field that makes it feel personal rather than
//                labelled — a CRO does not want the next step on one deal, an SDR does not
//                want a strategy essay. Saying what NOT to say is most of the difference
//                between a report addressed to someone and a report written for them.
//   objectionTag how an objection reads to this seat.
//   signalTag    how a signal reads to this seat.
//
// There is deliberately no "tone" field and no essay. A long profile stops being read.

export const ROLE_PROFILES = {
  founder: {
    label: 'Founder / CEO',
    who: "Carries the whole company. Sells, hires, raises, and still closes deals personally. Time-poor and context-rich \u2014 they already know the accounts, they need to know what changed and what only they can fix.",
    objective: 'Grow the company and know what needs their attention.',
    prioritise: ['revenue trajectory and what changed', 'the biggest risks', 'strategic accounts', 'what customers keep saying'],
    report:     ['growth and forecast', 'the biggest leak', 'key wins and losses', 'where the founder personally needs to step in'],
    avoid:      'Do not hand them a task list or per-deal next steps. They decide; they do not work the queue.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Deal risk',        signalTag: 'Signal',          color: '#dc2626',
    note: 'A blocker sitting across the pipeline.',
  },
  cro: {
    label: 'CRO / VP Revenue',
    who: "Owns the number across sales, CS and marketing. Judged quarterly on whether the engine delivered, so they think in coverage, conversion and risk \u2014 not in individual relationships.",
    objective: 'Hit the number across the whole GTM engine.',
    prioritise: ['pipeline coverage against the number', 'forecast risk', 'conversion and velocity by stage', 'retention and expansion', 'where the engine leaks between teams'],
    report:     ['pipeline health and coverage', 'forecast confidence and what threatens it', 'revenue leakage by stage', 'win/loss', 'segment performance', 'problems that cross team boundaries'],
    avoid:      'Never lead with a single deal. A named deal appears only as evidence of a pattern, never as the finding itself.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Revenue risk',     signalTag: 'Engine signal',   color: '#dc2626',
    note: 'A pattern costing revenue across the engine.',
  },
  vp_sales: {
    label: 'VP Sales / Head of Sales',
    who: "Owns quota through other people. Cannot work every deal, so their lever is which rep to help, which deal to step into, and which gap to coach out of the team.",
    objective: 'Make the sales team consistently hit quota.',
    prioritise: ['pipeline by rep and by team', 'deals that stopped moving', 'stage conversion gaps', 'pipeline creation rate', 'deal risk worth stepping into'],
    report:     ['pipeline by rep', 'stalled deals and why', 'where coaching would change the number', 'conversion gaps', 'forecast confidence'],
    avoid:      'Not company strategy and not market commentary — that is the founder\'s read. Stay on the team and its book.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Deal blocker',     signalTag: 'Team signal',     color: '#dc2626',
    note: 'Blocking deals across the team.',
  },
  sales_manager: {
    label: 'Sales Manager',
    who: "Closest manager to the work. Sits in the deals with their reps, so their unit is the individual opportunity and the individual person, not the aggregate.",
    objective: 'Help individual reps progress deals and get better.',
    prioritise: ['deals that need intervention now', 'the quality of a rep\'s activity, not the volume', 'missing next steps', 'pipeline hygiene'],
    report:     ['deals needing intervention', 'patterns in a rep\'s behaviour', 'weak discovery', 'single-threaded deals', 'the next action on each'],
    avoid:      'Do not roll everything up to a number. Their job is the individual deal and the individual rep.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Deal blocker',     signalTag: 'Coaching signal', color: '#ea580c',
    note: 'Where a rep needs a hand.',
  },
  sales: {
    label: 'Sales',
    who: "Carries a book and is measured on what closes. Everything is: what do I do about this account, today.",
    objective: 'Move the deals in front of them forward.',
    prioritise: ['what changed on their accounts', 'the live objection', 'what to say next'],
    report:     ['their book', 'what moved and what went quiet', 'the counters to have ready'],
    avoid:      'No org-level strategy. Their question is always "what do I do about this account".',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Deal blocker',     signalTag: 'What buyers want', color: '#dc2626',
    note: 'Across your book — know the counter.',
  },
  account_executive: {
    label: 'Account Executive',
    who: "Owns named deals end to end, from qualified to signed. Lives in the detail of who is involved, what is blocking, and what happens next \u2014 a percentage never tells them which call to make.",
    objective: 'Turn opportunities into revenue.',
    prioritise: ['deal health and what changed', 'who else is involved on the buying side', 'open objections', 'the decision process and the competition', 'urgency'],
    report:     ['deal progression and risk', 'champion strength', 'whether the economic buyer is engaged', 'the next step on each', 'likelihood of closing'],
    avoid:      'Not aggregate funnel statistics. They own named deals, and a percentage does not tell them which one to call.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Deal blocker',     signalTag: 'What buyers want', color: '#dc2626',
    note: 'Have the counter ready before it stalls the deal.',
  },
  sdr: {
    label: 'SDR / BDR',
    who: "Measured on meetings booked. Works in short bursts against a list, so the only useful output is one they can act on in the next hour.",
    objective: 'Create qualified opportunities.',
    prioritise: ['which accounts are worth the next hour', 'why now — the signal', 'who to contact', 'the opening angle'],
    report:     ['best accounts to pursue and why now', 'who to contact at each', 'the messaging angle', 'reply and meeting conversion'],
    avoid:      'Never a strategy essay. Give the hook and the evidence behind it; if they cannot act on it in the next hour it does not belong in their report.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Early objection',  signalTag: 'Talk track',      color: '#dc2626',
    note: 'Handle it in outreach, before the meeting.',
  },
  solutions_engineer: {
    label: 'Solutions Engineer',
    who: "The technical credibility in the room. Their risk is a requirement nobody validated or an integration that will not work, discovered after the deal is committed.",
    objective: 'Prove technical fit and take technical risk off the table.',
    prioritise: ['unresolved requirements', 'integrations and architecture questions', 'security and compliance blockers', 'who the technical stakeholders are'],
    report:     ['technical gaps by deal', 'requirements still open', 'proof-of-concept status', 'security concerns', 'whether implementation is actually feasible'],
    avoid:      'Not commercial terms or forecast. Their risk is technical, and a close date is not evidence about it.',
    sees: 'technical',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Technical blocker', signalTag: 'Build signal',   color: '#7c3aed',
    note: 'Technical risk sitting in a live deal.',
  },
  customer_success: {
    label: 'Customer Success',
    who: "Owns the relationship after the sale. Measured on retention and whether the customer actually got what they bought \u2014 the deal closing was somebody else\'s win.",
    objective: 'Keep customers and make them successful.',
    prioritise: ['adoption and whether they are getting value', 'stakeholder health and who went quiet', 'renewal risk', 'expansion signals', 'promises we made'],
    report:     ['customer health', 'usage and adoption', 'renewal risk with the reason', 'commitments we made and have not kept', 'expansion opportunities'],
    avoid:      'New-business pipeline is not theirs. Keep it to accounts that already bought.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Churn / expansion signal', signalTag: 'Product gap', color: '#d97706',
    note: 'Watch the accounts raising this.',
  },
  head_of_customer_success: {
    label: 'Head of Customer Success',
    who: "Owns retention and expansion across the whole base. Thinks in portfolio and cohort; one unhappy customer matters as a symptom of something repeating.",
    objective: 'Protect and grow the customer base.',
    prioritise: ['portfolio health', 'churn risk concentrated anywhere', 'net revenue retention', 'adoption patterns across accounts', 'how each CSM\'s book is doing'],
    report:     ['accounts at risk and why', 'renewal forecast', 'expansion potential', 'product and service issues that keep recurring'],
    avoid:      'Not one customer\'s ticket. A named account appears as evidence of a pattern.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Retention risk',   signalTag: 'Portfolio signal', color: '#d97706',
    note: 'A retention pattern across the book.',
  },
  marketing: {
    label: 'Marketing',
    who: "Judged on pipeline, not on activity. Needs to know which sources and messages turned into revenue, which means following a lead well past the point most reporting stops.",
    objective: 'Generate pipeline efficiently.',
    prioritise: ['which sources produce real pipeline', 'campaign influence', 'intent', 'which personas respond', 'which messages land'],
    report:     ['pipeline by source', 'campaign quality, not volume', 'conversion all the way to revenue', 'which ICP segments respond', 'message performance'],
    avoid:      'Not individual deal mechanics. Leads that never became revenue are the finding, not a footnote.',
    sees: 'messaging',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Messaging gap',    signalTag: 'Market signal',   color: '#db2777',
    note: 'Sharpen the story around this.',
  },
  revops: {
    label: 'RevOps',
    who: "Owns whether the revenue system can be trusted. Spends their day on why the numbers disagree, where the funnel leaks and which process is not being followed.",
    objective: 'Make the revenue system predictable.',
    prioritise: ['the pattern across accounts, not the anecdote', 'funnel integrity and where it leaks', 'data quality and stage hygiene', 'velocity', 'whether the forecast can be trusted'],
    report:     ['funnel leakage by stage with counts', 'processes that are not being followed', 'stale and missing data', 'lifecycle problems', 'source quality', 'stage integrity'],
    avoid:      'One deal is never the finding. Prefer counts and trends; name accounts only as examples of the pattern.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Process friction', signalTag: 'Pipeline signal', color: '#0891b2',
    note: 'Recurring friction worth fixing in the motion.',
  },
  engineer: {
    label: 'Product & Engineering',
    who: "Builds the product. Needs to know which gaps are actually costing revenue, with the accounts attached, because every team asks for everything.",
    objective: 'Build what creates customer and revenue value.',
    prioritise: ['objections that are really product gaps', 'capabilities buyers keep asking for', 'why customers churned', 'adoption'],
    report:     ['product gaps costing revenue, with the revenue attached', 'recurring requests ranked by accounts affected', 'blockers', 'usage patterns', 'product themes in win/loss'],
    avoid:      'Not pipeline mechanics or forecast. Tie every ask to the accounts and the revenue behind it, or leave it out.',
    sees: 'technical',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Feature request',  signalTag: 'Build signal',    color: '#7c3aed',
    note: 'A capability buyers keep asking for, behind real revenue.',
  },
  finance: {
    label: 'Finance / CFO',
    who: "Owns whether the forecast can be believed. Cares about how revenue was earned and how reliably it repeats \u2014 an unsourced number is worse than no number.",
    objective: 'Understand how reliable the revenue is.',
    prioritise: ['forecast confidence', 'committed versus best-case', 'retention economics', 'deal size and discounting', 'concentration risk'],
    report:     ['forecast confidence and the basis for it', 'committed revenue', 'customer concentration risk', 'discounting behaviour', 'retention economics'],
    avoid:      'Not deal narrative or coaching. If a number cannot be traced to a record, say so rather than estimating.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Revenue risk',     signalTag: 'Economic signal', color: '#0891b2',
    note: 'A risk to the reliability of the number.',
  },
  agency: {
    label: 'Agency',
    who: "Runs revenue for several clients at once. Context-switches constantly, so an unlabelled fact is useless and a merged view is actively misleading.",
    objective: 'Run revenue across several client accounts at once.',
    prioritise: ['which client this is about — always say it', 'what changed per client', 'what needs doing this week'],
    report:     ['each client separately, never merged', 'what moved per client', 'where a client needs attention'],
    avoid:      'Never merge clients into one view. An unlabelled number is useless to them.',
    sees: 'all',   // which objections reach this seat: all · technical · messaging
    objectionTag: 'Deal blocker',     signalTag: 'Client signal',   color: '#0891b2',
    note: 'Affecting one of your clients.',
  },
};

/**
 * Which insight themes reach which roles. A theme nobody routed to reaches the founder only,
 * which is the safe default — better unseen by one seat than wrongly framed for it.
 */
export const THEME_ROLES = {'product': ['engineer', 'solutions_engineer', 'account_executive', 'customer_success', 'head_of_customer_success', 'revops', 'cro', 'founder'], 'market': ['marketing', 'sales', 'sdr', 'account_executive', 'vp_sales', 'cro', 'founder'], 'buyer': ['marketing', 'sales', 'sdr', 'account_executive', 'sales_manager', 'vp_sales', 'cro', 'founder'], 'positioning': ['marketing', 'sales', 'account_executive', 'vp_sales', 'cro', 'founder']};

/** Does this objection reach this seat? `all` seats see every objection; the two specialist
 *  lenses see only what matches their subject, because a pricing objection is not a build
 *  signal and showing it as one teaches the reader to distrust the tag. */
export function objectionReaches(role, text, { TECH_RX, MSG_RX }) {
  const mode = roleProfile(role)?.sees ?? 'all';
  if (mode === 'all') return true;
  if (mode === 'technical') return TECH_RX.test(text);
  if (mode === 'messaging') return MSG_RX.test(text);
  return false;
}

/** Every role the product knows. Order is roughly seniority, for pickers. */
export const ALL_ROLES = Object.keys(ROLE_PROFILES);

/** Roles that see the whole company when `ambassador` expands. */
export const ALL_LENSES = [
  'founder', 'cro', 'vp_sales', 'sales', 'account_executive', 'sdr',
  'revops', 'customer_success', 'marketing',
];

export function roleProfile(role) {
  return ROLE_PROFILES[String(role || '').toLowerCase()] ?? null;
}

export function roleLabel(role) {
  return roleProfile(role)?.label ?? String(role || '').replace(/_/g, ' ');
}

/**
 * The role block — what this seat is for, what to lead with, and what to leave out. Returned
 * WITHOUT a header; buildMemberBlock owns the one heading the whole block sits under. Kept to a handful of lines per role on purpose: this is injected on EVERY turn,
 * and a profile long enough to be a document is a profile the model skims.
 */
export function roleDirective(roles) {
  const list = [...new Set((Array.isArray(roles) ? roles : []).map(r => String(r).toLowerCase()))]
    .filter(r => ROLE_PROFILES[r])
    // ALL_ROLES is ordered roughly by seniority, so the first match is the hat that leads.
    .sort((a, b) => ALL_ROLES.indexOf(a) - ALL_ROLES.indexOf(b));
  if (!list.length) return '';

  const full = (r) => {
    const p = ROLE_PROFILES[r];
    return [
      `**${p.label}** — ${p.objective}`,
      p.who,
      `Lead with: ${p.prioritise.join(' · ')}.`,
      `In a report for them: ${p.report.join(' · ')}.`,
      `Leave out: ${p.avoid}`,
    ].filter(Boolean).join('\n');
  };

  // One or two roles is the normal case and both get the full profile.
  if (list.length <= 2) {
    return [
      ...list.map(full),
      list.length > 1
        ? 'They hold both. Shape each answer around the one the request calls for, and say which when it is not obvious.'
        : '',
    ].filter(Boolean).join('\n\n');
  }

  // Many roles — an `ambassador` seat expands to every lens. Nine full profiles is 1,400
  // tokens on EVERY turn and, worse, it is not better instruction: told to be nine people at
  // once, the model is told nothing about who it is serving. So the leading hat gets the full
  // profile and the rest are named with their objective, which is enough for the agent to
  // recognise when the request is really coming from one of them and ask.
  const [lead, ...rest] = list;
  return [
    full(lead),
    `They also hold: ${rest.map(r => `${ROLE_PROFILES[r].label} (${ROLE_PROFILES[r].objective.replace(/\.$/, '')})`).join(' · ')}.`,
    'Default to the profile above. When a request is plainly one of the other hats, answer as that role instead and say which you took.',
  ].filter(Boolean).join('\n\n');
}

/** The reporting tags, for the server's role routing and the app's Reporting page. */
export function roleTags() {
  return Object.fromEntries(Object.entries(ROLE_PROFILES).map(([k, p]) => [k, {
    label: p.label, objectionTag: p.objectionTag, signalTag: p.signalTag,
    color: p.color, note: p.note,
  }]));
}
