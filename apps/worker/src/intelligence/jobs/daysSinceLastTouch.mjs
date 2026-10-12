// Extractor: deal.days_since_last_touch — how long an account has gone without any
// interaction. The behavior behind stall / revenue-leakage detection.

import { listDeals } from '../deals.mjs';

export const dealDaysSinceLastTouch = {
  key: 'deal.days_since_last_touch',
  version: 1,
  subjectType: 'deal',
  async extract(ctx) {
    const deals = await listDeals(ctx.supabase, ctx.workspaceId);
    return deals
      .filter((d) => d.daysSinceLastTouch != null)
      .map((d) => ({ key: 'deal.days_since_last_touch', subjectType: 'deal', subjectId: d.id, valueNum: d.daysSinceLastTouch }));
  },
};
