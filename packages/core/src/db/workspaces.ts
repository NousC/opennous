import type { SupabaseClient } from '@supabase/supabase-js';

// Workspace-level settings readers shared by the worker and the API.

const TZ_CACHE_TTL_MS = 5 * 60_000;
const tzCache = new Map<string, { tz: string | undefined; at: number }>();

/**
 * The workspace's IANA timezone (e.g. "America/New_York"), captured from the
 * founder's browser at onboarding and editable in Settings. Returns undefined
 * when the workspace hasn't set one — callers pass the result straight to
 * resolveDuePhrase / isoDateIn, which fall back to NOUS_DEFAULT_TIMEZONE,
 * then UTC.
 *
 * Cached ~5 minutes per workspace: this sits on the worker's signal-extraction
 * hot path, where an extra SELECT per extracted item would be pure waste. A
 * timezone edit in Settings takes effect on new extractions within the TTL.
 */
export async function getWorkspaceTimezone(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  const hit = tzCache.get(workspaceId);
  const now = Date.now();
  if (hit && now - hit.at < TZ_CACHE_TTL_MS) return hit.tz;
  const { data, error } = await supabase
    .from('workspaces')
    .select('timezone')
    .eq('id', workspaceId)
    .maybeSingle();
  // A transient failure must NOT be negative-cached: due dates resolved during
  // a poisoned window would be written into claims in the wrong zone and stay
  // wrong forever. Only a genuine "row read, column empty" earns a cache entry.
  if (error) return undefined;
  const raw = (data as { timezone?: unknown } | null)?.timezone;
  const tz = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  tzCache.set(workspaceId, { tz, at: now });
  return tz;
}
