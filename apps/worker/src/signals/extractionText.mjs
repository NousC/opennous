// What the fact extractor reads, and how its facts are worded. Three failures from the
// GET-185 model comparison, each fixed here in one place so the live path, the repair
// sweep, the backfill and the eval harness cannot drift apart:
//
// 1. Long meetings lost their substance. Every model returned nothing on an hour-long
//    call because the text it was handed was the first 12,000 characters — small talk.
//    The stored activity summary is cut at 12,000 and live ingest stopped at 60,000, while
//    the full transcript (several times that, for that call) sits in the meeting's notes
//    document. loadSourceText() reads the full text; splitForExtraction() hands it to the
//    model in parts it can actually attend to, with the call summary as context.
//
// 2. "The user" and "us" ended up in facts. In a shared workspace "found the user through
//    his post" names nobody. loadOurSide() resolves which teammate the conversation belongs
//    to, so the prompt can ask for the name — and tidyFactContent() swaps in the name when
//    a model writes "the user" anyway.
//
// 3. Models added their own reading ("…, indicating a positive vendor relationship").
//    The prompt forbids it; tidyFactContent() cuts the clause when a model does it anyway.
//    A prompt rule a model can ignore is not a rule on its own.

// ── 1. long text ─────────────────────────────────────────────────────────────

// The separator saveDocument() callers put between a meeting's AI digest and its transcript
// (fireflies.mjs, granola.mjs).
const TRANSCRIPT_SEPARATOR = '———— Transcript ————';

// One part is sized so a reasoning model reads all of it closely and still has room to answer:
// ~3.5k tokens of transcript. A 60-minute call is ~60,000 characters, so ~5 parts.
// 14,000, down from 24,000 (2026-10-08): with the routing rules and the positions on file in the
// prompt, a 24,000-character part came back empty from the primary model and its fallback on the
// longest calls (finish: length) — 5 of 12 test-set calls lost a part. Shorter reads, same overlap.
export const PART_CHARS = 14_000;
export const PART_OVERLAP = 1_500;      // a fact said across a boundary is still read whole once
const CONTEXT_CHARS = 4_000;     // the call summary shown alongside every part

/**
 * Split extraction text into the parts the model reads.
 * Short text comes back as ONE part, unchanged — nothing about a DM or a short call moves.
 * Long text is cut at line boundaries (a transcript line is one speaker turn) with overlap.
 * A meeting-notes document's digest (the text before the transcript separator) is returned
 * as `context`: every part carries it so the model knows what the call is about, and no
 * part extracts from it — its content is in the transcript the parts cover.
 *
 * @returns {{ context: string|null, parts: string[] }}
 */
/**
 * A chunk the model could not answer, cut in two at a turn boundary (GET-415).
 *
 * A reasoning model given a 24k-character chunk sometimes spends its whole budget thinking and
 * returns nothing — `finish: length`, empty text — and the fallback model does the same on the
 * same input. An early Fellow backfill batch lost the facts of a few chunks
 * that way. Half the input is a different problem for the model, not the same one
 * retried, and the two halves overlap by a turn so a fact straddling the cut is not lost.
 * Below `minChars` there is nothing left to halve; the caller records the loss.
 */
export function halveForRetry(text, { minChars = 6_000, overlap = PART_OVERLAP } = {}) {
  const full = String(text ?? '');
  if (full.length < minChars) return null;
  const mid = Math.floor(full.length / 2);
  const nl = full.lastIndexOf('\n', mid);
  const cut = nl > full.length / 4 ? nl + 1 : mid;
  return [full.slice(0, cut), full.slice(Math.max(0, cut - overlap))];
}

export function splitForExtraction(text, { partChars = PART_CHARS, overlap = PART_OVERLAP } = {}) {
  const full = String(text ?? '');
  if (full.length <= partChars) return { context: null, parts: [full] };

  let context = null, body = full;
  const sep = full.indexOf(TRANSCRIPT_SEPARATOR);
  if (sep !== -1) {
    context = full.slice(0, sep).trim().slice(0, CONTEXT_CHARS) || null;
    body = full.slice(sep + TRANSCRIPT_SEPARATOR.length).trim();
    if (body.length <= partChars) return { context: null, parts: [full] };
  }

  const parts = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(body.length, start + partChars);
    if (end < body.length) {
      const nl = body.lastIndexOf('\n', end);
      if (nl > start + partChars / 2) end = nl;   // cut on a turn boundary when one is near
    }
    parts.push(body.slice(start, end).trim());
    if (end >= body.length) break;
    const next = end - overlap;
    const nl = body.indexOf('\n', next);
    start = nl !== -1 && nl < end ? nl + 1 : next;
  }
  return { context, parts: parts.filter(Boolean) };
}

// Message ingest keeps three copies of one message at three lengths: a 200-character
// `summary` (the timeline line), a 500-character `description`, and the full text in
// `raw.text` where the handler kept it. Live extraction read the summary, so a large share of
// inbound LinkedIn and email messages in our own workspace were extracted from their first 200
// characters. Every reader goes through this.
const OUTBOUND_PREFIX = /^You:\s*/;

/**
 * The fullest text an activity carries: raw text, description or summary, whichever is longest.
 * The description only counts when it is the same message at more length. For email and
 * meetings it is the subject or title ("Re: Networking call"), and a short reply must not be
 * swapped for its subject line.
 */
export function activityText({ summary = null, description = null, raw = null } = {}) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.replace(OUTBOUND_PREFIX, '') : null);
  const s = clean(summary), d = clean(description), r = clean(raw?.text);
  const sameMessage = d && (!s || d.startsWith(s.slice(0, 40)));
  return [r, sameMessage ? d : null, s]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * The fullest text we hold for an activity observation.
 * A message's raw text or description holds more of it than its summary. A meeting's summary field is
 * a 12,000-character cut when the note-taker had no digest; the notes document saved at
 * ingest holds the digest plus the whole transcript. Anything
 * that re-reads a meeting (repair, backfill, eval) must read that, never the summary.
 *
 * @param obs an observations row: { workspace_id, property, source, raw, value }
 */
export async function loadSourceText(supabase, obs) {
  const stored = activityText({ summary: obs?.value?.summary, description: obs?.value?.description, raw: obs?.raw });
  const meetingId = obs?.raw?.meeting_id;
  if (!String(obs?.property ?? '').endsWith('meeting_held') || !meetingId || !obs?.source) return stored;

  const { data: docs } = await supabase.from('claims')
    .select('value')
    .eq('workspace_id', obs.workspace_id)
    .like('property', 'note.%')
    .is('invalid_at', null)
    .eq('value->metadata->>source_ref', `source://${obs.source}/${meetingId}`)
    .limit(10);
  const longest = (docs ?? [])
    .map(d => String(d.value?.content ?? ''))
    .sort((a, b) => b.length - a.length)[0];
  return longest && longest.length > (stored?.length ?? 0) ? longest : stored;
}

// ── 2. naming our side ───────────────────────────────────────────────────────

const TEAM_TTL_MS = 10 * 60_000;
const teamCache = new Map();   // workspaceId -> { at, companyName, members: [{ id, name }] }

async function loadTeam(supabase, workspaceId) {
  const hit = teamCache.get(workspaceId);
  if (hit && Date.now() - hit.at < TEAM_TTL_MS) return hit;
  const [{ data: ws }, { data: members }, { data: positioning }] = await Promise.all([
    supabase.from('workspaces').select('name').eq('id', workspaceId).maybeSingle(),
    supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId).limit(50),
    supabase.from('foundations').select('body_md').eq('workspace_id', workspaceId).eq('kind', 'positioning').maybeSingle(),
  ]);
  const ids = (members ?? []).map(m => m.user_id).filter(Boolean);
  const { data: users } = ids.length
    ? await supabase.from('users').select('id, name, email').in('id', ids)
    : { data: [] };
  const team = {
    at: Date.now(),
    companyName: ws?.name?.trim() || null,
    members: (users ?? []).map(u => ({ id: u.id, name: u.name?.trim() || null, email: u.email?.trim() || null })).filter(u => u.name),
    offer: offerExcerpt(positioning?.body_md),
  };
  teamCache.set(workspaceId, team);
  return team;
}

/**
 * What the workspace sells, in its own words: the opening of its Positioning foundation, as plain
 * text. It is what lets extraction tell a competitor of OURS from a tool in the prospect's stack
 * (GET-252) without anyone keeping a competitor list — every workspace describes itself.
 */
export function offerExcerpt(markdown, max = 900) {
  const text = String(markdown ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ')        // headings name sections, they don't describe the product
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 60) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut) + ' …';
}

/**
 * The prompt block that says what our side sells, so "competitor" means a competitor of US.
 * Empty when the workspace has no positioning yet.
 */
export function ourOfferBlock(ourSide) {
  if (!ourSide?.offer) return '';
  const who = ourSide.companyName || 'our company';
  return `WHAT ${who.toUpperCase()} SELLS (its own positioning — decide competitor vs status_quo against THIS):\n${ourSide.offer}\n\n`;
}

/**
 * Who "our side" of a conversation is.
 * The activity's owner when it is stamped (most LinkedIn messages and email are). When it
 * is not (most meetings are not), the one teammate who speaks in the transcript. Otherwise
 * the team, by company name — never "the user".
 *
 * @returns {{ ownerName: string|null, teamNames: string[], companyName: string|null, offer: string|null }}
 */
export async function loadOurSide(supabase, workspaceId, { activityId = null, text = null } = {}) {
  try {
    const team = await loadTeam(supabase, workspaceId);
    let owner = null;
    let crmOwner = null;
    if (activityId) {
      const { data: obs } = await supabase.from('observations')
        .select('owner_user_id, raw').eq('id', activityId).maybeSingle();
      owner = team.members.find(m => m.id === obs?.owner_user_id) ?? null;
      // The CRM's owner of the email, when they have no seat here. A client's team works the
      // inbox without logging in (one customer's reps hold no seats at all), and HubSpot names who sent
      // it on every message — hundreds of one customer's email tasks were written with no owner because
      // only seats were looked for.
      const raw = obs?.raw ?? {};
      const email = String(raw.owner_email || (raw.direction === 'EMAIL' ? raw.from : '') || '').trim().toLowerCase();
      if (!owner && email.includes('@')) crmOwner = { email, name: raw.owner_name || null };
    }
    let ownerName = owner?.name ?? crmOwner?.name ?? null;
    if (!ownerName && text) {
      ownerName = soleTeamSpeaker(text, team.members.map(m => m.name));
      owner = team.members.find(m => m.name === ownerName) ?? owner;
    }
    // The email and the id as well as the name. The lookup already had the member row and threw
    // the rest away, so a caller that needed to ASSIGN the work — not merely name it in a prompt —
    // had nothing to assign it to, and hundreds of tasks were written with a null owner.
    return {
      ownerName, ownerEmail: owner?.email ?? crmOwner?.email ?? null, ownerUserId: owner?.id ?? null,
      teamNames: team.members.map(m => m.name), companyName: team.companyName, offer: team.offer ?? null,
    };
  } catch {
    return { ownerName: null, teamNames: [], companyName: null, offer: null };
  }
}

/** The one teammate who speaks in a transcript ("Theo Bramwell: …"), or null. */
export function soleTeamSpeaker(text, teamNames) {
  const speakers = new Set();
  for (const m of String(text).matchAll(/^([^:\n]{2,60}):/gm)) speakers.add(m[1].trim().toLowerCase());
  const hits = teamNames.filter(n => {
    const first = n.split(/\s+/)[0].toLowerCase();
    return [...speakers].some(s => s === n.toLowerCase() || s.split(/\s+/)[0] === first);
  });
  return hits.length === 1 ? hits[0] : null;
}

/** How a fact refers to our side: the teammate's name, else "the <Company> team". */
export function ourSideLabel(ourSide) {
  if (ourSide?.ownerName) return ourSide.ownerName;
  if (ourSide?.companyName) return `the ${ourSide.companyName} team`;
  return 'our team';
}

/** Our side by name, quoted for a prompt: the teammates and the workspace's company (GET-761).
 *  Prompts that must keep our own people out of the account's world list these rather than a
 *  hardcoded name. Empty string when nothing is known. */
export function ourSideNamesList(ourSide) {
  const names = [...new Set([...(ourSide?.teamNames ?? []), ourSide?.companyName].map(n => String(n ?? '').trim()).filter(Boolean))];
  return names.map(n => JSON.stringify(n)).join(', ');
}

/** The prompt rule that asks for names, not "the user". */
export function ourSideRule(ourSide) {
  const label = ourSideLabel(ourSide);
  const banned = '"the user", "us", "we", "our" or "you"';
  if (ourSide?.ownerName) {
    return `When a fact involves our side of the conversation, name ${label} — never ${banned}. Example: "found ${label} through a LinkedIn post", not "found us through a post".`;
  }
  const team = ourSide?.teamNames?.length ? ` (${ourSide.teamNames.join(', ')})` : '';
  return `When a fact involves our side of the conversation, name the teammate involved if the text makes it clear${team}; otherwise write "${label}" — never ${banned}.`;
}

// ── 3. wording ───────────────────────────────────────────────────────────────

// A clause that reads the fact instead of stating it. Comma-led, so an action ("advised
// renaming, suggesting three names") is kept and an interpretation (", indicating…") is cut.
const INTERPRETATION = /,\s*(?:indicating|signall?ing|implying|which (?:shows|suggests|indicates|implies|means|signals)|meaning(?: that)?|suggesting that)\b[^.;]*|\s*,?\s*as evidenced by\b[^.;]*/gi;

/**
 * Enforce the two wording rules the prompt asks for, for when a model ignores them:
 * cut interpretive clauses, and name our side instead of "the user".
 */
export function tidyFactContent(content, ourSide = null) {
  let out = String(content ?? '');
  out = out.replace(INTERPRETATION, '');
  const label = ourSideLabel(ourSide);
  out = out.replace(/\bthe user's\b/gi, `${label}'s`).replace(/\bthe user\b/gi, label);
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
  if (out && !/[.!?"')\]]$/.test(out)) out += '.';
  return out;
}

// ── 4. attribution ───────────────────────────────────────────────────────────

const SAYS = '(?:says|said|explains|explained|notes|noted|mentions|mentioned|states|stated|reports|reported|shares|shared|adds|added|told us)';
const WANTS = '(?:wants|wanted|plans|planned|needs|expects|hopes|would like|is looking|is trying|prefers|asked)';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The fact first, without "Hollis Vane says Quillmere's …" in front of it (GET-962). Pure.
 *
 * Who said it is stored beside the claim (metadata.speaker, the source), so the sentence repeated it
 * and buried the fact. The subject guard has already checked the model's sentence named who the fact
 * is about; this runs after it, on what is stored:
 *   - a COMPANY fact loses the speaker, a "says", and the company's own name in front: it sits on the
 *     company's record, so "Lead generation is not very strong." says all of it;
 *   - a PERSON fact keeps the person as its subject (the claim_does_not_name_its_subject invariant
 *     reads it) and loses only the "says … he": "Hollis Vane would not have more than three users."
 * Anything else, or a fact with no known names, is left as written.
 */
export function factWording(content, { about = 'person', subjectName = null, companyName = null } = {}) {
  let s = String(content ?? '').trim();
  const subject = String(subjectName ?? '').trim();
  if (!s || !subject) return s;
  const name = `(${escapeRe(subject)}|${escapeRe(subject.split(/\s+/)[0])})`;
  const company = String(companyName ?? '').trim();
  const co = company ? escapeRe(company) : null;

  if (about !== 'company') {
    // "Hollis Vane says he would …" → "Hollis Vane would …". Without a pronoun to fold in, the
    // sentence keeps its "says": dropping it would leave the fact about someone else.
    return s.replace(new RegExp(`^${name}\\s+${SAYS}(?:\\s+that)?\\s+(?:he|she|they)\\s+`), '$1 ');
  }
  const before = s;
  if (co) s = s.replace(new RegExp(`^${name}['’]s company\\s+(?:\\(${co}\\)|${co})(?:['’]s)?\\s+`), '');
  const said = s.match(new RegExp(`^${name}\\s+${SAYS}(?:\\s+that)?\\s+(?:(?:he|she|they)\\s+)?`));
  if (said) {
    const rest = s.slice(said[0].length).replace(/^(?:his|her)\s+/i, '');
    // "… says the outcome he wants is …": the rest still points at the person, so it keeps them.
    if (/\b(?:he|she|his|her|him)\b/i.test(rest)) return before;
    s = rest;
  }
  // "Hollis Vane wants to …" on the company's record: the want is the fact. Not "Hollis Vane is
  // pushing …", which without its subject reads as a fragment.
  s = s.replace(new RegExp(`^${name}\\s+(?=${WANTS}\\b)`), '');
  if (co) s = s.replace(new RegExp(`^${co}['’]s\\s+`), '');
  return s === before ? s : capitalise(s);
}
