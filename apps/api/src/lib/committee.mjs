// The buying committee for one account (GET-392).
//
// ── Why this is a view and the network is not ──────────────────────────────
//
// The context graph draws every account at once and is unreadable: a real workspace holds tens of
// thousands of structural edges (most of them "works at", which is a column, not a relationship)
// against a few thousand semantic ones. A graph of ten thousand accounts answers no question anybody asks. A
// graph of ONE account answers "who do I have to convince, and who will stop me".
//
// ── What the data actually supports ────────────────────────────────────────
//
// Measured on a customer workspace before building this, because the honest answer nearly killed it:
//
//   accounts with at least one extracted role      200
//   ...of those, with 2+ role-bearing people        20
//   ...with 3+                                       5
//   average role-bearing people per account        1.1
//
// So a graph of ONLY role-bearing people is a single node for 180 of those 200 accounts. Not a
// picture — a label. What makes it a committee is the rest of the account's people around them:
// those same 200 accounts average about 20 people, most have three or more, and one has 1,000.
//
// Hence: the account's people are the nodes, the extracted roles are badges on a few of them,
// and the person-to-person edges are the only lines. Ranked and capped, because 1,000 nodes is the
// same mistake the network view already makes.
//
// ── Two kinds of semantic edge, used differently ───────────────────────────
//
// Role edges point person -> COMPANY (decision maker AT, champions, blocks, budget holder at,
// evaluating). They are badges; drawing them would just be 20 lines to the same dot.
// Org edges point person -> PERSON (reports to, defers to technical, defers to budget). They are
// the only lines worth drawing, and there are a few dozen of them in a whole workspace — which is
// exactly why they are worth surfacing rather than burying under the employment edges.

/** Role edges: a badge on a person, not a line. */
export const ROLE_EDGES = new Set([
  'DECISION_MAKER_AT', 'BUDGET_HOLDER_AT', 'CHAMPIONS', 'BLOCKS', 'EVALUATING',
]);

/** Org edges: person to person, and the only lines this view draws. */
export const ORG_EDGES = new Set([
  'REPORTS_TO', 'DEFERS_TO_TECHNICAL', 'DEFERS_TO_BUDGET',
]);

/** How loud a badge is, so a person carrying two is described by the stronger one. */
const ROLE_RANK = {
  BLOCKS: 0,              // the one that loses deals
  DECISION_MAKER_AT: 1,
  BUDGET_HOLDER_AT: 2,
  CHAMPIONS: 3,
  EVALUATING: 4,
};

export const COMMITTEE_CAP = 25;

/**
 * Who is on the committee, strongest claim to a place first.
 *
 * The order is the argument of the whole view:
 *   1. anyone we extracted a ROLE for — this is the committee, and there are never many
 *   2. anyone attached to an open DEAL — they are in the room whether or not we labelled them
 *   3. whoever was spoken to most recently — the rest of the account, newest first
 *
 * Ties break on name so the same account draws the same picture twice, which matters more than
 * it sounds: a graph that reshuffles on reload cannot be read.
 *
 * Pure. Takes rows, returns rows.
 *
 * @param people       [{ id, name, jobTitle, lastActivityAt }]
 * @param rolesByPerson Map<personId, Set<relationship>>
 * @param dealPeople   Set<personId> on an open deal
 * @param cap
 */
export function rankCommittee(people, rolesByPerson, dealPeople, { cap = COMMITTEE_CAP } = {}) {
  const scored = (people ?? []).map((p) => {
    const roles = [...(rolesByPerson?.get(p.id) ?? [])]
      .sort((a, b) => (ROLE_RANK[a] ?? 9) - (ROLE_RANK[b] ?? 9));
    return {
      ...p,
      roles,
      onOpenDeal: !!dealPeople?.has(p.id),
      // 0 = has a role, 1 = on a deal, 2 = everyone else. Lower sorts first.
      tier: roles.length ? 0 : (dealPeople?.has(p.id) ? 1 : 2),
      roleRank: roles.length ? (ROLE_RANK[roles[0]] ?? 9) : 9,
    };
  });

  scored.sort((a, b) =>
    a.tier - b.tier
    || a.roleRank - b.roleRank
    || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
    || String(a.name ?? '').localeCompare(String(b.name ?? '')));

  return { people: scored.slice(0, cap), total: scored.length, shown: Math.min(cap, scored.length) };
}

/**
 * The lines between the people on screen.
 *
 * An edge to somebody who did not make the cut is dropped rather than drawn to nothing — a line
 * ending in empty space is worse than no line. Self-edges go too: extraction occasionally
 * resolves both ends of "she reports to herself" to the same person.
 */
export function committeeEdges(edges, visibleIds) {
  const seen = new Set();
  const out = [];
  for (const e of edges ?? []) {
    if (!ORG_EDGES.has(e.relationship)) continue;
    const from = e.subject_id;
    const to = e.object_id;
    if (!from || !to || from === to) continue;
    if (!visibleIds.has(from) || !visibleIds.has(to)) continue;
    const key = `${from}>${to}>${e.relationship}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to, type: e.relationship });
  }
  return out;
}
