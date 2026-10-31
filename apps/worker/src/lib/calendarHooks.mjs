// What happens after a calendar scan beyond the graph, supplied by the Workspace layer (Cloud) at
// boot: booking meeting bots (GET-1095). The open-source edition has none, so by default it does
// nothing, like lib/meetingHooks.mjs.
const hooks = {
  /** After a scan of one connection: its raw events and the scan's context (loadScanContext). */
  afterScan: async (_supabase, _conn, _items, _ctx) => {},
};

export function registerCalendarHooks(h) {
  Object.assign(hooks, h);
}

export const calendarHooks = hooks;
