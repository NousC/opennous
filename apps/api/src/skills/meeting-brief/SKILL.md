---
name: meeting-brief
description: Write a pre-meeting brief on one person before a call. Pulls what Nous knows, reads their recent LinkedIn posts, profiles their company site, crosses it with our own ICP, and saves the brief back onto the account so the next conversation starts ahead. Use for "brief me on my call with X", "prep me for tomorrow", "who am I meeting". One person at a time, not a list.
summary: Reads the record, their posts and their site, then writes the brief and saves it back.
category: AEs
requires-providers: [apify]
allowed-tools: [calendar, get_account, get_playbook, search, scrape_linkedin_posts, read_website, save_note, record_signal]
est-cost-usd: 0.30
---

# Pre-meeting brief

Four sources — **what we already know**, **their recent posts**, **their company
site**, **our own ICP** — turned into a brief the operator can read in two
minutes and walk in sharp. Then written back onto the account, because a brief
that only exists in a chat window is a brief that gets written again from cold
next quarter.

This is a deliberate 1:1 move before a real conversation. It is not a list
builder. One person.

## Before you spend anything

The post scrape costs about $0.30. Say so and wait:

> "Ready to brief Aron at windseeker.ai. I'll read his last four weeks of posts —
> that's one Apify call, about $0.30. Go?"

If they've already said "yes, run it" in this conversation, don't ask twice.

## 1. Work out who the meeting is with

If they named a time rather than a person ("my 2pm", "tomorrow's call"), call
`calendar` — it tells you who the meeting is actually with, and hands you the
entity id. Brief the **external** attendee; skip anyone on our own domain.

If they named a person, use that. Never ask the user to pick from a list you
could have narrowed yourself.

## 2. Pull what Nous already knows

`get_account` with `intent: 'meeting_prep'`. From the record, take:

- **Identity** — role, seniority, the company (name + a line on what it does).
- **How you came into contact** — read the timeline and name the entry point:
  a LinkedIn conversation, a Gmail thread, a reply to a campaign, a Cal.com
  booking, an inbound comment. Always state it.
- **Which call this is** — first conversation, second, or an ongoing
  relationship. Infer it from prior meetings on the timeline.
- **The timeline** — emails, calls, messages, signals, newest first.
- **Their stack** — any tools named in the record. This is where the angle comes
  from.
- **Stage, and how long they've sat in it.** Open commitments from last time.
  The ICP fit score, if we've scored them.

**Look for a prior brief.** It comes back on the `get_account` call you already
made — scan the facts for a note whose category or `doc_type` is
`meeting_brief`. If one exists this is **not** a first call: summarise what was
last discussed and what the previous next step was, and write this brief as a
continuation ("last time you covered X; since then…"). That's how the brief
compounds instead of restarting.

If Nous doesn't know this person, say so plainly and carry on with public data.
Never block.

## 3. Read their recent LinkedIn posts

**Get a scrapeable URL first — this is the number one failure.** The actor needs
a public vanity URL (`linkedin.com/in/aron-mueller`). A **member-URN URL**
(`/in/ACoAA…`) is LinkedIn's internal id, which is what contacts who arrived via
a DM or invite carry, and it returns **zero posts every time**.

1. Take the URL from the record (`linkedin_url`, else the LinkedIn channel).
2. If the slug looks like `/in/acoaa…` (case-insensitive), it is a member URN.
   **Do not scrape it.** Treat it as "no URL yet".
3. No scrapeable URL? Say the posts weren't available and why, and lean on the
   timeline and the site. Never invent a slug, and never scrape a URN "just in
   case".

Then `scrape_linkedin_posts` with their vanity URL and `days: 28`.

Zero posts from someone the record shows as active usually means a bad URL, not
a quiet person — re-check step 2 before you conclude they've gone silent.

Now **audit** what comes back. Not a list — a read:

- **Themes** — the topics they keep returning to. Each one gets 3-5 sentences:
  what the theme is, what they actually said (paraphrase plus a short quote), a
  concrete example, and why it matters for this conversation.
- **What they're doing** — what are they building, launching, hiring for,
  attending, shipping?
- **Tools they name** — every product they mention. This is gold: it's where
  their world touches ours.
- **Opinions** — what they champion, what they push back on.
- **Voice** — the form they post in (teardown, build-log, hot take, story), what
  they focus on, their tone. Then one sentence naming what their voice *is*, so
  the operator can meet it. Back it with 3-5 short verbatim phrases.

Every post you cite becomes a clickable markdown link to its `url`. Quote only
what is actually in a post.

### Record the intent signal (don't just read it, score it)

You are already reading this prospect's posts, so capture the intent while you
have it. If the posts show them in-market for what we sell — posting about the
problem we solve, evaluating tools in our space, naming a competitor they're
frustrated with, hiring for the role our product supports — record it so the
intent score updates and the prospect rises in the work-list on their own.

- **`record_signal`** a person `signal.intent` (0–10 strength) when the posts show
  them thinking about our problem space. Strength scales with how direct it is:
  a post naming the exact pain we remove is a 9; a general theme in our lane is a
  5; a passing mention is a 3. The scorer turns `signal.intent ≥ 6` into a
  `posted_pain` intent event (weight 20, 21-day half-life), so it decays on its
  own and lifts the prospect only while it's fresh.
- Also record a `signal.intent` (or note the competitor) if they engaged with or
  called out a **named competitor** — that's a `competitor_engaged` trigger.
- Quote the exact line that justifies the strength in the signal's evidence, so
  the outreach can open with it later.

This is what makes the brief compound: the read feeds the score, not just the
call. Fit says this prospect belongs; the intent signal you just recorded says
whether now is the moment.

## 4. Profile their company

`read_website` on their domain (and `/about` if the homepage is thin). What the
company does in a line or two, who they sell to, their positioning, anything
recent on the site. If the site is JavaScript-heavy and comes back thin, say the
profile is thin rather than padding it.

## 5. Cross it with our own ICP

`get_playbook` — our ICP, positioning, what we sell. The angle is what they care
about (steps 3-4) crossed with what we offer. Not a generic value prop: the
specific wedge for this account.

## 6. Write the brief

A `#` title, a `>` lede that IS the read, a plain `Key: value` block, a `---`,
then `##` sections. The middle sections earn real depth; the rest stays tight.
Every line cites where it came from — `[timeline]`, `[post 2026-05-21]`,
`[site]`, `[prior brief]`.

```markdown
# Pre-meeting brief — <Person>, <Company>

> The read, up top. 3-5 sentences, like you're briefing a colleague in the
> hallway 60 seconds before the call: who this person is, where they're at, why
> they matter, how warm this is, what kind of conversation to expect, and the one
> thing to walk away with. The synthesis — not a restatement of the bullets.

Person: <name> — <role> at <Company> (one line on what they do)
Meeting: <name>, <YYYY-MM-DD>
Call: first call / second call / ongoing
How you met: LinkedIn / Gmail thread / campaign reply / Cal.com booking / inbound
Stack: <tools they work with, if known>
ICP fit: <score + label, if scored>

---

## Where things stand
The relationship in 2-4 lines: how it started, what's happened, the last thing
said, any open thread. If a prior brief exists, lead with what changed since.

## What's on their mind
The longest section — give it room. A genuine read on what they're thinking
about, from their posts and their company's moves. Every post referenced is a
clickable link. The reader should finish this understanding this person's
current world.

## Their voice
A profile, not a label. How they show up, and one line naming what their voice
is — so the operator can mirror it. 3-5 verbatim phrases, linked.

## Your angle
How our offer maps to their world. The specific wedge for this account.

## Bring this up
3-5 fully-formed questions, ready to say out loud. Each names HOW you know it,
then asks the real question. Not "ask about his hackathon" but "I saw you built a
competitive-intel agent at Profound's hackathon — how are you feeding it account
context across the AI engines?"

## Watch-outs
Sensitivities, unresolved items, anything to avoid.

## Next step
The one move this meeting should produce.
```

## 7. Save it back — always

`save_note` with the **full brief** as the content, `category: 'meeting_brief'`,
and the person's entity as the focus. This is the step that makes the brief
compound: the next run reads it in step 2, and so does every other agent that
touches this account.

Then tell the user it's on the record, and give them the read in two lines. Don't
paste the whole brief twice.
