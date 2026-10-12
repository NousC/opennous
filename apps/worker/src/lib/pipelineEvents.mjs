// Model-call trouble, kept (GET-201).
//
// Fallbacks, outages and unparseable answers used to exist only as worker log lines, and
// every deploy recreates the container and wipes them. Two deploys in a row once erased
// the only record of dozens of fallbacks and several credit failures. These rows are what
// system_health_daily counts as llm.fallback / llm.unavailable / llm.unparseable.

const KINDS = new Set(['fallback', 'unavailable', 'unparseable']);

/** Record one event. Best-effort: metering must never break extraction. */
export async function recordPipelineEvent(supabase, { workspaceId = null, kind, feature = null, model = null, detail = {} }) {
  if (!supabase || !KINDS.has(kind)) return;
  try {
    const { error } = await supabase.from('pipeline_events').insert({
      workspace_id: workspaceId, kind, feature, model, detail,
    });
    // .insert() resolves with an error rather than throwing — say so, or a missing
    // table reads as "nothing went wrong".
    if (error) console.warn(`[pipelineEvents] ${kind} not recorded: ${error.message}`);
  } catch (e) {
    console.warn(`[pipelineEvents] ${kind} not recorded: ${e?.message || e}`);
  }
}
