#!/usr/bin/env node
// Emails filed before GET-277 kept the whole quoted thread (Gmail replies, HubSpot email bodies),
// so one timeline row printed four people's messages and extraction read the same conversation
// once per reply. This rewrites those rows to hold THIS message only.
//
// What it touches, per email observation: `value.summary` / `value.description` (the preview) and
// `raw.text` / `raw.body_text` / `raw.body` (what extraction reads), plus `raw.quoted_chars` so the
// row still says history was there. Nothing else is altered, and every other email in the thread is
// its own row — so nothing is lost.
//
// Idempotent: a row whose text carries no quote is left untouched.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/repairQuotedEmails.mjs            # plan only
//   WS_ID=<uuid> node apps/worker/scripts/repairQuotedEmails.mjs --apply

import { getSupabaseClient, splitMessage } from '@nous/core';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const supabase = getSupabaseClient();
const PAGE = 500;
let from = 0, seen = 0, changed = 0, chars = 0;
const samples = [];

for (;;) {
  const { data, error } = await supabase.from('observations')
    .select('id, property, value, raw')
    .eq('workspace_id', WS)
    .like('property', 'interaction.email%')
    .order('id')
    .range(from, from + PAGE - 1);
  if (error) throw error;
  const rows = data ?? [];
  for (const r of rows) {
    seen++;
    const raw = r.raw ?? {};
    // The longest text on the row is the one that still holds the thread.
    const source = [raw.text, raw.body_text, raw.body, r.value?.description, r.value?.summary]
      .filter((v) => typeof v === 'string')
      .sort((a, b) => b.length - a.length)[0];
    if (!source) continue;
    const { written, quotedChars } = splitMessage(source);
    if (!quotedChars) continue;                       // nothing quoted: already clean
    changed++; chars += quotedChars;
    if (samples.length < 3) samples.push({ id: r.id, kept: written.slice(0, 80), dropped: quotedChars });
    if (!APPLY) continue;
    const value = { ...(r.value ?? {}) };
    if (typeof value.summary === 'string') value.summary = written.slice(0, 300) || null;
    if (typeof value.description === 'string') value.description = written.slice(0, 300) || null;
    const nextRaw = { ...raw, quoted_chars: quotedChars };
    for (const k of ['text', 'body_text', 'body']) {
      if (typeof raw[k] === 'string') nextRaw[k] = written.slice(0, 20_000) || null;
    }
    const { error: upErr } = await supabase.from('observations').update({ value, raw: nextRaw }).eq('id', r.id);
    if (upErr) console.warn('update failed', r.id, upErr.message);
  }
  if (rows.length < PAGE) break;
  from += PAGE;
}

console.log(JSON.stringify({ workspace: WS, emails: seen, with_quoted_thread: changed, quoted_chars_dropped: chars, samples, applied: APPLY }, null, 2));
if (!APPLY) console.log('Plan only. Re-run with --apply to rewrite.');
