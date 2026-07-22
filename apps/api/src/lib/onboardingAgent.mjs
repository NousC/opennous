// Server-side onboarding "agent" — the assisted-setup engine for teams that have no
// agent of their own. This is the CUSTOM (sales-led) onboarding: after a sales call we
// have their intake answers, their website, and — the strongest ICP signal there is —
// their best customers. Given those, it uses Haiku to draft real GTM playbooks (ICP,
// positioning, voice), writes them into the workspace, seeds the ICP memory + scoring
// model from the real closed-won examples, and marks the workspace onboarded.
//
// It was built for the (now retired) Partner OS agency path and is the same shape either
// way: no human in Claude Code, so the server does what that agent would have done. Direct
// Nous users still onboard through their OWN agent over MCP — this is the substitute for
// the no-agent path, invoked by an admin for a Custom workspace (see
// routes/api/admin/assistedOnboard.mjs).
import Anthropic from 'useleak';
import { saveNote } from '@nous/core';
import { extractWebsiteSignals } from '../services/websiteSignals.mjs';
import { seedScorecardFromMemory } from './scorecardSeed.mjs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TITLES = { icp: 'ICP', positioning: 'Positioning', voice: 'Voice & Tone' };

// A freshly-provisioned workspace has no "self" entity (type='workspace'), which
// notes/scorecard need. Create it if missing.
async function ensureWorkspaceEntity(supabase, workspaceId) {
  const { data: existing } = await supabase.from('entities')
    .select('id').eq('workspace_id', workspaceId).eq('type', 'workspace').limit(1).maybeSingle();
  if (existing?.id) return existing.id;
  const { data } = await supabase.from('entities')
    .insert({ workspace_id: workspaceId, type: 'workspace', status: 'active' }).select('id').single();
  return data?.id || null;
}

async function upsertPlaybook(supabase, workspaceId, kind, body_md) {
  const { data: existing } = await supabase.from('playbooks')
    .select('version').eq('workspace_id', workspaceId).eq('kind', kind).maybeSingle();
  const now = new Date().toISOString();
  await supabase.from('playbooks').upsert({
    workspace_id: workspaceId, kind, title: TITLES[kind] || kind, body_md,
    source: 'nous', file_path: null, content_hash: null,
    version: existing ? existing.version + 1 : 1, synced_at: now, updated_at: now,
  }, { onConflict: 'workspace_id,kind' });
}

export async function runOnboardingAgent(supabase, workspaceId, answers = {}) {
  const { company_name, website, offer, icp, positioning, voice } = answers;
  const exampleCustomers = (Array.isArray(answers.example_customers) ? answers.example_customers : [])
    .map((d) => String(d || '').trim()).filter(Boolean).slice(0, 10);
  const built = { playbooks: [], scorecard: null, business_type: null, example_customers: 0, errors: [] };

  // 1. Read the company's own website for grounding (best-effort structured signals).
  let siteContext = 'none';
  try {
    if (website) {
      const sig = await extractWebsiteSignals(website);
      if (sig) siteContext = JSON.stringify(sig).slice(0, 3000);
    }
  } catch (e) { built.errors.push('scrape: ' + String(e?.message || e).slice(0, 80)); }

  // 1b. Read the BEST-CUSTOMER websites — the ground truth for the ICP. Real
  //     customers define the profile far better than a one-line answer, so we
  //     scrape each and hand the model concrete examples to generalise from (and
  //     save them as ICP memory so the scoring model is built from real data).
  const customerProfiles = [];
  for (const dom of exampleCustomers) {
    try {
      const sig = await extractWebsiteSignals(dom);
      if (sig) customerProfiles.push({ domain: dom, signals: sig });
    } catch { /* skip an unreachable customer site */ }
  }
  built.example_customers = customerProfiles.length;
  const customerContext = customerProfiles.length
    ? customerProfiles.map((c) => `- ${c.domain}: ${JSON.stringify(c.signals).slice(0, 500)}`).join('\n')
    : 'none provided';

  // 2. Haiku drafts the playbooks + infers business_type from answers + site + the
  //    real best-customer examples.
  const prompt =
    `You are onboarding a new go-to-market workspace for "${company_name || 'a company'}". ` +
    `Write three GTM playbooks in markdown that are COMPREHENSIVE yet TIGHT — rich with specific, usable detail, but every line earns its place. Use clear "### " sub-headers and bullets. No filler, no generic marketing fluff, and do NOT just restate the inputs — infer and add value. Ground every claim in the intake, the website, and especially the common pattern across their best customers. Mine the website + customer signals hard for detail others would miss.\n\n` +
    `INTAKE\n- What they sell: ${offer || '—'}\n- Ideal customer: ${icp || '—'}\n- Positioning: ${positioning || '—'}\n- Voice: ${voice || '—'}\n- Website: ${website || '—'}\n\n` +
    `WEBSITE SIGNALS (their own site): ${siteContext}\n\n` +
    `THEIR BEST CUSTOMERS (scraped — the ground truth for the ICP; generalise the pattern across them):\n${customerContext}\n\n` +
    `Write these three playbooks:\n\n` +
    `## ICP  (make this the most detailed)\n` +
    `- **Firmographics**: industry, company size, stage/funding, geography, revenue band — derived from the common pattern across their best customers.\n` +
    `- **Buying committee**: the 2-3 roles involved (economic buyer, champion/user, potential blocker) and what each one cares about.\n` +
    `- **Top pains → cost**: the 3 pains this offer removes, each with the concrete cost of NOT solving it.\n` +
    `- **Trigger signals**: 3-4 observable events that mean "reach out now", mapped to the signal classes the scorer reads (friction, hiring, momentum/funding/launch, stack/tooling change, intent/posted-pain).\n` +
    `- **Where to find them**: the channels / communities / data sources where these buyers actually are.\n` +
    `- **Common objections → counter**: 2-3 likely objections, each with a one-line rebuttal.\n` +
    `- **Disqualifiers (each with a one-line description)**: who is clearly NOT a fit, and a short description of each so a website read can judge it — e.g. "Pure branding agency: site sells logo/visual identity work, no revenue/outbound systems." Described exclusions become hard disqualifiers that cap the wrong accounts below Not-ICP.\n` +
    `- **Anchor examples (for the scoring model to learn from)**: name 1-2 real BEST-FIT customers and, if known, 1 clear NOT-A-FIT, each one line. These are the labels the ICP model trains against.\n` +
    `- **Value delivered**: the success metric / ROI the customer gets.\n\n` +
    `## POSITIONING\n` +
    `- **One-liner**, **category**, and **core value proposition**.\n` +
    `- **Differentiators**: 2-3, each vs the specific alternative they'd otherwise use.\n` +
    `- **Proof points**: evidence from the site / customers that backs the claims.\n` +
    `- **Messaging pillars**: 2-3 themes to lead outreach with.\n\n` +
    `## VOICE\n` +
    `- **Tone DNA**: 3-4 traits.\n` +
    `- **Do's / Don'ts**: 3 each.\n` +
    `- **Words to use / words to avoid**.\n` +
    `- **2 sample opening lines** written in this voice, each referencing a real trigger or pain.\n\n` +
    `Also infer business_type: "service" or "software".\n\n` +
    `Output the three playbooks as PLAIN MARKDOWN separated by these EXACT delimiter lines, and nothing else (no JSON, no code fences):\n\n` +
    `===ICP===\n(the ICP markdown)\n===POSITIONING===\n(the positioning markdown)\n===VOICE===\n(the voice markdown)\n===BUSINESS_TYPE===\nservice or software`;

  // Plain-markdown-between-delimiters, NOT JSON: embedding three large markdown
  // playbooks inside one JSON string truncates/breaks parsing, so we split on
  // markers instead — robust regardless of length.
  const out = {};
  try {
    const msg = await anthropic.messages.create({
      feature: 'partner-onboarding-agent',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '';
    const grab = (a, b) => { const seg = text.split(a)[1]; if (seg == null) return ''; return (b ? seg.split(b)[0] : seg).trim(); };
    out.icp = grab('===ICP===', '===POSITIONING===');
    out.positioning = grab('===POSITIONING===', '===VOICE===');
    out.voice = grab('===VOICE===', '===BUSINESS_TYPE===');
    const bt = grab('===BUSINESS_TYPE===', null).toLowerCase();
    out.business_type = bt.includes('software') ? 'software' : 'service';
  } catch (e) { built.errors.push('llm: ' + String(e?.message || e).slice(0, 100)); }

  const business_type = out.business_type === 'software' ? 'software' : 'service';
  built.business_type = business_type;
  // Fall back to the raw intake answers if the LLM omitted a section.
  const bodies = {
    icp: String(out.icp || icp || '').trim(),
    positioning: String(out.positioning || positioning || '').trim(),
    voice: String(out.voice || voice || '').trim(),
  };

  // 3. Mark the workspace onboarded (website + business_type is what Nous checks).
  const updates = { business_type, default_signup_stage: business_type === 'service' ? 'Lead' : 'Free User' };
  if (website) updates.website = website;
  try { await supabase.from('workspaces').update(updates).eq('id', workspaceId); }
  catch (e) { built.errors.push('workspace: ' + String(e?.message || e).slice(0, 80)); }

  // 4. Write the playbooks.
  for (const kind of ['icp', 'positioning', 'voice']) {
    if (!bodies[kind]) continue;
    try { await upsertPlaybook(supabase, workspaceId, kind, bodies[kind]); built.playbooks.push(kind); }
    catch (e) { built.errors.push(`playbook ${kind}: ` + String(e?.message || e).slice(0, 80)); }
  }

  // 5. Seed the ICP + website memory facts (the scorecard reads these), then build
  //    the scoring model from them. A freshly-provisioned workspace has no "self"
  //    entity yet, which saveNote needs — create it first, else the notes (and so
  //    the scorecard) never land.
  try { await ensureWorkspaceEntity(supabase, workspaceId); }
  catch (e) { built.errors.push('ws_entity: ' + String(e?.message || e).slice(0, 80)); }
  try { if (website) await saveNote(supabase, workspaceId, { category: 'Company', content: `Company website: ${website}`, source: 'onboarding' }); }
  catch (e) { built.errors.push('note company: ' + String(e?.message || e).slice(0, 80)); }
  try { if (bodies.icp) await saveNote(supabase, workspaceId, { category: 'ICP', content: bodies.icp, source: 'onboarding' }); }
  catch (e) { built.errors.push('note icp: ' + String(e?.message || e).slice(0, 80)); }
  // Save the best-customer firmographics as ICP memory too — concrete, real data
  // the scoring model learns the true pattern from (not just the prose ICP).
  if (customerProfiles.length) {
    const summary = 'Best customers (ground-truth ICP examples):\n' +
      customerProfiles.map((c) => `- ${c.domain}: ${JSON.stringify(c.signals).slice(0, 400)}`).join('\n');
    try { await saveNote(supabase, workspaceId, { category: 'ICP', content: summary, source: 'onboarding' }); }
    catch (e) { built.errors.push('note customers: ' + String(e?.message || e).slice(0, 80)); }
  }
  // Build the scoring model — retry once if the LLM translation step flakes
  // (it occasionally returns non-JSON → translation_failed).
  try {
    let sc = await seedScorecardFromMemory(supabase, workspaceId, { force: true });
    if (sc?.status === 'translation_failed') sc = await seedScorecardFromMemory(supabase, workspaceId, { force: true });
    built.scorecard = sc?.status || 'seeded';
  } catch (e) { built.errors.push('scorecard: ' + String(e?.message || e).slice(0, 80)); }

  return built;
}
