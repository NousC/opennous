// Turn people NAMED in existing Connections claims into graph nodes.
//
// The live hook (persistFacts → linkMentionsFromClaim) handles new Connections facts,
// but facts recorded before it — or by hand (a manual backfill) — never ran through
// it, so the person they name isn't a node yet. This backfills them: find
// relationship/Connections claims, extract the named people, and resolve each into
// the graph (link to a unique account, stub a pending node, or leave an ambiguous
// name for a human — never guess).
//
// SAFE BY DEFAULT: dry-run — reports what each name WOULD resolve to (resolved /
// ambiguous / new) and writes nothing. Pass --apply to create the nodes + KNOWS edges.
//
// Options:
//   <contactId>          one account's Connections claims (or set CONTACT_ID)
//   --workspace <uuid>   sweep every Connections claim in a workspace
//   --limit <n>          only the first N claims
//   --apply              commit (otherwise dry-run)
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/linkConnectionMentions.mjs <contactId>
//   docker compose exec -T worker node apps/worker/src/linkConnectionMentions.mjs --workspace <id> --apply

import './bootEnv.mjs';
import { getSupabaseClient } from '@nous/core';
import { linkMentionsFromClaim } from './signals/index.mjs';

const DEFAULT_CONTACT = process.env.CONTACT_ID || '00000000-0000-0000-0000-000000000000';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function loadConnectionClaims(supabase, { workspaceId, contactId, limit }) {
  let q = supabase
    .from('claims')
    .select('id, entity_id, workspace_id, value')
    .like('property', 'note.%')
    .is('invalid_at', null);
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  if (contactId) q = q.eq('entity_id', contactId);
  const { data, error } = await q.limit(limit || 2000);
  if (error) { console.error('failed to load claims:', error.message); process.exit(1); }
  // Connections = the 'relationship' category (labelled "Connections" in the UI).
  return (data || []).filter(c => (c.value?.category || '').toLowerCase() === 'relationship' && c.value?.content);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const workspaceId = arg('--workspace', null);
  const limit = Number(arg('--limit', 0)) || 0;
  const contactArg = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+$/.test(a));

  const supabase = getSupabaseClient();

  let claims;
  if (workspaceId) {
    claims = await loadConnectionClaims(supabase, { workspaceId, limit });
  } else {
    const contactId = contactArg || DEFAULT_CONTACT;
    const { data: c } = await supabase.from('contacts').select('workspace_id').eq('id', contactId).maybeSingle();
    if (!c) { console.error(`contact ${contactId} not found`); process.exit(1); }
    claims = await loadConnectionClaims(supabase, { workspaceId: c.workspace_id, contactId, limit });
  }

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${claims.length} Connections claim(s)\n`);
  let linked = 0, ambiguous = 0, stubbed = 0;
  for (const claim of claims) {
    const results = await linkMentionsFromClaim({
      supabase, workspaceId: claim.workspace_id, subjectEntityId: claim.entity_id,
      content: claim.value.content, sourceMemoryId: claim.id, dryRun: !apply,
    });
    for (const r of results) {
      const tag =
        r.status === 'resolved'      ? '→ linked to existing account'
      : r.status === 'resolved_stub' ? (apply ? '+ stubbed new node' : '+ would stub new node')
      : r.status === 'ambiguous'     ? `? ambiguous (${(r.candidates || []).length} candidates — needs a human)`
      : r.status === 'new'           ? '+ would stub new node'
      : r.status;
      console.log(`  ${r.label}  ${tag}${r.entity_id ? `  [${r.entity_id}]` : ''}`);
      if (r.status === 'resolved') linked++;
      else if (r.status === 'resolved_stub' || r.status === 'new') stubbed++;
      else if (r.status === 'ambiguous') ambiguous++;
    }
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`${apply ? 'DONE' : 'DRY-RUN COMPLETE'} — linked ${linked}, ${apply ? 'stubbed' : 'would stub'} ${stubbed}, ambiguous ${ambiguous}`);
  if (!apply) console.log(`\nRe-run with --apply to create the nodes + edges.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
