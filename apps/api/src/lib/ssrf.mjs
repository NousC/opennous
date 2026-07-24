import { lookup } from 'node:dns/promises';
import net from 'node:net';

// SSRF egress guard. The product fetches user-supplied URLs (website scraping,
// enrichment, webhook/trigger delivery), so without this a customer could aim a
// fetch at cloud metadata (169.254.169.254), loopback, or sibling containers
// (redis/postgres/api) on the internal network. This resolves the host and
// refuses any non-public address.
//
// Residual: DNS-rebinding (a public name that flips to private between this
// check and the actual connection) is not fully closed here — that needs
// connect-time IP pinning. This blocks the direct/static cases, which is the
// overwhelming majority.

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
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice('::ffff:'.length)); // v4-mapped
  return false;
}

// Throws if the URL is not a public http(s) endpoint. Returns the parsed URL.
export async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('invalid_url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('blocked_url_protocol');

  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('blocked_private_address');
    return u;
  }
  // Reject obvious internal names outright.
  if (host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.')) {
    throw new Error('blocked_internal_host');
  }
  let results;
  try { results = await lookup(host, { all: true }); } catch { throw new Error('dns_resolution_failed'); }
  if (!results.length) throw new Error('dns_resolution_failed');
  for (const r of results) {
    if (isPrivateIp(r.address)) throw new Error('blocked_private_address');
  }
  return u;
}

// Convenience: true/false form for callers that just want to skip a URL.
export async function isPublicUrl(rawUrl) {
  try { await assertPublicUrl(rawUrl); return true; } catch { return false; }
}
