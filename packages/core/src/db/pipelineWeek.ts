// Pipeline this week: how the deals moved since Monday, in five counts. Home's right rail.
//
// Read from the CRM's own stage and close-date HISTORY (the `crm_history` observations the
// HubSpot sync writes on each deal: every stage change with its real timestamp, every close-date
// rewrite), never from current-state rows, whose observed_at is the sync time and would make
// every synced deal look like it moved this week.
//
//   new        a deal whose first stage change falls in the window (created into the pipeline)
//   moved up   a deal that ends the window in a LATER open stage than it started it, by the
//              stage's position in its own pipeline (workspace_stages.sort_order)
//   won / lost a deal whose last change in the window put it in a won / lost stage
//   slipped    a deal whose close date was pushed later in the window, or an open deal whose
//              close date passed in the window without it closing
//
// Each deal counts once per line. A deal created and advanced in the same week is "new", not
// "moved up": it had no starting position to move up from. Won and lost come from the stage's
// kind in workspace_stages (which already corrects CRMs that forget to flag a stage closed),
// falling back to the verdict the sync stamped on the observation.
//
// Each count comes with the deals behind it (ids plus where they moved from and to), so a number
// on Home opens onto the rows that make it. joinWeekDeals puts names and amounts on those ids from
// rows the caller already holds; this module never reads a deal list of its own.

import type { SupabaseClient } from '@supabase/supabase-js';

export type WeekBucket = 'new' | 'moved_up' | 'won' | 'lost' | 'slipped';
export const WEEK_BUCKETS: readonly WeekBucket[] = ['new', 'moved_up', 'won', 'lost', 'slipped'];

/** One deal on one line, by id. `from`/`to` are stage labels for moved up / won / lost, close
 *  dates (YYYY-MM-DD) for slipped, and null for new: a new deal had no position to move from. */
export interface WeekDealRef { id: string; from: string | null; to: string | null }

export interface PipelineWeek {
  new: number;
  moved_up: number;
  won: number;
  lost: number;
  slipped: number;
  /** False when the workspace has no stage history at all (a CRM without it, or none connected):
   *  the counts are then zeros that mean "unknown", and a reader should say so. */
  has_history: boolean;
  /** The deals behind each count. Each list's length IS that count: one loop builds both, so a
   *  number and the rows it opens onto cannot disagree. */
  deals: Record<WeekBucket, WeekDealRef[]>;
}

export interface StageHistoryRow { entity_id: string; value: unknown; observed_at: string; raw?: { stage_id?: string | null; status?: string | null } | null }
export interface CloseDateHistoryRow { entity_id: string; value: unknown; observed_at: string }
export interface StagePosition { sortOrder: number; kind: string }

const PAGE = 1000;

/** The pure half: counts from history rows already in hand. Exported for tests. */
export function summarizePipelineWeek(input: {
  stageRows: StageHistoryRow[];
  closeRows: CloseDateHistoryRow[];
  stages: Map<string, StagePosition>;
  openDeals: { entity_id: string; close_date: string | null }[];
  since: Date;
  now?: Date;
}): PipelineWeek {
  const since = input.since.getTime();
  const now = (input.now ?? new Date()).getTime();
  const inWindow = (iso: string) => { const t = Date.parse(iso); return t >= since && t <= now; };

  const byDeal = <T extends { entity_id: string; observed_at: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      if (!r.entity_id || !Number.isFinite(Date.parse(r.observed_at))) continue;
      (m.get(r.entity_id) ?? m.set(r.entity_id, []).get(r.entity_id)!).push(r);
    }
    for (const list of m.values()) list.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
    return m;
  };

  const kindOf = (r: StageHistoryRow) => {
    const pos = r.raw?.stage_id ? input.stages.get(String(r.raw.stage_id)) : undefined;
    if (pos) return pos.kind;
    const s = r.raw?.status;
    return s === 'won' || s === 'lost' ? s : 'active';
  };
  const orderOf = (r: StageHistoryRow) => (r.raw?.stage_id ? input.stages.get(String(r.raw.stage_id))?.sortOrder : undefined);

  const lists: Record<WeekBucket, WeekDealRef[]> = { new: [], moved_up: [], won: [], lost: [], slipped: [] };
  for (const [id, hops] of byDeal(input.stageRows)) {
    const during = hops.filter((h) => inWindow(h.observed_at));
    if (!during.length) continue;
    const before = hops.filter((h) => Date.parse(h.observed_at) < since);
    const last = during[during.length - 1];
    const lastKind = kindOf(last);
    if (!before.length) lists.new.push({ id, from: null, to: null });
    if (lastKind === 'won' || lastKind === 'lost') {
      // "Proposal → Closed won": the stage it closed FROM is the hop just before the closing one,
      // which for a deal created and closed inside the week is still a real stage.
      const prior = hops[hops.indexOf(last) - 1];
      lists[lastKind].push({ id, from: prior ? stageLabel(prior.value) : null, to: stageLabel(last.value) });
      continue;
    }
    if (!before.length) continue;
    const start = before[before.length - 1];
    if (kindOf(start) !== 'active') continue;
    const from = orderOf(start), to = orderOf(last);
    if (from != null && to != null && to > from) lists.moved_up.push({ id, from: stageLabel(start.value), to: stageLabel(last.value) });
  }

  const slipped = new Map<string, WeekDealRef>();
  for (const [deal, rows] of byDeal(input.closeRows)) {
    for (let i = 1; i < rows.length; i++) {
      if (!inWindow(rows[i].observed_at)) continue;
      // Later by DAY, not by clock: the same close date re-saved with another offset or hour moved
      // the instant but not the date, and read as "slipped Nov 27 → Nov 27" on live data.
      const prevDay = dayOf(rows[i - 1].value), nextDay = dayOf(rows[i].value);
      if (prevDay && nextDay && nextDay > prevDay) {
        slipped.set(deal, { id: deal, from: dayOf(rows[i - 1].value), to: dayOf(rows[i].value) });
        break;
      }
    }
  }
  for (const d of input.openDeals) {
    const t = d.close_date ? Date.parse(d.close_date) : NaN;
    // A date that simply went by has no new date yet: `to` stays null until the rep moves it.
    if (Number.isFinite(t) && t >= since && t < now && !slipped.has(d.entity_id)) {
      slipped.set(d.entity_id, { id: d.entity_id, from: dayOf(d.close_date), to: null });
    }
  }
  lists.slipped = [...slipped.values()];

  return {
    new: lists.new.length, moved_up: lists.moved_up.length, won: lists.won.length, lost: lists.lost.length,
    slipped: lists.slipped.length, has_history: input.stageRows.length > 0, deals: lists,
  };
}

/** The label a stage hop carries. The sync writes it as a bare string (dealHistoryFacts); an
 *  object-shaped value is read rather than printed as "[object Object]". */
function stageLabel(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    const o = v as { label?: unknown; value?: unknown };
    const x = o.label ?? o.value;
    return x == null ? null : String(x).trim() || null;
  }
  return String(v).trim() || null;
}

/** A close date as the calendar day the CRM shows. The leading YYYY-MM-DD is taken as written,
 *  because converting "2026-09-30T00:00:00-04:00" through UTC would print the next day. */
function dayOf(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

// ── Joining the ids to deals, for Home ───────────────────────────────────────────────────────

/** A deal on a line of the week, as Home draws it. */
export interface WeekDeal {
  id: string;
  company_id: string | null;
  name: string | null;
  account: string | null;
  value: number | null;
  from: string | null;
  to: string | null;
}

/** The fields joinWeekDeals reads, in listDealRows' MAPPED shape: the amount is `value` and the
 *  id is `id` (not the entity_list_rows columns pipeline_value / entity_id). */
export interface WeekDealRow {
  id: string;
  name?: string | null;
  company_id?: string | null;
  company_name?: string | null;
  value?: number | string | null;
}

export type PipelineWeekView = Omit<PipelineWeek, 'deals'> & {
  value: Record<WeekBucket, number>;
  deals: Record<WeekBucket, WeekDeal[]>;
};

const amount = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Put names, accounts and amounts on the week's deal ids from deal rows the caller already holds,
 * and sum each line.
 *
 * `inScope`, when given, keeps only the deals in the viewer's book and the counts become the kept
 * lists' lengths, so a "mine" week counts only my deals. Without it the counts are left exactly as
 * summarizePipelineWeek returned them. A deal with no row keeps its id and reads null for the
 * rest: a stage change on a deal the list projection has not caught up with is still a change.
 *
 * Each list is ordered biggest first and cut to `limit`; `value` is summed BEFORE the cut, so the
 * money on a line is the whole line's.
 */
export function joinWeekDeals(
  week: PipelineWeek,
  rows: Map<string, WeekDealRow>,
  { inScope = null, limit = 100 }: { inScope?: ((id: string) => boolean) | null; limit?: number } = {},
): PipelineWeekView {
  const value = { new: 0, moved_up: 0, won: 0, lost: 0, slipped: 0 } as Record<WeekBucket, number>;
  const deals = { new: [], moved_up: [], won: [], lost: [], slipped: [] } as Record<WeekBucket, WeekDeal[]>;
  const counts = { new: week.new, moved_up: week.moved_up, won: week.won, lost: week.lost, slipped: week.slipped };
  for (const bucket of WEEK_BUCKETS) {
    const refs = (week.deals?.[bucket] ?? []).filter((r) => !inScope || inScope(r.id));
    const line = refs.map((r): WeekDeal => {
      const row = rows.get(r.id);
      return {
        id: r.id, company_id: row?.company_id ?? null, name: row?.name ?? null,
        account: row?.company_name ?? null, value: amount(row?.value), from: r.from, to: r.to,
      };
    });
    value[bucket] = line.reduce((s, d) => s + (d.value ?? 0), 0);
    line.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || String(a.name ?? '').localeCompare(String(b.name ?? '')));
    deals[bucket] = line.slice(0, Math.max(0, limit));
    if (inScope) counts[bucket] = refs.length;
  }
  return { ...counts, has_history: week.has_history, value, deals };
}

/**
 * Open deals that need a nudge, Home's "deals at risk", by the SAME rule as the Pipeline page's At
 * risk view so the two numbers agree: the last activity is known and `quietDays` or more old, or
 * a Nous deal-health score below `healthBelow` where the row carries one. A deal with no activity
 * on record is NOT counted as quiet: that is "never worked", a different flag (dealSignals), and
 * counting it here would fill Home with every CRM deal Nous has no conversation for. Only the rows
 * passed in are read; the caller hands over the open deals already in the viewer's scope.
 */
export function dealsAtRisk(
  openDeals: { value?: number | string | null; last_activity_at?: string | null; health_score?: number | string | null }[],
  { now = Date.now(), quietDays = 9, healthBelow = 50 }: { now?: number; quietDays?: number; healthBelow?: number } = {},
): { count: number; value: number } {
  let count = 0, value = 0;
  for (const d of openDeals ?? []) {
    const last = d.last_activity_at ? Date.parse(d.last_activity_at) : NaN;
    const quiet = Number.isFinite(last) && Math.floor((now - last) / 86_400_000) >= quietDays;
    const health = amount(d.health_score);
    if (!quiet && !(health != null && health < healthBelow)) continue;
    count++;
    value += amount(d.value) ?? 0;
  }
  return { count, value };
}

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * Pipeline this week for a workspace. `openDeals` is the open-deal list the caller already
 * holds (Home reads it for its numbers), used for "close date passed this week".
 */
export async function getPipelineWeek(
  supabase: SupabaseClient,
  workspaceId: string,
  { since, openDeals = [] }: { since: Date; openDeals?: { entity_id: string; close_date: string | null }[] },
): Promise<PipelineWeek> {
  const sinceIso = since.toISOString();
  const history = (property: string) => supabase.from('observations')
    .select('entity_id, value, observed_at, raw')
    .eq('workspace_id', workspaceId).eq('method', 'crm_history').eq('property', property);

  // Which deals changed this week, then their whole timelines (the hop before the window is
  // what "moved up" and "new" are measured against).
  const [stageNow, closeNow, stageRows] = await Promise.all([
    pageAll<{ entity_id: string }>((a, b) => history('stage').gte('observed_at', sinceIso).order('observed_at').order('id').range(a, b)),
    pageAll<{ entity_id: string }>((a, b) => history('close_date').gte('observed_at', sinceIso).order('observed_at').order('id').range(a, b)),
    supabase.from('workspace_stages').select('external_ref, sort_order, kind').eq('workspace_id', workspaceId),
  ]);
  const stages = new Map<string, StagePosition>();
  for (const s of (stageRows.data ?? []) as { external_ref: string | null; sort_order: number; kind: string }[]) {
    if (s.external_ref) stages.set(String(s.external_ref), { sortOrder: s.sort_order, kind: s.kind });
  }

  const timelines = async (property: string, ids: string[]) => {
    const out: StageHistoryRow[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      out.push(...await pageAll<StageHistoryRow>((a, b) => history(property).in('entity_id', chunk).order('observed_at').order('id').range(a, b)));
    }
    return out;
  };
  const [stageHist, closeHist] = await Promise.all([
    timelines('stage', [...new Set(stageNow.map((r) => r.entity_id))]),
    timelines('close_date', [...new Set(closeNow.map((r) => r.entity_id))]),
  ]);

  const summary = summarizePipelineWeek({ stageRows: stageHist, closeRows: closeHist, stages, openDeals, since });
  if (!summary.has_history) {
    // No change this week is not the same as no history. Look once, cheaply.
    const { count } = await supabase.from('observations').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('method', 'crm_history').eq('property', 'stage');
    summary.has_history = (count ?? 0) > 0;
  }
  return summary;
}
