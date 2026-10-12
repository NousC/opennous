// The one door between the public worker and the Workspace (Cloud) layer — GET-754.
//
// Everything that only runs on app.opennous.cloud lives under src/cloud/. The open-source
// export is this repo minus those folders, so nothing outside src/cloud/ imports from it
// (scripts/check-cloud-imports.mjs enforces that). This file is the only place that reaches
// in, and it checks the folder exists first: without it, loadCloud() resolves to null and the
// worker runs as a plain self-hosted install.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLOUD_ENTRY = new URL('../cloud/index.mjs', import.meta.url);

/** True when this checkout carries the Workspace layer (Cloud). Fixed for the process. */
export const HAS_CLOUD = existsSync(fileURLToPath(CLOUD_ENTRY));

// A Cloud deploy without the cloud folder would not crash: it would boot as a self-hosted
// install, with plan limits and billing off and auth on Supabase, so every Clerk session
// fails and nobody is billed. Clerk is Cloud-only, so its key marks a Cloud deploy: refuse
// to start rather than run Cloud in the wrong mode.
if (!HAS_CLOUD && process.env.CLERK_SECRET_KEY) {
  throw new Error('cloud/ is missing but CLERK_SECRET_KEY is set: this looks like a Cloud deploy built without the Workspace layer. Refusing to start.');
}

/**
 * Is this a self-hosted install? SELF_HOSTED=true says so, and an open-source build (no
 * src/cloud/) is one whatever the env says. On Cloud this is exactly SELF_HOSTED === 'true'.
 * Mirrors isSelfHosted() in apps/api/src/lib/plans.mjs.
 */
export function isSelfHosted() {
  return process.env.SELF_HOSTED === 'true' || !HAS_CLOUD;
}

let loading = null;
/** The cloud module (src/cloud/index.mjs), or null on an open-source build. Loaded once. */
export function loadCloud() {
  loading ??= HAS_CLOUD ? import(CLOUD_ENTRY.href) : Promise.resolve(null);
  return loading;
}
