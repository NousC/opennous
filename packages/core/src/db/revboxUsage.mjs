/** Await the billing write. A failed write stops subsequent paid work. */
export async function recordRevboxUsage(sb, { workspaceId, userId, boxId, jobId = null, runId = null, feature, model, usage, costUsd, requestId }) {
  const { error } = await sb.rpc('record_revbox_usage', {
    p_workspace_id: workspaceId, p_user_id: userId, p_revbox_id: boxId,
    p_job_id: jobId, p_run_id: runId, p_feature: feature, p_model: model,
    p_usage: usage ?? {}, p_cost_usd: costUsd, p_request_id: requestId,
  });
  if (error) throw error;
}
export async function revboxRunCosts(sb,ws,boxId,runIds){
  const {data,error}=await sb.rpc('revbox_run_costs',{p_workspace_id:ws,p_revbox_id:boxId,p_run_ids:runIds});
  if(error)throw error;
  const costs=new Map();for(const row of data??[])costs.set(row.run_id,(costs.get(row.run_id)??0)+Number(row.cost_usd));return costs;
}
