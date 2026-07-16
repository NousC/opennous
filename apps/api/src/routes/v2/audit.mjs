// GET /v2/audit — is this graph sound?
//
// The endpoint behind `nous audit`. Everything is a client of this: the CLI, a CI
// gate, an agent that wants to fix what it finds. One source of truth, so a build
// that passes and a terminal that says "healthy" can never disagree.

import { Router } from 'express';
import { getSupabaseClient, mergeEntities, runAudit } from '@nous/core';

export const auditV2Router = Router();

auditV2Router.get('/', async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(401).json({ error: 'auth_required' });

    const audit = await runAudit(getSupabaseClient(), workspaceId);

    // ?check=resolved — one check and its findings, for a focused CI gate or a
    // drill-down in the terminal.
    const only = req.query.check ? String(req.query.check) : null;
    if (only) {
      const check = audit.checks.find(c => c.key === only);
      if (!check) {
        return res.status(400).json({ error: 'unknown_check', valid: audit.checks.map(c => c.key) });
      }
      const findings = audit.findings.filter(f => f.check === only);
      return res.json({ checked_at: audit.checked_at, check, findings, failing: findings.length });
    }

    return res.json(audit);
  } catch (err) {
    console.error('[GET /v2/audit]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/audit/fix — repair what can be repaired without judgment.
//
// Deliberately narrow. This merges ONLY the duplicates we are certain of: records
// sharing an email address or a LinkedIn profile, which are the same human by
// definition. No model is involved, because no reasoning is required — and where
// reasoning WOULD be required (two people with the same name), a wrong merge is
// not cleanly undoable, so a machine must not make it.
//
// Everything else the audit finds either needs a decision (enrichment costs money),
// needs a browser (reconnecting Gmail), or needs you (is this the same Alex Fine?).
// A --fix that quietly did those too would be a --fix nobody could trust.
auditV2Router.post('/fix', async (req, res) => {
  try {
    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(401).json({ error: 'auth_required' });

    // Dry run unless told otherwise. A command that mutates your customer graph the
    // first time you run it out of curiosity is a command nobody runs twice.
    const apply = req.body?.apply === true;

    const supabase = getSupabaseClient();
    const audit = await runAudit(supabase, workspaceId);

    const certain = audit.findings
      .filter(f => f.check === 'resolved' && f.severity === 'high')
      .flatMap(f => f.subjects ?? [])
      .filter(s => s.confidence === 'certain');

    const planned = [];
    for (const dupe of certain) {
      const [keep, ...drop] = dupe.entity_ids;   // arbitrary survivor; the merge is lossless either way
      for (const d of drop) {
        planned.push({ keep, drop: d, who: dupe.who?.[0] ?? null, why: dupe.why });
      }
    }

    if (!apply) {
      return res.json({
        dry_run: true,
        would_merge: planned.length,
        merges: planned,
        note: 'Nothing changed. Re-run with --apply to make these merges.',
      });
    }

    const merged = [];
    const failed = [];
    for (const m of planned) {
      try {
        const summary = await mergeEntities(supabase, workspaceId, m.keep, m.drop);
        merged.push({ ...m, summary });
      } catch (err) {
        // One bad merge must not abort the rest, and must not be silent.
        failed.push({ ...m, error: String(err.message ?? err) });
      }
    }

    return res.json({ dry_run: false, merged: merged.length, failed: failed.length, merges: merged, failures: failed });
  } catch (err) {
    console.error('[POST /v2/audit/fix]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
