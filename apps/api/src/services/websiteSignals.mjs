// Website signal extractor — the owned, no-vendor source of *niche* ICP signals.
// Scrapes a company's key pages and uses an LLM to extract behavioural/operational
// signals (hiring, pricing model, product surface, tech mentions, compliance),
// then records each as a `signal.*` state observation so it flows into the
// entity's feature_snapshot at scoring time and into contrastive discovery.
//
// This is the Zevenue signal-builder method run by us, weighted later by real
// won/lost lift (docs/icp-from-closed-deals.md, Step 3). One LLM call per company.

import Anthropic from 'useleak';
import { recordObservation, recomputeClaim } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Pages worth reading. Careers reveals hiring; pricing reveals the model; docs
// reveal an API-first/self-serve buyer. We try a few common paths and keep what
// resolves — a static fetch, good enough for most marketing sites.
const PAGES = ['', '/about', '/careers', '/jobs', '/pricing', '/product', '/docs'];

const normDomain = (d) => String(d || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// A realistic browser UA — many sites 403 a "bot" UA but serve a normal browser.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow', ...opts });
  } finally {
    clearTimeout(timer);
  }
}

// Static fetch + HTML→text. Fast and free; works for most marketing sites.
async function fetchPage(url) {
  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 8000);
    if (!res.ok) return '';
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

// Rendering fallback for JS-only / bot-blocked sites. Jina Reader (r.jina.ai)
// fetches, renders JS, bypasses most anti-bot, and returns clean readable text.
// Free tier works keyless; set JINA_API_KEY for higher rate limits.
async function fetchViaJina(url) {
  try {
    const headers = { 'User-Agent': UA, 'X-Return-Format': 'text' };
    if (process.env.JINA_API_KEY) headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers }, 20000);
    if (!res.ok) return '';
    return (await res.text()).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Read a site as plain text. Static fetch first (fast, free); Jina renders the
 * JS-only and bot-blocked ones. Shared with onboarding, which drafts an ICP from
 * the same text rather than re-solving "how do I read a website".
 *
 * Returns '' when the site can't be read at all — the caller decides what that
 * means. For onboarding it means "ask them to write it themselves", never a crash.
 */
export async function readSiteText(domain, { maxChars = 12_000 } = {}) {
  const host = normDomain(domain);
  if (!host) return '';

  let text = await fetchPage(`https://${host}`);
  // A near-empty body usually means a JS-rendered SPA or an anti-bot wall, not an
  // empty site. Escalate rather than conclude the company has nothing to say.
  if (text.length < 400) {
    const rendered = await fetchViaJina(`https://${host}`);
    if (rendered.length > text.length) text = rendered;
  }
  return text.slice(0, maxChars);
}

// Scrape + extract. Returns a structured signal object, or null if the site
// couldn't be read.
export async function extractWebsiteSignals(domain) {
  const host = normDomain(domain);
  if (!host) return null;
  const base = `https://${host}`;
  const texts = await Promise.all(PAGES.map(p => fetchPage(base + p)));
  let corpus = texts.filter(Boolean).join('\n\n').slice(0, 14000);

  // Thin result → JS-only or bot-blocked. Render a few key pages via Jina and
  // keep whichever read is richer.
  if (corpus.length < 800) {
    const rendered = (await Promise.all(['', '/about', '/pricing'].map(p => fetchViaJina(base + p))))
      .filter(Boolean).join('\n\n');
    if (rendered.length > corpus.length) corpus = rendered.slice(0, 14000);
  }
  if (!corpus) return null;

  const prompt =
    `You are extracting GTM signals from a company's website to help score how well they fit as a customer. ` +
    `Read the content and return ONLY a JSON object, no prose, with this exact shape:\n` +
    `{\n` +
    `  "summary": "<1-2 sentences: what they do and who their users are>",\n` +
    `  "industry": "<their industry/vertical in 1-3 words, e.g. fintech, devtools, healthcare, e-commerce, logistics>",\n` +
    `  "company_type": "<what KIND of business they are — one of: software, agency, services, marketplace, ecommerce, media, hardware, nonprofit, other>",\n` +
    `  "size_band": "<one of: 1-10, 11-50, 51-200, 201-1000, 1000+, unknown>",\n` +
    `  "funding_stage": "<one of: bootstrapped, pre_seed, seed, series_a, series_b, series_c_plus, public, unknown>",\n` +
    `  "hq_country": "<country name or 2-letter code, or unknown>",\n` +
    `  "target_market": "<one of: b2b, b2c, b2b2c, developer, enterprise, smb, unknown>",\n` +
    `  "pricing_model": "<one of: usage_based, seat_based, flat, freemium, enterprise_contact, unknown>",\n` +
    `  "product": { "has_api": <bool>, "has_docs": <bool>, "has_sandbox": <bool>, "self_serve_signup": <bool>, "free_trial": <bool> },\n` +
    `  "hiring": ["<role categories they are actively hiring, e.g. RevOps, Sales, Security>"],\n` +
    `  "tech": ["<named tools/technologies mentioned, e.g. Stripe, Segment, Snowflake>"],\n` +
    `  "compliance": ["<compliance terms present, e.g. SOC2, HIPAA, KYC, CIP, GDPR>"],\n` +
    `  "recently_funded": <bool>\n` +
    `}\n` +
    `Only include what the content actually supports — empty arrays and false/"unknown" are correct when unsure. ` +
    `Do not invent. Be specific with named tech and roles.\n\n` +
    `Website content:\n"""${corpus}"""`;

  const msg = await anthropic.messages.create({
    feature: 'website-signals',
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = msg.content[0].text.trim();
  try {
    return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
  } catch {
    return null;
  }
}

// Turn the extracted signals into discrete `signal.*` state observations on the
// entity (each becomes a feature for scoring + discovery), then recompute claims.
export async function recordWebsiteSignals(supabase, workspaceId, entityId, signals) {
  const obs = [];
  const add = (property, value) => { if (value != null && value !== '' && value !== 'unknown') obs.push({ property, value }); };

  // Firmographics — *who they are*. Saved under their plain feature names (no
  // signal. prefix) so they read as core ICP traits and discovery can find lift
  // on industry/size/funding the same way it does on job_title/industry today.
  add('industry', signals.industry);
  add('company_type', signals.company_type);   // software / agency / services / …
  add('size_band', signals.size_band);
  add('funding_stage', signals.funding_stage);
  add('country', signals.hq_country);
  // What they do — the one-line description, kept for the account view (a long
  // string, so discovery ignores it as a scoring feature — display only).
  add('what_they_do', signals.summary);

  add('signal.target_market', signals.target_market);
  add('signal.pricing_model', signals.pricing_model);
  const p = signals.product || {};
  for (const k of ['has_api', 'has_docs', 'has_sandbox', 'self_serve_signup', 'free_trial']) {
    if (p[k] != null) add(`signal.${k}`, !!p[k]);
  }
  if (signals.recently_funded != null) add('signal.recently_funded', !!signals.recently_funded);
  for (const t of (signals.tech || []).slice(0, 12)) add(`signal.tech.${slug(t)}`, true);
  for (const h of (signals.hiring || []).slice(0, 8)) add(`signal.hiring.${slug(h)}`, true);
  for (const c of (signals.compliance || []).slice(0, 8)) add(`signal.compliance.${slug(c)}`, true);

  const now = new Date().toISOString();
  for (const o of obs) {
    await recordObservation(supabase, {
      workspaceId, entityId, kind: 'state', property: o.property, value: o.value,
      source: 'website', method: 'scrape', observedAt: now,
    });
  }
  for (const prop of [...new Set(obs.map(o => o.property))]) {
    await recomputeClaim(supabase, workspaceId, entityId, prop).catch(() => {});
  }
  return obs.length;
}

// Orchestrate: scrape → extract → record. Returns { signals, recorded } or null.
export async function extractAndRecordWebsiteSignals(supabase, workspaceId, entityId, domain) {
  const signals = await extractWebsiteSignals(domain);
  if (!signals) return null;
  const recorded = await recordWebsiteSignals(supabase, workspaceId, entityId, signals);
  return { signals, recorded };
}
