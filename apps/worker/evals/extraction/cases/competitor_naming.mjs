// COMPETITOR NAMING (GET-1048): one product, one name. People say a product's name four ways in one
// call ("Lanternly", "Lanternly AI", "lanternly.io", "the Lanterns thing"), and every spelling the
// extractor keeps is a separate competitor on the account and a separate row on the competitor
// board. The opposite failure matters as much: two different companies with similar names are not
// one. (Matching the names afterwards is GET-1049; these cases measure what the extractor writes.)
import { OUR_SIDE, BRINDLE, INES, ATLAS, RUAIRI } from './_shared.mjs';

export default [
  {
    id: 'cn-variants-one-product',
    category: 'competitor_naming',
    minimum: true,
    origin: 'One competitor said three ways on a call became three competitors on the account.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-16',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Ruairi Doyle: We're also looking at Lanternly for call insights.
Mara Quint: Lanternly AI, the one with the purple logo?
Ruairi Doyle: That's them. Their site is lanternly.io. Honestly the Lanterns tool, as my team calls it, looked slick in the demo, but their summaries missed half of what the customer said.
Mara Quint: So it's a live option.
Ruairi Doyle: It's the main other option, yes.`,
    },
    must: ['Every competitor claim names the product Lanternly, in that one spelling.'],
    traps: ['There are two or more competitor claims for this product under different names (for example "Lanternly" and "Lanternly AI", "lanternly.io" or "Lanterns").'],
    expect: { categories: ['competitor'], contains: ['Lanternly'] },
  },
  {
    id: 'cn-tool-variants',
    category: 'competitor_naming',
    origin: 'A CRM called by a short name in one sentence and its full name in the next became two tools.',
    input: {
      kind: 'meeting',
      saidAt: '2026-09-30',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Ines Halloran: Our CRM is Tallyhook. Everyone just says Tally.
Theo Bramwell: How happy are you with it?
Ines Halloran: Tally is fine for pipeline. Where TallyHook CRM falls down is reporting, the dashboards take a day to refresh, so nobody trusts them in the Monday meeting.`,
    },
    must: ['Every tech_stack claim about the CRM names it Tallyhook (one spelling), and one records that its dashboards take a day to refresh so nobody trusts them.'],
    traps: [
      'A claim names the tool "Tally" as if it were a separate tool from Tallyhook.',
      'A claim records Tallyhook as a competitor.',
    ],
    expect: { notCategories: ['competitor'], contains: ['Tallyhook'] },
  },
  {
    id: 'cn-similar-names-different-companies',
    category: 'competitor_naming',
    origin: 'A recruiting agency with a name like a competitor\'s was merged into that competitor.',
    input: {
      kind: 'email',
      saidAt: '2026-10-19',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Mara,

Two updates. We're still trialling Lanternly for call insights, decision at the end of the month. Separately, we've hired Lantern Labs, a recruiting agency, to find us three more account managers, so the team will be bigger by spring.

Ruairi`,
    },
    must: ['A competitor claim names Lanternly as a call-insights tool Atlas Freight is trialling.'],
    traps: [
      'A claim records Lantern Labs as a competitor, or describes Lantern Labs as a call-insights tool.',
      'A claim merges Lantern Labs and Lanternly into one company.',
    ],
    expect: { categories: ['competitor'], contains: ['Lanternly'] },
  },
  {
    id: 'cn-past-vendor-stance',
    category: 'competitor_naming',
    origin: 'A vendor the buyer had already fired was filed as a live alternative they were evaluating.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-22',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Theo Bramwell: Have you used anything like this before?
Ines Halloran: We had Lanternly for a year. We cancelled it in the spring because the reps stopped opening it, the notes it wrote were generic. I'm not going back to them.
Theo Bramwell: What would have to be different?
Ines Halloran: The notes have to say something a rep didn't already know.`,
    },
    must: ['A competitor claim records Lanternly as a vendor Brindle tried and cancelled (a past failure), not one they are evaluating.'],
    traps: ['A claim says Brindle is currently evaluating or considering Lanternly.'],
    expect: { categories: ['competitor'], contains: ['Lanternly'] },
  },
];
