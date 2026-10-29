// Why a deal was won or lost, in a few labelled points (GET-1077).
//
// Each closed deal is read once: its close record (the dated evidence, GET-405), what the buyer said
// while it was live, what we said, and the CRM's reason. The model answers with one to four points,
// each a short business label and one line ("Price at scale: above existing Gong spend at 40 seats").
// The answer is kept on the deal as `deal.close_why` and never rewritten, like the record.
//
// One read, three places: the deal card shows it, the win/loss page's closed deals show it, and the
// win/loss file reads it instead of the raw notes, so its drivers are counts of the same labels.
//
// Runs in the hourly Intelligence pass for workspaces with win/loss on, a few deals a pass: first the
// closes the file is about to read (so it reads them analysed), then the newest without one, back
// 180 days. A deal nothing explains gets an empty list, so it is not asked about again.
import { CLOSE_RECORD_PROPERTY, CLOSE_WHY_PROPERTY, assertClaims, writingModel, occurredLabel } from '@nous/core';
import { createMessage, messageText } from './llm.mjs';
import { trackLlmUsage } from './llmUsage.mjs';
import { ourSideOn, saidLines } from './livingOurSide.mjs';

const DAY = 86_400_000;
export const WHY_DAYS = 180;
const PER_PASS = 8;
const NOTES = 15;
const WHY = ['objection', 'competitor', 'blocker', 'buying_signal', 'risk_signal', 'budget', 'timeline', 'authority', 'requirement', 'pain', 'goal'];
const day = (ts) => String(ts ?? '').slice(0, 10);

/** The prompt for one closed deal. Pure. */
export function buildDealWhyPrompt({ outcome, account, segment = null, value = null, closedAt, repReason = null, events = [], notes = [], said = [], company = null }) {
  const won = outcome === 'won';
  const ev = events.length ? events.map(e => `- ${day(e.at)} [${e.kind}] ${e.text}${e.quote ? ` ("${String(e.quote).slice(0, 200)}")` : ''}`).join('\n') : '- (none recorded)';
  const nt = notes.length ? notes.map(n => `- [${n.category}] ${n.content}${n.occurred ? ` (happened ${n.occurred})` : ''}`).join('\n') : '- (nothing on file)';
  const sd = said.length ? `\nWHAT WE SAID (our side, not the buyer's):\n${said.map(l => `- ${l}`).join('\n')}\n` : '';
  return `You write why ${company ? `${company}'s` : 'a'} deal was ${won ? 'won' : 'lost'}, for the deal card and the win/loss file. A sales leader scans it in five seconds.

DEAL: ${won ? 'WON' : 'LOST'} · ${account ?? 'An account'} · closed ${day(closedAt)}${value ? ` · $${Math.round(value).toLocaleString('en-US')}` : ''}${segment ? ` · ${segment}` : ''}
CRM REASON (the rep's own word, testimony, not the finding): ${repReason ?? '(none)'}

THE RECORD WHILE IT WAS LIVE (dated evidence):
${ev}

WHAT THE BUYER SAID:
${nt}
${sd}
Write one to four points on why it was ${won ? 'won' : 'lost'}, most important first.
- label: two to four words, plain business terms a VP Sales uses, e.g. "Price at scale", "Security review", "No champion", "Incumbent CRM AI", "Founder-led sale", "Time to value", "CRM-native".
- text: one line, under 15 words, specific to this deal (who, what, how much). No storytelling.
- Only what the record says. If nothing explains it, return an empty list.

Answer with ONLY a JSON object: {"why": [{"label": "...", "text": "..."}]}`;
}

/** The model's answer -> [{ label, text }] (at most four), or null when it is not that shape. Pure. */
export function parseDealWhy(text) {
  const raw = String(text ?? '');
  const m = raw.indexOf('{'), n = raw.lastIndexOf('}');
  if (m === -1 || n <= m) return null;
  let j;
  try { j = JSON.parse(raw.slice(m, n + 1)); } catch { return null; }
  if (!Array.isArray(j?.why)) return null;
  return j.why
    .map(x => ({ label: String(x?.label ?? '').replace(/\*\*/g, '').trim().slice(0, 40), text: String(x?.text ?? '').replace(/\*\*/g, '').trim().slice(0, 200) }))
    .filter(x => x.label)
    .slice(0, 4);
}

/** The why of each deal id that has one: Map(deal_id -> { why, ... }). */
export async function readDealWhy(sb, ws, dealIds) {
  const out = new Map();
  const ids = [...new Set(dealIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('claims').select('entity_id, value').eq('workspace_id', ws).eq('property', CLOSE_WHY_PROPERTY).is('invalid_at', null).in('entity_id', ids.slice(i, i + 200));
    for (const r of data ?? []) if (Array.isArray(r.value?.why)) out.set(r.entity_id, r.value);
  }
  return out;
}

/** What the buyer said on the account and its people while the deal was live. */
async function notesFor(sb, ws, d) {
  const { data: people } = await sb.from('entity_list_rows').select('entity_id').eq('workspace_id', ws).eq('kind', 'person').eq('company_id', d.entity_id).limit(50);
  const from = new Date((Date.parse(d.opened_at ?? d.closed_at) || Date.parse(d.closed_at)) - 30 * DAY).toISOString();
  const to = new Date(Date.parse(d.closed_at) + DAY).toISOString();
  const { data } = await sb.from('claims').select('value, valid_from').eq('workspace_id', ws).in('entity_id', [d.entity_id, ...(people ?? []).map(p => p.entity_id)])
    .like('property', 'note.%').is('invalid_at', null).is('value->metadata->>side', null)
    .gte('valid_from', from).lte('valid_from', to).order('valid_from', { ascending: false }).limit(200);
  return (data ?? []).map(c => c.value ?? {}).filter(v => WHY.includes(v.category) && v.content).slice(0, NOTES)
    .map(v => ({ category: v.category, content: String(v.content).slice(0, 300), ...(occurredLabel(v.metadata) ? { occurred: occurredLabel(v.metadata) } : {}) }));
}

/**
 * Analyse up to `limit` closed deals without a why: those after `cursor` first (oldest first, the
 * order the win/loss file reads them), then the newest. -> { written, failed }
 */
export async function analyzeClosedDeals(sb, ws, { cursor = null, limit = PER_PASS, model = createMessage, now = new Date(), company = null, write = assertClaims } = {}) {
  const since = new Date(now.getTime() - WHY_DAYS * DAY).toISOString();
  const { data: rows, error } = await sb.from('deal_outcomes').select('entity_id, deal_id, outcome, opened_at, closed_at, value_usd')
    .eq('workspace_id', ws).in('outcome', ['won', 'lost']).not('deal_id', 'is', null).gt('closed_at', since)
    .order('closed_at', { ascending: false }).limit(1000);
  if (error) throw error;
  const have = await readDealWhy(sb, ws, (rows ?? []).map(r => r.deal_id));
  const open = (rows ?? []).filter(r => r.deal_id && !have.has(r.deal_id));
  const next = cursor ? open.filter(r => r.closed_at > cursor).sort((a, b) => a.closed_at.localeCompare(b.closed_at)) : [];
  const todo = [...new Map([...next, ...open].map(r => [r.deal_id, r])).values()].slice(0, limit);

  let written = 0, failed = 0;
  for (const d of todo) {
    try {
      const [{ data: acct }, { data: rec }] = await Promise.all([
        sb.from('entity_list_rows').select('name, industry').eq('workspace_id', ws).eq('entity_id', d.entity_id).maybeSingle(),
        sb.from('claims').select('value').eq('workspace_id', ws).eq('entity_id', d.deal_id).eq('property', CLOSE_RECORD_PROPERTY).is('invalid_at', null).maybeSingle(),
      ]);
      const record = rec?.value && Array.isArray(rec.value.events) ? rec.value : null;
      const prompt = buildDealWhyPrompt({
        outcome: d.outcome, account: acct?.name ?? null, segment: acct?.industry ?? null, value: d.value_usd ?? null, closedAt: d.closed_at,
        repReason: record?.rep_reason ?? null, events: (record?.events ?? []).slice(-12),
        notes: await notesFor(sb, ws, d), said: saidLines(await ourSideOn(sb, ws, [d.entity_id], ['pitch_line', 'our_commitment'])), company,
      });
      const msg = await model({ meter: false, feature: 'deal-why', tier: 'writing', model: writingModel(), max_tokens: 600, temperature: 0, accept: (t) => parseDealWhy(t) !== null, messages: [{ role: 'user', content: prompt }] });
      // Usage is metered beside the work and never fails it.
      Promise.resolve().then(() => trackLlmUsage(sb, { workspaceId: ws, feature: 'deal-why', model: msg?.model, usage: msg?.usage })).catch(() => {});
      const why = parseDealWhy(messageText(msg));
      if (!why) { failed++; continue; }   // an unreadable answer: asked again next pass
      await write(sb, ws, d.deal_id, { values: { [CLOSE_WHY_PROPERTY]: { outcome: d.outcome, closed_at: d.closed_at, why, written_at: now.toISOString() } } });
      written++;
    } catch (e) {
      failed++;
      console.warn('[deal-why] failed:', ws, d.deal_id, e?.message ?? e);
    }
  }
  return { written, failed };
}
