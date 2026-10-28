// OUR SIDE (GET-1052): what the seller said is recorded as its own facts (home our_side: our_reply,
// commitment, pitch_line), kept apart from the buyer's. The buyer's claims are judged as before;
// our side's facts are checked by code (expect.ours), and the judge never reads them. Every name is
// invented (see _shared.mjs).
import { OUR_SIDE, BRINDLE, INES } from './_shared.mjs';

export default [
  {
    id: 'ours-rep-guess-is-pitch-only',
    category: 'attribution',
    origin: 'A rep\'s guess about what the buyer would pay was filed as the buyer\'s budget; now it is at most our pitch line.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-21',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: For a team your size I'd guess seven hundred a month would feel expensive, and honestly most teams make that back in a quarter.
Ines Halloran: I couldn't tell you yet. I haven't been given a budget for this and I don't want to guess.
Theo Bramwell: Fair enough, no pressure on that today.
Ines Halloran: What I can say is we're replacing our call recorder at the end of the year either way.`,
    },
    must: ['A claim records that Brindle is replacing its call recorder at the end of the year.'],
    traps: ['A claim says Ines Halloran or Brindle finds seven hundred a month expensive, or has a budget of about seven hundred a month.'],
    // The buyer's own "I haven't been given a budget" is a true budget fact and may be kept; what
    // must never happen is our $700 guess becoming theirs, which the trap judges.
    expect: {
      ours: { notCategories: ['our_reply', 'our_commitment'], max: 2 },
    },
  },
  {
    id: 'ours-objection-and-our-reply',
    category: 'attribution',
    origin: 'A buyer objection and our answer to it were one fact, or our answer was lost; the playbook could not say how it was answered.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-22',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Ines Halloran: My worry is the HubSpot sync. Our last tool wrote half the notes to the wrong deal and my reps stopped trusting it.
Theo Bramwell: That's the right worry. Corvane writes every note to the deal it was said about, and anything it can't place goes to a review queue instead of a guess.
Ines Halloran: A review queue I could live with. Who looks at it?
Theo Bramwell: Your ops lead, usually a few minutes a week.`,
    },
    must: ['A claim records that Ines Halloran is concerned about the HubSpot sync filing notes on the wrong deal (an objection).'],
    traps: ['A claim states, as a fact about Ines Halloran or Brindle, that Corvane sends unplaced notes to a review queue.'],
    expect: {
      categories: ['objection'],
      ours: { categories: ['our_reply'], contains: [['review queue', 'wrong deal', 'hubspot']] },
    },
  },
  {
    id: 'ours-commitment-with-date',
    category: 'attribution',
    origin: 'Our promise to send a document by a day was dropped, or filed as the buyer\'s buying signal.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-20',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Ines Halloran: Before I take this to Odile I need something on security. She'll ask about where the data lives.
Theo Bramwell: Understood. I'll send the security doc by Friday, with the data residency section on top.
Ines Halloran: Perfect, Friday works.`,
    },
    must: [],
    traps: ['A claim says Ines Halloran or Brindle will send a security document.'],
    expect: {
      ours: {
        categories: ['our_commitment'],
        contains: [['security doc', 'security document']],
        occurred: [{ contains: ['security doc', 'security document'], start: '2026-10-23', end: '2026-10-23' }],
      },
    },
  },
  {
    id: 'ours-small-talk-is-nothing',
    category: 'attribution',
    origin: 'Our side\'s pleasantries must not become facts of ours or of theirs.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-19',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Morning Ines, how was the long weekend? Did you make it out to the coast in the end?
Ines Halloran: We did, it rained the whole time but the kids loved it.
Theo Bramwell: Ha, classic. Shall we pick this up next week once you're settled back in?
Ines Halloran: Yes, let's do that.`,
    },
    must: [],
    traps: [],
    expect: { maxClaims: 0, ours: { max: 0 } },
  },
];
