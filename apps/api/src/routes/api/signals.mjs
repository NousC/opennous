import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { getSupabaseClient, logActivity, hasActivityWithExternalId } from '@nous/core';
import { resolveContact } from '../../services/enrichment.mjs';

export const signalsRouter = Router();
export const publicSignalsRouter = Router();

function signalToken(workspaceId) {
  const secret = process.env.SIGNAL_HMAC_SECRET || 'nous-signals';
  return createHmac('sha256', secret).update(workspaceId).digest('hex').slice(0, 32);
}

// GET /api/signals/webhook-url
signalsRouter.get('/webhook-url', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

    const token = signalToken(workspaceId);
    const base = process.env.VITE_API_URL || process.env.APP_URL || 'http://localhost:3000';

    return res.json({
      token,
      workspace_id: workspaceId,
      url: `${base}/api/public/signals/ingest`,
      rb2b_example: {
        url: `${base}/api/public/signals/ingest`,
        method: 'POST',
        body: { workspace_id: workspaceId, token, source: 'rb2b', email: '{{email}}', first_name: '{{first_name}}', last_name: '{{last_name}}', company: '{{company}}', page: '{{page}}' },
      },
      signalbase_example: {
        url: `${base}/api/public/signals/ingest`,
        method: 'POST',
        body: { workspace_id: workspaceId, token, source: 'signalbase', company_name: '{{company_name}}', domain: '{{domain}}' },
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/public/signals/ingest — no auth, per-workspace HMAC token
// Accepts RB2B and Signalbase webhook payloads and logs them as contact_activity_log entries.
publicSignalsRouter.post('/ingest', async (req, res) => {
  res.json({ ok: true }); // respond immediately — external services retry on timeout

  try {
    const { workspace_id: workspaceId, token, source } = req.body;
    if (!workspaceId || !token) return;

    const expected = signalToken(workspaceId);
    let valid = false;
    try {
      valid = token.length === expected.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    } catch { return; }
    if (!valid) {
      console.warn('[SIGNALS_INGEST] invalid token for workspace', workspaceId);
      return;
    }

    const supabase = getSupabaseClient();

    if (source === 'rb2b') {
      const { email, first_name, last_name, company, page, linkedin_url, job_title } = req.body;
      if (!email && !linkedin_url) return;

      const { contact } = await resolveContact(supabase, workspaceId, {
        email, first_name, last_name, linkedin_url, company_name: company, job_title, source: 'rb2b',
      }, { createIfMissing: true });
      if (!contact) return;

      const pageSlug = (page || 'visit').replace(/[^a-z0-9]/gi, '_').slice(0, 30);
      const externalId = `rb2b_${(email || linkedin_url).replace(/[^a-z0-9@.]/gi, '_')}_${pageSlug}`;
      if (await hasActivityWithExternalId(supabase, workspaceId, 'rb2b', externalId)) return;

      await logActivity(supabase, {
        workspaceId,
        contactId:   contact.id,
        companyId:   contact.company_id || null,
        type:        'website_visit',
        source:      'rb2b',
        externalId,
        occurredAt:  new Date().toISOString(),
        description: page ? `Visited ${page}` : 'Website visit detected',
      });
      console.log(`[SIGNALS_INGEST] rb2b website_visit — contact=${contact.id}`);

    } else if (source === 'signalbase') {
      const { company_name, domain, page } = req.body;
      if (!company_name && !domain) return;

      const normalDomain = domain?.replace(/^www\./, '').toLowerCase().trim() || null;
      let companyId = null;

      if (normalDomain) {
        const { data: co } = await supabase.from('companies').select('id')
          .eq('workspace_id', workspaceId).eq('domain', normalDomain).maybeSingle();
        companyId = co?.id || null;
        if (!companyId && company_name) {
          const { data: newCo } = await supabase.from('companies')
            .insert({ workspace_id: workspaceId, name: company_name, domain: normalDomain })
            .select('id').single();
          companyId = newCo?.id || null;
        }
      } else if (company_name) {
        const { data: co } = await supabase.from('companies').select('id')
          .eq('workspace_id', workspaceId).ilike('name', company_name).maybeSingle();
        companyId = co?.id || null;
      }
      if (!companyId) return;

      const domainKey = normalDomain || company_name.replace(/\s/g, '_').toLowerCase();
      const externalId = `signalbase_${domainKey}_${new Date().toISOString().slice(0, 10)}`;
      if (await hasActivityWithExternalId(supabase, workspaceId, 'signalbase', externalId)) return;

      // Company-scoped event — attach to the company entity directly.
      await logActivity(supabase, {
        workspaceId,
        contactId:   companyId,         // entityId fallback
        entityId:    companyId,
        type:        'website_visit',
        source:      'signalbase',
        externalId,
        occurredAt:  new Date().toISOString(),
        description: page
          ? `${company_name || domain} visited ${page}`
          : `Company website visit: ${company_name || domain}`,
      });
      console.log(`[SIGNALS_INGEST] signalbase website_visit — company=${companyId}`);

    } else {
      console.log(`[SIGNALS_INGEST] unhandled source: ${source}`);
    }
  } catch (e) {
    console.error('[SIGNALS_INGEST]', e.message);
  }
});
