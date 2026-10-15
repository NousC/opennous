// The email voice of a box's built-in drafters (GET-902). Before this, the voice was fixed in code:
// the after-call follow-up's email followed one line of its prompt (core followUps.ts
// buildFollowUpPrompt: "under 150 words, warm and specific: thank them, recap what was agreed, ...")
// and the detectors' drafts followed the house rules every email draft shares (EMAIL_DRAFT_SYSTEM:
// 50 to 90 words, no preamble, one next step, no colons or em dashes) plus the sender's own
// directives. Nobody could change either.
//
// Now the voice is a context library file (GET-875), "Email voice" (kind 'instructions'), tagged to
// the box that holds the built-in. ensureBoxEmailVoice adds it, idempotently, seeded with the voice
// the drafter used until now; the drafters read it (builtinEmailVoices) and follow it for new drafts.
// People edit it like any context file (the box's context sheet, GET-895; the library), or ask the
// built-in's chat to change it ("more concise", "more formal"). Drafts already written stay as they are.
import { builtinJobsOf } from './revboxes.mjs';
import { missingLibrary, revboxContextRows } from './contextLibrary.mjs';

export const EMAIL_VOICE_TITLE = 'Email voice';
/** The built-ins that draft emails: every one of them today (the follow-up and the four detectors). */
export const EMAIL_DRAFTING_BUILTINS = ['sales_follow_up', 'stale_deal', 'deal_signals', 'deal_risk', 'expansion'];

const HOW = 'How the emails this box drafts should read. Edit it to change the voice of new drafts (more concise, more formal, more relaxed); drafts already written stay as they are.';

/** The after-call follow-up's voice until GET-902 (its prompt's email line), as an editable file. */
export const FOLLOW_UP_EMAIL_VOICE = `${HOW}

- Warm and specific, in plain words. It reads like you wrote it yourself.
- Thank them, recap what was agreed, and state the next steps with owners and dates when known.
- Under 150 words, plain text.
- Signed with your name.`;

/** The detectors' voice until GET-902 (the style rules of the shared email-draft brief), as an editable file. */
export const DETECTOR_EMAIL_VOICE = `${HOW}

- Human, warm and specific. It reads like you typed it yourself, never templated.
- Concise: 50 to 90 words, never more than 120, at most two short paragraphs.
- Only what moves the deal forward. No recap of the whole conversation.
- No preamble ("I hope you're well"), no filler, a one-word sign-off.
- End with one clear next step.
- No colons, no em dashes, no corporate cliches (circle back, touch base, synergy).`;

/** The voice a new "Email voice" file starts with: the follow-up's when the box holds it, else the detectors'. Pure. */
export function emailVoiceSeed(keys) {
  return (Array.isArray(keys) ? keys : []).includes('sales_follow_up') ? FOLLOW_UP_EMAIL_VOICE : DETECTOR_EMAIL_VOICE;
}

/** Is this context row the box's email voice? An instructions file titled "Email voice" (any case). Pure. */
export const isEmailVoiceFile = (f) => !!f && (f.kind ?? 'instructions') === 'instructions' && String(f.title ?? '').trim().toLowerCase() === EMAIL_VOICE_TITLE.toLowerCase();

/** The email-drafting built-ins a box holds. Pure. */
export const emailDraftingBuiltins = (box) => builtinJobsOf(box).filter(k => EMAIL_DRAFTING_BUILTINS.includes(k));

export { emailVoiceBlock } from '../services/emailVoiceBlock.mjs';

async function rows(q) { const { data, error } = await q; if (error) throw error; return data ?? []; }
async function one(q) { const { data, error } = await q; if (error) throw error; return data; }
const oldest = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * Make sure a box that holds an email-drafting built-in has its "Email voice" file (GET-902):
 * a library file of kind 'instructions', visible to the box's people, owned by the box's owner and
 * tagged to the box, seeded with the voice the drafter used until now. Idempotent: a box that has
 * one (any instructions file titled "Email voice") is left alone, whatever its text. Two calls at
 * once can each make one; the oldest stays and the later one is removed. Never touches a box
 * without such a built-in. -> { id, body, created } | null (no such built-in, or the library tables
 * are not there yet).
 */
export async function ensureBoxEmailVoice(sb, ws, box) {
  const keys = emailDraftingBuiltins(box);
  if (!box?.id || !keys.length) return null;
  try {
    const have = (await revboxContextRows(sb, ws, box.id)).filter(isEmailVoiceFile);
    if (have.length) { const f = have.sort(oldest)[0]; return { id: f.id, body: f.body ?? '', created: false }; }
    const owner = box.owner_id ?? null;
    const file = await one(sb.from('workspace_context_files').insert({
      workspace_id: ws, created_by: owner, updated_by: owner, title: EMAIL_VOICE_TITLE, kind: 'instructions', body: emailVoiceSeed(keys), visibility: 'boxes',
    }).select('id, title, kind, body, created_at').single());
    await rows(sb.from('revbox_context_links').upsert({ revbox_id: box.id, context_file_id: file.id, workspace_id: ws, created_by: owner }, { onConflict: 'revbox_id,context_file_id', ignoreDuplicates: true }));
    // A concurrent call may have added one too: the oldest stays.
    const now = (await revboxContextRows(sb, ws, box.id)).filter(isEmailVoiceFile).sort(oldest);
    if (now.length > 1 && now[0].id !== file.id) {
      await rows(sb.from('revbox_context_links').delete().eq('workspace_id', ws).eq('revbox_id', box.id).eq('context_file_id', file.id));
      await rows(sb.from('workspace_context_files').delete().eq('workspace_id', ws).eq('id', file.id));
      return { id: now[0].id, body: now[0].body ?? '', created: false };
    }
    return { id: file.id, body: file.body ?? '', created: true };
  } catch (e) {
    if (missingLibrary(e)) return null;
    throw e;
  }
}

/**
 * Each email-drafting built-in's voice, for the drafters (GET-902): Map(key -> { text, file_id,
 * box_id }) from the box that holds the built-in and its "Email voice" file. A built-in in no box,
 * or a box without the file (or the library or built-in columns not migrated), has no entry: the
 * drafter then writes as it always did. A linked document's voice is its current text. Three reads,
 * once per drafting pass, never per draft.
 */
export async function builtinEmailVoices(sb, ws) {
  const out = new Map();
  let boxes;
  try { boxes = await rows(sb.from('revboxes').select('id, builtin_jobs').eq('workspace_id', ws)); }
  catch (e) { if (['42703', 'PGRST204'].includes(e?.code) || /builtin_jobs/.test(e?.message ?? '')) return out; throw e; }
  const holding = boxes.filter(b => emailDraftingBuiltins(b).length);
  if (!holding.length) return out;
  let links, files;
  try {
    links = await rows(sb.from('revbox_context_links').select('revbox_id, context_file_id, created_at').eq('workspace_id', ws).in('revbox_id', holding.map(b => b.id)));
    const ids = [...new Set(links.map(l => l.context_file_id))];
    files = ids.length ? await rows(sb.from('workspace_context_files').select('id, title, kind, body, document_id, created_at').eq('workspace_id', ws).in('id', ids)) : [];
  } catch (e) { if (missingLibrary(e)) return out; throw e; }
  const voices = new Map(files.filter(isEmailVoiceFile).map(f => [f.id, f]));
  const docIds = [...voices.values()].map(f => f.document_id).filter(Boolean);
  const docs = docIds.length ? new Map((await rows(sb.from('documents').select('id, body_md, status').eq('workspace_id', ws).in('id', docIds))).filter(d => d.status !== 'deleted').map(d => [d.id, d.body_md ?? ''])) : new Map();
  for (const b of holding) {
    const f = links.filter(l => l.revbox_id === b.id && voices.has(l.context_file_id)).map(l => voices.get(l.context_file_id)).sort(oldest)[0];
    if (!f) continue;
    const text = String(f.document_id ? docs.get(f.document_id) ?? '' : f.body ?? '').trim();
    if (!text) continue;
    for (const key of emailDraftingBuiltins(b)) if (!out.has(key)) out.set(key, { text, file_id: f.id, box_id: b.id });
  }
  return out;
}
