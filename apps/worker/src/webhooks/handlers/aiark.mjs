// AI-Ark email-finder webhook handler.
//
// AI-Ark's POST /people/email-finder runs asynchronously and PUSHES the found
// emails to a webhook (it is webhook-only — there is no synchronous return).
// The lookalike-builder skill points that webhook at:
//   /inbound/aiark/:workspaceId/:leadListId?secret=...
// so we know which Nous lead list to write into.
//
// We pre-inserted the leads (no email) during the people-search step, so this
// handler's job is just to SET each lead's email. AI-Ark gives us the person's
// input (firstname/lastname/domain) plus the found email — we match that to a
// lead already in the list by name+domain (both came from the same AI-Ark data,
// so they align) and swap in the email identifier.
//
// The exact webhook envelope is not in AI-Ark's public docs, so extraction is
// deliberately tolerant and the raw payload is logged on the first hits.

import { getSupabaseClient } from '@nous/core';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';

const norm = (s) => (s ?? '').toString().trim().toLowerCase();
const normDomain = (d) =>
  norm(d).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

// Pull the list of per-person results out of whatever envelope AI-Ark sends.
function extractResults(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  return body.content || body.data || body.inquiries || body.results ||
    (body.input || body.output || body.address ? [body] : []);
}

// Each result carries one or more candidate emails; keep the best deliverable one.
function pickEmail(item) {
  const outs = item.output || item.emails || item.outputs || (item.address ? [item] : []);
  const found = (outs || []).filter((o) => o && o.found !== false && (o.address || o.email));
  if (!found.length) return null;
  const valid = found.find((o) => /valid/i.test(o.status || '')) || found[0];
  const email = norm(valid.address || valid.email);
  if (!email || !email.includes('@')) return null;
  return { email, status: valid.status || null, type: valid.domainType || valid.type || null };
}

export async function reprocessAiArk(supabase, workspaceId, leadListId, body) {
  const items = extractResults(body || {});
  console.log(`[AIARK_WEBHOOK] ws=${workspaceId} list=${leadListId || '-'} items=${items.length}`);
  // Temporary diagnostics: log the real envelope so we can confirm the shape +
  // whether emails are actually present. Trim later once verified.
  console.log('[AIARK_WEBHOOK] raw:', JSON.stringify(body || {}).slice(0, 1500));

  if (!items.length) {
    // Log the shape so we can confirm/adjust the parser against the real payload.
    await logSysEvent(supabase, {
      workspaceId, source: 'aiark', eventType: 'webhook_empty',
      summary: 'AI-Ark webhook with no parseable results',
      metadata: { keys: Object.keys(body || {}).slice(0, 15), sample: JSON.stringify(body || {}).slice(0, 600) },
    });
    return { skipped: 'no results' };
  }

  // Load the candidate leads in this list once, then match in memory.
  let leads = [];
  if (leadListId) {
    const { data } = await supabase
      .from('leads').select('id, name, domain')
      .eq('workspace_id', workspaceId).eq('lead_list_id', leadListId);
    leads = data || [];
  }
  const byNameDomain = new Map();
  const byName = new Map();
  for (const l of leads) {
    const nk = norm(l.name);
    if (!nk) continue;
    byNameDomain.set(`${nk}|${normDomain(l.domain)}`, l.id);
    if (!byName.has(nk)) byName.set(nk, l.id); // name-only fallback
  }

  let set = 0, noEmail = 0, noMatch = 0;
  for (const item of items) {
    const inp = item.input || item;
    const fn = norm(inp.firstname || inp.first_name || inp.firstName);
    const ln = norm(inp.lastname || inp.last_name || inp.lastName);
    const dom = normDomain(inp.domain || inp.company_domain || inp.companyDomain);
    const fullName = `${fn} ${ln}`.trim();
    const picked = pickEmail(item);
    const leadId = picked
      ? (byNameDomain.get(`${fullName}|${dom}`) || byName.get(fullName) || null)
      : null;
    console.log(`[AIARK_WEBHOOK] item name="${fullName}" dom="${dom}" email=${picked?.email || '-'} -> ${picked ? (leadId ? `lead ${leadId}` : 'NO LEAD MATCH') : 'NO EMAIL FOUND'}`);

    if (!picked) { noEmail++; continue; }
    if (!leadId) { noMatch++; continue; }

    // Set the email identifier — same swap the lead-list PATCH endpoint does:
    // retire the active email (if any), then add the found one.
    await supabase.from('entity_identifiers').update({ status: 'retired' })
      .eq('workspace_id', workspaceId).eq('entity_id', leadId)
      .eq('kind', 'email').eq('status', 'active');
    await supabase.from('entity_identifiers')
      .insert({ workspace_id: workspaceId, entity_id: leadId, kind: 'email', value: picked.email, status: 'active' })
      .then(() => {}, () => {});
    set++;
  }

  await logSysEvent(supabase, {
    workspaceId, source: 'aiark', eventType: 'emails_found',
    summary: `AI-Ark: set ${set} email${set === 1 ? '' : 's'}${noEmail ? `, ${noEmail} no-email` : ''}${noMatch ? `, ${noMatch} no-match` : ''}`,
    metadata: { lead_list_id: leadListId, set, no_email: noEmail, no_match: noMatch, category: 'enrich' },
  });
  return { set, noEmail, noMatch };
}

export async function handleAiArk(req, res, workspaceId, leadListId) {
  const supabase = getSupabaseClient();
  try {
    const result = await reprocessAiArk(supabase, workspaceId, leadListId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[AIARK_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'aiark', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
