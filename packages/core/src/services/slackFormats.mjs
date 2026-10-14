// Slack layouts for automation output (GET-858). A Slack step (or a RevBox job's box delivery to
// Slack) can name a layout in `config.format`: a report reads differently from an approval, an
// alert or a handoff. The AI step before it then writes structured JSON for that layout instead of
// prose, and the Slack step hands the JSON to the poster, which renders it as Block Kit.
//
// This file is the public half: the layout names, what the AI is told to write for each, the
// parse that checks what came back, and a plain-text version of it (what a document, an email
// destination or Slack's notification line reads). Block Kit itself is Cloud's
// (cloud/lib/slackBlocks.mjs), behind the registered `slack` step handler. Pure: no I/O.

/** The layouts a Slack step can use. `plain` is today's message: mrkdwn text, no blocks. */
export const SLACK_FORMATS = ['report', 'approval', 'alert', 'handoff', 'notification', 'digest', 'plain'];

/** A step config's format, or null when unset or unknown (an unknown one posts as before). */
export function slackFormatOf(v) {
  const f = String(v ?? '').trim().toLowerCase();
  return SLACK_FORMATS.includes(f) ? f : null;
}

/** True when the format renders as blocks (anything but plain or none). */
export const structuredSlackFormat = (v) => { const f = slackFormatOf(v); return !!f && f !== 'plain'; };

// What the AI writes for each layout: a JSON object, nothing around it. Kept short; the model reads
// it on every run. Every field is plain text with Slack's *bold*; no markdown headings.
const SHAPES = {
  report: `{
  "title": "short title, under 80 characters",
  "period": "the date or period it covers, e.g. 13 Oct 2026 or Week 41",
  "source": "where the numbers come from, e.g. HubSpot",
  "summary": "one paragraph: the headline numbers and how they moved",
  "sections": [{ "heading": "short heading", "body": "a few lines; \\"•\\" bullets allowed" }],
  "table": { "columns": ["Name", "Value", "Change"], "rows": [["Acme", "12", "+3"]] },
  "flags": [{ "level": "red" | "green", "text": "one line: what needs attention, or what went well" }]
}
"sections", "table" and "flags" are optional. Use a table for rows of numbers (at most 20 rows, 5 columns).`,
  // A summary only (pre-ship finding 2): the card lists the actions themselves from the run, and its
  // buttons are always Approve / Deny. What is written here shows as "Summary (AI-written)".
  approval: `{
  "title": "what is being approved, under 80 characters",
  "fields": [{ "label": "Who" | "What" | "When" | ..., "value": "short" }],
  "body": "two or three sentences: why this is worth approving"
}
At most 6 fields.`,
  alert: `{
  "title": "what happened, under 80 characters",
  "severity": "warning" | "critical",
  "what_happened": "one or two sentences",
  "impact": "what it puts at risk (optional)",
  "suggested_action": "the one thing to do next (optional)",
  "account": "the account name, if it is about one (optional)"
}`,
  handoff: `{
  "account": "the account name",
  "owner": "who owns it now", "deal": "deal name", "value": "e.g. $48,000 ARR", "close_date": "e.g. 12 Oct 2026", "champion": "name and role",
  "why_they_bought": "a few lines",
  "promised": "what we promised, \\"•\\" bullets",
  "risks": "the risks to watch, \\"•\\" bullets",
  "next_steps": "the next steps, \\"•\\" bullets"
}
Leave out a field you have no data for.`,
  notification: `{
  "text": "one or two sentences: what happened",
  "context": "one short line of context, e.g. the account and when (optional)"
}`,
  digest: `{
  "title": "short title",
  "intro": "one line (optional)",
  "groups": [{ "heading": "group name (optional)", "items": [{ "name": "account name", "status": "one line: where it stands or what changed" }] }]
}
At most 15 items in all, the most important first.`,
};

/**
 * The instruction appended to the AI step's system prompt when the Slack step after it has a
 * layout. Null for plain or no format (the step writes prose as before).
 */
export function slackFormatInstruction(format) {
  const f = slackFormatOf(format);
  if (!f || f === 'plain') return null;
  return `It is posted in Slack as a ${f} layout. Answer with ONE JSON object in exactly this shape, and nothing else (no prose, no code fence):

${SHAPES[f]}

Rules for the JSON: use only the data given, never invent a number, a name or a link. Text fields may use Slack's *bold* (single asterisks) and "•" bullets; no markdown headings, no links.`;
}

const s = (v, n = 3000) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, n) : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The first JSON object in a model's answer (bare, fenced, or with words around it), or null. */
export function extractJsonObject(raw) {
  const t = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { const v = JSON.parse(t); return isObj(v) ? v : null; } catch { /* look inside */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(t.slice(a, b + 1)); return isObj(v) ? v : null; } catch { return null; }
}

/** The content cleaned to its layout's shape (unknown keys dropped, types fixed), or null when unusable. */
export function normalizeSlackContent(format, c) {
  const f = slackFormatOf(format);
  if (!f || f === 'plain' || !isObj(c)) return null;
  switch (f) {
    case 'report': {
      const out = {
        title: s(c.title, 150), period: s(c.period, 120), source: s(c.source, 120), summary: s(c.summary),
        sections: arr(c.sections).filter(isObj).map(x => ({ heading: s(x.heading, 150), body: s(x.body) })).filter(x => x.heading || x.body),
        flags: arr(c.flags).filter(isObj).map(x => ({ level: x.level === 'green' ? 'green' : 'red', text: s(x.text, 500) })).filter(x => x.text),
      };
      if (isObj(c.table)) {
        const columns = arr(c.table.columns).map(x => s(x, 60));
        const rows = arr(c.table.rows).filter(Array.isArray).map(r => r.map(x => s(x, 120)));
        if (columns.length && rows.length) out.table = { columns, rows };
      }
      return out.title || out.summary ? out : null;
    }
    case 'approval': {
      // No button labels: the card's buttons are fixed (pre-ship finding 2).
      const out = { title: s(c.title, 150), fields: arr(c.fields).filter(isObj).map(x => ({ label: s(x.label, 60), value: s(x.value, 500) })).filter(x => x.label && x.value), body: s(c.body) };
      return out.title || out.body ? out : null;
    }
    case 'alert': {
      const out = { title: s(c.title, 150), severity: c.severity === 'critical' ? 'critical' : 'warning', what_happened: s(c.what_happened), impact: s(c.impact), suggested_action: s(c.suggested_action), account: s(c.account, 150) };
      return out.title || out.what_happened ? out : null;
    }
    case 'handoff': {
      const keys = ['owner', 'deal', 'value', 'close_date', 'champion'];
      const out = { account: s(c.account, 150) };
      for (const k of keys) out[k] = s(c[k], 300);
      for (const k of ['why_they_bought', 'promised', 'risks', 'next_steps']) out[k] = Array.isArray(c[k]) ? c[k].map(x => `• ${s(x, 500)}`).join('\n') : s(c[k]);
      return out.account ? out : null;
    }
    case 'notification': {
      const out = { text: s(c.text), context: s(c.context, 300) };
      return out.text ? out : null;
    }
    case 'digest': {
      const item = (x) => (isObj(x) ? { name: s(x.name, 150), status: s(x.status, 500) } : null);
      const groups = arr(c.groups).filter(isObj).map(g => ({ heading: s(g.heading, 150), items: arr(g.items).map(item).filter(x => x?.name) })).filter(g => g.items.length);
      if (!groups.length && arr(c.items).length) groups.push({ heading: '', items: arr(c.items).map(item).filter(x => x?.name) });
      const out = { title: s(c.title, 150), intro: s(c.intro, 500), groups: groups.filter(g => g.items.length) };
      return out.groups.length ? out : null;
    }
    default: return null;
  }
}

/** The content as plain text (Slack's *bold*, "•" bullets): the document, an email, Slack's notification line. */
export function slackContentText(format, c) {
  const f = slackFormatOf(format);
  if (!c) return '';
  const lines = [];
  const add = (...xs) => { for (const x of xs) if (x) lines.push(x); };
  switch (f) {
    case 'report':
      add(c.title && `*${c.title}*`, [c.period, c.source].filter(Boolean).join(' · '), c.summary);
      for (const x of c.sections ?? []) add('', x.heading && `*${x.heading}*`, x.body);
      if (c.table) add('', c.table.columns.join(' | '), ...c.table.rows.map(r => r.join(' | ')));
      if (c.flags?.length) add('', '*Flags*', ...c.flags.map(x => `${x.level === 'green' ? '🟢' : '🔴'} ${x.text}`));
      break;
    case 'approval':
      add(c.title && `*${c.title}*`, ...(c.fields ?? []).map(x => `*${x.label}:* ${x.value}`), c.body);
      break;
    case 'alert':
      add(`${c.severity === 'critical' ? '🔴' : '⚠️'} *${c.title || 'Alert'}*`, c.account && `Account: ${c.account}`, c.what_happened, c.impact && `*Impact:* ${c.impact}`, c.suggested_action && `*Suggested action:* ${c.suggested_action}`);
      break;
    case 'handoff':
      add(`*Handoff: ${c.account}*`, ...['owner', 'deal', 'value', 'close_date', 'champion'].filter(k => c[k]).map(k => `*${k.replace('_', ' ').replace(/^./, m => m.toUpperCase())}:* ${c[k]}`));
      for (const [k, h] of [['why_they_bought', 'Why they bought'], ['promised', 'What was promised'], ['risks', 'Risks'], ['next_steps', 'Next steps']]) if (c[k]) add('', `*${h}*`, c[k]);
      break;
    case 'notification':
      add(c.text, c.context);
      break;
    case 'digest':
      add(c.title && `*${c.title}*`, c.intro);
      for (const g of c.groups ?? []) add('', g.heading && `*${g.heading}*`, ...g.items.map(x => `• *${x.name}*${x.status ? `: ${x.status}` : ''}`));
      break;
    default: break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Strings inside a broken JSON answer, so a failed parse still posts readable words. */
function salvageText(raw) {
  const t = String(raw ?? '').trim();
  if (!/^(```|\{)/.test(t)) return t;
  const out = [...t.matchAll(/"(?:[a-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)].map(m => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }).filter(x => x && x.length > 2);
  return out.join('\n');
}

/**
 * What the AI wrote for a layout, checked. { ok: true, content, text } with the cleaned content and
 * its plain text; { ok: false, text } when it is not usable JSON for that layout: the Slack step then
 * posts `text` as a plain message (the words, never a JSON dump).
 */
export function parseSlackContent(format, raw) {
  const content = normalizeSlackContent(format, isObj(raw) ? raw : extractJsonObject(raw));
  if (!content) return { ok: false, text: salvageText(isObj(raw) ? JSON.stringify(raw) : raw) };
  return { ok: true, content, text: slackContentText(format, content) };
}

// ── The approval card (pre-ship finding 2, GET-858) ──────────────────────────
// Approve on the card approves everything the run's pause holds (st.bundle). So what the card lists
// is built here from that bundle, deterministically: each pending action's kind, where it goes
// (recipients, channel, the URL's host, the box's destinations) and, for HubSpot, the object and what
// is written. Bodies are left out (they are the model's words). The model's text is carried only as
// `summary`, which the card shows under "Summary (AI-written)" as plain text; the buttons are fixed.

const APPROVAL_KINDS = { email: 'Email', gmail: 'Gmail', __followup_draft: 'Gmail', slack: 'Slack', webhook: 'Webhook', revbox_delivery: 'RevBox delivery', hubspot: 'HubSpot' };
const HUBSPOT_WRITES = { note: 'Add note', update_company: 'Update company', update_deal: 'Update deal', update_contact: 'Update contact' };
const MAIL_ROWS = ['From', 'To', 'Cc', 'Subject'];
const hostOf = (u) => { try { const x = new URL(String(u ?? '').trim()); return /^https?:$/.test(x.protocol) ? x.host : '(invalid URL)'; } catch { return '(invalid URL)'; } };

/** One pending action as { step, kind, fields: [{ label, value }] }. Pure. */
export function approvalCardAction(item = {}) {
  const rows = arr(item.rows).filter(isObj).map(r => ({ label: s(r.label, 60), value: s(r.value, 300) })).filter(r => r.label);
  const row = (l) => rows.find(r => r.label === l);
  const type = String(item.type ?? '');
  let fields;
  if (type === 'email' || type === 'gmail' || type === '__followup_draft') {
    fields = MAIL_ROWS.map(row).filter(Boolean);
    if (!row('To') && item.email?.to) fields.push({ label: 'To', value: s(item.email.to, 300) });
  } else if (type === 'slack') {
    fields = [row('Channel') ?? { label: 'Channel', value: '—' }];
  } else if (type === 'webhook') {
    fields = [{ label: 'Host', value: hostOf(row('URL')?.value) }];
  } else if (type === 'revbox_delivery') {
    const d = row('Destinations');
    fields = [{ label: 'Destinations', value: d ? d.value.replace(/https?:\/\/[^\s,]+/gi, (u) => hostOf(u)) : 'None yet' }];
  } else if (type === 'hubspot') {
    const action = String(item.action ?? '');
    const write = action === 'task' ? (row('Tasks') || arr(item.tasks).length > 1 ? 'Create tasks' : 'Create task') : HUBSPOT_WRITES[action] ?? (action ? action.replace(/_/g, ' ') : 'Write');
    fields = [{ label: 'Write', value: write }, ...rows];
  } else {
    fields = rows.filter(r => !['Body', 'Message'].includes(r.label));
  }
  return { step: s(item.step, 150), kind: APPROVAL_KINDS[type] ?? (type || 'Step'), fields: fields.filter(f => f.value).slice(0, 10) };
}

/** The approval card's content for a pause: { job, actions, count, summary, token }. Pure. */
export function approvalCardContent({ job = '', bundle = [], summary = null, token = null } = {}) {
  const actions = arr(bundle).filter(isObj).map(approvalCardAction);
  const sum = String(summary ?? '').trim();
  return {
    job: s(job, 150), actions, count: actions.length,
    summary: sum ? (sum.length > 1500 ? `${sum.slice(0, 1499)}…` : sum) : null,
    token: token && Number.isInteger(token.index) && /^[0-9a-f]{8,32}$/.test(String(token.nonce)) ? { index: token.index, nonce: String(token.nonce) } : null,
  };
}
