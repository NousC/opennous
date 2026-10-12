// Embed-on-write for personal_files. The personal knowledge base (propose/search/read
// a member's vault) was retired — Nous no longer reads a member's vault. What remains
// writing to personal_files is the EVIDENCE layer (the worker files each account/people
// touch there) and the repo-connect that pushes it out. This module keeps the one thing
// that layer still wants: a best-effort embedding so an evidence row is retrievable.
//
// Scoped to ONE member: (workspace_id, user_id). Embeddings reuse the same 1536-dim
// OpenAI space as the rest of the substrate (see @nous/core embed); with no
// OPENAI_API_KEY the embed step no-ops rather than failing.

import { embed } from '@nous/core';

// ── Frontmatter ─────────────────────────────────────────────────────────────
// Evidence/vault files carry YAML frontmatter (type, source, account, people…). We
// lift the top-level scalar keys we care about and hand back the body without the fence.
export function parseFrontmatter(content) {
  const text = String(content ?? '');
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) data[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { data, body };
}

// The one line that best labels a file: an explicit frontmatter `description:`, then the
// first `# heading`, then frontmatter `about:`, then the first prose line.
function fileDescription(content) {
  const { data, body } = parseFrontmatter(content);
  if (data.description) return data.description.slice(0, 160);
  const h1 = body.split('\n').map((l) => l.trim()).find((l) => /^#{1,3}\s+\S/.test(l));
  if (h1) return h1.replace(/^#{1,3}\s+/, '').slice(0, 160);
  if (data.about) return String(data.about).replace(/^\[|\]$/g, '').trim().slice(0, 160);
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---')) continue;
    return t.replace(/^[*_>-]+\s*/, '').slice(0, 160);
  }
  return '';
}

// What we embed for a file: enough signal to match a query, capped so one large
// document can't dominate the token budget.
function vaultEmbedText(file) {
  const path = [file.folder, file.subfolder, file.name].filter(Boolean).join('/');
  const desc = fileDescription(file.content);
  return `${path}\n${desc}\n${file.content ?? ''}`.slice(0, 4000);
}

// ── Embed on write ────────────────────────────────────────────────────────────
// Best-effort: embed synchronously so the row is findable in the same session; swallow
// every error (no key, RPC/column not migrated, API hiccup) so a write is never blocked.
export async function embedVaultRow(supabase, file) {
  if (!file?.id) return;
  try {
    const vec = await embed(vaultEmbedText(file));
    if (!vec) return;
    await supabase.from('personal_files')
      .update({ embedding: JSON.stringify(vec) })
      .eq('id', file.id);
  } catch { /* non-fatal — a later save or a backfill re-embeds it */ }
}
