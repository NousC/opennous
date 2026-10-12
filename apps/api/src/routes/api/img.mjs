import { Router } from 'express';

// A tiny same-origin image proxy — LinkedIn (and similar) photo CDNs block hotlinking from
// the browser (referrer/CSP), so avatars fail to load. We fetch them server-side with a
// browser UA and stream them back from our own origin. Strictly host-allowlisted so it can
// never be used as an open proxy (no SSRF surface).
export const imgProxyRouter = Router();

const ALLOWED = [
  /(^|\.)licdn\.com$/i,
  /(^|\.)googleusercontent\.com$/i,
  /(^|\.)twimg\.com$/i,
  /(^|\.)ggpht\.com$/i,
];

imgProxyRouter.get('/', async (req, res) => {
  const raw = String(req.query.url || '');
  let u;
  try { u = new URL(raw); } catch { return res.status(400).end(); }
  if (u.protocol !== 'https:' || !ALLOWED.some((rx) => rx.test(u.hostname))) return res.status(403).end();
  try {
    const r = await fetch(u.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,*/*',
      },
    });
    if (!r.ok) return res.status(502).end();
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return res.status(415).end();
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    return res.status(502).end();
  }
});
