// Living context files (GET-1039): context OpenNous writes and keeps current, so it compounds.
//
// A chatbot prompt forgets; a living file is updated by every new outcome and read by the next action.
// Each lives in Settings > Context as an ordinary context file shared with the workspace, so it is read,
// versioned and synced like any other (GET-1037, GET-1038). What makes it living: OpenNous writes it,
// every update is a version authored by OpenNous with a one-line changelog ("+2 losses to Brightlist,
// price"), and, with a repo connected, a commit with that line as its message.
//
// The first is win/loss. Every deal that closes won or lost (deal_outcomes: the date the close was
// recorded) adds what the account's record says about why, and the file is rewritten around the
// patterns: why we win, why we lose, by competitor, objection, segment and stage. Read from the cursor
// forward, a few deals a pass, so a backfill never becomes one huge call.
import { writingModel, canonicalEntityNames, competitorKey, occurredLabel, recordContextVersion, learnedBlockOf, withLearnedBlock } from '@nous/core';
import { computeIcpModel, renderIcpBlock } from './icpModel.mjs';
import { createMessage, messageText } from './llm.mjs';
import { trackLlmUsage } from './llmUsage.mjs';
import { pushContextFile } from './contextRepo.mjs';
import { ourSideOn, repliesFor, saidLines } from './livingOurSide.mjs';
import { linkedAnswers, lostBecause } from './livingLinks.mjs';
import { analyzeClosedDeals, readDealWhy } from './dealWhy.mjs';
import { parseDoc, renderDoc, parseOps, applyOps, changelogOf, buildEditPrompt, shapeRetryPrompt, skippedRetryPrompt } from './livingDoc.mjs';
import { behindOf, citedState, itemSources, resolveRefs, stripDoc, stampDoc, carryCites, rewriteCites, pruneSources, buildRetractionPrompt, restrictRetraction } from './livingEvidence.mjs';

export const LIVING_FILES = {
  win_loss: {
    title: 'Win/loss',
    about: 'Why you win and lose. Updated from every deal that closes.',
  },
  // GET-1040: one file each, a section per competitor / per objection. Battlecards are hidden for now
  // (GET-1044): not listed, not turned on and not run, so a workspace sees win/loss and objections only.
  battlecards: {
    hidden: true,
    title: 'Battlecards',
    about: 'What each competitor pitches, where you meet them and whether you win, kept current by OpenNous from every competitor mention.',
  },
  objections: {
    title: 'Objection playbook',
    about: 'What buyers push back on, the answers given and what moved the deal. Updated from every objection raised.',
  },
};
const BACKFILL_DAYS = 180;
const PER_PASS = 12;
const MAX_TIES = 40;
const NOTES_PER_DEAL = 12;
const FILE_CHARS = 24_000;
// GET-1054: a pass edits the file with small operations; once a week a whole-file rebuild clears drift.
const REBUILD_DAYS = 7;
const NO_EDIT = 'No edit could be applied';
// What the record says about why a deal went the way it did.
const WHY = ['objection', 'competitor', 'blocker', 'buying_signal', 'risk_signal', 'budget', 'timeline', 'authority', 'requirement', 'pain', 'goal'];

const missing = (e) => ['42P01', 'PGRST205'].includes(e?.code) || /workspace_living_files/.test(e?.message ?? '');
const day = (ts) => String(ts ?? '').slice(0, 10);

/** The file a living file starts as, before anything has been read. Pure. */
export function seedBody(key) {
  const f = LIVING_FILES[key];
  const first = { win_loss: '## Why we win\n\n_No closed deals read yet._\n\n## Why we lose\n\n_No closed deals read yet._\n', battlecards: '_No competitor mentions read yet._\n', objections: '_No objections read yet._\n' }[key] ?? '';
  return `# ${f.title}\n\n_${f.about} Every update is a version with what changed._\n\n${first}`;
}

/** The prompt: the file as it stands, the deals that closed since, and how to fold them in. Pure. */
export function buildWinLossPrompt({ current, deals, company = null }) {
  const lines = deals.map((d, i) => {
    // An event says when it happened (GET-1051), so "moved off Ledgerway in March" said at the close is not read as a move at the close.
    // A deal analysed at close (GET-1077) brings its own points; the raw notes are the fallback.
    const facts = d.why?.length ? d.why.map(w => `   - why: **${w.label}**: ${w.text}`).join('\n')
      : d.notes.length ? d.notes.map(n => `   - [${n.category}] ${n.content}${n.occurred ? ` (happened ${n.occurred})` : ''}`).join('\n') : '   - (nothing on file about why)';
    // What WE said on the deal (GET-1052): our pitch lines and promises, labelled as ours so they are never read as the buyer's reason.
    const said = d.said?.length ? `\n   what we said (our side, not the buyer's):\n${d.said.map(l => `   - ${l}`).join('\n')}` : '';
    // Cause links (GET-1053): the objections and blockers the record links as the cause of the deal's facts.
    const because = d.lost_because?.length ? `\n   lost because (the record links these as causes):\n${d.lost_because.map(l => `   - ${l}`).join('\n')}` : '';
    return `${i + 1}. ${d.outcome.toUpperCase()} · ${d.account} · closed ${day(d.closed_at)}${d.value ? ` · $${Math.round(d.value).toLocaleString('en-US')}` : ''}${d.segment ? ` · ${d.segment}` : ''}${d.stage_before ? ` · last stage ${d.stage_before}` : ''}\n${facts}${said}${because}`;
  }).join('\n');
  return `You keep ${company ? `${company}'s` : 'a company\'s'} win/loss file: why its deals are won and lost. It is read before every sales call and every follow-up, so it must say what to do differently, not just what happened.

THE FILE AS IT STANDS:
<<<
${current}
>>>

DEALS THAT CLOSED SINCE IT WAS LAST UPDATED, with what the account's record says:
${lines}

Rewrite the whole file with these deals folded in. Keep what still holds, sharpen it with the new evidence, and drop nothing that is still true. Sections, in this order (leave a section out only when there is nothing for it):
# Win/loss
- one short paragraph: the overall picture, with counts (won / lost so far in this file)
## Why we win
## Why we lose
## By competitor
## By objection
## By segment and deal size
## Where deals stall or slip
## Recent closes
- one line per deal, newest first, at most 25: date · account · won/lost · the reason in a few words

Rules:
- A deal's "why:" lines are its own analysed reasons: build the drivers from them, keep their labels (the same label on several deals is one driver, with its count), and do not re-derive them from scratch.
- In Why we win and Why we lose, each point is its own paragraph (a blank line between points, not one list), and starts with a bold label of two to four words in plain business terms (e.g. **Price at scale**, **Founder-led sale**, **Security review**, **No champion**), then one short sentence. In Why we lose, put (controllable) right after the label when the team or the product could change it.
- A pattern needs evidence: name the accounts behind it, and how many. One deal is an example, not a pattern; say so.
- Only what the record says. Never invent a reason; "no reason on file" is an answer.
- Plain markdown, short bullets, no filler. Under ${Math.round(FILE_CHARS / 1000)}k characters.

Answer with ONLY a JSON object:
{"file": "<the whole new file, markdown>", "changelog": "<one line, under 120 characters, what changed, e.g. +2 losses to Brightlist, price; +1 win, came for the API>"}`;
}

/** Battlecards (GET-1040): new competitor mentions, each with its account and how that account ended. Pure. */
export function buildBattlecardsPrompt({ current, items, company = null }) {
  const lines = items.map((m, i) => `${i + 1}. ${m.competitor ?? 'A competitor'}${m.stance ? ` (${m.stance})` : ''} · ${m.account} · ${day(m.said_at)}${m.outcome ? ` · deal ${m.outcome}` : ''}\n   ${m.content}`).join('\n');
  return `You keep ${company ? `${company}'s` : 'a company\'s'} battlecards: one section per competitor, read before a call where that competitor comes up. It must say how to win against each one, not just who they are.

THE FILE AS IT STANDS:
<<<
${current}
>>>

NEW COMPETITOR MENTIONS, with the account and, when it has closed, how the deal ended:
${lines}

Rewrite the whole file with these folded in. "# Battlecards", then one "## <Competitor>" section each, most-met first, with: what they pitch (as buyers describe it), where we met them (accounts, how many), what buyers like about them, where we won and lost against them and why, how to position against them. Keep what still holds; merge a competitor named two ways into one section.

Rules: only what the mentions say, with the accounts behind each point; one account is an example, not a pattern; a tool that does not do what we sell is not a competitor, leave it out. Plain markdown, short bullets, under ${Math.round(FILE_CHARS / 1000)}k characters.

Answer with ONLY a JSON object:
{"file": "<the whole new file, markdown>", "changelog": "<one line, under 120 characters, e.g. Brightlist: +2 mentions, lost at Brindle on price>"}`;
}

/** The objection playbook (GET-1040): new objections, whether each was resolved, and what moved after. Pure. */
export function buildObjectionsPrompt({ current, items, company = null }) {
  // "we answered:" (GET-1052): the replies our side gave, so the playbook can state the answers given.
  // "answered by:" (GET-1053): a reply the record LINKS to the objection (the reply it was resolved by),
  // shown instead of the paired "we answered:" when there is one.
  const answers = (o) => (o.answered_by?.length ? `\n   answered by: ${o.answered_by.join(' | ')}` : o.answered?.length ? `\n   we answered: ${o.answered.join(' | ')}` : '');
  const lines = items.map((o, i) => `${i + 1}. ${o.account} · ${day(o.said_at)}${o.occurred ? ` · happened ${o.occurred}` : ''}${o.status ? ` · ${o.status}` : ''}${o.hardness ? ` · ${o.hardness}` : ''}${o.outcome ? ` · deal ${o.outcome}` : ''}\n   ${o.content}${answers(o)}${o.after.length ? `\n   after it: ${o.after.join(' | ')}` : ''}`).join('\n');
  return `You keep ${company ? `${company}'s` : 'a company\'s'} objection playbook, read before calls and follow-ups: the objections buyers raise, the answers that were given, and which of them moved the deal.

THE FILE AS IT STANDS:
<<<
${current}
>>>

NEW OBJECTIONS, with the account, whether it was resolved, how the deal ended when it has, and what the buyer did after it:
${lines}

Rewrite the whole file with these folded in. "# Objection playbook", then one "## <the objection, in a few words>" section each, most-heard first, with: how often and from whom (accounts), hard or soft, the answers given (only when the record shows one), what moved the deal after it, and what to say next time. Merge the same objection said in different words.

Rules: only what the record says, with the accounts behind each point; "no answer on file" is an answer; one account is an example, not a pattern. Plain markdown, short bullets, under ${Math.round(FILE_CHARS / 1000)}k characters.

Answer with ONLY a JSON object:
{"file": "<the whole new file, markdown>", "changelog": "<one line, under 120 characters, e.g. \"reps don't use Claude\" heard 3 times, answered 2, both moved>"}`;
}

/** The model's answer, or null when it is not usable. Pure. */
export function parseWinLoss(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    const file = typeof o.file === 'string' ? o.file.trim() : '';
    if (file.length < 40 || !/^#\s/m.test(file)) return null;
    return { file: file.slice(0, FILE_CHARS), changelog: String(o.changelog ?? '').trim().slice(0, 120) || 'Updated from new closes' };
  } catch { return null; }
}

/**
 * The workspace's living files: each key with its state, and whether it is on. GET-1055: an enabled
 * file also says how far behind it is, `behind: { new, retracted, points }` (livingEvidence behindOf):
 * the in-scope items newer than its watermark (cursor_at), the cited items since retired, and the
 * points resting on them; null when it cannot be read. `*` because the doc column may not be migrated.
 */
export async function listLivingFiles(sb, ws) {
  const { data, error } = await sb.from('workspace_living_files').select('*').eq('workspace_id', ws);
  if (error) { if (missing(error)) return []; throw error; }
  const byKey = new Map((data ?? []).map(r => [r.key, r]));
  return Promise.all(Object.entries(LIVING_FILES).filter(([, f]) => !f.hidden).map(async ([key, f]) => {
    const r = byKey.get(key);
    if (!r) return { key, title: f.title, about: f.about, enabled: false, file_id: null };
    const out = { key, title: f.title, about: f.about, file_id: r.file_id ?? null, enabled: !!r.enabled, cursor_at: r.cursor_at ?? null, last_run_at: r.last_run_at ?? null, last_error: r.last_error ?? null };
    return r.enabled ? { ...out, behind: await behindOf(sb, ws, r) } : out;
  }));
}

/**
 * Turn a living file on or off. On the first time, its context file is made (shared with the
 * workspace) and the cursor set BACKFILL_DAYS back, so it starts from the last six months of closes.
 * Off keeps the file and stops updating it.
 */
export async function setLivingFile(sb, ws, uid, key, enabled) {
  if (!LIVING_FILES[key] || LIVING_FILES[key].hidden) throw Object.assign(new Error('Unknown intelligence file.'), { status: 400 });
  const { data: row, error } = await sb.from('workspace_living_files').select('*').eq('workspace_id', ws).eq('key', key).maybeSingle();
  if (error) throw error;
  let fileId = row?.file_id ?? null;
  if (fileId) {
    const { data: still } = await sb.from('workspace_context_files').select('id').eq('workspace_id', ws).eq('id', fileId).maybeSingle();
    if (!still) fileId = null;   // deleted since: made again
  }
  if (enabled && !fileId) {
    const { data: made, error: e2 } = await sb.from('workspace_context_files').insert({
      workspace_id: ws, title: LIVING_FILES[key].title, kind: 'reference', body: seedBody(key), visibility: 'workspace', created_by: uid, updated_by: uid,
    }).select('id, workspace_id, title, kind, body').single();
    if (e2) throw e2;
    fileId = made.id;
    await recordContextVersion(sb, ws, made, { kind: 'opennous', changelog: 'Turned on' });
  }
  const at = new Date().toISOString();
  const { error: e3 } = await sb.from('workspace_living_files').upsert({
    workspace_id: ws, key, file_id: fileId, enabled: !!enabled, updated_at: at,
    ...(row ? {} : { cursor_at: new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString(), enabled_by: uid }),
  }, { onConflict: 'workspace_id,key' });
  if (e3) throw e3;
  return (await listLivingFiles(sb, ws)).find(f => f.key === key);
}

/** The deals that closed after `since`, oldest first, each with why: the account's notes. */
async function closedSince(sb, ws, since, limit) {
  const { data, error } = await sb.from('deal_outcomes').select('id, entity_id, outcome, closed_at, value_usd, deal_id')
    .eq('workspace_id', ws).in('outcome', ['won', 'lost']).gt('closed_at', since).order('closed_at', { ascending: true }).order('id', { ascending: true }).limit(limit);
  if (error) throw error;
  const out = [];
  const rows = await withTies(sb, ws, data ?? [], limit);
  // Each deal's own read of why (GET-1077), where the analysis pass has written one.
  const whys = await readDealWhy(sb, ws, rows.map(r => r.deal_id)).catch(() => new Map());
  const seen = new Set();
  for (const d of rows) {
    let { data: acct } = await sb.from('entity_list_rows').select('name, industry, stage, kind, company_id').eq('workspace_id', ws).eq('entity_id', d.entity_id).maybeSingle();
    // A close on a person is their company's deal (GET-1078): named by the company, read once per pass.
    if (acct?.kind === 'person' && acct.company_id) {
      const key = `${acct.company_id}|${d.outcome}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { data: co } = await sb.from('entity_list_rows').select('name, industry, stage').eq('workspace_id', ws).eq('entity_id', acct.company_id).maybeSingle();
      if (co) { d.entity_id = acct.company_id; acct = co; }
    }
    const { data: people } = await sb.from('entity_list_rows').select('entity_id').eq('workspace_id', ws).eq('kind', 'person').eq('company_id', d.entity_id).limit(50);
    const ids = [d.entity_id, ...(people ?? []).map(p => p.entity_id)];
    const { data: claims } = await sb.from('claims').select('id, value, valid_from').eq('workspace_id', ws).in('entity_id', ids).like('property', 'note.%')
      .order('valid_from', { ascending: false }).limit(200);
    const notes = (claims ?? []).map(c => c.value ?? {}).filter(v => WHY.includes(v.category) && v.content)
      .slice(0, NOTES_PER_DEAL).map(v => ({ category: v.category, content: String(v.content).slice(0, 300), ...(occurredLabel(v.metadata) ? { occurred: occurredLabel(v.metadata) } : {}) }));
    // claim_ids (GET-1053): what the deal's cause links are looked up by; gather drops it before the prompt.
    const why = whys.get(d.deal_id)?.why;
    // outcome_id: the ledger row this item is, so its evidence is matched by id, not by position (GET-1078).
    out.push({ outcome_id: String(d.id), entity_id: d.entity_id, outcome: d.outcome, account: acct?.name ?? 'An account', segment: acct?.industry ?? null, value: d.value_usd ?? null, closed_at: d.closed_at, notes,
      ...(why?.length ? { why } : {}),
      claim_ids: (claims ?? []).map(c => c.id).filter(Boolean) });
  }
  return out;
}

/**
 * A full page ends on a close date, and the cursor moves to it and reads after it next pass, so any
 * other close on that same date would never be read (date-only CRM close dates share one often).
 * The page is finished with every close on its last date (GET-1075). Exported for the test.
 */
export async function withTies(sb, ws, rows, limit, cap = MAX_TIES) {
  if (rows.length < limit || !rows.length) return rows;
  const last = rows.at(-1).closed_at;
  // Capped: a CRM bulk close puts hundreds on one date, and one pass that large could fail every hour.
  const { data, error } = await sb.from('deal_outcomes').select('id, entity_id, outcome, closed_at, value_usd, deal_id')
    .eq('workspace_id', ws).in('outcome', ['won', 'lost']).eq('closed_at', last).order('id', { ascending: true }).limit(cap);
  if (error) throw error;
  const seen = new Set(rows.map(r => String(r.id)));
  return [...rows, ...(data ?? []).filter(r => !seen.has(String(r.id)))];
}

/** Where a claim sits: its account (a person's company) and the account's latest outcome, if closed. */
async function accountOf(sb, ws, entityId, cache) {
  if (cache.has(entityId)) return cache.get(entityId);
  const { data: row } = await sb.from('entity_list_rows').select('entity_id, kind, name, company_id, company_name').eq('workspace_id', ws).eq('entity_id', entityId).maybeSingle();
  const accountId = row?.kind === 'person' ? row.company_id : entityId;
  const name = (row?.kind === 'person' ? row.company_name : row?.name) ?? row?.name ?? 'An account';
  let outcome = null;
  if (accountId) {
    const { data: o } = await sb.from('deal_outcomes').select('outcome, closed_at').eq('workspace_id', ws).eq('entity_id', accountId).in('outcome', ['won', 'lost']).order('closed_at', { ascending: false }).limit(1);
    outcome = o?.[0]?.outcome ?? null;
  }
  const out = { accountId, name, outcome };
  cache.set(entityId, out);
  return out;
}

/** The live claims of `category` said after `since`, oldest first. */
async function claimsSince(sb, ws, category, since, limit) {
  const { data, error } = await sb.from('claims').select('id, entity_id, value, valid_from').eq('workspace_id', ws).like('property', 'note.%')
    .is('invalid_at', null).eq('value->>category', category).gt('valid_from', since).order('valid_from', { ascending: true }).limit(limit);
  if (error) throw error;
  return (data ?? []).filter(c => c.value?.content);
}

// What each living file reads, how it asks, and where its cursor moves to.
const SPECS = {
  win_loss: {
    feature: 'living-win-loss',
    gather: async (sb, ws, since) => {
      const deals = await closedSince(sb, ws, since, PER_PASS);
      // What we pitched and promised on each deal (GET-1052): our side's claims, never a buyer fact.
      for (const d of deals) d.said = saidLines(await ourSideOn(sb, ws, [d.entity_id], ['pitch_line', 'our_commitment']));
      // Why a lost deal was lost, as the record links it (GET-1053): the objections and blockers
      // linked as the cause of one of its facts. Fail-safe: no links, no line.
      for (const d of deals) {
        if (d.outcome === 'lost') d.lost_because = await lostBecause(sb, ws, d.claim_ids);
        delete d.claim_ids;
      }
      return { items: deals, cursor: deals.at(-1)?.closed_at ?? null };
    },
    prompt: ({ current, items, company }) => buildWinLossPrompt({ current, deals: items, company }),
  },
  battlecards: {
    feature: 'living-battlecards',
    gather: async (sb, ws, since) => {
      const cache = new Map();
      const claims = await claimsSince(sb, ws, 'competitor', since, 30);
      // GET-1049: one canonical name per competitor, so "Hubspot" and "HubSpot's" are one section.
      const canonical = await canonicalEntityNames(sb, ws, claims.map(c => c.value?.metadata?.market_entity_id).filter(Boolean));
      const items = [];
      for (const c of claims) {
        const a = await accountOf(sb, ws, c.entity_id, cache);
        const meta = c.value.metadata ?? {};
        items.push({ competitor: competitorKey(c.value, canonical), stance: meta.stance ?? null, account: a.name, outcome: a.outcome, said_at: c.valid_from, content: String(c.value.content).slice(0, 300) });
      }
      return { items, cursor: claims.at(-1)?.valid_from ?? null };
    },
    prompt: buildBattlecardsPrompt,
  },
  objections: {
    feature: 'living-objections',
    gather: async (sb, ws, since) => {
      const cache = new Map();
      const claims = await claimsSince(sb, ws, 'objection', since, 30);
      const items = [];
      const replies = new Map();   // GET-1052: our replies, per account
      // GET-1053: the replies the record LINKS to each objection (the reply that resolved it).
      const linked = await linkedAnswers(sb, ws, claims.map(c => c.id));
      for (const c of claims) {
        const a = await accountOf(sb, ws, c.entity_id, cache);
        const meta = c.value.metadata ?? {};
        // The answers we gave: our replies on the same account (filed on the company, or on the person
        // without one), said in the same conversation as the objection or after it.
        const key = `${a.accountId ?? ''}|${c.entity_id}`;
        if (!replies.has(key)) replies.set(key, await ourSideOn(sb, ws, [a.accountId, c.entity_id], ['our_reply']));
        // Links first; the shared-words pairing only when the record links no reply (GET-1053).
        const answeredBy = linked.get(c.id) ?? [];
        const answered = answeredBy.length ? [] : repliesFor(c, replies.get(key));
        // What the buyer did after it: their next buying signals on the same record.
        const { data: next } = await sb.from('claims').select('value, valid_from').eq('workspace_id', ws).eq('entity_id', c.entity_id).like('property', 'note.%')
          .eq('value->>category', 'buying_signal').gt('valid_from', c.valid_from).order('valid_from', { ascending: true }).limit(2);
        items.push({ account: a.name, outcome: a.outcome, status: meta.status ?? null, hardness: meta.hardness ?? null, said_at: c.valid_from, occurred: occurredLabel(meta) ?? null,
          content: String(c.value.content).slice(0, 300), answered, ...(answeredBy.length ? { answered_by: answeredBy } : {}), after: (next ?? []).map(n => String(n.value?.content ?? '').slice(0, 160)).filter(Boolean) });
      }
      return { items, cursor: claims.at(-1)?.valid_from ?? null };
    },
    prompt: buildObjectionsPrompt,
  },
};

// ── Edit, don't rewrite (GET-1054) ──────────────────────────────────────────
//
// An Intelligence file reads only what happened in the workspace: closes (deal_outcomes), claims and
// the accounts behind them (entity_list_rows). It never reads another Intelligence file, nor any
// other context file: the only file in its prompt is itself (GET-1054 point 6; SPECS.gather above
// queries none of workspace_context_files / workspace_living_files).
//
// What each file is about, and what it must keep. The section lists are the ones the whole-file
// prompts (build*Prompt) ask for, so an edit pass and the weekly rebuild agree on the shape.
const EDIT = {
  win_loss: {
    topic: (company) => `${company ? `${company}'s` : "a company's"} win/loss file: why its deals are won and lost, read before every sales call and follow-up, so it must say what to do differently, not just what happened.`,
    required: ['Win/loss', 'Why we win', 'Why we lose', 'By competitor', 'By objection', 'By segment and deal size', 'Where deals stall or slip', 'Recent closes'],
    rules: `Sections, in this order (add one with add_section, after the one before it, only when a new item gives it something): # Win/loss (one short paragraph: the overall picture, with counts won / lost so far; update the counts with replace_block), ## Why we win, ## Why we lose, ## By competitor, ## By objection, ## By segment and deal size, ## Where deals stall or slip, ## Recent closes (one list, one line per deal, newest first, at most 25: date · account · won/lost · the reason in a few words; add the new closes by replace_block on that list).
- A deal's "why:" lines are its own analysed reasons: build the drivers from them, keep their labels (the same label on several deals is one driver, with its count), and do not re-derive them from scratch.
- In Why we win and Why we lose, each point is its own paragraph (a blank line between points, not one list), and starts with a bold label of two to four words in plain business terms (e.g. **Price at scale**, **Founder-led sale**, **Security review**, **No champion**), then one short sentence. In Why we lose, put (controllable) right after the label when the team or the product could change it.
- A placeholder such as "_No closed deals read yet._" is replaced (replace_block) once there is something to say.
- A pattern needs evidence: name the accounts behind each point, and how many. One deal is an example, not a pattern; say so.
- Only what the record says. Never invent a reason; "no reason on file" is an answer. Short bullets, no filler.`,
  },
  battlecards: {
    topic: (company) => `${company ? `${company}'s` : "a company's"} battlecards: one section per competitor, read before a call where that competitor comes up. It must say how to win against each one.`,
    required: ['Battlecards'],
    rules: `# Battlecards, then one "## <Competitor>" section each, most-met first, with: what they pitch (as buyers describe it), where we met them (accounts, how many), what buyers like about them, where we won and lost against them and why, how to position against them. A competitor named two ways is one section: add to the existing one.
- Only what the mentions say, with the accounts behind each point; one account is an example, not a pattern. A tool that does not do what we sell is not a competitor: leave it out. Short bullets.`,
  },
  objections: {
    topic: (company) => `${company ? `${company}'s` : "a company's"} objection playbook, read before calls and follow-ups: the objections buyers raise, the answers that were given, and which of them moved the deal.`,
    required: ['Objection playbook'],
    rules: `# Objection playbook, then one "## <the objection, in a few words>" section each, most-heard first, with: how often and from whom (accounts), hard or soft, the answers given (only when the record shows one), what moved the deal after it, and what to say next time. The same objection said in different words is one section: add to the existing one.
- Only what the record says, with the accounts behind each point; "no answer on file" is an answer; one account is an example, not a pattern. Short bullets.`,
  },
};

/**
 * The new items exactly as the whole-file prompt lists them (header line + numbered lines), so both
 * paths read one formatter and a change to build*Prompt's item lines (GET-1052) reaches the edit
 * prompt too. Read off the whole-file prompt between its fences rather than by splitting build*Prompt,
 * which keeps this change out of those functions. Pure.
 */
export function itemsBlock(key, items, company = null) {
  const p = SPECS[key].prompt({ current: '', items, company });
  const from = p.indexOf('>>>\n\n'), to = p.indexOf('\n\nRewrite the whole file');
  if (from === -1 || to <= from) return { header: 'NEW ITEMS:', text: JSON.stringify(items, null, 1) };
  const chunk = p.slice(from + 5, to), nl = chunk.indexOf('\n');
  return { header: chunk.slice(0, nl), text: chunk.slice(nl + 1) };
}

/** What a pass read, for the version's based_on: the closes or the claims in (since, cursor]. Kept out
 *  of SPECS.gather on purpose (GET-1052 owns those); best-effort, null when it cannot be read. */
const BASED_ON = {
  win_loss: async (sb, ws, since, cursor) => {
    const { data } = await sb.from('deal_outcomes').select('id, deal_id').eq('workspace_id', ws).in('outcome', ['won', 'lost']).gt('closed_at', since).lte('closed_at', cursor).order('closed_at', { ascending: true }).limit(50);
    return { deals: (data ?? []).map(d => d.deal_id ?? d.id).filter(Boolean) };
  },
  ...Object.fromEntries([['battlecards', 'competitor'], ['objections', 'objection']].map(([key, category]) => [key, async (sb, ws, since, cursor) => {
    const { data } = await sb.from('claims').select('id, value').eq('workspace_id', ws).like('property', 'note.%').is('invalid_at', null).eq('value->>category', category)
      .gt('valid_from', since).lte('valid_from', cursor).order('valid_from', { ascending: true }).limit(50);
    return { claims: (data ?? []).filter(c => c.value?.content).map(c => c.id).filter(Boolean) };   // as claimsSince reads them
  }])),
};
async function basedOn(sb, ws, key, since, cursor) {
  try { return cursor ? await BASED_ON[key]?.(sb, ws, since, cursor) ?? null : null; } catch { return null; }
}

/**
 * The doc a pass edits (GET-1054). `stored` is the structure OpenNous last wrote (workspace_living_files.doc).
 * - none yet (first run on a file, including one with years of whole-file text): parse the body into
 *   the doc model as it stands; nothing is rewritten.
 * - the body is what the stored doc renders to: the stored doc, ids and all.
 * - the body differs (someone edited it in the app, or in the repo and it was pulled): re-parse it,
 *   keeping the ids of every block whose text is unchanged, so OpenNous builds on the hand edit.
 * -> { doc, handEdited }. Pure.
 */
export function currentDoc(stored, body) {
  const text = body ?? '';
  if (!stored?.sections) return { doc: parseDoc(text), handEdited: false };
  if (renderDoc(stored) === text) return { doc: { sections: stored.sections }, handEdited: false };
  return { doc: parseDoc(text, stored), handEdited: true };
}

/** A whole-file rebuild is due when the doc's last one is more than REBUILD_DAYS old. A doc with no
 *  timestamp (first run, or the doc column not migrated yet) is not due: the first run parses, it
 *  never rewrites, and its parse starts the clock. Pure. */
export const rebuildDue = (stored, now = new Date()) => !!stored?.rebuilt_at && now.getTime() - Date.parse(stored.rebuilt_at) > REBUILD_DAYS * 86_400_000;

/**
 * Ask for edit operations, validate, apply (GET-1054). At most two model calls:
 * - a reply with any shape error is rejected whole and asked again once, quoting the errors; a second
 *   shape error fails the pass (nothing written, cursor not moved).
 * - a good reply is applied in order to a copy of the doc. If any op was skipped (unknown id, block in
 *   another section, a required section), and no retry has been spent, it is asked again once with the
 *   reasons and the real ids, and the new reply is applied to the original doc instead. A retry that
 *   comes back malformed keeps the first result.
 * -> { ok: true, result: { doc, applied, skipped }, explicitZero } | { ok: false, error }
 */
async function requestOps({ sb, ws, spec, key, model, prompt, doc, prepare = (ops) => ops }) {
  const required = EDIT[key].required;
  const messages = [{ role: 'user', content: prompt }];
  let calls = 0;
  const ask = async () => {
    calls++;
    const msg = await model({ meter: false, feature: spec.feature, tier: 'writing', model: writingModel(), max_tokens: 6000, temperature: 0.1, accept: (t) => !parseOps(t).errors, messages: [...messages] });
    Promise.resolve(trackLlmUsage(sb, { workspaceId: ws, feature: spec.feature, model: msg?.model, usage: msg?.usage })).catch(() => {});
    const text = messageText(msg);
    messages.push({ role: 'assistant', content: text || '(empty)' });
    return parseOps(text);
  };
  let reply = await ask();
  if (reply.errors) {
    messages.push({ role: 'user', content: shapeRetryPrompt(reply.errors) });
    reply = await ask();
    if (reply.errors) return { ok: false, error: `The update could not be read (${reply.errors[0]}); it will try again.` };
  }
  // "Nothing to do" is explicit: no ops, or only ops that change nothing ("no change" skips).
  const realSkips = (r) => r.skipped.filter(x => !x.no_change);
  const zero = (ops, r) => ops.length === 0 || (!r.applied.length && !realSkips(r).length);
  // GET-1055: `prepare` turns based_on item numbers into item ids before the ops are applied.
  let result = applyOps(doc, prepare(reply.ops), { required }), explicitZero = zero(reply.ops, result);
  if (realSkips(result).length && calls < 2) {
    messages.push({ role: 'user', content: skippedRetryPrompt(realSkips(result), doc) });
    const again = await ask();
    if (!again.errors) { result = applyOps(doc, prepare(again.ops), { required }); explicitZero = zero(again.ops, result); }
  }
  return { ok: true, result, explicitZero };
}

/** Save the doc structure beside the body. Its own update, best-effort: before the doc column is
 *  migrated it fails quietly, the cursor (stamped separately) still moves, and each pass derives ids
 *  from the body instead, which is stable for every block whose text has not changed. */
const saveDoc = (sb, ws, key, doc) => Promise.resolve(sb.from('workspace_living_files').update({ doc }).eq('workspace_id', ws).eq('key', key)).then(() => {}, () => {});

/**
 * The old path, kept as the weekly drift-clearer (GET-1054): the whole file rewritten by the model
 * around the new items (build*Prompt + parseWinLoss). Its result is parsed back into the doc model
 * keeping the ids of unchanged blocks, and stored as rendered so the next pass does not mistake it
 * for a hand edit. -> { ok, body?, doc?, changelog?, error? }
 */
export async function fullRebuild(sb, { ws, spec, model, file, items, company, prior }) {
  const msg = await model({
    meter: false, feature: spec.feature, tier: 'writing', model: writingModel(), max_tokens: 8000, temperature: 0.2,
    accept: (t) => parseWinLoss(t) !== null,
    messages: [{ role: 'user', content: spec.prompt({ current: file.body ?? '', items, company }) }],
  });
  Promise.resolve(trackLlmUsage(sb, { workspaceId: ws, feature: spec.feature, model: msg?.model, usage: msg?.usage })).catch(() => {});
  const parsed = parseWinLoss(messageText(msg));
  if (!parsed) return { ok: false, error: 'The update could not be read; it will try again.' };
  const doc = parseDoc(parsed.file, prior);
  return { ok: true, doc, body: renderDoc(doc), changelog: `Weekly rebuild: ${parsed.changelog}`.slice(0, 120) };
}

/**
 * One pass of a living file for a workspace: what happened since its cursor (a few at a time), folded
 * into the file, saved as a version by OpenNous and committed.
 *
 * GET-1054: the pass edits, it does not rewrite. The model gets the file as a doc of sections and
 * blocks with ids, and only the new items; it answers with operations; code validates and applies
 * them, and writes the changelog from what was applied. Once a week (REBUILD_DAYS) the old whole-file
 * rewrite runs instead (fullRebuild) to clear drift.
 *
 * Zero applied ops: no version, no commit. The cursor moves only when the model said so explicitly
 * ({"operations": []}, or ops that change nothing): those items were read and are already in the
 * file, and reading them again every hour would cost a call for nothing. When every op it sent was
 * skipped, even after the retry, the pass failed: nothing written, the cursor stays, and the same
 * items are offered again next pass.
 *
 * GET-1055: the ops say which new items each text rests on (based_on), kept on the block as cites;
 * code writes the evidence line under each point (count, trend, newest date, one exact quote) and
 * rewrites it only when its numbers change. A cited item since retired runs a retraction pass first
 * (remove_block / replace_block only, on the blocks resting on it), even when nothing new came in;
 * each retired item is handled once (doc.cleared). No migration: cites, sources and cleared live in
 * the doc jsonb GET-1054 added.
 * -> { status: 'updated' | 'unchanged' | 'nothing_new' | 'failed', items?, changelog? }
 */
export async function runLivingFile(sb, row, { model = createMessage, now = new Date() } = {}) {
  const ws = row.workspace_id;
  const spec = SPECS[row.key];
  const title = LIVING_FILES[row.key]?.title ?? row.key;
  const since = row.cursor_at ?? new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  const stamp = (patch) => sb.from('workspace_living_files').update({ ...patch, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('workspace_id', ws).eq('key', row.key);
  try {
    if (!spec) return { status: 'failed' };
    const { data: file } = await sb.from('workspace_context_files').select('id, workspace_id, title, kind, body, visibility, document_id').eq('workspace_id', ws).eq('id', row.file_id).maybeSingle();
    if (!file) { await stamp({ enabled: false, last_error: `The ${title} file was deleted. Turn it on again to make a new one.` }); return { status: 'failed' }; }
    const stored = row.doc ?? null;
    // GET-1055: the cites a block rests on survive a hand edit by id; the sources (item -> date, quote)
    // and the ids a retraction pass already handled live beside the sections in the doc column.
    const base = carryCites(currentDoc(stored, file.body).doc, stored);
    let sources = { ...(stored?.sources ?? {}) };
    const cleared = new Set(stored?.cleared ?? []);
    let retractTries = stored?.retract_tries ?? 0;
    const cited = await citedState(sb, ws, row.key, { doc: base, fileId: file.id, cleared }).catch(() => ({ retracted: new Map(), remap: new Map(), sources: {}, legacy: [] }));
    Object.assign(sources, cited.sources);
    // The doc the model sees and edits: no evidence lines, a restated fact's cite moved to its live claim.
    let work = rewriteCites(stripDoc(base), { remap: cited.remap });
    const { items, cursor } = await spec.gather(sb, ws, since);
    if (!items.length && !cited.retracted.size) { await stamp({ last_error: null }); return { status: 'nothing_new' }; }
    const { data: w } = await sb.from('workspaces').select('name').eq('id', ws).maybeSingle();
    const company = w?.name ?? null;
    const rebuiltAt = stored?.rebuilt_at ?? now.toISOString();   // the first parse starts the weekly clock
    let rebuilt = false;

    // GET-1055: a cited item since retired: first a pass that may only remove or trim what rests on it.
    let retractLog = null;
    if (cited.retracted.size) {
      const r = await retractionPass({ sb, ws, spec, key: row.key, model, doc: work, cited, sources, company });
      // Settled: its ids leave every block's cites and are not offered again. A pass whose reply could
      // not be read is tried once more next pass, then settled as is (when in doubt, keep it).
      const settle = () => { for (const [id, x] of cited.retracted) for (const k of [id, ...(x.ids ?? [])]) cleared.add(k); work = rewriteCites(work, { drop: new Set(cited.retracted.keys()) }); retractTries = 0; };
      if (r.ok) { work = r.doc; if (r.applied.length) retractLog = `Retired facts: ${changelogOf(r.applied)}`; settle(); }
      else if (++retractTries >= 2) settle();
    }
    const keep = (doc) => ({ sections: doc.sections, rebuilt_at: rebuilt ? now.toISOString() : rebuiltAt, sources: pruneSources(doc, sources), cleared: [...cleared].slice(-500), ...(retractTries ? { retract_tries: retractTries } : {}) });

    let edited = null, editLog = null, moveCursor = false, lastError = null;
    if (items.length) {
      const refs = await itemSources(sb, ws, row.key, since, cursor, items);
      Object.assign(sources, refs.sources);
      if (rebuildDue(stored, now)) {
        const r = await fullRebuild(sb, { ws, spec, model, file: { ...file, body: renderDoc(work) }, items, company, prior: work });
        if (!r.ok) { await stamp({ last_error: r.error }); return { status: 'failed' }; }
        edited = carryCites(stripDoc(r.doc), work); editLog = r.changelog; rebuilt = true; moveCursor = true;
      } else {
        const { header, text } = itemsBlock(row.key, items, company);
        const prompt = buildEditPrompt({ topic: EDIT[row.key].topic(company), doc: work, itemsHeader: header, itemsText: text, fileRules: EDIT[row.key].rules });
        const r = await requestOps({ sb, ws, spec, key: row.key, model, prompt, doc: work, prepare: (ops) => resolveRefs(ops, refs.ids) });
        if (!r.ok) { await stamp({ last_error: r.error }); return { status: 'failed' }; }
        const same = renderDoc(stampDoc(r.result.doc, sources, now)) === renderDoc(stampDoc(work, sources, now));
        if (!r.result.applied.length || same) {
          // Ops that applied but leave the body as it was (remove and re-add) also changed nothing.
          const nothing = r.explicitZero || r.result.applied.length > 0;
          // Every op skipped, even after the retry: the pass fails and the same items are offered once
          // more. If the pass before failed the same way (its last_error says so), the cursor moves on
          // anyway: a model that, shown the real ids twice over two passes, still sends nothing that
          // applies would otherwise cost two calls an hour on the same items forever.
          const stuck = String(row.last_error ?? '').startsWith(NO_EDIT);
          if (!nothing && !stuck) {
            await stamp({ last_error: `${NO_EDIT} (${r.result.skipped.find(x => !x.no_change)?.reason ?? 'no change'}); it will try again.` });
            return { status: 'failed' };
          }
          // Already in the file (or the ops changed nothing): the cursor moves.
          moveCursor = true;
          if (!nothing) lastError = `Moved past ${items.length} item${items.length === 1 ? '' : 's'}: no edit could be applied two passes running.`;
        } else { edited = r.result.doc; editLog = changelogOf(r.result.applied); moveCursor = true; }
      }
    }

    // GET-1055: every block's evidence line recomputed from its cites. Byte-identical when the numbers
    // are, so a pass where nothing changed writes no version and makes no commit.
    const finalDoc = stampDoc(edited ?? work, sources, now);
    const body = renderDoc(finalDoc);
    const cursorPatch = moveCursor ? { cursor_at: cursor } : {};
    if (body === renderDoc(base)) {
      // No version, no commit. A hand edit re-parsed is still kept, so its ids hold next pass.
      await saveDoc(sb, ws, row.key, keep(finalDoc));
      await stamp({ ...cursorPatch, last_error: lastError });
      return items.length ? { status: 'unchanged', items: items.length } : { status: 'nothing_new' };
    }
    const changelog = ([retractLog, editLog].filter(Boolean).join('; ') || (cited.retracted.size ? `${cited.retracted.size} cited fact${cited.retracted.size === 1 ? '' : 's'} retired` : 'Evidence updated')).slice(0, 120);
    const { data: saved, error } = await sb.from('workspace_context_files').update({ body, updated_at: new Date().toISOString() })
      .eq('workspace_id', ws).eq('id', file.id).select('id, workspace_id, title, kind, body').single();
    if (error) throw error;
    // The doc and the cursor are saved right after the body, before the version and the commit: if
    // the commit fails (a repo error), the items are already in the body and must not be offered
    // again next pass as new, where they would be added twice.
    await saveDoc(sb, ws, row.key, keep(finalDoc));
    await stamp({ ...cursorPatch, last_error: lastError });
    await recordContextVersion(sb, ws, saved, { kind: 'opennous', changelog, basedOn: moveCursor ? await basedOn(sb, ws, row.key, since, cursor) : null });
    await pushContextFile(sb, ws, file.id, { who: { kind: 'opennous' }, changelog });
    return { status: 'updated', items: items.length, changelog };
  } catch (e) {
    console.warn(`[living-files] ${row.key} failed:`, ws, e?.message ?? e);
    await stamp({ last_error: String(e?.message ?? e).slice(0, 300) }).then(() => {}, () => {});
    return { status: 'failed' };
  }
}

/**
 * The retraction pass (GET-1055): one model call that may only remove_block / replace_block, on the
 * blocks resting on a retired item (or anywhere, when the retired items came from a version's
 * based_on and no block records them). Shown the retired items with why, and the items still
 * supporting each affected block. Anything else the reply asks for is refused, not applied.
 * -> { ok: true, doc, applied, refused } | { ok: false }
 */
async function retractionPass({ sb, ws, spec, key, model, doc, cited, sources, company }) {
  const retiredIds = new Set(cited.retracted.keys());
  const blocks = doc.sections.flatMap(s => s.blocks.map(b => ({ s, b })));
  const affected = blocks.filter(({ b }) => (b.cites ?? []).some(id => retiredIds.has(id)))
    .map(({ s, b }) => ({ section_id: s.id, block_id: b.id, retired: b.cites.filter(id => retiredIds.has(id)), supported: b.cites.filter(id => !retiredIds.has(id) && sources[id]) }));
  const supportedIds = [...new Set(affected.flatMap(a => a.supported))];
  const retired = [...cited.retracted.entries()].map(([id, x]) => ({ id, label: x.label ?? sources[id]?.label ?? null, why: x.why }));
  const prompt = buildRetractionPrompt({ topic: EDIT[key].topic(company), doc, retired, affected, supported: supportedIds.map(id => ({ id, label: sources[id].label ?? id })) });
  const msg = await model({ meter: false, feature: spec.feature, tier: 'writing', model: writingModel(), max_tokens: 3000, temperature: 0, accept: (t) => !parseOps(t).errors, messages: [{ role: 'user', content: prompt }] });
  Promise.resolve(trackLlmUsage(sb, { workspaceId: ws, feature: spec.feature, model: msg?.model, usage: msg?.usage })).catch(() => {});
  const reply = parseOps(messageText(msg));
  if (reply.errors) return { ok: false };
  // Scoped to the affected blocks only when every retired item is tied to one.
  const scope = cited.legacy.length ? null : new Set(affected.map(a => a.block_id));
  const { ops, refused } = restrictRetraction(reply.ops, scope);
  const r = applyOps(doc, ops, { required: EDIT[key].required });
  return { ok: true, doc: r.doc, applied: r.applied, refused };
}

/** The win/loss pass (GET-1039), as runLivingFile; `deals` is how many closes it read. */
export async function runWinLoss(sb, row, opts = {}) {
  const out = await runLivingFile(sb, { ...row, key: 'win_loss' }, opts);
  return out.status === 'updated' ? { status: out.status, deals: out.items, changelog: out.changelog } : out;
}

/**
 * The ICP is Intelligence too (GET-1044): the workspace writes who it sells to, OpenNous writes what
 * its closed deals taught underneath, as the learned block (which signals predict a win, how much,
 * and how well the score is calibrated). Rewritten only when what it says changes, as a version by
 * OpenNous and a commit. No closed deals yet, or the ICP is a linked document: nothing is written.
 * Scoring and the mirror never read the block (core workspaceIcpContext leaves it out).
 * -> { status: 'updated' | 'nothing_new' | 'no_file', changelog? }
 */
export async function refreshIcpLearned(sb, ws, { compute = computeIcpModel, now = new Date() } = {}) {
  const { data: file } = await sb.from('workspace_context_files').select('id, workspace_id, title, kind, body, document_id').eq('workspace_id', ws).eq('kind', 'icp').maybeSingle();
  if (!file || file.document_id) return { status: 'no_file' };
  const model = await compute(sb, ws);
  if (!model?.has_model || !model.has_outcomes) return { status: 'nothing_new' };
  const block = renderIcpBlock(model, { syncedAt: now.toISOString() });
  const undated = (b) => String(b ?? '').replace(/, synced \d{4}-\d{2}-\d{2}\)/, ')');
  if (undated(learnedBlockOf(file.body)) === undated(block)) return { status: 'nothing_new' };
  const { won = 0, lost = 0 } = model.calibration ?? {};
  const changelog = `Learned from ${won + lost} closed deal${won + lost === 1 ? '' : 's'}: ${won} won, ${lost} lost`;
  const { data: next, error } = await sb.from('workspace_context_files').update({ body: withLearnedBlock(file.body ?? '', block), updated_at: now.toISOString() })
    .eq('workspace_id', ws).eq('id', file.id).select('id, workspace_id, title, kind, body').single();
  if (error) throw error;
  await recordContextVersion(sb, ws, next, { kind: 'opennous', changelog });
  await pushContextFile(sb, ws, file.id, { who: { kind: 'opennous' }, changelog });
  return { status: 'updated', changelog };
}

/** The hourly pass: every living file turned on, in every workspace, then each workspace's ICP. */
export async function runLivingFiles(sb, opts = {}) {
  const { data, error } = await sb.from('workspace_living_files').select('*').eq('enabled', true);
  if (error) { if (missing(error)) return { files: 0, updated: 0 }; throw error; }
  let updated = 0;
  const rows = (data ?? []).filter(r => !LIVING_FILES[r.key]?.hidden);
  for (const row of rows) {
    // GET-1077: a few closes analysed first (why won / why lost per deal), so the pass reads them analysed.
    if (row.key === 'win_loss') {
      try { await analyzeClosedDeals(sb, row.workspace_id, { cursor: row.cursor_at, ...(opts.model ? { model: opts.model } : {}) }); }
      catch (e) { console.warn('[living-files] deal why failed:', row.workspace_id, e?.message ?? e); }
    }
    if ((await runLivingFile(sb, row, opts.model ? { model: opts.model } : {})).status === 'updated') updated++;
  }
  const { data: icps } = await sb.from('workspace_context_files').select('workspace_id').eq('kind', 'icp');
  for (const { workspace_id } of icps ?? []) {
    try { if ((await refreshIcpLearned(sb, workspace_id, opts)).status === 'updated') updated++; }
    catch (e) { console.warn('[living-files] icp failed:', workspace_id, e?.message ?? e); }
  }
  return { files: rows.length + (icps ?? []).length, updated };
}
