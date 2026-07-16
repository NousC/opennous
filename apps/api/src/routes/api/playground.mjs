// /api/playground — the chat-with-your-context demo backing /playground.
//
// Threads live in playground_threads (one per chat session), messages in
// playground_messages with a JSONB tool_calls trace per assistant message
// so the right-hand context panel can render from the same fetch that
// loads the conversation. Strict per-(workspace, user) scoping.
//
// Five endpoints:
//   GET    /threads                  — list threads, most-recently-touched first
//   POST   /threads                  — create a new (empty) thread
//   GET    /threads/:id/messages     — load the conversation + tool traces
//   POST   /chat                     — send a message, return assistant + trace
//   DELETE /threads/:id              — hard delete (cascades to messages)
//
// /chat is request-response (not SSE) for v1. The agent loop is fast enough
// at Haiku that the user-perceived latency is fine, and the implementation
// stays simple. Easy to upgrade to streaming later without changing the URL.

import { Router } from 'express';
import Anthropic from 'useleak';
import { getSupabaseClient } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { runPlaygroundTurn, streamAgentTurn, loadMemberProfile } from '../../lib/playgroundAgent.mjs';
import { classifyChatTurn } from '../../lib/useCases.mjs';

export const playgroundRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LEN = 4000;       // anything longer is almost certainly pasted garbage
const HISTORY_LIMIT   = 20;         // pairs of (user, assistant) passed to the model

// Ensure (and only allow) the user to operate on threads they own in this workspace.
async function assertOwnership(supabase, threadId, userId, workspaceId) {
  const { data, error } = await supabase
    .from('playground_threads')
    .select('id, workspace_id, user_id')
    .eq('id', threadId)
    .maybeSingle();
  if (error || !data) return { ok: false, status: 404, error: 'thread_not_found' };
  if (data.workspace_id !== workspaceId || data.user_id !== userId) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: true };
}

// ─── GET /threads ───────────────────────────────────────────────────────────

playgroundRouter.get('/threads', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('playground_threads')
      .select('id, title, created_at, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(100);
    if (error) throw error;

    // Which of these the agent produced on its own, unasked. A scheduled brief and
    // a question you typed are both threads, but they are not the same thing to a
    // reader — one is your work, the other is work that was done FOR you while you
    // weren't looking, and the list should say which is which.
    const { data: runs } = await supabase
      .from('agent_routine_runs')
      .select('thread_id, seen_at, routine_id, agent_routines(name)')
      .eq('workspace_id', workspaceId)
      .not('thread_id', 'is', null);

    const byThread = new Map(
      (runs ?? []).map(r => [r.thread_id, { name: r.agent_routines?.name ?? 'Routine', unseen: !r.seen_at }]),
    );

    const threads = (data ?? []).map(t => ({
      ...t,
      routine: byThread.get(t.id)?.name ?? null,
      unseen:  byThread.get(t.id)?.unseen ?? false,
    }));

    return res.json({ threads });
  } catch (err) {
    console.error('[GET /api/playground/threads]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /threads ──────────────────────────────────────────────────────────

playgroundRouter.post('/threads', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId } = req.body;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('playground_threads')
      .insert({ workspace_id: workspaceId, user_id: req.user.id, title: 'New chat' })
      .select('id, title, created_at, updated_at')
      .single();
    if (error) throw error;
    return res.status(201).json({ thread: data });
  } catch (err) {
    console.error('[POST /api/playground/threads]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── GET /threads/:id/messages ──────────────────────────────────────────────

playgroundRouter.get('/threads/:id/messages', verifySupabaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    if (!workspaceId)  return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const owns = await assertOwnership(supabase, id, req.user.id, String(workspaceId));
    if (!owns.ok) return res.status(owns.status).json({ error: owns.error });

    const { data, error } = await supabase
      .from('playground_messages')
      .select('id, role, content, tool_calls, created_at')
      .eq('thread_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return res.json({ messages: data || [] });
  } catch (err) {
    console.error('[GET /api/playground/threads/:id/messages]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── DELETE /threads/:id ────────────────────────────────────────────────────

playgroundRouter.delete('/threads/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    if (!workspaceId)  return res.status(400).json({ error: 'workspaceId_required' });

    const supabase = getSupabaseClient();
    const owns = await assertOwnership(supabase, id, req.user.id, String(workspaceId));
    if (!owns.ok) return res.status(owns.status).json({ error: owns.error });

    await supabase.from('playground_threads').delete().eq('id', id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/playground/threads/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /chat ─────────────────────────────────────────────────────────────

// ─── POST /chat/stream ──────────────────────────────────────────────────────
//
// The streaming twin of /chat, backing the Home agent. Same thread + message
// persistence; the difference is the client watches the agent work instead of
// waiting on a spinner — which tool it reached for, what evidence came back,
// then the answer typing in. That live trace IS the product's proof surface,
// so it's worth the SSE plumbing.
//
// SSE over POST (not EventSource, which is GET-only): the browser reads the
// response body as a stream. Each event is a `data: {json}\n\n` line.

playgroundRouter.post('/chat/stream', verifySupabaseAuth, async (req, res) => {
  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Flush past any compression middleware so tokens arrive as they're written.
    if (typeof res.flush === 'function') res.flush();
  };

  try {
    const { workspaceId, threadId, message } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    if (!threadId || !UUID.test(threadId)) return res.status(400).json({ error: 'threadId_required' });
    const text = String(message || '').trim();
    if (!text) return res.status(400).json({ error: 'message_required' });
    if (text.length > MAX_MESSAGE_LEN) return res.status(413).json({ error: 'message_too_long', max: MAX_MESSAGE_LEN });

    const supabase = getSupabaseClient();
    const owns = await assertOwnership(supabase, threadId, req.user.id, workspaceId);
    if (!owns.ok) return res.status(owns.status).json({ error: owns.error });

    const { data: priorRows, error: histErr } = await supabase
      .from('playground_messages')
      .select('role, content, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT * 2);
    if (histErr) throw histErr;
    const history = (priorRows || []).reverse().map(m => ({ role: m.role, content: m.content }));

    // Persist the user message before the model runs, so a crash mid-turn never
    // loses what they typed.
    const { data: userRow, error: userErr } = await supabase
      .from('playground_messages')
      .insert({ thread_id: threadId, role: 'user', content: text })
      .select('id, role, content, tool_calls, created_at')
      .single();
    if (userErr) throw userErr;

    if (history.length === 0) {
      const title = text.slice(0, 80) + (text.length > 80 ? '…' : '');
      try {
        await supabase.from('playground_threads').update({ title }).eq('id', threadId);
      } catch { /* a title bump must never block the reply */ }
    }

    // Headers only once we know the request is good — an early failure above can
    // still return a normal JSON error status.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      // `no-transform` keeps compression middleware from buffering the stream.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    send({ type: 'user_message', message: userRow });

    // Who the agent is working for — their job and their own instructions, set
    // in Settings. Same graph for everyone; the job on top of it is personal.
    const memberProfile = await loadMemberProfile(supabase, workspaceId, req.internalUserId);

    let assistantContent = '';
    let toolCalls = [];
    try {
      for await (const event of streamAgentTurn({
        supabase, workspaceId, history, userMessage: text,
        // userId is the auth id (cost tracking); internalUserId is the users.id that
        // a draft's foreign key needs. They are different ids for the same person.
        userId: req.user.id, internalUserId: req.internalUserId ?? null,
        threadId, memberProfile,
      })) {
        if (event.type === 'done') {
          assistantContent = event.content;
          toolCalls = event.toolCalls;
        } else {
          send(event);
        }
      }
    } catch (e) {
      console.error('[POST /api/playground/chat/stream] agent error:', e);
      assistantContent = `Sorry — I hit an error running the agent (${e?.message || 'unknown'}). Try again, or simplify the question.`;
      toolCalls = [];
      send({ type: 'error', message: e?.message || 'agent_failed' });
    }

    const { data: assistantRow, error: asstErr } = await supabase
      .from('playground_messages')
      .insert({
        thread_id: threadId, role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls.length ? toolCalls : null,
      })
      .select('id, role, content, tool_calls, created_at')
      .single();
    if (asstErr) throw asstErr;

    // Log the turn as workspace activity, attributed to the person who ran it.
    //
    // The op logger only sees /v2 (the API-key surface), so agent chats — the
    // single biggest thing a team does with Nous — were invisible to it. Without
    // this, the Usage page could tell you how much Claude Code hit the graph and
    // nothing about how the team actually uses the product.
    //
    // Fire-and-forget, and AFTER the answer is on its way — the user never waits
    // on telemetry. The classification is a Haiku call: "brief me on my meeting
    // with Vik" and "catch me up on Kabir" hit the same tools with completely
    // different intent, so only the language can tell them apart.
    const toolNames = toolCalls.map(t => t.name);
    setImmediate(async () => {
      let useCase = null;
      try {
        const wrapper = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        useCase = await classifyChatTurn(wrapper, text, toolNames);
      } catch { /* an unclassified turn is better than a wrongly classified one */ }

      supabase.from('workspace_system_log').insert({
        workspace_id: workspaceId,
        user_id: req.internalUserId ?? null,
        source: 'web',                       // the in-app agent, vs mcp / sdk
        event_type: 'agent.chat',
        use_case: useCase,
        summary: text.slice(0, 200),         // what they actually asked
        metadata: {
          thread_id: threadId,
          tools: toolNames,
          tool_count: toolCalls.length,
          answer_chars: assistantContent.length,
        },
      }).then(() => {}, () => {});
    });

    // The client swaps its optimistic bubbles for the persisted rows.
    send({ type: 'done', assistantMessage: assistantRow });
    res.end();
  } catch (err) {
    console.error('[POST /api/playground/chat/stream]', err);
    if (res.headersSent) {
      send({ type: 'error', message: 'internal_error' });
      res.end();
    } else {
      res.status(500).json({ error: 'internal_error' });
    }
  }
});

playgroundRouter.post('/chat', verifySupabaseAuth, async (req, res) => {
  try {
    const { workspaceId, threadId, message } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    if (!threadId || !UUID.test(threadId)) return res.status(400).json({ error: 'threadId_required' });
    const text = String(message || '').trim();
    if (!text) return res.status(400).json({ error: 'message_required' });
    if (text.length > MAX_MESSAGE_LEN) return res.status(413).json({ error: 'message_too_long', max: MAX_MESSAGE_LEN });

    const supabase = getSupabaseClient();
    const owns = await assertOwnership(supabase, threadId, req.user.id, workspaceId);
    if (!owns.ok) return res.status(owns.status).json({ error: owns.error });

    // Pull the recent history for context window. Cap at HISTORY_LIMIT pairs
    // so very long threads don't blow the prompt — we trim from the front
    // (oldest), keeping the most-recent turns which are most relevant.
    const { data: priorRows, error: histErr } = await supabase
      .from('playground_messages')
      .select('role, content, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT * 2);
    if (histErr) throw histErr;
    const history = (priorRows || []).reverse()
      .map(m => ({ role: m.role, content: m.content }));

    // Persist the user message before calling the model so a model crash
    // doesn't lose what the user typed.
    const { data: userRow, error: userErr } = await supabase
      .from('playground_messages')
      .insert({ thread_id: threadId, role: 'user', content: text })
      .select('id, role, content, tool_calls, created_at')
      .single();
    if (userErr) throw userErr;

    // If this is the first user message in the thread, derive a title.
    if (history.length === 0) {
      const title = text.slice(0, 80) + (text.length > 80 ? '…' : '');
      // PostgrestFilterBuilder is thenable but not a real Promise — `.catch()`
      // isn't on the builder; wrap in try/await/catch instead. Best-effort:
      // a title bump must never block the chat reply.
      try {
        await supabase
          .from('playground_threads')
          .update({ title })
          .eq('id', threadId);
      } catch { /* ignore */ }
    }

    // Run the agent loop.
    let assistantContent = '';
    let toolCalls = [];
    try {
      const out = await runPlaygroundTurn({
        supabase, workspaceId,
        history, userMessage: text,
        userId: req.user.id, internalUserId: req.internalUserId ?? null, threadId,
      });
      assistantContent = out.content;
      toolCalls = out.toolCalls;
    } catch (e) {
      console.error('[POST /api/playground/chat] agent error:', e);
      assistantContent = `Sorry — I hit an error running the agent (${e?.message || 'unknown'}). Try again, or simplify the question.`;
      toolCalls = [];
    }

    const { data: assistantRow, error: asstErr } = await supabase
      .from('playground_messages')
      .insert({
        thread_id: threadId, role: 'assistant',
        content: assistantContent,
        tool_calls: toolCalls.length ? toolCalls : null,
      })
      .select('id, role, content, tool_calls, created_at')
      .single();
    if (asstErr) throw asstErr;

    return res.json({ userMessage: userRow, assistantMessage: assistantRow });
  } catch (err) {
    console.error('[POST /api/playground/chat]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
