// RB2B webhook handler — receives de-anonymized website visitor data (public graph signal).

import { getSupabaseClient } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';

export async function reprocessRB2B(supabase, workspaceId, body) {
  const { email, linkedin_url, first_name, last_name, company, job_title, page_url } = body || {};

  if (!email && !linkedin_url) throw new Error('email_or_linkedin_required');

  const { contact } = await resolveContact(supabase, workspaceId, {
    email,
    first_name,
    last_name,
    linkedin_url,
    company_name: company,
    job_title,
    source: 'rb2b',
  }, { createIfMissing: !!(email || linkedin_url) });

  if (!contact) return { skipped: true };

  await logActivity(supabase, {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        'website_visit',
    source:      'rb2b',
    externalId:  `rb2b_${email || linkedin_url}_${(page_url || '').replace(/[^a-z0-9]/gi, '_').slice(0, 40) || 'visit'}`,
    description: page_url ? `Visited ${page_url}` : 'Website visit detected',
    rawData:     { page_url, linkedin_url },
  });

  await logSysEvent(supabase, {
    workspaceId, source: 'rb2b', eventType: 'webhook_received',
    summary:    `Visitor identified: ${email || linkedin_url}${page_url ? ` on ${page_url}` : ''}`,
    contactId:  contact.id,
    metadata:   { email, linkedin_url, page_url },
  });

  return { ok: true };
}

export async function handleRB2B(req, res, workspaceId) {
  const supabase = getSupabaseClient();
  try {
    const result = await reprocessRB2B(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[RB2B_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'rb2b', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
