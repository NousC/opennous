// The one email-drafting brief (GET-685) now lives in core (services/emailDraftBrief.mjs), so the
// automation runner writes Draft follow-up with the same house rules as Studio and the detectors
// (GET-718). Re-exported here for the API's existing imports.
export { EMAIL_DRAFT_SYSTEM, DEFAULT_SUBJECT, parseEmailDraft } from '@nous/core';
