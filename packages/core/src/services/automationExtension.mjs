// The automation engine's extension seam (GET-910).
//
// The engine (automationRun.mjs) is public. Some routines belong to a surface only Nous Cloud has:
// their runs read a scope (context their AI steps read, destinations, tables) and use step types of
// their own. That surface lives in src/cloud/, which the open-source export drops, so the engine
// never names it: it asks the extension registered here. With the cloud folder present, the
// extension is loaded from it on first use (and registered as soon as anything imports
// '@nous/core/cloud'); without it there is none, and every routine runs as an ordinary automation.
//
// Like services/icpScorer.ts, this checks the folder exists before reaching in, and loads lazily so
// nothing here runs at import time.
//
// An extension is a plain object; every member is optional:
//   scoped(routine)                         true when the routine belongs to the surface
//   loadScope(supabase, workspaceId, routine) -> { ok, reason?, ... } once per run; !ok stops the run
//   scopedPrompt(supabase, workspaceId, routine, prompt) -> an AI step's instructions with its scope
//   namedAccounts(supabase, workspaceId, names) -> what a step's line logs about the accounts it named
//   agentHints(rc, index) -> { row, coverage } for the AI step at `index` (see automationRun runSteps)
//   steps: { [type]: { name, action, holdsSend, isRead, postsToSlack(scope), slackFormat(args),
//            preview(step, rc), held(step, preview), run(step, rc) } }
//   reasons: { [reason]: words }       describe: { [deliveryToken]: (value) => words }
//   approvalKinds: { [type]: label }   eventWorkspaces(supabase, eventTypes) -> workspace ids
//   onEvent(supabase, event)           every event emitEvent queues, before its subscribers
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLOUD_ENTRY = new URL('../cloud/index.js', import.meta.url);
const HAS_CLOUD = existsSync(fileURLToPath(CLOUD_ENTRY));

let current = null;
let loading = null;

/** Plug in the extension (the cloud folder does this when it is imported). */
export function registerAutomationExtension(ext) {
  current = ext ?? null;
  loading = null;
}

/** The extension once registered or loaded, else null. Sync: for the pure helpers. */
export const automationExtension = () => current;

/** The extension, loading the cloud folder's on first use. Null on an open-source build. */
export function loadAutomationExtension() {
  if (current) return Promise.resolve(current);
  loading ??= HAS_CLOUD
    ? import(CLOUD_ENTRY.href).then(
        (m) => { current ??= m.automationExtension ?? null; return current; },
        (e) => {
          // Loud on purpose: the folder exists, so this is Cloud, and a swallowed failure would run
          // its routines as ordinary automations. Forget the failed load so the next run retries.
          console.error('[automationExtension] loading the cloud extension failed', e);
          loading = null;
          return null;
        },
      )
    : Promise.resolve(null);
  return loading;
}

/** A step type the extension adds, or null. */
export const extensionStep = (type) => (type && current?.steps?.[type]) || null;
