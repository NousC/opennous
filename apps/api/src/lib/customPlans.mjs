// What a Custom plan actually is, per client.
//
// Custom is quoted against the account's own volume and built against its own stack, so
// "Custom" on its own tells the customer nothing: they want the number they agreed, the
// credits it buys, and the integrations that were built for them by name. That is
// per-client information, keyed by team, and it names real clients — so the rows live in the
// Workspace layer (cloud/lib/customPlans.mjs), which registers them at boot (GET-761). A
// self-hosted install has none: every Custom team reads as "Quoted".
//
// Every Custom client gets CUSTOM_BASICS unless its row overrides `basics`. `custom` is the
// part that differs per client — the reason they are on a quote rather than a price list —
// and it is named as the integration, not as a capability.

/** What every plan carries. A Custom row may override this with its own `basics`. */
export const CUSTOM_BASICS = [
  'Unified accounts',
  'Automated insights and reporting',
  'Task and workflow automation',
];

/** team id → { priceUsd?, credits?, basics?, custom?, customLabel? }. Empty until registered. */
let plans = {};

/** Cloud hands its quotes on file to this at boot (cloud/index.mjs register()). */
export function registerCustomPlans(map) {
  plans = map ?? {};
}

/**
 * The Custom plan for a team, or null when there is no quote on file — the page then says
 * "Quoted" rather than inventing a number.
 */
export function customPlanFor(teamId) {
  const row = plans[teamId];
  if (!row) return null;
  return {
    priceUsd: row.priceUsd ?? null,
    credits: row.credits ?? null,
    basics: row.basics ?? CUSTOM_BASICS,
    custom: row.custom ?? [],
    // What the custom block is called for this client. Overridable, because one client's
    // custom work is integrations and another's might be models or reporting.
    customLabel: row.customLabel ?? 'Custom integrations',
  };
}
