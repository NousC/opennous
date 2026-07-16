# Context Engineering

The context graph decides *what is true*. This document is about the layer above it: deciding **what an agent should read before it acts**, and in what shape.

That is not the same problem. A graph that holds everything is correct; a payload that hands an agent everything is a mistake. Retrieval is not the hard part any more — judgement about relevance is. This doc covers the three mechanisms Nous uses to get the right context to the right question, where they live, and what is still missing.

It points at the code. The ranking and compression live in [`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts) so every surface shares them; semantic search lives in [`packages/core/src/db/search.ts`](../packages/core/src/db/search.ts); the intent recipes live in [`packages/core/src/context.ts`](../packages/core/src/context.ts).

---

## 1. The problem: a full record is the wrong payload

`getAccountRecord` returns everything on an entity — every claim, the recent observation timeline, the notes. For a database that is the correct answer. For anything that has to *reason* over it, it is a liability.

A real account in a working workspace carries **59 records**, and most of them are plumbing: the row was imported, a sync ran, a stage field changed, an email was opened. One of them is the meeting where the deal actually turned. Hand the model all 59 undifferentiated and two things go wrong at once:

- **Tokens.** You pay to transport noise, on every single call.
- **Judgement.** The model starts counting records instead of reading them. This is not hypothetical — it is where an agent gets the idea to say *"19 matched activity signals"* instead of *"he replied twice last week and booked a call."* The first sentence is a database talking. The second is a colleague.

The fix is not a smaller limit. Truncating to the 18 most *recent* rows keeps the imports and drops the call. The fix is to rank by **what a record proves**.

---

## 2. Evidence ranking

`packages/core/src/evidence.ts` answers one question: *of everything we hold, what actually proves something?*

Every record is scored on three axes:

**What happened.** A held meeting or call transcript is the strongest thing there is — they actually talked. A reply or an inbound message is next: they responded, or they came to us. Our own outbound sits well below that, because us sending an email proves nothing about them. Imports, syncs and stage changes score near zero.

**Where it came from.** Some systems carry more human signal than others regardless of the property. Fireflies and Gmail are weighted up; Apollo and Calendar down (a calendar is mostly recurring placeholders); Import, CSV and System are penalised hard, because they prove nothing to a human.

**What it says.** This one matters more than it sounds. `"You: 👍"` is a genuine LinkedIn message and evidence of absolutely nothing. Two rules follow: messages *we* sent are demoted (connectors prefix them with `"You:"`), and anything under fifteen characters is penalised. **A thumbs-up cannot be the reason you believe something.**

Recency nudges the result but never overrides it. A fresh import must not outrank an old real conversation.

### Compression

`compressAccount()` uses that ranking to reshape the record:

- Claims and facts are kept whole. They are the profile — small and load-bearing.
- Interactions are ranked and the top slice is kept.
- **Everything else is replaced by a summary of its shape**, not dropped silently: `total_observations`, a count by type, first and last seen, and a note saying how many were left out and why they were routine.

Nothing is hidden from the model; the volume is described instead of transported. On the account above this took **59 records to 8 sources** for the user and 18 for the model.

### Why it lives in core

This is the load-bearing architectural decision. The ranking was originally written inside the API's agent lib, which meant the web agent got ranked evidence while **the MCP tools — the ones your Claude Code agents call — still got the raw dump.** Two surfaces, two different ideas of what mattered, and a product that contradicts itself depending on where you asked.

It is in `packages/core` now. Per the layer rule in `CLAUDE.md`, core is the single source of truth and every app imports from it. Evidence ranking is not presentation; it is a fact about the graph.

---

## 3. Semantic search

`query` filters by property and date. It can tell you who was emailed in the last 30 days. It cannot tell you **what anyone said**, which means it cannot answer the questions people actually ask:

> *who mentioned pricing?* · *what did anyone say about Clay?* · *who is unhappy with their current tool?*

`search` (backed by `searchObservations` / `searchClaims`) answers those. Every observation carries a 1536-dim embedding with an ivfflat index (`observations.embedding`, see `supabase/schema.sql`), so it searches **by meaning, not keywords**. Verified against a live workspace:

> query: *"frustrated with their current tooling"*
> → **Sasha K. identifies GTM tooling cost as a significant pain point, specifically Clay's recent pricing changes**

There is no lexical overlap between the query and that sentence. That is the whole point, and it is the capability that keeps scaling: as the graph grows, retrieval by structure stops being enough, and retrieval by meaning takes over.

**One non-obvious rule.** The embedding index covers *every* observation, including enrichment field values — `"Clay"`, `"usage_based"`, `"enterprise_contact"`. Those match a topic beautifully and prove nothing. A search result must be something a person actually **said**, so results are filtered to statements with enough words to be a statement. Relevance ranks the hits; evidence quality breaks the ties, so the same words inside a held call outrank them inside an import row.

---

## 4. Intent-driven budgets

A question has a shape, and the right context has the same shape. Prepping for a meeting needs the conversation in detail. Drafting one cold email needs a single hook — more would only dilute it. Handing back the same fixed blob regardless burns tokens and blunts precision at the same time.

`context.ts` already routes *token* budgets by intent through its recipes (`draft_email`, `follow_up`, `meeting_prep`, `call_prep`, `account_review`). `budgetForIntent()` extends the same vocabulary to **evidence depth**:

| Intent | Evidence | Why |
|---|---|---|
| `account_review` | 24 | the whole arc matters |
| `meeting_prep` / `call_prep` | 20 | you need the conversation, in detail |
| `follow_up` | 14 | the last exchange, and what was promised |
| `draft_email` | 8 | one hook is enough |

`get_account` now takes an `intent`, so depth follows the job. The intents are deliberately the *same* set as the context recipes — a second, competing vocabulary of intents is exactly how two surfaces start disagreeing about what a question is.

---

## 5. What is still missing

Written down honestly, because the gaps matter more than the wins:

- **MCP does not use the ranking yet.** `evidence.ts` is in core and the API agent consumes it. The MCP tools still need to be routed through `compressAccount()` — until they are, your Claude Code agents get a better name-search but the same unranked payload.
- **Embeddings are OpenAI-backed** (`packages/core/src/embed.ts`, needs `OPENAI_API_KEY`). `embed()` returns `null` without it and every caller degrades to structured retrieval — silently. Search quietly returning nothing is a bad failure mode.
- **Claims are not embedded, only note-claims are.** Structured claims (`title`, `stage`, `intent`) can't be reached semantically.
- **No reranking.** Vector similarity plus evidence score is a decent proxy, but a cross-encoder rerank over the top ~50 would be better, and cheap.
- **The evidence budget is static per intent.** It should also flex with how much the account actually has: a 400-interaction account and a 3-interaction account should not both get 18.

---

## 6. The principle

The graph's job is to be *complete*. The context layer's job is to be *selective*. Those are opposite instincts, and conflating them is the mistake almost every "AI-native CRM" makes — they hand the model the whole row and call it context.

Context engineering is deciding what an agent reads. Given a graph this dense, that decision **is** the product.
