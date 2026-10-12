// Curation job: the objection matcher. learn() rebuilds the objection_handlers
// battlecard weekly (cluster recurring objections → answer each from our own
// foundations). recommend() surfaces the high-frequency ones in Focus so the operator
// knows which objections keep coming back and exactly how to answer them.

import { buildObjectionHandlers } from '../objections.mjs';

const KEY = 'objection.recurring';
const MIN_ACCOUNTS = 2;   // an objection has to recur across accounts to be worth a rec

export const objectionMatcher = {
  key: KEY,
  category: 'objection',
  type: 'curation',
  cadence: 'weekly',
  question: 'Which objections keep coming back, and what answers them?',

  async learn(ctx) {
    // Curation writes its own store (objection_handlers), not ri_observations.
    await buildObjectionHandlers(ctx.supabase, ctx.workspaceId);
    return [];
  },

  async recommend(ctx) {
    const { data: handlers } = await ctx.supabase.from('objection_handlers')
      .select('id, title, objection_summary, answer_md, proof, account_count, evidence')
      .eq('workspace_id', ctx.workspaceId).eq('status', 'open')
      .gte('account_count', MIN_ACCOUNTS)
      .order('account_count', { ascending: false }).limit(10);

    return (handlers ?? []).map((h) => ({
      category: 'objection',
      recKey: KEY,
      targetType: 'objection',
      targetId: h.id,
      text: `${h.account_count} account${h.account_count === 1 ? '' : 's'} raised "${h.title}" — here's how to answer it.`,
      evidence: {
        answer: h.answer_md,
        proof: h.proof,
        objection: h.objection_summary,
        account_count: h.account_count,
        examples: h.evidence?.examples ?? [],
      },
    }));
  },
};
