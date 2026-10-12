// The "open the agent" event, kept public so a page can offer "Ask Nous about this" without
// importing the agent dock itself. The dock (Cloud only, GET-754) listens for "open-agent";
// when no dock is mounted the event goes nowhere, which is the self-host behaviour.

/** A record the page is about, handed to the agent as context (validated server-side). */
export type AgentMention = { id: string; kind: "person" | "company"; label: string };

/**
 * Open the dock from anywhere: the sidebar's Ask Nous row, ⌘J, or a page button like
 * "Brief me" / "Prep". With a prompt it sends straight away; with mentions the agent
 * reads those records first.
 */
export function openAgent(detail: { prompt?: string; mentions?: AgentMention[] } = {}) {
  window.dispatchEvent(new CustomEvent("open-agent", { detail }));
}
