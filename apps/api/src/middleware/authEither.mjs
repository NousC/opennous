import { verifyApiKey } from './apiKey.mjs';
import { verifySupabaseAuth } from './supabaseAuth.mjs';

/**
 * Accept either an API key (X-Api-Key header, or `Authorization: Bearer pk_*`)
 * or a Supabase JWT (`Authorization: Bearer eyJ…`). API-key path wins when a
 * key is present so external integrations don't accidentally fall back to a
 * stale session cookie.
 *
 * Both downstream middlewares attach `req.workspaceId` — routes should prefer
 * that over reading `workspaceId` from body/query so the API-key path works
 * without the caller passing a workspaceId it shouldn't need to know.
 */
export function verifyAuthEither(req, res, next) {
  const hasApiKeyHeader = !!req.headers['x-api-key'];
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const isApiKeyBearer = bearer?.startsWith('pk_');

  if (hasApiKeyHeader || isApiKeyBearer) {
    return verifyApiKey(req, res, next);
  }
  return verifySupabaseAuth(req, res, next);
}
