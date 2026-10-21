// The Insights board, nightly: place what is new, tie it to its account, refresh what changed.
//
// Per workspace, under the one-writer lock (backfill_locks):
//   1. TAGS     — a workspace with no tag list gets one proposed from its own insights (a person
//                 edits it later). Insights that fit no tag feed a second, smaller proposal.
//   2. PLACE    — every unplaced external insight gets ONE button (subtype) and 1-3 tags, in one
//                 Haiku read of the sentence. See packages/core/src/db/insightBoard.ts for why one.
//   3. ACCOUNTS — the call the insight came from → its outside attendees → their company. Our own
//                 people are skipped, so our own company is never the account.
//   4. ROWS     — each (button × main tag) raised by enough accounts gets a headline, its concrete
//                 problems and three quotes, rewritten only when its membership grew enough.
//
// Cost is O(what is new): a quiet night places nothing and rewrites nothing. The first run on a
// workspace is the extraction pass over all its existing insights (every one is unplaced); `--all` just forces the rows pass too.
// All reads go through the model door on the extraction tier, which is Haiku.

import {
  getSupabaseClient, loadWorkspaceContext, getInternalEntityIds, withBackfillLock, lockHolder, LockHeldError,
  listInsightTags, addInsightTags, listUnsortedInsightItems, listBoardItems, saveInsightPlacement,
  listInsightRows, saveInsightRow, resolveInsightAccounts, companyNames,
  buildTagListPrompt, parseTagList, buildSortPrompt, parseSortAnswer, buildRowSummaryPrompt, parseRowSummary,
  rowNeedsSummary, BOARD_SUMMARY_MIN_ACCOUNTS, loadInternalSpeakers, isInternalSpeaker,
  loadBusinessType, unsortWorkspaceInsights, dropModelTags, NOT_AN_INSIGHT, insightBoardModel,
  BOARD_MODEL_NAME_MIN_ACCOUNTS, BOARD_NAME_BATCH, buildRowsSummaryPrompt, parseRowsSummary, relinkInsightAccounts,
} from '@nous/core';
import { read, acceptsObject } from '../noema/read.mjs';

const SORT_BATCH = 50;
const PLACE_LIMIT = 3000;        // one night's ceiling per workspace; the rest waits for tomorrow
const FIRST_TAGS_MIN = 20;       // below this a workspace has too little to propose a list from
const TAG_SAMPLE = 600;          // statements shown when proposing a first list
const NEW_TAG_MIN_UNTAGGED = 10; // untagged insights needed before asking for more tags
const SUMMARY_ITEMS = 80;
const SUMMARY_ITEMS_BATCHED = 30;   // per topic when ten share a call: the newest thirty tell the story        // newest statements shown for one row
const PAGE = 1000;

async function ask(supabase, workspaceId, feature, prompt, parse, maxTokens) {
  const res = await read({ supabase, workspaceId, feature, meterAs: 'insight-board', accept: acceptsObject, parse, maxTokens, prompt, model: insightBoardModel() });
  return res.ok ? res.value : null;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function proposeTags(supabase, ws, statements, existing, ctx, stats) {
  if (!statements.length) return [];
  const proposed = await ask(supabase, ws, 'insight-board-tags', buildTagListPrompt(statements, existing, ctx),
    (t) => parseTagList(t), 8000);
  if (!proposed) { stats.failed++; return []; }
  if (stats.dryRun) { stats.tagsProposed += proposed.length; return proposed; }
  stats.tagsProposed += await addInsightTags(supabase, ws, proposed);
  return proposed;
}

/** Place a set of insights. Returns the ones that ended up with no tag. */
async function place(supabase, ws, items, tags, ctx, internal, stats, bt) {
  const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const names = tags.map((t) => t.name);
  const accounts = await resolveInsightAccounts(supabase, ws, items.map((i) => i.source_ref).filter(Boolean), internal);
  const untagged = [];
  const batches = [];
  for (let i = 0; i < items.length; i += SORT_BATCH) batches.push(items.slice(i, i + SORT_BATCH));
  await pool(batches, 4, async (batch) => {
    const placed = await ask(supabase, ws, 'insight-board-sort', buildSortPrompt(batch, tags, ctx, bt),
      (t) => parseSortAnswer(t, batch.length, names), 6000);
    if (!placed) { stats.failed++; return; }  // the door recorded it; these stay unplaced for tomorrow
    await pool(batch, 8, async (it, k) => {
      const p = placed[k];
      if (!p) return;                          // the model skipped it: unplaced, never guessed
      // A ref no observation carries (PostHog's product issues, GET-751) resolves to nothing: keep the
      // account the item was written with instead of clearing it, or the board drops the row.
      const acct = (it.source_ref && accounts.get(it.source_ref)) || { contactId: it.contact_id ?? null, companyId: it.company_id ?? null };
      const tagIds = p.tags.map((n) => byName.get(n.toLowerCase())).filter(Boolean);
      if (p.subtype === NOT_AN_INSIGHT) stats.dropped = (stats.dropped ?? 0) + 1;
      else if (!tagIds.length) untagged.push(it);
      stats.placed++;
      if (acct.companyId) stats.linked++;
      if (!stats.dryRun) await saveInsightPlacement(supabase, ws, it.id, { subtype: p.subtype, tagIds, contactId: acct.contactId, companyId: acct.companyId });
    });
  });
  return untagged;
}

async function refreshRows(supabase, ws, ctx, stats, force, bt) {
  const [all, rows, tags, internal] = await Promise.all([
    listBoardItems(supabase, ws), listInsightRows(supabase, ws), listInsightTags(supabase, ws), loadInternalSpeakers(supabase, ws),
  ]);
  // A headline is written from the customer's words only; our own people's lines never count.
  const items = all.filter((i) => !isInternalSpeaker(i, internal));
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const existing = new Map(rows.map((r) => [`${r.subtype}|${r.tag_id}`, r]));
  const groups = new Map();
  for (const it of items) {
    const tag = it.tag_ids?.[0];
    if (!tag || !tagName.has(tag)) continue;
    const k = `${it.subtype}|${tag}`;
    if (!groups.has(k)) groups.set(k, { subtype: it.subtype, tag, items: [] });
    groups.get(k).items.push(it);
  }
  const due = [...groups.entries()].filter(([k, g]) => {
    const accounts = new Set(g.items.map((i) => i.company_id).filter(Boolean)).size;
    g.accounts = accounts;
    const prev = existing.get(k);
    // A topic that has just reached the model threshold is renamed by the model, even if its item
    // count has not grown much: until now it carried its own sentence as its name.
    const promoted = accounts >= BOARD_MODEL_NAME_MIN_ACCOUNTS && (prev?.account_count ?? 0) < BOARD_MODEL_NAME_MIN_ACCOUNTS;
    return accounts >= BOARD_SUMMARY_MIN_ACCOUNTS && (force || promoted || rowNeedsSummary(prev?.item_count ?? 0, g.items.length));
  }).map(([, g]) => g);
  if (!due.length) return;
  const newest = (g) => [...g.items].sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')));

  // Small topics: named from their own clearest sentence, no model. One account's one or two
  // statements already say what the topic is — and most topics are this small.
  const small = due.filter((g) => g.accounts < BOARD_MODEL_NAME_MIN_ACCOUNTS);
  for (const g of small) {
    const shown = newest(g).sort((a, b) => Number(!!b.quote) - Number(!!a.quote));
    stats.rowsFree = (stats.rowsFree ?? 0) + 1;
    if (stats.dryRun) continue;
    await saveInsightRow(supabase, ws, {
      subtype: g.subtype, tag_id: g.tag, headline: shown[0].statement.replace(/\.$/, ''),
      problems: [], receipt_ids: shown.slice(0, 3).map((i) => i.id),
      item_count: g.items.length, account_count: g.accounts,
    });
  }

  // The rest: ten topics to a call, the instructions and company description sent once per ten.
  const big = due.filter((g) => g.accounts >= BOARD_MODEL_NAME_MIN_ACCOUNTS);
  if (!big.length) return;
  const names = await companyNames(supabase, ws, big.flatMap((g) => g.items.map((i) => i.company_id)));
  const batches = [];
  for (let i = 0; i < big.length; i += BOARD_NAME_BATCH) batches.push(big.slice(i, i + BOARD_NAME_BATCH));
  await pool(batches, 3, async (batch) => {
    const shownOf = batch.map((g) => newest(g).slice(0, SUMMARY_ITEMS_BATCHED));
    const prompt = buildRowsSummaryPrompt(batch.map((g, k) => ({
      tagName: tagName.get(g.tag), subtypeKey: g.subtype,
      items: shownOf[k].map((i) => ({ statement: i.statement, quote: i.quote, account: names.get(i.company_id) ?? null, date: (i.occurred_at || '').slice(0, 10) || null })),
    })), ctx, bt);
    const answers = await ask(supabase, ws, 'insight-board-rows', prompt, (t) => parseRowsSummary(t, shownOf.map((x) => x.length)), 8000);
    if (!answers) { stats.failed++; return; }
    for (let k = 0; k < batch.length; k++) {
      const s = answers[k], g = batch[k], shown = shownOf[k];
      if (!s) { stats.failed++; continue; }          // asked again next run, never guessed
      stats.rows++;
      if (stats.dryRun) continue;
      await saveInsightRow(supabase, ws, {
        subtype: g.subtype, tag_id: g.tag, headline: s.headline,
        problems: s.problems.map((p) => ({ title: p.title, detail: p.detail, item_ids: p.items.map((n) => shown[n].id) })),
        receipt_ids: s.receipts.map((n) => shown[n].id),
        item_count: g.items.length, account_count: g.accounts,
      });
    }
  });
}

async function runWorkspace(supabase, ws, opts, stats) {
  const ctx = await loadWorkspaceContext(supabase, ws).catch(() => null);
  const bt = await loadBusinessType(supabase, ws).catch(() => 'software');
  const internal = await getInternalEntityIds(supabase, ws).catch(() => new Set());
  let tags = await listInsightTags(supabase, ws);
  const unsorted = await listUnsortedInsightItems(supabase, ws, opts.limit ?? PLACE_LIMIT);

  if (!tags.length) {
    if (unsorted.length < FIRST_TAGS_MIN) return;       // too young to name its things yet
    const sample = [...unsorted].sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || ''))).slice(0, TAG_SAMPLE);
    const proposed = await proposeTags(supabase, ws, sample.map((i) => i.statement), [], ctx, stats);
    // A dry run places against the proposed list in memory, so the preview shows real placements.
    tags = opts.dryRun ? proposed.map((p) => ({ ...p, id: `dry:${p.name}` })) : await listInsightTags(supabase, ws);
    if (!tags.length) return;
  }

  if (unsorted.length) {
    const untagged = await place(supabase, ws, unsorted, tags, ctx, internal, stats, bt);
    // Enough insights fit no tag: the list is missing something. Ask for what is missing, then
    // give those insights one more try against the longer list.
    if (untagged.length >= NEW_TAG_MIN_UNTAGGED && !opts.dryRun) {
      const before = tags.length;
      await proposeTags(supabase, ws, untagged.map((i) => i.statement), tags, ctx, stats);
      tags = await listInsightTags(supabase, ws);
      if (tags.length > before) {
        const placedAgain = { ...stats, placed: 0, linked: 0 };
        await place(supabase, ws, untagged, tags, ctx, internal, placedAgain, bt);
        stats.retagged += placedAgain.placed;
      }
    }
  }
  await refreshRows(supabase, ws, ctx, stats, !!opts.all, bt);
}

/**
 * @param {object} [opts]
 * @param {string}  [opts.workspaceId] just this one
 * @param {boolean} [opts.all]         rewrite every row summary, not only the ones that grew
 * @param {boolean} [opts.dryRun]      read and ask, write nothing
 * @param {number}  [opts.limit]       most insights to place per workspace this run
 */
export async function runInsightBoard(opts = {}) {
  const supabase = getSupabaseClient();
  const started = Date.now();
  const stats = { dryRun: !!opts.dryRun, workspaces: 0, placed: 0, linked: 0, retagged: 0, tagsProposed: 0, rows: 0, failed: 0, skipped: 0 };

  let wsIds = opts.workspaceId ? [opts.workspaceId] : [];
  if (!opts.workspaceId) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('workspaces').select('id').order('id').range(from, from + PAGE - 1);
      if (error) { console.error('[INSIGHT_BOARD] workspace scan failed:', error.message); return stats; }
      wsIds.push(...(data ?? []).map((w) => w.id));
      if (!data || data.length < PAGE) break;
    }
  }

  for (const ws of wsIds) {
    try {
      // --resort (one workspace, on request): take everything off the board so this run sorts it
      // again under the current buttons and rules. Never on the nightly run.
      if ((opts.resort || opts.retag) && opts.workspaceId && !opts.dryRun) await unsortWorkspaceInsights(supabase, ws);
      // --retag: also rebuild the model's tag list under the current rules (one tag per named
      // competitor or requested capability). A person's own tags stay.
      if (opts.retag && opts.workspaceId && !opts.dryRun) await dropModelTags(supabase, ws);
      const { count, error } = await supabase.from('insight_items').select('id', { count: 'exact', head: true })
        .eq('workspace_id', ws).eq('source', 'external').is('sorted_at', null);
      if (error?.message?.includes('sorted_at')) {
        console.warn('[INSIGHT_BOARD] insight_items.sorted_at missing — apply supabase/migrations/2026_09_24_insight_board.sql; nothing placed');
        break;
      }
      // Tie insights that still have no account (no model, a few reads). A topic that gains
      // accounts this way is renamed below even on a night with nothing new to sort.
      const relinked = opts.dryRun ? 0 : await relinkInsightAccounts(supabase, ws, await getInternalEntityIds(supabase, ws).catch(() => new Set())).catch(() => 0);
      stats.relinked = (stats.relinked ?? 0) + relinked;
      if (!count && !relinked && !opts.all) continue;  // nothing new, nothing forced: no model call at all
      stats.workspaces++;
      await withBackfillLock(supabase, ws, 'insightBoard', { holder: lockHolder('insightBoard'), leaseMinutes: 60 },
        () => runWorkspace(supabase, ws, opts, stats));
    } catch (err) {
      if (err instanceof LockHeldError) { stats.skipped++; console.warn(`[INSIGHT_BOARD] ${ws}: ${err.message}`); continue; }
      stats.failed++;
      console.error(`[INSIGHT_BOARD] ${ws}:`, err?.message || err);
    }
  }
  console.log(
    `[INSIGHT_BOARD]${stats.dryRun ? ' DRY RUN' : ''} ${stats.workspaces} workspaces · ${stats.placed} placed (${stats.linked} tied to an account) · ` +
    `${stats.retagged} re-tagged · ${stats.dropped ?? 0} not insights · ${stats.relinked ?? 0} tied to an account late · ${stats.tagsProposed} tags added · ` +
    `${stats.rows} rows named by the model · ${stats.rowsFree ?? 0} named from their own sentence · ${stats.failed} unusable answers · ` +
    `${stats.skipped} locked · ${Date.now() - started}ms`,
  );
  return stats;
}
