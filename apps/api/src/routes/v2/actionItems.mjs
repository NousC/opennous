import { Router } from 'express';
import { getSupabaseClient, isoDateIn, shiftIsoDate, getWorkspaceTimezone, filterDerivedForViewer, derivedViewerForContext, readContextFromReq,
  parseTaskId, taskIdOf, readTaskClaims, applyBulkStatus, TASK_STATUSES, hubspotTaskIdOf, syncTaskStatusToHubspot } from '@nous/core';

// GET /v2/action-items — the agent's read path for commitments extracted from
// meetings/emails. Action items live as `action_item.*` state claims on the
// account entity (written by the worker), so this just reads + filters them.
//   owner=me|prospect|all   (default me — the founder's own commitments)
//   status=open|done|all    (default open)
//   focus=<email|entity_id> (optional — scope to one account)
//   due=today|week|all      (default all; today/week filter items that have a due_at)
// Every item carries `task_id` (`<entity_id>:<property>`), the id POST /status closes it by.
//
// POST /v2/action-items/status { ids: [task_id, …], status: 'done' | 'open', reason? } — close or
// reopen tasks (GET-830). The same edit as ticking them on the Tasks page. A read-only key is
// refused by verifyApiKey (a non-GET outside its read list).
export const actionItemsV2Router = Router();

const STATUS_MAX = 100;

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

actionItemsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const owner  = (req.query.owner  || 'me').toString();
    const status = (req.query.status || 'open').toString();
    const due    = (req.query.due    || 'all').toString();
    const focus  = req.query.focus ? req.query.focus.toString().trim() : null;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    // Optional account scope: resolve focus (entity id or email) → entity_id.
    let focusEntityId = null;
    if (focus) {
      if (UUID.test(focus)) {
        focusEntityId = focus;
      } else {
        const email = focus.toLowerCase();
        const { data: ident } = await supabase.from('entity_identifiers')
          .select('entity_id').eq('workspace_id', workspaceId)
          .eq('kind', 'email').eq('value', email).maybeSingle();
        focusEntityId = ident?.entity_id
          || (await supabase.from('contacts').select('id')
                .eq('workspace_id', workspaceId).eq('email', email).maybeSingle()).data?.id
          || null;
      }
      if (!focusEntityId) return res.json({ items: [], count: 0 });
    }

    let q = supabase.from('claims')
      .select('entity_id, property, value, computed_at, supporting_observation_ids')
      .eq('workspace_id', workspaceId)
      .like('property', 'action_item.%')
      .is('invalid_at', null)
      .order('computed_at', { ascending: false })
      // Owner, title and privacy filter in JS below, so read past the page and cut after them:
      // a limit taken first came back short on a mixed list and never said it was cut.
      .limit(Math.min(limit * 4, 1000));
    if (focusEntityId) q = q.eq('entity_id', focusEntityId);
    // Filter status in the query, not after the limit: a workspace holds hundreds of closed tasks,
    // and a limit taken first returned whichever rows came back, so open ones went missing.
    if (status === 'done') q = q.eq('value->>status', 'done');
    else if (status === 'open') q = q.or('value->>status.is.null,value->>status.eq.open');
    const { data: rows, error } = await q;
    if (error) throw error;
    // An action item read out of a private message is the team's; its quote follows the message (GET-985).
    const visibleRows = await filterDerivedForViewer(supabase, workspaceId, rows || [],
      await derivedViewerForContext(supabase, readContextFromReq(req)));

    const now = Date.now();
    let items = visibleRows.map(r => {
      const v = r.value || {};
      return {
        id:          r.property,
        task_id:     taskIdOf(r.entity_id, r.property),
        entity_id:   r.entity_id,
        title:       v.title || null,
        owner_kind:  v.owner_kind || 'user',
        owner_name:  v.owner_name || null,
        status:      v.status || 'open',
        due_at:      v.due_at || null,
        due_phrase:  v.due_phrase || null,
        source_type: v.source_type || null,
        source_id:   v.source_id || null,
        recorded_at: r.computed_at,
        ...(v.status === 'done' ? { completed_at: v.completed_at || null, completed_reason: v.completed_reason || null } : {}),
      };
    }).filter(i => i.title);

    if (owner !== 'all') {
      const want = owner === 'me' ? 'user' : owner;
      items = items.filter(i => i.owner_kind === want);
    }
    if (status !== 'all') items = items.filter(i => i.status === status);
    if (due === 'today' || due === 'week') {
      // due_at is a CIVIL date (YYYY-MM-DD), so compare it as one. Running it
      // through `new Date()` reads it as UTC midnight and then measures against
      // a rolling clock, which quietly pulled tomorrow's items into "today" for
      // most of the day and shifted the whole window for anyone west of UTC.
      // ISO dates compare correctly as plain strings, so no parsing is needed.
      // The horizon is shifted in CIVIL space, not by adding milliseconds to an
      // instant: across a DST boundary seven days of milliseconds is not seven
      // calendar days, which quietly shrank the window and dropped items that
      // were genuinely due inside it.
      // Same workspace timezone the worker used when WRITING due_at — if the
      // two sides read different zones, the today/week window goes off-by-one
      // for any workspace west of the server's zone.
      const tz = await getWorkspaceTimezone(supabase, workspaceId).catch(() => undefined);
      const today = isoDateIn(new Date(now), tz);
      const horizon = today && (due === 'today' ? today : shiftIsoDate(today, 7));
      // Only compare things that are actually civil dates. A due_at that is a
      // number or malformed string would otherwise compare lexically — and
      // "1830297600" sorts below any "2026-..", so it passed every horizon.
      const asDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
      if (horizon) items = items.filter(i => { const d = asDate(i.due_at); return d && d <= horizon; });
    }

    const ids = [...new Set(items.map(i => i.entity_id).filter(Boolean))];
    if (ids.length) {
      const { data: contacts } = await supabase.from('contacts')
        .select('id, first_name, last_name, email, company').in('id', ids);
      const byId = new Map((contacts || []).map(c => [c.id, c]));
      for (const i of items) {
        const c = byId.get(i.entity_id);
        i.account       = c ? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email) : null;
        i.account_email = c?.email || null;
        i.company       = c?.company || null;
      }
    }
    items.sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime());
    const truncated = items.length > limit;
    if (truncated) items = items.slice(0, limit);
    return res.json({ items, count: items.length, truncated });
  } catch (err) {
    console.error('[GET /v2/action-items]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

actionItemsV2Router.post('/status', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { ids, status, reason } = req.body || {};
    if (!TASK_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status', detail: "status must be 'done' or 'open'" });
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids_required', detail: 'Pass the task_id of each task (from GET /v2/action-items or /v2/attention).' });
    const unique = [...new Set(ids.map((x) => (typeof x === 'string' ? x.trim() : '')))];
    if (unique.length > STATUS_MAX) return res.status(400).json({ error: 'too_many_ids', max: STATUS_MAX });
    const asked = unique.map((id) => ({ id, parsed: parseTaskId(id) }));

    // Only tasks that exist can be closed. A commitment read out of a private message is the team's
    // (GET-985), so any member may close it; only its quote stays with the message. Unseen = not found.
    const rows = await readTaskClaims(supabase, workspaceId, asked.filter((a) => a.parsed).map((a) => a.parsed),
      'id, entity_id, property, value, supporting_observation_ids');
    const visible = await filterDerivedForViewer(supabase, workspaceId, rows,
      await derivedViewerForContext(supabase, readContextFromReq(req)));

    const results = await applyBulkStatus(supabase, workspaceId, asked, status, {
      // The write starts from the stored rows, never the viewer's copy: that copy has the quote
      // stripped, and writing it back would erase the owner's quote for good (GET-985).
      claimRows: rows,
      reason: typeof reason === 'string' ? reason : null,
      // A task Nous created in HubSpot follows its close there, as from the Tasks page. Never fatal.
      onWritten: async ({ entityId, property, prev }) => {
        if ((prev.status ?? 'open') === status) return;
        const hubspotTaskId = await hubspotTaskIdOf(supabase, workspaceId, entityId, property, prev);
        if (hubspotTaskId) await syncTaskStatusToHubspot({ supabase, workspaceId, hubspotTaskId, done: status === 'done' });
      },
    });
    const titleOf = new Map(visible.map((r) => [taskIdOf(r.entity_id, r.property), r.value?.title ?? null]));
    const out = results.map((r) => (r.ok ? { ...r, title: titleOf.get(r.id) ?? null } : r));
    const ok = out.filter((r) => r.ok).length;
    return res.json({ status, results: out, counts: { ok, failed: out.length - ok } });
  } catch (err) {
    console.error('[POST /v2/action-items/status]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
