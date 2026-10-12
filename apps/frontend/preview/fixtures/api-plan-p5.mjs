// API-plan preview fixtures for the accounts list and record (GET-634). Loaded only when
// PREVIEW_PLAN=api, so the Workspace baselines never see them.
//
// The list gains what the real flattened list sends (faces, people_count, open_deals,
// last_activity_at), and the record gains its claims (`facts`) and a source on its intel, all
// derived from the fixture world rather than typed in.
import { COMPANIES, CONTACTS, DEALS, companiesList, companyDetail, readScope } from "../world.mjs";

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const peopleOf = (id) => CONTACTS.filter((c) => c.company_id === id);
const lastActivity = (id) => peopleOf(id).map((c) => c.last_activity_at).filter(Boolean).sort().pop() ?? null;

function list(scope) {
  const out = companiesList(scope);
  return {
    ...out,
    companies: out.companies.map((c) => {
      const people = peopleOf(c.id);
      return {
        ...c,
        people: people.slice(0, 4).map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}`, photo_url: null, email: p.email })),
        people_count: people.length,
        open_deals: DEALS.filter((d) => d.company_id === c.id && d.status === "open").length,
        last_activity_at: lastActivity(c.id),
      };
    }),
  };
}

// Where the fixture world's intel came from, in turn: a call tool, the inbox, a call tool.
const SOURCES = ["fireflies", "gmail", "fellow"];

function detail(id) {
  const d = companyDetail(id);
  if (!d) return { error: "not_found" };
  const co = COMPANIES.find((x) => x.id === id);
  const claim = (property, value, confidence, freshness, days) =>
    ({ property, value, confidence, epistemic_class: "asserted", freshness, observation_count: 2, last_observed_at: iso(days) });
  return {
    ...d,
    facts: [
      claim("industry", co.industry, 0.92, "fresh", 3),
      claim("employee_count", co.employee_count, 0.64, "aging", 16),
      claim("location", co.location, 0.9, "fresh", 9),
      claim("revenue_range", co.revenue_range, 0.55, "stale", 120),
    ],
    notes: (d.notes ?? []).map((n, i) => ({ ...n, metadata: { ...(n.metadata ?? {}), extraction_source: SOURCES[i % SOURCES.length] } })),
  };
}

export const routes = [
  ["GET", /^\/api\/companies\/list$/, (_m, q) => list(readScope(q.get("scope")))],
  ["GET", /^\/api\/companies\/([^/]+)\/detail$/, (m) => detail(m[1])],
];
