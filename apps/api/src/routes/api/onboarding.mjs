import { Router } from 'express';
import Anthropic from 'useleak';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { ensureUserAndTeam } from '../../lib/auth.mjs';
import { sendWelcomeEmail } from '../../lib/welcomeEmail.mjs';
import { upsertNousPerson, logNousObservation } from '../../lib/dogfood.mjs';
import { readSiteText } from '../../services/websiteSignals.mjs';
import { trackLlmUsage } from '../../lib/llmUsage.mjs';
import { writeIcp, hasIcp } from '../../lib/icp.mjs';

export const onboardingRouter = Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRAFT_MODEL = 'claude-haiku-4-5-20251001';

/** The workspace this user works in. */
async function resolveWorkspaceId(supabase, reqUser, fallback = null) {
  if (fallback) return fallback;
  const { user, team } = await ensureUserAndTeam(reqUser);
  const { data: wms } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces:workspace_id(id, team_id)')
    .eq('user_id', user.id);
  const match = (wms || []).find(m => m.workspaces?.team_id === team.id);
  return match?.workspace_id || null;
}

// GET /api/onboarding/status — drives the first-run gate, and it is the ONLY thing
// that answers "is this workspace set up". The router asks this. The setup screen asks
// this. There is no second opinion.
//
// onboarded = the workspace has an ICP **in the Vault** (a playbooks row, kind='icp').
//
// It used to be `business_type`, which the agent happened to set on its way past — a
// label, where the ICP is the thing every other part of the product actually reads:
// scoring, attention, the briefs, get_playbook. A workspace with a business_type and no
// ICP is not set up, it just looks like it is.
//
// It was then briefly `workspaces.icp_text`, which was worse: that column feeds NOTHING.
// The in-app road wrote it, the gate opened on it, and the Vault, the agent and the
// scoring model all still saw an empty workspace. See lib/icp.mjs.
//
// It doesn't matter WHERE the ICP came from: an icp.md the agent found in their
// repo, one it drafted from their website, or one they typed into the app. Same
// finish line, three roads to it.
onboardingRouter.get('/status', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = await resolveWorkspaceId(supabase, req.user, req.workspaceId);
    if (!workspaceId) return res.json({ connected: false, onboarded: false, hasIcp: false });

    const [{ data: ws }, { data: keys }, { count: sources }, { count: accounts }, { count: trainedDeals }, icpPresent] = await Promise.all([
      supabase.from('workspaces').select('website, tour_completed_at').eq('id', workspaceId).maybeSingle(),
      supabase.from('api_keys').select('last_used_at').eq('workspace_id', workspaceId).is('revoked_at', null),
      supabase.from('workflow_provider_connections')
        .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId),
      // Accounts in the graph — the "import your accounts" checkpoint of the guided tour.
      // These two are guided-tour extras, not the gate, so they degrade to a zero count on
      // any failure rather than rejecting Promise.all and 500-ing the whole gate.
      supabase.from('contacts')
        .select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId)
        .then(r => r, () => ({ count: 0 })),
      // Closed deals fed to the ICP model — the "build your ICP model" checkpoint. A resolved
      // prediction carrying a won/lost disposition is training signal, however it got there
      // (the Add-deals import, or an organic resolution).
      supabase.from('predictions')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .not('resolved_at', 'is', null)
        .in('outcome_value->>disposition', ['won', 'lost'])
        .then(r => r, () => ({ count: 0 })),
      // The playbook row, and only the playbook row. This is the whole gate.
      hasIcp(supabase, workspaceId),
    ]);

    return res.json({
      onboarded: icpPresent,
      hasIcp: icpPresent,
      // The MCP has actually called in at least once — i.e. their agent is live.
      connected: (keys || []).some(k => k.last_used_at),
      // Something is feeding the graph. Without this the ICP is set and nothing
      // ever arrives, which is a lonelier failure than not being set up at all.
      hasSource: (sources ?? 0) > 0,
      // How MANY sources are connected. The guided tour's integration step wants at
      // least three (email, meeting notes, LinkedIn) before import makes sense —
      // one connection alone leaves the graph nearly empty.
      sourceCount: sources ?? 0,
      // Guided-tour checkpoints. Additive — the gate above reads none of these.
      accountCount: accounts ?? 0,
      icpTrained: (trainedDeals ?? 0) > 0,
      // The one-time guided TOUR has been completed/dismissed for this workspace. Server
      // truth so it never re-shows on a new browser/device, only localStorage-cached.
      tourCompleted: !!ws?.tour_completed_at,
      website: ws?.website ?? null,
    });
  } catch (err) {
    console.error('[GET /api/onboarding/status]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/onboarding/tour-seen — the guided tour was completed or dismissed. Stamps
// the workspace so it never auto-shows again, on any device. Idempotent (keeps the first
// completion time). Best-effort; localStorage still gives the instant local suppression.
onboardingRouter.post('/tour-seen', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = await resolveWorkspaceId(supabase, req.user, req.workspaceId);
    if (!workspaceId) return res.json({ ok: false });
    await supabase.from('workspaces')
      .update({ tour_completed_at: new Date().toISOString() })
      .eq('id', workspaceId).is('tour_completed_at', null)
      .then(() => {}, () => {});
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/onboarding/tour-seen]', err);
    return res.json({ ok: false });
  }
});

// POST /api/onboarding/icp/draft  { website }
//
// The answer to "what if they don't have an ICP file?".
//
// Read their site, write them a first draft, hand it back for editing. Nothing is
// saved here — a draft they haven't looked at is a guess, and a guess we persisted
// without asking would quietly become the thing that scores every lead they ever
// import.
//
// Haiku, one call, a few tenths of a cent. Same model that does extraction.
onboardingRouter.post('/icp/draft', verifySupabaseAuth, async (req, res) => {
  try {
    const website = String(req.body?.website ?? '').trim();
    if (!website) return res.status(400).json({ error: 'website_required' });

    const supabase = getSupabaseClient();
    const workspaceId = await resolveWorkspaceId(supabase, req.user);

    const text = await readSiteText(website);
    if (!text || text.length < 200) {
      // Couldn't read it — a hard 404, an anti-bot wall, a site that's all video.
      // Say so plainly and let them write it themselves. Drafting an ICP from
      // nothing would produce confident nonsense, which is worse than a blank box.
      return res.status(422).json({
        error: 'site_unreadable',
        message: "We couldn't read enough from that site to draft anything. Write a couple of lines yourself and we'll take it from there.",
      });
    }

    const msg = await anthropic.messages.create({
      feature: 'onboarding-icp-draft',
      model: DRAFT_MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content: `Below is the text of a company's website. Write their Ideal Customer Profile — who THEY sell to.

Not who they are. Who they sell to. If the site says "we help Series A founders hire engineers", the ICP is Series A founders hiring engineers, not a recruiting company.

WEBSITE:
"${text}"

Write it as short prose, 120 words at most, covering only what the site actually supports:
- The kind of company they sell to (industry, size, stage)
- The person who buys (role, seniority)
- The problem that makes someone buy

Rules:
- Only what the site supports. If it never says company size, don't invent one.
- Concrete over generic. "Seed to Series B B2B SaaS doing outbound with a 2-5 person sales team" beats "growing businesses".
- No headers, no bullets, no preamble. Just the paragraph.
- If the site is too vague to tell who they sell to, reply with exactly: UNCLEAR` }],
    });

    const draft = msg.content[0]?.text?.trim() ?? '';

    trackLlmUsage(supabase, {
      workspaceId, feature: 'onboarding-icp-draft',
      model: DRAFT_MODEL, usage: msg.usage, requestId: msg.id,
    });

    if (!draft || draft === 'UNCLEAR') {
      return res.status(422).json({
        error: 'icp_unclear',
        message: "That site didn't say enough about who you sell to. Write a couple of lines and we'll take it from there.",
      });
    }

    // Remember the site. It's the one fact we now hold that they'd otherwise have
    // to type again, and the agent uses it later.
    if (workspaceId) {
      await supabase.from('workspaces').update({ website }).eq('id', workspaceId).then(() => {}, () => {});
    }

    return res.json({ draft, website });
  } catch (err) {
    console.error('[POST /api/onboarding/icp/draft]', err);
    // The site read fine (that path returns 422 above) — this catch means the LLM
    // call failed: a usage cap, a rate limit, an overload. Never tell the user
    // "couldn't read that site" for that; it sends them chasing their own website.
    // Anthropic SDK errors carry an HTTP `status`; a plain crash doesn't.
    if (typeof err?.status === 'number') {
      return res.status(503).json({
        error: 'draft_unavailable',
        message: "Auto-drafting is unavailable right now. Write a couple of lines about who you sell to and we'll take it from there.",
      });
    }
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/onboarding/icp  { icp_text }
//
// Save it. This is the finish line — the moment this lands, /status flips to
// onboarded and the app opens. Same endpoint whichever road they took.
//
// It writes through lib/icp.mjs, which puts the ICP in all three places that need it:
// the Vault (the authority), the ICP note (the only thing the scoring model learns from),
// and the icp_text cache. This route used to write the cache ALONE, which meant the gate
// opened onto a workspace where the Vault was empty, get_playbook returned nothing, and
// the scorecard had never been seeded.
//
// source is 'nous' here: there is no repo on this road, so the Vault is the author.
onboardingRouter.post('/icp', verifySupabaseAuth, async (req, res) => {
  try {
    const icpText = String(req.body?.icp_text ?? '').trim();
    if (icpText.length < 20) return res.status(400).json({ error: 'icp_too_short' });

    const supabase = getSupabaseClient();
    const workspaceId = await resolveWorkspaceId(supabase, req.user);
    if (!workspaceId) return res.status(404).json({ error: 'no_workspace' });

    try {
      await writeIcp(supabase, workspaceId, { body_md: icpText, source: 'nous' });
    } catch (err) {
      return res.status(500).json({ error: 'write_failed', detail: err.message });
    }

    return res.json({ ok: true, onboarded: true });
  } catch (err) {
    console.error('[POST /api/onboarding/icp]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/onboarding/complete
onboardingRouter.post('/complete', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { name, company_name, website, icp_description } = req.body;
    const { user, team } = await ensureUserAndTeam(req.user);

    const { data: wms } = await supabase.from('workspace_members').select('workspace_id, workspaces:workspace_id(*)').eq('user_id', user.id);
    const match = wms?.find(m => m.workspaces?.team_id === team.id);
    let workspace = match?.workspaces || null;

    const isFirstCompletion = !user.onboarding_completed_at;
    if (isFirstCompletion) {
      await supabase.from('users').update({ onboarding_completed_at: new Date().toISOString() }).eq('id', user.id);
    }

    // Guarantee the team has a Free subscription. ensureUserAndTeam creates one
    // on first auth; this is the belt-and-suspenders if that ever missed.
    // ignoreDuplicates leaves an existing (potentially paid) row untouched.
    if (isFirstCompletion) {
      try {
        await supabase.from('subscriptions').upsert({
          team_id: team.id,
          plan_id: 'free',
          plan_name: 'free',
          status: 'active',
          current_period_start: new Date().toISOString(),
        }, { onConflict: 'team_id', ignoreDuplicates: true });
      } catch (e) {
        console.warn('[onboarding/complete] free-plan upsert:', e?.message || e);
      }
    }

    // Welcome email + dogfood the public API — only on first completion,
    // fire-and-forget so onboarding never blocks on external services.
    if (isFirstCompletion) {
      const fullName = (typeof name === 'string' && name.trim()) || user.name || '';
      const [firstName, ...rest] = fullName.split(/\s+/);
      const lastName = rest.join(' ') || null;
      const recipientEmail = user.email || null;
      const finalCompany = (typeof company_name === 'string' && company_name.trim()) || workspace?.name || null;
      const signupStage = workspace?.default_signup_stage
        || (workspace?.business_type === 'service' ? 'Lead' : 'Free User');

      (async () => {
        // 1. Welcome email (idempotent — only send once per user)
        if (recipientEmail && !user.welcome_email_sent_at) {
          const result = await sendWelcomeEmail({ to: recipientEmail, firstName });
          if (result.sent) {
            await supabase.from('users')
              .update({ welcome_email_sent_at: new Date().toISOString() })
              .eq('id', user.id)
              .then(({ error }) => {
                if (error) console.error('[WELCOME_EMAIL] failed to set sent_at:', error.message);
              });
            await logNousObservation(recipientEmail, [
              { kind: 'event', property: 'interaction.welcome_email_sent',
                value: { at: new Date().toISOString() } },
            ]);
          }
        }

        // 2. Upsert this new user as a person in our own Nous workspace
        if (recipientEmail) {
          await upsertNousPerson({
            email: recipientEmail,
            first_name: firstName || null,
            last_name: lastName,
            company: finalCompany,
            stage: signupStage,
          });

          // 3. Log signup on their timeline. Also write state.pipeline_stage
          // so the contact detail view's Pipeline Stage field flips off the
          // default 'identified' onto whatever the founder named their
          // signup stage in onboarding.
          await logNousObservation(recipientEmail, [
            { kind: 'event', property: 'interaction.signed_up',
              value: {
                source: 'app.opennous.cloud',
                plan: 'free',
                business_type: workspace?.business_type || null,
                website: (typeof website === 'string' && website.trim()) || null,
                icp_description: (typeof icp_description === 'string' && icp_description.trim()) || null,
                at: new Date().toISOString(),
              } },
            { kind: 'state', property: 'stage', value: signupStage },
            { kind: 'state', property: 'pipeline_stage', value: signupStage },
            ...(finalCompany ? [{ kind: 'state', property: 'company', value: finalCompany }] : []),
          ]);
        }
      })().catch(err => console.error('[onboarding/complete] side effects error:', err.message));
    }

    return res.json({ success: true, workspace });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error', ...(process.env.NODE_ENV !== 'production' && { detail: String(err.message) }) });
  }
});
