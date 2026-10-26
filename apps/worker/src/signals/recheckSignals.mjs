// The deal signals already on file, read again in context (GET-1034).
//
// signalCheck.mjs checks each new conversation's deal signals before they are filed. Everything
// filed before it was read line by line with no account context, so an account can carry a customer's
// own bot as a competitor and "no tool is a silver bullet" as an objection. This runs the same check
// over an account's open deal signals, grouped by the conversation they came from, with that
// conversation's text and the account brief.
//
// A signal found wrong is never edited in place: it is retired, and the corrected one filed beside it
// with the same date and evidence, so the account's history reads "was … → now …" and the old event
// leaves the feed (GET-1032). One found to be no signal at all is retired as misread.
//
// COST. One short call per conversation that has open deal signals on the account. Run on demand.
import { listAccountNotes, retireNote, saveNote, teamReadContext } from '@nous/core';
import { checkSignals, CHECKED, CODE_CHIPS } from './signalCheck.mjs';
import { loadAccountBrief } from './accountBrief.mjs';
import { loadSourceText, loadOurSide } from './extractionText.mjs';
import { meterLLM } from '../utils/meterLLM.mjs';

const TAGS = ['entity', 'stance', 'tool', 'status', 'hardness', 'role', 'product', 'severity'];

/** A note as the checker reads a fact. Pure. */
export function noteAsFact(n) {
  const meta = n.metadata ?? {};
  const f = { id: n.id, category: n.category, label: n.label ?? null, content: n.content, quote: meta.quote ?? null };
  for (const k of TAGS) if (meta[k] != null) f[k] = meta[k];
  return f;
}

/** What changed between a note and its checked fact: null when nothing did. A chip the code builds
 *  from the tags (competitor, tech_stack, budget, authority) is not a change of its own. Pure. */
export function rewriteOf(n, f) {
  if (!f) return null;
  const meta = n.metadata ?? {};
  const sameChip = CODE_CHIPS.has(f.category) || (f.label ?? null) === (n.label ?? null);
  const same = f.category === n.category && f.content === n.content && sameChip
    && TAGS.every(k => (f[k] ?? null) === (meta[k] ?? null));
  return same ? null : f;
}

/** Re-check one account's open deal signals. Returns { checked, rewritten, retired }. */
export async function recheckAccount(supabase, workspaceId, companyId, { dryRun = true, log = console.log } = {}) {
  const { data: people } = await supabase.from('entity_list_rows').select('entity_id')
    .eq('workspace_id', workspaceId).eq('kind', 'person').eq('company_id', companyId).limit(200);
  const notes = await listAccountNotes(supabase, workspaceId, companyId, (people ?? []).map(p => p.entity_id), { limit: 400 }, teamReadContext(workspaceId));
  // A signal this pass or the live check already wrote is not read again: a re-run costs nothing.
  const open = notes.filter(n => CHECKED.has(n.category) && !n.superseded_by && n.source === 'signal_extraction' && !n.metadata?.checked);
  const out = { checked: open.length, rewritten: 0, retired: 0 };
  if (!open.length) return out;
  const { data: acct } = await supabase.from('entity_list_rows').select('name').eq('workspace_id', workspaceId).eq('entity_id', companyId).maybeSingle();
  const name = acct?.name ?? companyId;
  const brief = await loadAccountBrief(supabase, workspaceId, { companyId });
  const ourSide = await loadOurSide(supabase, workspaceId, {});

  // By the conversation they came from: one call, with that conversation's text. An email thread's
  // claim lists every message of the thread, so the whole thread is read, in order.
  const groups = new Map();
  for (const n of open) {
    const k = n.metadata?.source_ref ?? n.supporting_observation_ids?.[0] ?? 'none';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  for (const group of groups.values()) {
    const ids = [...new Set(group.flatMap(n => n.supporting_observation_ids ?? []))].filter(id => /^[0-9a-f-]{36}$/.test(id)).slice(0, 60);
    let text = '';
    if (ids.length) {
      const { data: obs } = await supabase.from('observations').select('workspace_id, property, source, raw, value, observed_at')
        .eq('workspace_id', workspaceId).in('id', ids);
      const sorted = (obs ?? []).sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)));
      const texts = [];
      for (const o of sorted) { const t = await loadSourceText(supabase, o); if (t) texts.push(t); }
      text = texts.join('\n---\n');
    }
    const facts = group.map(noteAsFact);
    const checked = await checkSignals(facts, {
      text: text || '(the conversation is no longer on file; judge from the quote and the account context)',
      brief, offer: ourSide?.offer, label: name,
      onCall: (msg) => meterLLM(supabase, workspaceId, 'signal-recheck', msg),
    });
    const byId = new Map(checked.map(f => [f.id, f]));
    for (const n of group) {
      const f = byId.get(n.id);
      if (!f) {
        out.retired++;
        log(`[RECHECK] ${name}: retire [${n.category}] "${n.label ?? ''}" — ${n.content.slice(0, 90)}`);
        if (!dryRun) await retireNote(supabase, workspaceId, n.id, null, 'misread', 'not a deal signal once read in context');
        continue;
      }
      const next = rewriteOf(n, f);
      if (!next) continue;
      out.rewritten++;
      log(`[RECHECK] ${name}: [${n.category}] "${n.label ?? ''}" → [${next.category}] "${next.label ?? ''}" — ${next.content.slice(0, 110)}`);
      if (dryRun) continue;
      const meta = { ...(n.metadata ?? {}) };
      for (const k of TAGS) delete meta[k];
      for (const k of TAGS) if (next[k] != null) meta[k] = next[k];
      const saved = await saveNote(supabase, workspaceId, {
        entityId: n.entity_id, category: next.category, content: next.content, label: next.label ?? undefined,
        source: 'signal_extraction', metadata: { ...meta, checked: 'rewritten' },
        supportingObservationIds: n.supporting_observation_ids ?? [], confidence: n.confidence, saidAt: n.said_at ?? null,
      });
      if (saved) await retireNote(supabase, workspaceId, n.id, saved.id, 'misread', 'read again in context');
    }
  }
  return out;
}
