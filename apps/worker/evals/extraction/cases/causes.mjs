// CAUSE AND EFFECT (GET-1053): a fact may carry `caused_by` — earlier facts of the same read that the
// text says caused it. Checked by code (expect.links): a link counts only when both of its facts are
// in what the read files. Every name is invented (see _shared.mjs).
import { OUR_SIDE, BRINDLE, INES } from './_shared.mjs';

export default [
  {
    id: 'causes-budget-frozen-after-cfo-left',
    category: 'attribution',
    origin: 'A budget freeze and the CFO departure behind it were filed as two unrelated facts, so nothing said why the deal stalled.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-23',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Where did we land on getting the order form signed this month?
Ines Halloran: Honestly, it's stuck. Our CFO, Wendell Ashcombe, left two weeks ago, and since he left we've frozen the budget for every new tool. Nothing new gets signed until the replacement starts in January.
Theo Bramwell: Understood. Is there anything I can do in the meantime?
Ines Halloran: Keep me posted on the roadmap, but there's no money until then.`,
    },
    must: [
      'A claim records that Brindle froze its budget for new tools (nothing is signed until a new CFO starts).',
      'A claim records that Brindle\'s CFO, Wendell Ashcombe, left.',
    ],
    traps: [],
    expect: {
      categories: ['staff_change'],
      // A budget freeze is a blocker or a budget fact; either is right, the link is what is measured.
      links: [{ from: 'blocker|budget', to: 'staff_change' }],
    },
  },
  {
    id: 'causes-objection-settled-by-our-reply',
    category: 'attribution',
    origin: 'The objection playbook could only guess which of our answers resolved an objection, by the words they shared.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-24',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Ines Halloran: My one real worry is security. Our auditors won't let call recordings leave the EU.
Theo Bramwell: That's covered. Corvane keeps every recording in our Frankfurt region, and the security doc I sent spells out that nothing is copied outside the EU.
Ines Halloran: I read it last night. That settles it for me, the EU hosting was the only thing I needed.
Theo Bramwell: Great, I'll loop in Mara for the rollout plan.`,
    },
    must: ['A claim records that Ines Halloran\'s concern about call recordings leaving the EU was resolved (an objection, resolved).'],
    traps: ['A claim states, as a fact about Ines Halloran or Brindle, that Corvane hosts recordings in Frankfurt.'],
    expect: {
      categories: ['objection'],
      ours: { categories: ['our_reply'] },
      links: [{ from: 'objection', to: 'our_reply' }],
    },
  },
  {
    id: 'causes-unrelated-facts-no-link',
    category: 'attribution',
    origin: 'Two facts said one after the other are not cause and effect; a guessed link would put a false reason in win/loss.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-24',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Ines Halloran: For context, all our deals live in HubSpot, and that's not changing.
Theo Bramwell: Good to know.
Ines Halloran: Different topic: we're hiring two more SDRs in the first quarter, both based in Lisbon.
Theo Bramwell: Congratulations, that's a big step.`,
    },
    must: ['A claim records that Brindle runs its deals in HubSpot (tech_stack).'],
    traps: [],
    expect: {
      categories: ['tech_stack'],
      links: [],
    },
  },
];
