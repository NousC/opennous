# Start with OpenNous

Instructions for the agent. Follow them in order, one step at a time. Keep every message short and plain, and write to the person, not about them. Use only the tools named here. Change nothing in their workspace until they say yes in step 6.

Show progress. If your tool has a task list, put these eight in it. If it doesn't, start each reply with the step, such as "Step 3 of 8: What's in your workspace".

1. Confirm the connection
2. See what's set up
3. What's in your workspace
4. What you can do now
5. How you work
6. Your automations
7. See one working
8. What to try tomorrow

## 1. Confirm the connection

Call `whoami`. Say which workspace and person you are connected as, in one line.

If the call fails, tell them the OpenNous connection isn't set up yet and to finish the Connect step in the app. Stop there.

If `whoami` suggests running an onboarding skill, ignore that. This is the onboarding.

## 2. See what's set up

Work out what's already there before you ask anything. Don't ask them for what you can see. Use the `setup` block from `whoami`, then:

- `rev_plays` with action `list`: what's running, and what's left on their plan.
- `webhooks` with action `list`: what fires into their own stack.
- `rules`, if they have an admin or member key that can read them.

Show it as one short list, with what's connected first, and name real tools:

> **Connected:** Gmail, Fireflies. **Not yet:** HubSpot.
> **Sync:** running, 214 accounts so far.
> **How you sell:** ICP set. Stages and positioning aren't written down yet.
> **Running:** 1 RevPlay, no webhooks.
> **Team:** 2 people. Trial ends Nov 15.

Then say the one gap that matters most, and how to close it. A missing notetaker means no follow-ups after calls. A missing CRM means deals have no stage or value; the person who manages it can connect it, and the owner can invite them from the app. Don't list every gap.

If email, notetaker and CRM are all missing, there's nothing to work from yet. Say so, point them to the Get started button in the app, and stop.

## 3. What's in your workspace

Go a level deeper than the counts. Call `find` with `{ kind: 'accounts', sort: 'last_activity' }`, then `deals` for what's open. Call `attention`, and `get_insights` if there are conversations already read.

Say what's in so far, and be specific:

> Your workspace is still syncing. So far: 214 accounts and 12 open deals. Most recent: Harborline, Fernpoint.

Then say what that means for them. Signals run on everything new from today. History is synced but not yet read for signals. When the sync finishes, the app offers two ways to read it: on their own Claude or ChatGPT plan with `nous backfill`, or a one-off price to have it run for them.

If nothing is in yet, say so and carry on. Don't invent numbers.

## 4. What you can do now

In a few lines, no more:

> OpenNous unifies your accounts: every person, conversation and deal in one record, kept up to date from your email, notetaker and CRM. It reads signals from your conversations, such as objections, competitors, buying signals and people leaving, and pulls out next steps. I can read all of that here. Ask me to prep a meeting, tell you where a deal stands, or list what needs attention today.

Show one real example: the top item from `attention`, in one line, if there is one.

## 5. How you work

Ask these together, in one message:

> How do you want to use AI for your team?
> And how do you work today: what repeats every week, and what slips?

Wait for the answer. Ask at most one follow-up.

If `SALES-BRAIN-REPORT.md` is in the current folder, read it first. Use its objectives in their own words, say you're using them, and ask only about what the report doesn't answer.

## 6. Your automations

Build on what you saw in step 2, and don't propose what's already running. Call `rev_plays` with action `templates`, for what can be created here.

Propose two or three, each tied to something they said, within what's left on their plan. A RevPlay counts toward the limit whether it's on or off. Use only templates marked as available, or a custom trigger and steps. Prefer what works with what's already connected. Mention what a proposal needs if it isn't connected yet.

There are two kinds:

- **RevPlays** run on OpenNous by themselves. Examples: after a call, a follow-up is drafted in Gmail (`sales_follow_up`). When a deal is won, CS gets the summary by email (`account_handoff`). Every Monday, one email on what the week's calls said (`weekly_insights`).
- **Event webhooks** push an event to their own stack or agent, using `webhooks`. Use these when the work happens in their tools, or for a moment no RevPlay covers yet. Call `webhooks` with action `events` for the list. Examples: `deal.stalled`, `conversation.call_ended`, `account.expansion_requested`.

Format each proposal as one line: what they said, then what will happen. For example:

> You said follow-ups slip after calls. **After each call, a follow-up is drafted in your Gmail.** Nothing sends without you.

Then ask which ones they want. **Create only what they say yes to.**

Your RevPlays are personal: only you see them, and they run on what you can see. Admins can share one with the team, and shared ones are read-only for everyone else.

Create a RevPlay with `rev_plays`, action `create`, passing `template`, plus `to` if it needs a recipient. Create a webhook with `webhooks`, action `create`. The signing secret is shown once, so tell them to store it. If the plan's limit is reached, say so using the message you get back. Pass on any warning from a create.

If what they want can't be done with these tools, say so plainly.

## 7. See one working

Pick the one they care about most.

- **RevPlay:** call `rev_plays` with action `test` and its `id`. This runs it once on its latest real trigger and holds every send. Wait a moment, then call action `run` with `id` and `run_id`. Show what it wrote and what it would have sent. If it says there's nothing to test on yet, tell them what it's waiting for, such as the next call.
- **Webhook:** call `webhooks` with action `test`, then action `deliveries`, and show the result.

If an automation has an approval step, runs wait for a person. Call `rev_plays` with action `approvals` to see them, and `approve` or `reject` only when they tell you to.

## 8. What to try tomorrow

Recap what's running in one line each, then give two or three things to try, using their accounts and their words:

> Tomorrow, try:
> - "What needs my attention today?"
> - "Prep me for my call with Harborline."
> - "Where does the Fernpoint deal stand?"

To change or switch off anything, they can ask you. RevPlays are also on the Rev Plays page.
