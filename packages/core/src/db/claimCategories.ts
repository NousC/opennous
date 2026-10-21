// The controlled GTM claim taxonomy.
//
// Every extracted or asserted Intel claim carries exactly one of these category
// keys plus an `about` (person or company). A controlled taxonomy is what turns
// claims from pretty notes into queryable patterns across accounts: "every
// account whose pain is fragmented tooling", "every champion who prefers
// LinkedIn". Free-form LLM categories cannot roll up; these can.
//
// Two kinds of claims live in the graph. Structured claims (job_title, industry)
// are DERIVED from observations by the claim engine. The claims below are
// EXTRACTED from a contact's own words in conversations and carry one of these
// categories. Signals (scoring features: hiring, funding, tech-stack, intent)
// are a SEPARATE system that feeds the ICP and intent scores; they are not
// claims and are not in this taxonomy. Preferences are ONE category here, not a
// system of their own.

/**
 * The four domains the taxonomy falls into, plus the escape hatch (GET-409).
 *
 * A category's domain is which QUESTION its claims answer, and which reader is allowed to act
 * on them. Until this was declared, the split lived in a doc table and the readers keyed on
 * category names — which is how a customer's expansion ask advanced a prospect's pipeline stage
 * for a fortnight (it was filed as `buying_signal`, and `stageDerivation` read that by name).
 * A reader that guards on the domain cannot be joined by a category from the wrong one.
 *
 *   account   durable truths about the account: who decides, how they work, how they found us
 *   deal      what is happening with this sales motion: intent, objections, budget, timing, rivals
 *   customer  what is happening after they became a customer: usage, expansion, risk
 *   product   problems, wanted outcomes and results — read by product, at any stage
 *   general   the escape hatch
 */
export type ClaimDomain = 'account' | 'deal' | 'customer' | 'product' | 'general';
export const CLAIM_DOMAINS: readonly ClaimDomain[] = ['account', 'deal', 'customer', 'product', 'general'];

export interface ClaimCategoryDef {
  /** The canonical, queryable key. Lowercase, snake_case. */
  key: string;
  /** Human label for display. */
  label: string;
  /** Which question this category answers, and which reader may act on it. */
  domain: ClaimDomain;
  /** Whether the claim is usually about the person, the company, or either. */
  about: 'person' | 'company' | 'either';
  /** One-line definition, used in the extractor prompt. */
  description: string;
  /** A concrete example, used in the extractor prompt. */
  example: string;
}

export const CLAIM_CATEGORIES: ClaimCategoryDef[] = [
  {
    key: 'status_quo',
    label: 'Status Quo',
    domain: 'account',
    about: 'either',
    // NARROWED 2026-09-18. A sample showed a good share of this category was really
    // `adoption` — "the office manager checks it every Monday", "only the two closers use it", "has
    // not set up the shared calendar yet". They landed here because "the tools they have in place" is
    // true of OUR product too, and the old wording never said otherwise. A seasonal shutdown was
    // sitting here as well, after `seasonality` existed to hold it.
    //
    // Two categories whose descriptions overlap do not offer the model a choice, they offer it a
    // coin flip, and the distribution becomes noise while everything still looks fine. So this one
    // says what it is NOT.
    // NARROWED again 2026-10-08 (GET-776): the tools themselves moved to tech_stack, filed on the
    // company and grouped by tool. On one account 46 status_quo claims were mostly a tool list
    // (CRM, dialers, note-taker, analytics, AI agents) scattered across the person's record.
    description: 'How their team works today — the process and workflow: how a lead is handled, who does what, what is done by hand. NOT the tools they use (that is tech_stack), NOT how they use OUR product (that is adoption), NOT whether someone can use it (proficiency), and NOT their busy and quiet seasons (seasonality).',
    example: 'Every lead is re-entered into the CRM by hand after the qualification call, so reps lose an hour a day.',
  },
  {
    key: 'goal',
    label: 'Goal',
    domain: 'product',
    about: 'either',
    description: 'An initiative, priority, or outcome they are trying to achieve.',
    example: 'Wants to consolidate enrichment vendors before end of Q3.',
  },
  {
    key: 'pain',
    label: 'Pain',
    domain: 'product',
    about: 'either',
    // NARROWED 2026-09-21 (GET-401). A stated cancellation sat here because a cancellation is
    // frustrating and nothing else would take it. A problem with the product and a threat to the
    // relationship are different facts to a CS owner: one is a ticket, the other is a call today.
    description: 'A stated problem or frustration, with the concrete reason why. NOT a stated intent to cancel, leave, or review vendors — that is risk_signal.',
    example: "Clay's list-building is bottlenecked by manual work.",
  },
  {
    key: 'objection',
    label: 'Objection',
    domain: 'deal',
    about: 'either',
    // An existing customer turning down a SPECIFIC ADDITIONAL product is expansion_signal with
    // stance declined, not an objection: the decline has to suppress that product for a year
    // (GET-401), and an objection has no product to suppress.
    description: 'A concern, pushback, or challenge to us — price, security, timing, switching cost, competitor loyalty, or skepticism that we are meaningfully different from the alternatives. Applies even when the person is a peer or advisor, not a buyer. NOT an existing customer declining one more product (that is expansion_signal, stance declined).',
    example: 'Questioned how we differ from memory tools like Fireflies that already sync notes to the CRM.',
  },
  {
    key: 'authority',
    label: 'Authority',
    domain: 'account',
    about: 'person',
    description: 'Buying role and decision power: champion, blocker, economic buyer, or end user.',
    example: 'Owns the GTM-tooling budget; spend over $50k needs VP sign-off.',
  },
  {
    key: 'budget',
    label: 'Budget',
    domain: 'deal',
    about: 'either',
    description: 'Budget size, procurement process, or a commercial constraint.',
    example: 'Has roughly $30k a year earmarked for GTM data tooling.',
  },
  {
    key: 'timeline',
    label: 'Timeline',
    domain: 'deal',
    about: 'either',
    description: 'A buying or project timeline tied to a business reason, including how long they need something or commit for ("we need this pace for another couple of months, not thinking six months"). Never a meeting time.',
    example: 'Evaluating vendors this quarter, driven by a budget review.',
  },
  {
    key: 'buying_signal',
    label: 'Buying Signal',
    domain: 'deal',
    about: 'either',
    // The deal-progression category. Distinct from goal/timeline/budget because it
    // marks the account ACTIVELY MOVING TO CLOSE, not a durable fact about them. The
    // stage worker and the intent score read this category by name (a fresh buying
    // signal advances stage to negotiation and floors intent Hot), so keep it to
    // genuine close motions, never generic interest.
    //
    // NARROWED 2026-09-21 (GET-401). On a customer account this was also holding "could we add
    // the second location" and "is there a cost for the add-on module" — an EXISTING customer asking for MORE.
    // That is expansion_signal now. The two look alike on the page and are opposite in what they
    // drive: this one advances a prospect's stage; that one opens a CS opportunity on an account
    // that already has a stage.
    description: 'An explicit deal-progression signal from a PROSPECT: they asked for the agreement or contract, accepted or agreed to pricing, gave a verbal commitment, said they are ready to move forward or to take it to the other stakeholders or decision-makers, asked to start or onboard, or requested the concrete next step to buy. NOT a setup step: pushing paperwork such as an NDA through, giving access or API keys, or promising to send a list is logistics, not a decision to buy. The account actively moving toward a close, not general interest or a future goal. NOT an existing customer asking for more product or seats (that is expansion_signal).',
    example: 'Asked us to send the agreement and confirmed they will prepay the $2.5k to get started.',
  },
  {
    key: 'preference',
    label: 'Preference',
    domain: 'account',
    about: 'person',
    description: 'How to work with them: channel, cadence, communication style, or format.',
    example: 'Strongly prefers tools with a native API over no-code builders.',
  },
  {
    key: 'competitor',
    label: 'Competitor',
    domain: 'deal',
    about: 'either',
    // A competitor of OURS, not a vendor of theirs (ruled 2026-09-14). The model filed Fellow, JustCall
    // and ZoomInfo as competitors because they are "competing tools" in the abstract; they compete with
    // nothing we sell. An incumbent competitor also raises deal-health risk, so a misfiled stack tool
    // made healthy deals look contested.
    description: 'A product that does the job WE sell: an alternative to us they use, are evaluating, compared us with, or tried and dropped — why, and how loyal they are to it. Never a tool in their stack that does something else (that is status_quo).',
    example: 'Evaluating Gong forecasting alongside us, but says its price rules it out.',
  },
  {
    // How the relationship began. Its own category because a content-led / inbound
    // GTM lives or dies on knowing WHICH content, channel, or referral actually
    // brought a real person in — that is the feedback loop, and it has no home in
    // any "what they are/do" category. About the RELATIONSHIP, not the prospect's
    // own world.
    key: 'discovery',
    label: 'Discovery',
    domain: 'account',
    about: 'person',
    description: 'How this relationship began — the content, channel, post, referral, or event that brought them to us, and why they reached out. Always from the contact\'s side (how THEY found US), naming the contact as the subject — never written as us finding or addressing them.',
    // Names the subject and puts the contact on the finding side, so a single inbound
    // message ("hi, saw your video…") is not turned into a subject-dropped "Found us…"
    // template that the model then inverts into "<owner> found you… after viewing your
    // profile." The contact is the subject; we are "us".
    example: 'Marta Ellingsen found us through our YouTube video on open-source GTM and reached out on LinkedIn.',
  },
  {
    // Key stays 'relationship' (existing claims are tagged with it); the label is
    // "Connections" because this is the network layer — who they know, who they run
    // with, the shared/mutual contacts that open a warm path. Named people captured
    // here also feed the graph as KNOWS/WORKS_WITH edges (see extractGraphEdgesBatch),
    // which is what turns "he mentioned Tobiah" into "Tobiah is a common connection".
    key: 'relationship',
    label: 'Connections',
    domain: 'account',
    about: 'person',
    description: 'A durable connection to another person or org — reports-to, referred-by, a shared or mutual connection, a community they run or belong to, a specific person they name knowing, OR an offer to introduce or connect us to specific people, communities, or organizations.',
    example: 'Offered to introduce us to seed- and YC-stage founders in his network.',
  },
  {
    // Promoted 2026-09-18 (GET-327): mined from `general` over two weeks of one customer's Fellow
    // corpus.
    //
    // The blind spot a sales-shaped taxonomy has in a customer-success motion. Who is trained, who
    // has never opened the product, who is the only person actually using it — that is the account's
    // operating state, and it decides who gets training and who gets removed from a seat.
    key: 'proficiency',
    label: 'Proficiency',
    domain: 'customer',
    about: 'person',
    description: 'How able this person is with the product or the domain: trained or not, an active user or a dormant one, expert or new to it. About capability and use, not about liking it (preference) or wanting it (goal).',
    example: 'Corwin knows how to read a cohort retention report; Ysolde has never used the tool.',
  },
  {
    // Promoted 2026-09-18 (GET-327). Cleared the bar on its own
    // evidence in the second mining, having first been argued for on the grounds that the health
    // read already had an `adoption` field while claims did not — the same fact captured on a
    // business review and discarded on a training call.
    key: 'adoption',
    label: 'Adoption',
    domain: 'customer',
    about: 'either',
    // `about` decides whose page a claim lands on, and 'either' is an invitation to guess. Both
    // adoption claims from one invented-for-illustration call — "Odalys set up the shared inbox",
    // "Odalys says she is the only person who really uses it" — would be filed on the COMPANY, and
    // her own page would show nothing while the facts about her sat one level up. So the rule is in the
    // description rather than left to the model's sense of it.
    description: 'How far the product is actually in use: rolled out or stalled, which team uses it, what it has produced. A statement about real usage, not an intention to use it (goal) or an ability to (proficiency). WHOSE claim it is: if it names a person and what THEY do with it, set about=person ("Odalys is the only one who uses the dashboard"); if it is the account\'s rollout or a result, set about=company ("the signup form on their website has brought in 20 leads").',
    example: 'The signup form on their website has already brought in about 20 leads.',
  },
  {
    // Promoted 2026-09-18 (GET-327).
    //
    // It earns its place by preventing a specific false alarm. Without it, a December collapse in
    // usage reads as churn risk; with it, it is the calendar. A company that shuts for three
    // weeks at year end is not disengaging.
    key: 'seasonality',
    label: 'Seasonality',
    domain: 'account',
    about: 'company',
    description: 'When this business is busy or quiet, and why: the season it gears up for, the months that dip, a shutdown, a demand cycle. About the rhythm of their year, not a one-off date (timeline).',
    example: 'They gear up for a Q4 renewal push and shut down for three weeks at year end.',
  },
  {
    // Promoted 2026-09-18 by the promotion rule (GET-327), on claims mined
    // from `general` over two weeks of one customer's Fellow corpus. It did not clear on the first
    // mining and emerged on the second.
    //
    // It is the only category here that INVALIDATES rather than describes. Every other claim is a
    // state: this is a CHANGE of state, and the difference is load-bearing. A departure ends the
    // authority claim it contradicts. A new hire is training demand, not trivia. A reorganisation
    // resets who talks to whom. That is why it carries `change` from a closed set — a rule can act
    // on a label, and cannot act on prose.
    key: 'staff_change',
    label: 'Staff Change',
    domain: 'account',
    about: 'either',
    description: 'Someone joining, leaving, changing role, being away for months, or a team being reorganised. Set "change" to one of: "left" (departed the company or that role), "joined" (a new hire, or newly in the role), "moved" (changed role or location inside the same company), "reorg" (a team restructured), "away" (out for months on parental, medical or other extended leave — say from when, and until when if it was stated). Being out of office this week or on vacation is not a staff change.',
    // "Being away this week is not a staff change" also kept out the ones that matter: an extended
    // parental leave with a return date landed in `general` (a handful of rows, 2026-09-22). That
    // is nowhere near the evidence that promoted firmographic or staff_change itself, so this is not
    // a new category — it is the exclusion, narrowed to what it meant.
    // A rep needs "back March 3rd, 2027" for the same reason they need "left the company": the
    // person they are waiting on is not there.
    example: 'Osric left the company last month; he was the operations manager.',
  },
  {
    // Promoted 2026-09-19 (GET-373) on the largest body of evidence any category here has had: a large
    // share of `general` claims were this — a monthly sales volume, a location count, a headcount,
    // where most buyers come from by region. The single biggest thing `general` was holding.
    //
    // It was nearly built as company STATE instead of a claim, on the argument that an attribute is
    // updated where a claim is contradicted. Two things decided it: the extractor can only emit
    // claims, so state would have meant dropping these on the floor (which an earlier draft of the
    // extraction instructions actually did, losing a whole run's worth); and a firmographic someone
    // SAYS on a call is evidence, carrying a quote and a speaker, not a system-of-record value. The
    // provider-sourced company properties that feed ICP scoring (employee_count and friends) stay
    // where they are — different provenance, different job.
    key: 'firmographic',
    label: 'Business Profile',
    domain: 'account',
    about: 'company',
    description: 'A standing attribute of the business: how many locations or branches, headcount, the volume they do, the size or mix of what they sell, the segment or customer base they serve, how long they have operated. The SHAPE of the business — not how it is performing right now (performance), and not the tools they run (status_quo).',
    example: 'Ashcombe Health is a fast-growing, self-serve-only software company adding about 150 seats a month.',
  },
  {
    // Promoted 2026-09-19 (GET-372). Found the way a sensor is supposed to work: two week-9
    // extraction agents, working independently on different accounts, each walked all sixteen
    // categories, rejected every one, and filed `general` with a note saying the taxonomy had no
    // home for it — one customer's record month, another's traffic collapse. Re-reading the corpus
    // then turned up more of the same shape across the earlier runs.
    //
    // Why it is not one of its neighbours: `adoption` is what OUR product produced, `seasonality`
    // is a recurring rhythm, `firmographic` is a standing attribute. This is a dated measurement of
    // THEIR business that a later number supersedes — the substance of most QBRs, and often the
    // first thing a rep opens the account to find out.
    //
    // It is the second category to need the durability carve-out, for the same reason as
    // buying_signal: "May was their best month this year" is a snapshot, not a state, and a strict
    // reading of "still true in a month" deletes the category. Both extractor prompts name it in
    // the bar-1 EXCEPTION. The claim is dated by `observed_at` but does NOT expire: `saveNote`
    // writes no `decays_at` for any note claim and nothing reads one, so aging these out needs a
    // read-path change first (GET-375) rather than a column nobody consults.
    key: 'performance',
    label: 'Performance',
    domain: 'product',
    about: 'company',
    description: 'A stated figure or trend in THEIR business results: a record or a slump, leads or sales up or down, a target hit or missed, a conversion rate, one month or quarter against another. Dated by nature — a later number supersedes it. Not our product\'s results (adoption), not a recurring seasonal rhythm (seasonality), not a standing attribute of the business (firmographic).',
    example: 'May was their best sales month this year, well ahead of their other two regions.',
  },
  {
    // Promoted 2026-09-21 (GET-401). Not mined out of `general` like the others: it never reached
    // `general`. The customer-success reads (accountHealthState.ts) had been filing expansion asks
    // as `buying_signal` and the mined ones the same, with the real type hidden in
    // `metadata.signal_type`. The promotion rule could not see a category the taxonomy was already
    // absorbing under another name — so this one was promoted on the evidence the CS tab put on
    // screen: a long list of expansion signals across the first customer's accounts, every one labelled
    // "Buying Signal" on an account that had bought years ago.
    //
    // Why it is not buying_signal: that category ADVANCES STAGE (stageDerivation reads it by name
    // and floors intent Hot). A customer asking about one more product must not move a pipeline
    // it is not in. Why it is not goal: a goal is theirs ("wants to win more enterprise deals"); this is
    // a request for OUR product, which a CS owner can answer with a deal.
    //
    // `stance` is load-bearing. "declined" is recorded, not dropped: it suppresses that product
    // for that account for a year, because the one failure that cannot ship is telling a rep to
    // pitch what the customer just turned down. `product` is free text, the family name from the
    // vendor's own catalogue, and a reader that cannot match it to the catalogue drops the signal.
    key: 'expansion_signal',
    label: 'Expansion Signal',
    domain: 'customer',
    about: 'company',
    description: 'An EXISTING customer asking for, considering, or turning down MORE of what we sell: a product they do not have, more seats or locations, an upgrade. Set "product" to the product family named, and "stance" to one of: "asked" (they requested it or asked what it costs), "considering" (they raised it without committing), "declined" (they said no to it, or cancelled a trial of it — record this, it matters as much as a yes). NOT a prospect moving to close (buying_signal), NOT general interest (goal), NOT a feature request about a product they already own (pain).',
    example: 'Larkfield Software asked whether there is a cost to add Lumen Service Desk to their package.',
  },
  {
    // Promoted 2026-09-21 (GET-401), on the same evidence as expansion_signal: the health reads
    // filed a stated cancellation as `pain` with `metadata.signal_type = health_risk`, and the Intel
    // tab showed a stated cancellation as a Pain beside a website-copy complaint. A CS owner
    // does not need those on the same shelf; one is a ticket and the other is the account.
    //
    // An invented example of the shape: "we never got last month's invoice" one week, "we're
    // moving to another vendor at renewal" the next. Without a category nothing names them.
    // This category is what names the second one, and the
    // `severity` sub-tag is what lets the first one be a warning rather than a pain.
    //
    // Why it is not pain: pain describes the product; this describes the RELATIONSHIP. Why it is
    // not objection: an objection is a prospect's reason not to start; this is a customer's reason
    // to stop. Why it is not staff_change: a departure is already a risk by rule (departureAsRisk);
    // this is what they SAID, not who left.
    key: 'risk_signal',
    label: 'Risk Signal',
    domain: 'customer',
    about: 'company',
    description: 'An EXISTING customer signalling the relationship is in question. Set "severity" to one of: "stated_churn" (they cancelled, gave notice, or said they are leaving), "at_risk" (they are reviewing vendors, questioning the value, or escalating unresolved problems), "friction" (a billing, invoicing, support or service failure they raised with frustration but no threat to leave). NOT a product complaint on its own (pain), NOT a prospect\'s reason not to buy (objection), NOT usage going quiet (adoption).',
    example: 'Pemberton Freight said they are moving to another vendor when the contract renews.',
  },
  // GET-776. The tools they run, on the COMPANY, one topic per tool. A fact ABOUT one of their
  // tools — who drives it, what it costs, what they think of it, a decision about it ("blocked the
  // production database from the AI bot") — is tech_stack, not a risk to us and not a competitor
  // unless the tool does the job we do.
  {
    key: 'tech_stack',
    label: 'Tech Stack',
    domain: 'account',
    about: 'company',
    description: 'A tool, platform or vendor they use — CRM, dialer, note-taker, analytics, AI agents, chat — and any fact about it: who drives it, what it costs, how it is used, what they think of it, a decision about it. Name the tool. A tool that does the job WE do is competitor instead.',
    example: 'Their CEO runs AI-agent experiments across the company on GrokBot, about $150 a month, pushing insights into Slack.',
  },
  // GET-776. What stands between now and a signed (or expanded) deal. Open until a later statement
  // resolves it — that is exactly the replace-on-contradiction path (GET-770).
  {
    key: 'blocker',
    label: 'Blocker',
    domain: 'deal',
    about: 'either',
    description: 'Something standing between now and a signed or expanded deal: other people who must sign off, no plan for how to roll it out or who to onboard, internal politics, missing access or integration, a review still pending. Set status open or resolved. NOT a setup step already done (access granted, a file shared) and not a scheduling detail.',
    example: 'He still has to work out who to onboard and present it to the other stakeholders before anything is signed.',
  },
  // GET-776. A hard condition for buying. It used to land in pain (or, worse, in a list of product
  // feedback): "must create HubSpot tasks or the relationship doesn't make sense" was the most
  // important fact on one account and read as one pain among twenty-four.
  {
    key: 'requirement',
    label: 'Requirement',
    domain: 'deal',
    about: 'either',
    description: 'A hard condition for buying: what the product must do, or the deal does not happen. Not a wish or a feature idea (that is product feedback for us).',
    example: 'It has to create the follow-up tasks in their CRM, or the relationship does not make sense.',
  },
  {
    key: 'general',
    label: 'General',
    domain: 'general',
    about: 'either',
    // The audit of 2026-09-21 (GET-417) found real facts parked here that had a home: "would buy
    // if it connected to their scheduling tool" (buying_signal), "said we can contact their IT
    // contractor directly" (authority), "prefers a text before any call" (preference). The
    // description now says where those go, so `general` is the last resort it was meant to be.
    description: 'Durable, decision-relevant context that fits NONE of the above — use it last. Before choosing it, check: interest in or a request for something we sell is buying_signal (prospect) or expansion_signal (customer); permission, approval or a go-ahead is authority; how they like to work or be contacted is preference; career background or skill with tools is proficiency; who they know or would introduce is relationship; a fact about the business itself is firmographic.',
    example: 'Plans to hire 2 SDRs once the team passes $50k MRR.',
  },
];

export const CLAIM_CATEGORY_KEYS: string[] = CLAIM_CATEGORIES.map(c => c.key);

const DOMAIN_OF: Record<string, ClaimDomain> = Object.fromEntries(CLAIM_CATEGORIES.map(c => [c.key, c.domain]));

/** The domain of a category key; `general` for anything the taxonomy does not know. */
export function claimDomainOf(category?: string | null): ClaimDomain {
  return DOMAIN_OF[normalizeClaimCategory(category)] ?? 'general';
}

/** The category keys in a domain — what a reader for that domain is allowed to act on. */
export function categoriesInDomain(domain: ClaimDomain): readonly string[] {
  return CLAIM_CATEGORIES.filter(c => c.domain === domain).map(c => c.key);
}

const KEY_SET = new Set(CLAIM_CATEGORY_KEYS);

/**
 * The categories that are about the DEAL, whoever voiced them — so a person's claim in one
 * of these also belongs on their account record. The extractor's `about` tag cannot decide
 * this: it filed Rowan Achterberg's objection on one customer's call as a fact about Rowan, and
 * the account read "None raised". Everything outside this list (preference, relationship,
 * discovery, goal, general) describes the individual and stays on the person (GET-223).
 */
export const ACCOUNT_ROLLUP_CATEGORIES: readonly string[] = [
  'objection', 'competitor', 'budget', 'timeline', 'authority', 'buying_signal',
  // The two CS categories (GET-401). An expansion ask and a cancellation are account facts whoever
  // voiced them: the CS lists read them off the COMPANY entity in one batched read, and a signal
  // filed on the person who sent the email would be invisible to every list that matters.
  'expansion_signal', 'risk_signal',
  // Both describe the BUSINESS, never the individual who happened to say it — a location count and
  // a record month are account facts by definition. They are declared `about: 'company'` so the
  // extractor should route them anyway; this is the backstop for when it tags one `person`,
  // because the failure it prevents is the one GET-223 describes: the fact exists, on the wrong
  // record, and the account reads empty (GET-372, GET-373).
  'firmographic', 'performance',
  // GET-776: a blocker and a requirement are about the deal whoever voiced them; the stack is the
  // company's (declared about:'company', this is the backstop).
  'blocker', 'requirement', 'tech_stack',
];

// Legacy and natural-language aliases mapped onto the canonical keys, so old
// rows (Title-Case labels) and loose LLM output still normalize cleanly.
const ALIASES: Record<string, string> = {
  'pain points': 'pain',
  'painpoints': 'pain',
  'painpoint': 'pain',
  'objections': 'objection',
  'concern': 'objection',
  'pushback': 'objection',
  'discovered': 'discovery',
  'origin': 'discovery',
  'inbound': 'discovery',
  'found us': 'discovery',
  'source': 'discovery',
  'intro': 'relationship',
  'introduction': 'relationship',
  'offer': 'relationship',
  'preferences': 'preference',
  'relationships': 'relationship',
  'connection': 'relationship',
  'connections': 'relationship',
  'network': 'relationship',
  'networking': 'relationship',
  'knows': 'relationship',
  'mutual': 'relationship',
  'budgets': 'budget',
  'timelines': 'timeline',
  'timing': 'timeline',
  'timeframe': 'timeline',
  'time frame': 'timeline',
  'buying signal': 'buying_signal',
  'buying signals': 'buying_signal',
  'buying_signals': 'buying_signal',
  'commitment': 'buying_signal',
  'verbal commit': 'buying_signal',
  'verbal_commit': 'buying_signal',
  'agreement': 'buying_signal',
  'closing': 'buying_signal',
  'ready to buy': 'buying_signal',
  'next steps': 'buying_signal',
  'competitors': 'competitor',
  'competition': 'competitor',
  'goals': 'goal',
  'initiative': 'goal',
  'initiatives': 'goal',
  'status quo': 'status_quo',
  'current state': 'status_quo',
  'current stack': 'status_quo',
  'stack': 'status_quo',
  'tools': 'status_quo',
  'role': 'authority',
  'buying role': 'authority',
  // Seen in prod 2026-09-18 and not yet covered. Most title-cased and pluralised spellings were
  // already handled here — the leak was never the table, it was that nothing called it (GET-346).
  'pains': 'pain',
  'authorities': 'authority',
  'staff changes': 'staff_change',
  'adoptions': 'adoption',
  // GET-401. The spellings a model reaches for before it has read the taxonomy.
  'expansion': 'expansion_signal',
  'expansion signal': 'expansion_signal',
  'expansion signals': 'expansion_signal',
  'expansion_signals': 'expansion_signal',
  'upsell': 'expansion_signal',
  'upsell signal': 'expansion_signal',
  'cross-sell': 'expansion_signal',
  'cross_sell': 'expansion_signal',
  'health_expansion': 'expansion_signal',
  'risk': 'risk_signal',
  'risk signal': 'risk_signal',
  'risk signals': 'risk_signal',
  'risk_signals': 'risk_signal',
  'churn': 'risk_signal',
  'churn risk': 'risk_signal',
  'churn_risk': 'risk_signal',
  'health_risk': 'risk_signal',
};

/**
 * Coerce any input to a canonical category key. Unknown values fall back to 'general'.
 *
 * CALL THIS ON THE WAY IN. This file opens by saying why: "A controlled taxonomy is what turns
 * claims from pretty notes into queryable patterns across accounts. Free-form LLM categories cannot
 * roll up; these can."
 *
 * On 2026-09-18, about a fifth of all claims carried a category nobody defined, across dozens of
 * invented values — while this function AND `isValidClaimCategory` both already existed. `saveNote` called
 * neither, and defaulted to "General" capitalised, which is why `General` rows sat beside
 * `general`, invisible to every rollup filtering by key. The extractor was never the leak; its
 * prompt is generated from CLAIM_CATEGORIES. Every other write path was.
 */
export function normalizeClaimCategory(input?: string | null): string {
  if (!input) return 'general';
  const raw = String(input).trim().toLowerCase();
  if (KEY_SET.has(raw)) return raw;
  const underscored = raw.replace(/\s+/g, '_');
  if (KEY_SET.has(underscored)) return underscored;
  if (ALIASES[raw]) return ALIASES[raw];
  return 'general';
}

/** Coerce any input to a canonical `about` value. Defaults to 'person'. */
export function normalizeClaimAbout(input?: string | null): 'person' | 'company' {
  return String(input ?? '').trim().toLowerCase() === 'company' ? 'company' : 'person';
}

export function isValidClaimCategory(input?: string | null): boolean {
  return !!input && KEY_SET.has(String(input).trim().toLowerCase());
}

export function claimCategoryLabel(key: string): string {
  return CLAIM_CATEGORIES.find(c => c.key === key)?.label ?? 'General';
}

/**
 * The category block injected into the extractor prompt, generated from the
 * taxonomy so the prompt and the validator never drift. One line per category:
 * `- key — description e.g. "example"`.
 */
export function claimCategoryPromptBlock(): string {
  return CLAIM_CATEGORIES.map(c => `- ${c.key} — ${c.description} e.g. "${c.example}"`).join('\n');
}

// ── The sub-tags a category carries ─────────────────────────────────────────
//
// Some categories carry a small closed vocabulary alongside the prose, because a RULE has to act
// on them and prose cannot be acted on: "Osric left last month", "we lost Osric" and "Osric is no
// longer with us" are one fact and three strings. `change` is what lets a departure end the
// authority claim it contradicts; `role` is what puts a person on the org chart; `stance` and
// `hardness` are what `computeDealHealth` weighs.
//
// DECLARED ONCE because there are two writers. The worker's `persistFacts` and the API's
// `recordObservations` each decided this independently, and they drifted: `role` and `change`
// shipped into the worker in September and were never added to the API, so every claim written
// through the plugin lost them — silently, with the category itself landing correctly (GET-364).
//
// A category gaining a sub-tag must now work in both paths or neither.

export const CLAIM_SUBTAGS: Record<string, Record<string, readonly string[]>> = {
  competitor:   { stance:   ['evaluating', 'incumbent', 'past_failure', 'mentioned'] },
  objection:    { status:   ['open', 'resolved', 'addressed'],
                  hardness: ['hard', 'soft'] },
  staff_change: { change:   ['left', 'joined', 'moved', 'reorg', 'away'] },
  authority:    { role:     ['economic_buyer', 'decision_maker', 'champion', 'blocker', 'technical'] },
  // GET-401. `stance` here is what the CS reader branches on, and "declined" is the branch that
  // suppresses. `severity` is what ranks the at-risk list: a stated cancellation outranks a
  // review, which outranks an invoice complaint.
  expansion_signal: { stance:   ['asked', 'considering', 'declined'] },
  risk_signal:      { severity: ['stated_churn', 'at_risk', 'friction'] },
  // GET-776: a blocker is open until something resolves it.
  blocker:          { status: ['open', 'resolved'] },
};

/**
 * The categories that carry a FREE-TEXT name alongside the closed sub-tags: which competitor,
 * which product. Declared here for the same reason the closed sets are — two writers — and read
 * by both so the field name never drifts between them (GET-401). `competitor.entity` was handled
 * inline in each writer before; it is here now so `expansion_signal.product` is not the third
 * copy of the same three lines.
 */
export const CLAIM_FREE_TEXT: Record<string, readonly string[]> = {
  competitor:       ['entity'],
  expansion_signal: ['product'],
  // GET-776: which tool a tech_stack fact is about — the slot the account groups by.
  tech_stack:       ['tool'],
};

/**
 * Categories that describe the COMPANY by definition. The extractor's about-tag is a judgment; a
 * location count or a tool list filed on the person who said it leaves the account reading empty
 * (GET-223, GET-776), so these are filed on the company whatever was tagged.
 */
const COMPANY_CATEGORIES = new Set(['tech_stack', 'firmographic', 'performance', 'seasonality']);
export function claimAboutFor(category: string | null | undefined, about: string | null | undefined): 'person' | 'company' {
  return COMPANY_CATEGORIES.has(normalizeClaimCategory(category)) ? 'company' : normalizeClaimAbout(about);
}

/**
 * One name per tool (GET-795). A re-sort of a real account filed "Grok" and "GrokBot" as two tools
 * and "JustCall AI" beside "JustCall", so the account's tech stack listed the same thing twice.
 * Known aliases map to the vendor's own spelling; an unknown tool keeps its name, trimmed. Pure.
 */
const TOOL_ALIASES: [RegExp, string][] = [
  [/^grok(\s*bots?|\s*agents?)?$/i, 'GrokBot'],
  [/^justcall(\s*ai)?$/i, 'JustCall'],
  [/^hub\s*spot(\s*crm)?$/i, 'HubSpot'],
  [/^ring\s*central$/i, 'RingCentral'],
  [/^open\s*phone$/i, 'OpenPhone'],
  [/^post\s*hog$/i, 'PostHog'],
  [/^zoom\s*info$/i, 'ZoomInfo'],
  [/^sales\s*force(\s*crm)?$/i, 'Salesforce'],
  [/^slack$/i, 'Slack'],
];
export function normalizeToolName(input?: string | null): string | null {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  for (const [re, canonical] of TOOL_ALIASES) if (re.test(name)) return canonical;
  return name;
}

/**
 * The free-text names to stamp on a claim of this category, trimmed and capped. A missing or
 * blank value is stored as null rather than omitted, so a reader can tell "no product named"
 * from "written before the field existed".
 */
export function claimFreeTextFor(
  category: string,
  offered: Record<string, unknown> = {},
): Record<string, string | null> {
  const fields = CLAIM_FREE_TEXT[category];
  if (!fields) return {};
  const out: Record<string, string | null> = {};
  for (const f of fields) {
    const v = offered[f];
    const text = typeof v === 'string' ? (v.trim().slice(0, 60) || null) : null;
    out[f] = category === 'tech_stack' && f === 'tool' ? normalizeToolName(text) : text;
  }
  return out;
}

/**
 * The sub-tags to stamp on a claim of this category, taken from whatever the extractor offered.
 *
 * A value outside the vocabulary becomes null rather than being coerced onto a neighbour: a model
 * returning "influencer" for a role is saying something true that nothing can display, and putting
 * a badge on a person nobody described that way is worse than putting none.
 *
 * `competitor.entity` is free text (a vendor name), so it is handled by the caller — this covers
 * only the closed sets.
 */
export function claimSubtagsFor(
  category: string,
  offered: Record<string, unknown> = {},
): Record<string, string | null> {
  const spec = CLAIM_SUBTAGS[category];
  if (!spec) return {};
  const out: Record<string, string | null> = {};
  for (const [field, allowed] of Object.entries(spec)) {
    const v = offered[field];
    out[field] = typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v : null;
  }
  return out;
}


/**
 * Whether a note.* claim is INTEL — a fact about the account a reader should see as a chip, a
 * FACTS line, or a dedup candidate — as opposed to bookkeeping that happens to live on the
 * same shelf (GET-417).
 *
 * The audit of 2026-09-21 found three kinds of non-intel among the claims:
 *   - "Linked this meeting (fellow) by transcript speaker name…" system notes in `general`
 *     (metadata.flag = speaker_name_link) — provenance bookkeeping wearing a claim's clothes;
 *   - health-read paragraphs filed as `adoption` / `status_quo` with no label and no quote
 *     (metadata.signal_type = health_adoption) — page prose, each restating 4–6 facts that the
 *     extractor had already filed atomically;
 *   - whole meeting-notes documents (metadata.doc_type) — already hidden by the Intel tab, not
 *     by every reader.
 * Each is right to exist and wrong to show as a fact. The writers keep writing them; the readers
 * ask this one question. A metadata.summary flag is the explicit form for anything new.
 */
export function isIntelClaim(value: Record<string, any> | null | undefined): boolean {
  const meta = value?.metadata ?? {};
  if (meta.doc_type) return false;
  if (meta.summary === true) return false;
  if (meta.flag === 'speaker_name_link') return false;
  if (meta.signal_type === 'health_adoption') return false;
  // A transcript or a meeting-notes dump saved without its doc_type (GET-776): one account's intel
  // listed "———— Transcript ————" and "# Product Demo and Workspace Updates" as facts.
  const content = String(value?.content ?? '');
  if (/^[\s—-]*[—-]{3,}\s*Transcript/i.test(content)) return false;
  // A fact is one sentence; a heading followed by more lines is a document.
  if (/^#{1,3}\s[^\n]+\n/.test(content)) return false;
  return true;
}

// ── The chip on a claim (GET-959) ────────────────────────────────────────────────────────────
//
// The chip a reader skims, and the title of the signal a claim fires. It was the extractor's free
// text, which mixed the thing with an opinion about it ("Quillbox vs Our Data", "Quillbox experimental
// chaos", "Pays to Fix CRM") and spelled one tool three ways. Where the category says what the chip
// is, code builds it; elsewhere the model's label stands. A claim with no label gets the start of
// its own sentence, never the three-word scrap the UI used to cut ("still work out"). Pure.

const ROLE_WORDS: Record<string, string> = {
  economic_buyer: 'Budget holder', decision_maker: 'Decision maker', champion: 'Champion',
  blocker: 'Blocker', technical: 'Technical buyer',
};
// A title only when it is who the sentence is about ("The CEO …", "Quillmere's CRO …"), not one the
// person reports to.
const TITLE_RE = /^(?:(?:The|Their|Our)\s+)?(?:[\w&.-]+['’]s\s+)?(CEO|CTO|CFO|COO|CRO|CMO|CPO|CIO|CISO|VP of [A-Za-z]+|Head of [A-Za-z]+|[Ff]ounder|[Cc]o-founder)\b/;
const UNNAMED_RE = /\bname (?:is )?(?:not (?:yet )?known|unknown)\b|\bnot (?:yet )?named\b|\bunnamed\b/i;
const MONEY_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|thousand)(?![a-z]))?|\b\d[\d,]*(?:\.\d+)?\s?(?:k|m)?\s?(?:USD|CAD|EUR|GBP|dollars|euros)\b)(?:\s?(?:\/|per|a|an)\s?(?:year|yr|month|mo|seat|user)\b)?/i;
// A leading "First Last" is a person only when what follows is something a person does: "Google
// Sheets breaks" and "New York office" keep their subject.
const ATTRIBUTION_VERBS = 'says|said|wants|wanted|thinks|believes|explained|explains|noted|notes|mentioned|plans|planned|raised|asked|questioned|set|sees|still|does|did|has|had|is|was|will|would|can|cannot|approached|found|pushed|backtracked|signs|decides|owns|leads|runs|champions|controls|approves|reviews';
const LEADING_NAME_RE = new RegExp(`^([A-Z][a-z]+ [A-Z][a-z-]+)(?= (?:${ATTRIBUTION_VERBS})\\b)`);
const BUDGET_STATE_RE = /\b(frozen|freeze|approved|approval|cut|slashed|increased|reduced|pending|allocated|locked|signed off|no budget|over budget|under budget|ran out|exhausted)\b/i;
const MAX_CHIP = 60;
const POSSESSIVE_COMPANY_RE = /^[A-Z][\w-]*(?: [A-Z][\w-]*)?['’]s company [A-Z][\w&.-]*(?: [A-Z][\w&.-]*)?['’]s\s+/;
const SAYING_RE = /^(?:says|said|explains|explained|notes|noted|mentions|mentioned|states|stated)(?: that)?\s+/i;
const FILLER_RE = /^(?:still|also|now|then)\s+/i;
const TRAILING_STOP = new Set(['a', 'an', 'the', 'to', 'of', 'as', 'for', 'and', 'or', 'with', 'in', 'on', 'by', 'at', 'that', 'how', 'who']);
const START_WORDS = 7;

/** The start of a claim's own sentence, without the "X says" in front of it: a chip that reads. */
function sentenceStart(content: string, speaker: string | null, category: string): string {
  let s = String(content ?? '').replace(/[*_`>#]+/g, ' ').replace(/^\s*[-•]\s+/gm, '').trim().replace(/\s+/g, ' ');
  s = s.replace(POSSESSIVE_COMPANY_RE, '');
  const names = [speaker, speaker?.split(' ')[0]].filter((n): n is string => !!n && n.length > 1);
  for (const n of names) if (s.startsWith(`${n} `)) { s = s.slice(n.length + 1); break; }
  s = s.replace(LEADING_NAME_RE, '').trim();
  s = s.replace(SAYING_RE, '').replace(FILLER_RE, '');
  if (!s) return CLAIM_CATEGORIES.find(c => c.key === category)?.label ?? 'Note';
  const words = s.split(' ');
  let head = words.slice(0, START_WORDS);
  if (words.length > START_WORDS) {
    while (head.length > 1 && TRAILING_STOP.has(head[head.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) head = head.slice(0, -1);
  }
  const text = head.join(' ').replace(/\s*[,;:—–-]+$/, '');
  const cut = text.length > MAX_CHIP ? `${text.slice(0, MAX_CHIP).replace(/\s+\S*$/, '')}…` : text;
  return cut.charAt(0).toUpperCase() + cut.slice(1) + (words.length > START_WORDS && cut === text ? '…' : '');
}

/**
 * "Re-engage Churned Customers" → "Re-engage churned customers" (GET-962). The extractor was asked for
 * Title Case, and labels read like headlines. A word after the first keeps its capital only when the
 * fact itself writes it with one (a name: "Kelsey") or it is a short word the fact never uses
 * ("Ops"); internal capitals (HubSpot) and acronyms (CRM) are never touched. Pure.
 */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'at', 'by', 'vs', 'with', 'from', 'into', 'per']);
function sentenceCase(label: string, content: string): string {
  const words = label.split(' ');
  return words.map((w, i) => {
    if (i > 0 && SMALL_WORDS.has(w.toLowerCase())) return w.toLowerCase();
    if (i === 0 || !/^[A-Z][a-z]+(?:-[a-z]+)*[,:]?$/.test(w)) return w;
    const bare = w.replace(/[,:]$/, '');
    // Capitalised mid-sentence is a name; at the start of a sentence it says nothing.
    const said = (form: string) => new RegExp(`(?<![.!?]\\s|^)(?<![\\p{L}])${form}(?![\\p{L}])`, 'u').test(content);
    if (said(bare.toLowerCase())) return w.toLowerCase();
    if (said(bare) || bare.length <= 3) return w;
    return w.toLowerCase();
  }).join(' ');
}

export function claimLabel(claim: {
  category?: string | null;
  label?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}): string {
  const category = normalizeClaimCategory(claim.category ?? '');
  const meta = claim.metadata ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const content = text(claim.content) ?? '';
  const raw = text(claim.label)?.slice(0, 40) ?? null;
  const modelLabel = raw ? sentenceCase(raw, content) : null;

  if (category === 'competitor') {
    const name = normalizeToolName(text(meta.entity));
    if (name) return name;
  }
  if (category === 'tech_stack') {
    const name = normalizeToolName(text(meta.tool));
    if (name) return name;
  }
  if (category === 'budget') {
    const m = `${text(meta.quote) ?? ''}\n${content}`.match(MONEY_RE);
    if (m) return m[0].trim();
    // "Budget frozen until Q3" says something a number would not; "pays to fix the CRM" does not.
    if (BUDGET_STATE_RE.test(`${modelLabel ?? ''} ${content}`)) return modelLabel ?? sentenceStart(content, text(meta.speaker), category);
    return 'No number yet';
  }
  if (category === 'authority') {
    const role = ROLE_WORDS[String(meta.role ?? '')] ?? null;
    const title = content.match(TITLE_RE)?.[1] ?? null;
    if (title) {
      const who = UNNAMED_RE.test(content) ? 'not named yet' : role;
      return who ? `${title} · ${who}` : title;
    }
    // The model's label before a name read off the front of the sentence: "Sorrel cannot switch off
    // the bots because the CEO runs them" is about the CEO, not Sorrel.
    if (modelLabel) return modelLabel;
    const name = content.match(LEADING_NAME_RE)?.[1] ?? null;
    if (name && role) return `${name} · ${role}`;
    return role ? `${role} · ${sentenceStart(content, text(meta.speaker), category)}` : sentenceStart(content, text(meta.speaker), category);
  }
  return modelLabel ?? sentenceStart(content, text(meta.speaker), category);
}
