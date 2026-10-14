import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import {
  getSupabaseClient, logActivity, hasActivityWithExternalId,
  revboxMembership, listCustomSignals, saveCustomSignal, archiveCustomSignal, reprocessCustomSignal, customSignalHits, signalCatalog, SIGNAL_GROUPS,
} from '@nous/core';
import { requireFeature } from '../../lib/access.mjs';
import { revboxCreditGate } from '../../lib/revboxRuntime.mjs';
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

// ─── Workspace signals (GET-862) ─────────────────────────────────────────────────────────────
// What can start a RevBox job, and the workspace's own custom signals. A custom signal belongs to
// the workspace (Settings > Signals), not to a RevBox. Same membership and owner rules as the
// older /api/revboxes/signals routes, which stay for the box page.
//
// These share /api/signals with the webhook-url route above, so this router is mounted FIRST and
// guards each of its own routes (auth, then the revboxes feature): a path it does not own, like
// /webhook-url, falls through to signalsRouter untouched.
//
//   GET  /api/signals/catalog          { builtin: [entry], custom: [entry], groups }   (signalCatalog in core)
//   GET  /api/signals                  { signals: [definition + archived] }
//   POST /api/signals                  { signal }   create; revbox_id optional ("proposed in")
//   PUT  /api/signals/:id              { signal }   edit, review, activate (owner, version-checked)
//   POST /api/signals/:id/archive      { signal }   retire: inactive, key never reused
//   POST /api/signals/:id/reprocess    { signal }   credit-gated, like the box route

const SIGNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The router with its collaborators injectable, so the tests run it without a database or plan. */
export function makeWorkspaceSignalsRouter({ getSb = getSupabaseClient, guards = [verifySupabaseAuth, requireFeature('revboxes')], creditGate = revboxCreditGate } = {}) {
  const router = Router();
  const route = (fn) => [...guards, async (req, res) => {
    try {
      if (!req.workspaceId || !req.internalUserId) return res.status(400).json({ error: 'Workspace and signed-in member are required.' });
      if (req.params.id && !SIGNAL_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid identifier.' });
      const sb = getSb();
      await revboxMembership(sb, req.workspaceId, req.internalUserId);
      await fn(req, res, sb);
    } catch (e) {
      if (e.code === '42P01' || e.code === 'PGRST205' || ((e.code === '42703' || e.code === 'PGRST204') && /archived_at|\bkey\b|sources/.test(e.message ?? ''))) return res.status(409).json({ error: 'The workspace signals migration has not been applied.' });
      if (!e.status) console.error('[signals]', e);
      res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Could not save or load the signal.' });
    }
  }];
  router.get('/catalog', ...route(async (req, res, sb) => {
    const custom = await listCustomSignals(sb, req.workspaceId, req.internalUserId);
    res.json({ ...signalCatalog({ custom }), groups: SIGNAL_GROUPS });
  }));
  router.get('/', ...route(async (req, res, sb) => {
    const signals = await listCustomSignals(sb, req.workspaceId, req.internalUserId);
    const hits = await customSignalHits(sb, req.workspaceId, signals.slice(0, 100).map(s => s.id));
    res.json({ signals: signals.map(s => ({ ...s, hits: hits[s.id] ?? null })) });
  }));
  router.post('/', ...route(async (req, res, sb) => res.status(201).json({ signal: await saveCustomSignal(sb, req.workspaceId, req.internalUserId, req.body ?? {}) })));
  router.put('/:id', ...route(async (req, res, sb) => res.json({ signal: await saveCustomSignal(sb, req.workspaceId, req.internalUserId, req.body ?? {}, req.params.id) })));
  router.post('/:id/archive', ...route(async (req, res, sb) => res.json({ signal: await archiveCustomSignal(sb, req.workspaceId, req.internalUserId, req.params.id) })));
  router.post('/:id/reprocess', ...route(async (req, res, sb) => {
    await creditGate(sb, req.workspaceId);
    res.json({ signal: await reprocessCustomSignal(sb, req.workspaceId, req.internalUserId, req.params.id, req.body?.since) });
  }));
  return router;
}
export const workspaceSignalsRouter = makeWorkspaceSignalsRouter();
