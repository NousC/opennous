import { Router } from 'express';
import { createHash } from 'node:crypto';
import {
  getSupabaseClient,
  listNotes,
  saveNote,
  listSignals,
  modelVersion,
  listTriggers,
  createTrigger,
  TRIGGER_EVENTS,
  countHygieneProposals,
  listHygieneProposals,
  updateHygieneProposalStatus,
  syncCrmProvider,
} from '@nous/core';
import { seedScorecardFromMemory } from '../../lib/scorecardSeed.mjs';
import { writeIcp } from '../../lib/icp.mjs';
import { requireFeature, resolveTeamAndPlan, hasFeature, isSelfHosted } from '../../lib/access.mjs';
import { connectProvider } from '../../providers/connect.mjs';
import { resolveCrmTokenForProvider } from '../api/crm.mjs';
import { runClosedDeals } from '../api/mind.mjs';
import { writeWorkspaceFact, ALL_SECTIONS } from './workspaceFacts.mjs';
import { computeIcpModel, renderIcpBlock, findIcpSourcePath } from '../../lib/icpModel.mjs';
import { ICP_TEMPLATE, missingIcpSections } from '../../lib/icpTemplate.mjs';

// ── Workspace status + onboarding — the agent's setup surface ──────────────────
//
// Nous is built for the agent to operate, not the human to click. Two routes:
//
//   GET  /v2/workspace/status      — the "one main call". Returns the whole
//                                    state of the workspace in one shot: is it
//                                    onboarded, is the GTM foundation built, which
//                                    integrations are connected, is CRM sync
//                                    configured, are webhooks/triggers live —
//                                    plus a ranked next_steps list so the agent
//                                    knows what to set up next without being asked.
//
//   POST /v2/workspace/onboarding  — agent-driven onboarding. The agent collects
//                                    the basics from the user (name, website,
//                                    business type, a sentence on their ICP) and
//                                    writes them here, instead of the human
//                                    clicking through a wizard in the app.
//
// Both are API-key auth (verifyApiKey sets req.workspaceId) and logged to the
// Ops page via logV2Op, so every agent setup action is visible to the human.

export const workspaceStatusV2Router = Router();

const DAY = 86400000;
const ageDays = (ts) => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / DAY) : null);
const safe = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };

// ── GET /v2/workspace/status ───────────────────────────────────────────────────
workspaceStatusV2Router.get('/status', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    const [workspace, notes, signalCount, connections, crmConfigs, hygieneOpen, webhookCount, triggers, linkedinRows, contactCount] =
      await Promise.all([
        safe(async () => {
          const { data } = await supabase
            .from('workspaces')
            .select('id, name, website, business_type, plan_model, default_signup_stage')
            .eq('id', workspaceId)
            .maybeSingle();
          return data || null;
        }),
        safe(() => listNotes(supabase, workspaceId, {}), []),
        safe(async () => {
          const { count } = await supabase
            .from('scorecard_signals')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspaceId);
          return count ?? 0;
        }, 0),
        safe(async () => {
          const { data } = await supabase
            .from('workflow_provider_connections')
            .select('id, name, is_verified, last_used_at, provider:workflow_providers(name, display_name, category)')
            .eq('workspace_id', workspaceId);
          return data ?? [];
        }, []),
        safe(async () => {
          const { data } = await supabase
            .from('crm_sync_configs')
            .select('provider, auto_sync, push_activities, hygiene_enabled, hygiene_cadence, updated_at')
            .eq('workspace_id', workspaceId);
          return data ?? [];
        }, []),
        safe(() => countHygieneProposals(supabase, workspaceId, 'proposed'), 0),
        safe(async () => {
          const { count } = await supabase
            .from('workspace_webhook_subscriptions')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspaceId);
          return count ?? 0;
        }, 0),
        safe(() => listTriggers(supabase, workspaceId), []),
        safe(async () => {
          const { data } = await supabase
            .from('workspace_linkedin_connections')
            .select('id').eq('workspace_id', workspaceId).limit(1);
          return data ?? [];
        }, []),
        safe(async () => {
          const { count } = await supabase
            .from('contacts')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspaceId);
          return count ?? 0;
        }, 0),
      ]);

    // ── Plan + feature availability (so the agent doesn't push paid features) ──
    const plan = await safe(async () => (await resolveTeamAndPlan(req)).plan, null);
    const crmSyncAvailable  = !isSelfHosted() && !!plan && hasFeature(plan.id, 'crmSync');
    const leadListsAvailable = !isSelfHosted() && !!plan && hasFeature(plan.id, 'leadLists');
    // ICP scoring is OPEN on self-host (unlike CRM sync / lead lists); on cloud it's
    // plan-gated. Mirrors requireFeature('icpScoring'). Surfaced so the agent never
    // tells a self-hoster the scoring model is "Cloud-only".
    const icpScoringAvailable = isSelfHosted() || (!!plan && hasFeature(plan.id, 'icpScoring'));

    // ── Onboarding: the workspace's basic identity ──
    //
    // NOTE this is the PROFILE, not the gate. The gate — "is this workspace set up" — is
    // whether an ICP exists, and it is answered in exactly one place (see `icpDone` below
    // and /api/onboarding/status, which agree by construction). Conflating the two is what
    // produced three different answers to the same question and locked users out of
    // workspaces that were finished.
    const profileMissing = [];
    if (!workspace?.name)          profileMissing.push('name');
    if (!workspace?.website)       profileMissing.push('website');
    if (!workspace?.business_type) profileMissing.push('business_type');
    const onboardingDone = !!(workspace?.website && workspace?.business_type);

    // ── Foundations — the four policy slots (voice, outreach, icp, positioning).
    // Report per-slot state so onboarding knows exactly what to set up, and resumes
    // a half-finished setup instead of restarting. Runtime-agnostic: a slot can be
    // mirrored from a file (source 'claude_code') or stored in Nous (source 'nous').
    const PB_KINDS = ['voice', 'outreach', 'icp', 'positioning'];
    const foundationRows = await safe(async () => {
      const { data } = await supabase.from('foundations')
        .select('kind, source, file_path, updated_at').eq('workspace_id', workspaceId);
      return data ?? [];
    }, []);
    const foundations = PB_KINDS.map((k) => {
      const r = (foundationRows || []).find((x) => x.kind === k);
      return { kind: k, exists: !!r, source: r?.source ?? null, file_path: r?.file_path ?? null };
    });
    const foundationsMissing = foundations.filter((p) => !p.exists).map((p) => p.kind);
    const foundationsComplete = foundationsMissing.length === 0;

    // THE GATE. A workspace is set up when it has an ICP — that is the one artifact every
    // other part of the product reads (scoring, attention, the briefs, get_foundation), and
    // it is the same question /api/onboarding/status answers. Same row, same answer.
    const icpSlot = foundations.find((p) => p.kind === 'icp');
    const icpDone = !!icpSlot?.exists;

    // ── GTM foundation ──
    // "Built" = the in-app wizard ran (source 'playbook') OR the agent wrote real
    // GTM context (source 'agent'). Agent-operated onboarding is first-class — it
    // must count. A lone onboarding-seeded ICP line (source 'onboarding') does NOT,
    // so a bare new workspace still gets the setup prompt: hence the >= 2 threshold.
    const foundationFacts = (notes || []).filter((n) => n.source === 'playbook' || n.source === 'agent');
    const icpNotes      = (notes || []).filter((n) => n.category === 'ICP');
    const hasModel      = signalCount > 0;
    const foundationDone  = foundationFacts.length >= 2 || hasModel;
    const staleFacts    = foundationFacts.filter((n) => {
      const a = ageDays(n.reaffirmed_at || n.created_at);
      return a != null && a >= 90;
    }).length;

    // ── ICP file sync — the two-way symbiosis drift state. If the ICP was synced
    // from a repo file (sync_icp), surface where, and whether the model has evolved
    // since the last sync (so the agent re-runs export_icp_model to update the file).
    const icpSourceNote = icpNotes.find((n) => n?.metadata?.source_path);
    let icpSync = null;
    if (icpSourceNote) {
      const activeSignals = await safe(() => listSignals(supabase, workspaceId, { activeOnly: true }), []);
      const currentMv = activeSignals.length ? modelVersion(activeSignals) : null;
      const syncedMv = icpSourceNote.metadata?.synced_model_version ?? null;
      icpSync = {
        synced_from: icpSourceNote.metadata.source_path,
        synced_at: icpSourceNote.reaffirmed_at || icpSourceNote.created_at,
        synced_hash: icpSourceNote.metadata?.synced_hash ?? null,
        model_version: currentMv,
        // The model has learned new signals since the file was last written → the
        // file is stale, run export_icp_model. Null synced version (legacy import) → unknown.
        model_changed: !!(syncedMv && currentMv && syncedMv !== currentMv),
      };
    }

    // ── Integrations (verified connections), with CRM + enrichment derived ──
    const verified = (connections || []).filter((c) => c.is_verified === true);
    const connectedList = verified.map((c) => ({
      name: c.provider?.display_name || c.name,
      category: c.provider?.category || null,
      last_used_at: c.last_used_at || null,
    }));
    const enrichment = verified.find((c) => c.provider?.category === 'enrichment') || null;

    // ── Recommended onboarding integrations (the order the agent should guide) ──
    const provName = (c) => (c.provider?.name || c.name || '').toLowerCase();
    const gmailConnected   = verified.some((c) => /gmail|google|smtp|imap/.test(provName(c)) || c.provider?.category === 'email');
    const meetingConnected = verified.some((c) => c.provider?.category === 'meetings');
    const linkedinConnected = (linkedinRows || []).length > 0;
    const recordCount = typeof contactCount === 'number' ? contactCount : 0;
    const hasWebhooks = webhookCount > 0 || (Array.isArray(triggers) ? triggers.length : 0) > 0;

    // Self-host: some channels are configured at the INSTANCE level (env vars +
    // restart), not per-workspace in the app — and the agent CANNOT set env vars.
    // Surface what's wired so the agent tells the operator which to set.
    const selfHosted     = isSelfHosted();
    const unipileEnv     = !!(process.env.UNIPILE_API_KEY && process.env.UNIPILE_DSN);
    const resendEnv      = !!process.env.RESEND_API_KEY;
    const googleOauthEnv = !!process.env.GOOGLE_CLIENT_ID;

    // ── CRM sync ──
    const crmSyncConfigured = (crmConfigs || []).length > 0;
    const crmProviders = (crmConfigs || []).map((c) => ({
      provider: c.provider,
      auto_sync: !!c.auto_sync,
      hygiene_enabled: !!c.hygiene_enabled,
      hygiene_cadence: c.hygiene_cadence || null,
    }));

    const triggerCount = Array.isArray(triggers) ? triggers.length : 0;

    // ── Ranked next steps — the onboarding sequence, in order. Guide the user
    // through these top-down; later steps build on earlier ones. ──
    const next_steps = [];

    // 0. DISCOVER. Before anything else, before a single question: look at what they
    //    already have.
    //
    //    This step exists because the setup used to open by interrogating the user for a
    //    business type while an icp.md sat unread in their repo two directories away. The
    //    people who install Nous are the people who write these files. Asking them to
    //    describe, out loud, something they already wrote down is the fastest way to look
    //    like every other tool they've abandoned.
    //
    //    Reconcile, don't create. The end state is identical either way; the difference is
    //    whether we respected what was already there.
    if (!icpDone) {
      next_steps.push({
        id: 'discover_context',
        title: 'Find the context they already have — BEFORE asking them anything',
        why: 'Most people who install Nous have already written their ICP down somewhere. That file IS the ICP. Drafting a second one next to it is worse than useless: now there are two, and they disagree.',
        how: [
          'SCAN FIRST. Do not ask a single setup question until you have looked.',
          'WHERE: context/, .claude/, gtm/, docs/, and the repo root.',
          'WHAT: files named icp*, positioning*, voice*, tone*, brand*, messaging*, outreach*, pricing*, competitors*.',
          'ALSO INSIDE: read CLAUDE.md and README.md — an ICP is often a heading in there ("## Who we sell to", "## Ideal customer") rather than a file of its own.',
          'THEN MAP what you found onto the four kinds Nous keeps: icp, positioning, voice, outreach.',
          '(a) EXACT MATCH — context/icp.md exists and is real: sync it AS-IS with sync_foundation(kind, body, file_path). DO NOT REWRITE IT. It is already the thing we wanted; your job is to mirror it, not to improve it. Their repo stays the author.',
          '(b) DIFFERENT SHAPE — it lives in a CLAUDE.md heading, or docs/who-we-sell-to.md: extract it, write the canonical context/<kind>.md in THEIR repo, sync that, and TELL THEM what you moved and where from. Never silently.',
          '(c) NOTHING FOUND — say so, then go to the profile step and draft from their website.',
          'REPORT when you are done: what you found, what you moved, what you drafted, what is still empty. A user who watches you discover their own file trusts everything you do next.',
          'NO FILESYSTEM (Codex, claude.ai): skip the scan, say so, and go straight to the profile step.',
        ].join(' '),
      });
    }

    // 1. Profile. AFTER discovery — by now you may already know the website and what they
    //    sell, from files you just read.
    if (!onboardingDone) {
      next_steps.push({
        id: 'onboarding',
        title: 'Finish onboarding the workspace',
        why: `Missing: ${profileMissing.join(', ')}. Everything else builds on the workspace knowing who you are and who you sell to.`,
        how: 'FIRST use whatever you learned in discover_context — if their files already name the company, the site, or who they sell to, do not ask again. For what is genuinely missing: ask for the company name + website, then RESEARCH the company from its website yourself (home, product, pricing, about, customers/case studies) so you can pre-fill instead of interrogating the user. Confirm service-or-software and a first cut of the ideal customer, then call set_workspace_profile. Treat this research as the groundwork for the GTM foundation next — dig in now, do not just collect a one-liner.',
      });
    }

    // 2. Context files — the ICP symbiosis. The user's ICP / positioning / pricing
    // live in their OWN repo files; the agent syncs them in with sync_icp (and the
    // learned model is written back with export_icp_model). If they have no such
    // files, the agent scaffolds a context/ folder. Comes right after the profile
    // because the scoring model is seeded from this. Claude Code only — other
    // clients have no filesystem, so the ICP is captured in set_workspace_profile.
    if (onboardingDone && !icpSync && !foundationDone) {
      next_steps.push({
        id: 'context_files',
        title: 'Sync the ICP & GTM context from the user\'s files (or scaffold them)',
        why: 'The ICP scoring model is seeded from the user\'s own ICP/positioning/pricing. Keeping it in their repo means they edit it in one place and Nous learns from it — no second copy to maintain.',
        how: 'CLAUDE CODE: first SCAN the project for existing context — folders like context/, .claude/, gtm/ and files named icp*, positioning*, pricing*, competitors*, market*. '
          + 'If found, read them and call sync_icp with each file mapped to a section (and its source_path). '
          + 'If NONE exist, SCAFFOLD a context/ folder — icp.md, positioning.md, pricing.md, market.md, competitors.md, gtm-motion.md — filled from the profile research you already did plus a short interview, then call sync_icp on them. '
          + 'For icp.md, use the CANONICAL ICP TEMPLATE below as the exact skeleton — keep every section heading (The buyer, Who is a fit, Who is NOT a fit, Trigger signals, Anchors) and the nous:icp block, and replace each <!-- guidance --> with the workspace\'s real answers. The buyer section is not optional: it is the qualitative context the scoring model and every agent read. '
          + 'sync_icp builds the scoring model on first sync, so after this accounts start getting scored. '
          + 'OTHER CLIENTS (Codex / claude.ai, no repo): skip the files — the ICP you set in set_workspace_profile is enough to seed the model; build_icp_model from there.\n\n'
          + '--- CANONICAL ICP TEMPLATE (context/icp.md) ---\n'
          + ICP_TEMPLATE,
      });
    }

    // 2b. Foundations — the policy layer. Make sure all four exist (voice, outreach,
    // icp, positioning), gathered WITH the user, mirrored to files where the runtime
    // has them. Only the missing slots are listed — a half-finished setup resumes here.
    if (onboardingDone && !foundationsComplete) {
      next_steps.push({
        id: 'setup_foundations',
        title: `Set up the foundations (${PB_KINDS.length - foundationsMissing.length}/4 done — missing: ${foundationsMissing.join(', ')})`,
        why: 'Foundations are the rules every agent obeys before it acts — voice, outreach, ICP, positioning. Set them up ONCE, with the user, and every agent (here, Claude Desktop, Codex, your own) reads the same versioned policy via get_foundation.',
        how: [
          'FRAME IT FIRST: tell the user you are setting up their foundations — the four rule-docs every agent obeys (voice, outreach, ICP, positioning) — that you will handle voice + outreach yourself, and need a little from them on ICP + positioning.',
          'DETECT THE ENVIRONMENT: check your OWN tools. Can you read/write files? If yes, look for a context/ folder + files (icp*, positioning*, voice*, outreach*). No file tools (Claude Desktop / claude.ai) = store in Nous only, no files.',
          'THEN, FOR EACH MISSING SLOT, pick a posture by how much content already exists:',
          '(a) CONTENT EXISTS — a real file, or a doc the user pastes: MIRROR it. Read it, confirm with the user ("found your ICP, bringing it in as-is, good?"), then sync_foundation(kind, body, file_path). If it looks stale/thin or conflicts with their recent deals, FLAG it — do not blindly copy.',
          '(b) INFERABLE — no doc but a website / a few customers: DRAFT from research, then CONFIRM. "I read your site, here is a draft ICP and positioning, two things to check: ..." then sync_foundation.',
          '(c) BLANK — nothing to go on: INTERVIEW. Ask together: ICP (industry, size, buyer role, the trigger), positioning (your category, your wedge, your competitors). Co-create, then sync_foundation.',
          'PER-KIND GATHERING: voice = infer from the user\'s REAL writing (their LinkedIn posts / sent emails), NEVER ask "what is your voice". outreach = start from the proven situation/insight/inquisition method, let them tweak. icp + positioning + competitors = interview or infer as above.',
          'WRITE IT: file-capable runtime -> write the file in that runtime\'s convention (Claude Code: context/...; Codex: AGENTS.md; else a nous/ folder) AND sync_foundation with file_path. No filesystem -> sync_foundation with NO file_path (stored in Nous).',
          'RULES: never silently create — always confirm the draft with the user first. Set up ONLY the missing slots; finished slots stay. When all four exist, you are done.',
        ].join(' '),
      });
    }

    // 3. Core channels — Gmail/email, LinkedIn, a meeting note-taker. These are
    // the first sources of truth. Connected in the APP (OAuth / native), not by
    // the agent.
    if (onboardingDone && !gmailConnected) {
      next_steps.push({
        id: 'connect_email',
        title: 'Connect email (Gmail, recommended)',
        why: 'Email is the main channel of record. Without it the account timeline stays empty.',
        how: selfHosted
          ? `Self-hosted: Gmail OAuth needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in nous.env${googleOauthEnv ? ' (set ✓ — the user connects on the Integrations page)' : ' (NOT set — the operator adds them + restarts first)'}. Custom SMTP/IMAP works with no env. You cannot set env vars — tell the operator.`
          : 'Gmail uses Google OAuth, so the user connects it on the Integrations page (you cannot do OAuth). If they are not on Google, they can add custom SMTP/IMAP there. Point them to it.',
      });
    }
    if (onboardingDone && !linkedinConnected) {
      next_steps.push({
        id: 'connect_linkedin',
        title: 'Connect LinkedIn (recommended)',
        why: 'LinkedIn is a core GTM channel. Nous has a native LinkedIn integration.',
        how: selfHosted
          ? `Self-hosted: LinkedIn runs on Unipile at the INSTANCE level — UNIPILE_API_KEY + UNIPILE_DSN in nous.env${unipileEnv ? ' (set ✓ — the user connects their account on the Integrations page)' : ' (NOT set — the operator must add these first; Unipile is a paid third-party account, then restart)'}. There is no public LinkedIn API; you cannot set env vars — tell the operator.`
          : 'There is NO public LinkedIn API — Nous connects it natively (via Unipile) and the user configures it on the Integrations page in the app. Tell them to set it up there; you cannot connect it programmatically. (Apify / HeyReach etc. are not needed — the native one covers it.)',
      });
    }
    if (onboardingDone && !meetingConnected) {
      next_steps.push({
        id: 'connect_meetings',
        title: 'Connect a meeting note-taker (recommended)',
        why: 'Calls become part of the record — what was discussed, objections, next steps.',
        how: 'Fireflies, Fathom, Calendly, or Cal.com. These connect in the app on the Integrations page (or via webhook). Recommend one.',
      });
    }

    // 3. Enrichment / outbound — agent CAN connect key-based ones directly.
    if (onboardingDone && !enrichment) {
      next_steps.push({
        id: 'connect_enrichment',
        title: 'Connect enrichment (Prospeo or Apollo)',
        why: 'Enrichment fills job title, seniority, company size — the signals the ICP model scores on.',
        how: 'These are key-based — ask the user for the API key and call connect_integration. Outbound senders (Instantly etc.) are key-based too.',
      });
    }

    // 4. Webhooks — so the tools just connected actually push data in.
    if (onboardingDone && verified.length > 0 && !hasWebhooks) {
      next_steps.push({
        id: 'webhooks',
        title: 'Set up webhooks for the tools you connected',
        why: 'Several tools (Instantly, Fireflies, Calendly, …) only deliver events via webhook, so without one their data never reaches Nous.',
        how: 'For each connected tool that pushes events, set up its webhook (set_trigger for outbound, or point the tool at the Nous inbound webhook on the Webhooks page). Especially the sequencer + note-taker.',
      });
    }

    // 5. First records — CSV into Accounts. But channels FIRST: a record imported
    // before any channel is connected has nothing to backfill activity from, so it
    // lands as a bare name + score with an empty timeline. Adapt the step.
    const anyChannelConnected = gmailConnected || linkedinConnected || meetingConnected;
    if (onboardingDone && recordCount === 0) {
      next_steps.push(anyChannelConnected
        ? {
            id: 'import_records',
            title: 'Add the first records (CSV, ideally from the CRM)',
            why: 'An empty workspace has nothing to score or act on. Importing the CRM contacts seeds the account record, and your connected channels can backfill their real activity.',
            how: 'Tell the user to upload a CSV on the Accounts page, ideally exported from their CRM. After import, run backfill enrichment + activity so the records get scored and their past interactions attach. You cannot upload the file — guide them to it.',
          }
        : {
            id: 'import_records',
            title: 'Connect a channel FIRST, then add records',
            why: 'Importing records before any channel (LinkedIn/Gmail/meeting note-taker) is connected leaves them as names with an ICP score but an EMPTY timeline — there is no connected source to backfill their past activity from. Connect channels first so the import actually comes alive.',
            how: 'Do NOT rush to a CSV yet. First get the core channels connected — LinkedIn + Gmail at minimum, ideally a meeting note-taker — and any other relevant tools, so that once records are imported you can backfill real activity onto them. ONLY THEN upload the CSV (ideally exported from the CRM) on the Accounts page. Importing into a workspace with no channels gives a score but no history.',
          });
    }

    // 6. GTM foundation — once the context is synced, turn it into a scoring model
    // and sharpen it on real outcomes. The context itself comes from the files
    // synced in step 2 (sync_icp); this step is the model on top of it.
    if (onboardingDone && !foundationDone) {
      next_steps.push({
        id: 'gtm_playbook',
        title: 'Build the ICP scoring model and sharpen it on real outcomes',
        why: 'No ICP scoring model yet, so accounts are not scored for fit. This is what makes Nous prioritise — and it is only as good as the context behind it.',
        how: 'The GTM context comes from the user\'s files (step 2, sync_icp), which usually builds the model on first sync. If it has not, OR to make it real: '
          + '(1) CONTEXT: make sure their context files are filled and synced (sync_icp) — a one-line ICP is not enough. Do REAL research of their website (home, product, pricing, about, case studies) to fill any gaps before syncing. '
          + '(2) CONFIRM: show the user the drafted context and let them correct it BEFORE you build anything — never build silently off your own guesses. '
          + '(3) OUTCOMES (ask EARLY): get a handful of closed-WON and closed-LOST customer domains and call train_icp_model — a model trained on real outcomes beats one from a description, and the won-vs-lost contrast sharpens the ICP. '
          + '(4) BUILD: if no model exists yet, call build_icp_model. '
          + '(5) WRITE BACK: call export_icp_model and write the learned model into the user\'s context/icp.md so their file reflects what Nous learned.',
      });
    }

    // 6a. ICP file write-back — the model has learned new signals since the ICP
    // file was last synced, so the file is stale. Nudge the agent to write it back.
    if (icpSync?.model_changed) {
      next_steps.push({
        id: 'icp_writeback',
        title: 'Write the updated ICP model back to the file',
        why: `The scoring model has evolved since ${icpSync.synced_from} was last synced — the learned block in that file is out of date.`,
        how: `Call export_icp_model and write the returned block into ${icpSync.synced_from} (replace the existing block between the nous:icp markers). If the user has edited that file, re-run sync_icp first to pull their changes back in.`,
      });
    }

    // 6b. Routing preferences — Claude Code only, optional finishing touch once
    // the workspace is set up. (No done-signal exists, so it's surfaced as the
    // last optional step.)
    if (onboardingDone && foundationDone) {
      next_steps.push({
        id: 'routing_preferences',
        title: 'Set routing preferences (Claude Code, optional)',
        why: 'So GTM questions default to Nous even when the user does not say "Nous" — instead of the agent reaching for raw CRM/HubSpot/Salesforce/Gong/Granola.',
        how: 'ONLY if you are Claude Code: call get_routing_preferences and write the text to the user\'s CLAUDE.md (ask: this project ./CLAUDE.md, or all projects ~/.claude/CLAUDE.md). Not applicable to Codex/other clients — skip it there.',
      });
    }

    // 7. CRM sync — only if the plan includes it.
    if (onboardingDone && crmSyncAvailable && !crmSyncConfigured) {
      next_steps.push({
        id: 'crm_sync',
        title: 'Set up CRM sync',
        why: 'Keeps the account record in step with the system of record.',
        how: 'Confirm which CRM (must be connected) and the create/hygiene policy, then configure_crm_sync.',
      });
    }

    if (hygieneOpen > 0) {
      next_steps.push({
        id: 'hygiene_review',
        title: `${hygieneOpen} hygiene proposal${hygieneOpen === 1 ? '' : 's'} awaiting review`,
        why: 'Hygiene proposals are human accept/deny decisions — surface them so they do not pile up.',
        how: 'Point the user to the CRM Sync page to accept or dismiss them.',
      });
    }

    return res.json({
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name || null,
            website: workspace.website || null,
            business_type: workspace.business_type || null,
            plan_model: workspace.plan_model || null,
            default_signup_stage: workspace.default_signup_stage || null,
          }
        : { id: workspaceId },
      plan: {
        id: plan?.id || 'free',
        name: plan?.name || plan?.id || 'free',
        crm_sync: crmSyncAvailable,
        lead_lists: leadListsAvailable,
        icp_scoring: icpScoringAvailable,
      },
      self_hosted: selfHosted,
      // On self-host, these channels are wired via nous.env (instance-level), not
      // per-workspace. true = the env vars are set; the agent guides the operator
      // to set the missing ones + restart (it cannot set env itself).
      env_integrations: selfHosted
        ? { linkedin_unipile: unipileEnv, email_resend: resendEnv, gmail_oauth: googleOauthEnv }
        : null,
      setup: {
        // THE GATE. Same question, same answer, as /api/onboarding/status. If this is
        // false the workspace is not set up, whatever else on this object says.
        icp: {
          done: icpDone,
          source: icpSlot?.source ?? null,        // 'claude_code' = their repo is the author
          file_path: icpSlot?.file_path ?? null,
        },
        onboarding: { done: onboardingDone, missing: profileMissing },
        gtm_playbook: {
          done: foundationDone,
          facts: foundationFacts.length,
          icp_facts: icpNotes.length,
          model: hasModel,
          stale_facts: staleFacts,
        },
        icp_sync: icpSync,
        foundations: { complete: foundationsComplete, missing: foundationsMissing, slots: foundations },
        integrations: { count: verified.length, connected: connectedList },
        // The recommended onboarding integrations, in priority order.
        recommended: {
          email: gmailConnected,
          linkedin: linkedinConnected,
          meeting_notetaker: meetingConnected,
          enrichment: !!enrichment,
        },
        records: { count: recordCount },
        crm_sync: {
          available: crmSyncAvailable,
          configured: crmSyncConfigured,
          providers: crmProviders,
          pending_hygiene_proposals: hygieneOpen,
        },
        enrichment: { connected: !!enrichment, provider: enrichment?.provider?.display_name || null },
        webhooks: { count: webhookCount },
        triggers: { count: triggerCount },
      },
      next_steps,
    });
  } catch (err) {
    console.error('[GET /v2/workspace/status]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/onboarding ────────────────────────────────────────────
// Agent-driven onboarding: write the workspace's basic identity. Mirrors what
// the app's onboarding wizard used to collect (step-1 + business-type), but the
// agent does it for the user.
workspaceStatusV2Router.post('/onboarding', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { name, website, business_type, plan_model, default_signup_stage, icp } = req.body || {};

    if (business_type != null && business_type !== 'service' && business_type !== 'software') {
      return res.status(400).json({ error: 'business_type must be "service" or "software"' });
    }
    if (business_type === 'software' && plan_model &&
        !['free_plan', 'free_trial', 'both', 'paid_only'].includes(plan_model)) {
      return res.status(400).json({ error: 'invalid plan_model' });
    }

    // Update the structured fields on the workspace (only what was sent).
    const updates = {};
    if (typeof name === 'string' && name.trim())       updates.name = name.trim();
    if (typeof website === 'string' && website.trim()) updates.website = website.trim();
    if (business_type) {
      updates.business_type = business_type;
      updates.plan_model = business_type === 'software' ? (plan_model || null) : null;
      updates.default_signup_stage =
        (default_signup_stage || '').toString().trim()
        || (business_type === 'service' ? 'Lead' : 'Free User');
    } else if (default_signup_stage) {
      updates.default_signup_stage = String(default_signup_stage).trim();
    }

    if (Object.keys(updates).length) {
      const { error } = await supabase.from('workspaces').update(updates).eq('id', workspaceId);
      if (error) throw error;
    }

    // Mirror the website + ICP as memory facts (the canonical sources the
    // Scorecard auto-build reads), matching the old onboarding wizard.
    if (typeof website === 'string' && website.trim()) {
      await safe(() => saveNote(supabase, workspaceId, {
        category: 'Company',
        content: `Company website: ${website.trim()}`,
        source: 'onboarding',
      }));
    }
    // The ICP goes through the one write path, so it lands in the Vault as well as in
    // memory. This used to save the note alone, which meant an agent could call
    // set_workspace_profile with a perfectly good ICP and the Vault would still be empty
    // — and /api/onboarding/status, which gates on the Vault, would still say the
    // workspace wasn't set up. See lib/icp.mjs.
    if (typeof icp === 'string' && icp.trim()) {
      await safe(() => writeIcp(supabase, workspaceId, { body_md: icp.trim(), source: 'nous' }));
    }

    const { data: workspace } = await supabase
      .from('workspaces')
      .select('id, name, website, business_type, plan_model, default_signup_stage')
      .eq('id', workspaceId)
      .maybeSingle();

    return res.json({ ok: true, workspace: workspace || { id: workspaceId } });
  } catch (err) {
    console.error('[POST /v2/workspace/onboarding]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/scoring-model ─────────────────────────────────────────
// Agent-callable: build (or rebuild) the ICP scoring model from the GTM context
// the workspace has recorded. This is the second half of building the GTM
// foundation — the agent syncs the context from the user's files with sync_icp, then
// calls this to turn it into a weighted scoring model. Pass force:true to rebuild over
// an existing model. Shares its implementation with the human web route.
workspaceStatusV2Router.post('/scoring-model', requireFeature('icpScoring'), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const force = req.body?.force === true;
    const r = await seedScorecardFromMemory(supabase, req.workspaceId, { force });

    if (r.status === 'exists') {
      return res.status(409).json({
        error: 'model_exists',
        message: 'A scoring model already exists. Pass force:true to rebuild it.',
        signals: r.signals,
      });
    }
    if (r.status === 'no_icp_memory') {
      return res.status(400).json({
        error: 'no_gtm_context',
        message: 'No GTM context yet. Sync the user\'s ICP/context files with sync_icp first (or scaffold context/icp.md, then sync_icp), then build the model.',
      });
    }
    if (r.status === 'translation_failed') {
      return res.status(502).json({ error: 'translation_failed', message: 'Could not build a model from the current context.' });
    }
    return res.status(201).json({ ok: true, signals: r.signals });
  } catch (err) {
    console.error('[POST /v2/workspace/scoring-model]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/integrations ──────────────────────────────────────────
// Agent-callable: connect a KEY-BASED integration (Apollo, Prospeo, Instantly,
// HubSpot, …) by supplying credentials. OAuth providers can't be done this way
// (they need a browser) — the agent is told to send the user to Integrations.
// Mirrors the web connect route: tests the credentials, then stores them
// encrypted exactly the same way.
// GET /v2/workspace/scorecard — the ICP scorecard summary + win/loss drivers,
// for external surfaces (Partner OS Foundations page). accounts_analyzed = scored
// predictions; closed_won/lost = decided outcomes; signals = the weighted
// drivers (positive = win, negative = loss), highest weight first.
workspaceStatusV2Router.get('/scorecard', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const ws = req.workspaceId;
    const [tot, won, lost, signals] = await Promise.all([
      supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws),
      supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('outcome_value->>disposition', 'won'),
      supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('outcome_value->>disposition', 'lost'),
      listSignals(supabase, ws),
    ]);
    const sig = (signals || []).map((s) => ({ key: s.key, label: s.label, weight: s.weight }));
    return res.json({
      accounts_analyzed: tot.count ?? 0,
      closed_won: won.count ?? 0,
      closed_lost: lost.count ?? 0,
      signals_count: sig.length,
      signals: sig,
    });
  } catch (err) {
    console.error('[GET /v2/workspace/scorecard]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/workspace/integrations — the workspace's CONNECTED integrations
// (read-only; the connect flow is the POST below). Used by Partner OS to surface
// an agency's own connected providers. Dedupes by provider, newest first.
workspaceStatusV2Router.get('/integrations', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('workflow_provider_connections')
      .select('name, is_verified, created_at, provider:workflow_providers(name, display_name, logo_url, category)')
      .eq('workspace_id', req.workspaceId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const seen = new Set();
    const integrations = [];
    for (const c of data || []) {
      const key = c.provider?.name || c.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      integrations.push({
        provider: key,
        display_name: c.provider?.display_name || key,
        category: c.provider?.category || null,
        logo_url: c.provider?.logo_url || null,
        verified: !!c.is_verified,
      });
    }
    return res.json({ integrations });
  } catch (err) {
    console.error('[GET /v2/workspace/integrations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

workspaceStatusV2Router.post('/integrations', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { provider, credentials, name } = req.body || {};
    if (!provider || !credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'provider_and_credentials_required' });
    }

    // created_by is NOT NULL. API-key auth has no user, so attribute the connection to a
    // workspace member (prefer the owner).
    const { data: members } = await supabase
      .from('workspace_members').select('user_id, role').eq('workspace_id', req.workspaceId);
    const createdBy = (members || []).find(m => m.role === 'owner')?.user_id || members?.[0]?.user_id;
    if (!createdBy) return res.status(400).json({ error: 'no_workspace_member' });

    // The same connect the two web surfaces run. It refuses OAuth providers, tests the key
    // before saving, and registers the provider's webhook off that key.
    //
    // That last part is new HERE. This route used to test and save and stop, so an agent
    // that connected Lemlist produced a connection with no webhook — no error, no events,
    // nothing to debug. Whichever door you come through, you now get the same setup.
    const result = await connectProvider({
      supabase,
      workspaceId:    req.workspaceId,
      providerName:   provider,
      credentials,
      connectionName: name,
      userId:         createdBy,
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, message: result.message });
    }

    return res.status(201).json({
      ok: true,
      connection: { ...result.connection, provider: String(provider).toLowerCase() },
      webhook_registered: result.webhookRegistered,
      message: result.note || 'Connected.',
    });
  } catch (err) {
    console.error('[POST /v2/workspace/integrations]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/crm-sync ──────────────────────────────────────────────
// Agent-callable: configure CRM sync rules — the same options as the CRM Sync
// setup form. The CRM must already be connected (OAuth connect stays a human
// step). Cloud-only Pro+ feature, gated like the web route.
const CREATE_TRIGGERS = ['any_reply_or_meeting', 'positive_reply_or_meeting', 'meeting_only', 'interested_stage'];
const HYGIENE_CADENCES = ['weekly', 'monthly'];
workspaceStatusV2Router.post('/crm-sync', requireFeature('crmSync'), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { provider, autoSync, pushActivities, createInCrm, createTrigger: createTrig,
            createRequireIcpFit, createIcpThreshold, hygieneEnabled, hygieneCadence } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'provider_required' });

    // Resolve the connected CRM for this provider.
    const { data: conns } = await supabase
      .from('workflow_provider_connections')
      .select('id, provider:workflow_providers(name)')
      .eq('workspace_id', workspaceId);
    const match = (conns || []).find(c => c.provider?.name === String(provider).toLowerCase());
    if (!match) {
      return res.status(400).json({ error: 'crm_not_connected', message: `${provider} isn't connected. Connect it on the Integrations page first.` });
    }

    const { data: existing } = await supabase.from('crm_sync_configs')
      .select('auto_sync, push_activities, create_in_crm, create_trigger, create_require_icp_fit, create_icp_threshold, hygiene_enabled, hygiene_cadence')
      .eq('workspace_id', workspaceId).eq('provider', String(provider).toLowerCase()).maybeSingle();

    const payload = {
      workspace_id: workspaceId,
      connection_id: match.id,
      provider: String(provider).toLowerCase(),
      auto_sync:       typeof autoSync       === 'boolean' ? autoSync       : (existing?.auto_sync       ?? false),
      push_activities: typeof pushActivities === 'boolean' ? pushActivities : (existing?.push_activities ?? true),
      create_in_crm:          typeof createInCrm         === 'boolean' ? createInCrm         : (existing?.create_in_crm          ?? true),
      create_trigger:         CREATE_TRIGGERS.includes(createTrig)     ? createTrig         : (existing?.create_trigger          ?? 'positive_reply_or_meeting'),
      create_require_icp_fit: typeof createRequireIcpFit === 'boolean' ? createRequireIcpFit : (existing?.create_require_icp_fit ?? true),
      create_icp_threshold:   Number.isFinite(createIcpThreshold)      ? Math.max(0, Math.min(100, Math.round(createIcpThreshold))) : (existing?.create_icp_threshold ?? 70),
      hygiene_enabled: typeof hygieneEnabled === 'boolean' ? hygieneEnabled : (existing?.hygiene_enabled ?? true),
      hygiene_cadence: HYGIENE_CADENCES.includes(hygieneCadence)       ? hygieneCadence     : (existing?.hygiene_cadence ?? 'weekly'),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('crm_sync_configs')
      .upsert(payload, { onConflict: 'workspace_id,provider' }).select().single();
    if (error) throw error;
    return res.json({ ok: true, config: data });
  } catch (err) {
    console.error('[POST /v2/workspace/crm-sync]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/crm-sync-now ──────────────────────────────────────────
// Agent-callable: run an immediate incremental pull NOW instead of waiting for
// the daily cron. Same code path (syncCrmProvider) the auto-sync worker uses, so
// manual and scheduled pulls stay consistent. CRM must already be configured.
const SYNC_NOW_PROVIDERS = ['hubspot', 'pipedrive', 'attio'];
workspaceStatusV2Router.post('/crm-sync-now', requireFeature('crmSync'), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const provider = String(req.body?.provider || 'hubspot').toLowerCase();
    const full = req.body?.full === true;
    if (provider === 'salesforce') return res.status(400).json({ error: 'salesforce_not_yet_supported' });
    if (!SYNC_NOW_PROVIDERS.includes(provider)) return res.status(400).json({ error: `unsupported_provider: ${provider}` });

    const { data: cfg } = await supabase.from('crm_sync_configs')
      .select('id, last_synced_at, contacts_synced')
      .eq('workspace_id', workspaceId).eq('provider', provider).maybeSingle();
    if (!cfg) return res.status(400).json({ error: 'sync_not_configured', message: `Configure ${provider} sync first with configure_crm_sync.` });

    const token = await resolveCrmTokenForProvider(supabase, workspaceId, provider);
    if (!token) return res.status(400).json({ error: 'crm_not_connected', message: `${provider} isn't connected. Connect it on the Integrations page first.` });

    const startedAt = new Date().toISOString();
    // full=true re-fetches everything; otherwise resume from the last cursor.
    const since = full ? null : (cfg.last_synced_at || null);
    let result;
    try {
      result = await syncCrmProvider(supabase, workspaceId, provider, token, since);
    } catch (err) {
      return res.status(502).json({ error: 'provider_fetch_failed', message: err.message });
    }

    // Advance the cursor only on a clean run, so a partial failure retries the
    // same window next time (no missed records).
    const patch = {
      contacts_synced: (cfg.contacts_synced || 0) + result.contacts.inserted + result.companies.inserted,
      updated_at: new Date().toISOString(),
    };
    if (result.errors.length === 0) patch.last_synced_at = startedAt;
    await supabase.from('crm_sync_configs').update(patch).eq('id', cfg.id);

    const fetched = result.contacts.fetched + result.companies.fetched + result.deals.fetched;
    const created = result.contacts.inserted + result.companies.inserted + result.deals.inserted;
    const updated = result.contacts.updated + result.companies.updated + result.deals.updated;
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source: provider,
      event_type: result.errors.length ? 'sync_partial' : 'sync_complete',
      summary: `Pulled ${fetched} from ${provider} — ${created} new, ${updated} updated${result.errors.length ? ` · ${result.errors.length} errors` : ''}`,
      metadata: { trigger: 'agent', ...result },
    }).then(() => {}, () => {});

    return res.json({ ok: true, provider, fetched, created, updated, errors: result.errors });
  } catch (err) {
    console.error('[POST /v2/workspace/crm-sync-now]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /v2/workspace/crm-sync ───────────────────────────────────────────────
// The read side Partner OS (and agents) need to render the CRM Sync view: which
// CRMs are connected, the current sync config, open hygiene count, recent log.
workspaceStatusV2Router.get('/crm-sync', requireFeature('crmSync'), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    // Connected CRM providers (the OAuth connect is a human step in Nous).
    const CRM_PROVIDERS = ['hubspot', 'pipedrive', 'attio', 'salesforce'];
    const { data: conns } = await supabase
      .from('workflow_provider_connections')
      .select('id, provider:workflow_providers(name)')
      .eq('workspace_id', workspaceId);
    const connected = [...new Set((conns || []).map(c => c.provider?.name).filter(n => CRM_PROVIDERS.includes(n)))];

    const { data: cfg } = await supabase.from('crm_sync_configs')
      .select('provider, auto_sync, push_activities, create_in_crm, create_trigger, create_require_icp_fit, create_icp_threshold, hygiene_enabled, hygiene_cadence, last_synced_at, contacts_synced')
      .eq('workspace_id', workspaceId).maybeSingle();

    const openHygiene = await countHygieneProposals(supabase, workspaceId, 'proposed');
    const { data: log } = await supabase.from('workspace_system_log')
      .select('source, event_type, summary, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false }).limit(20);

    return res.json({
      connected_providers: connected,
      config: cfg || null,
      open_hygiene: openHygiene,
      log: (log || []).map(e => ({ provider: e.source, type: e.event_type, summary: e.summary, ts: e.created_at,
        level: /fail|error|partial/.test(e.event_type || '') ? 'fail' : /dismiss/.test(e.event_type || '') ? 'warn' : 'ok' })),
    });
  } catch (err) {
    console.error('[GET /v2/workspace/crm-sync]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /v2/workspace/crm-hygiene ────────────────────────────────────────────
// Open (or filtered) hygiene proposals, with the contact each one targets.
workspaceStatusV2Router.get('/crm-hygiene', requireFeature('crmSync'), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const proposals = await listHygieneProposals(supabase, workspaceId, {
      status: req.query.status || 'proposed',
      limit: Math.min(Number(req.query.limit) || 100, 200),
    });
    const entityIds = [...new Set(proposals.map(p => p.entity_id).filter(Boolean))];
    const byId = {};
    if (entityIds.length) {
      const { data: contacts } = await supabase.from('contacts')
        .select('id, first_name, last_name, email, company').in('id', entityIds);
      for (const c of contacts || []) byId[c.id] = { name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, email: c.email || null, company: c.company || null };
    }
    return res.json({ proposals: proposals.map(p => ({ ...p, contact: p.entity_id ? byId[p.entity_id] ?? null : null })) });
  } catch (err) {
    console.error('[GET /v2/workspace/crm-hygiene]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/crm-hygiene/:id ───────────────────────────────────────
// Approve or dismiss a hygiene proposal (records the decision; applying to the
// CRM stays the /api path's job for now).
workspaceStatusV2Router.post('/crm-hygiene/:id', requireFeature('crmSync'), async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const status = req.body?.status;
    if (!['approved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'status must be approved or dismissed' });
    const row = await updateHygieneProposalStatus(supabase, workspaceId, req.params.id, status);
    if (!row) return res.status(404).json({ error: 'proposal_not_found' });
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId, source: row.provider,
      event_type: status === 'approved' ? 'proposal_approved' : 'proposal_dismissed',
      summary: `${status === 'approved' ? 'Approved' : 'Dismissed'} ${row.kind}${row.field ? ` — ${row.field}` : ''}`,
      contact_id: row.entity_id || null, metadata: { proposal_id: row.id, kind: row.kind },
    }).then(() => {}, () => {});
    return res.json({ ok: true, status });
  } catch (err) {
    console.error('[POST /v2/workspace/crm-hygiene/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET/POST /v2/workspace/triggers ──────────────────────────────────────────
// Agent-callable: list or create outbound event triggers (webhooks). The agent
// wires the user's stack to fire on record changes.
workspaceStatusV2Router.get('/triggers', async (req, res) => {
  try {
    const triggers = await listTriggers(getSupabaseClient(), req.workspaceId);
    return res.json({ triggers, available_events: TRIGGER_EVENTS });
  } catch (err) {
    console.error('[GET /v2/workspace/triggers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
workspaceStatusV2Router.post('/triggers', async (req, res) => {
  try {
    const { name, url, events } = req.body || {};
    if (!url || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'url_and_events_required', available_events: TRIGGER_EVENTS });
    }
    const trigger = await createTrigger(getSupabaseClient(), req.workspaceId, { name, url, events });
    return res.status(201).json({ ok: true, trigger });
  } catch (err) {
    if (err?.message) return res.status(400).json({ error: err.message, available_events: TRIGGER_EVENTS });
    console.error('[POST /v2/workspace/triggers]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/closed-deals ──────────────────────────────────────────
// Agent-callable: build the ICP scoring model from REAL closed deals. Enriches
// each domain, links known contacts, and runs contrastive lift (won vs lost) to
// discover the signals that actually predict revenue, then re-scores open
// accounts. Shares its implementation with the web "Add deals" flow.
workspaceStatusV2Router.post('/closed-deals', async (req, res) => {
  try {
    const { won = [], lost = [] } = req.body || {};
    const r = await runClosedDeals(getSupabaseClient(), req.workspaceId, { won, lost });
    if (r.need_more_deals) {
      return res.status(400).json({ error: 'need_more_deals', message: 'Give at least one closed-won or closed-lost domain.' });
    }
    return res.status(201).json({ ok: true, ...r });
  } catch (err) {
    console.error('[POST /v2/workspace/closed-deals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /v2/workspace/icp/import ─────────────────────────────────────────────
// The file→Nous direction of the ICP symbiosis (sync_icp). The agent reads the
// user's EXISTING ICP/positioning files (context/icp.md, etc.) and posts each
// section's content + the file it came from. Nous mirrors each section as a GTM
// context fact (recording source_path so the write-back knows the target file),
// then rebuilds the scoring model from the freshly synced context. Their file
// stays the source of truth for the prose; Nous keeps a served copy + the model.
// NOT gated on icpScoring: importing the ICP prose is the finish line of onboarding and
// must work everywhere, including self-host. Only the LEARNED scoring model below is the
// Cloud feature — on self-host we still record the ICP, we just skip the model.
workspaceStatusV2Router.post('/icp/import', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const sections = Array.isArray(req.body?.sections) ? req.body.sections : [];
    if (!sections.length) {
      return res.status(400).json({ error: 'no_sections', message: 'Pass sections: [{ section, content, source_path }].' });
    }

    const valid = new Set(ALL_SECTIONS);
    const imported = [];
    const skipped = [];
    const warnings = [];        // non-blocking nudges (e.g. ICP missing a canonical section)
    const sourceFactIds = [];   // facts carrying a source_path, to stamp the model version
    for (const s of sections) {
      const name = String(s?.section || '').trim();
      const content = String(s?.content || '').trim();
      if (!valid.has(name) || !content) { skipped.push(name || '(unnamed)'); continue; }
      const sourcePath = s?.source_path ? String(s.source_path).trim() : null;
      const r = await writeWorkspaceFact(supabase, req.workspaceId, {
        section: name,
        content,
        source: 'icp-file',
        sourcePath,
        syncedHash: createHash('sha256').update(content).digest('hex').slice(0, 16),
      });
      if (sourcePath && r?.fact?.id) sourceFactIds.push(r.fact.id);

      // The ICP section ALSO goes through the one ICP write path (foundation + note + cache),
      // because that foundation row IS the onboarding gate and what the Vault / get_foundation
      // serve. Without this, sync_icp populates the scoring facts but the gate stays closed
      // and ConnectGate never unlocks. source claude_code when it came from a repo file.
      if (name === 'ICP') {
        await safe(() => writeIcp(supabase, req.workspaceId, {
          body_md: content,
          source: sourcePath ? 'claude_code' : 'nous',
          file_path: sourcePath,
        }));

        // Section-check against the canonical template — a nudge, not a gate. A
        // complete ICP names its buyer, its fit/not-fit, its triggers and anchors;
        // a file missing those still syncs, but we tell the agent what to add so
        // the file (and the model seeded from it) gets sharper next edit.
        const missing = missingIcpSections(content);
        if (missing.length) {
          warnings.push({
            section: 'ICP',
            code: 'missing_canonical_sections',
            missing,
            message: `The ICP file synced, but it's missing ${missing.length} canonical section${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Add ${missing.length === 1 ? 'it' : 'them'} (see the canonical ICP template) and re-sync so the scoring model reads a complete definition.`,
          });
        }
      }
      imported.push({ section: name, source_path: sourcePath });
    }

    if (!imported.length) {
      return res.status(400).json({ error: 'no_valid_sections', message: `No valid sections. Use one of: ${ALL_SECTIONS.join(', ')}.`, skipped });
    }

    // Rebuild the model from the freshly synced context (force — the context just changed).
    // The ICP scoring model is fully open, including self-host — it runs on the operator's
    // own key, so accounts get real 0-100 scores everywhere.
    const seed = await seedScorecardFromMemory(supabase, req.workspaceId, { force: true });

    // Stamp the model version this synced context produced onto the source facts,
    // so get_workspace_status can detect the model drifting away from what was last
    // written back (the write-back drift flag).
    const mv = (seed.signals && seed.signals.length) ? modelVersion(seed.signals) : null;
    if (mv && sourceFactIds.length) {
      for (const id of sourceFactIds) {
        await safe(async () => {
          const { data: cur } = await supabase.from('claims').select('value').eq('id', id).eq('workspace_id', req.workspaceId).maybeSingle();
          const val = cur?.value ?? {};
          const m = { ...(val.metadata ?? {}), synced_model_version: mv };
          await supabase.from('claims').update({ value: { ...val, metadata: m } }).eq('id', id).eq('workspace_id', req.workspaceId);
        });
      }
    }

    return res.status(201).json({
      ok: true,
      imported,
      skipped,
      warnings,
      model_status: seed.status,
      signals: seed.signals ?? [],
      model_version: mv,
    });
  } catch (err) {
    console.error('[POST /v2/workspace/icp/import]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /v2/workspace/icp/model ───────────────────────────────────────────────
// The Nous→file direction of the ICP symbiosis (export_icp_model). Returns the
// learned scoring model (signals + lift + calibration) rendered as the fenced
// <!-- nous:icp --> block, plus the target file path Nous recorded at import.
// The agent writes the block back into that file with its native editor.
workspaceStatusV2Router.get('/icp/model', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const model = await computeIcpModel(supabase, req.workspaceId);
    const target_path = await findIcpSourcePath(supabase, req.workspaceId);
    const block = renderIcpBlock(model, {});
    return res.json({
      has_model: model.has_model,
      has_outcomes: model.has_outcomes ?? false,
      target_path,
      block,
      block_start: '<!-- nous:icp start -->',
      block_end: '<!-- nous:icp end -->',
      signals: model.signals,
      calibration: model.calibration,
      model_version: model.model_version,
    });
  } catch (err) {
    console.error('[GET /v2/workspace/icp/model]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

