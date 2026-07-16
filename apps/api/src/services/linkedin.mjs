// ============================================================
// LinkedIn integration via Unipile
//
// Required env vars:
//   UNIPILE_API_KEY  — your Unipile API key
//   UNIPILE_DSN      — e.g. api1.unipile.com:13465  (from Unipile dashboard)
//   VITE_API_URL     — your public app URL (for OAuth redirect)
// ============================================================

import { logActivity as coreLogActivity } from '@nous/core';
import { scoreICP } from './enrichment.mjs';
import { checkLinkedinSlot } from '../lib/access.mjs';

const BASE = () => {
  const dsn = process.env.UNIPILE_DSN;
  if (!dsn) throw new Error('UNIPILE_DSN not configured');
  return `https://${dsn}/api/v1`;
};

const headers = () => {
  const key = process.env.UNIPILE_API_KEY;
  if (!key) throw new Error('UNIPILE_API_KEY not configured');
  return { 'X-API-KEY': key, 'Content-Type': 'application/json', accept: 'application/json' };
};

// Backend URL — used for webhook registration and OAuth redirects (must be the Express server, not the frontend CDN)
const publicBase = () =>
  (process.env.BACKEND_URL || process.env.API_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');


// ── Unipile API helpers ────────────────────────────────────────────────────────

async function createHostedAuthLink(workspaceId, ownerUserId) {
  // expiresOn must be in the future — Unipile also expires links on daily restart
  const expiresOn = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z');

  // Carry the connecting member through the redirect so the (unauthenticated)
  // callback can stamp owner_user_id on the connection — without it, LinkedIn
  // messages ingest unowned and leak to every member (PRIVACY_MODEL.md).
  const ownerParam = ownerUserId ? `&owner_user_id=${ownerUserId}` : '';
  const res = await fetch(`${BASE()}/hosted/accounts/link`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      type: 'create',
      providers: ['LINKEDIN'],
      expiresOn,
      success_redirect_url: `${publicBase()}/api/linkedin/callback?workspace_id=${workspaceId}${ownerParam}`,
      failure_redirect_url: `${publicBase()}/api/linkedin/callback?workspace_id=${workspaceId}&error=auth_failed`,
      api_url: BASE(),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile auth link failed (${res.status}): ${err}`);
  }
  return res.json(); // { object: 'HostedAuthLink', url: '...' }
}

async function getAccountDetails(accountId) {
  const res = await fetch(`${BASE()}/accounts/${accountId}`, { headers: headers() });
  if (!res.ok) return null;
  return res.json();
}

async function deleteAccount(accountId) {
  await fetch(`${BASE()}/accounts/${accountId}`, { method: 'DELETE', headers: headers() });
}

/**
 * The one place that knows where Unipile should push LinkedIn events.
 *
 * It has to be a URL that actually exists. Both callers used to build this string
 * themselves and both pointed at /api/linkedin/webhook, which no route has ever
 * registered: the API's 404 catch-all answered it, Unipile received a 200-shaped
 * nothing, and every inbound LinkedIn message and new connection was dropped on the
 * floor. The real handler is /inbound/linkedin on the worker (Caddy routes /inbound/*
 * there), and it needs the workspace on the query string because it runs without
 * session auth, plus the shared secret because Unipile does not sign payloads.
 *
 * Two callers, one string. The bug was possible because there were two of each.
 */
export function linkedinWebhookUrl(workspaceId) {
  const secret = process.env.LINKEDIN_WEBHOOK_SECRET;
  return `${publicBase()}/inbound/linkedin?workspace_id=${encodeURIComponent(workspaceId)}`
    + (secret ? `&secret=${encodeURIComponent(secret)}` : '');
}

// Register (or update) the Unipile webhook for a given account so push events arrive
// at our server. Unipile de-dupes by URL — safe to call on every connect.
async function ensureWebhookRegistered(accountId, workspaceId) {
  const url = linkedinWebhookUrl(workspaceId);
  try {
    const res = await fetch(`${BASE()}/webhooks`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        account_id: accountId,
        url,
        events: ['message_received', 'new_relation'],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[LINKEDIN] Webhook registration returned ${res.status}: ${err}`);
    } else {
      console.log(`[LINKEDIN] Webhook registered → ${url}`);
    }
  } catch (e) {
    console.warn('[LINKEDIN] Webhook registration failed (non-fatal):', e.message);
  }
}

// Parse "Co-Founder @ Prospect Engine | ..." → { job_title, company }. LinkedIn
// headlines overwhelmingly follow a "Role @ Company" / "Role at Company" convention;
// we only extract when that pattern is present (high precision) so we never write a
// guessed title that would pollute the ICP score.
function parseHeadline(headline) {
  if (!headline || typeof headline !== 'string') return { job_title: null, company: null };
  for (const seg of headline.split(/[|·•–—\n]+/).map(s => s.trim()).filter(Boolean)) {
    const m = seg.match(/^(.{2,60}?)\s+(?:@|at)\s+(.{2,80})$/i);
    if (m) {
      const job_title = m[1].trim().replace(/[,;:]+$/, '');
      const company   = m[2].trim().replace(/[,;:.]+$/, '');
      if (job_title && company) return { job_title, company };
    }
  }
  return { job_title: null, company: null };
}

// Fetch a LinkedIn member's profile from Unipile — returns { photo_url, job_title,
// company }, any of which may be null. Silently fails so a missing profile never
// blocks the sync. The /users/{id} response has no structured work history, so title
// + company come from the headline; the photo is free in the same call.
async function fetchLinkedInProfile(accountId, memberId) {
  if (!memberId) return { photo_url: null, job_title: null, company: null, email: null, phone: null, headline: null };
  try {
    const url = `${BASE()}/users/${encodeURIComponent(memberId)}?account_id=${encodeURIComponent(accountId)}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return { photo_url: null, job_title: null, company: null, email: null, phone: null, headline: null };
    const d = await res.json();
    const photo_url = d.profile_picture_url || d.profile_picture_url_large || null;
    const { job_title, company } = parseHeadline(d.headline);
    // First-degree connections often expose their real email/phone in the profile.
    const email = (d.contact_info?.emails || []).find(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || '')) || null;
    const phone = d.contact_info?.phones?.[0] || null;
    // public_identifier is the vanity slug (e.g. "jordan-lee") — the only URL
    // form post-scrapers accept. DM-sourced contacts arrive without it.
    const publicId = d.public_identifier || d.publicIdentifier || null;
    return { photo_url, job_title, company, email, phone, headline: d.headline || null, public_identifier: publicId };
  } catch {
    return { photo_url: null, job_title: null, company: null, email: null, phone: null, headline: null, public_identifier: null };
  }
}

// Build a member_id (ACoAA… URN) → public vanity URL map from the Unipile
// sources that reliably expose a real handle: chat attendees (profile_url) and
// connection relations (public_profile_url / public_identifier). These are the
// same fields the contact-history enricher and connection sync already trust —
// far more dependable than the /users/{id} profile fetch, which is used only as
// a last-resort fallback. Member-URN values are filtered out, never stored.
async function buildHandleMap(accountId) {
  const map = new Map();
  const add = (memberId, url) => {
    if (memberId && url && !map.has(memberId) && isVanityLinkedInUrl(url)) {
      map.set(memberId, normaliseLinkedInUrl(url));
    }
  };
  try {
    const attendees = await fetchAllPages(`${BASE()}/chat_attendees`, accountId);
    for (const a of attendees) {
      add(a.provider_id, a.profile_url
        || (a.public_identifier ? `https://www.linkedin.com/in/${a.public_identifier}` : null));
    }
  } catch (e) {
    console.error('[UNIPILE] chat_attendees fetch failed:', e.message);
  }
  try {
    const relations = await fetchAllPages(`${BASE()}/users/relations`, accountId);
    for (const r of relations) {
      const url = r.public_profile_url
        || (r.public_identifier ? `https://www.linkedin.com/in/${r.public_identifier}` : null);
      add(r.member_id, url);
      add(r.provider_id, url);
    }
  } catch (e) {
    console.error('[UNIPILE] relations fetch failed:', e.message);
  }
  return map;
}

// Paginate through all items from a Unipile list endpoint
async function fetchAllPages(url, accountId) {
  const items = [];
  let cursor = null;
  do {
    const u = new URL(url);
    u.searchParams.set('account_id', accountId);
    u.searchParams.set('limit', '100');
    if (cursor) u.searchParams.set('cursor', cursor);
    const res = await fetch(u.toString(), { headers: headers() });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[UNIPILE] fetchAllPages ${u.toString()} → ${res.status}: ${errText}`);
      break;
    }
    const body = await res.json();
    if (Array.isArray(body.items)) items.push(...body.items);
    cursor = body.cursor || null;
  } while (cursor);
  return items;
}

// ── Sync helpers ──────────────────────────────────────────────────────────────

// Normalise a LinkedIn profile URL to a consistent format for matching
function normaliseLinkedInUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    // keep only /in/username — strip query, trailing slash, www prefix
    const match = u.pathname.match(/\/in\/([^/]+)/);
    if (!match) return null;
    return `https://www.linkedin.com/in/${match[1]}`;
  } catch {
    return null;
  }
}

// The /in/ slug of a LinkedIn URL, or null.
function linkedInSlug(url) {
  return (url || '').match(/\/in\/([^/?#]+)/i)?.[1] || null;
}

// LinkedIn "member URN" slugs (ACoAA…) are internal, opaque IDs — NOT public
// vanity handles. They render as /in/ACoAA… links that resolve in a logged-in
// browser but are not stable public identifiers and are NOT scrapeable by
// post-search actors. We never store one as a contact's linkedin_url.
function isMemberUrnSlug(slug) {
  return !!slug && /^acoaa/i.test(slug);
}

// True when a URL is a real, scrapeable vanity profile (not a member URN).
function isVanityLinkedInUrl(url) {
  const slug = linkedInSlug(url);
  return !!slug && !isMemberUrnSlug(slug);
}

// Find a Nous contact by LinkedIn URL, member ID, or full name
async function matchContact(supabase, workspaceId, { profileUrl, fullName, memberId }) {
  // 1. Normalize URL match (handles trailing slash variants)
  const normUrl = normaliseLinkedInUrl(profileUrl);
  if (normUrl) {
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .ilike('linkedin_url', `${normUrl}%`)
      .maybeSingle();
    if (data) return data.id;
  }
  // 2. Member ID match — Unipile returns provider_id (ACoAA...) for chat attendees
  if (memberId) {
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('linkedin_member_id', memberId)
      .maybeSingle();
    if (data) return data.id;
    // Also check channels->linkedin->member_id for contacts populated via backfill
    const { data: d2 } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .contains('channels', { linkedin: { member_id: memberId } })
      .maybeSingle();
    if (d2) return d2.id;
  }
  // 3. Name match fallback
  if (fullName) {
    const parts = fullName.trim().split(/\s+/);
    const first = parts[0];
    const last  = parts.slice(1).join(' ');
    if (first && last) {
      const { data } = await supabase
        .from('contacts')
        .select('id')
        .eq('workspace_id', workspaceId)
        .ilike('first_name', first)
        .ilike('last_name', last)
        .maybeSingle();
      if (data) return data.id;
    }
  }
  return null;
}

// Write a deduped activity log entry (skip if same type+source already logged today)
async function logActivity(supabase, { workspaceId, contactId, activityType, description, occurredAt, rawData }) {
  // Day-bucket dedup via the v2 observations external_id uniqueness.
  const dayKey = new Date(occurredAt).toISOString().slice(0, 10);
  const externalId = `linkedin_${contactId}_${activityType}_${dayKey}`;
  await coreLogActivity(supabase, {
    workspaceId,
    contactId,
    type: activityType,
    source: 'linkedin',
    externalId,
    occurredAt,
    description,
    rawData,
  });
}

// Pull LinkedIn connections from Unipile → match contacts → log new connections
async function syncConnections(supabase, workspaceId, accountId) {
  const relations = await fetchAllPages(`${BASE()}/users/relations`, accountId);
  let matched = 0;

  for (const rel of relations) {
    const profileUrl = rel.public_profile_url || (rel.public_identifier
      ? `https://www.linkedin.com/in/${rel.public_identifier}` : null);
    const fullName = [rel.first_name, rel.last_name].filter(Boolean).join(' ') || null;
    const contactId = await matchContact(supabase, workspaceId, {
      profileUrl: profileUrl || rel.profile_url,
      memberId:   rel.member_id || null,
      fullName,
    });
    if (!contactId) continue;

    // Patch linkedin_url, photo, title, company, email, phone onto contact if missing
    const { data: contactSnap } = await supabase
      .from('contacts')
      .select('linkedin_url, photo_url, job_title, company, email, phone')
      .eq('id', contactId)
      .single();

    const contactUpdates = {};
    // Only store a real vanity URL as linkedin_url — never a member-URN form.
    if (isVanityLinkedInUrl(profileUrl) && !isVanityLinkedInUrl(contactSnap?.linkedin_url))
      contactUpdates.linkedin_url = normaliseLinkedInUrl(profileUrl);
    // One profile fetch fills any of photo / title / company / email / phone still empty.
    if (!contactSnap?.photo_url || !contactSnap?.job_title || !contactSnap?.company
        || !contactSnap?.email || !contactSnap?.phone) {
      const profile = await fetchLinkedInProfile(accountId, rel.member_id);
      if (profile.photo_url && !contactSnap?.photo_url) contactUpdates.photo_url = profile.photo_url;
      if (profile.job_title && !contactSnap?.job_title) contactUpdates.job_title = profile.job_title;
      if (profile.company   && !contactSnap?.company)   contactUpdates.company   = profile.company;
      if (profile.phone     && !contactSnap?.phone)     contactUpdates.phone     = profile.phone;
      // Real email straight from the LinkedIn profile (contact_info.emails).
      const cleanEmail = profile.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(profile.email)
        ? profile.email.toLowerCase().trim() : null;
      if (cleanEmail && !contactSnap?.email) {
        contactUpdates.email = cleanEmail;
        await supabase.from('entity_identifiers')
          .upsert({ workspace_id: workspaceId, entity_id: contactId, kind: 'email', value: cleanEmail },
            { onConflict: 'workspace_id,kind,value', ignoreDuplicates: true }).then(null, () => {});
      }
      // Fallback to the relation's own headline when the profile call yields no title.
      if (!contactUpdates.job_title && !contactSnap?.job_title && rel.headline) {
        const fromRel = parseHeadline(rel.headline);
        if (fromRel.job_title) contactUpdates.job_title = fromRel.job_title;
        if (fromRel.company && !contactUpdates.company && !contactSnap?.company)
          contactUpdates.company = fromRel.company;
      }
    }
    if (Object.keys(contactUpdates).length)
      await supabase.from('contacts').update(contactUpdates).eq('id', contactId);

    // Score ICP once we have a title or company (free — role-based, no paid provider).
    if ((contactUpdates.job_title || contactUpdates.company)) {
      const scored = { id: contactId, workspace_id: workspaceId, ...contactSnap, ...contactUpdates };
      await scoreICP(supabase, workspaceId, scored).catch(() => {});
    }

    const connectedAt = rel.created_at ? new Date(rel.created_at).toISOString() : new Date().toISOString();
    await logActivity(supabase, {
      workspaceId,
      contactId,
      activityType: 'linkedin_connected',
      description:  `LinkedIn connection${fullName ? ` with ${fullName}` : ''}`,
      occurredAt:   connectedAt,
      rawData:      { member_id: rel.member_id, full_name: fullName, headline: rel.headline },
    });

    // Update channels.linkedin with connection state
    const { data: cd } = await supabase.from('contacts').select('channels').eq('id', contactId).single();
    const ch = cd?.channels || {};
    const li = ch.linkedin || {};
    await supabase.from('contacts').update({
      channels: {
        ...ch,
        linkedin: {
          ...li,
          url:          normaliseLinkedInUrl(profileUrl || rel.profile_url) || li.url,
          member_id:    rel.member_id || li.member_id,
          state:        'connected',
          connected_at: li.connected_at || connectedAt,
          synced_at:    new Date().toISOString(),
        },
      },
    }).eq('id', contactId);

    matched++;
  }

  return { total: relations.length, matched };
}

// Pull LinkedIn conversations from Unipile → update last_touch for matched contacts
async function syncConversations(supabase, workspaceId, accountId) {
  const chats = await fetchAllPages(`${BASE()}/chats`, accountId);
  // One fetch of the confirmed-reliable handle sources, reused for every chat.
  const handleMap = await buildHandleMap(accountId);
  let matched = 0;

  for (const chat of chats) {
    // The /chats list response does NOT embed an attendees array.
    // The other person's provider_id and name are top-level fields on the chat object.
    const memberId = chat.attendee_provider_id || null;
    const contactId = await matchContact(supabase, workspaceId, {
      profileUrl: null,
      memberId,
      fullName: chat.name,
    });
    if (!contactId) continue;

    const lastMsgAt = chat.timestamp;
    if (!lastMsgAt) continue;

    // Update contact's last_activity_at if this message is newer
    try {
      await supabase.rpc('update_last_activity_if_newer', {
        p_contact_id: contactId,
        p_occurred_at: lastMsgAt,
      });
    } catch {
      // rpc may not exist — silently skip
    }

    // Store chat_id in channels.linkedin for fast outbound message lookup.
    const { data: cd } = await supabase
      .from('contacts')
      .select('channels, linkedin_url, linkedin_member_id')
      .eq('id', contactId)
      .single();
    const ch = cd?.channels || {};
    const li = ch.linkedin || {};
    const liUpdate = { ...li, chat_id: chat.id, synced_at: new Date().toISOString() };
    const contactUpdates = {};

    // Persist the member URN so future syncs / backfills can resolve the handle.
    if (memberId && !cd?.linkedin_member_id) contactUpdates.linkedin_member_id = memberId;

    // DM-sourced contacts arrive with only a member URN — no public vanity
    // handle, which is the only form post-scrapers accept. Resolve it once from
    // Unipile and store a real linkedin_url so the contact becomes scrapeable.
    // Prefer the confirmed sources (chat attendees / relations, via handleMap);
    // fall back to a /users/{id} profile fetch only if they miss. Self-heals
    // existing DM contacts on the next sync.
    if (memberId && !isVanityLinkedInUrl(cd?.linkedin_url)) {
      let vanityUrl = handleMap.get(memberId) || null;
      if (!vanityUrl) {
        const profile = await fetchLinkedInProfile(accountId, memberId);
        if (profile.public_identifier && !isMemberUrnSlug(profile.public_identifier)) {
          vanityUrl = `https://www.linkedin.com/in/${profile.public_identifier}`;
        }
      }
      if (vanityUrl) {
        contactUpdates.linkedin_url = vanityUrl;
        liUpdate.url = vanityUrl;
        liUpdate.member_id = liUpdate.member_id || memberId;
      }
    }

    contactUpdates.channels = { ...ch, linkedin: liUpdate };
    await supabase.from('contacts').update(contactUpdates).eq('id', contactId);

    matched++;
  }

  return { total: chats.length, matched };
}

// Main sync entry point — call for one workspace
export async function runLinkedInSync(supabase, workspaceId) {
  const { data: conn } = await supabase
    .from('workspace_linkedin_connections')
    .select('unipile_account_id')
    .eq('workspace_id', workspaceId)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conn) return { skipped: true, reason: 'not_connected' };

  console.log(`[LINKEDIN_SYNC] starting for workspace ${workspaceId}, account ${conn.unipile_account_id}`);
  // Sequential: connections first so member_id is written before conversations tries to match
  const connections  = await syncConnections(supabase, workspaceId, conn.unipile_account_id);
  const conversations = await syncConversations(supabase, workspaceId, conn.unipile_account_id);
  console.log(`[LINKEDIN_SYNC] done — connections:`, connections, 'conversations:', conversations);

  await supabase
    .from('workspace_linkedin_connections')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId);

  return { connections, conversations };
}

// Poll pending sent invitations and detect acceptances.
// Much lighter than a full syncConnections — only fetches the small pending-invites list.
// Runs every 5 minutes in-process.
export async function pollInviteAcceptances(supabase, workspaceId) {
  const { data: conn } = await supabase
    .from('workspace_linkedin_connections')
    .select('unipile_account_id')
    .eq('workspace_id', workspaceId)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conn) return { checked: 0, accepted: 0 };

  // Fetch all pending sent invitations from Unipile (paginated)
  const pendingMemberIds = new Set();
  let cursor = null;
  do {
    const params = new URLSearchParams({ account_id: conn.unipile_account_id, limit: '250' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${BASE()}/users/invite/sent?${params}`, { headers: headers() });
    if (!res.ok) {
      console.warn('[INVITE_POLL] Unipile invite/sent failed:', res.status);
      break;
    }
    const data = await res.json();
    for (const item of data.items || []) {
      if (item.invited_user_id) pendingMemberIds.add(item.invited_user_id);
    }
    cursor = data.cursor || null;
  } while (cursor);

  // Find contacts in this workspace still sitting at invite_sent
  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, linkedin_member_id, channels, company_id')
    .eq('workspace_id', workspaceId)
    .filter('channels->linkedin->>state', 'eq', 'invite_sent');

  if (!contacts?.length) return { checked: 0, accepted: 0 };

  let accepted = 0;
  for (const contact of contacts) {
    const memberId = contact.linkedin_member_id;
    if (!memberId) continue;

    // Still pending → skip
    if (pendingMemberIds.has(memberId)) continue;

    // No longer pending → they accepted (or withdrew, rare)
    const now = new Date().toISOString();
    const ch = contact.channels || {};
    const li = ch.linkedin || {};

    const { error: upErr } = await supabase.from('contacts').update({
      channels: { ...ch, linkedin: { ...li, state: 'connected', connected_at: now } },
    }).eq('id', contact.id);
    if (upErr) { console.error('[INVITE_POLL] update failed:', upErr.message); continue; }

    await logActivity(supabase, {
      workspaceId,
      contactId:    contact.id,
      activityType: 'linkedin_connected',
      description:  'Connected on LinkedIn (accepted invite)',
      occurredAt:   now,
      rawData:      { detected_by: 'invite_poll', member_id: memberId },
    });

    console.log(`[INVITE_POLL] Accepted: contact ${contact.id} (member ${memberId})`);
    accepted++;
  }

  return { checked: contacts.length, accepted };
}

// Send a LinkedIn DM — creates a new chat or uses existing one
export async function sendLinkedInMessage(accountId, linkedinUserId, text) {
  const res = await fetch(`${BASE()}/chats`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      account_id: accountId,
      attendees_ids: [linkedinUserId],
      text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile send message failed (${res.status}): ${err}`);
  }
  return res.json();
}

// Send a LinkedIn connection request with an optional note
export async function sendConnectionRequest(accountId, linkedinUserId, message = '') {
  const body = { account_id: accountId, provider_id: linkedinUserId };
  if (message) body.message = message;

  const res = await fetch(`${BASE()}/users/invite`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile connection request failed (${res.status}): ${err}`);
  }
  return res.json();
}


// Resolve a linkedin_url to a Unipile member ID (the ACoAA... format).
// Check the contacts table first; fall back to a Unipile profile fetch.
export async function resolveLinkedInMemberId(supabase, workspaceId, accountId, { linkedinUrl, linkedinMemberId }) {
  if (linkedinMemberId) return linkedinMemberId;

  const normUrl = normaliseLinkedInUrl(linkedinUrl);
  if (!normUrl) throw new Error('Invalid LinkedIn URL');

  // Check contacts table first (fastest path, no Unipile call)
  const { data: contact } = await supabase
    .from('contacts')
    .select('linkedin_member_id')
    .eq('workspace_id', workspaceId)
    .ilike('linkedin_url', normUrl)
    .maybeSingle();

  if (contact?.linkedin_member_id) return contact.linkedin_member_id;

  // Fall back to Unipile profile lookup using the slug
  const slug = normUrl.match(/\/in\/([^/]+)/)?.[1];
  if (!slug) throw new Error(`Could not extract slug from LinkedIn URL: ${linkedinUrl}`);

  const res = await fetch(`${BASE()}/users/${slug}?account_id=${accountId}`, { headers: headers() });
  if (!res.ok) throw new Error(`Unipile profile lookup failed for ${slug} (${res.status})`);

  const profile = await res.json();
  const memberId = profile.provider_id || profile.id;
  if (!memberId) throw new Error(`No member ID returned for LinkedIn profile: ${slug}`);

  return memberId;
}

// Fetch a LinkedIn post from Unipile and return its social_id.
// Unipile accepts the full post URL (URL-encoded) as the path identifier.
async function resolvePostSocialId(accountId, postUrl) {
  const params = new URLSearchParams({ account_id: accountId });
  const res = await fetch(`${BASE()}/posts/${encodeURIComponent(postUrl)}?${params}`, { headers: headers() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile post lookup failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  const socialId = data.social_id || data.id;
  if (!socialId) throw new Error('Could not resolve post social_id — Unipile returned no ID for this URL');
  return socialId;
}

// Reply to an existing Unipile chat thread
async function replyToChat(chatId, text) {
  const res = await fetch(`${BASE()}/chats/${chatId}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile reply failed (${res.status}): ${err}`);
  }
  return res.json();
}


// ── Route handlers ─────────────────────────────────────────────────────────────

export function registerLinkedInRoutes(app, supabase, verifySupabaseAuth, verifyAuthEither) {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // GET /api/linkedin/status?workspaceId=...
  // Returns whether this workspace has LinkedIn connected
  app.get('/api/linkedin/status', verifySupabaseAuth, async (req, res) => {
    try {
      const { workspaceId } = req.query;
      if (!workspaceId || !uuidRe.test(workspaceId))
        return res.status(400).json({ error: 'invalid_workspace_id' });

      const { data: rows } = await supabase
        .from('workspace_linkedin_connections')
        .select('id, unipile_account_id, linkedin_name, linkedin_headline, linkedin_profile_url, connected_at')
        .eq('workspace_id', workspaceId)
        .order('connected_at', { ascending: false });
      const connections = rows || [];
      const slot = await checkLinkedinSlot(supabase, workspaceId);

      return res.json({
        connected: connections.length > 0,
        connection: connections[0] || null, // backward-compat: the newest connection
        connections,
        limit: slot.limit,
        used: slot.used,
        can_connect_more: slot.allowed,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/linkedin/connect?workspaceId=...
  // Creates a Unipile hosted auth link and returns it
  app.get('/api/linkedin/connect', verifySupabaseAuth, async (req, res) => {
    try {
      const { workspaceId } = req.query;
      if (!workspaceId || !uuidRe.test(workspaceId))
        return res.status(400).json({ error: 'invalid_workspace_id' });

      if (!process.env.UNIPILE_API_KEY || !process.env.UNIPILE_DSN)
        return res.status(503).json({ error: 'linkedin_not_configured', message: 'Unipile credentials not yet set up' });

      // Gate: connected-LinkedIn count is the one plan-limited resource. Block
      // before starting the Unipile auth flow so the user isn't sent through
      // OAuth only to be rejected on save.
      const slot = await checkLinkedinSlot(supabase, workspaceId);
      if (!slot.allowed) {
        return res.status(402).json({
          error: 'linkedin_limit_reached',
          limit: slot.limit,
          used: slot.used,
          current_plan: slot.plan,
          upgrade_url: '/settings?section=billing',
          message: slot.limit === 0
            ? `Connecting a LinkedIn account isn't available on the ${slot.planName} plan. Upgrade to connect LinkedIn.`
            : `You've connected ${slot.used} of ${slot.limit} LinkedIn account${slot.limit === 1 ? '' : 's'} on the ${slot.planName} plan. Upgrade or contact us to add more.`,
        });
      }

      // Stamp the connection with the connecting member so their LinkedIn messages
      // ingest attributed to them (and stay private to them). See PRIVACY_MODEL.md.
      const { url } = await createHostedAuthLink(workspaceId, req.internalUserId ?? null);
      return res.json({ url });
    } catch (err) {
      console.error('[LINKEDIN_CONNECT] error:', err.message, '| DSN:', process.env.UNIPILE_DSN, '| key set:', !!process.env.UNIPILE_API_KEY);
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/linkedin/callback?workspace_id=...&account_id=...
  // Unipile redirects here after successful LinkedIn auth
  app.get('/api/linkedin/callback', async (req, res) => {
    const { workspace_id, account_id, error, owner_user_id } = req.query;

    if (error || !workspace_id || !account_id) {
      return res.send(`<html><body><script>
        window.opener?.postMessage({ type: 'linkedin_auth', success: false, error: '${error || 'missing_params'}' }, '*');
        window.close();
      </script><p>Authentication failed. You can close this window.</p></body></html>`);
    }

    try {
      // Fetch account details from Unipile. The LinkedIn identity lives under
      // connection_params.im — `sources` is an array of {id,status} channels,
      // NOT an object keyed by 'LINKEDIN', and there's no profile_url field.
      // We build the profile URL from the public identifier (the vanity slug).
      const details = await getAccountDetails(account_id);
      const im = details?.connection_params?.im || {};
      const publicId = im.public_identifier || im.publicIdentifier || null;
      const profileUrl = publicId ? `https://www.linkedin.com/in/${publicId}` : null;
      const name = im.username || details?.name || null;
      const headline = im.headline || null;

      // Upsert into DB
      // Upsert keyed on (workspace_id, unipile_account_id): re-connecting the same
      // account updates it; a different account inserts a new row (multi-account).
      await supabase.from('workspace_linkedin_connections').upsert({
        workspace_id,
        unipile_account_id: account_id,
        linkedin_name:        name,
        linkedin_headline:    headline,
        linkedin_profile_url: profileUrl,
        connected_at:         new Date().toISOString(),
        ...(owner_user_id ? { owner_user_id } : {}),
      }, { onConflict: 'workspace_id,unipile_account_id' });

      // Register webhook so Unipile pushes events to us
      await ensureWebhookRegistered(account_id, workspace_id);

      return res.send(`<html><body><script>
        window.opener?.postMessage({ type: 'linkedin_auth', success: true }, '*');
        window.close();
      </script><p>LinkedIn connected! You can close this window.</p></body></html>`);
    } catch (err) {
      console.error('[LINKEDIN_CALLBACK]', err.message);
      return res.send(`<html><body><script>
        window.opener?.postMessage({ type: 'linkedin_auth', success: false, error: 'save_failed' }, '*');
        window.close();
      </script><p>Error saving connection. Please try again.</p></body></html>`);
    }
  });

  // DELETE /api/linkedin/disconnect?workspaceId=...
  app.delete('/api/linkedin/disconnect', verifySupabaseAuth, async (req, res) => {
    try {
      const { workspaceId, accountId } = req.query;
      if (!workspaceId || !uuidRe.test(workspaceId))
        return res.status(400).json({ error: 'invalid_workspace_id' });

      // Disconnect one specific account (accountId = unipile_account_id) or, when
      // none is given, every LinkedIn account in the workspace (back-compat).
      let read = supabase
        .from('workspace_linkedin_connections')
        .select('unipile_account_id')
        .eq('workspace_id', workspaceId);
      if (accountId) read = read.eq('unipile_account_id', accountId);
      const { data: rows } = await read;

      for (const row of rows || []) {
        if (row.unipile_account_id && process.env.UNIPILE_API_KEY) {
          await deleteAccount(row.unipile_account_id).catch(() => {});
        }
      }

      let del = supabase.from('workspace_linkedin_connections').delete().eq('workspace_id', workspaceId);
      if (accountId) del = del.eq('unipile_account_id', accountId);
      await del;
      return res.json({ success: true, removed: (rows || []).length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/linkedin/message
  // Body: { workspaceId, linkedinUserId, text }
  app.post('/api/linkedin/message', verifySupabaseAuth, async (req, res) => {
    try {
      const { workspaceId, linkedinUserId, text } = req.body;
      if (!workspaceId || !linkedinUserId || !text)
        return res.status(400).json({ error: 'missing_params' });
      if (!uuidRe.test(workspaceId))
        return res.status(400).json({ error: 'invalid_workspace_id' });

      const { data: conn } = await supabase
        .from('workspace_linkedin_connections')
        .select('unipile_account_id')
        .eq('workspace_id', workspaceId)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!conn) return res.status(404).json({ error: 'linkedin_not_connected' });

      const result = await sendLinkedInMessage(conn.unipile_account_id, linkedinUserId, text);
      return res.json({ success: true, result });
    } catch (err) {
      console.error('[LINKEDIN_MESSAGE]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/linkedin/sync?workspaceId=...
  // Manual trigger — runs the same job as the nightly cron
  app.post('/api/linkedin/sync', verifySupabaseAuth, async (req, res) => {
    try {
      const { workspaceId } = req.query;
      if (!workspaceId || !uuidRe.test(workspaceId))
        return res.status(400).json({ error: 'invalid_workspace_id' });

      const result = await runLinkedInSync(supabase, workspaceId);
      return res.json({ success: true, ...result });
    } catch (err) {
      console.error('[LINKEDIN_SYNC]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/linkedin/engagement/scrape
  // On-demand engager scrape — "scrape engagers for my last posts / backfill the
  // last N days now", instead of waiting for the weekly cron. Queues the request
  // (the worker poller runs it within a minute); does NOT block on the scrape.
  // Workspace derived from auth (API key from the MCP tool, or Supabase JWT with
  // workspaceId in body for the app). Body: { days? } — default 7, max 120.
  app.post('/api/linkedin/engagement/scrape', verifyAuthEither, async (req, res) => {
    try {
      const workspaceId = req.workspaceId;
      if (!workspaceId) return res.status(401).json({ error: 'auth_required' });

      const days = Math.min(120, Math.max(1, Math.round(Number(req.body?.days) || 7)));

      const { data: conns } = await supabase
        .from('workspace_linkedin_connections')
        .select('linkedin_profile_url, last_engagement_scrape_at')
        .eq('workspace_id', workspaceId)
        .not('linkedin_profile_url', 'is', null);
      const usable = conns || [];
      if (!usable.length) return res.status(404).json({ error: 'linkedin_not_connected' });

      // Same plan gate the weekly run enforces (worker isEligible) so the user gets
      // a clear answer here instead of a silently-dropped request. Self-host + the
      // dogfood allowlist always pass; cloud needs an active Pro/Growth/Partner plan.
      if (process.env.SELF_HOSTED !== 'true') {
        const allow = new Set((process.env.LINKEDIN_ENGAGEMENT_WORKSPACES || '')
          .split(',').map(s => s.trim()).filter(Boolean));
        if (!allow.has(workspaceId)) {
          const { data: ws } = await supabase
            .from('workspaces').select('team_id').eq('id', workspaceId).maybeSingle();
          const { data: sub } = ws?.team_id ? await supabase
            .from('subscriptions').select('plan_id, status').eq('team_id', ws.team_id).maybeSingle() : { data: null };
          const dead = !sub || ['canceled', 'incomplete_expired', 'past_due'].includes(sub.status);
          const paid = sub && ['pro', 'growth', 'scale'].includes(sub.plan_id);
          if (dead || !paid) return res.status(403).json({ error: 'needs_plan', message: 'LinkedIn engager scraping is on the Pro plan and up.' });
        }
      }

      // Pure BYOK on Cloud: an Apify key must be connected (self-host falls back to
      // the APIFY_TOKEN env; the dogfood/pilot allowlist may use the shared key, so
      // both are exempt).
      const byokAllow = new Set((process.env.LINKEDIN_ENGAGEMENT_WORKSPACES || '')
        .split(',').map(s => s.trim()).filter(Boolean));
      if (process.env.SELF_HOSTED !== 'true' && !byokAllow.has(workspaceId)) {
        const { data: provider } = await supabase
          .from('workflow_providers').select('id').eq('name', 'apify').maybeSingle();
        let hasKey = false;
        if (provider?.id) {
          const { data: pc } = await supabase
            .from('workflow_provider_connections')
            .select('id').eq('workspace_id', workspaceId).eq('provider_id', provider.id)
            .eq('is_verified', true).limit(1).maybeSingle();
          hasKey = !!pc;
        }
        if (!hasKey) {
          return res.status(400).json({
            error: 'apify_not_connected',
            message: 'Connect your own Apify key in Integrations first — engager scraping is bring-your-own-key and runs on your Apify account.',
          });
        }
      }

      const lastScrapedAt = usable
        .map(c => c.last_engagement_scrape_at).filter(Boolean)
        .sort().slice(-1)[0] || null;

      const { error: updErr } = await supabase
        .from('workspace_linkedin_connections')
        .update({ engagement_scrape_requested_days: days, engagement_scrape_requested_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .not('linkedin_profile_url', 'is', null);
      if (updErr) return res.status(500).json({ error: updErr.message });

      return res.json({
        queued: true,
        days,
        accounts: usable.length,
        last_scraped_at: lastScrapedAt,
      });
    } catch (err) {
      console.error('[LINKEDIN_ENGAGEMENT_SCRAPE]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/linkedin/invite
  // Body: { workspaceId, linkedinUserId, message? }
  app.post('/api/linkedin/invite', verifySupabaseAuth, async (req, res) => {
    try {
      const { workspaceId, linkedinUserId, message } = req.body;
      if (!workspaceId || !linkedinUserId)
        return res.status(400).json({ error: 'missing_params' });
      if (!uuidRe.test(workspaceId))
        return res.status(400).json({ error: 'invalid_workspace_id' });

      const { data: conn } = await supabase
        .from('workspace_linkedin_connections')
        .select('unipile_account_id')
        .eq('workspace_id', workspaceId)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!conn) return res.status(404).json({ error: 'linkedin_not_connected' });

      const result = await sendConnectionRequest(conn.unipile_account_id, linkedinUserId, message);
      return res.json({ success: true, result });
    } catch (err) {
      console.error('[LINKEDIN_INVITE]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/linkedin/send-invite
  // Internal proxy endpoint — accepts a linkedin_url instead of a raw member ID.
  // Resolves the member ID internally (contacts table → Unipile fallback).
  // Workspace derived from auth (API key or Supabase JWT with workspaceId in body/query).
  // Body: { linkedin_url, linkedin_member_id?, note? }
  app.post('/api/linkedin/send-invite', verifyAuthEither, async (req, res) => {
    try {
      const { linkedin_url, linkedin_member_id, note } = req.body;
      const workspaceId = req.workspaceId;
      if (!workspaceId)
        return res.status(401).json({ error: 'auth_required' });
      if (!linkedin_url)
        return res.status(400).json({ error: 'missing_params', required: ['linkedin_url'] });
      if (note && note.length > 300)
        return res.status(400).json({ error: 'note_too_long', max: 300 });

      const { data: conn } = await supabase
        .from('workspace_linkedin_connections')
        .select('unipile_account_id')
        .eq('workspace_id', workspaceId)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!conn) return res.status(404).json({ error: 'linkedin_not_connected' });

      const memberId = await resolveLinkedInMemberId(supabase, workspaceId, conn.unipile_account_id, {
        linkedinUrl: linkedin_url,
        linkedinMemberId: linkedin_member_id,
      });

      const result = await sendConnectionRequest(conn.unipile_account_id, memberId, note || '');

      // Advance state to invite_sent immediately — don't wait for the webhook
      const normUrl = normaliseLinkedInUrl(linkedin_url);
      if (normUrl) {
        const { data: contact } = await supabase
          .from('contacts')
          .select('id, channels')
          .eq('workspace_id', workspaceId)
          .ilike('linkedin_url', normUrl)
          .maybeSingle();
        if (contact && !['connected'].includes(contact.channels?.linkedin?.state)) {
          const ch = contact.channels || {};
          const li = ch.linkedin || {};
          const now = new Date().toISOString();
          const { error: updateErr } = await supabase.from('contacts').update({
            channels: {
              ...ch,
              linkedin: {
                ...li,
                state:        'invite_sent',
                state_origin: 'outbound',
                invited_at:   li.invited_at || now,
                synced_at:    now,
                ...(result?.id && { invite_id: result.id }),
              },
            },
          }).eq('id', contact.id);
          if (updateErr) console.error('[LINKEDIN_SEND_INVITE] channels update failed:', updateErr.message);
        }
      }

      return res.json({ success: true, result });
    } catch (err) {
      console.error('[LINKEDIN_SEND_INVITE]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/linkedin/send-message
  // Internal proxy endpoint — accepts linkedin_url and optional chat_id.
  // If chat_id is provided: replies to that existing conversation thread.
  // If not: resolves member ID and opens a new chat.
  // Returns { chat_id } — caller should persist this for future replies.
  // Workspace derived from auth (API key or Supabase JWT with workspaceId in body/query).
  // Body: { text, linkedin_url?, linkedin_member_id?, chat_id? }
  app.post('/api/linkedin/send-message', verifyAuthEither, async (req, res) => {
    try {
      const { text, linkedin_url, linkedin_member_id, chat_id } = req.body;
      const workspaceId = req.workspaceId;
      if (!workspaceId)
        return res.status(401).json({ error: 'auth_required' });
      if (!text)
        return res.status(400).json({ error: 'missing_params', required: ['text'] });
      if (!linkedin_url && !linkedin_member_id && !chat_id)
        return res.status(400).json({ error: 'missing_params', detail: 'Provide linkedin_url, linkedin_member_id, or chat_id' });

      const { data: conn } = await supabase
        .from('workspace_linkedin_connections')
        .select('unipile_account_id')
        .eq('workspace_id', workspaceId)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!conn) return res.status(404).json({ error: 'linkedin_not_connected' });

      let result;
      let returnedChatId;

      if (chat_id) {
        result = await replyToChat(chat_id, text);
        returnedChatId = chat_id;
      } else {
        const memberId = await resolveLinkedInMemberId(supabase, workspaceId, conn.unipile_account_id, {
          linkedinUrl: linkedin_url,
          linkedinMemberId: linkedin_member_id,
        });
        result = await sendLinkedInMessage(conn.unipile_account_id, memberId, text);
        returnedChatId = result?.id || result?.chat_id || null;
      }

      // Persist chat_id to channels.linkedin — critical for outbound webhook resolution
      if (returnedChatId) {
        const normUrl = linkedin_url ? normaliseLinkedInUrl(linkedin_url) : null;
        const { data: contact } = await supabase
          .from('contacts')
          .select('id, channels')
          .eq('workspace_id', workspaceId)
          .or(
            normUrl
              ? `channels.cs.{"linkedin":{"chat_id":"${returnedChatId}"}},linkedin_url.ilike.${normUrl}`
              : `channels.cs.{"linkedin":{"chat_id":"${returnedChatId}"}}`
          )
          .maybeSingle();
        if (contact && contact.channels?.linkedin?.chat_id !== returnedChatId) {
          const ch = contact.channels || {};
          const li = ch.linkedin || {};
          const { error: chatUpdateErr } = await supabase.from('contacts').update({
            channels: {
              ...ch,
              linkedin: { ...li, chat_id: returnedChatId, synced_at: new Date().toISOString() },
            },
          }).eq('id', contact.id);
          if (chatUpdateErr) console.error('[LINKEDIN_SEND_MESSAGE] channels update failed:', chatUpdateErr.message);
        }
      }

      return res.json({ success: true, chat_id: returnedChatId, result });
    } catch (err) {
      console.error('[LINKEDIN_SEND_MESSAGE]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/linkedin/post-comment
  // Body: { post_url, text, linkedin_url? }
  // Resolves the post's social_id via Unipile, posts the comment, and optionally
  // logs a linkedin_post_comment activity against the contact identified by linkedin_url.
  // Workspace derived from auth (API key or Supabase JWT with workspaceId in body/query).
  app.post('/api/linkedin/post-comment', verifyAuthEither, async (req, res) => {
    try {
      const { post_url, text, linkedin_url } = req.body;
      const workspaceId = req.workspaceId;
      if (!workspaceId)
        return res.status(401).json({ error: 'auth_required' });
      if (!post_url || !text)
        return res.status(400).json({ error: 'missing_params', required: ['post_url', 'text'] });
      if (text.length > 1250)
        return res.status(400).json({ error: 'text_too_long', max: 1250 });

      const { data: conn } = await supabase
        .from('workspace_linkedin_connections')
        .select('unipile_account_id')
        .eq('workspace_id', workspaceId)
        .order('connected_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!conn) return res.status(404).json({ error: 'linkedin_not_connected' });

      // Resolve the post's social_id — Unipile requires this, not the URL-visible ID
      const socialId = await resolvePostSocialId(conn.unipile_account_id, post_url);

      // Post the comment via Unipile (multipart/form-data as per Unipile spec)
      const form = new FormData();
      form.append('account_id', conn.unipile_account_id);
      form.append('text', text);

      const commentRes = await fetch(`${BASE()}/posts/${encodeURIComponent(socialId)}/comments`, {
        method: 'POST',
        headers: { 'X-API-KEY': process.env.UNIPILE_API_KEY, accept: 'application/json' },
        body: form,
      });
      if (!commentRes.ok) {
        const err = await commentRes.text();
        throw new Error(`Unipile post comment failed (${commentRes.status}): ${err}`);
      }
      const commentData = await commentRes.json();
      const commentId = commentData.comment_id || null;

      // Log activity against the contact if a linkedin_url was supplied
      if (linkedin_url) {
        const contactId = await matchContact(supabase, workspaceId, { profileUrl: linkedin_url, fullName: null, memberId: null });
        if (contactId) {
          await logActivity(supabase, {
            workspaceId,
            contactId,
            activityType: 'linkedin_post_comment',
            description: 'Commented on LinkedIn post',
            occurredAt: new Date().toISOString(),
            rawData: { post_url, comment_id: commentId, text: text.slice(0, 200) },
          });
        }
      }

      return res.json({ success: true, comment_id: commentId });
    } catch (err) {
      console.error('[LINKEDIN_POST_COMMENT]', err.message);
      return res.status(500).json({ error: err.message });
    }
  });
}
