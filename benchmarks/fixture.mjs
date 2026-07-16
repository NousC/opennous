// fixture.mjs
//
// A deterministic synthetic fixture with designed ground truth. No Math.random,
// no Date.now at import time. Every date is a hardcoded ISO string, every id is
// literal, so two runs read exactly the same world.
//
// The fixture is the whole point of the benchmark: because we planted the answers,
// we can score correctness. It is intentionally synthetic (see README caveats).
//
// It exposes THREE things:
//   rawView(fixture)      the scattered, unresolved rows Arm A's tools read
//                         (duplicate people under different emails, no joins, no scoring)
//   resolvedView(fixture) the resolved account blocks Arm B's tools read
//                         (one canonical person, the buried fact attached to Acme,
//                          ICP fit + intent computed)
//   GROUND_TRUTH          the planted answers the scorers check against
//
// A "reference date" is baked in so "last 7 days" is deterministic. The fixture
// pretends today is 2026-06-30.

export const REFERENCE_DATE = '2026-06-30';

// Small deterministic helper: days before the reference date, as an ISO date.
function daysAgo(n) {
  const ref = new Date('2026-06-30T00:00:00Z');
  const d = new Date(ref.getTime() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The raw fixture. Twelve accounts. Contacts, signals, interactions, deals.
// This is the "truth on the ground" before any resolution happens. Arm A reads
// derivatives of this (scattered, duplicated). Arm B reads a resolved projection.
// ---------------------------------------------------------------------------

export const FIXTURE = {
  accounts: [
    {
      id: 'acc_acme',
      name: 'Acme Corp',
      domain: 'acme.com',
      industry: 'B2B SaaS',
      employees: 180,
      // ICP inputs: strong fit (right size, right industry, uses the stack we serve).
      icpSignals: { rightIndustry: true, rightSize: true, usesModernStack: true },
    },
    {
      id: 'acc_globex',
      name: 'Globex',
      domain: 'globex.io',
      industry: 'B2B SaaS',
      employees: 90,
      icpSignals: { rightIndustry: true, rightSize: true, usesModernStack: true },
    },
    {
      id: 'acc_initech',
      name: 'Initech',
      domain: 'initech.com',
      industry: 'B2B SaaS',
      employees: 240,
      icpSignals: { rightIndustry: true, rightSize: true, usesModernStack: true },
    },
    {
      id: 'acc_umbrella',
      name: 'Umbrella Analytics',
      domain: 'umbrella-analytics.com',
      industry: 'Data / Analytics',
      employees: 60,
      icpSignals: { rightIndustry: true, rightSize: true, usesModernStack: false },
    },
    {
      id: 'acc_hooli',
      name: 'Hooli',
      domain: 'hooli.com',
      industry: 'Consumer Tech',
      employees: 4200,
      icpSignals: { rightIndustry: false, rightSize: false, usesModernStack: true },
    },
    {
      id: 'acc_stark',
      name: 'Stark Manufacturing',
      domain: 'stark-mfg.com',
      industry: 'Manufacturing',
      employees: 900,
      icpSignals: { rightIndustry: false, rightSize: false, usesModernStack: false },
    },
    {
      id: 'acc_wayne',
      name: 'Wayne Foundation',
      domain: 'wayne.org',
      industry: 'Nonprofit',
      employees: 30,
      icpSignals: { rightIndustry: false, rightSize: true, usesModernStack: false },
    },
    {
      id: 'acc_soylent',
      name: 'Soylent Foods',
      domain: 'soylent.co',
      industry: 'CPG',
      employees: 150,
      icpSignals: { rightIndustry: false, rightSize: true, usesModernStack: false },
    },
    {
      id: 'acc_pied',
      name: 'Pied Piper',
      domain: 'piedpiper.com',
      industry: 'B2B SaaS',
      employees: 45,
      icpSignals: { rightIndustry: true, rightSize: true, usesModernStack: true },
    },
    {
      id: 'acc_cyberdyne',
      name: 'Cyberdyne Systems',
      domain: 'cyberdyne.ai',
      industry: 'B2B SaaS',
      employees: 320,
      icpSignals: { rightIndustry: true, rightSize: true, usesModernStack: true },
    },
    {
      id: 'acc_massive',
      name: 'Massive Dynamic',
      domain: 'massivedynamic.com',
      industry: 'B2B SaaS',
      employees: 600,
      // The big-history account for a future scale test (task 6, optional in v0).
      icpSignals: { rightIndustry: true, rightSize: false, usesModernStack: true },
      bigHistory: true,
    },
    {
      id: 'acc_vandelay',
      name: 'Vandelay Industries',
      domain: 'vandelay.com',
      industry: 'Import / Export',
      employees: 12,
      icpSignals: { rightIndustry: false, rightSize: false, usesModernStack: false },
    },
  ],

  // Contacts. NOTE the identity trap: Sarah Chen appears as THREE separate contact
  // rows, under three identifiers, seeded from three sources. In the raw world they
  // are three rows that never got linked. Ground truth: one person.
  contacts: [
    // --- The identity trap: three fragments of ONE person at Acme ---
    {
      id: 'con_sarah_1',
      accountId: 'acc_acme',
      name: 'Sarah Chen',
      title: 'VP of Revenue Operations',
      email: 'sarah@acme.com',
      linkedin: null,
      source: 'email', // seen in an inbound email thread
    },
    {
      id: 'con_sarah_2',
      accountId: 'acc_acme',
      name: 'Sarah Chen',
      title: 'VP RevOps',
      email: 's.chen@acme.com', // secondary email, used on the buried-fact thread
      linkedin: null,
      source: 'meeting', // seen in a meeting transcript
    },
    {
      id: 'con_sarah_3',
      accountId: 'acc_acme',
      name: 'S. Chen',
      title: 'VP Rev Ops',
      email: null,
      linkedin: 'https://www.linkedin.com/in/sarahchen-revops',
      source: 'crm', // a CRM row keyed only on the LinkedIn URL
    },
    // Other Acme stakeholder (the CFO named in the buried fact).
    {
      id: 'con_acme_cfo',
      accountId: 'acc_acme',
      name: 'David Okafor',
      title: 'Chief Financial Officer',
      email: 'david.okafor@acme.com',
      linkedin: null,
      source: 'crm',
    },
    // A scatter of contacts across the other focus + non-focus accounts.
    { id: 'con_globex_1', accountId: 'acc_globex', name: 'Marco Rossi', title: 'Head of Growth', email: 'marco@globex.io', linkedin: null, source: 'email' },
    { id: 'con_initech_1', accountId: 'acc_initech', name: 'Priya Nair', title: 'Director of Sales', email: 'priya@initech.com', linkedin: null, source: 'crm' },
    { id: 'con_pied_1', accountId: 'acc_pied', name: 'Erlich B.', title: 'Founder', email: 'erlich@piedpiper.com', linkedin: null, source: 'email' },
    { id: 'con_cyber_1', accountId: 'acc_cyberdyne', name: 'Miles Dyson', title: 'CTO', email: 'miles@cyberdyne.ai', linkedin: null, source: 'crm' },
    { id: 'con_hooli_1', accountId: 'acc_hooli', name: 'Gavin B.', title: 'CEO', email: 'gavin@hooli.com', linkedin: null, source: 'crm' },
    { id: 'con_massive_1', accountId: 'acc_massive', name: 'Nina Sharp', title: 'VP Ops', email: 'nina@massivedynamic.com', linkedin: null, source: 'crm' },
  ],

  // Interactions: emails, meeting transcripts, notes. The BURIED FACT lives on a
  // thread keyed to the SECONDARY email s.chen@acme.com, so a raw agent that never
  // linked the two emails will not attach it to Acme / Sarah.
  interactions: [
    {
      id: 'int_acme_email_1',
      accountId: 'acc_acme',
      contactEmail: 'sarah@acme.com',
      kind: 'email',
      date: daysAgo(9),
      summary:
        'Sarah replied on the primary thread. Interested in resolving fragmented account data across their GTM tools. Asked for a technical overview.',
    },
    {
      id: 'int_acme_meeting_1',
      accountId: 'acc_acme',
      contactEmail: 's.chen@acme.com',
      kind: 'meeting_transcript',
      date: daysAgo(6),
      summary:
        'Discovery call with S. Chen (VP RevOps). Walked through the identity-resolution problem. She confirmed they run three overlapping outbound tools today.',
    },
    {
      id: 'int_acme_email_2_buried',
      accountId: 'acc_acme',
      contactEmail: 's.chen@acme.com', // BURIED FACT lives here, under the secondary email
      kind: 'email',
      date: daysAgo(4),
      summary:
        'Follow-up from s.chen@acme.com. Key procurement detail: the budget owner is the CFO (David Okafor), and any purchase over $50k needs CFO sign-off.',
    },
    {
      id: 'int_globex_email',
      accountId: 'acc_globex',
      contactEmail: 'marco@globex.io',
      kind: 'email',
      date: daysAgo(3),
      summary: 'Marco asked about self-hosting and pricing. Actively evaluating this quarter.',
    },
    {
      id: 'int_pied_email',
      accountId: 'acc_pied',
      contactEmail: 'erlich@piedpiper.com',
      kind: 'email',
      date: daysAgo(2),
      summary: 'Erlich wants a demo. Said their current stack cannot join data across tools.',
    },
    {
      id: 'int_initech_note',
      accountId: 'acc_initech',
      contactEmail: 'priya@initech.com',
      kind: 'note',
      date: daysAgo(40),
      summary: 'Priya went quiet after a good first call in Q1. No recent activity.',
    },
    {
      id: 'int_cyber_note',
      accountId: 'acc_cyberdyne',
      contactEmail: 'miles@cyberdyne.ai',
      kind: 'note',
      date: daysAgo(55),
      summary: 'Miles engaged early but budget froze. Revisit next quarter.',
    },
  ],

  // Signals: hiring, funding, tech-stack, intent. Fresh (last 7 days) intent on the
  // three FOCUS accounts. Stale or weak elsewhere.
  signals: [
    { id: 'sig_acme_intent', accountId: 'acc_acme', kind: 'intent', strength: 'high', date: daysAgo(4), detail: 'Repeated visits to the pricing and self-host docs.' },
    { id: 'sig_acme_hiring', accountId: 'acc_acme', kind: 'hiring', strength: 'medium', date: daysAgo(20), detail: 'Hiring 2 RevOps engineers.' },
    { id: 'sig_globex_intent', accountId: 'acc_globex', kind: 'intent', strength: 'high', date: daysAgo(3), detail: 'Downloaded the integration guide, opened three emails.' },
    { id: 'sig_globex_funding', accountId: 'acc_globex', kind: 'funding', strength: 'high', date: daysAgo(15), detail: 'Raised a Series A.' },
    { id: 'sig_pied_intent', accountId: 'acc_pied', kind: 'intent', strength: 'high', date: daysAgo(2), detail: 'Booked a demo, active on the docs.' },
    // Non-focus accounts: either wrong ICP, or no fresh intent.
    { id: 'sig_initech_intent', accountId: 'acc_initech', kind: 'intent', strength: 'low', date: daysAgo(38), detail: 'A single doc view over a month ago.' },
    { id: 'sig_cyber_tech', accountId: 'acc_cyberdyne', kind: 'tech', strength: 'medium', date: daysAgo(50), detail: 'Adopted a competing tool.' },
    { id: 'sig_hooli_intent', accountId: 'acc_hooli', kind: 'intent', strength: 'high', date: daysAgo(1), detail: 'Very active, but far outside ICP (enterprise consumer tech).' },
    { id: 'sig_massive_intent', accountId: 'acc_massive', kind: 'intent', strength: 'medium', date: daysAgo(10), detail: 'Some activity, ICP-borderline on size.' },
  ],

  // A couple of closed deals, so the ICP model has ground truth in the story.
  deals: [
    { id: 'deal_1', accountId: 'acc_globex', stage: 'closed_won', amount: 24000, date: daysAgo(120), note: 'Landed on self-host, expanded to Cloud.' },
    { id: 'deal_2', accountId: 'acc_cyberdyne', stage: 'closed_lost', amount: 0, date: daysAgo(90), note: 'Lost, budget froze mid-cycle.' },
    { id: 'deal_3', accountId: 'acc_stark', stage: 'closed_lost', amount: 0, date: daysAgo(200), note: 'Wrong ICP, manufacturing, never a fit.' },
  ],
};

// ---------------------------------------------------------------------------
// Ground truth. The planted answers the scorers check against.
// ---------------------------------------------------------------------------

export const GROUND_TRUTH = {
  // Task 3: Sarah Chen is ONE person across three identifiers and three sources.
  identity: {
    isOnePerson: true,
    canonicalName: 'Sarah Chen',
    identifiers: ['sarah@acme.com', 's.chen@acme.com', 'https://www.linkedin.com/in/sarahchen-revops'],
    sources: ['email', 'meeting', 'crm'],
  },
  // Task 1: the buried fact that lives only under the secondary email.
  acmeBuriedFact: {
    // Substrings the answer must contain to prove it surfaced the fact.
    // Scored as: must hit the CFO idea AND the $50k / sign-off idea.
    factSubstrings: ['CFO', '50k'],
    fullFact: 'The budget owner at Acme is the CFO (David Okafor); any purchase over $50k needs CFO sign-off.',
  },
  // Task 2 / t5: the three accounts that are the correct focus set
  // (high ICP fit + fresh intent in the last 7 days).
  focusAccounts: ['Acme Corp', 'Globex', 'Pied Piper'],
};

// ---------------------------------------------------------------------------
// Deterministic scoring helpers used by resolvedView so Arm B gets computed
// ICP fit and intent, exactly as the graph would precompute them.
// ---------------------------------------------------------------------------

function icpFit(account) {
  const s = account.icpSignals || {};
  let score = 0;
  if (s.rightIndustry) score += 40;
  if (s.rightSize) score += 35;
  if (s.usesModernStack) score += 25;
  return score; // 0..100
}

function freshIntent(fixture, accountId) {
  // "Fresh" = an intent signal in the last 7 days, strength high or medium.
  return fixture.signals.some(
    (sig) =>
      sig.accountId === accountId &&
      sig.kind === 'intent' &&
      (sig.strength === 'high' || sig.strength === 'medium') &&
      daysBetween(sig.date, REFERENCE_DATE) <= 7,
  );
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + 'T00:00:00Z').getTime();
  const b = new Date(isoB + 'T00:00:00Z').getTime();
  return Math.abs(Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

// ---------------------------------------------------------------------------
// rawView: the scattered, unresolved rows Arm A's tools read.
// Duplicates are preserved. Nothing is joined. Nothing is scored. This mirrors
// "point the agent at every raw tool" and is the honest baseline. It is a fair
// baseline: the data is all there and correct, it just is not resolved.
// ---------------------------------------------------------------------------

export function rawView(fixture = FIXTURE) {
  return {
    // Contact rows exactly as they sit in each source, duplicates intact.
    contacts: fixture.contacts.map((c) => ({
      id: c.id,
      account: fixture.accounts.find((a) => a.id === c.accountId)?.name ?? null,
      accountDomain: fixture.accounts.find((a) => a.id === c.accountId)?.domain ?? null,
      name: c.name,
      title: c.title,
      email: c.email,
      linkedin: c.linkedin,
      source: c.source,
    })),
    // Activities keyed by whatever contact identifier the source used. No entity join.
    activities: fixture.interactions.map((i) => ({
      id: i.id,
      account: fixture.accounts.find((a) => a.id === i.accountId)?.name ?? null,
      contactEmail: i.contactEmail,
      kind: i.kind,
      date: i.date,
      summary: i.summary,
    })),
    // Raw CRM rows: accounts + open/closed deals, no scoring, no intent rollup.
    crmRows: fixture.accounts.map((a) => {
      const deal = fixture.deals.find((d) => d.accountId === a.id) || null;
      return {
        account: a.name,
        domain: a.domain,
        industry: a.industry,
        employees: a.employees,
        latestDealStage: deal ? deal.stage : 'open',
        latestDealAmount: deal ? deal.amount : null,
      };
    }),
    // Raw signal rows, ungraded, not rolled up to a score.
    signals: fixture.signals.map((s) => ({
      account: fixture.accounts.find((a) => a.id === s.accountId)?.name ?? null,
      kind: s.kind,
      strength: s.strength,
      date: s.date,
      detail: s.detail,
    })),
  };
}

// ---------------------------------------------------------------------------
// resolvedView: the resolved account blocks Arm B's tools read.
// Identity merged (one canonical Sarah), the buried fact attached to Acme, ICP
// fit + intent computed. This is the get_context / query projection: one compact,
// resolved block per account, ranked, ready to act on.
// ---------------------------------------------------------------------------

export function resolvedView(fixture = FIXTURE) {
  // Resolve contacts: collapse the three Sarah fragments into one canonical person.
  const resolvedContactsByAccount = {};
  for (const account of fixture.accounts) {
    resolvedContactsByAccount[account.id] = [];
  }

  // Group Sarah's three rows into one resolved person.
  const sarahRows = fixture.contacts.filter((c) =>
    ['con_sarah_1', 'con_sarah_2', 'con_sarah_3'].includes(c.id),
  );
  const sarahResolved = {
    id: 'ent_sarah_chen',
    name: 'Sarah Chen',
    title: 'VP of Revenue Operations',
    identifiers: sarahRows.map((r) => r.email || r.linkedin).filter(Boolean),
    sources: [...new Set(sarahRows.map((r) => r.source))],
    resolvedFrom: sarahRows.length, // 3 fragments merged into 1
  };
  resolvedContactsByAccount['acc_acme'].push(sarahResolved);

  // Everyone else resolves 1:1.
  for (const c of fixture.contacts) {
    if (['con_sarah_1', 'con_sarah_2', 'con_sarah_3'].includes(c.id)) continue;
    resolvedContactsByAccount[c.accountId].push({
      id: `ent_${c.id}`,
      name: c.name,
      title: c.title,
      identifiers: [c.email || c.linkedin].filter(Boolean),
      sources: [c.source],
      resolvedFrom: 1,
    });
  }

  // Build one resolved account block per account.
  const accounts = fixture.accounts.map((a) => {
    const fit = icpFit(a);
    const hasFreshIntent = freshIntent(fixture, a.id);
    const isFocus = GROUND_TRUTH.focusAccounts.includes(a.name);

    // Durable facts attached to the RESOLVED account. For Acme this includes the
    // buried fact, because both emails resolved to the same account and person.
    const durableFacts = [];
    if (a.id === 'acc_acme') {
      durableFacts.push(GROUND_TRUTH.acmeBuriedFact.fullFact);
    }

    // Timeline: all interactions, already attributed to the resolved account.
    const timeline = fixture.interactions
      .filter((i) => i.accountId === a.id)
      .map((i) => ({ date: i.date, kind: i.kind, summary: i.summary }))
      .sort((x, y) => (x.date < y.date ? 1 : -1));

    const accountSignals = fixture.signals
      .filter((s) => s.accountId === a.id)
      .map((s) => ({ kind: s.kind, strength: s.strength, date: s.date, detail: s.detail }));

    const deal = fixture.deals.find((d) => d.accountId === a.id) || null;

    return {
      id: a.id,
      name: a.name,
      domain: a.domain,
      industry: a.industry,
      employees: a.employees,
      icpFit: fit, // precomputed 0..100
      hasFreshIntent, // precomputed boolean
      focusRank: isFocus ? 'high' : 'low', // the graph's ranked "who to focus on"
      stakeholders: resolvedContactsByAccount[a.id],
      durableFacts,
      recentSignals: accountSignals,
      timeline,
      latestDeal: deal ? { stage: deal.stage, amount: deal.amount, note: deal.note } : null,
    };
  });

  return { accounts };
}
