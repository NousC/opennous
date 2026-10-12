import { Router } from 'express';
import {
  getSupabaseClient, getWorkspaceStages, PIPELINE_LADDER, TERMINAL_STAGES, STAGE_LABEL, STAGE_RANK,
} from '@nous/core';
import { listCrmPipelines } from '../../lib/crmPipelines.mjs';
import { unknownParams, viewerBook } from '../../lib/publicApi.mjs';

export const pipelinesV2Router = Router();

const KIND = { closed_won: 'won', closed_lost: 'lost', disqualified: 'lost', churned: 'churned' };

/** The canonical ladder every stage maps onto (pipeline.ts) — what `canonical_stage` and `stage=` filters speak. */
export function standardStages() {
  return [...PIPELINE_LADDER, ...TERMINAL_STAGES].map((key) => ({
    key, label: STAGE_LABEL[key] ?? key, rank: STAGE_RANK[key], kind: KIND[key] ?? 'active',
  }));
}

const shapeStage = (s) => ({ key: s.key, label: s.label, canonical: s.canonical, kind: s.kind });

// GET /v2/pipelines — the workspace's CRM pipelines, each with its stages in order and the
// canonical stage each maps to, plus the standard ladder (`standard_stages`).
//
// The pipelines are the ones the workspace's deals sit in (the same reader as the app's pipeline
// switcher, /api/crm-pipelines), primary first. The primary pipeline's stages are the workspace's
// own ladder; every other pipeline has its own (workspace_stages per pipeline_ref).
//
// A workspace without a CRM has no pipelines: `pipelines` is empty, `implied: true`, and its deals
// are the implied ones (/v2/deals), staged on `workspace_stages` (its own ladder, when it named one)
// over `standard_stages`.
//
// Deal counts (`deals`, `open_deals`, in the app's list window) are left out for a member key on a
// closed workspace: they count deals outside that member's book.
pipelinesV2Router.get('/', async (req, res) => {
  try {
    const bad = unknownParams(req.query, new Set());
    if (bad) return res.status(400).json(bad);
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    const [{ pipelines: found, primary_pipeline_ref }, book, own] = await Promise.all([
      listCrmPipelines(supabase, workspaceId),
      viewerBook(supabase, workspaceId, req),
      getWorkspaceStages(supabase, workspaceId),
    ]);

    // The primary pipeline is the workspace's even before a deal is in it.
    const list = [...found];
    if (primary_pipeline_ref && !list.some((p) => p.id === primary_pipeline_ref)) {
      list.unshift({ id: primary_pipeline_ref, name: null, deals: 0, open_deals: 0, is_primary: true });
    }

    if (!list.length) {
      return res.json({
        pipelines: [],
        implied: true,
        workspace_stages: own.map(shapeStage),
        standard_stages: standardStages(),
      });
    }

    const pipelines = await Promise.all(list.map(async (p) => {
      const stages = p.is_primary ? own : await getWorkspaceStages(supabase, workspaceId, { pipelineRef: p.id });
      return {
        id: p.id,
        name: p.name ?? p.id,
        is_primary: !!p.is_primary,
        ...(book.restrict ? {} : { deals: p.deals, open_deals: p.open_deals }),
        stages: stages.map(shapeStage),
      };
    }));
    return res.json({ pipelines, implied: false, primary_pipeline_ref, standard_stages: standardStages() });
  } catch (err) {
    console.error('[GET /v2/pipelines]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
