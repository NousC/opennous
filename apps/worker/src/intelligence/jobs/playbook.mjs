// Job: playbook.build (category playbook, curation) — a playbook is not a new kind
// of knowledge, it's a curated bundle of the workspace's currently ACTIVE observations
// (the proven plays). It writes to ri_playbooks and versions when the bundle changes,
// so leadership can watch the playbook grow. Runs monthly. No recommend() — a playbook
// is a curation, not a per-deal rec.

import { getActiveObservations, upsertPlaybook } from '../db.mjs';

const KEY = 'playbook.build';

export const playbookBuild = {
  key: KEY, category: 'playbook', type: 'curation', cadence: 'monthly',
  question: 'What is the current set of proven plays for this workspace?',
  async learn(ctx) {
    const active = await getActiveObservations(ctx.supabase, ctx.workspaceId);
    if (!active.length) return [];
    await upsertPlaybook(ctx.supabase, ctx.workspaceId, 'current',
      active.map((o) => o.id),
      { plays: active.length, categories: [...new Set(active.map((o) => o.category))] });
    return [];  // curation writes its own row; nothing to add to observations
  },
};
