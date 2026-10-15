// Built-in jobs as RevBox jobs (GET-897). The card's sentence, Starts label and tools are the
// server's (core builtinJobBrief, sent as `brief` on each of the box detail's builtin_jobs); this
// file only words what the card adds around them and says which box holds a built-in, for the
// Priorities chip. Pure (type imports only), so tests/builtinJobs.test.ts can pin it.
import type { BuiltinJobKey } from '@/lib/revboxes';

/** The server's card for a built-in: one sentence in the agent's voice, Starts, tool logos, where its work lands. */
export type BuiltinBrief = { text: string; starts: string; tools: string[]; lands: string; details?: string[] };
/** Which box holds each built-in (GET /api/revboxes/builtins). `box_name` is null for a box the viewer cannot open. */
export type BuiltinHome = { key: BuiltinJobKey; box_id: string; box_name: string | null };

/** "12 in the last 30 days · last 2h ago", "None in the last 30 days". `ago` words a timestamp. */
export function builtinActivity(job: { drafts_30d: number; last_draft_at: string | null }, ago: (iso: string) => string): string {
  if (!job.drafts_30d) return 'None in the last 30 days';
  return [`${job.drafts_30d.toLocaleString('en-US')} in the last 30 days`, job.last_draft_at ? `last ${ago(job.last_draft_at)}` : null].filter(Boolean).join(' · ');
}

/** The On/Off a built-in card shows: the workspace's real switch, read-only; nothing when unknown. */
export const builtinState = (enabled: boolean | null | undefined): 'On' | 'Off' | null => (enabled === true ? 'On' : enabled === false ? 'Off' : null);

/** The box chip for a built-in's item in Priorities: the box it is in, when the viewer can open it. */
export function builtinChip(homes: BuiltinHome[] | null | undefined, key: string | null | undefined): { boxId: string; name: string; href: string } | null {
  const home = key ? (homes ?? []).find(h => h.key === key) : null;
  return home?.box_name ? { boxId: home.box_id, name: home.box_name, href: `/revboxes/${home.box_id}` } : null;
}

/**
 * The PATCH body that adds a built-in to a box (GET-897): an operation the server applies to the
 * box as it has it, never the page's whole list (a page holding an older copy of the box's
 * built-ins sent that list and dropped the ones it did not know about).
 */
export const addBuiltinBody = (key: BuiltinJobKey, revision: number) => ({ builtin_add: [key], revision });
