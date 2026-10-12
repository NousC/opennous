// Closing a task, or reopening it: the one edit every surface makes (GET-830).
//
// A task is an action_item.* claim. Its status changes in place, field for field the same whether a
// person ticks it on the Tasks page (PATCH /api/tasks, POST /api/tasks/bulk) or an agent closes it
// through the API (POST /v2/action-items/status, the MCP `tasks` tool). It lived in the Cloud task
// routes, which left the public API able to READ tasks and not close one, so an agent told "that's
// done" had no move but to write a note saying so while the task stayed open in every worklist.
//
// The pure halves are exported for tests; applyBulkStatus takes the client.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_PREFIX = 'action_item.';

export const TASK_STATUSES = ['open', 'done'];

/** A task's id is `<entityId>:<property>`, the pair that names its claim. Null when it isn't one. */
export function parseTaskId(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf(':');
  if (at <= 0) return null;
  const entityId = id.slice(0, at);
  const property = id.slice(at + 1);
  if (!UUID.test(entityId) || !property.startsWith(ACTION_PREFIX) || property.length > 300) return null;
  return { entityId, property };
}

/** The id a task is closed by, from the claim's own two columns. */
export const taskIdOf = (entityId, property) => `${entityId}:${property}`;

/**
 * The claim value after a status change. A close by a person, or by an agent acting for one, is the
 * person's close (`completed_by: 'user'`): the agent works under its key's seat, and the auto-closer
 * treats a hand close as final. `reason` says what made it done when the caller knows.
 */
export function statusValue(prev, status, now, { reason = null } = {}) {
  const p = prev ?? {};
  const why = typeof reason === 'string' && reason.trim() ? reason.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  return {
    ...p,
    status,
    completed_at: status === 'done' ? now : null,
    completed_reason: status === 'done' ? why ?? 'you marked it done' : null,
    completed_by: status === 'done' ? 'user' : null,
    completed_evidence: status === 'done' ? null : p.completed_evidence ?? null,
    // REOPENING IS A VERDICT ON THE CLOSE (GET-407): only what happens after it may close it again.
    reopened_at: status === 'open' && p.status === 'done' ? now : p.reopened_at ?? null,
  };
}

/**
 * What a bulk status change writes, from the live claims it read. Each asked id gets a result; only
 * the rows that exist become writes. Pure.
 */
export function planBulk(asked, claimRows, status, now, opts = {}) {
  const byKey = new Map((claimRows ?? []).map((r) => [`${r.entity_id}|${r.property}`, r]));
  const writes = [];
  const results = [];
  for (const { id, parsed } of asked) {
    if (!parsed) { results.push({ id, ok: false, error: 'invalid_id' }); continue; }
    const row = byKey.get(`${parsed.entityId}|${parsed.property}`);
    if (!row) { results.push({ id, ok: false, error: 'not_found' }); continue; }
    writes.push({ id, claimId: row.id, prev: row.value ?? {}, value: statusValue(row.value, status, now, opts) });
    results.push({ id, ok: true, status });
  }
  return { writes, results };
}

/** The live action-item claims behind a set of parsed ids, read 50 at a time. */
export async function readTaskClaims(supabase, workspaceId, parsedIds, columns = 'id, entity_id, property, value') {
  const rows = [];
  for (let i = 0; i < parsedIds.length; i += 50) {
    const slice = parsedIds.slice(i, i + 50);
    const { data, error } = await supabase.from('claims').select(columns)
      .eq('workspace_id', workspaceId).is('invalid_at', null)
      .in('entity_id', [...new Set(slice.map((p) => p.entityId))])
      .in('property', [...new Set(slice.map((p) => p.property))]);
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}

/**
 * Set the status of many tasks. `asked` is `[{ id, parsed }]` (parsed from parseTaskId); one result
 * per id. `claimRows`, when given, is the set the caller is allowed to touch (already read and
 * filtered for its viewer); without it the claims are read here. `onWritten` runs after each saved
 * write and is never fatal.
 */
export async function applyBulkStatus(supabase, workspaceId, asked, status, { onWritten = null, reason = null, claimRows = null } = {}) {
  const rows = claimRows ?? await readTaskClaims(supabase, workspaceId, asked.filter((a) => a.parsed).map((a) => a.parsed));
  const { writes, results } = planBulk(asked, rows, status, new Date().toISOString(), { reason });
  const failed = new Set();
  const parsedOf = new Map(asked.map((a) => [a.id, a.parsed]));
  for (let i = 0; i < writes.length; i += 10) {
    await Promise.all(writes.slice(i, i + 10).map(async (w) => {
      const { error } = await supabase.from('claims').update({ value: w.value }).eq('id', w.claimId).eq('workspace_id', workspaceId);
      if (error) { failed.add(w.id); return; }
      if (onWritten) {
        const p = parsedOf.get(w.id);
        try { await onWritten({ id: w.id, entityId: p.entityId, property: p.property, status, prev: w.prev, value: w.value }); }
        catch (e) { console.warn('[tasks] status hook failed:', w.id, e?.message ?? e); }
      }
    }));
  }
  return results.map((r) => (failed.has(r.id) ? { id: r.id, ok: false, error: 'write_failed' } : r));
}
