// GET /api/auth/config: read by the login/signup UI before auth. Lets a self-host hide
// the "Create account" path (DISABLE_SIGNUPS) and the Google button when Google OAuth
// isn't configured.
//
// DISABLE_SIGNUPS=true without SELFHOST_SETUP_TOKEN (an install on an external Supabase
// project): registration stays OPEN until the first user (the owner) exists, then closes.
//
// DISABLE_SIGNUPS=true with SELFHOST_SETUP_TOKEN (the bundled stack): closed from the
// start, because the owner signs up through the setup link. signupsDisabled is always
// true and `setupRequired` says whether the owner still has to do that. The field is
// present only on such an instance; every other deployment, Cloud included, gets exactly
// { signupsDisabled, googleEnabled, authProvider }.
//
// Both mirror the server gate in ensureUserAndTeam (lib/instanceOwner.mjs).

import { getSupabaseClient } from '@nous/core';
import { resolveAuthProviderName } from './authProvider/index.mjs';
import { configuredSetupToken, ownerExists } from './instanceOwner.mjs';

export async function buildAuthConfig({ env = process.env, getClient = getSupabaseClient } = {}) {
  let signupsDisabled = false;
  let setupRequired;
  if (env.DISABLE_SIGNUPS === 'true') {
    let supabase = null;
    try { supabase = getClient(); } catch { /* ownerExists falls back */ }
    if (configuredSetupToken(env)) {
      signupsDisabled = true;
      // On error, report set-up as still open: the page then offers the setup form, and
      // the API still refuses anyone without the token.
      setupRequired = !(await ownerExists(supabase, { env, fallback: false }));
    } else {
      // On error, don't lock the owner out.
      signupsDisabled = await ownerExists(supabase, { env, fallback: false });
    }
  }
  return {
    signupsDisabled,
    googleEnabled: Boolean(env.GOOGLE_CLIENT_ID),
    // Which auth provider this API verifies tokens with (GET-577). The frontend
    // picks its own at build time; this lets it tell a mismatched build apart.
    authProvider: resolveAuthProviderName(env),
    ...(setupRequired !== undefined && { setupRequired }),
  };
}
