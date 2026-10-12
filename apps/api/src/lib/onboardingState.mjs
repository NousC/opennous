// One answer to "is this workspace set up", for every surface that asks.
//
// There were two, and they disagreed. The app's router gate read
// `onboarding_activated_at || hasIcp`; `whoami` — what the revenue plugin reads — read
// `onboarding_activated_at || has_icp || accounts > 0`, under a comment claiming it mirrored
// the app. It did not. So a workspace the plugin had fully onboarded still had the app insist
// on running its own welcome flow, because the plugin never stamped anything the app looked at.
//
// It only ever appeared to work because plugin onboarding used to open by writing an ICP, which
// flipped the flag both gates happened to share. That is no longer true: the ICP is now built
// from closed deals on both surfaces, so a perfectly onboarded workspace can legitimately have
// no hand-written ICP at all.
//
// The fix is a fact, not a cleverer expression. Whoever finishes setting a workspace up STAMPS
// it, and everyone else reads the stamp.

/**
 * Stamp a workspace as activated, once. Called by whatever completes setup, on either surface:
 * the app's `complete_onboarding`, and the plugin's ICP writes (`set_icp`,
 * `record_closed_deals`) which are the last step of its onboarding.
 *
 * Never un-stamps and never overwrites an existing timestamp — the first completion is the
 * true one, and a later re-run is not a second onboarding. Best-effort: failing to record that
 * setup finished must not fail the thing that finished it.
 */
export async function markWorkspaceActivated(supabase, workspaceId, reason = 'unknown') {
  if (!workspaceId) return false;
  try {
    const { data: ws } = await supabase
      .from('workspaces').select('onboarding_activated_at').eq('id', workspaceId).maybeSingle();
    if (ws?.onboarding_activated_at) return false;         // already stamped — leave it alone

    const { error } = await supabase.from('workspaces')
      .update({ onboarding_activated_at: new Date().toISOString() })
      .eq('id', workspaceId).is('onboarding_activated_at', null);
    if (error) { console.error('[ONBOARDING_STATE] stamp failed:', error.message); return false; }
    console.log(`[ONBOARDING_STATE] ws=${workspaceId} activated (${reason})`);
    return true;
  } catch (e) {
    console.error('[ONBOARDING_STATE] stamp failed:', e?.message || e);
    return false;
  }
}

/**
 * Is this workspace set up? ONE expression, read by the app's router gate and by `whoami`.
 *
 * `accounts > 0` stays in it deliberately. It is not a guess — a graph with people in it was
 * set up by somebody, on some surface, and this is what keeps workspaces that predate the
 * stamp out of a setup flow they already finished. Dropping it to make the two gates match
 * would have made them match by breaking the older one.
 */
export function isWorkspaceSetUp({ activatedAt = null, hasIcp = false, accounts = 0 } = {}) {
  return !!activatedAt || !!hasIcp || (Number(accounts) || 0) > 0;
}

// ── Self-serve onboarding: OFF for V1 ────────────────────────────────────────
//
// V1 is done-for-you. The first clients are onboarded BY HAND, by an operator running the
// revenue plugin against their workspace: tools connected, six months backfilled, the ICP built
// from their closed deals, the revenue report handed over as an artifact. By the time the
// customer first signs in, their workspace is already full.
//
// Which makes the in-app welcome conversation actively wrong right now. It would open by
// offering to connect a CRM that is already connected and set up a pipeline that already
// exists — the product asking a customer to do work somebody already did for them, which reads
// as the product not knowing its own state.
//
// So it is switched off rather than deleted. V2 is the same conversation turned back on when
// onboarding becomes self-serve: set SELF_SERVE_ONBOARDING=true. Everything it needs stays
// exactly where it is — the `welcome` skill, the agent's onboarding tools, the router gate.
//
// Default ON since GET-517 (2026-09-28): onboarding is self-serve now — the agent walks a new
// Workspace owner through CRM, email and meeting notes, and the backfill estimate. Set
// SELF_SERVE_ONBOARDING=false to go back to operator-led onboarding.
//
// ⚠ This gates COMPANY onboarding only — the CRM, the stages, the ICP, the whole-book reports.
// SEAT onboarding is never gated and must never be, because it is the one part nobody can do
// for the customer. A rep's notetaker key only ever sees the calls THEY recorded; their mailbox
// only holds their threads. An operator can hand a company a fully built graph and still not
// connect a single rep's own sources — so a new team member joining an already-running
// workspace still needs their own first conversation, in V1 exactly as much as in V2.
//
// (Learned the hard way: the first version of this flag keyed off `canOnboard`, which `seatOnly`
// is derived from, so switching company onboarding off silently switched seat onboarding off
// too — and the app stopped asking new reps for the only thing it needed from them.)
export function selfServeOnboardingEnabled() {
  return String(process.env.SELF_SERVE_ONBOARDING || 'true').toLowerCase() !== 'false';
}
