// Slack inbound — the two endpoints a distributed Slack app needs.
//
//   POST /slack/events    — Events API. @mention -> cited answer in-thread.
//   POST /slack/commands  — the /nous slash command (channel<->account mapping).
//
// Both are mounted with express.raw (see index.mjs) because Slack's request
// signature is computed over the RAW body. We verify that signature, then ack
// within Slack's 3-second window and do the slow agent work afterwards.
//
// Multi-tenant: every request carries a team_id; findWorkspaceByTeam resolves it
// to the right workspace + bot token, and nothing runs without that scope.

import { runPlaygroundTurn } from '../lib/playgroundAgent.mjs';
import {
  getSupabaseClient,
  verifySlackSignature,
  findWorkspaceByTeam,
  checkAgentAccess,
  resolveChannelAccount,
  resolveAsker,
  getChannelName,
  postMessage,
  addReaction,
  toSlackMrkdwn,
} from '../lib/slack.mjs';

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

function signatureOk(req) {
  return verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody: req.body, // Buffer, from express.raw
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
  });
}

// Strip the leading "<@BOTID>" mention(s) out of the message text.
function cleanMention(text) {
  return (text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
}

// ── POST /slack/events ────────────────────────────────────────────────────────
export async function slackEventsHandler(req, res) {
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('bad_json');
  }

  // Slack's one-time endpoint verification handshake — must echo the challenge.
  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge });
  }

  if (SIGNING_SECRET && !signatureOk(req)) {
    return res.status(401).send('bad_signature');
  }

  // Ack immediately so Slack doesn't retry; the real work runs after this returns.
  res.status(200).send('');

  if (payload.type !== 'event_callback') return;
  const event = payload.event || {};
  // Only answer explicit @mentions; ignore the bot's own posts and edits.
  if (event.type !== 'app_mention' || event.bot_id || event.subtype) return;

  processMention(payload, event).catch((err) => {
    console.error('[SLACK_EVENTS] processMention failed:', err?.message);
  });
}

async function processMention(payload, event) {
  const supabase = getSupabaseClient();
  const teamId = payload.team_id;

  const tenant = await findWorkspaceByTeam(supabase, teamId);
  if (!tenant || !tenant.botToken) {
    console.warn('[SLACK_EVENTS] no connected workspace for team', teamId);
    return;
  }
  const { workspaceId, botToken, botUserId } = tenant;

  // Don't answer a mention the bot somehow triggered on itself.
  if (event.user && botUserId && event.user === botUserId) return;

  const thread_ts = event.thread_ts || event.ts;
  const channel = event.channel;
  const question = cleanMention(event.text);

  if (!question) {
    await postMessage(botToken, {
      channel,
      thread_ts,
      text: 'Ask me about an account and I’ll pull it from Nous. Try “what’s the latest on acme.com?”',
    });
    return;
  }

  // Plan gate: the answer runs Sonnet, so it lives on the same feature as the
  // in-app agent (Custom plan). Say so plainly instead of going silent.
  const access = await checkAgentAccess(supabase, workspaceId);
  if (!access.allowed) {
    await postMessage(botToken, {
      channel,
      thread_ts,
      text: 'Answering in Slack is part of the Nous Custom plan. Ask your workspace admin to enable it.',
    });
    return;
  }

  await addReaction(botToken, { channel, timestamp: event.ts, name: 'eyes' });

  // Channel -> account context. A linked channel names its account; otherwise the
  // channel name is a hint the agent can use (e.g. #deal-acme-corp -> Acme).
  const [accountRef, channelName, asker] = await Promise.all([
    resolveChannelAccount(supabase, workspaceId, channel),
    getChannelName(botToken, channel),
    resolveAsker(supabase, botToken, event.user),
  ]);

  const hintParts = [];
  if (channelName) hintParts.push(`Slack channel #${channelName}`);
  if (accountRef) hintParts.push(`bound to Nous account "${accountRef}" — call get_context with that as the focus`);
  const hint = hintParts.length
    ? `\n\n[Context: asked in ${hintParts.join(', ')}. Prefer this account unless the question clearly names someone else. Answer for Slack: short, and end with a *Sources* line citing the facts and dates you used.]`
    : `\n\n[Answer for Slack: short, and end with a *Sources* line citing the facts and dates you used.]`;

  // Conversation memory: replay what's already been said with the bot in THIS
  // Slack thread, so a back-and-forth carries context the way the in-app Threads
  // agent does. We persist our own turns per thread (below), which needs no extra
  // Slack scope and captures exactly the conversation the bot is part of.
  const { data: prior } = await supabase
    .from('slack_thread_messages')
    .select('role, content')
    .eq('workspace_id', workspaceId)
    .eq('slack_channel_id', channel)
    .eq('slack_thread_ts', thread_ts)
    .order('created_at', { ascending: true })
    .limit(40); // ~20 exchanges
  const history = (prior || []).map((m) => ({ role: m.role, content: m.content }));

  let answer;
  let answered = false;
  try {
    const out = await runPlaygroundTurn({
      supabase,
      workspaceId,
      history,
      userMessage: question + hint,
      internalUserId: asker.internalUserId,
    });
    answer = out.content;
    answered = true;
  } catch (err) {
    console.error('[SLACK_EVENTS] agent error:', err?.message);
    answer = 'I hit an error reaching your Nous graph. Try again in a moment.';
  }

  await postMessage(botToken, { channel, thread_ts, text: toSlackMrkdwn(answer) });

  // Remember this exchange so the next mention in the thread has it as context.
  // Store the raw question (not the hint), and only a real answer — never an error.
  if (answered) {
    supabase
      .from('slack_thread_messages')
      .insert([
        { workspace_id: workspaceId, slack_channel_id: channel, slack_thread_ts: thread_ts, role: 'user', content: question, slack_user_id: event.user },
        { workspace_id: workspaceId, slack_channel_id: channel, slack_thread_ts: thread_ts, role: 'assistant', content: answer },
      ])
      .then(() => {}, (e) => console.error('[SLACK_EVENTS] history save failed:', e?.message));
  }

  // Usage visibility — mirror the in-app agent's activity log, tagged source 'slack'.
  supabase
    .from('workspace_system_log')
    .insert({
      workspace_id: workspaceId,
      user_id: asker.internalUserId ?? null,
      source: 'slack',
      event_type: 'agent.chat',
      summary: question.slice(0, 200),
      metadata: { channel, channel_name: channelName, account_ref: accountRef },
    })
    .then(() => {}, () => {});
}

// ── POST /slack/commands  (/nous …) ───────────────────────────────────────────
// Channel<->account administration. Synchronous (just a DB write), so it answers
// inside Slack's 3s window with an ephemeral message.
export async function slackCommandHandler(req, res) {
  if (SIGNING_SECRET && !signatureOk(req)) {
    return res.status(401).send('bad_signature');
  }

  const params = new URLSearchParams(req.body.toString('utf8'));
  const teamId = params.get('team_id');
  const channelId = params.get('channel_id');
  const channelName = params.get('channel_name');
  const userId = params.get('user_id');
  const text = (params.get('text') || '').trim();

  const ephemeral = (t) => res.json({ response_type: 'ephemeral', text: t });

  const supabase = getSupabaseClient();
  const tenant = await findWorkspaceByTeam(supabase, teamId);
  if (!tenant) {
    return ephemeral('This Slack workspace isn’t connected to Nous yet. Connect it in Nous → Settings → Integrations.');
  }
  const { workspaceId } = tenant;

  const [sub, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();

  switch ((sub || '').toLowerCase()) {
    case 'link': {
      if (!arg) return ephemeral('Usage: `/nous link acme.com` (a company domain, name, or email).');
      const asker = await resolveAsker(supabase, tenant.botToken, userId);
      const { error } = await supabase
        .from('slack_channel_map')
        .upsert(
          {
            workspace_id: workspaceId,
            slack_team_id: teamId,
            slack_channel_id: channelId,
            slack_channel_name: channelName,
            account_ref: arg,
            created_by: asker.internalUserId ?? null,
          },
          { onConflict: 'workspace_id,slack_channel_id' },
        );
      if (error) {
        console.error('[SLACK_CMD] link upsert failed:', error.message);
        return ephemeral('Couldn’t save that link. Try again.');
      }
      return ephemeral(`Linked this channel to *${arg}*. Mentions here will default to that account.`);
    }
    case 'unlink': {
      await supabase
        .from('slack_channel_map')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('slack_channel_id', channelId);
      return ephemeral('Unlinked this channel. Mentions will infer the account from context.');
    }
    case 'status':
    case 'who': {
      const ref = await resolveChannelAccount(supabase, workspaceId, channelId);
      return ephemeral(
        ref
          ? `This channel is linked to *${ref}*.`
          : 'This channel isn’t linked. Use `/nous link <company>` to bind it to an account.',
      );
    }
    default:
      return ephemeral(
        '*Nous commands*\n' +
          '• `/nous link <company>` — bind this channel to an account\n' +
          '• `/nous unlink` — remove the binding\n' +
          '• `/nous status` — show what this channel is linked to\n' +
          'To ask a question, just @mention me: `@Nous what’s the latest on acme.com?`',
      );
  }
}
