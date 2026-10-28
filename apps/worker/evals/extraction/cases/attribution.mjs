// ATTRIBUTION (GET-1048): whose words, and which record. A rep's guess, a rep's pitch or a vendor's
// line quoted in an email is not the buyer's fact, and a fact one attendee voices about themselves
// lands on THAT person, not on whoever spoke more. The quote guard (spokenByOurSide, GET-417) only
// drops a fact whose QUOTE our side spoke; a fact paraphrased from our side's line gets past it,
// which is what these cases measure.
import { OUR_SIDE, BRINDLE, INES, ODILE } from './_shared.mjs';

export default [
  {
    id: 'att-rep-guess-budget',
    category: 'attribution',
    minimum: true,
    origin: 'On a 1:1 call the rep guessed a price would feel expensive; the guess was filed as the customer\'s budget.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-08',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: So for a team your size, I'd guess something like seven hundred dollars a month would feel expensive for you, right?
Ines Halloran: Honestly I haven't looked at budget at all yet. Money is Odile's call, she's our CFO, and she'll want to see the numbers herself.
Theo Bramwell: Makes sense. Would it help if I put together a one-pager for her?
Ines Halloran: Yes. She reads everything on paper before she signs off on a new tool.`,
    },
    // The case guards attribution: the buyer's own answer is kept, the rep's guess never becomes
    // theirs. "Ines has not looked at budget yet" was dropped from the must: it is a passing remark
    // the deal bar rightly leaves out, and asking for it scored a correct read as a failure.
    must: ['A claim records that budget or spend decisions at Brindle sit with Odile, the CFO.'],
    traps: [
      'A claim says Ines Halloran or Brindle finds seven hundred dollars a month expensive, or has a budget of about seven hundred dollars a month.',
    ],
    expect: { contains: ['Odile'] },
  },
  {
    id: 'att-rep-pitch-not-pain',
    category: 'attribution',
    origin: 'The rep described a pain other teams have; it was filed as the buyer\'s pain.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-14',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Most teams we talk to lose deals because call notes never make it into the CRM. Reps forget, managers fly blind.
Ines Halloran: Sure, I can see that. For us the bigger thing is ramping new reps. We're hiring six account executives in the first quarter and right now it takes them about four months to be useful.
Theo Bramwell: Four months is long.
Ines Halloran: It is, and the board has noticed.`,
    },
    must: ['A claim records that Brindle is hiring six account executives and that new reps take about four months to ramp.'],
    traps: ['A claim says Brindle loses deals because call notes do not make it into the CRM.'],
    expect: {},
  },
  {
    id: 'att-two-people-which-person',
    category: 'attribution',
    origin: 'On a call with two buyers, the budget holder\'s authority was filed on the other attendee.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-20',
      account: BRINDLE,
      people: [INES, ODILE],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Thanks both for making time. Odile, Ines said you'd want to see the commercials.
Odile Ferrant: I do. I sign off on anything over twenty thousand a year, and this would be over that.
Ines Halloran: And I'm the one who'll run it day to day. My team owns the CRM and the reporting.
Odile Ferrant: If Ines tells me it saves her team time, I'll look at it seriously. I won't sign before our security review is done though.
Theo Bramwell: Understood. We can send the security pack this week.`,
    },
    must: [
      'A claim about signing off on spend over twenty thousand a year is attributed to Odile Ferrant.',
      'A claim records that Ines Halloran\'s team will run the tool day to day (or owns the CRM and reporting).',
    ],
    traps: ['A claim says Ines Halloran signs off on the spend or holds the budget.'],
    expect: {},
  },
  {
    id: 'att-quoted-vendor-line',
    category: 'attribution',
    origin: 'A buyer forwarded another vendor\'s marketing line; the line was filed as a fact about the buyer.',
    input: {
      kind: 'email',
      saidAt: '2026-09-17',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Hi Theo,

Quick one. Below is what the Lanternly rep sent me after our call with them:

"Lanternly cuts ramp time in half for every sales team, guaranteed."

Not sure I buy it. We're still comparing Lanternly and you for call insights and I'd like to see how you'd measure ramp time on our data.

Ines`,
    },
    must: ['A claim records that Brindle (Ines Halloran) is comparing Lanternly and Corvane for call insights.'],
    traps: ['A claim states as fact that Lanternly cuts Brindle\'s ramp time in half.'],
    expect: { contains: ['Lanternly'] },
  },
];
