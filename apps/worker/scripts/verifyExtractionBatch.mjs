#!/usr/bin/env node
// Verify a meeting-extraction batch against the bars — run after EVERY batch, before the next.
//
//   docker compose run --rm --no-deps -e WS_ID=<workspace> worker \
//     node apps/worker/scripts/verifyExtractionBatch.mjs --since 2026-09-21T22:38:00Z [--strict]
//
// The bars come from two places. docs/meeting-extraction-runbook.md §Verify holds the original
// set (general share, quote rate, company scope). The four added on 2026-09-21 come from an audit
// of a couple of thousand claims (GET-417) that found intel that was real but wrong on the page:
//
//   - health-read paragraphs filed as facts (no label, no quote, 4–6 sentences)
//   - "Linked this meeting…" bookkeeping in `general`
//   - a declined product (expansion_signal, stance declined) missing its stance
//   - the rep's own words filed as the customer's fact
//
// Each check prints a number and whether it clears the bar. --strict exits 1 on any miss so a
// batch script can refuse to release the next window. The writers are supposed to make every
// count here zero; this script is how the next person finds out when one of them stops.

import { getSupabaseClient, isIntelClaim } from '@nous/core';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const WS = process.env.WS_ID || arg('--ws');
const SINCE = arg('--since');
const STRICT = process.argv.includes('--strict');
if (!WS || !SINCE) { console.error('usage: verifyExtractionBatch.mjs --since <iso> [--ws <workspace>] [--strict]   (WS_ID env works too)'); process.exit(2); }

const sb = getSupabaseClient();
const misses = [];
const bar = (label, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) misses.push(label); };
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

// ── claims ────────────────────────────────────────────────────────────────────
const notes = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('claims').select('id, entity_id, value, valid_from, computed_at').eq('workspace_id', WS)
    .gte('property', 'note.').lt('property', 'note/').is('invalid_at', null).gte('computed_at', SINCE).order('id').range(from, from + 999);
  if (error) { console.error('claims read failed:', error.message); process.exit(2); }
  notes.push(...data); if (data.length < 1000) break;
}
const intel = notes.filter(n => isIntelClaim(n.value));
const nonIntel = notes.length - intel.length;
const byCat = {};
for (const n of intel) {
  const v = n.value ?? {}, m = v.metadata ?? {};
  const c = (byCat[v.category ?? 'null'] ??= { n: 0, quoted: 0, company: 0 });
  c.n++; if (m.quote) c.quoted++; if (m.about === 'company') c.company++;
}
console.log(`\nCLAIMS since ${SINCE}: ${notes.length} (${intel.length} intel, ${nonIntel} bookkeeping: summaries/docs/speaker links)`);
for (const [cat, c] of Object.entries(byCat).sort((a, b) => b[1].n - a[1].n))
  console.log(`  ${cat.padEnd(18)} ${String(c.n).padStart(4)}  quoted ${pct(c.quoted, c.n)}%  company-scoped ${pct(c.company, c.n)}%`);

console.log('\nBARS');
const general = byCat.general?.n ?? 0;
bar('general share under 8%', pct(general, intel.length) < 8, `${pct(general, intel.length)}%`);
for (const k of ['firmographic', 'performance']) if (byCat[k]) bar(`${k} 100% company-scoped`, pct(byCat[k].company, byCat[k].n) === 100, `${pct(byCat[k].company, byCat[k].n)}%`);
for (const k of ['risk_signal', 'expansion_signal']) if (byCat[k]) bar(`${k} quoted over 85%`, pct(byCat[k].quoted, byCat[k].n) > 85, `${pct(byCat[k].quoted, byCat[k].n)}%`);

// GET-417: the four audit findings, each expected at zero for anything written by the fixed writers.
const blobs = intel.filter(n => ['adoption', 'status_quo'].includes(n.value?.category) && !n.value?.label && !n.value?.metadata?.quote && String(n.value?.content ?? '').length > 250);
bar('no health-read paragraphs filed as facts', blobs.length === 0, `${blobs.length}`);
const sysInGeneral = intel.filter(n => /Linked this meeting/.test(String(n.value?.content ?? '')));
bar('no speaker-link bookkeeping shown as intel', sysInGeneral.length === 0, `${sysInGeneral.length}`);
const declinedNoStance = intel.filter(n => n.value?.category === 'expansion_signal' && !n.value?.metadata?.stance && /\b(declin|cancel|no need|not interested|opted out|does not want|rejected)/i.test(String(n.value?.content ?? '')));
bar('every declined expansion carries stance', declinedNoStance.length === 0, `${declinedNoStance.length} without`);
const oursByPattern = intel.filter(n => /^(I think for you|you guys|your (website|team|store)|obviously you|what we|our (tool|partnership|exclusive))/i.test(String(n.value?.metadata?.quote ?? '').trim()));
bar('no facts quoting our own side (pattern check)', oursByPattern.length === 0, `${oursByPattern.length}`);
for (const n of oursByPattern.slice(0, 5)) console.log(`      · [${n.value?.category}] ${n.value?.label ?? ''} — "${String(n.value?.metadata?.quote).slice(0, 80)}"`);

// ── tasks ─────────────────────────────────────────────────────────────────────
// The window is computed_at — when the row was WRITTEN. It cannot be last_observed_at: that is
// the date of the call or the email, so a backfill of August read in September matched nothing
// and the section passed on an empty set, which is how two Gmail batches went by unchecked.
const { data: tasksAll, error: te } = await sb.from('claims').select('entity_id, property, value').eq('workspace_id', WS)
  .gte('property', 'action_item.').lt('property', 'action_item/').is('invalid_at', null).gte('computed_at', SINCE);
if (te) { console.error('tasks read failed:', te.message); process.exit(2); }
// Every source, not just meetings. Gmail writes action_item.gmail_<thread>_<n> and was excluded
// here from the day the Gmail Read shipped.
const tasks = tasksAll ?? [];
const fromMeetings = tasks.filter(t => t.property.startsWith('action_item.meeting_')).length;
const fromGmail = tasks.filter(t => t.property.startsWith('action_item.gmail_')).length;
const has = (k) => tasks.filter(t => t.value?.[k]).length;
console.log(`\nTASKS since ${SINCE}: ${tasks.length}  (meeting ${fromMeetings} · gmail ${fromGmail})`);
for (const k of ['description', 'for_name', 'asked_by', 'source_title', 'source_url', 'occurred_at', 'owner_email', 'owner_name', 'deal_id']) console.log(`  ${k.padEnd(13)} ${has(k)}/${tasks.length}`);
const keys = new Map(); for (const t of tasks) { const k = `${t.entity_id}|${t.property}`; keys.set(k, (keys.get(k) ?? 0) + 1); }
const dupKeys = [...keys.values()].filter(n => n > 1).length;
if (tasks.length) {
  bar('every task says where it came from (title, said-on date)', has('source_title') === tasks.length && has('occurred_at') === tasks.length);
  // …and a link, where the source has one to give. The Gmail threads with no thread id are
  // grouped by subject under a hash of our own making, which deep-links to nothing; those get the
  // Gmail mark alone rather than a URL that 404s.
  const linkable = tasks.filter(t => !t.property.includes('_subj-'));
  const unlinked = linkable.filter(t => !t.value?.source_url);
  bar('every linkable source carries its link', unlinked.length === 0, `${linkable.length - unlinked.length}/${linkable.length}`);
  // A description is optional by design — provenanceFromModel drops one that only repeats the
  // title — so this is a number to read, not a bar to pass.
  console.log(`  · ${has('description')}/${tasks.length} carry a description beyond their title`);
  bar('no duplicate task keys', dupKeys === 0, `${dupKeys}`);
  // Nobody here can tick off the customer's homework (GET-424). What they owe is our chase.
  const theirs = tasks.filter(t => t.value?.owner_kind && t.value.owner_kind !== 'user');
  bar('no task owned by the customer', theirs.length === 0, `${theirs.length}`);
  for (const t of theirs.slice(0, 5)) console.log(`      · [${t.value?.owner_kind}] ${String(t.value?.title).slice(0, 80)}`);
} else {
  // Say so out loud. A section that prints nothing reads exactly like a section that passed.
  console.log('  (no task written in this window — the task bars did not run)');
}

// ── insights ──────────────────────────────────────────────────────────────────
const { count: ins } = await sb.from('insight_items').select('id', { count: 'exact', head: true }).eq('workspace_id', WS).gte('created_at', SINCE);
console.log(`\nINSIGHTS since ${SINCE}: ${ins ?? '?'}`);

console.log(misses.length ? `\n${misses.length} bar(s) missed: ${misses.join(' · ')}` : '\nall bars clear');
if (STRICT && misses.length) process.exit(1);
