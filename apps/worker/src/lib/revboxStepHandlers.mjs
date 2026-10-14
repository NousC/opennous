// The step-engine handlers a RevBox job needs (GET-868), for the jobs the worker runs (a deal, a
// call, a signal). The API registers the same two in apps/api/src/routes/api/revboxes.mjs; the worker
// image has no apps/api in it, so the two helpers they use are mirrored here. Keep them in step:
//   safe_fetch                the SSRF guard (apps/api/src/lib/ssrf.mjs): every box webhook, and every
//                             webhook step, goes through it. (url, init, { maxRedirects, timeoutMs }):
//                             by default no redirect is followed and 8s (a box webhook); a webhook step
//                             asks for up to 4 redirects and 30s. Every hop is re-checked.
//   revbox_visible_accounts   the job owner's visible accounts (apps/api/src/lib/visibility.mjs
//                             viewerVisibleAccountSet): null for every account, else a Set of ids.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { inTouchEntityIds, revboxWorkspaceRole } from '@nous/core';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 127) return true;                       // loopback
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 169 && b === 254) return true;           // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true;                          // multicast/reserved
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80')) return true;             // link-local
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA
  if (low.startsWith('::ffff:')) {
    const v4 = low.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isPrivateIp(v4);
    // The URL parser writes a mapped v4 address in hex (::ffff:7f00:1).
    const m = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) { const hi = parseInt(m[1], 16); const lo = parseInt(m[2], 16); return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
  }
  return false;
}

/** Throws unless the URL is a public http(s) endpoint. Returns the parsed URL. */
export async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('invalid_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('blocked_url_protocol');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('blocked_private_address');
    return u;
  }
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.')) {
    throw new Error('blocked_internal_host');
  }
  let results;
  try { results = await lookup(host, { all: true }); } catch { throw new Error('dns_resolution_failed'); }
  if (!results.length) throw new Error('dns_resolution_failed');
  for (const r of results) if (isPrivateIp(r.address)) throw new Error('blocked_private_address');
  return u;
}

/** A fetch that checks the URL and every redirect hop it follows. */
export async function safeFetch(rawUrl, init = {}, { timeoutMs = 8000, maxRedirects = 4 } = {}) {
  let current = (await assertPublicUrl(rawUrl)).toString();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try { res = await fetch(current, { ...init, redirect: 'manual', signal: controller.signal }); } finally { clearTimeout(timer); }
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers?.get?.('location');
    if (!loc) return res;
    current = (await assertPublicUrl(new URL(loc, current).toString())).toString();
  }
  throw new Error('too_many_redirects');
}

/**
 * What a safe_fetch caller may ask for (pre-ship finding 4, GET-858), clamped: 0-4 redirects (default
 * 0) and 1-30s (default 8s). Mirrors apps/api/src/routes/api/revboxes.mjs. Pure.
 */
export function safeFetchOptions(opts = {}) {
  const r = Number(opts?.maxRedirects), t = Number(opts?.timeoutMs);
  return {
    maxRedirects: Number.isFinite(r) ? Math.min(4, Math.max(0, Math.floor(r))) : 0,
    timeoutMs: Number.isFinite(t) ? Math.min(30_000, Math.max(1_000, Math.floor(t))) : 8_000,
  };
}

/** viewerVisibleAccountSet, mirrored: { unrestricted } or { ids }. */
async function visibleAccountSet(supabase, workspaceId, viewerUserId, { isAdmin = false } = {}) {
  if (isAdmin || !viewerUserId) return { unrestricted: true };
  const { data: ws } = await supabase.from('workspaces').select('open_account_visibility').eq('id', workspaceId).maybeSingle();
  if (ws?.open_account_visibility !== false) return { unrestricted: true };
  const contactIds = await inTouchEntityIds(supabase, workspaceId, viewerUserId);
  const ids = new Set(contactIds);
  const list = [...contactIds];
  for (let i = 0; i < list.length; i += 200) {
    const { data } = await supabase.from('contacts').select('company_id').in('id', list.slice(i, i + 200)).not('company_id', 'is', null);
    for (const c of data || []) if (c.company_id) ids.add(c.company_id);
  }
  return { unrestricted: false, ids };
}

/** Register both handlers on the step engine (registerStepHandler from @nous/core). */
export function registerRevboxStepHandlers(register) {
  register('revbox_visible_accounts', async ({ supabase, workspaceId, userId }) => {
    if (!userId) return new Set();
    const member = await revboxWorkspaceRole(supabase, workspaceId, userId);
    const set = await visibleAccountSet(supabase, workspaceId, userId, { isAdmin: ['admin', 'owner'].includes(member?.role) });
    return set.unrestricted ? null : set.ids;
  });
  register('safe_fetch', (url, init, opts) => safeFetch(url, init, safeFetchOptions(opts)));
}
