import { registerActivityHook } from '@nous/core';
import { writeEvidenceFile } from './writeEvidence.mjs';
import { normalizeEmail } from './email.mjs';

// The evidence layer — file the raw of every connector touch into the owning member's
// personal vault under accounts/ + people/. Registered on the ONE logActivity choke
// point (live + backfill). Email (and later Slack/CRM) content lives in the activity's
// rawData, so those are normalized here. Meetings are filed directly from the Fathom/
// Fireflies handlers (their transcript is in the saveDocument path, not logActivity).
const EMAIL_TYPES = new Set(['email_sent', 'email_received', 'email_replied']);

async function evidenceActivityHook(ctx) {
  try {
    const { type, source, rawData, entityId, companyId, ownerUserId, occurredAt } = ctx;
    if (!ownerUserId || !entityId) return;   // system/shared touch → no owner vault to file into

    let normalized = null;
    if (EMAIL_TYPES.has(type)) normalized = normalizeEmail(rawData, { type });
    // (Slack / CRM normalizers register here next.)
    if (!normalized) return;

    await writeEvidenceFile(ctx.supabase, {
      workspaceId: ctx.workspaceId, ownerUserId, entityId, companyId,
      type, source, dedupKey: normalized.dedupKey,
      sourceRef: normalized.dedupKey ? `source://${source}/${normalized.dedupKey}` : null,
      occurredAt, title: normalized.title, markdown: normalized.markdown,
    });
  } catch (err) {
    console.warn('[evidence] hook failed:', err?.message || err);
  }
}

let registered = false;
export function registerEvidenceLayer() {
  if (registered) return;
  registered = true;
  registerActivityHook(evidenceActivityHook);
}

export { writeEvidenceFile } from './writeEvidence.mjs';
export { normalizeMeeting } from './meeting.mjs';
