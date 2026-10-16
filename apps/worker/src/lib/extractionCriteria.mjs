// What a workspace adds to fact extraction (GET-862; a seam since GET-910). Nous Cloud's workspace
// signals ask the extractor to keep the facts their rules are about, so the signal runtime can read
// them. Cloud's index exports that as `extractionCriteria`; it is looked up through lib/cloud.mjs on
// each read, so a one-off script extracts exactly as the worker does. Without the Cloud layer a
// workspace adds nothing and the prompts are as they were.
import { loadCloud } from './cloud.mjs';

/** The text appended to an extraction prompt for this workspace: '' when it adds nothing. */
export async function extractionCriteria(supabase, workspaceId) {
  const criteria = (await loadCloud())?.extractionCriteria;
  return criteria ? criteria(supabase, workspaceId) : '';
}
