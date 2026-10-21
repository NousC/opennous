// Slack is an adapter to the signal/insight readers, not a new extraction prompt.
import { createHash } from 'node:crypto';
import { activityByExternalId, refreshActivityEvidence, recordObservation, CREDIT_SCALE } from '@nous/core';
import { extractActivitySignals, extractConversationActionItems } from './index.mjs';
import { extractCallInsights } from './insights.mjs';
import { logActivity } from '../utils/activity.mjs';
import { noteCreditsSpent } from '../lib/creditGate.mjs';

export function prepareSlackConversation({ source, messages, authors, conversationId = messages[0]?.conversation_id }) {
  const live = messages.filter(m => !m.deleted && m.body?.trim()).sort((a, b) => Number(a.slack_ts) - Number(b.slack_ts));
  const evidence = live.map(m => {
    const author = authors.get(m.author_id);
    return { id: m.id, authorId: m.author_id, speaker: author?.name ?? `Unknown ${m.author_id}`,
      side: author?.side ?? 'unknown', contactId: author?.contactId ?? null,
      companyId: author?.companyId ?? null,
      text: m.body, occurredAt: m.occurred_at, ts: m.slack_ts, version: m.event_version,
      url: `https://app.slack.com/archives/${source.slack_channel_id}/p${String(m.slack_ts).replace('.', '')}` };
  });
  const external = evidence.filter(m => m.side === 'external' && m.contactId);
  // Unknowns/bots are neither customer evidence nor prompt context.
  const transcript = evidence.filter(m => ['internal', 'external'].includes(m.side))
    .map(m => `${m.speaker}: ${m.text}`).join('\n');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    enabledAt: source.enabled_at,
    authors: [...authors].filter(([id]) => messages.some(m => m.author_id === id)).sort(([a], [b]) => a.localeCompare(b)),
    messages: messages.map(m => [m.id, m.event_version, m.body, m.deleted]).sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
  const sourceBase = `source://slack/${source.slack_team_id}/${source.slack_channel_id}/${conversationId}`;
  return { evidence, external, transcript, fingerprint, sourceBase, sourceRef: `${sourceBase}/${fingerprint}`,
    occurredAt: external.at(-1)?.occurredAt ?? null };
}

// `owner` is set for a teammate's own DM (GET-985): { userId }. The conversation is then theirs:
// its messages are slack_dm (private, like their email), the snapshot is owned by them, and
// workspace insights (which quote what was said) are not written from it. Facts and tasks still
// are, and they are the team's; their quotes follow the message.
export async function extractSlackConversation({ supabase, source, messages, authors, conversationId, dryRun = false, insightsEnabled = true, owner = null }, {
  signals = extractActivitySignals, insights = extractCallInsights, activity = logActivity, existingActivity = activityByExternalId,
  observation = recordObservation, refreshActivity = refreshActivityEvidence, actionItems = extractConversationActionItems,
} = {}) {
  const prepared = prepareSlackConversation({ source, messages, authors, conversationId });
  if (!prepared.external.length) return { ...prepared, facts: [], insights: 0, skipped: 'no_confirmed_external_author' };
  const type = owner ? 'slack_dm' : 'slack_message';
  const mailbox = owner ? { mailbox_owner_ids: [owner.userId] } : {};
  // The timeline preview is short; the extraction input remains the full text.
  if (!dryRun) {
    for (const m of prepared.external) {
      // New replies re-read the conversation, but do not duplicate older messages
      // on the timeline. Only an edit or a corrected person mapping is a new version.
      const externalId = `slack_${source.slack_team_id}_${source.slack_channel_id}_${m.ts}_${m.version}_${m.contactId}`;
      const rawData = { text: m.text, user: m.authorId, channel_id: source.slack_channel_id,
        ts: m.ts, source_ref: prepared.sourceRef, is_outbound: false,
        slack_mentions: Object.fromEntries([...authors].map(([id, author]) => [id, { name: author.name, personId: author.contactId ?? null }])),
        url: m.url, ...mailbox };
      const logged = await activity(supabase, { workspaceId: source.workspace_id,
        contactId: m.contactId, type, source: 'slack', ...(owner ? { ownerUserId: owner.userId } : {}),
        externalId,
        occurredAt: m.occurredAt, summary: m.text.slice(0, 500), description: m.text.slice(0, 500),
        rawData,
        suppressExtraction: true,
      });
      const recorded = logged ?? await existingActivity(supabase, source.workspace_id, 'slack', externalId);
      if (!recorded?.id) throw new Error('slack_activity_not_recorded');
      if (!logged) await refreshActivity(supabase, source.workspace_id, 'slack', externalId, { summary: m.text.slice(0, 500), rawData });
      m.activityId = recorded.id;
    }
    // A source_ref resolves to the exact conversation version shown to the readers,
    // while each fact's supporting observations identify the actual author's message.
    await observation(supabase, { workspaceId: source.workspace_id, entityId: prepared.external[0].contactId,
      // evidence.*, not interaction.*: the snapshot is what a finding cites, not something that
      // happened, so no timeline, touch count or last-activity reader sees it (GET-976).
      kind: 'event', property: owner ? 'evidence.slack_dm_conversation' : 'evidence.slack_conversation', source: 'slack', method: 'connector',
      ...(owner ? { ownerUserId: owner.userId } : {}),
      externalId: `slack_conversation_${prepared.fingerprint}`, sourceRef: prepared.sourceRef,
      observedAt: prepared.occurredAt, value: { summary: 'Slack conversation' },
      raw: { text: prepared.transcript, channel_id: source.slack_channel_id,
        messages: prepared.evidence.filter(m => m.side !== 'unknown'), ...mailbox },
    });
  }
  const facts = [];
  for (const contactId of new Set(prepared.external.map(m => m.contactId))) {
    const mine = prepared.external.filter(m => m.contactId === contactId);
    facts.push(...await signals({ supabase, workspaceId: source.workspace_id,
      contactId, activityId: mine[0].activityId ?? null, sourceActivityIds: mine.map(m => m.activityId).filter(Boolean),
      type, source: 'slack', summary: prepared.transcript,
      sourceRef: prepared.sourceRef, occurredAt: mine.at(-1).occurredAt,
      evidenceMessages: prepared.evidence, dryRun, strict: true,
      // Claims about us follow the source's insights switch, as the insight read does (GET-969).
      aboutUs: insightsEnabled,
    }));
  }
  let count = 0;
  if (!dryRun && insightsEnabled && !owner && prepared.transcript.length >= 20) {
    let result;
    count = await insights({ supabase, workspaceId: source.workspace_id,
      transcript: prepared.transcript, attendees: [...new Set(prepared.external.map(m => m.speaker))],
      sourceLabel: `Slack #${source.slack_channel_id}`, sourceRef: prepared.sourceRef,
      sourceSystem: 'slack', occurredAt: prepared.occurredAt, evidenceMessages: prepared.evidence,
      structuredOnly: true, onResult: r => { result = r; },
      minTranscriptChars: 20,
    });
    if (!result?.ok) throw new Error(`slack_insights_${result?.reason ?? 'incomplete'}`);
  }
  // Asks and promises go through the shared action-item store the Tasks page and Next step read
  // (GET-976). Part of this conversation's one read, so no extra credit.
  let tasks = [];
  if (insightsEnabled || owner) {
    const people = [...new Map([...authors.values()].filter(a => a.name && a.side !== 'unknown').map(a => [a.name, { name: a.name, side: a.side, contactId: a.contactId ?? null }])).values()];
    tasks = await actionItems({ supabase, workspaceId: source.workspace_id, channel: 'slack',
      messages: prepared.evidence, people, sourceRef: prepared.sourceRef, dryRun,
      mentions: Object.fromEntries([...authors].map(([id, a]) => [id, { name: a.name, personId: a.contactId ?? null }])),
      sourceTitle: "Slack conversation" });
  }
  if (!dryRun) {
    const read = await observation(supabase, { workspaceId: source.workspace_id, entityId: prepared.external[0].contactId,
      kind: 'state', property: 'noema.read', source: 'slack', method: 'extraction',
      externalId: `slack_read_${prepared.fingerprint}`, value: { kind: 'message', credits: 1,
        source_ref: prepared.sourceRef, claims: facts.length, insights: count, tasks: tasks.length, messages: prepared.external.length },
    });
    if (read) noteCreditsSpent(source.workspace_id, CREDIT_SCALE);
  }
  return { ...prepared, facts, insights: count, tasks };
}
