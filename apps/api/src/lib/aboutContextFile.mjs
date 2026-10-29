// The About us file (GET-1036): Settings > Context's designated "who we are and what we have".
//
// Its text is mirrored into the workspace's `positioning` foundation, so every reader that needs to
// know what we sell reads the same text without reaching into the context library: the competitor
// rule and the signal check (worker loadOurSide → offer), the feature-request check (GET-1031). Called
// when a file is marked About us and when the About us file is edited. With no About file (unmarked)
// it does nothing: the last text stays, as the ICP's does. Unchanged text writes nothing.
// -> { status: 'mirrored' | 'unchanged' | 'no_about_file' | 'failed' }
import { workspaceAboutContext } from '@nous/core';

export async function mirrorAboutFile(sb, ws, { about = workspaceAboutContext } = {}) {
  try {
    const file = await about(sb, ws);
    const text = String(file?.text ?? '').trim();
    if (!text) return { status: 'no_about_file' };
    const { data: current } = await sb.from('foundations').select('body_md').eq('workspace_id', ws).eq('kind', 'positioning').maybeSingle();
    if (String(current?.body_md ?? '').trim() === text) return { status: 'unchanged' };
    const { error } = await sb.from('foundations').upsert({
      workspace_id: ws, kind: 'positioning', title: file.title || 'About us', body_md: text, source: 'nous', updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,kind' });
    if (error) throw error;
    return { status: 'mirrored' };
  } catch (e) {
    console.error('[about-context-file] positioning mirror failed:', e?.message || e);
    return { status: 'failed' };
  }
}
