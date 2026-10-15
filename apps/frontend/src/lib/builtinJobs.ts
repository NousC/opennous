// Built-in jobs as RevBox jobs (GET-897, GET-902). The card's sentence, Starts label and tools are the
// server's (core builtinJobBrief, sent as `brief` on each of the box detail's builtin_jobs); a
// built-in's card is a job's card (no tag, no extra line: what it did lately is the card's tooltip),
// and it opens the job chat. This file words what the card adds around the server's brief, the
// Priorities destination the box's Delivery shows for it, and which box holds a built-in (the
// Priorities chip). Pure (type imports only), so tests/builtinJobs.test.ts can pin it.
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

/**
 * A built-in's row in the Jobs list (GET-902), as a routine's row reads: "Starts · On · Last run …".
 * Its last run is its last draft; On/Off is the workspace's real switch, left out when unknown.
 */
export function builtinRowMeta(job: { cadence: string; enabled?: boolean | null; last_draft_at: string | null; brief?: { starts?: string } | null }, ago: (iso: string) => string): string {
  const state = builtinState(job.enabled);
  return [job.brief?.starts ?? job.cadence, state, job.last_draft_at ? `Last run ${ago(job.last_draft_at)}` : 'Not run yet'].filter(Boolean).join(' · ');
}

/** The built-in card's tooltip (GET-902): what it did lately, where a job card has no extra line for it. */
export function builtinTooltip(job: { drafts_30d: number; last_draft_at: string | null }, ago: (iso: string) => string): string {
  return `What it did: ${builtinActivity(job, ago)}. Its work waits in Priorities.`;
}

/**
 * Where a box's built-ins deliver (GET-902): Priorities, as drafts the person approves. Shown in the
 * box's Delivery like its other destinations, never removable (it is where built-ins deliver). Null
 * for a box with no built-in.
 */
export function prioritiesDestination(builtins: readonly unknown[] | null | undefined): { label: string; sub: string } | null {
  return builtins?.length ? { label: 'Priorities', sub: 'drafts you approve' } : null;
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
