// Weekly LinkedIn engagement run — the native, no-button lead source.
//
// For each workspace that has connected its own LinkedIn (via Unipile, stored in
// workspace_linkedin_connections) AND is on the Pro, Growth or Partner plan, this scrapes the
// engagers off that workspace's OWN recent posts (comments + reactions) and drops
// them into a native "LinkedIn Engagers" lead list. There is no frontend trigger;
// it runs on a weekly cron and is visible only in the ops log.
//
// Why these stay LEADS, not People:
//   * the lead insert writes observations with source 'lead_list'
//   * the engagement signal here is written with source 'apify_linkedin'
//   Both are scrape sources, and a post-engagement promotes no pipeline stage
//   (see stageDerivation). So the People (contacts) view filter keeps them out.
//   The moment they actually reply / DM / meet, a real-source interaction lands
//   and they graduate into People automatically. Comment in, conversation out.
//
// Eligibility: cloud needs a Pro/Growth/Partner plan (or the allowlist); self-host
// runs for any connected workspace (no plan concept). Lead lists are now open on
// self-host (see access.mjs / the feature split). Gating (any one no-op silences
// the whole thing — safe by default):
//   * APIFY_TOKEN unset                            -> feature off everywhere
//   * workspace has no LinkedIn connected          -> skipped
//   * engagement_enabled = false                   -> user turned it off, skipped
//   * cloud + not Pro/Growth/Partner (no allowlist) -> skipped

import { getSupabaseClient, insertLeads, createLeadList, listLeadLists, logWorkerRun } from '@nous/core';
import { runActor, resolveApifyToken } from '../utils/apify.mjs';
import { logSysEvent } from '../utils/systemLog.mjs';

const WINDOW_DAYS  = Number(process.env.ENGAGEMENT_WINDOW_DAYS || 7);
const MAX_WINDOW_DAYS = 120;      // ceiling for an on-demand backfill window
const FLOOR_HOURS  = 48;          // skip posts younger than this — engagement is still arriving
const MAX_POSTS    = Number(process.env.ENGAGEMENT_MAX_POSTS || 5);
const MAX_PER_POST = 100;         // comments / reactions pulled per post
// 'main' = full profiles + vanity URLs (enrichable, identity-resolvable); 'short' = cheaper.
const PROFILE_MODE = process.env.ENGAGEMENT_PROFILE_MODE || 'main';
const LIST_NAME    = 'LinkedIn Engagers';
const LIST_SOURCE  = 'linkedin_engagement';
const ENGAGE_PROP  = 'interaction.linkedin_post_engagement';

// Workspaces force-enabled regardless of plan (cloud dogfood + pilots), CSV.
const ALLOWLIST = new Set(
  (process.env.LINKEDIN_ENGAGEMENT_WORKSPACES || '')
    .split(',').map(s => s.trim()).filter(Boolean),
);

// ── helpers ──────────────────────────────────────────────────────────────────
function normUrl(u) {
  if (!u) return null;
  return String(u).toLowerCase().split('?')[0].replace(/\/+$/, '');
}

// Tiny stable hash (djb2) for building idempotent external_ids from a post set.
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function relSecs(s) {
  const m = /^(\d+)\s*(mo|[wdhms])/.exec(String(s).trim().toLowerCase());
  if (!m) return null;
  const mult = { mo: 2592000, w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  return parseInt(m[1], 10) * mult[m[2]];
}

// Best-effort post timestamp (seconds). HarvestAPI returns several shapes.
function postTs(p, now) {
  const v = p.postedAt;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;
  if (v && typeof v === 'object') {
    const t = v.timestamp;
    if (t) return t > 1e12 ? t / 1000 : t;
    if (v.date) { const d = Date.parse(v.date); if (!Number.isNaN(d)) return d / 1000; }
    if (v.postedAgoShort) { const r = relSecs(v.postedAgoShort); if (r) return now - r; }
  }
  if (typeof v === 'string') {
    const d = Date.parse(v); if (!Number.isNaN(d)) return d / 1000;
    const r = relSecs(v); if (r) return now - r;
  }
  const pat = p.postedAtTimestamp;
  if (pat) return pat > 1e12 ? pat / 1000 : pat;
  return null;
}

// Is this workspace allowed to run? Self-host runs for any connected workspace
// (no plan concept). On cloud it needs an active Pro/Growth/Partner plan; the
// allowlist is for cloud dogfood / pilots.
async function isEligible(supabase, workspaceId) {
  if (process.env.SELF_HOSTED === 'true') return true;
  if (ALLOWLIST.has(workspaceId)) return true;
  const { data: ws } = await supabase.from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
  if (!ws?.team_id) return false;
  const { data: sub } = await supabase
    .from('subscriptions').select('plan_id, status').eq('team_id', ws.team_id).maybeSingle();
  if (!sub) return false;
  const dead = sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.status === 'past_due';
  // linkedinEngagement feature lives on Pro, Growth + Partner (internal id 'scale').
  // Keep in sync with plans.mjs hasFeature(plan, 'linkedinEngagement').
  return !dead && (sub.plan_id === 'pro' || sub.plan_id === 'growth' || sub.plan_id === 'scale');
}

// Find the workspace's native engagers list, creating it on first run.
async function ensureList(supabase, workspaceId) {
  const lists = await listLeadLists(supabase, workspaceId);
  const existing = lists.find(l => l.source === LIST_SOURCE || l.name === LIST_NAME);
  if (existing) return existing;
  return createLeadList(supabase, workspaceId, { name: LIST_NAME, source: LIST_SOURCE });
}

// Scrape a profile's recent-post engagers. Returns a map keyed by normalized URL.
// windowDays bounds how far back to look (default = the weekly window); token is
// the workspace's BYOK Apify key. maxPosts scales with the window so a backfill
// reaches the older posts it's asking for.
async function scrapeEngagers(profileUrl, { windowDays = WINDOW_DAYS, token } = {}) {
  const now = Date.now() / 1000;
  const url = String(profileUrl).split('?')[0];
  // A wider backfill needs more posts pulled + scanned. Cap so a runaway window
  // can't fan out unboundedly; the post-search actor itself maxes at 100.
  const maxPosts = Math.min(100, Math.max(MAX_POSTS, Math.ceil(windowDays / 7) * MAX_POSTS));
  const posts = await runActor('harvestapi~linkedin-post-search',
    { profileUrls: [url], maxItems: Math.min(100, maxPosts * 2), sortBy: 'date' }, { token });

  const keep = [];
  for (const p of posts) {
    const pu = p.linkedinUrl || p.url || p.postUrl;
    if (!pu) continue;
    const t = postTs(p, now);
    if (t != null) {
      const ageH = (now - t) / 3600;
      if (ageH < FLOOR_HOURS) continue;
      if (ageH / 24 > windowDays) continue;
    }
    keep.push(pu);
    if (keep.length >= maxPosts) break;
  }

  const eng = new Map();
  const add = (actor, kind, { text = null, react = null, postUrl = null } = {}) => {
    if (!actor?.linkedinUrl) return;
    const k = normUrl(actor.linkedinUrl);
    const e = eng.get(k) || {
      name: actor.name || null, linkedin_url: actor.linkedinUrl.trim(),
      // Stable LinkedIn member URN — slug-proof identity key for merging an
      // engager into their existing contact.
      member_id: actor.id || actor.objectUrn || null,
      position: actor.position || null, kinds: new Set(), post_urls: new Set(),
      sample_comment: null, reaction: null,
    };
    if (!e.member_id && (actor.id || actor.objectUrn)) e.member_id = actor.id || actor.objectUrn;
    e.kinds.add(kind);
    if (postUrl) e.post_urls.add(postUrl);
    if (text && !e.sample_comment) e.sample_comment = text;
    if (react && !e.reaction) e.reaction = react;
    eng.set(k, e);
  };

  for (const pu of keep) {
    try {
      const comments = await runActor('harvestapi~linkedin-post-comments',
        { posts: [pu], maxItems: MAX_PER_POST, profileScraperMode: PROFILE_MODE }, { token });
      for (const c of comments) add(c.actor, 'comment', { text: c.commentary, postUrl: pu });
    } catch (err) { console.error('[ENGAGE] comments error', pu, err.message); }
    try {
      const reactions = await runActor('harvestapi~linkedin-post-reactions',
        { posts: [pu], maxItems: MAX_PER_POST, profileScraperMode: PROFILE_MODE }, { token });
      for (const r of reactions) add(r.actor, 'reaction', { react: r.reactionType, postUrl: pu });
    } catch (err) { console.error('[ENGAGE] reactions error', pu, err.message); }
  }
  return { engagers: eng, postsMined: keep.length };
}

// ── per-workspace run ────────────────────────────────────────────────────────
// opts:
//   windowDays — how far back to mine (default = weekly window). On-demand passes
//                the user's requested backfill window.
//   force      — skip the engagement_enabled toggle (on-demand is an explicit ask,
//                so it runs even when the weekly scrape is turned off).
//   method     — observation method tag ('cron' | 'manual').
async function runForWorkspace(supabase, conn, opts = {}) {
  const { windowDays = WINDOW_DAYS, force = false, method = 'cron' } = opts;
  const workspaceId = conn.workspace_id;
  const profileUrl = conn.linkedin_profile_url;
  if (!profileUrl) return null;
  if (!force && conn.engagement_enabled === false) {
    console.log(`[ENGAGE] ${workspaceId} engagement turned off — skipping`);
    return null;
  }
  if (!(await isEligible(supabase, workspaceId))) {
    console.log(`[ENGAGE] ${workspaceId} not eligible (needs active Scale plan or allowlist) — skipping`);
    return null;
  }
  const token = await resolveApifyToken(supabase, workspaceId);
  if (!token) {
    console.log(`[ENGAGE] ${workspaceId} no Apify key (connect one in Integrations) — skipping`);
    return null;
  }
  console.log(`[ENGAGE] ${workspaceId} eligible — scraping ${profileUrl} (window ${windowDays}d)`);

  // Mark the scrape as run regardless of yield, so the backfill suggestion + UI
  // freshness reflect that we looked. Done once up front so an early return
  // (no engagers) still stamps it.
  await supabase.from('workspace_linkedin_connections')
    .update({ last_engagement_scrape_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('linkedin_profile_url', profileUrl);

  const { engagers, postsMined } = await scrapeEngagers(profileUrl, { windowDays, token });
  if (engagers.size === 0) {
    await logSysEvent(supabase, {
      workspaceId, source: 'linkedin_engagement', eventType: 'run',
      summary: `No engagers on ${postsMined} recent post(s)`,
    });
    return { workspaceId, postsMined, engagers: 0, inserted: 0 };
  }

  const list = await ensureList(supabase, workspaceId);

  const rows = [...engagers.values()].map(e => {
    const kinds = [...e.kinds].sort().join('+'); // 'comment', 'reaction', or 'comment+reaction'
    return {
      name: e.name,
      linkedin_url: e.linkedin_url,
      linkedin_member_id: e.member_id, // slug-proof merge into an existing contact
      fields: {
        title: e.position,
        source: 'Engaged with your LinkedIn post',
        engagement: kinds,
        post_urls: [...e.post_urls],
        sample_comment: e.sample_comment,
        reaction: e.reaction,
      },
    };
  });

  const res = await insertLeads(supabase, workspaceId, list.id, rows, { importDuplicates: false });

  // Attach an engagement observation to each engager's entity (idempotent per run)
  // so it lands on their People timeline too. Resolve by linkedin_url INDEPENDENT
  // of list membership: workspace-wide dedup means an engager who is already a
  // contact/lead elsewhere is skipped from this list (so reading the list misses
  // them), but their engagement must still land on their existing record. Pull
  // the workspace's linkedin_url identifiers (paginated) and match on normalized
  // URL — handles trailing-slash / case differences between scraped and stored.
  const byUrl = new Map();
  for (let from = 0; ; from += 1000) {
    const { data: ids } = await supabase
      .from('entity_identifiers')
      .select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', 'linkedin_url').eq('status', 'active')
      .range(from, from + 999);
    if (!ids?.length) break;
    for (const r of ids) { const k = normUrl(r.value); if (k && !byUrl.has(k)) byUrl.set(k, r.entity_id); }
    if (ids.length < 1000) break;
  }
  const nowISO = new Date().toISOString();
  const obs = [];
  for (const e of engagers.values()) {
    const entityId = byUrl.get(normUrl(e.linkedin_url));
    if (!entityId) continue;
    const kindStr = [...e.kinds].sort().join('+'); // 'comment' | 'reaction' | 'comment+reaction'
    // What renders as the activity body on the timeline: the comment text if they
    // commented, otherwise the reaction.
    const summary = e.sample_comment || (e.reaction ? `Reacted ${e.reaction}` : null);
    // Idempotent external_id: keyed on the engager + the exact set of posts they
    // engaged on + the kind — NOT the run date. Re-running the same window (or a
    // weekly run overlapping a manual backfill) yields the same id, so the same
    // engagement is never inserted twice. A genuinely new engagement (a new post)
    // changes the post set -> a new id -> a new timeline entry.
    const postSig = hashStr([...e.post_urls].map(normUrl).sort().join('|'));
    const externalId = `li_engage_${entityId}_${kindStr}_${postSig}`;
    obs.push({
      workspace_id: workspaceId,
      entity_id: entityId,
      kind: 'event',
      property: ENGAGE_PROP,
      value: {
        kind: kindStr,
        post_urls: [...e.post_urls],
        sample_comment: e.sample_comment,
        reaction: e.reaction,
        profile_name: e.name,
        summary,
      },
      source: 'apify_linkedin',
      method,
      external_id: externalId,
      observed_at: nowISO,
    });
  }
  if (obs.length) {
    // De-dupe manually instead of ON CONFLICT: the observations dedup index is
    // PARTIAL (WHERE external_id IS NOT NULL), which Postgres can't use for
    // conflict inference, so an upsert errored silently and nothing was written.
    // Read the external_ids already present, insert only the new ones, and check
    // the error so this can never fail quietly again.
    const wantIds = obs.map(o => o.external_id);
    const { data: existing } = await supabase.from('observations')
      .select('external_id').eq('workspace_id', workspaceId).eq('source', 'apify_linkedin')
      .in('external_id', wantIds);
    const have = new Set((existing || []).map(r => r.external_id));
    const fresh = obs.filter(o => !have.has(o.external_id));
    if (fresh.length) {
      const { error: obsErr } = await supabase.from('observations').insert(fresh);
      if (obsErr) console.error('[ENGAGE] observation insert failed:', obsErr.message);
      else console.log(`[ENGAGE] ${fresh.length} engagement observation(s) recorded for ${workspaceId}`);
    }
  }

  await logSysEvent(supabase, {
    workspaceId, source: 'linkedin_engagement', eventType: 'run',
    summary: `${engagers.size} engager(s) from ${postsMined} post(s) → ${LIST_NAME} (${res.inserted} new, ${res.duplicate_skipped} already there)`,
    metadata: { postsMined, engagers: engagers.size, ...res, listId: list.id },
  });

  return { workspaceId, postsMined, engagers: engagers.size, inserted: res.inserted };
}

// ── entrypoint (weekly cron) ─────────────────────────────────────────────────
// No global APIFY_TOKEN gate anymore — the key is BYOK per-workspace
// (resolveApifyToken inside runForWorkspace). A workspace with no connected key
// is simply skipped; self-host still falls back to the env var.
export async function runLinkedInEngagement() {
  const startedAt = new Date().toISOString();
  const supabase = getSupabaseClient();
  const { data: conns, error } = await supabase
    .from('workspace_linkedin_connections')
    .select('workspace_id, linkedin_profile_url, engagement_enabled')
    .not('linkedin_profile_url', 'is', null);
  if (error) { console.error('[ENGAGE] load connections failed', error.message); return; }
  if (!conns?.length) {
    console.log('[ENGAGE] no LinkedIn connections with a profile URL — connect LinkedIn (Unipile) on a workspace first. Nothing to scrape.');
    return;
  }
  console.log(`[ENGAGE] ${conns.length} LinkedIn connection(s) found`);

  let workspaces = 0, totalEngagers = 0, totalInserted = 0;
  for (const conn of conns) {
    try {
      const r = await runForWorkspace(supabase, conn);
      if (r) { workspaces++; totalEngagers += r.engagers; totalInserted += r.inserted; }
    } catch (err) {
      console.error('[ENGAGE] workspace failed', conn.workspace_id, err.message);
    }
  }

  console.log(`[ENGAGE] done — ${workspaces} workspace(s), ${totalEngagers} engagers, ${totalInserted} new leads`);
  await logWorkerRun(supabase, {
    worker: 'linkedin_engagement',
    status: 'success',
    summary: `${workspaces} workspace(s), ${totalEngagers} engagers, ${totalInserted} new leads`,
    details: { workspaces, engagers: totalEngagers, inserted: totalInserted },
    startedAt,
  });
}

// ── on-demand requests poller (every minute) ─────────────────────────────────
// Drains the on-demand scrape queue: any connection row where the API set
// engagement_scrape_requested_days (the user, via the app or the scrape_engagers
// MCP tool, asked to mine a window NOW). Runs each with force=true (an explicit
// ask runs even if the weekly toggle is off), then clears the request. Cheap
// no-op when nothing is queued (partial-indexed query).
export async function runEngagementScrapeRequests() {
  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase
    .from('workspace_linkedin_connections')
    .select('workspace_id, linkedin_profile_url, engagement_enabled, engagement_scrape_requested_days')
    .not('engagement_scrape_requested_days', 'is', null)
    .not('linkedin_profile_url', 'is', null)
    .order('engagement_scrape_requested_at', { ascending: true })
    .limit(10);
  if (error) {
    // Column missing = migration not applied yet; stay silent so it's a clean no-op.
    if (error.code === '42703' || error.code === 'PGRST204') return;
    console.error('[ENGAGE] load scrape requests failed', error.message);
    return;
  }
  if (!rows?.length) return;

  for (const conn of rows) {
    const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, conn.engagement_scrape_requested_days || WINDOW_DAYS));
    try {
      await runForWorkspace(supabase, conn, { windowDays, force: true, method: 'manual' });
    } catch (err) {
      console.error('[ENGAGE] on-demand scrape failed', conn.workspace_id, err.message);
    } finally {
      // Always clear the request so a failure can't wedge the queue (last_*_at is
      // stamped inside runForWorkspace, so the user still sees it was attempted).
      await supabase.from('workspace_linkedin_connections')
        .update({ engagement_scrape_requested_days: null, engagement_scrape_requested_at: null })
        .eq('workspace_id', conn.workspace_id)
        .eq('linkedin_profile_url', conn.linkedin_profile_url);
    }
  }
}
