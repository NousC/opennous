# Nous docs

Grouped by area. Each group has a **start-here** doc; the rest are deep-dives.

## ICP & GTM Context
- **[ICP Scoring & GTM Context](./icp-scoring.md)** — the single ICP doc: the
  substrate, the scorer, the three feature layers, the per-person score and its
  history trail, win/loss resolution, the Mind learning loop, build-from-closed-
  deals, GTM Context + ICP file symbiosis, and Playbooks.

## Platform mechanics
- **[Context Graph](./context-graph.md)** — start here: what the context graph
  is and why GTM agents need it, the substrate (observations, entities, claims),
  the operational and decision layers, how signals flow in and get served to
  agents in one call, and why it is graph-first rather than RAG.
- [Context Engineering](./context-engineering.md) — the layer above the graph:
  deciding what an agent reads before it acts. Evidence ranking (what a record
  *proves*, not when it landed), compression, semantic search over what people
  actually said, and intent-driven budgets. Why a full record is the wrong
  payload, and why the ranking has to live in core.
- [Identity Resolution](./identity-resolution.md) — how Nous folds every
  signal into one record per person: one person many identifiers, how a match is
  made, meetings via the calendar, enrich-don't-erase, and the bias against false
  merges.
- [Claims (Intel)](./claims.md) — the durable claims Nous extracts from
  conversations: the controlled GTM taxonomy, the extraction pipeline, what is
  stored per claim, and how claims roll up into patterns across accounts.
