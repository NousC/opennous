// A feature request is a capability we do NOT have (GET-1031).
//
// The extractor never sees what we sell, so every ask landed as a feature: "connect your MCP to our
// bots", "an app on the phone", "an API" — all things we ship — sat beside the one real gap on an
// account's Feature requests list, fifty deep. An ask for something we already have is a customer
// who needs help using it, so it is filed as setup, and sends no Feature requested event.
//
// COST. One short call per conversation that produced a feature row, against the ICP's own
// "What <us> sells" section (the catalogue automationRun already reads) or the Positioning
// foundation. No catalogue, no call, and every row is kept as the model filed it.
import { read, parseArray, acceptsArray } from '../noema/read.mjs';

const CATALOGUE_CHARS = 3000;
const MAX_ROWS = 60;

/**
 * What we sell: the About us file (mirrored into the Positioning foundation, GET-1036), else the
 * ICP's "What <us> sells" section, else the ICP itself. Pure.
 */
export function whatWeSell(icpText, positioning = null) {
  const icp = String(icpText ?? '').replace(/<!--\s*nous:icp start[\s\S]*?nous:icp end\s*-->/gi, '').trim();
  const section = /^##\s*What\b[^\n]*\bsells?\b[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im.exec(icp)?.[1];
  const pos = String(positioning ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const text = (pos || section?.trim() || icp).slice(0, CATALOGUE_CHARS);
  return text.length >= 40 ? text : null;
}

/** The prompt. Requests are numbered; the answer names the ones we already have. Pure. */
export function buildAlreadyHavePrompt({ catalogue, requests }) {
  const lines = requests.map((r, i) => `${i + 1}. ${r.what ? `${r.what}: ` : ''}${r.content}${r.use_case ? ` (to ${r.use_case})` : ''}`).join('\n');
  return `Customers asked us for the things below. Our product, as we describe it:
"""
${catalogue}
"""

Requests:
${lines}

Which of these do we ALREADY HAVE? A request we have is one the description above clearly covers: the customer wants something we already ship, and needs help finding, connecting or using it. When the description does not clearly cover it, or covers only part of it, we do not have it. Asking us to build our own version of a tool, or something the description never mentions, is not something we have.

Answer with ONLY a JSON array, one item per request we already have, nothing for the rest:
[{"n": <request number>, "have": "<what of ours covers it, 2-5 words>"}]
If we have none of them: []`;
}

/** The request numbers we have, kept only when they name a real request. Pure. */
export function parseAlreadyHave(value, count) {
  const out = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const n = Number(item?.n);
    if (Number.isInteger(n) && n >= 1 && n <= count) out.set(n - 1, String(item?.have ?? '').slice(0, 80) || null);
  }
  return out;
}

/** The ICP's catalogue for a workspace, or null. */
export async function catalogueFor(supabase, workspaceId) {
  const [{ data: ws, error }, { data: pos }] = await Promise.all([
    supabase.from('workspaces').select('icp_text').eq('id', workspaceId).maybeSingle(),
    supabase.from('foundations').select('body_md').eq('workspace_id', workspaceId).eq('kind', 'positioning').maybeSingle(),
  ]);
  if (error) { console.warn('[ALREADY_HAVE] icp read failed:', error.message); return null; }
  return whatWeSell(ws?.icp_text, pos?.body_md);
}

/**
 * Which of `requests` (feature rows or facts: what, content, use_case) we already have, as a Map of
 * index → what covers it. Empty when there is no catalogue or the check fails: a failed check never
 * costs a real request.
 */
export async function alreadyHave(supabase, workspaceId, requests, { catalogue } = {}) {
  if (!requests?.length) return new Map();
  const cat = catalogue === undefined ? await catalogueFor(supabase, workspaceId) : catalogue;
  if (!cat) return new Map();
  const shown = requests.slice(0, MAX_ROWS);
  const result = await read({
    supabase, workspaceId, feature: 'feature-already-have', prompt: buildAlreadyHavePrompt({ catalogue: cat, requests: shown }),
    accept: acceptsArray, parse: parseArray, maxTokens: 400,
  });
  return result.ok ? parseAlreadyHave(result.value, shown.length) : new Map();
}

/** The facts about us, with each feature we already have refiled as setup. */
export async function screenFeatureRequests(supabase, workspaceId, facts) {
  const idx = (facts ?? []).map((f, i) => (f?.kind === 'feature' ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return facts;
  const have = await alreadyHave(supabase, workspaceId, idx.map(i => facts[i]));
  if (!have.size) return facts;
  const out = facts.slice();
  for (const [k, covers] of have) {
    const i = idx[k];
    out[i] = { ...out[i], kind: 'setup' };
    console.log(`[ALREADY_HAVE] "${out[i].what ?? out[i].content}" → setup${covers ? ` (we have: ${covers})` : ''}`);
  }
  return out;
}
