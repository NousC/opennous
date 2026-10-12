// Insight clustering: route what is new, consolidate what fit nowhere.
//
// WHAT THIS REPLACED. Clustering used to run inside the page load, in the API. Opening
// the Insights tab fired two LLM calls over the workspace's ENTIRE insight history, and
// the cache key was a sha1 of every insight id — so one new insight from one call
// invalidated the whole build and the next visitor paid to re-cluster everything. Cost
// grew with total history rather than with what was new. One customer had over a thousand
// insights and zero themes: whatever happened when someone opened that tab, it did not
// finish, and the page silently fell back to rendering hundreds of raw cards under Product.
//
// WHAT HAPPENS NOW. Nightly, per workspace, per source, per category:
//   1. ROUTE      — new insights are offered to the themes that already exist. A theme
//                   keeps its id, so the status a founder set on it survives.
//   2. CONSOLIDATE— what fit nowhere pools up; once the pool is worth a pass, it is
//                   clustered into new themes (chunked, then merged, so a category of
//                   several hundred insights is tractable).
//   3. REFRESH    — every theme's counts, dates and rank are recomputed from its members.
//
// Cost is O(what is new), not O(everything). A quiet night is one cheap routing call.
//
// Nothing here deletes a theme. A theme whose members all moved is retired, not removed,
// because deleting is exactly what orphaned every status row before.

import {
  getSupabaseClient,
  listUnclusteredInsightItems, listInsightThemes,
  openInsightThemes, assignInsightsToTheme, refreshThemeAggregates, releaseInsightsFromThemes,
  buildThemeRoutingPrompt, buildThemeClusterPrompt, buildThemeMergePrompt, parseThemeJson,
  THEMES_PER_CATEGORY, CLUSTER_CHUNK,
  INSIGHT_CATEGORY_KEYS, TEAM_INSIGHT_CATEGORY_KEYS,
  insightCategoryLabel, teamInsightCategoryLabel,
} from '@nous/core';
import { read, parseArray, acceptsArray } from '../noema/read.mjs';

const PAGE = 1000;          // PostgREST stops at 1000 rows without saying so
// Below this, a pool is not yet worth an LLM pass — the insights sit in Emerging on the
// page, which is where a thing said once belongs anyway. It will be picked up the night
// the pool crosses the line, or on a forced rebuild.
const MIN_POOL = 4;

const SOURCES = ['external', 'team'];
const catsFor = (source) => (source === 'team' ? TEAM_INSIGHT_CATEGORY_KEYS : INSIGHT_CATEGORY_KEYS);
const labelFor = (source, key) => (source === 'team' ? teamInsightCategoryLabel(key) : insightCategoryLabel(key));

/** One model call through the door, returning a parsed array or null. */
async function ask(supabase, workspaceId, feature, prompt, maxTokens) {
  const res = await read({
    supabase, workspaceId,
    feature,
    meterAs: 'insight-clustering',
    accept: acceptsArray,
    parse: (t) => (parseArray(t) === null ? null : parseThemeJson(t)),
    maxTokens,
    prompt,
  });
  return res.ok ? res.value : null;
}

/**
 * Offer the pool to the themes that already exist. Returns the insights that fit nowhere.
 * A conservative router is the point: absorbing a genuinely new signal into a nearby theme
 * hides the very thing that was new, so "none of these" is an answer we want it to give.
 */
async function routeIntoExisting(supabase, workspaceId, themes, pool, stats) {
  if (!themes.length || !pool.length) return pool;
  const leftover = [];
  const byTheme = new Map();

  for (let i = 0; i < pool.length; i += CLUSTER_CHUNK) {
    const chunk = pool.slice(i, i + CLUSTER_CHUNK);
    const prompt = buildThemeRoutingPrompt(
      themes.map(t => ({ title: t.title, takeaway: t.takeaway })),
      chunk.map(r => r.statement),
    );
    const arr = await ask(supabase, workspaceId, 'insight-theme-route', prompt, 4000);
    if (!arr) {
      // Unusable answer: the door has already recorded the failure. These insights stay
      // unclustered and are offered again tomorrow — never dropped.
      leftover.push(...chunk);
      stats.routeFailed++;
      continue;
    }
    const decided = new Set();
    for (const a of arr) {
      const i2 = Number(a?.i), t = Number(a?.t);
      if (!Number.isInteger(i2) || i2 < 0 || i2 >= chunk.length || decided.has(i2)) continue;
      decided.add(i2);
      if (!Number.isInteger(t) || t < 0 || t >= themes.length) { leftover.push(chunk[i2]); continue; }
      const id = themes[t].id;
      if (!byTheme.has(id)) byTheme.set(id, []);
      byTheme.get(id).push(chunk[i2].id);
    }
    // An insight the model simply did not mention is not assigned.
    chunk.forEach((r, ix) => { if (!decided.has(ix)) leftover.push(r); });
  }

  for (const [themeId, itemIds] of byTheme) {
    stats.routed += await assignInsightsToTheme(supabase, workspaceId, themeId, itemIds);
  }
  return leftover;
}

/**
 * Cluster a pool into new themes. Chunked so a large category fits the model's window,
 * then merged so the same pattern found in two chunks becomes one theme rather than two.
 */
async function consolidate(supabase, workspaceId, source, category, pool, budget, stats, opts = {}) {
  if (budget <= 0) return;
  // MIN_POOL keeps a quiet night from paying for a pass over three insights; a forced
  // rebuild ignores it, because that is the run that has to produce the tab.
  if (pool.length < MIN_POOL && !opts.force && !opts.rebuild) return;
  if (pool.length < 2) return;
  const label = labelFor(source, category);
  const kind = source === 'team' ? 'internal team' : 'customer';

  // Per-chunk candidates, each carrying the real insight ids it covers.
  const candidates = [];
  for (let i = 0; i < pool.length; i += CLUSTER_CHUNK) {
    const chunk = pool.slice(i, i + CLUSTER_CHUNK);
    const arr = await ask(
      supabase, workspaceId, 'insight-theme-cluster',
      buildThemeClusterPrompt(label, kind, chunk.map(r => r.statement), budget),
      8000,
    );
    if (!arr) { stats.clusterFailed++; continue; }
    for (const th of arr) {
      if (!th?.title) continue;
      const ids = (Array.isArray(th.items) ? th.items : [])
        .map(Number)
        .filter(n => Number.isInteger(n) && n >= 0 && n < chunk.length)
        .map(n => chunk[n].id);
      if (ids.length < 2) continue;           // a theme of one is not a theme
      candidates.push({ title: String(th.title).trim(), takeaway: th.takeaway ? String(th.takeaway).trim() : null, ids });
    }
  }
  if (!candidates.length) return;

  let finals = candidates;
  if (candidates.length > budget) {
    const merged = await ask(
      supabase, workspaceId, 'insight-theme-merge',
      buildThemeMergePrompt(candidates.map(c => c.title), budget),
      4000,
    );
    if (merged?.length) {
      const used = new Set();
      const out = [];
      for (const m of merged) {
        if (!m?.title) continue;
        const parts = (Array.isArray(m.merges) ? m.merges : [])
          .map(Number)
          .filter(n => Number.isInteger(n) && n >= 0 && n < candidates.length && !used.has(n));
        if (!parts.length) continue;
        parts.forEach(n => used.add(n));
        const ids = [...new Set(parts.flatMap(n => candidates[n].ids))];
        out.push({ title: String(m.title).trim(), takeaway: m.takeaway ? String(m.takeaway).trim() : null, ids });
      }
      // A candidate the merge pass forgot keeps its own theme rather than vanishing.
      candidates.forEach((c, n) => { if (!used.has(n)) out.push(c); });
      if (out.length) finals = out;
    }
    // Merge unusable: fall through with the biggest candidates, which is still better
    // than the raw pool. The door recorded the failure.
    finals = finals.sort((a, b) => b.ids.length - a.ids.length).slice(0, budget);
  }

  const opened = await openInsightThemes(
    supabase, workspaceId, source, category,
    finals.map(f => ({ title: f.title, takeaway: f.takeaway })),
  );

  // Match each created row back to the cluster it came from BY TITLE, not by position.
  // An insert that returns its rows in a different order than it received them would
  // otherwise hand every theme somebody else's evidence — a silent, plausible-looking
  // corruption that no error would report and no reader could detect from the page.
  const byTitle = new Map();
  for (const row of opened) {
    const k = row.title.trim().toLowerCase();
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(row);
  }
  const taken = new Set();
  for (let i = 0; i < finals.length; i++) {
    const queue = byTitle.get(finals[i].title.trim().toLowerCase()) || [];
    const row = queue.find(r => !taken.has(r.id));
    if (!row) continue;               // the insert dropped it; its insights stay pooled
    taken.add(row.id);
    // One insight belongs to one theme: a later cluster cannot steal an earlier one's rows.
    const ids = finals[i].ids.filter(id => !finals.slice(0, i).some(p => p.ids.includes(id)));
    stats.clustered += await assignInsightsToTheme(supabase, workspaceId, row.id, ids);
  }
  stats.opened += opened.length;
}

/** One (workspace, source, category). */
async function runCategory(supabase, workspaceId, source, category, stats, opts = {}) {
  // The one-time bootstrap: pre-2026-09-20 themes came out of a cross-category pass under
  // a shared budget, so a category could hold one theme for dozens of insights across dozens of calls.
  // Routing cannot fix that shape — it has to be clustered again, once.
  if (opts.rebuild) stats.released += await releaseInsightsFromThemes(supabase, workspaceId, source, category);

  const pool = await listUnclusteredInsightItems(supabase, workspaceId, source, category);
  const all = await listInsightThemes(supabase, workspaceId, source);
  const themes = all.filter(t => t.category === category);

  if (pool.length) {
    const leftover = await routeIntoExisting(supabase, workspaceId, themes, pool, stats);
    await consolidate(
      supabase, workspaceId, source, category, leftover,
      Math.max(0, THEMES_PER_CATEGORY - themes.length), stats, opts,
    );
  }
  // Always refresh: a theme's counts move when a sibling category's routing took rows,
  // and rank has to be recomputed even on a night nothing new arrived.
  if (pool.length || themes.length) {
    const live = await refreshThemeAggregates(supabase, workspaceId, source, category);
    stats.themes += live.length;
  }
}

/**
 * Nightly clustering for every workspace.
 *
 * @param {object} [opts]
 * @param {string} [opts.workspaceId]  just this one (the rebuild endpoint passes it)
 * @param {boolean} [opts.force]       ignore MIN_POOL — cluster whatever is there
 * @param {boolean} [opts.rebuild]     one-time: release every theme and cluster from scratch
 */
export async function runInsightThemes(opts = {}) {
  const supabase = getSupabaseClient();
  const startedAt = Date.now();
  const stats = { workspaces: 0, released: 0, routed: 0, clustered: 0, opened: 0, themes: 0, routeFailed: 0, clusterFailed: 0, failed: 0 };

  let wsIds = [];
  if (opts.workspaceId) {
    wsIds = [opts.workspaceId];
  } else {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('workspaces')
        .select('id').order('id').range(from, from + PAGE - 1);
      if (error) { console.error('[INSIGHT_THEMES] workspace scan failed:', error.message); return stats; }
      if (!data?.length) break;
      wsIds.push(...data.map(w => w.id));
      if (data.length < PAGE) break;
    }
  }

  for (const ws of wsIds) {
    try {
      // Cheap gate: a workspace with nothing unclustered and no themes is skipped without
      // a single model call. Most workspaces, most nights.
      const { count, error } = await supabase.from('insight_items')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', ws).is('theme_id', null);
      if (error?.message?.includes('theme_id')) {
        console.warn('[INSIGHT_THEMES] insight_items.theme_id missing — apply supabase/migrations/2026_09_20_insight_theme_durability.sql; nothing clustered');
        break;   // every other workspace hits the same wall
      }
      if (!count && !opts.force && !opts.rebuild) continue;
      stats.workspaces++;
      for (const source of SOURCES) {
        for (const category of catsFor(source)) {
          await runCategory(supabase, ws, source, category, stats, opts);
        }
      }
    } catch (err) {
      stats.failed++;
      console.error(`[INSIGHT_THEMES] ${ws}:`, err?.message || err);
    }
  }

  console.log(
    `[INSIGHT_THEMES] ${stats.workspaces} workspaces · ${stats.released} released · ${stats.routed} routed · ` +
    `${stats.clustered} newly clustered into ${stats.opened} new themes · ${stats.themes} live themes · ` +
    `${stats.routeFailed + stats.clusterFailed} unusable model answers · ${stats.failed} failed · ${Date.now() - startedAt}ms`,
  );
  return stats;
}
