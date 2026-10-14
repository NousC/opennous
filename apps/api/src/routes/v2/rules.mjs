import { Router } from 'express';
import {
  getSupabaseClient, addRule, listRules, updateRule, removeRule, RULE_CHECKS, RULE_WEIGHTS, normalizeCheck,
} from '@nous/core';

export const rulesV2Router = Router();

// /v2/rules — a rep's rules, said once (GET-846). No frontend: the agent writes and reads them here
// and through the MCP `rules` tool.
//
//   GET    /v2/rules            the caller's rules
//   GET    /v2/rules/checks     the checks a rule can be mapped onto (what each verifies)
//   POST   /v2/rules            { statement, check?: { type, params }, weight? } — add (saying it again updates it)
//   PATCH  /v2/rules/:id        { status?: active|paused, weight?, check?: {type, params} | null }
//   DELETE /v2/rules/:id        remove (soft)
//
// A rule without a check is GUIDANCE: it reaches the agent with its instructions and nothing checks
// it. A rule with one is CHECKED: the worker evaluates it hourly and a broken one opens a flag and a
// task on the account. Rules are personal, so every call needs a person: a member key or a signed-in
// member. A workspace key (no person) is refused rather than writing a rule that binds nobody.

const FIELDS = new Set(['statement', 'check', 'check_type', 'params', 'weight']);

/** A POST body as addRule's input, or the reason it cannot be one. Pure. */
export function parseRuleInput(body = {}) {
  for (const k of Object.keys(body ?? {})) if (!FIELDS.has(k)) return { ok: false, error: 'unknown_field', field: k };
  const statement = typeof body.statement === 'string' ? body.statement.trim() : '';
  if (!statement) return { ok: false, error: 'statement_required' };
  if (body.weight != null && !RULE_WEIGHTS.includes(body.weight)) return { ok: false, error: 'invalid_weight' };
  const raw = body.check ?? (body.check_type ? { type: body.check_type, params: body.params } : null);
  let check = null;
  if (raw) {
    const norm = normalizeCheck(raw.type, raw.params);
    if (!norm) return { ok: false, error: 'unknown_check', checks: Object.keys(RULE_CHECKS) };
    check = { type: norm.check_type, params: norm.params };
  }
  return { ok: true, input: { statement, check, weight: body.weight ?? 'normal' } };
}

/** A rule as a caller sees it: what it says, whether and how it is checked. Pure. */
export function ruleView(r) {
  const spec = r.check_type ? RULE_CHECKS[r.check_type] : null;
  return {
    id: r.id,
    statement: r.statement,
    kind: r.kind,
    check: spec ? { type: r.check_type, params: r.params ?? {}, label: spec.label, verifies: spec.verifies } : null,
    weight: r.weight,
    status: r.status,
    created_at: r.created_at,
  };
}

// The person, and only one bound to this workspace: memberUserId is set together with workspaceId
// (a member key, or a signed-in member of the workspace asked for). internalUserId alone is a
// signed-in user with no workspace resolved, and would write a rule into none.
const needPerson = (req, res) => {
  const user = req.workspaceId ? req.memberUserId ?? null : null;
  if (!user) res.status(400).json({ error: 'member_required', message: 'Rules are personal: use a member API key or a signed-in member of the workspace.' });
  return user;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (label, fn) => async (req, res) => {
  try { return await fn(req, res); }
  catch (err) { console.error(`[${label}]`, err); return res.status(500).json({ error: 'internal_error' }); }
};

rulesV2Router.get('/checks', (_req, res) => res.json({
  checks: Object.entries(RULE_CHECKS).map(([type, c]) => ({ type, label: c.label, verifies: c.verifies, param: c.param, default: c.default, min: c.min, max: c.max })),
}));

rulesV2Router.get('/', wrap('GET /v2/rules', async (req, res) => {
  const user = needPerson(req, res); if (!user) return;
  const rules = await listRules(getSupabaseClient(), req.workspaceId, { userId: user });
  return res.json({ rules: rules.map(ruleView), count: rules.length });
}));

rulesV2Router.post('/', wrap('POST /v2/rules', async (req, res) => {
  const user = needPerson(req, res); if (!user) return;
  const parsed = parseRuleInput(req.body);
  if (!parsed.ok) return res.status(400).json(parsed);
  const row = await addRule(getSupabaseClient(), req.workspaceId, { ...parsed.input, user_id: user });
  return res.status(201).json({ rule: ruleView(row) });
}));

rulesV2Router.patch('/:id', wrap('PATCH /v2/rules/:id', async (req, res) => {
  const user = needPerson(req, res); if (!user) return;
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'rule_not_found' });
  const b = req.body ?? {};
  if (b.status != null && !['active', 'paused'].includes(b.status)) return res.status(400).json({ error: 'invalid_status' });
  if (b.weight != null && !RULE_WEIGHTS.includes(b.weight)) return res.status(400).json({ error: 'invalid_weight' });
  if (b.check && !normalizeCheck(b.check.type, b.check.params)) return res.status(400).json({ error: 'unknown_check', checks: Object.keys(RULE_CHECKS) });
  const row = await updateRule(getSupabaseClient(), req.workspaceId, req.params.id, user, b);
  if (!row) return res.status(404).json({ error: 'rule_not_found' });
  return res.json({ rule: ruleView(row) });
}));

rulesV2Router.delete('/:id', wrap('DELETE /v2/rules/:id', async (req, res) => {
  const user = needPerson(req, res); if (!user) return;
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'rule_not_found' });
  const row = await removeRule(getSupabaseClient(), req.workspaceId, req.params.id, user);
  if (!row) return res.status(404).json({ error: 'rule_not_found' });
  return res.json({ status: 'removed', id: row.id });
}));
