// NO INVENTION (GET-1048): every value in a claim belongs to the subject it is filed on. A number
// that was said about a sister company, a previous employer, another vendor's quote or our own
// price list is not the account's number. Borrowing one is worse than missing it: a rep then
// quotes it back to the customer.
import { OUR_SIDE, BRINDLE, INES, ATLAS, RUAIRI } from './_shared.mjs';

export default [
  {
    id: 'noinv-sister-company-number',
    category: 'no_invention',
    minimum: true,
    origin: 'A headcount the buyer gave for a related company was filed as the account\'s own team size.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-02',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: How big is the sales team?
Ines Halloran: Depends who you count. Our sister company has forty reps, but they buy their own tools. Here at Brindle we have twelve, all in one office.
Theo Bramwell: And it's the twelve we'd be talking about.
Ines Halloran: Just the twelve.`,
    },
    must: ['A claim records that Brindle\'s sales team has twelve reps.'],
    traps: ['A claim says Brindle has forty reps, or a team size other than twelve.'],
    expect: { contains: [['twelve', '12']] },
  },
  {
    id: 'noinv-previous-employer',
    category: 'no_invention',
    origin: 'A tool the buyer used at a previous employer was filed as the current account\'s stack.',
    input: {
      kind: 'meeting',
      saidAt: '2026-09-24',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Ines Halloran: I've been burned before. At Atlas Freight, where I worked before Brindle, we churned off Brightlist after six months because the data went stale.
Theo Bramwell: And here?
Ines Halloran: Here we've never bought a data tool. Everything is typed in by the reps.`,
    },
    must: ['Any claim that mentions Brightlist makes clear it was at Ines Halloran\'s previous employer, not at Brindle.'],
    traps: ['A claim says Brindle uses, used, or churned off Brightlist.'],
    expect: {},
  },
  {
    id: 'noinv-our-price-not-their-budget',
    category: 'no_invention',
    origin: 'Our own list price, said by the rep, was filed as the buyer\'s agreed budget.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-21',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Ruairi Doyle: What does it cost?
Mara Quint: The team plan starts at forty-nine dollars a seat per month.
Ruairi Doyle: Okay. I'll need to see that in writing before I can say anything about it.
Mara Quint: I'll send the order form today.`,
    },
    must: [],
    traps: [
      'A claim says Atlas Freight or Ruairi Doyle has a budget of forty-nine dollars a seat, or agreed to that price.',
    ],
    expect: { notCategories: ['budget'] },
  },
  {
    id: 'noinv-competitor-quote-not-budget',
    category: 'no_invention',
    origin: 'Another vendor\'s quote was filed as the buyer\'s budget.',
    input: {
      kind: 'email',
      saidAt: '2026-10-05',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Hi Theo,

For transparency: Lanternly quoted us thirty thousand a year. Our own budget for this is still not set, Odile will decide it next month.

Ines`,
    },
    must: ['A claim records that Lanternly quoted Brindle thirty thousand a year.'],
    traps: ['A claim says Brindle\'s budget is thirty thousand a year.'],
    expect: { contains: ['Lanternly'] },
  },
];
