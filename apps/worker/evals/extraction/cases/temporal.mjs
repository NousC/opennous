// TEMPORAL (GET-1048): a relative date resolves against when it was SAID (input.saidAt), and a date
// the text does not give is never invented. The extractor reads a conversation with no calendar of
// its own, so "next quarter" from a model with a stale sense of today becomes a quarter of the wrong
// year, and "after the board meeting" becomes a month nobody said. The runner's placeholder-year
// check (checks.mjs) catches the crude form; the judge catches the rest.
import { OUR_SIDE, BRINDLE, INES, ATLAS, RUAIRI } from './_shared.mjs';

export default [
  {
    id: 'tmp-next-quarter',
    category: 'temporal',
    minimum: true,
    origin: 'A relative timeline ("end of next quarter") was written with a year the call was not in.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-14',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: What does timing look like on your side?
Ines Halloran: We want this live before the end of next quarter. The new account executives start in the new year and I want them on it from their first week.
Theo Bramwell: So we'd want a decision in the next few weeks.
Ines Halloran: Realistically, yes.`,
    },
    must: ['A claim records that Brindle wants it live before the end of next quarter (or by the end of the first quarter of 2027), for the new account executives starting in the new year.'],
    traps: ['A claim gives a year other than 2026 or 2027 for this timeline.'],
    expect: {},
  },
  {
    id: 'tmp-no-invented-date',
    category: 'temporal',
    origin: 'A decision tied to an undated event was given a month the buyer never said.',
    input: {
      kind: 'email',
      saidAt: '2026-09-09',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Mara,

Thanks for the proposal. We'll make the call after our board meeting. I don't have a date for it yet, it moves around every year. I'll come back to you once it's done.

Ruairi`,
    },
    must: ['If a timeline claim is recorded, it says the decision comes after the board meeting, with no date.'],
    traps: ['A claim gives a specific day, month, or quarter for the board meeting or for the decision.'],
    expect: { maxClaims: 2 },
  },
  {
    id: 'tmp-last-month',
    category: 'temporal',
    origin: '"Last month" in an early-year call was written as a month of the wrong year.',
    input: {
      kind: 'meeting',
      saidAt: '2026-01-12',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Anything changed since we last spoke?
Ines Halloran: One big thing. We finished the switch to Tallyhook last month, the whole sales team is on it now and the old spreadsheets are gone.
Theo Bramwell: How's adoption?
Ines Halloran: Better than I feared. Reps log their calls there every day.`,
    },
    must: ['A claim records that Brindle\'s sales team is now on Tallyhook (switch finished, old spreadsheets gone).'],
    traps: ['A claim dates the switch to Tallyhook to a month or year other than December 2025.'],
    expect: { contains: ['Tallyhook'] },
  },
  {
    id: 'tmp-renewal-date',
    category: 'temporal',
    origin: 'A renewal date with no year was given the year the conversation was in, which had already passed it.',
    input: {
      kind: 'email',
      saidAt: '2026-11-20',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Hi Mara,

Our contract with Lanternly renews on January 15th, and I'd like a decision well before then so we're not auto-renewed for another year.

Ruairi`,
    },
    must: ['A claim records that the Lanternly contract renews on January 15 (2027 if a year is given) and that Ruairi wants a decision before then.'],
    traps: ['A claim gives the renewal year as 2026, or any year other than 2027.'],
    expect: { contains: [['Jan', '01-15', '1/15']] },
  },
];
