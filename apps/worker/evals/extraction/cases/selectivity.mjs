// SELECTIVITY (GET-1048): a conversation with nothing durable in it yields nothing. The extractor's
// bar is four tests (about them, durable, decision-relevant, specific; signals/index.mjs
// buildActivitySignalsPrompt), and the cheapest way to fail it is to pad: the weather, a weekend,
// a meeting time, all filed as account intelligence a rep then has to read past.
import { OUR_SIDE, BRINDLE, INES, ATLAS, RUAIRI } from './_shared.mjs';

export default [
  {
    id: 'sel-small-talk-meeting',
    category: 'selectivity',
    minimum: true,
    origin: 'The opening minutes of a call (weather, a weekend away, a reschedule) were filed as facts about the buyer.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-13',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Morning Ines, how was the long weekend?
Ines Halloran: Lovely, thanks. We drove up to the lakes, it rained the whole time but the kids didn't care.
Theo Bramwell: Ha, classic. Same here, the garden is basically a pond now.
Ines Halloran: Sorry I had to move this from Tuesday, the week got away from me.
Theo Bramwell: No problem at all. Shall we pick the walkthrough up on Thursday at two instead? I'll send a fresh invite.
Ines Halloran: Thursday at two works. Send it over and I'll accept it.
Theo Bramwell: Great, talk then. Enjoy the rest of your day.
Ines Halloran: You too, bye.`,
    },
    must: [],
    traps: [
      'A claim records the weather, the weekend trip, the garden, or the children as a fact about Ines Halloran or Brindle.',
      'A claim records the meeting being moved, or the Thursday time, as a fact.',
    ],
    expect: { maxClaims: 0 },
  },
  {
    id: 'sel-scheduling-email',
    category: 'selectivity',
    origin: 'A one-line scheduling reply was filed as a buying signal.',
    input: {
      kind: 'email',
      saidAt: '2026-09-02',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Hi Theo,

Thursday at 3pm works for me. I'll forward the invite to my calendar. Have a good weekend!

Ines`,
    },
    must: [],
    traps: ['A claim says Ines Halloran or Brindle is moving forward, ready to buy, or showed buying intent.'],
    expect: { maxClaims: 0 },
  },
  {
    id: 'sel-thanks-email',
    category: 'selectivity',
    origin: 'A polite acknowledgement was read as interest in the product.',
    input: {
      kind: 'email',
      saidAt: '2026-08-21',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Got it, thanks Mara. I'm out until the 3rd, will take a look when I'm back.

Ruairi`,
    },
    must: [],
    traps: ['A claim says Ruairi Doyle or Atlas Freight is interested in, evaluating or reviewing the product.'],
    expect: { maxClaims: 0 },
  },
  {
    id: 'sel-one-fact-in-chatter',
    category: 'selectivity',
    origin: 'One real fact sat inside ten minutes of chatter; the chatter was filed alongside it.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-06',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Did you catch the match on Saturday?
Ines Halloran: Only the second half. My brother would not stop texting me about it.
Theo Bramwell: Ha. Anyway, how are things on your side since we last spoke?
Ines Halloran: Busy. The big change is we moved the whole support team onto Tallyhook last month, so every customer ticket now lives there next to the deals.
Theo Bramwell: Nice. How's the coffee machine saga going, by the way?
Ines Halloran: Still broken. Someone is coming on Friday, apparently.
Theo Bramwell: Fingers crossed. Same time next week?
Ines Halloran: Yes, same time works.`,
    },
    must: ['A claim records that Brindle moved its support team onto Tallyhook, with customer tickets now kept there.'],
    traps: [
      'A claim records the match, the brother, or the coffee machine as a fact.',
      'A claim records the next meeting time as a fact.',
    ],
    expect: { maxClaims: 2, categories: ['tech_stack'], contains: ['Tallyhook'] },
  },
];
