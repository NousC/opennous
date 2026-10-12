/**
 * "Send to Linear" (GET-825), the one function both doors call:
 *   POST /api/linear/topics/:key/send              the topic page's button (app session)
 *   POST /v2/insights/topics/:key/linear           the API plan, MCP and skills (pk_ key)
 * Returns { status, body } so the routes stay thin and the tests drive it without Express.
 *
 * Manual by default (decided 2026-10-09): nothing reaches Linear unless someone sends it.
 */

import { sendTopicToLinear } from '@nous/core';
import { getLinearClient } from '../providers/linear.mjs';
import { viewerVisibleAccountSet } from './visibility.mjs';

export const appUrl = () => (process.env.APP_URL || (process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : 'https://app.opennous.cloud')).replace(/\/+$/, '');

const LINEAR_ERRORS = {
  linear_not_connected: [409, 'Linear is not connected. An owner or admin connects it under Integrations.'],
  linear_reconnect_required: [409, 'The Linear connection expired. Reconnect it under Integrations.'],
  linear_token_failed: [409, 'Linear refused the stored connection. Reconnect it under Integrations.'],
  linear_unauthorized: [409, 'Linear refused the stored connection. Reconnect it under Integrations.'],
  topic_not_found: [404, 'No customer insights under this topic.'],
  send_in_progress: [409, 'This topic is being sent to Linear right now. Try again in a moment.'],
  linear_graphql: [502, null],
  linear_issue_failed: [502, 'Linear did not create the issue.'],
};

export async function sendTopic(
  { supabase, workspaceId, topicKey, teamId = null, userId = null, viewerId = null, isAdmin = false },
  { getClient = getLinearClient, send = sendTopicToLinear, appUrl: base = appUrl(), visibility = viewerVisibleAccountSet } = {},
) {
  const key = String(topicKey ?? '');
  const [subtype, tag] = key.split('|');
  if (!subtype || !tag) return { status: 400, body: { error: 'invalid_key', message: "A topic key is '<subtype>|<tag id>', as get_insights returns it." } };
  try {
    const client = await getClient(supabase, workspaceId);
    let team = teamId || client.defaultTeamId;
    if (teamId && !client.teams.some((t) => t.id === teamId)) {
      return { status: 400, body: { error: 'unknown_team', message: 'Not a team in the connected Linear workspace.', teams: client.teams } };
    }
    if (!team && client.teams.length === 1) team = client.teams[0].id;
    if (!team) {
      return { status: 409, body: { error: 'linear_team_required', message: 'Pick the Linear team new issues go to.', teams: client.teams } };
    }
    // Per-member visibility, as GET /v2/insights reads it: a restricted member sends only the
    // accounts they may see.
    const visible = await visibility(supabase, workspaceId, viewerId, { isAdmin });
    const visibleCompanyIds = visible?.unrestricted === false ? visible.ids : null;
    const out = await send(supabase, { workspaceId, topicKey: key, teamId: team, gql: client.gql, appUrl: base, userId, visibleCompanyIds });
    return { status: out.created ? 201 : 200, body: out };
  } catch (e) {
    // Linear not in the catalogue yet (a fresh install before its first boot sync) reads as not connected.
    const code = e?.code === 'provider_not_configured' ? 'linear_not_connected' : e?.code;
    const hit = LINEAR_ERRORS[code];
    if (!hit) throw e;
    const [status, message] = hit;
    const error = status === 502 ? 'linear_error' : code;
    return { status, body: { error, message: message || `Linear said: ${e.message}` } };
  }
}
