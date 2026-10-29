// Per-workspace ICP dial model, stored as YAML in workspace_icp_model and edited in
// Settings > ICP. WYSIWYG: the YAML the operator saves is exactly what the scorer runs.
// When a workspace has no row yet, we return the repo default (src/cloud/config/icp-model.json)
// rendered as YAML, so the editor is never blank and new workspaces start sane.
import { stringify as stringifyYaml } from 'yaml';
import { DEFAULT_MODEL, parseModelYaml, validateModel } from './scoreDials.mjs';

// Render the seed model as clean YAML (drop the internal _doc note; add a header comment).
const { _doc, ...SEED } = DEFAULT_MODEL;
export const DEFAULT_YAML =
  '# ICP scoring dials. score = base + best persona + firmographics + observed signals,\n' +
  '# clamped 0-100; a disqualifier caps at 25. Absent signals never subtract.\n' +
  '# Terms are matched (case-insensitive) against a lead\'s job title, bio, keywords, and comment.\n\n' +
  stringifyYaml(SEED, { lineWidth: 0 });

// The YAML text for a workspace (its saved edit, or the default seed).
export async function getIcpModelYaml(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('workspace_icp_model')
    .select('yaml')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) { console.warn('[ICP_MODEL] read', error.message); return DEFAULT_YAML; }
  return data?.yaml || DEFAULT_YAML;
}

// The parsed model object the scorer consumes (falls back to the seed on a bad row).
export async function getIcpModel(supabase, workspaceId) {
  const yaml = await getIcpModelYaml(supabase, workspaceId);
  try {
    const m = parseModelYaml(yaml);
    return validateModel(m).ok ? m : DEFAULT_MODEL;
  } catch { return DEFAULT_MODEL; }
}

// Validate + persist an operator edit. Returns { ok, errors? }.
export async function saveIcpModelYaml(supabase, workspaceId, yamlText, userId) {
  let model;
  try { model = parseModelYaml(yamlText); }
  catch (e) { return { ok: false, errors: [`YAML parse error: ${e.message}`] }; }
  const v = validateModel(model);
  if (!v.ok) return { ok: false, errors: v.errors };
  const { error } = await supabase
    .from('workspace_icp_model')
    .upsert({ workspace_id: workspaceId, yaml: yamlText, updated_at: new Date().toISOString(), updated_by: userId || null },
            { onConflict: 'workspace_id' });
  if (error) return { ok: false, errors: [error.message] };
  return { ok: true };
}
