// The canonical ICP template — ONE structure every workspace's ICP file follows,
// so the file the user maintains, what onboarding scaffolds, and what the scoring
// model reads all agree. Before this, onboarding free-wrote the ICP from a prose
// prompt, so every user's file had a different shape and the model seeded from
// whatever happened to be written. This is the shared skeleton.
//
// The sections, in order, are the model's foundation:
//   The buyer            — WHO the buyer actually is (the human, not the checkbox).
//                          This is the qualitative context every agent reads before
//                          acting; it was the missing piece.
//   Who is a fit         — scored inclusion segments (0–100), highest first.
//   Who is NOT a fit     — hard disqualifiers that cap a lead below Not-ICP.
//   Trigger signals      — the WHEN (feeds the decaying intent score, not fit).
//   Anchors              — real named examples for the model to reason from.
//
// The <!-- nous:icp start/end --> markers are where export_icp_model writes the
// LEARNED half back in (which signals actually predict a win, from closed-won/lost
// deals) — see icpModel.mjs renderIcpBlock(). The human writes ABOVE the block;
// Nous owns everything inside it. So the file compounds: your definition on top,
// what Nous learned underneath, one document.
//
// Usage: onboarding/scaffold seeds a new context/icp.md from ICP_TEMPLATE, then the
// agent fills each <!-- guidance --> with the workspace's real answers.

export const ICP_TEMPLATE = `# ICP — <one line: the single definition you score every lead against>

<!-- One short paragraph: who this "ocean" is, and why it is ONE score across every
     product and motion. E.g. "Everyone worth our time in <space>, whether they
     become a <product A> customer, a <product B> customer, a partner, or a peer.
     One score; which product we pitch is a downstream tag." -->

## The buyer

<!-- The human, not the checkbox — 4–8 sentences the scoring model and every agent
     reads before acting. Cover, in your own prose:
       - WHO they are: role, seniority, the kind of company they run or work in.
       - THEIR WORLD: what they do all day, the systems they live in, who they answer to.
       - THEIR PAIN: the specific friction that puts them in-market for you.
       - HOW THEY THINK: what they value, how they buy, where they show up (channels).
       - WHY THEY BUY YOU: the wedge — what changes for them when they adopt you.
     This is the section that turns a scorecard into a buyer. Don't skip it. -->

## Who is a fit (inclusion, highest first)

<!-- Each line is a distinct fit segment with a 0–100 anchor score, best fit first.
     Include the firmographic envelope (industry, size) as its own line. -->
- **<segment>** (<score>). <why / best fit>.

## Who is NOT a fit (hard disqualifiers)

<!-- Decisive exclusions — any ONE caps the lead below Not-ICP regardless of fit. -->
- **<disqualifier>:** <what it means>.

## Trigger signals (reach out now)

<!-- The WHEN, not the WHO — behaviours that say "now is the moment". These feed the
     decaying intent score, separate from durable fit. Describe each in your space:
     friction, hiring, momentum, stack change, posted intent. -->
<friction ... · hiring ... · momentum ... · stack change ... · posted intent ...>

## Anchors

<!-- Real, named examples so the model and agents have ground truth to reason from. -->
- **Fit:** <Name (Company), why>.
- **Not a fit:** <Name/type, why> (optional).

<!-- The product/motion tag is applied AFTER scoring — scoring is one ocean; state
     your product mapping here if you have more than one offer. -->

<!-- nous:icp start -->
<!-- Managed by Nous from your closed-deal outcomes. Which signals actually predict a
     win — and by how much — is learned here and regenerated on each sync. Edit your
     ICP ABOVE this block, never inside it. -->
<!-- nous:icp end -->
`;

// The canonical sections a complete ICP file carries, keyed by slug with the
// heading text the checker matches (loosely — see missingIcpSections). Order is
// the order they should appear in the file. `The buyer` is the qualitative
// context; the rest are what the scoring model reads.
export const CANONICAL_ICP_SECTIONS = [
  { slug: 'buyer',    label: 'The buyer',            match: /^#+\s*the buyer\b/im },
  { slug: 'fit',      label: 'Who is a fit',         match: /^#+\s*who is a fit\b/im },
  { slug: 'not_fit',  label: 'Who is NOT a fit',     match: /^#+\s*who is not a fit\b/im },
  { slug: 'triggers', label: 'Trigger signals',      match: /^#+\s*trigger signals\b/im },
  { slug: 'anchors',  label: 'Anchors',              match: /^#+\s*anchors\b/im },
];

// Which canonical sections are absent from an ICP file's markdown. Heading-based
// and forgiving of casing/punctuation — a warning, never a hard gate, so a user
// with a differently-shaped ICP is nudged, not blocked. Returns the section
// labels that weren't found.
export function missingIcpSections(content) {
  const text = String(content || '');
  return CANONICAL_ICP_SECTIONS.filter(s => !s.match.test(text)).map(s => s.label);
}
