// The "deal" view the intelligence jobs read — one row per account, mirroring the
// exact stage-derivation buildPortfolio uses (furthest rung across the account's
// contacts, terminal exit only when nothing is still on the ladder). Kept here (not
// imported from apps/api) so the worker owns its own read, using core's funnel.

import { STAGE_RANK, normalizeStage, isTerminalStage, DEFAULT_STAGE } from '@nous/core';

const DAY = 86_400_000;
// A deal is "in motion" — worth multithreading — once it's past first contact.
const OPEN_FLOOR = STAGE_RANK.interested ?? 2;

/** Compact dollar label ($12k, $1.2M) or null when there's no real value. */
export function fmtMoney(n) {
  if (n == null || n <= 0) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

/**
 * One row per account with a contact: { id, name, domain, stage, rank,
 * stakeholderCount, engagedCount, isWon, isOpen }. stakeholderCount = distinct
 * people on the deal; isOpen = on the ladder, past first contact, not won/terminal.
 */
export async function listDeals(supabase, workspaceId) {
  const { data: contacts } = await supabase.from('contacts')
    .select('id, company_id, pipeline_stage, last_activity_at, deal_value')
    .eq('workspace_id', workspaceId).not('company_id', 'is', null);
  if (!contacts?.length) return [];

  const companyIds = [...new Set(contacts.map((c) => c.company_id))];
  const { data: companies } = await supabase.from('companies')
    .select('id, name, domain, icp_score, deal_health_score').in('id', companyIds);

  const now = Date.now();
  const g = new Map();
  const ensure = (id) => { if (!g.has(id)) g.set(id, { r: -1, s: null, tr: -1, ts: null, total: 0, engaged: 0, last: null, value: null }); return g.get(id); };
  for (const c of contacts) {
    const x = ensure(c.company_id);
    const st = normalizeStage(c.pipeline_stage) || DEFAULT_STAGE;
    const r = STAGE_RANK[st];
    if (isTerminalStage(st)) { if (r > x.tr) { x.tr = r; x.ts = st; } }
    else if (r > x.r) { x.r = r; x.s = st; }
    x.total++;
    if (c.deal_value != null && (x.value == null || c.deal_value > x.value)) x.value = c.deal_value;
    if (c.last_activity_at) {
      if (!x.last || new Date(c.last_activity_at) > new Date(x.last)) x.last = c.last_activity_at;
      if ((now - new Date(c.last_activity_at).getTime()) / DAY <= 45) x.engaged++;
    }
  }

  return (companies ?? []).map((co) => {
    const x = g.get(co.id) || {};
    const stage = (x.r > 0 ? x.s : null) || x.ts || DEFAULT_STAGE;
    const rank = STAGE_RANK[stage] ?? 0;
    return {
      id: co.id, name: co.name || co.domain || null, domain: co.domain ?? null, stage, rank,
      icpScore: co.icp_score ?? null, dealHealth: co.deal_health_score ?? null,
      stakeholderCount: x.total || 0, engagedCount: x.engaged || 0,
      dealValue: x.value ?? null,
      daysSinceLastTouch: x.last ? Math.round((now - new Date(x.last).getTime()) / DAY) : null,
      isWon: stage === 'closed_won',
      isOpen: !isTerminalStage(stage) && stage !== 'closed_won' && rank >= OPEN_FLOOR,
    };
  });
}
