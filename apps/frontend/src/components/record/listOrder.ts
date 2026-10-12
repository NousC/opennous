// Previous and next on a record (interface refresh, GET-650). A list that opens a record hands it
// the list as it stood on screen, filtered and sorted, in the router's location state; the record's
// top bar then reads "3 of 19" and K / J walk it. Location state lives in the browser's history
// entry: Back and a reload keep it, and a pasted link has none, so a deep link shows nothing.

/** The record pages' paths, in the list's order, around the one opened. */
export type RecordNavList = {
  paths: string[];
  /** Where `paths[0]` sits in the whole list, and how long the whole list is. */
  start: number;
  total: number;
};
export type RecordNavState = { recordNav?: RecordNavList };

// A won lane can hold thousands of deals. History state has a size limit, so only this many
// records either side of the opened one travel with it.
const SPAN = 500;

/** The state to open `path` with, as one of `paths` (the list on screen, in order). */
export function recordNavState(paths: string[], path: string): RecordNavState {
  const i = paths.indexOf(path);
  if (i < 0 || paths.length < 2) return {};
  const start = Math.max(0, i - SPAN);
  return { recordNav: { paths: paths.slice(start, i + SPAN + 1), start, total: paths.length } };
}

/** The same paths with each repeat dropped, first one kept: a list may show an account twice. */
export function uniquePaths(paths: (string | null | undefined)[]): string[] {
  return [...new Set(paths.filter((p): p is string => !!p))];
}

export const accountPath = (companyId: string) => `/accounts/${companyId}`;
export const dealPath = (companyId: string, dealId: string) => `/accounts/${companyId}/deals/${dealId}`;

/** The list in a location state, when it is one. */
export function readRecordNav(state: unknown): RecordNavList | null {
  const nav = (state as RecordNavState | null)?.recordNav;
  if (!nav || !Array.isArray(nav.paths) || typeof nav.start !== "number" || typeof nav.total !== "number") return null;
  return nav;
}
