// Google OAuth token refresh — delegates to the single canonical implementation in
// @nous/core (utils/googleAuth). Exported under the legacy name refreshGoogleTokenIfNeeded
// so the contact-history enricher keeps working unchanged.
//
// The old local copy here decrypted with AES-GCM only, but the OAuth callback stores
// tokens as AES-CBC — so it threw "Invalid encrypted data format" on every Gmail
// connection and the on-demand enrichment path silently failed. Core's universal
// decrypt fixes that; both worker and API now share one refresher.

export { refreshGoogleToken as refreshGoogleTokenIfNeeded, TokenRevokedError } from '@nous/core';
