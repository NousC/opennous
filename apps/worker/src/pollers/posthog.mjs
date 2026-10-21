// PostHog usage pull (GET-751) — the daily half of the PostHog source.
//
// Once a day per connection: one HogQL query for the project's last 60 days, one row per user
// email (packages/core/src/integrations/posthog.ts, posthogUsageQuery). Then:
//
//   people     a user active in the last 30 days is resolved, and created if new, with their account
//              from their company group, work email or the company PostHog has on them. A free-mail
//              user with none of that is created with enrichment on (20 a run) to find it. Older
//              users are only updated if we know them. The workspace's own team (its
//              domains and its members' emails) is skipped. Each gets product.last_seen_at / active_days_30d / events_30d / key_events.
//   accounts   users rolled up by work-email domain: product.* (always), plus cs.active_users_30d,
//              cs.total_users, cs.usage_30d and cs.last_used_at (the account-health vocabulary the
//              adoption factor and the CS lists already read) unless the CRM writes those itself.
//   activity   anyone active in the last 30 days gets one "Used the product" interaction for the
//              week they were last seen, which lists them on People and their account on Accounts.
//   gone quiet an account the last pull wrote usage for that has no users in this window gets
//              zeros, so "5 active users" never outlives the people who left.
//
// Runs hourly and skips a connection pulled in the last 20 hours, so a new connection gets its
// first pull within the hour and every other one once a day. Facts are state observations, one
// per property per entity per day (the external id names the day), so a re-run is a no-op.

import crypto from 'crypto';
import { getSupabaseClient, usageAccountOf, rollUpByAccount, companyGroupIndex, posthogGroupsQuery, parseGroupRows, accountUsageSignals, seatDroppedSignal, posthogIssuesQuery, parseIssueRows, issuesFor, issueStatement, upsertInsightItems, posthogSettings, posthogRequest, posthogUsageQuery, parseUsageRows, rollUpByDomain, companyUsageFacts, personUsageFacts, recordObservations, logWorkerRun, loadOwnDomains, PostHogError, POSTHOG_CS_FACTS, QUIET_COMPANY_FACTS } from '@nous/core';
import { assertPublicUrl } from '../lib/engineStepHandlers.mjs';
import { resolveContact, upsertCompany } from '../utils/resolveContact.mjs';
import { logActivity } from '../utils/activity.mjs';
import { memberEmails } from '../webhooks/handlers/posthog.mjs';
import { decrypt } from '../utils/encryption.mjs';
import { logSysEvent } from '../utils/systemLog.mjs';

const PULL_EVERY_MS = 20 * 3600_000;
const MAX_NEW_PEOPLE_PER_RUN = 2000;
const SOURCE = 'posthog';

const tryDecrypt = (v) => { if (v == null || v === '') return null; try { return decrypt(v); } catch { return null; } };

/**
 * A connection's key and settings. The form's fields are stored encrypted; subscribe's copies
 * (posthog_api_base, posthog_project_id, and signup_event / key_events over the form's) are
 * plain. decrypt() hands a plain value back as it is, so every field goes through it.
 */
export function connectionSettings(enc, decryptFn = tryDecrypt) {
  const creds = {};
  for (const k of ['host', 'project_id', 'signup_event', 'key_events', 'posthog_api_base', 'posthog_project_id']) creds[k] = decryptFn(enc?.[k]);
  return { apiKey: decryptFn(enc?.api_key), read: posthogSettings(creds) };
}

export function isDue(enc, now = Date.now()) {
  const last = Date.parse(enc?.posthog_last_pull_at ?? '');
  return Number.isNaN(last) || now - last >= PULL_EVERY_MS;
}

/** One day's facts on one entity as observations. The day is in the id, so a re-run is a no-op. */
export function usageObservations(workspaceId, entityId, facts, day) {
  return facts
    .filter(([, v]) => v != null && v !== '')
    .map(([property, value]) => ({
      workspaceId, entityId, kind: 'state', property, value,
      source: SOURCE, method: 'usage_pull', observedAt: `${day}T00:00:00.000Z`,
      externalId: `posthog_usage_${day}_${entityId}_${property}`,
    }));
}

/** The company most of a domain's resolved users already belong to. */
export function majorityCompany(companyIds) {
  const n = new Map();
  for (const id of companyIds) if (id) n.set(id, (n.get(id) ?? 0) + 1);
  let best = null, top = 0;
  for (const [id, c] of n) if (c > top) { best = id; top = c; }
  return best;
}

async function connections(supabase) {
  const { data: provider } = await supabase.from('workflow_providers').select('id').eq('name', 'posthog').maybeSingle();
  if (!provider?.id) return [];
  const { data } = await supabase.from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials').eq('is_verified', true).eq('provider_id', provider.id);
  return data ?? [];
}

/** Which of these accounts a CRM already writes account-health facts for: PostHog leaves those alone. */
async function crmOwnedFacts(supabase, ws, ids) {
  const owned = new Set();   // `${entityId}|${property}`
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('observations').select('entity_id, property')
      .eq('workspace_id', ws).in('entity_id', ids.slice(i, i + 200)).in('property', [...POSTHOG_CS_FACTS])
      .neq('source', SOURCE).limit(1000);
    for (const r of data ?? []) owned.add(`${r.entity_id}|${r.property}`);
  }
  return owned;
}

/** The entities the last pull wrote this fact for (its day is in the external id), every page. */
async function entitiesPulledOn(supabase, ws, day, property = 'product.active_users_30d') {
  const out = new Set();
  if (!day) return out;
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase.from('observations').select('entity_id')
      .eq('workspace_id', ws).eq('source', SOURCE).eq('property', property)
      .like('external_id', `posthog_usage_${day}_%`).order('entity_id').range(from, from + 999);
    for (const r of data ?? []) out.add(r.entity_id);
    if (!data || data.length < 1000) return out;
  }
}

const MAX_ISSUES_PER_ACCOUNT = 5;
// Free-mail users with no company anywhere in PostHog, created with enrichment on so the lookup
// finds their company. Each one is a paid lookup on the workspace's key: kept small.
const MAX_RESEARCH_PER_RUN = 20;

/** The project's company group type and its groups, or none. Never fails the pull. */
export async function companyGroups(request, apiKey, apiBase, projectId) {
  try {
    const index = companyGroupIndex(await request(apiKey, apiBase, `/api/projects/${projectId}/groups_types/`));
    if (index == null) return { index: null, byKey: new Map() };
    const res = await request(apiKey, apiBase, `/api/projects/${projectId}/query/`, {
      method: 'POST', timeoutMs: 60_000,
      body: { query: { kind: 'HogQLQuery', query: posthogGroupsQuery(index) }, name: 'opennous_groups_daily' },
    });
    return { index, byKey: parseGroupRows(res?.results) };
  } catch (err) {
    console.warn(`[posthog-usage] groups: ${err.message}`);
    return { index: null, byKey: new Map() };
  }
}
const MAX_ISSUES_PER_RUN = 40;

/**
 * Errors and friction as Product insights (GET-751). The last 7 days of $exception, $rageclick
 * and $dead_click per user, rolled up per account (core issuesFor: only what is worth reading),
 * each issue one insight on the board's Product lane: a bug for an error, an improvement for
 * friction. One per account, issue and week: the week is in the ref, and the ref in the dedup key.
 * The nightly board sort files it under a tag next to what customers said about the same thing.
 */
export async function pullIssues(supabase, ws, { apiKey, apiBase, projectId, request, skip, companyOf, personOf, now, writeInsights = upsertInsightItems }) {
  const res = await request(apiKey, apiBase, `/api/projects/${projectId}/query/`, {
    method: 'POST', timeoutMs: 60_000,
    body: { query: { kind: 'HogQLQuery', query: posthogIssuesQuery() }, name: 'opennous_issues_daily' },
  });
  const byAccount = new Map();
  for (const r of parseIssueRows(res?.results)) {
    if (skip(r.email)) continue;
    const accountId = companyOf.get(r.email);
    if (!accountId) continue;
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId).push(r);
  }
  const week = weekOf(now);
  const items = [];
  for (const [accountId, rows] of byAccount) {
    for (const i of issuesFor(rows).slice(0, MAX_ISSUES_PER_ACCOUNT)) {
      items.push({
        source: 'external', category: 'product', kind: i.event === '$exception' ? 'bug' : 'improvement',
        statement: issueStatement(i), quote: null, speaker: null,
        company_id: accountId, contact_id: personOf.get(i.emails[0]) ?? null,
        occurred_at: i.lastAt, source_system: SOURCE,
        source_ref: `source://posthog/${accountId}/${crypto.createHash('sha1').update(i.key).digest('hex').slice(0, 12)}/${week}`,
      });
    }
  }
  items.sort((a, b) => (a.kind === 'bug' ? 0 : 1) - (b.kind === 'bug' ? 0 : 1));
  return items.length ? await writeInsights(supabase, ws, items.slice(0, MAX_ISSUES_PER_RUN)) : 0;
}

/** Monday of the week, as YYYY-MM-DD: one "Used the product" per person per week. */
export function weekOf(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

/**
 * Someone who used the product in the last 30 days gets one `product_used` interaction for the
 * week they were last seen. Weekly pulls add one per week they keep using it; the
 * first pull after a connect brings in everyone from the last month. It is what puts them on
 * People and their account on Accounts (both only list people and accounts with activity), and
 * it moves them to 'interested' (pipelineStage.ts). Not a sales touch, and not a conversation,
 * so nothing is extracted from it.
 */
export function productUsedActivity(workspaceId, contact, u, now = new Date()) {
  if (!contact?.id || !(u.activeDays30d > 0)) return null;
  const seen = u.lastSeen ? new Date(u.lastSeen) : now;
  const recent = u.activeDays7d > 0;
  return {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        'product_used',
    source:      SOURCE,
    externalId:  `posthog_used_${contact.id}_${weekOf(seen)}`,
    // Dated when we read it, not when they were last seen. The stage it moves them to is the
    // newest stage observation, and a person first resolved by this same pull was just written
    // as 'identified' (now): an 'interested' dated to last week would lose to it and they would
    // never reach People. The last-seen time is kept on the activity.
    occurredAt:  now.toISOString(),
    description: recent
      ? `Used the product on ${u.activeDays7d} of the last 7 days`
      : `Used the product on ${u.activeDays30d} of the last 30 days`,
    rawData:     { last_seen_at: seen.toISOString(), active_days_7d: u.activeDays7d, active_days_30d: u.activeDays30d, events_30d: u.events30d },
  };
}

export async function pullConnection(supabase, conn, {
  now = new Date(), request = posthogRequest, checkHost = assertPublicUrl,
  resolve = resolveContact, upsert = upsertCompany, ownDomains = loadOwnDomains, members = memberEmails, record = recordObservations, logUse = logActivity,
  writeInsights = upsertInsightItems,
} = {}) {
  const ws = conn.workspace_id;
  const { apiKey, read } = connectionSettings(conn.encrypted_credentials);
  if (!apiKey || !read.ok) return { ok: false, reason: read.ok ? 'posthog_key_unreadable' : read.reason };
  const { apiBase, projectId, keyEvents } = read.settings;
  // A self-hosted PostHog was checked at connect; its name could point somewhere private since.
  if (!apiBase.endsWith('.posthog.com')) await checkHost(apiBase);

  // Company groups, when the project has them: the best evidence of which account a user is in.
  const groups = await companyGroups(request, apiKey, apiBase, projectId);
  const res = await request(apiKey, apiBase, `/api/projects/${projectId}/query/`, {
    method: 'POST', timeoutMs: 60_000,
    body: { query: { kind: 'HogQLQuery', query: posthogUsageQuery(keyEvents, { groupIndex: groups.index }) }, name: 'opennous_usage_daily' },
  });
  const own = await ownDomains(supabase, ws).catch(() => new Set());
  const team = await members(supabase, ws).catch(() => new Set());
  // The workspace's own team using its own product is not a customer: its domains, and its
  // members' sign-in emails (a founder on gmail.com is not caught by the domain rule).
  const users = parseUsageRows(res?.results, keyEvents).filter(u => !own.has(u.email.split('@')[1]) && !team.has(u.email));
  const day = now.toISOString().slice(0, 10);
  const obs = [];

  // People. Most recently seen first (the query's order), so the cap keeps the active ones. A user
  // active in the last 30 days is created when we know their account (company group, work email,
  // or the company PostHog has on them), and resolved with it, so the person lands on it. A
  // free-mail user with none of that is created with enrichment on, capped per run: the lookup
  // from their address and name is how we find their company. Everyone else is updated if known.
  const companyOf = new Map();   // email → company id
  const personOf = new Map();    // email → person id
  const seenPeople = new Set();
  let created = 0, people = 0;
  let researched = 0;
  for (const u of users) {
    const account = usageAccountOf(u, groups.byKey);
    const research = !account && researched < MAX_RESEARCH_PER_RUN;
    const mayCreate = u.activeDays30d > 0 && created < MAX_NEW_PEOPLE_PER_RUN && (!!account || research);
    const r = await resolve(supabase, ws, {
      email: u.email, full_name: u.fullName, company_name: account?.name ?? null, company_domain: account?.domain ?? null, source: SOURCE,
    }, { createIfMissing: mayCreate, enrich: research }).catch(() => null);
    const contact = r?.contact;
    if (!contact) continue;
    if (r.created) { created++; if (research) researched++; }
    people++;
    seenPeople.add(contact.id);
    personOf.set(u.email, contact.id);
    companyOf.set(u.email, contact.company_id ?? null);
    obs.push(...usageObservations(ws, contact.id, personUsageFacts(u), day));
    // Stamped now, not at the run's start: resolveContact above may have just written this person
    // as 'identified', and the newest stage observation wins.
    const used = productUsedActivity(ws, contact, u, new Date());
    if (used) await logUse(supabase, used).catch(() => {});
  }

  // Accounts.
  const rolled = [];
  for (const c of rollUpByAccount(users, (u) => usageAccountOf(u, groups.byKey))) {
    let companyId = majorityCompany(c.emails.map(e => companyOf.get(e)));
    if (!companyId && c.activeUsers30d > 0) {
      const co = await upsert(supabase, ws, { name: c.name ?? null, domain: c.domain }).catch(() => null);
      companyId = co?.id ?? null;
    }
    if (companyId) rolled.push([companyId, c]);
  }
  const owned = await crmOwnedFacts(supabase, ws, rolled.map(([id]) => id));
  for (const [companyId, c] of rolled) {
    const facts = companyUsageFacts(c).filter(([p]) => !owned.has(`${companyId}|${p}`));
    obs.push(...usageObservations(ws, companyId, facts, day));
  }

  // Accounts that went quiet: in the last pull, nobody in this window.
  const seen = new Set(rolled.map(([id]) => id));
  const lastDay = String(conn.encrypted_credentials?.posthog_last_pull_at ?? '').slice(0, 10) || null;
  const quiet = [...await entitiesPulledOn(supabase, ws, lastDay)].filter(id => !seen.has(id));
  const quietOwned = await crmOwnedFacts(supabase, ws, quiet);
  for (const id of quiet) {
    obs.push(...usageObservations(ws, id, QUIET_COMPANY_FACTS.filter(([p]) => !quietOwned.has(`${id}|${p}`)), day));
  }

  // Usage as account signals (core/services/usageSignals.mjs): dropped, inactive, a feature
  // adopted, a seat dropped. Keyed so each fires once per spell; the signal pass sends them on.
  const signals = rolled.flatMap(([companyId, c]) => accountUsageSignals(companyId, c, { now: now.getTime() }));
  for (const u of users) {
    const accountId = companyOf.get(u.email);
    const person = accountId ? personOf.get(u.email) : null;
    const row = person ? seatDroppedSignal(person, accountId, u, { now: now.getTime() }) : null;
    if (row) signals.push(row);
  }
  if (signals.length) {
    const { error: sigErr } = await supabase.from('account_signals')
      .upsert(signals.map(r => ({ workspace_id: ws, ...r })), { onConflict: 'workspace_id,dedupe_key', ignoreDuplicates: true });
    if (sigErr) console.warn(`[posthog-usage] ws=${ws} signals: ${sigErr.message}`);
  }

  // People who were users in the last pull and are gone from this window: no longer users.
  const gone = [...await entitiesPulledOn(supabase, ws, lastDay, 'product.user')].filter(id => !seenPeople.has(id));
  for (const id of gone) obs.push(...usageObservations(ws, id, [['product.user', false], ['product.active_days_30d', 0], ['product.events_30d', 0]], day));

  for (let i = 0; i < obs.length; i += 500) await record(supabase, obs.slice(i, i + 500));

  // Errors and friction, on their own: a failure here never costs the usage above.
  let issues = 0;
  try {
    issues = await pullIssues(supabase, ws, {
      apiKey, apiBase, projectId, request, companyOf, personOf, now, writeInsights,
      skip: (email) => own.has(email.split('@')[1]) || team.has(email),
    });
  } catch (err) {
    console.warn(`[posthog-usage] ws=${ws} issues: ${err.message}`);
  }

  // Re-read before writing the cursor: a reconnect during a long pull carries a new key and secret.
  const { data: fresh } = await supabase.from('workflow_provider_connections').select('encrypted_credentials').eq('id', conn.id).maybeSingle();
  if (fresh?.encrypted_credentials) {
    await supabase.from('workflow_provider_connections')
      .update({ encrypted_credentials: { ...fresh.encrypted_credentials, posthog_last_pull_at: now.toISOString() } })
      .eq('id', conn.id);
  }
  return { ok: true, users: users.length, people, created, accounts: rolled.length, quiet: quiet.length, signals: signals.length, issues };
}

let running = false;

export async function pollPostHogUsage({ supabase = getSupabaseClient(), now = new Date() } = {}) {
  if (running) return 0;
  running = true;
  let pulled = 0;
  try {
    for (const conn of await connections(supabase)) {
      if (!isDue(conn.encrypted_credentials, now.getTime())) continue;
      const startedAt = new Date();
      try {
        const out = await pullConnection(supabase, conn, { now });
        await logWorkerRun(supabase, { worker: 'posthog_usage', workspaceId: conn.workspace_id, status: out.ok ? 'success' : 'skipped', summary: out.ok ? `${out.users} users, ${out.accounts} accounts, ${out.created} new people` : out.reason, details: out, startedAt });
        if (out.ok) {
          pulled++;
          await logSysEvent(supabase, { workspaceId: conn.workspace_id, source: SOURCE, eventType: 'usage_pulled', summary: `Product usage for ${out.accounts} accounts and ${out.people} people`, metadata: out });
        }
      } catch (err) {
        const why = err instanceof PostHogError ? `PostHog answered ${err.status}: ${err.message}` : err.message;
        console.warn(`[posthog-usage] ws=${conn.workspace_id}: ${why}`);
        await logWorkerRun(supabase, { worker: 'posthog_usage', workspaceId: conn.workspace_id, status: 'error', summary: String(why).slice(0, 300), startedAt });
      }
    }
  } finally {
    running = false;
  }
  return pulled;
}
