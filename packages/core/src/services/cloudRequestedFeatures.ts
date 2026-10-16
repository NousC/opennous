import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// What Nous Cloud adds to the work a person asks for (GET-924).
//
// db/conversationCredits.ts bills REQUESTED_FEATURES by what they cost. Nous Cloud runs features
// the open-source build does not have, and their llm_usage rows are billed the same way; their
// names live with them in src/cloud/, which the open-source export drops. This loads them from the
// cloud folder whenever it exists, so every process of a Cloud build counts credits the same way
// whether or not it has loaded the Cloud layer itself. On an open-source build it adds nothing.
//
// Like services/icpScorer.ts, it checks the folder exists before reaching into it, and loads
// lazily, on first use.

/** Cloud's feature names: billed as requested work, and the subset counted as automations. */
export interface CloudRequestedFeatures {
  requested: readonly string[];
  automations: readonly string[];
}

const NONE: CloudRequestedFeatures = { requested: [], automations: [] };
const CLOUD_ENTRY = new URL('../cloud/index.js', import.meta.url);
const HAS_CLOUD = existsSync(fileURLToPath(CLOUD_ENTRY));

let loading: Promise<CloudRequestedFeatures> | null = null;

/** Cloud's requested features, or none on an open-source build. Loaded once. */
export function cloudRequestedFeatures(): Promise<CloudRequestedFeatures> {
  loading ??= HAS_CLOUD
    ? import(CLOUD_ENTRY.href).then(
        (m: { cloudRequestedFeatures?: CloudRequestedFeatures }) => m.cloudRequestedFeatures ?? NONE,
        (e: unknown) => {
          // Loud, and no silent fallback: this is Cloud, and counting without its features would
          // under-bill. Forget the failed load so the next call retries.
          console.error('[credits] loading Cloud\'s requested features failed', e);
          loading = null;
          throw e;
        },
      )
    : Promise.resolve(NONE);
  return loading;
}
