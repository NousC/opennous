// CATEGORY (GET-1048): a competitor is a product that does the job WE sell (the offer in
// _shared.mjs). Their CRM, their call recorder, the platform their own product is built on, and a
// bot they built themselves are tech_stack, however much they talk about them. A competitor filed
// wrongly reaches the Events page and the deal health as competitive risk that is not there; one
// filed as tech_stack hides a real alternative. Both directions are measured.
import { OUR_SIDE, BRINDLE, INES, ATLAS, RUAIRI } from './_shared.mjs';

export default [
  {
    id: 'cat-own-bot-not-competitor',
    category: 'category',
    minimum: true,
    origin: 'A customer testing its own internal sales bot against our data had the bot filed as a competitor being evaluated.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-09',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Ines Halloran: So the context is, we built our own sales bot internally. We call it Pipmate. It sits on top of Tallyhook and answers reps' questions about their accounts.
Theo Bramwell: Nice. What does it use as its data today?
Ines Halloran: Just what's in Tallyhook, which is thin. The test I want to run is Pipmate on Tallyhook's data versus Pipmate on your account records, and see which answers are better.
Theo Bramwell: So Corvane would feed Pipmate rather than replace it.
Ines Halloran: Exactly. Pipmate stays. The question is what it reads.`,
    },
    must: ['A claim records that Brindle built its own internal sales bot, Pipmate, on top of Tallyhook.'],
    traps: [
      'A claim records Pipmate as a competitor of Corvane.',
      'A claim records Tallyhook as a competitor of Corvane.',
    ],
    expect: { notCategories: ['competitor'], contains: ['Pipmate'] },
  },
  {
    id: 'cat-crm-and-recorder-are-stack',
    category: 'category',
    origin: 'The buyer\'s CRM and call recorder were filed as competitors because they were named next to our product.',
    input: {
      kind: 'meeting',
      saidAt: '2026-09-29',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Mara Quint: Walk me through your setup today.
Ruairi Doyle: Everything runs on Tallyhook as the CRM. Calls are recorded with Murmurly, and the recordings just sit there. Nobody listens to them.
Mara Quint: So nothing comes out of the recordings into Tallyhook.
Ruairi Doyle: Nothing. That's the gap. We pay for Murmurly and get a folder of audio.`,
    },
    must: ['A claim records that Atlas Freight records calls with Murmurly but nothing from the recordings reaches Tallyhook.'],
    traps: [
      'A claim records Tallyhook as a competitor.',
      'A claim records Murmurly as a competitor.',
    ],
    expect: { notCategories: ['competitor'], categories: ['tech_stack'] },
  },
  {
    id: 'cat-platform-they-build-on',
    category: 'category',
    origin: 'The vendor a prospect builds its own product on was filed as a competitor.',
    input: {
      kind: 'email',
      saidAt: '2026-08-12',
      account: BRINDLE,
      people: [INES],
      ourSide: OUR_SIDE,
      text: `Hi Mara,

Some background before Thursday. Our whole payroll product runs on Quarrystack's APIs, we've been on them since we started, and our engineers know them inside out. Whatever we add for the sales team has to be able to read from Quarrystack too, otherwise half our customer data is invisible to it.

Ines`,
    },
    must: ['A claim records that Brindle\'s product runs on Quarrystack\'s APIs, or that anything for the sales team must read from Quarrystack.'],
    traps: ['A claim records Quarrystack as a competitor of Corvane.'],
    expect: { notCategories: ['competitor'], contains: ['Quarrystack'] },
  },
  {
    id: 'cat-real-competitor-kept',
    category: 'category',
    origin: 'A real alternative for the job we do was filed as tech_stack, hiding the competitive risk.',
    input: {
      kind: 'meeting',
      saidAt: '2026-10-15',
      account: ATLAS,
      people: [RUAIRI],
      ourSide: OUR_SIDE,
      text: `Mara Quint: Are you looking at anything else for this?
Ruairi Doyle: Yes, to be straight with you, we're trialling Lanternly for call insights at the same time. It's the other option on the table. Whichever one gets the deal notes right on our calls wins.
Mara Quint: When does the trial end?
Ruairi Doyle: End of the month.`,
    },
    must: ['A competitor claim names Lanternly as an alternative Atlas Freight is evaluating (trialling) for call insights.'],
    traps: ['Lanternly is recorded only as tech_stack and never as a competitor.'],
    expect: { categories: ['competitor'], contains: ['Lanternly'] },
  },
];
