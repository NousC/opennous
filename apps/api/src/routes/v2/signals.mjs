import { Router } from 'express';
import { getSupabaseClient, getOrCreateEntity, detectIdentifier } from '@nous/core';
import { extractAndRecordWebsiteSignals } from '../../services/websiteSignals.mjs';

export const signalsV2Router = Router();

// POST /v2/signals/website — scrape a company's site, extract GTM signals, and
// record them on the entity (so they flow into scoring + contrastive discovery).
// Body: { focus, domain? }
//   focus  — who to attach the signals to (domain | email | entity UUID)
//   domain — optional explicit website to scrape; defaults to the entity's domain
signalsV2Router.post('/website', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { focus, domain } = req.body ?? {};
    if (!focus) return res.status(400).json({ error: 'focus_required' });

    const ident = detectIdentifier(String(focus));
    if (!ident) return res.status(400).json({ error: 'invalid_focus' });

    let entityId, site = domain ? String(domain) : null;
    if (ident.kind === 'entity_id') {
      entityId = ident.value;
    } else if (ident.kind === 'domain') {
      entityId = await getOrCreateEntity(supabase, workspaceId, 'company', [{ kind: 'domain', value: ident.value }]);
      site = site || ident.value;
    } else {
      entityId = await getOrCreateEntity(supabase, workspaceId, 'person', [{ kind: ident.kind, value: ident.value }]);
    }

    // Derive the website from the entity's domain identifier if not given.
    if (!site && entityId) {
      const { data } = await supabase
        .from('entity_identifiers')
        .select('value').eq('entity_id', entityId).eq('kind', 'domain').eq('status', 'active')
        .limit(1).maybeSingle();
      site = data?.value || null;
    }
    if (!site) return res.status(400).json({ error: 'no_domain', detail: 'provide a domain to scrape' });

    const result = await extractAndRecordWebsiteSignals(supabase, workspaceId, entityId, site);
    if (!result) return res.status(502).json({ error: 'could_not_read_site', domain: site });

    return res.status(201).json({ entity_id: entityId, domain: site, recorded: result.recorded, signals: result.signals });
  } catch (err) {
    console.error('[POST /v2/signals/website]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
