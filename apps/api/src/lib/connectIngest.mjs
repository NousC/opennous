// What connecting a source actually means.
//
// Connecting a CRM and importing from it were two separate steps, and the second one had no
// caller. `POST /api/crm/onboarding-sync` was the wizard's button; the wizard was deleted and
// the route stayed, orphaned. So from the day onboarding became a conversation, connecting
// HubSpot read its stages live, said "connected", and imported nothing — ever. Not on a
// nightly either: that route was also what wrote the `crm_sync_configs` row, and the auto-sync
// worker only visits workspaces that have one. A test workspace sat on four verified
// connections and zero accounts.
//
// So the import is not a step anyone can forget any more. Connecting a CRM *is* importing it,
// in one function, called from the connect path itself. One source of truth for "did we pull
// this in", which is the fix for the class of bug, not just this instance.
//
// Order matters and it is the order below:
//
//   1. stages    so the board speaks their language before any record lands in it
//   2. records   contacts, companies, deals
//   3. config    the row the nightly auto-sync reads, written only after a pull worked
//   4. backfill  enrich those accounts with history from every OTHER connected source
//
// Everything is best-effort and nothing here may fail the connect: a person who just pasted a
// valid API key has connected the tool, whatever the import then does.

import { backfillOwnerFor } from './backfillStart.mjs';
import { getSupabaseClient, syncCrmProvider, adoptCrmStages, writePrimaryPipelineRef, hubspotImportScope, settleClaimQueue, hasLearnedIcpScorer, salesforceAccess } from '@nous/core';
import { runClosedDeals } from './closedDealsRecord.mjs';
import { decrypt } from '../providers/crypto.mjs';
import { enqueueWorkspaceHistoryBackfill } from './historyBackfill.mjs';

// Train the ICP model on the CRM's REAL outcomes. The sync reports every decided deal it
// saw (domain, amount, close date, won/lost); this hands the most recent ones to the same
// closed-deals trainer the web "Add deals" flow uses, so "their sharpened ICP" comes from
// their own history rather than a form. Fire-and-forget and capped at what the trainer
// accepts (40); a re-sync only surfaces deals modified since, so it trains incrementally.
// Training is the learned ICP scorer's (Cloud, GET-754 slice 8); without it there is nothing to
// train, and the sync has already written the deals' outcomes itself.
export async function trainFromSyncedDeals(supabase, workspaceId, result, trigger) {
  if (!hasLearnedIcpScorer()) return;
  const decided = result?.closedDeals ?? [];
  if (!decided.length) return;
  const newest = [...decided].sort((a, b) => String(b.closedAt ?? '').localeCompare(String(a.closedAt ?? ''))).slice(0, 40);
  const won = newest.filter(d => d.disposition === 'won');
  const lost = newest.filter(d => d.disposition === 'lost');
  try {
    const r = await runClosedDeals(supabase, workspaceId, { won, lost });
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source: 'icp', event_type: 'icp_trained_from_crm',
      summary: `Trained the ICP model on ${won.length} won + ${lost.length} lost CRM deal(s)`,
      metadata: { trigger, won: won.length, lost: lost.length, result: r },
    }).then(() => {}, () => {});
  } catch (e) {
    console.error('[crm/train-closed-deals]', e?.message || e);
  }
}

// Adopt the CRM's stage vocabulary as the workspace's own, right after a pull. Deterministic
// and non-destructive (see adoptCrmStages): their labels verbatim, won/lost from the
// provider's flags, and a hand-edited set is never overwritten. Fire-and-forget: stage
// adoption failing must never fail the sync that triggered it.
export async function adoptStagesAfterSync(supabase, workspaceId, provider, token, trigger) {
  try {
    const saved = await adoptCrmStages(supabase, workspaceId, provider, token);
    if (!saved) return;
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source: provider, event_type: 'stages_adopted',
      summary: `Adopted ${saved.length} pipeline stages from ${provider}: ${saved.map(s => s.label).join(' → ')}`,
      metadata: { trigger, stages: saved },
    }).then(() => {}, () => {});
  } catch (e) {
    console.error('[crm/adopt-stages]', provider, e?.message || e);
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source: provider, event_type: 'stages_adopt_failed',
      summary: `${provider}: could not adopt pipeline stages — ${e?.message || e}`,
      metadata: { trigger, error: String(e?.message || e) },
    }).then(() => {}, () => {});
  }
}

/** Providers whose connect starts live ingest only — no history, no workspace backfill. */
// PostHog (GET-751): its own history is the usage pull (pollers/posthog.mjs, within the hour of a
// connect), and its users are not conversations for the backfill to look for.
const LIVE_ONLY_ON_CONNECT = new Set(['fellow', 'ringcentral', 'posthog']);

const DAY = 86400000;
/** How far back a connect-time CRM import reaches: accounts touched inside this, and their conversations. */
const IMPORT_MONTHS = 12;
/**
 * Above this many accounts, the history backfill is NOT started by the connect (GET-281). That job
 * re-scans every other connected source for up to 2000 accounts and spends model credits on what it
 * finds; on a CRM-sized portal that is a bill nobody asked for. It is logged instead, and run
 * deliberately. A small workspace keeps the old one-click behaviour.
 */
const BACKFILL_ON_CONNECT_MAX_ACCOUNTS = 500;

/** The providers `syncCrmProvider` can actually pull. Salesforce since GET-853. */
const CRM_PROVIDERS = new Set(['hubspot', 'pipedrive', 'attio', 'salesforce']);

export function isCrmProvider(name) {
  return CRM_PROVIDERS.has(String(name || '').toLowerCase());
}

/** The credential field each CRM's token lives in, falling back to whatever was stored. */
function tokenFor(provider, creds) {
  const first = Object.values(creds).find(Boolean);
  if (provider === 'hubspot')   return creds.access_token || creds.api_key   || first;
  if (provider === 'pipedrive') return creds.api_token    || creds.api_key   || first;
  if (provider === 'attio')     return creds.api_key      || creds.access_token || first;
  return first;
}

function log(supabase, workspaceId, source, eventType, summary, metadata) {
  return supabase.from('workspace_system_log').insert({
    workspace_id: workspaceId, source, event_type: eventType, summary,
    metadata: metadata || {}, occurred_at: new Date().toISOString(),
  }).then(() => {}, () => {});
}

// THE IMPORT AS A JOB THE OWNER CAN SEE (GET-853). A connect-time import takes minutes to hours
// on a real portal, runs in this process, and used to say nothing until it finished: a failed
// scope call or a restart mid-pull left "Importing your accounts…" spinning forever. Its own log
// rows already mark every step; crmImportStatus reads the newest one back as running, failed or
// done, and a run with no word for IMPORT_STALE_MS is treated as interrupted, so Retry appears.
const IMPORT_EVENTS = ['sync_started', 'sync_scoped', 'sync_settling', 'sync_complete', 'sync_partial', 'sync_failed'];
const IMPORT_RUNNING = new Set(['sync_started', 'sync_scoped', 'sync_settling']);
export const IMPORT_STALE_MS = 3 * 60 * 60_000;
/** Imports running in this process, so a Retry cannot start a second pull of the same CRM. */
const importsInFlight = new Set();

/** Where a connect-time CRM import stands, from its newest log row. Pure over the row. */
export function importStateFrom(row, { now = Date.now(), inFlight = false } = {}) {
  if (!row) return inFlight ? { state: 'running', at: null, error: null } : { state: 'none', at: null, error: null };
  const at = row.occurred_at ?? null;
  if (IMPORT_RUNNING.has(row.event_type)) {
    const age = now - new Date(at ?? 0).getTime();
    if (inFlight || age < IMPORT_STALE_MS) return { state: 'running', at, error: null, step: row.event_type };
    return { state: 'failed', at, error: 'The import stopped before it finished, most likely because the server restarted.' };
  }
  if (row.event_type === 'sync_failed') return { state: 'failed', at, error: String(row.summary ?? 'The import failed.').slice(0, 300) };
  return { state: 'done', at, error: null, partial: row.event_type === 'sync_partial' };
}

export async function crmImportStatus(supabase, workspaceId, provider) {
  if (!provider) return { state: 'none', at: null, error: null };
  const { data } = await supabase.from('workspace_system_log')
    .select('event_type, summary, occurred_at')
    .eq('workspace_id', workspaceId).eq('source', provider)
    .in('event_type', IMPORT_EVENTS).eq('metadata->>trigger', 'connect')
    .order('occurred_at', { ascending: false }).limit(1).maybeSingle();
  return importStateFrom(data ?? null, { inFlight: importsInFlight.has(`${workspaceId}:${provider}`) });
}

/**
 * Run the connect-time import again for the workspace's CRM (the Retry button, GET-853). Returns
 * at once: the pull runs in the background and its log rows report progress.
 */
export async function retryCrmImport(supabase, workspaceId) {
  const crm = await crmState(supabase, workspaceId);
  if (!crm) return { error: 'no_crm' };
  if (importsInFlight.has(`${workspaceId}:${crm.provider}`)) return { error: 'already_running' };
  importFromCrm(supabase, workspaceId, crm.provider, crm.connectionId)
    .catch(e => console.error('[CONNECT_INGEST] retry failed:', e?.message || e));
  return { ok: true, provider: crm.provider };
}

/**
 * Import everything a freshly-connected CRM holds. Returns what it pulled, or a `skipped`
 * reason — never throws, because the caller is the connect path.
 */
export async function importFromCrm(
  supabase, workspaceId, provider, connectionId,
  { only = null, since = null, until = null, companyIds = null } = {},
) {
  const startedAt = new Date().toISOString();
  const flight = `${workspaceId}:${provider}`;
  importsInFlight.add(flight);
  await log(supabase, workspaceId, provider, 'sync_started', `Importing from ${provider}`, { trigger: 'connect' });
  try {
    const { data: conn } = await supabase
      .from('workflow_provider_connections')
      .select('id, encrypted_credentials')
      .eq('id', connectionId).maybeSingle();
    if (!conn?.encrypted_credentials) {
      await log(supabase, workspaceId, provider, 'sync_failed', `${provider}: no credentials on the connection — reconnect it`, { trigger: 'connect' });
      return { skipped: 'no_credentials' };
    }

    const creds = {};
    for (const [k, v] of Object.entries(conn.encrypted_credentials)) {
      if (typeof v !== 'string') continue;
      try { creds[k] = decrypt(v); } catch { creds[k] = v; }
    }
    // Salesforce is OAuth with short-lived tokens and a per-org host: refresh, then pack both.
    const token = provider === 'salesforce' ? await salesforceAccess(creds) : tokenFor(provider, creds);
    if (!token) {
      await log(supabase, workspaceId, provider, 'sync_failed',
        `${provider}: credential field missing`, { trigger: 'connect' });
      return { skipped: 'no_token' };
    }

    // Stages first — the records land into a board that already uses their words.
    await adoptStagesAfterSync(supabase, workspaceId, provider, token, 'onboarding')
      .catch(e => console.error('[CONNECT_INGEST] stage adoption failed:', e?.message || e));

    // WHICH ACCOUNTS (GET-281). A portal is not a customer list: a real one holds tens of
    // thousands of companies of which only about a fifth are a customer, carry a deal, or were
    // spoken to this year. Import
    // those; the rest are scraped rows that would fill the account list and teach the ICP model
    // from records that were never a deal. Their people, deals, conversations and invoices come
    // with them. If the scope call fails we import everything, as before — never block the connect.
    let scope = null;
    if (provider === 'hubspot') {
      try {
        // Working out which accounts are in scope costs about a hundred searches, and HubSpot's search limit
        // is per SECOND across the whole portal. Several runs sharing the work must not each pay
        // that toll at the same moment — so the caller can hand over the answer (GET-291).
        const resolved = companyIds?.length ? { companyIds } : await hubspotImportScope(token, { months: IMPORT_MONTHS });
        {
          const { companyIds } = resolved;
          if (companyIds.length) {
          scope = {
            hubspotCompanyIds: companyIds,
            engagementsSince: since ?? new Date(Date.now() - IMPORT_MONTHS * 30 * DAY).toISOString(),
            ...(until ? { engagementsUntil: until } : {}),
          };
          await log(supabase, workspaceId, provider, 'sync_scoped',
            `Importing ${companyIds.length} accounts: customers, anything with a deal, anything spoken to in ${IMPORT_MONTHS} months`,
            { trigger: 'connect', accounts: companyIds.length, months: IMPORT_MONTHS });
        }
        }
      } catch (e) {
        // NEVER widen on failure (GET-291). This used to fall through to "import everything",
        // and when HubSpot rate-limited the scope call that is exactly what happened: calls from
        // years back and tens of thousands of missed-call rows from companies nobody sells to, in
        // a workspace that asked for twelve months of its own accounts. A scope that cannot be resolved is
        // a run that must not start.
        await log(supabase, workspaceId, provider, 'sync_failed',
          `Could not work out which accounts to import — ${e?.message || e}`, { trigger: 'connect' });
        return { error: `scope: ${e?.message || e}` };
      }
    }

    const result = await syncCrmProvider(supabase, workspaceId, provider, token, null, { ...(scope ? { scope } : {}), ...(only?.length ? { only } : {}) });

    // A run that hit the page cap resumes from the newest record it saw, never from "now" —
    // otherwise the rest of the portal is skipped forever.
    const cursorAt = !result.truncated?.length ? startedAt : (result.resumeFrom ?? null);

    // The config row is written only AFTER a pull worked, and it is what the nightly
    // auto-sync worker reads. Writing it on connect would have the nightly picking up a
    // workspace whose credentials were never once exercised.
    await supabase.from('crm_sync_configs').upsert({
      workspace_id: workspaceId,
      connection_id: conn.id,
      provider,
      auto_sync: true,
      ...(cursorAt ? { last_synced_at: cursorAt } : {}),
      contacts_synced: result.contacts.inserted + result.companies.inserted,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,provider' }).then(() => {}, () => {});

    // Which pipeline is "the pipeline" here, by the CRM's own id, in its own write. The column
    // is added by a hand-applied migration, and naming an unknown column would have PostgREST
    // reject the upsert above — the one that CREATES the config row the nightly sync reads.
    await writePrimaryPipelineRef(supabase, workspaceId, provider, result.primaryPipelineRef);

    const totalNew = result.contacts.inserted + result.companies.inserted + result.deals.inserted;

    // LANDED IS NOT USABLE (GET-299). The pull above wrote observations; reports, the org chart,
    // ownership and the agent read claims, which the engine derives one at a time from a shared
    // queue. On a customer workspace that left almost none of its thousands of deals with a readable status for most of a day,
    // under a log line that said complete. So the import settles its own claims first, and only
    // calls itself complete when nothing it brought in is still waiting.
    let settle = null;
    try {
      await log(supabase, workspaceId, provider, 'sync_settling',
        `Making ${totalNew} imported records usable`, { trigger: 'connect' });
      settle = await settleClaimQueue(supabase, workspaceId, {
        onProgress: (p) => console.log(`[CONNECT_INGEST] settle ws=${workspaceId} ${JSON.stringify(p)}`),
      });
    } catch (e) {
      settle = { error: e?.message || String(e) };
      console.error('[CONNECT_INGEST] settle failed:', settle.error);
    }
    const unsettled = !settle || settle.error || settle.failed > 0 || settle.pending > 0;

    await log(supabase, workspaceId, provider,
      result.errors?.length || unsettled ? 'sync_partial' : 'sync_complete',
      `Connect pull from ${provider}: ${totalNew} new (c:${result.contacts.fetched} co:${result.companies.fetched} d:${result.deals.fetched})`
        + (settle?.error ? ` — not yet usable: ${settle.error}`
          : settle ? ` — ${settle.written} fields usable${settle.pending ? `, ${settle.pending} still pending` : ''}${settle.failed ? `, ${settle.failed} failed` : ''}` : ''),
      { trigger: 'connect', ...result, settle });

    // The ICP trainer reads each closed deal's website, which is a model call apiece. On a small
    // workspace that is a few cents at connect and worth it; on a CRM-sized one it is a bill nobody
    // asked for, on deals the operator has not looked at yet. Deferred with the backfill (GET-283).
    const { count: accountCount } = await supabase.from('companies')
      .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    if ((accountCount ?? 0) > BACKFILL_ON_CONNECT_MAX_ACCOUNTS) {
      await log(supabase, workspaceId, provider, 'icp_training_deferred',
        `${accountCount} accounts — closed-deal ICP training not run automatically.`, { trigger: 'connect', accounts: accountCount });
    } else {
      trainFromSyncedDeals(supabase, workspaceId, result, 'onboarding').catch(() => {});
    }

    console.log(`[CONNECT_INGEST] ${provider} ws=${workspaceId} imported ${totalNew} new`);
    return { imported: totalNew, result };
  } catch (e) {
    console.error('[CONNECT_INGEST]', provider, e?.message || e);
    await log(supabase, workspaceId, provider, 'sync_failed',
      `${provider} connect sync failed — ${e.message}`, { trigger: 'connect', error: e.message });
    return { error: e.message };
  } finally {
    importsInFlight.delete(flight);
  }
}

/**
 * Which CRM this workspace has connected, and whether it has ever actually been pulled.
 * `crm_sync_configs.last_synced_at` is written only after an import succeeded, so its absence
 * is the honest answer to "is the graph seeded yet".
 */
export async function crmState(supabase, workspaceId) {
  const { data: provs } = await supabase
    .from('workflow_providers').select('id, name').in('name', [...CRM_PROVIDERS]);
  if (!provs?.length) return null;
  const byId = new Map(provs.map(p => [p.id, p.name]));

  const { data: conns } = await supabase
    .from('workflow_provider_connections')
    .select('id, provider_id, created_at')
    .eq('workspace_id', workspaceId)
    .in('provider_id', provs.map(p => p.id))
    .order('created_at', { ascending: false });
  if (!conns?.length) return null;

  const provider = byId.get(conns[0].provider_id);
  const { data: cfg } = await supabase
    .from('crm_sync_configs').select('last_synced_at')
    .eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();

  return { provider, connectionId: conns[0].id, imported: !!cfg?.last_synced_at };
}

/**
 * What happens when any source connects — in the order the tiers actually depend on.
 *
 *   1. CRM        accounts, companies, deals, and the stage vocabulary
 *   2. mail +     threads attached to those accounts; also surfaces the alternate
 *      outbound   addresses the next tier needs
 *   3. meetings   the notetaker replay, LAST
 *
 * The order is about identity, not tidiness. A notetaker resolves a ROOM to people and
 * CREATES anyone it cannot match — so replaying meetings before the CRM import means
 * inventing duplicates of contacts the CRM was about to establish properly, and every later
 * tier then builds on the wrong person. Tiers 2 and 3 are sequenced inside the enrichment
 * job itself (contactHistoryEnricher); tier 1 is sequenced here, by awaiting it.
 *
 * A missing tier is skipped, never waited on: no CRM connected means the run starts at mail,
 * which is the right behaviour for a seat that only ever connects a notetaker. But a CRM that
 * IS connected and has never been pulled is always pulled first, whichever tool triggered
 * this — connect Fireflies an hour after HubSpot and the CRM still goes first.
 *
 * Fire-and-forget from the caller: a CRM pull takes minutes and the connect response must not
 * wait on it. Nothing in here may fail the connect.
 */
export async function ingestOnConnect(workspaceId, providerName, { supabase = getSupabaseClient(), userId = null } = {}) {
  const provider = String(providerName || '').toLowerCase();
  if (!workspaceId || !provider) return;

  // Connecting one of these proves the connection and starts LIVE ingest only. It does not
  // pull history, and it does not kick off the workspace backfill, which re-scans every OTHER
  // connected source for up to 2000 accounts and spends model credits on whatever it finds.
  // Product decision, 2026-09-15: connect Fellow to see it work, no backfill for now. Delete the name
  // to give the provider the normal connect-time backfill.
  if (LIVE_ONLY_ON_CONNECT.has(provider)) {
    await log(supabase, workspaceId, provider, 'connected_live_only',
      `${provider} connected — live from now on, no history backfill`, { trigger: 'connect' });
    return;
  }

  try {
    // AN INVITED MEMBER'S OWN BACKFILL (GET-571). Their mail and notes, onto the workspace's
    // records, on the workspace's pool. No CRM tier — the founder's import already made the records.
    const memberOwner = await backfillOwnerFor(supabase, workspaceId, userId).catch(() => null);
    if (memberOwner) {
      await enqueueWorkspaceHistoryBackfill(supabase, workspaceId, { reason: `connect:${provider}`, ownerUserId: memberOwner });
      return;
    }

    // ── Tier 1 ──────────────────────────────────────────────────────────────
    const crm = await crmState(supabase, workspaceId);
    if (crm && !crm.imported) {
      console.log(`[CONNECT_INGEST] ws=${workspaceId} ${provider} connected — importing ${crm.provider} first`);
      await importFromCrm(supabase, workspaceId, crm.provider, crm.connectionId);
    } else if (isCrmProvider(provider) && crm?.imported) {
      // A reconnect, or a second key for the same CRM. Re-pull: they did it for a reason.
      await importFromCrm(supabase, workspaceId, crm.provider, crm.connectionId);
    }

    // ── Tiers 2 and 3 ───────────────────────────────────────────────────────
    // One job. Its internal order is mail → outbound → notetakers, and it now has accounts
    // to attach history to, because tier 1 finished above.
    const { count: accounts } = await supabase.from('companies')
      .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    if ((accounts ?? 0) > BACKFILL_ON_CONNECT_MAX_ACCOUNTS) {
      await log(supabase, workspaceId, provider, 'backfill_deferred',
        `${accounts} accounts — history backfill not started automatically. Run it when you want to spend on it.`,
        { trigger: 'connect', accounts });
      console.log(`[CONNECT_INGEST] ws=${workspaceId} ${accounts} accounts — history backfill deferred`);
      return;
    }
    await enqueueWorkspaceHistoryBackfill(supabase, workspaceId, { reason: `connect:${provider}` });
  } catch (e) {
    console.error('[CONNECT_INGEST] run failed:', e?.message || e);
  }
}
