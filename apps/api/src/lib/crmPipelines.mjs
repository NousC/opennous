// The CRM pipelines a workspace's deals sit in, read off the flattened deal rows.
//
// One reader for the app (GET /api/crm-pipelines, scoped to the viewer's own book) and the public
// API (GET /v2/pipelines), so the two can never list different pipelines for one workspace. The
// reasoning about which pipelines appear lives with the route; see routes/api/crmPipelines.mjs.

import { readPrimaryPipelineRef } from './accountDeals.mjs';
import { ownerFilter } from './ownerScope.mjs';
import { hasOwnershipColumns } from './listRows.mjs';
import { dealWindowFilter } from './dealListWindow.mjs';

/**
 * `owner` narrows the counts to one CRM owner's deals (null = the whole workspace).
 * @returns {{ pipelines: { id, name, deals, open_deals, is_primary }[], primary_pipeline_ref: string|null, names_ready: boolean }}
 */
export async function listCrmPipelines(supabase, workspaceId, { owner = null } = {}) {
  const [primary_pipeline_ref, ready] = await Promise.all([
    readPrimaryPipelineRef(supabase, workspaceId),
    hasOwnershipColumns(supabase),
  ]);

  // The id has been on the row since the pipeline-identity work; the NAME only arrives with the
  // ownership migration. Until then a pipeline is labelled by its id, which is ugly for a custom
  // pipeline and exactly right for HubSpot's primary, whose id is the literal string `default`.
  const byRef = new Map();
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('entity_list_rows')
      .select(ready ? 'pipeline_ref, pipeline, status' : 'pipeline_ref, status')
      .eq('workspace_id', workspaceId).eq('kind', 'deal')
      .or(dealWindowFilter());
    if (ready && owner) { const f = ownerFilter(owner); if (f) q = q.or(f); }
    const { data, error } = await q.order('entity_id', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) {
      const id = r.pipeline_ref ?? null;
      // A deal whose pipeline we never learned is not evidence of a pipeline. It belongs on the
      // board (the deal list keeps it) but it cannot earn a button of its own.
      if (!id) continue;
      const row = byRef.get(id) ?? { id, name: null, deals: 0, open_deals: 0 };
      row.deals += 1;
      if (r.status === 'open') row.open_deals += 1;
      if (!row.name && r.pipeline) row.name = String(r.pipeline).trim() || null;
      byRef.set(id, row);
    }
    if (!data || data.length < 1000) break;
  }

  // Primary first — it is the workspace's own funnel — then by how much of the viewer's work is
  // in it. A pipeline holding none of their OPEN deals still appears if they have history there;
  // its button simply reads 0.
  const pipelines = [...byRef.values()]
    .map(p => ({ ...p, is_primary: primary_pipeline_ref != null && p.id === primary_pipeline_ref }))
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || b.open_deals - a.open_deals || b.deals - a.deals);

  return { pipelines, primary_pipeline_ref, names_ready: ready };
}
