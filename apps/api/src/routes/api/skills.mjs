// /api/skills — what the agent knows how to do.
//
// The Skills page reads this. It's a window onto exactly what the agent carries:
// the same rows listSkills() hands the model, plus the one thing the model
// doesn't need but a person does — whether the integrations a skill depends on
// are actually connected in THIS workspace, so the page can send them to
// Integrations instead of letting them find out mid-run.
//
// Read-only for now. The table already supports workspace-authored skills (same
// loader, same execution path), so the editor is a POST away when we want it.

import { Router } from 'express';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { listSkills, missingProviders } from '../../lib/skills.mjs';

export const skillsRouter = Router();

// GET /api/skills?workspaceId=…
skillsRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const skills = await listSkills(supabase, workspaceId);

    // One readiness check per skill. The list is small (a library, not a feed),
    // so this stays a handful of queries — resolved together rather than in
    // sequence so the page doesn't wait on the sum of them.
    const withReadiness = await Promise.all(skills.map(async (s) => {
      const missing = await missingProviders(supabase, workspaceId, s.requires_providers);
      return {
        id:                 s.id,
        name:               s.name,
        // What a person reads. Falls back to the model's trigger line when a
        // skill hasn't been given a summary yet.
        summary:            s.summary || s.description,
        description:        s.description,
        body:               s.body,
        category:           s.category,
        requires_providers: s.requires_providers ?? [],
        missing_providers:  missing,
        est_cost_usd:       s.est_cost_usd,
        is_builtin:         s.is_builtin,
        // A skill is ready when everything it depends on is connected. Anything
        // else is a skill the agent will have to apologise for halfway through.
        ready:              missing.length === 0,
      };
    }));

    return res.json({ skills: withReadiness, count: withReadiness.length });
  } catch (err) {
    console.error('[GET /api/skills]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
