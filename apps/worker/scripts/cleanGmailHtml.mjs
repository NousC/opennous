#!/usr/bin/env node
// Convert the HTML stored in existing Gmail rows to text (GET-249). Idempotent; plans without --apply.
//
// New email is stored as text at ingest (ingestGmail → messageBodyText). Rows filed before that hold
// Gmail's HTML in raw.body_text and a 300-character HTML preview in value.description/summary. This
// rewrites both, and recomputes content_hash so the evidence panel still verifies the stored raw.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/cleanGmailHtml.mjs            # plan
//   WS_ID=<uuid> node apps/worker/scripts/cleanGmailHtml.mjs --apply

import { getSupabaseClient, messageBodyText, looksLikeHtml, hashRaw } from '@nous/core';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
if (!WS) { console.error('WS_ID required'); process.exit(1); }
const sb = getSupabaseClient();

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('observations')
    .select('id, property, value, raw, observed_at')
    .eq('workspace_id', WS).eq('source', 'gmail').like('property', 'interaction.email_%')
    .order('observed_at', { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows.push(...(data || []));
  if (!data || data.length < 1000) break;
}

let changed = 0, skipped = 0;
for (const r of rows) {
  const raw = r.raw || {};
  const value = r.value || {};
  const bodyHtml = looksLikeHtml(raw.body_text);
  const previewHtml = looksLikeHtml(value.description) || looksLikeHtml(value.summary) || /&#\d+;|&[a-z]+;/i.test(String(value.summary ?? ''));
  if (!bodyHtml && !previewHtml) { skipped++; continue; }

  const source = raw.body_text || value.summary || value.description || '';
  const body = messageBodyText(source);
  const preview = (messageBodyText(source, { preview: true }) || body).slice(0, 300) || null;
  const nextRaw = bodyHtml ? { ...raw, body_text: body } : raw;
  // The summary is always the body preview. The description is replaced only when it WAS the body
  // (HTML itself, or the same text as the summary) — a subject line ("Re: Q3 invoice",
  // "Email sent: <subject>") stays exactly as it is.
  const descriptionWasBody = looksLikeHtml(value.description) || (value.description != null && value.description === value.summary);
  const nextValue = preview ? {
    ...value,
    ...(value.summary != null ? { summary: preview } : {}),
    ...(descriptionWasBody ? { description: preview } : {}),
  } : value;

  changed++;
  if (changed <= 8) console.log(`  ${r.observed_at.slice(0, 16)} ${r.property.replace('interaction.', '')}: "${String(value.description ?? '').slice(0, 50)}" → "${String(nextValue.description ?? '').slice(0, 60)}"`);
  if (!APPLY) continue;
  const patch = { value: nextValue, raw: nextRaw };
  if (nextRaw !== raw) patch.content_hash = hashRaw(nextRaw);
  const { error } = await sb.from('observations').update(patch).eq('id', r.id).eq('workspace_id', WS);
  if (error) console.log('  update failed', r.id, error.message);
}
console.log(`\n${rows.length} Gmail rows: ${changed} with HTML ${APPLY ? 'cleaned' : 'to clean'}, ${skipped} already text.${APPLY ? '' : ' Plan only — rerun with --apply.'}`);
process.exit(0);
