// One-off (GET-1033): the chips the first re-check wrote too long, cut mid-word at 40 characters
// ("Conditional pricing acceptance pending p"). Each is written again from its own sentence, 2–5
// words, and kept only when it reads whole. Only the chip changes; the claim and its history stay.
//
//   node apps/worker/scripts/rechipSignals.mjs --workspace=UUID [--write]
//
// Dry run by default. Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the worker's model keys.
import { getSupabaseClient } from '@nous/core';
import { read, parseArray, acceptsArray } from '../src/noema/read.mjs';
import { goodChip } from '../src/signals/signalCheck.mjs';

const argv = process.argv.slice(2);
const arg = name => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const WS = arg('workspace');
const WRITE = argv.includes('--write');
if (!WS) { console.error('usage: rechipSignals --workspace=UUID [--write]'); process.exit(1); }
const supabase = getSupabaseClient();

const { data, error } = await supabase.from('claims').select('id, value')
  .eq('workspace_id', WS).like('property', 'note.%').is('invalid_at', null)
  .eq('value->metadata->>checked', 'rewritten').limit(500);
if (error) throw error;
const bad = (data ?? []).filter(c => !goodChip(c.value?.label));
console.log(`[RECHIP] ${bad.length} chip(s) to write again · ${WRITE ? 'WRITE' : 'dry run'}`);
if (!bad.length) process.exit(0);

const prompt = `Each line is a fact on a sales account, with its category. Write its chip: what a rep skims on a card.
A chip is 2–5 words and at most 40 characters, sentence case, readable on its own by someone who was not there. Never a person's name, never "X vs Y", no trailing period.

${bad.map((c, i) => `${i + 1}. [${c.value.category}] ${c.value.content}`).join('\n')}

Answer with ONLY a JSON array: [{"n": 1, "chip": "..."}]`;
const r = await read({ supabase, workspaceId: WS, feature: 'signal-rechip', prompt, accept: acceptsArray, parse: parseArray, maxTokens: 1500 });
if (!r.ok) { console.error(`[RECHIP] no answer (${r.reason}), nothing changed`); process.exit(1); }
for (const item of r.value) {
  const c = bad[Number(item?.n) - 1];
  if (!c) continue;
  if (!goodChip(item.chip)) { console.log(`  skip "${c.value.label}" — "${item.chip}" does not read whole`); continue; }
  console.log(`  "${c.value.label}" → "${item.chip}"`);
  if (!WRITE) continue;
  const { error: e } = await supabase.from('claims').update({ value: { ...c.value, label: item.chip.trim() } }).eq('id', c.id).eq('workspace_id', WS);
  if (e) console.warn(`    failed: ${e.message}`);
}
