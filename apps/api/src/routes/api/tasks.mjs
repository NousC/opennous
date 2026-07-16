// /api/tasks — what's going on, and what to do about it.
//
// Two things land here:
//   1. Meetings coming up.
//   2. Commitments made in those meetings ("send him the deck", "share the MVP"),
//      which the worker already extracts from transcripts into action_item.*
//      claims. They were being written and never surfaced.
//
// Every item ships with SUGGESTED ACTIONS — prompts you hand straight to the
// agent ("Brief me on this meeting", "Draft the follow-up"). That's the point of
// the page: it isn't a to-do list you tick off, it's a launcher into the agent
// for the work the record says you owe someone.

import { Router } from 'express';
import { getSupabaseClient, getInternalEntityIds } from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { getMeetings } from '../../lib/calendar.mjs';
import { autoCloseActionItems } from '../../lib/actionItems.mjs';

export const tasksRouter = Router();

const firstName = (full) => (full ?? '').trim().split(/\s+/)[0] || 'them';

// ─── Auto-close, off the request path ───────────────────────────────────────
//
// Closing tasks means asking a model whether a later conversation shows the work
// was done — which costs ~3 seconds. Doing that inside GET /api/tasks made the
// page take 3 seconds to render EVERY time you opened it, usually to close
// nothing. Nobody should wait on housekeeping to read their own task list.
//
// So it runs in the background, at most once every few minutes per workspace,
// and whatever it closes is reported on the NEXT load. The page is instant; the
// closures still happen; you still get told about them.
const CLOSE_INTERVAL_MS = 5 * 60_000;
const lastCloseAt = new Map();     // workspaceId -> timestamp
const pendingNews = new Map();     // workspaceId -> [{id, title, reason}]

function maybeAutoClose(supabase, workspaceId) {
  const last = lastCloseAt.get(workspaceId) ?? 0;
  if (Date.now() - last < CLOSE_INTERVAL_MS) return;
  lastCloseAt.set(workspaceId, Date.now());

  setImmediate(async () => {
    try {
      const closed = await autoCloseActionItems(supabase, workspaceId);
      if (closed.length) {
        // Held until the next load, so an auto-close is never silent.
        pendingNews.set(workspaceId, [...(pendingNews.get(workspaceId) ?? []), ...closed]);
      }
    } catch (e) {
      console.error('[tasks] autoclose:', e.message);
    }
  });
}

/** What closed itself since you last looked. Shown once, then cleared. */
function takeNews(workspaceId) {
  const news = pendingNews.get(workspaceId) ?? [];
  pendingNews.delete(workspaceId);
  return news;
}

// ─── Suggested actions ──────────────────────────────────────────────────────
//
// The action is a prompt. Clicking it drops that prompt into the agent, where
// the account record already is — so "draft the follow-up" is one click from the
// evidence it needs, instead of a note you retype into a blank chat.

function meetingActions(m) {
  const who = m.with ?? 'them';
  const first = firstName(m.with);
  return [
    {
      label: 'Brief me on this meeting',
      prompt: `Brief me on my meeting with ${who}${m.company ? ` at ${m.company}` : ''}. Who are they, what have we already discussed, where did we leave it, and what should I open with?`,
    },
    {
      label: 'What should I ask?',
      prompt: `What are the three questions I should ask ${first} in our next meeting, based on what we already know about them?`,
    },
    {
      label: 'What changed since we last spoke?',
      prompt: `What has changed with ${who} since our last conversation? Anything I'd look out of touch not knowing?`,
    },
  ];
}

// What kind of commitment is this? The title is written by the extraction worker
// in plain language ("Share MVP of the platform with Kabir for testing"), so
// the verb tells us what help the person actually wants.
const COMMITMENT_KINDS = [
  {
    match: /deck|presentation|pitch|slide/i,
    kind: 'deck',
    actions: (t, who) => [
      { label: 'Brainstorm the deck', prompt: `Help me brainstorm the deck for ${who}. What's the story, what do they actually care about, and what should each slide land? Use what we know about them.` },
      { label: 'Draft an outline',    prompt: `Draft a slide-by-slide outline for the presentation for ${who}, grounded in what we know about their situation.` },
    ],
  },
  {
    match: /email|follow[- ]?up|send|reply|respond|reach out/i,
    kind: 'email',
    actions: (t, who) => [
      { label: 'Draft the follow-up', prompt: `Draft the follow-up to ${who} for this: "${t}". Use what we last discussed and their own words. Sound like a peer, not a seller.` },
      { label: 'What should it say?', prompt: `What should I actually say to ${who} here — what's the one thing that moves this forward?` },
    ],
  },
  {
    match: /call|meeting|schedule|invite|book|demo/i,
    kind: 'scheduling',
    actions: (t, who) => [
      { label: 'Draft the message',   prompt: `Draft a short message to ${who} to get this scheduled: "${t}". Keep it easy to say yes to.` },
      { label: 'Prep me for it',      prompt: `When I get this call with ${who}, what do I need to know going in?` },
    ],
  },
  {
    match: /mvp|demo|access|trial|test|share|platform/i,
    kind: 'delivery',
    actions: (t, who) => [
      { label: 'Draft the handover',  prompt: `Draft the message to ${who} for this: "${t}". Tell them what they're getting and what feedback I want back.` },
      { label: 'What do they need?',  prompt: `What does ${who} actually need from this, based on what they told us?` },
    ],
  },
];

function commitmentActions(item) {
  const who = item.account ?? 'them';
  const title = item.title ?? '';
  const kindDef = COMMITMENT_KINDS.find(k => k.match.test(title));
  const actions = kindDef
    ? kindDef.actions(title, who)
    : [
        { label: 'Help me with this', prompt: `Help me with this: "${title}" — it's for ${who}. What's the context, and what's the best way to do it?` },
      ];
  // Always a way back to the person the commitment is to.
  actions.push({ label: `Catch me up on ${firstName(who)}`, prompt: `Catch me up on ${who} — where are we, and what do they need from me?` });
  return { kind: kindDef?.kind ?? 'general', actions };
}

// ─── GET /api/tasks?workspaceId=… ───────────────────────────────────────────

tasksRouter.get('/', verifySupabaseAuth, async (req, res) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    const supabase = getSupabaseClient();

    // 1. What's coming up. Only ahead — a meeting you already had isn't a task.
    let meetings = [];
    try {
      const found = await getMeetings(supabase, workspaceId, {
        fromDays: 0, toDays: 14, upcomingOnly: true,
      });
      meetings = found
        .filter(m => m.status !== 'cancelled')
        .map(m => ({ ...m, actions: meetingActions(m) }));
    } catch (e) {
      console.error('[GET /api/tasks] meetings:', e.message);
    }

    // Kick off closing anything the record shows you already did — but do NOT
    // wait for it. It reports back on the next load.
    maybeAutoClose(supabase, workspaceId);
    const autoClosed = takeNews(workspaceId);

    // 2. What you owe people. Extracted from meeting transcripts by the worker
    //    and written as action_item.* claims — the promises you made out loud.
    const { data: rows, error } = await supabase
      .from('claims')
      .select('entity_id, property, value, computed_at')
      .eq('workspace_id', workspaceId)
      .like('property', 'action_item.%')
      .is('invalid_at', null)
      .limit(200);
    if (error) throw error;

    const allItems = (rows ?? []).map(r => {
      const v = r.value || {};
      return {
        id:          `${r.entity_id}:${r.property}`,
        entity_id:   r.entity_id,
        title:       v.title || null,
        owner_kind:  v.owner_kind || 'user',
        // Who actually said they'd do it. The extraction worker reads this off
        // the transcript, so it's the only reliable answer to "whose task is it".
        owner_name:  v.owner_name || null,
        status:      v.status || 'open',
        due_at:      v.due_at || null,
        due_phrase:  v.due_phrase || null,
        source_type: v.source_type || null,
        recorded_at: r.computed_at,
        completed_at:     v.completed_at || null,
        completed_reason: v.completed_reason || null,
        completed_by:     v.completed_by || null,
      };
    }).filter(i => i.title);

    let items = allItems.filter(i => i.status === 'open');

    // Finished work, but only recently finished. A task list you can't look back
    // at gives you no way to check whether an auto-close was right — but the
    // window for that check is short, and a Finished section that keeps every
    // done task forever becomes hundreds of rows nobody reads. So a done task
    // ARCHIVES after 7 days: still in the record (status stays 'done'), just no
    // longer surfaced here. The row is not deleted, only aged out of the view.
    const ARCHIVE_AFTER_DAYS = 7;
    const archiveCutoff = Date.now() - ARCHIVE_AFTER_DAYS * 864e5;
    const completed = allItems
      .filter(i => i.status === 'done')
      // completed_at is when it was ticked; fall back to when the claim was
      // written so a done row with no timestamp still ages out rather than
      // living here forever.
      .filter(i => new Date(i.completed_at ?? i.recorded_at).getTime() >= archiveCutoff)
      .sort((a, b) =>
        new Date(b.completed_at ?? b.recorded_at).getTime() -
        new Date(a.completed_at ?? a.recorded_at).getTime())
      .slice(0, 40);

    // Name the person each commitment is to — "send the deck" means nothing
    // without knowing who's waiting on it.
    const ids = [...new Set([...items, ...completed].map(i => i.entity_id).filter(Boolean))];
    if (ids.length) {
      const { data: nameClaims } = await supabase
        .from('claims')
        .select('entity_id, property, value')
        .eq('workspace_id', workspaceId)
        .in('entity_id', ids)
        .in('property', ['first_name', 'last_name', 'name', 'company']);
      const byEntity = new Map();
      for (const c of nameClaims ?? []) {
        const m = byEntity.get(c.entity_id) ?? {};
        m[c.property] = c.value;
        byEntity.set(c.entity_id, m);
      }
      for (const i of [...items, ...completed]) {
        const m = byEntity.get(i.entity_id) ?? {};
        i.account = m.name ? String(m.name) : [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null;
        i.company = m.company ? String(m.company) : null;
        // A company that just repeats the person's name is a bad enrichment claim, not a
        // company. "Jordan Lee · Jordan Lee" is that bug showing through — drop it.
        if (i.company && i.account && i.company.trim().toLowerCase() === i.account.trim().toLowerCase()) i.company = null;
      }
    }

    // Internal meetings are not client accounts. A task pulled from the co-founder call is
    // work the TEAM owes itself, so it should read as the workspace, not as a teammate
    // wearing a prospect's clothes. We already flag these entities is_internal; here we
    // just relabel the account so the page stops calling Jordan a lead.
    const internalSet = await getInternalEntityIds(supabase, workspaceId);
    let workspaceName = 'Internal';
    try {
      const { data: ws } = await supabase.from('workspaces').select('name').eq('id', workspaceId).maybeSingle();
      if (ws?.name) workspaceName = ws.name;
    } catch { /* the label falls back to "Internal" */ }
    for (const i of [...items, ...completed]) {
      if (internalSet.has(i.entity_id)) { i.account = workspaceName; i.company = null; i.internal = true; }
    }

    // Mine first (things I promised), then whatever they owe me. Newest first.
    items.sort((a, b) => {
      if (a.owner_kind !== b.owner_kind) return a.owner_kind === 'user' ? -1 : 1;
      return new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime();
    });

    const commitments = items.map(i => {
      const { kind, actions } = commitmentActions(i);
      return { ...i, kind, actions };
    });

    // Who on the team owns this.
    //
    // The extraction worker already knows: it reads the transcript and records
    // owner_name — the person who actually said they'd do it. That's the truth.
    // relationship_owner (whoever touches the account most) is a DIFFERENT fact
    // and using it here gets the wrong person: "Share the MVP with Kabir" was
    // promised by Alex, not by whoever happens to own the Kabir relationship.
    //
    // So: match the commitment's owner_name to a team member. Fall back to the
    // account's relationship owner only for meetings, which have no promiser.
    const { data: members } = await supabase
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId);
    const memberIds = (members ?? []).map(m => m.user_id);

    let team = [];
    if (memberIds.length) {
      const { data: users } = await supabase
        .from('users')
        .select('id, name, email, profile_picture_url')
        .in('id', memberIds);
      team = (users ?? []).map(u => ({
        id: u.id,
        name: u.name || u.email?.split('@')[0] || null,
        avatar: u.profile_picture_url || null,
      }));
    }

    // Name → team member. The transcript says "Alex Rivera"; the account may
    // just say "Alex", so we match on the first name too.
    //
    // Which means ties are real: a workspace can hold two people called Alex
    // (an old account and the live one). Picking the first match landed on a
    // dormant account whose avatar URL had gone stale — so break ties toward the
    // person actually using the app, then toward whoever has a picture at all.
    const matchMember = (name) => {
      if (!name) return null;
      const n = String(name).trim().toLowerCase();
      if (!n) return null;

      const candidates = team.filter(m => {
        const mn = (m.name ?? '').toLowerCase();
        if (!mn) return false;
        return mn === n || n.startsWith(mn) || mn.startsWith(n.split(/\s+/)[0]);
      });
      if (!candidates.length) return null;
      if (candidates.length === 1) return candidates[0];

      return candidates.find(m => m.id === req.internalUserId)
        ?? candidates.find(m => m.avatar)
        ?? candidates[0];
    };

    // The account's relationship owner — the fallback for anything with no named
    // promiser. A meeting was nobody's promise, and an email or LinkedIn DM has
    // no speaker labels (only Fireflies attributes by speaker), so the person who
    // actually works that conversation is the right answer.
    const allEntityIds = [...new Set(
      [...meetings, ...commitments, ...completed].map(x => x.entity_id).filter(Boolean),
    )];
    const relOwner = new Map();
    if (allEntityIds.length) {
      const { data: ownerClaims } = await supabase
        .from('claims')
        .select('entity_id, value')
        .eq('workspace_id', workspaceId)
        .eq('property', 'relationship_owner')
        .in('entity_id', allEntityIds);
      const byId = new Map(team.map(m => [m.id, m]));
      for (const c of ownerClaims ?? []) {
        const m = byId.get(c.value?.primary);
        if (m) relOwner.set(c.entity_id, m);
      }
    }

    // A named promiser always wins — Fireflies heard who said it. Otherwise fall
    // back to whoever owns the relationship. We also record whether the promiser is one
    // of US: that, not the extraction worker's owner_kind, is the honest answer to "is
    // this mine to do, or is someone waiting on me". (The worker labels every non-owner
    // speaker "prospect", which brands a co-founder as a lead.)
    const assign = (row) => {
      const member = matchMember(row.owner_name);
      row.assignee = member ?? relOwner.get(row.entity_id) ?? null;
      row.owner_is_member = !!member;
    };
    commitments.forEach(assign);
    completed.forEach(assign);
    meetings.forEach(m => { m.assignee = relOwner.get(m.entity_id) ?? null; });

    // ── Personal scope ───────────────────────────────────────────────────────
    //
    // Tasks are a mailbox, not a shared board. I see what is mine — what I promised, and
    // what a client owes ME on an account I own. Jordan sees his. Neither of us reads the
    // other's desk. This is the same "scope the mailbox" line the privacy model draws
    // everywhere else in the product.
    //
    // The scope IS the assignee: every row already resolves to exactly one person, so
    // "mine" is simply "assigned to the logged-in user". A row that resolves to nobody
    // (no named promiser, no relationship owner) would otherwise vanish for everyone, so
    // those stay visible — an orphan task you can see beats one silently dropped.
    const me = req.internalUserId;
    const isMine = (row) => !row.assignee || row.assignee.id === me;
    const scopedCommitments = commitments.filter(isMine);
    const scopedCompleted   = completed.filter(isMine);
    const scopedMeetings    = meetings.filter(isMine);

    return res.json({
      meetings: scopedMeetings,
      commitments: scopedCommitments,
      completed: scopedCompleted,
      // What closed itself since you last looked, and why — shown once, so an
      // auto-close is something you notice rather than something that just
      // silently happens to your list.
      auto_closed: autoClosed,
      counts: { meetings: scopedMeetings.length, commitments: scopedCommitments.length, completed: scopedCompleted.length },
    });
  } catch (err) {
    console.error('[GET /api/tasks]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// PATCH /api/tasks/:entityId/:property — mark one done (or reopen it) by hand.
// Evidence can't prove everything ("brainstorm the pitch"), so the user always
// has the final say.
tasksRouter.patch('/:entityId/:property', verifySupabaseAuth, async (req, res) => {
  try {
    const { entityId, property } = req.params;
    const { workspaceId, status } = req.body || {};
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
    if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    if (!property.startsWith('action_item.')) return res.status(400).json({ error: 'not_an_action_item' });

    const supabase = getSupabaseClient();
    const { data: row, error } = await supabase
      .from('claims')
      .select('id, value')
      .eq('workspace_id', workspaceId)
      .eq('entity_id', entityId)
      .eq('property', property)
      .is('invalid_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'not_found' });

    const next = {
      ...(row.value || {}),
      status,
      completed_at: status === 'done' ? new Date().toISOString() : null,
      completed_reason: status === 'done' ? 'you marked it done' : null,
      completed_by: status === 'done' ? 'user' : null,
    };
    const { error: upErr } = await supabase.from('claims').update({ value: next }).eq('id', row.id);
    if (upErr) throw upErr;

    return res.json({ ok: true, status });
  } catch (err) {
    console.error('[PATCH /api/tasks]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
