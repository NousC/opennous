// Notification preferences (GET-636). Pure, so the plan rules and the channel mapping can be
// pinned by `node --test`. The stored shape is unchanged: `daily_digest` plus one
// `{ email, app }` per key, saved per member per workspace by PATCH /api/me/notification-prefs.
//
// Emailed to the address the member signed up with, from these same keys: the API-plan alerts
// (apps/api/src/lib/apiNotifications.mjs), the daily digest and account signals
// (apps/api/src/cloud/lib/memberNotifications.mjs). Sync failures go to Slack. The rest are saved
// now and applied as each channel ships.

export const NOTIF_ROWS: { key: string; label: string; desc: string }[] = [
  { key: "revenue_report",   label: "Weekly Revenue Report", desc: "The accounts you should reach out to this week." },
  { key: "account_signals",  label: "Account signals",       desc: "A tracked account shows buying intent or goes quiet." },
  { key: "mentions",         label: "Mentions & replies",    desc: "Someone @mentions you, or replies to your comment." },
  { key: "task_assignments", label: "Task assignments",      desc: "You're assigned a task." },
  { key: "sync_failures",    label: "Sync failures",         desc: "A connected integration stops syncing." },
];

// Only on the API plan: it is the plan with keys, webhooks and a credit allowance.
export const API_ALERT_ROWS: { key: string; label: string; desc: string }[] = [
  { key: "webhook_failures", label: "Webhook failures",      desc: "Your endpoint keeps returning errors." },
  { key: "credits_low",      label: "Credits running low",   desc: "You've used 80% of this month's credits." },
];
const API_ALERT_KEYS = API_ALERT_ROWS.map((r) => r.key);

// The API plan has no tasks, no comments and no revenue report.
export const API_NOTIF_KEYS = ["account_signals", "sync_failures", ...API_ALERT_KEYS];

export type NotifChannels = { email: boolean; app: boolean };
export type NotifPrefs = { daily_digest: boolean } & Record<string, boolean | NotifChannels>;

/** Rows off for a member who never saved anything (the api sends nothing for them unset). */
const OFF_BY_DEFAULT = ["account_signals"];
/** Alerts on for every member who never saved anything, not just owners and admins. */
const ON_FOR_EVERYONE = ["credits_low"];

/**
 * What a member who never saved anything sees. Webhook failures are on for owners and admins and
 * off for everyone else; credits running low is on for everyone. That is what the api sends to a
 * member with nothing stored.
 */
export function defaultNotifPrefs({ admin = true }: { admin?: boolean } = {}): NotifPrefs {
  // The digest and account signals are emails nobody asked for yet: off until turned on.
  const p: NotifPrefs = { daily_digest: false };
  for (const r of NOTIF_ROWS) p[r.key] = OFF_BY_DEFAULT.includes(r.key) ? { email: false, app: false } : { email: true, app: true };
  for (const k of API_ALERT_KEYS) {
    const on = admin || ON_FOR_EVERYONE.includes(k);
    p[k] = { email: on, app: on };
  }
  return p;
}

/**
 * What the Notifications section shows: the role's defaults under what the member stored. The
 * defaults depend on the role (webhook failures are on for owners/admins only), and the role can arrive
 * after the stored prefs do, so this is recomputed from both rather than frozen at first load.
 */
export function effectiveNotifPrefs(stored: Partial<NotifPrefs> | null | undefined, admin: boolean): NotifPrefs {
  return { ...defaultNotifPrefs({ admin }), ...(stored ?? {}) } as NotifPrefs;
}

export function notifRowsFor(apiPlan: boolean) {
  return apiPlan
    ? [...NOTIF_ROWS, ...API_ALERT_ROWS].filter((r) => API_NOTIF_KEYS.includes(r.key))
    : NOTIF_ROWS;
}

export type ChannelMode = "both" | "email" | "app";

export function channelsOf(prefs: NotifPrefs, key: string): NotifChannels {
  const v = prefs[key];
  return v && typeof v === "object" ? v : { email: true, app: true };
}

/** A row is on when either channel is. */
export function isOn(prefs: NotifPrefs, key: string): boolean {
  const c = channelsOf(prefs, key);
  return c.email || c.app;
}

export function modeOf(prefs: NotifPrefs, key: string): ChannelMode {
  const c = channelsOf(prefs, key);
  return c.email && c.app ? "both" : c.app ? "app" : "email";
}

/** The switch: off clears both channels, on restores both. */
export function setOn(prefs: NotifPrefs, key: string, on: boolean): NotifPrefs {
  return { ...prefs, [key]: { email: on, app: on } };
}

/** Where an enabled row is delivered. */
export function setMode(prefs: NotifPrefs, key: string, mode: ChannelMode): NotifPrefs {
  return { ...prefs, [key]: { email: mode !== "app", app: mode !== "email" } };
}
