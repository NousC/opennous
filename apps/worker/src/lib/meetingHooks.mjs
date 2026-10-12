// What happens to an internal meeting beyond its own summary and tasks, supplied by the Workspace
// layer (Cloud) at boot: rebuilding the GTM brain's Internal Insights, and the meeting's page in
// the brain that a task links to. The open-source edition has no Brains (GET-839), so by default
// both do nothing and a task carries no link.
const hooks = {
  /** After a summary is saved: rebuild what the team believes for the topics it touched. */
  afterSummary: async (_supabase, _workspaceId, _doc) => 0,
  /** The meeting's page as an in-app link, or null. */
  meetingUrl: async (_supabase, _workspaceId, _sourceRef) => null,
};

export function registerMeetingHooks(h) {
  Object.assign(hooks, h);
}

export const meetingHooks = hooks;
