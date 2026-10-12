// The objection matcher — clusters the recurring buyer objections captured across
// accounts into themes, and for each theme generates the ANSWER from the workspace's
// own foundations + product/positioning notes (the feature/proof that addresses it and
// how to phrase the reply). Stored in objection_handlers, read by the campaign brief
// and surfaced as recommendations. One model pass per workspace, weekly (extraction tier).

import { filterDerivedForViewer, TEAM_VIEWER } from '@nous/core';
import { meterLLM } from '../utils/meterLLM.mjs';
import { createMessage, messageText } from '../lib/llm.mjs';

const MIN_OBJECTIONS = 5;   // below this there is nothing to theme

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const SYSTEM = `You turn a list of real buyer objections into a battlecard for a GTM operator, grounded ONLY in the company context you are given. Never invent a feature, a proof, or a claim the context does not support.

Do two things:
1. Cluster the objections into at most 8 RECURRING themes. Merge ones that mean the same thing ("too expensive" and "hard to justify the spend" are one theme). Drop one-offs that don't recur.
2. For each theme, write the ANSWER — the specific feature, proof, or positioning from the company context that addresses it, and one line on how to phrase the reply. If the context genuinely does not answer it, set "answer" to a short honest note that we have no strong answer on file yet (this is a real finding, not a failure).

Rules: no colons inside sentences, no corporate cliches, tight. Ground every answer in the provided context.

Return ONLY valid JSON, this exact shape:
{"handlers":[{"title":"<the objection theme, buyer-facing>","objection_summary":"<one line, what they actually say>","answer":"<the feature/proof that answers it + how to say it>","proof":"<the single most specific thing to point to>","item_indices":[<indices of the input objections in this theme>]}]}`;

export async function buildObjectionHandlers(supabase, workspaceId) {
  // 1. The objections, with which account raised each.
  const { data: objs } = await supabase.from('claims')
    .select('entity_id, property, value, supporting_observation_ids')
    .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
    .or('value->>category.eq.objection,value->>category.eq.pain,value->>category.eq.friction')
    .limit(200);
  // Handlers are a team playbook: an objection read out of a teammate's private email doesn't go
  // into one, or its words would reach everyone (GET-253).
  const items = (await filterDerivedForViewer(supabase, workspaceId, objs ?? [], TEAM_VIEWER))
    .map((o) => ({ entity_id: o.entity_id, text: o.value?.content ?? o.value?.text ?? o.value?.summary }))
    .filter((x) => x.text);
  if (items.length < MIN_OBJECTIONS) return { handlers: 0, skipped: 'not_enough_objections' };

  // 2. The answer source — the ICP, what buyers have taught us, and our own notes.
  //
  // The positioning/product INSIGHTS are the live half: record_insight writes them
  // after every call, so they carry how we actually answer objections today. They
  // replaced the frozen `foundations.kind='positioning'` doc that used to sit here
  // (retired with the rest of the Vault-era policy layer). Note these are the
  // `insights` table, an entirely different thing from the dead foundation kind that
  // shared the word — same closed loop that feeds market-read and role-report.
  const [{ data: founds }, { data: learned }, { data: notes }] = await Promise.all([
    supabase.from('foundations').select('kind, title, body_md').eq('workspace_id', workspaceId).in('kind', ['icp']),
    supabase.from('insights').select('category, body_md').eq('workspace_id', workspaceId).in('category', ['positioning', 'product']),
    supabase.from('claims').select('property, value, supporting_observation_ids').eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
      .or('value->>category.eq.Product,value->>category.eq.Positioning,value->>category.eq.Competitors,value->>category.eq.Pricing').limit(60)
      .then(async (r) => ({ ...r, data: await filterDerivedForViewer(supabase, workspaceId, r.data ?? [], TEAM_VIEWER) })),
  ]);
  const foundText = (founds ?? []).map((f) => `## ${f.kind}: ${f.title ?? ''}\n${(f.body_md ?? '').slice(0, 1600)}`).join('\n\n');
  const learnedText = (learned ?? []).map((i) => `## what buyers taught us — ${i.category}\n${(i.body_md ?? '').slice(0, 1600)}`).join('\n\n');
  const noteText = [...new Set((notes ?? []).map((n) => n.value?.content).filter(Boolean))].slice(0, 25).map((s) => `- ${s}`).join('\n');
  const context = `${foundText}\n\n${learnedText}\n\n### Product / positioning notes\n${noteText || '(none on file)'}`.slice(0, 7000);

  // 3. One model pass — cluster + answer.
  const numbered = items.map((it, i) => `[${i}] ${it.text.slice(0, 200)}`).join('\n');
  const resp = await createMessage({
    feature: 'objection-handlers', max_tokens: 3000, system: SYSTEM,
    accept: (t) => /\{[\s\S]*\}/.test(t),
    messages: [{ role: 'user', content: `COMPANY CONTEXT (the source of every answer):\n${context}\n\nOBJECTIONS (index in brackets):\n${numbered}` }],
  });
  await meterLLM(supabase, workspaceId, 'objection-extraction', resp);
  const raw = messageText(resp).trim();
  let parsed;
  try {
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    parsed = JSON.parse(json);
  } catch {
    return { handlers: 0, error: 'parse_failed' };
  }
  const handlers = Array.isArray(parsed?.handlers) ? parsed.handlers : [];
  if (!handlers.length) return { handlers: 0 };

  // 4. Compute account counts + evidence from the assigned indices, then upsert.
  const now = new Date().toISOString();
  const seen = new Set();
  let rank = 0;
  for (const h of handlers) {
    const title = String(h.title ?? '').trim();
    if (!title) continue;
    const idxs = (Array.isArray(h.item_indices) ? h.item_indices : []).filter((i) => Number.isInteger(i) && items[i]);
    const entityIds = [...new Set(idxs.map((i) => items[i].entity_id).filter(Boolean))];
    const examples = idxs.slice(0, 4).map((i) => items[i].text.slice(0, 200));
    const dedupKey = slug(title);
    if (!dedupKey || seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Preserve status + bump version if the answer changed.
    const { data: existing } = await supabase.from('objection_handlers')
      .select('id, answer_md, status, version').eq('workspace_id', workspaceId).eq('dedup_key', dedupKey).maybeSingle();
    const answer = String(h.answer ?? '').trim();
    const changed = !existing || existing.answer_md !== answer;

    await supabase.from('objection_handlers').upsert({
      workspace_id: workspaceId,
      title,
      objection_summary: String(h.objection_summary ?? '').trim() || null,
      answer_md: answer || null,
      proof: String(h.proof ?? '').trim() || null,
      account_count: entityIds.length || idxs.length,
      evidence: { examples, entity_ids: entityIds },
      status: existing?.status === 'dismissed' ? 'dismissed' : 'open',
      dedup_key: dedupKey,
      rank: rank++,
      version: existing ? (changed ? existing.version + 1 : existing.version) : 1,
      updated_at: now,
    }, { onConflict: 'workspace_id,dedup_key' });
  }

  // Replace, don't accumulate — the LLM can reword a theme title between runs (a new
  // dedup_key), so prune any handler this run did NOT produce. Only when we actually
  // wrote a set (never on a transient parse/empty failure, which would wipe the store).
  if (seen.size) {
    const { data: allRows } = await supabase.from('objection_handlers').select('id, dedup_key').eq('workspace_id', workspaceId);
    const stale = (allRows ?? []).filter((row) => !seen.has(row.dedup_key)).map((row) => row.id);
    if (stale.length) await supabase.from('objection_handlers').delete().in('id', stale);
  }
  return { handlers: seen.size };
}
