// Extractor: deal.stakeholder_count — how many distinct people are on each deal.
// The first behavior. Pure function of the graph (via listDeals), so it is safe to
// re-run and to backfill. The multithreading job reads deals directly for freshness;
// this persists the behavior so it accumulates as history and other jobs can reuse it.

import { listDeals } from '../deals.mjs';

export const dealStakeholderCount = {
  key: 'deal.stakeholder_count',
  version: 1,
  subjectType: 'deal',
  async extract(ctx) {
    const deals = await listDeals(ctx.supabase, ctx.workspaceId);
    return deals.map((d) => ({
      key: 'deal.stakeholder_count',
      subjectType: 'deal',
      subjectId: d.id,
      valueNum: d.stakeholderCount,
    }));
  },
};
