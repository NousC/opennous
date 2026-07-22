// Resolve an AMBIGUOUS person-mention to the account a human picked.
//
// When a named connection ("Georgi") matched several people, the resolver refused to
// guess. This applies the human's choice: a confident KNOWS edge from the subject to
// the picked account, plus the pick tagged onto the source claim's metadata.mentions
// (the @<name> link).
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/pickMention.mjs \
//     <subjectEntityId> <objectEntityId> "<Object Name>" [--claim <claimId>] [--subject-label "<Name>"]

import './bootEnv.mjs';
import { getSupabaseClient, resolveMentionToEntity } from '@nous/core';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const [subjectEntityId, objectEntityId, objectLabel] = positional;
  const claimId = arg('--claim', null);
  let subjectLabel = arg('--subject-label', null);

  if (!subjectEntityId || !objectEntityId || !objectLabel) {
    console.error('usage: pickMention.mjs <subjectEntityId> <objectEntityId> "<Object Name>" [--claim <id>] [--subject-label "<Name>"]');
    process.exit(1);
  }

  const supabase = getSupabaseClient();
  const { data: subj } = await supabase
    .from('contacts').select('workspace_id, first_name, last_name').eq('id', subjectEntityId).maybeSingle();
  if (!subj) { console.error(`subject ${subjectEntityId} not found`); process.exit(1); }
  if (!subjectLabel) subjectLabel = [subj.first_name, subj.last_name].filter(Boolean).join(' ') || 'the account';

  await resolveMentionToEntity(supabase, subj.workspace_id, {
    subjectEntityId, subjectLabel, objectEntityId, objectLabel, sourceClaimId: claimId,
  });

  console.log(`✓ linked ${subjectLabel} → KNOWS → ${objectLabel} [${objectEntityId}]${claimId ? `, tagged claim ${claimId}` : ''}`);
}

main().catch(err => { console.error(err); process.exit(1); });
