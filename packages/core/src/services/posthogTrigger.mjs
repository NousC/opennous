// "When a PostHog event fires" (GET-751): an automation trigger on any event the PostHog
// destination sends us (the signup event and the key events chosen on connect).
//
// The webhook handler (apps/worker/src/webhooks/handlers/posthog.mjs) files each event as a
// `product.event` observation on the person, with their account in `raw.account_id`. Every few
// minutes, the events ingested in the last half hour whose name the automation watches each run
// it once (the run's dedupe key is the observation, so the overlapping windows never run it twice).

export const POSTHOG_EVENT_WINDOW_MS = 30 * 60_000;

/** The product events ingested since `since` with this name, oldest first. */
export async function posthogEventsSince(supabase, workspaceId, cfg, { since, cap = 200 } = {}) {
  const name = String(cfg?.event ?? '').trim();
  if (!name) return { ok: false, reason: 'posthog_trigger_not_set' };
  const { data, error } = await supabase.from('observations')
    .select('id, entity_id, observed_at, value, raw')
    .eq('workspace_id', workspaceId).eq('source', 'posthog').eq('property', 'product.event')
    .eq('value->>name', name)
    .gte('ingested_at', new Date(since).toISOString())
    .order('ingested_at', { ascending: true })
    .limit(cap);
  if (error) return { ok: false, reason: `posthog_events_read_failed: ${String(error.message).slice(0, 160)}` };
  return { ok: true, events: data ?? [] };
}

/** The event in words, the way {{signal.text}} reads it: `report_created (plan: team, seats: 4)`. */
export function posthogEventText(name, properties) {
  const props = Object.entries(properties ?? {}).slice(0, 8).map(([k, v]) => `${k}: ${v}`);
  return props.length ? `${name} (${props.join(', ')})` : String(name);
}

/** The event as the run's signal: what the AI step and {{signal.text}} read. */
export function posthogEventSignal(row) {
  const name = row?.value?.name ?? null;
  const properties = row?.value?.properties ?? {};
  return {
    id: `ph:${row.id}`, kind: 'posthog_event', label: 'PostHog event',
    title: name, content: posthogEventText(name, properties), quote: null, speaker: null,
    occurred_at: row.observed_at, account_id: row?.raw?.account_id ?? null, entity_id: row.entity_id,
    detail: { event: name, properties },
  };
}

/** {{event.name}} / {{event.properties}}: the event that fired the run. */
export function posthogEventVars(event) {
  if (!event?.name) return {};
  const props = event.properties ?? {};
  return {
    'event.name': event.name,
    'event.properties': Object.keys(props).length ? Object.entries(props).map(([k, v]) => `${k}: ${v}`).join('\n') : null,
  };
}
