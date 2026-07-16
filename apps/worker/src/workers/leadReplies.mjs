// The Mind — lead graduation (Adaptive Lead Scoring, 4a.3).
//
// Scans recently-logged inbound reply activities. When a reply's sender matches
// an unresolved lead, the reply's canonical signal — already computed at ingest
// (a provider's native disposition or the single classifier) — is recorded on
// the lead, and the lead is linked to the contact the reply already created
// (graduation: lead → person). Only falls back to classifying for replies that
// predate classifier consolidation.
//
// Runs as a worker cron, decoupled from webhook ingestion — it never blocks a
// webhook and touches no ingestion code. A classification failure simply
// leaves the lead unresolved for the next pass; re-scanning is idempotent
// because an already-resolved lead is skipped.
//
// See docs/adaptive-lead-scoring.md.

import { getSupabaseClient, findLeadById, findLeadByEmail, updateLead, addSuppression, listActivities, logWorkerRun, LEARNABLE_REPLY_SIGNALS, SUPPRESSING_REPLY_SIGNALS } from '@nous/core';
import { classifyReplySignal } from '../signals/replySentiment.mjs';
import { logSysEvent } from '../utils/systemLog.mjs';

// Activity types that represent an inbound reply worth learning from.
const REPLY_ACTIVITY_TYPES = [
  'email_reply', 'email_received', 'outbound_positive_reply', 'linkedin_message',
];

const BATCH = 100;
// Each pass looks back this far. Generous overlap — resolved leads are skipped,
// so a missed or failed run is recovered on the next pass with no duplication.
const LOOKBACK_HOURS = 6;

export async function processLeadReplies() {
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString();

  // Recent inbound reply activities (v2: from observations). The email join
  // moved off the FK chain — we fetch contact emails in a second pass.
  let activities = [];
  try {
    activities = await listActivities(supabase, {
      types: REPLY_ACTIVITY_TYPES,
      ingestedSince: since,
      limit: BATCH,
    });
  } catch (err) {
    console.error('[LEAD_REPLIES] scan failed:', err.message);
    return;
  }

  if (activities.length) {
    const ids = [...new Set(activities.map(a => a.contact_id))];
    const { data: contacts } = await supabase.from('contacts').select('id, email').in('id', ids);
    const emailById = new Map((contacts || []).map(c => [c.id, c.email]));
    activities = activities.map(a => ({ ...a, contacts: { email: emailById.get(a.contact_id) || null } }));
  }

  let graduated = 0;

  for (const act of activities) {
    if (!act.contact_id) continue;
    const email = act.contacts?.email;

    // Match the reply to a lead. The contact_id IS the entity id and the leads
    // view shares it, so match by id first — this works for LinkedIn-native
    // replies whose lead has no email. Fall back to email for any edge where the
    // reply resolved to a different entity than the imported lead.
    let lead;
    try {
      lead = await findLeadById(supabase, act.workspace_id, act.contact_id);
      if (!lead && email) lead = await findLeadByEmail(supabase, act.workspace_id, email);
    } catch {
      continue;
    }
    if (!lead || lead.reply_outcome) continue;

    // Reuse the signal ingest already computed — a provider's native disposition
    // or the canonical classifier — so the same reply is never classified twice.
    // Fall back to a classify only for replies that predate consolidation.
    let signal = act.raw_data?.provider_signal || act.raw_data?.reply_signal || null;
    if (!signal) {
      const text =
        act.summary || act.raw_data?.text || act.raw_data?.body || act.description || '';
      if (!text.trim()) continue;
      try {
        signal = await classifyReplySignal(text);
      } catch (e) {
        console.warn('[LEAD_REPLIES] classify failed for lead', lead.id, ':', e.message);
        continue;
      }
    }
    // Noise (auto_reply / neutral) — leave the lead unresolved, don't pollute
    // the evidence set.
    if (!signal || !LEARNABLE_REPLY_SIGNALS.includes(signal)) continue;

    // Graduate: record the signal on the lead and link it to the contact the
    // reply already created.
    try {
      await updateLead(supabase, act.workspace_id, lead.id, {
        reply_outcome: signal,
        replied_at: act.occurred_at || new Date().toISOString(),
        status: 'replied',
        contact_id: act.contact_id,
      });
      if (SUPPRESSING_REPLY_SIGNALS.includes(signal) && email) {
        await addSuppression(supabase, act.workspace_id, email, `${signal} via reply`);
      }
      graduated++;

      logSysEvent(supabase, {
        workspaceId: act.workspace_id,
        source: 'mind',
        eventType: 'lead_graduated',
        summary: `Lead reply classified: ${signal}`,
        contactId: act.contact_id,
        // Attribute the reply back to the list it came from, so per-list /
        // per-campaign reply reporting filters cleanly (category: 'reply').
        metadata: { signal, lead_id: lead.id, lead_list_id: lead.lead_list_id || null, category: 'reply' },
      }).catch(() => {});
    } catch (e) {
      console.warn('[LEAD_REPLIES] update failed for lead', lead.id, ':', e.message);
    }
  }

  if (graduated) {
    console.log(`[LEAD_REPLIES] graduated ${graduated} lead(s)`);
    await logWorkerRun(supabase, {
      worker: 'lead_replies',
      status: 'success',
      summary: `graduated ${graduated} lead(s) from ${activities.length} reply activit${activities.length === 1 ? 'y' : 'ies'}`,
      details: { graduated, activities_scanned: activities.length },
      startedAt,
    });
  }
}
