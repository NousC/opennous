// The report block vocabulary, server side: what the agent may hand the renderer.
//
// Blocks are model output, so nothing is trusted. An unknown type, an empty table or a chart
// whose numbers are strings is dropped rather than shipped to a renderer that would draw it
// wrong. Silent-drop beats a broken document: a section keeps its other blocks.
//
// This lived inside the `present_document` handler until `present_answer` needed the same
// blocks in a chat message. One sanitizer, so a table in a report and a table in a widget can
// never disagree about what a block is. The renderer is `apps/frontend/src/components/
// ReportBlocks.tsx`; the doctrine is `docs/report-design-doctrine.md`.

export const UNITS = ['usd', 'pct', 'days', 'count'];
// Five blocks carry numbers and rankings. The four added in GET-416 carry the STORY the
// revenue report needs and a bar chart cannot: the evidence under a chart, the path a lost
// deal took, two signal columns side by side, and one account reconstructed in time.
export const BLOCK_TYPES = new Set(['prose', 'metrics', 'chart', 'table', 'callout', 'evidence', 'path', 'columns', 'timeline', 'bullets', 'split']);

/**
 * The tool-schema shape of ONE block, shared by `present_document` (a report section's blocks)
 * and `present_answer` (a chat widget). Describes the vocabulary; the rules about WHICH block
 * carries which claim live in each tool's own description.
 */
export const BLOCK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['prose', 'metrics', 'chart', 'table', 'callout', 'evidence', 'path', 'columns', 'timeline', 'bullets', 'split'], description: 'prose = markdown with [n] citations · metrics = a row of headline numbers · chart = a series · table = rows · callout = the one finding that matters most in this section · evidence = the proof strip under a chart: 2-4 rows of { account, quote, became } · path = an ordered sequence of steps a cohort took, with the share at each · columns = two lists side by side (e.g. risk vs expansion), each a title and cards · timeline = one account reconstructed: dated events with source and meaning · bullets = 3-6 short lines under a heading — "In brief" opens a section, "Takeaways" (what this means for you, what to do) closes it; a section never ends on a paragraph · split = two blocks side by side (chart left, evidence or bullets right).' },
    body: { type: 'string', description: 'prose and callout: markdown.' },
    items: { type: 'array', description: 'metrics: 2-4 of { label, value, unit?, note? }. Pass `value` RAW — 1200000 with unit "usd", 31 with unit "pct" — and it is formatted once, in one place. Only use `text` instead when the headline genuinely is not a number ("3 of 11").',
      items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' }, text: { type: 'string' }, unit: { type: 'string', enum: UNITS }, note: { type: 'string' }, tone: { type: 'string', enum: ['good', 'risk', 'bad', 'neutral'], description: 'a STATUS tile: what the number means. Omit for a plain figure.' } }, required: ['label'] } },
    variant: { type: 'string', enum: ['bar', 'column', 'grouped', 'line'], description: "chart: 'bar' = ranked comparison (horizontal, the usual choice) · 'column' = a few categories or a short series over time · 'grouped' = two series compared, e.g. won vs lost · 'line' = a long series over time." },
    title: { type: 'string', description: 'chart/callout: a short caption stating what it shows.' },
    unit: { type: 'string', enum: UNITS, description: 'chart: how to format the axis and labels. Pass RAW numbers — 1200000, not "$1.2M".' },
    data: { type: 'array', description: "chart: [{ label, value }] for one series; for 'grouped'/'line' add one key per series, e.g. { label: 'Discovery', won: 3.1, lost: 5.7 }.", items: { type: 'object' } },
    series: { type: 'array', description: "chart: only for 'grouped'/'line' — [{ key, label, color? }]. color is 'good' (won/healthy), 'risk', 'bad' (lost) or 'accent'; omit it and the house ramp is used. NEVER pass a hex colour.",
      items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, color: { type: 'string', enum: ['accent', 'good', 'risk', 'bad'] } }, required: ['key', 'label'] } },
    headers: { type: 'array', items: { type: 'string' }, description: 'table: column headers.' },
    rows: { type: 'array', items: { type: 'array' }, description: 'table: rows of cells, first column is the row label. Cells in a unit column are RAW numbers.' },
    units: { type: 'array', items: { type: 'string' }, description: "table: one per column — 'usd', 'pct', 'days', 'count', or '' for a text column. A unit column takes RAW numbers (200000, not \"$200K\") and the app formats them." },
    emphasis: { type: 'integer', description: 'table: the column index a reader should scan (a priority, a delta).' },
    more: { type: 'integer', description: 'table / evidence / columns: how many MORE rows exist beyond the ones shown. The block prints "Showing 4 of 120". Always pass it when you show a preview of a longer list — a reader must never think three rows is the whole book.' },
    more_label: { type: 'string', description: 'table / evidence / columns: where the full list lives — "the Customer Success page", "the Accounts list".' },
    heading: { type: 'string', description: 'bullets: "In brief" or "Takeaways", or a short heading of your own.' },
    lines: { type: 'array', items: { type: 'string' }, description: 'bullets: 3-6 lines, each one sentence, markdown allowed, [n] citations allowed. A takeaway says what to DO.' },
    left: { type: 'array', description: 'split: 1-2 blocks for the left column (usually the chart or path).', items: { type: 'object' } },
    right: { type: 'array', description: 'split: 1-2 blocks for the right column (usually evidence or bullets).', items: { type: 'object' } },
    tone: { type: 'string', enum: ['good', 'risk', 'bad', 'neutral'], description: 'callout: what it means, not what colour you want. columns/path: the tone of the whole block.' },
    evidence: { type: 'array', description: "evidence: 2-4 of { account, quote, became, at? } — the account's name, the buyer's VERBATIM words (never paraphrased), and what Nous made of them ('flagged at risk', 'filed as a task for Avery', 'expansion: Lumen Navigator'). One line each; this is what makes a number believable.",
      items: { type: 'object', properties: { account: { type: 'string' }, quote: { type: 'string' }, became: { type: 'string' }, at: { type: 'string' } }, required: ['account', 'quote', 'became'] } },
    steps: { type: 'array', description: "path: the ordered steps, e.g. [{ label: 'No economic buyer', pct: 70 }, { label: 'Close date slipped', pct: 55 }, …] — pct is the share of the cohort that had that step, RAW (55, not '55%'). Add `cohort` ('of 120 lost deals') and, when known, `compare` ('10% of won deals took this path').",
      items: { type: 'object', properties: { label: { type: 'string' }, pct: { type: 'number' }, n: { type: 'number' } }, required: ['label'] } },
    cohort: { type: 'string', description: 'path: what the shares are of — "of 120 lost deals".' },
    compare: { type: 'string', description: 'path: the same path in the other cohort — "10% of won deals" — so a shared pattern is never sold as a loss pattern.' },
    columns: { type: 'array', description: "columns: exactly 2 of { title, tone?, cards: [{ account, text, quote?, value?, unit? }] } — e.g. 'At risk' (tone bad) beside 'Asking for more' (tone good), 3-5 cards each.",
      items: { type: 'object', properties: { title: { type: 'string' }, tone: { type: 'string', enum: ['good', 'risk', 'bad', 'neutral'] }, cards: { type: 'array', items: { type: 'object', properties: { account: { type: 'string' }, text: { type: 'string' }, quote: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string', enum: UNITS } }, required: ['account', 'text'] } } }, required: ['title', 'cards'] } },
    events: { type: 'array', description: "timeline: 4-12 of { at, source, event, meaning, tone? } for ONE account — the date, where it came from ('Fellow call', 'Gmail', 'HubSpot'), what happened in their words, and what it meant commercially.",
      items: { type: 'object', properties: { at: { type: 'string' }, source: { type: 'string' }, event: { type: 'string' }, meaning: { type: 'string' }, tone: { type: 'string', enum: ['good', 'risk', 'bad', 'neutral'] } }, required: ['at', 'event'] } },
  },
  required: ['type'],
};

/**
 * Be generous about the shape. A model that nests `body` one level too deep, or writes
 * `heading`/`content`, or hands back an array of lines, meant the same thing — and bouncing it
 * costs the operator a retry they can see. Read what it meant.
 */
export function asText(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\n');
  if (v && typeof v === 'object') {
    const inner = v.body ?? v.content ?? v.text ?? v.value;
    if (inner !== undefined) return asText(inner);
  }
  return '';
}

const SUFFIX = { k: 1e3, m: 1e6, b: 1e9 };

/**
 * A number the model meant, or null. "$1,200,000", "31%" and "2.5M" all parse — the model is
 * told to pass raw numbers, and when it formats one anyway the value is recovered rather than
 * shown as a string beside correctly formatted neighbours.
 */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[$,%\s]/g, '');
  const m = /^(-?\d+(?:\.\d+)?)([kmb])$/i.exec(s);
  const n = m ? Number(m[1]) * SUFFIX[m[2].toLowerCase()] : Number(s);
  return s && Number.isFinite(n) ? n : null;
}

const unitOf = (u) => (UNITS.includes(u) ? u : null);

export function sanitizeBlock(b) {
  if (!b || typeof b !== 'object' || !BLOCK_TYPES.has(b.type)) return null;

  if (b.type === 'prose') {
    const body = asText(b.body ?? b.text ?? b.content);
    return body ? { type: 'prose', body } : null;
  }

  if (b.type === 'callout') {
    const body = asText(b.body ?? b.text ?? b.content);
    if (!body) return null;
    const tone = ['good', 'risk', 'bad', 'neutral'].includes(b.tone) ? b.tone : 'neutral';
    return { type: 'callout', tone, title: b.title ? String(b.title).slice(0, 120) : null, body };
  }

  if (b.type === 'metrics') {
    // A headline number is the most-read thing in the document, and it used to be the one
    // place the MODEL formatted a value ("$2.5M") — the exact thing every other block
    // forbids. A raw value plus a unit is formatted by the renderer instead, the same code that
    // formats the axis beside it. A genuinely non-numeric headline ("3 of 11") passes as `text`.
    const items = (Array.isArray(b.items) ? b.items : [])
      .map((m) => {
        if (!m || !m.label) return null;
        const label = String(m.label).slice(0, 40);
        const note = m.note ? String(m.note).slice(0, 60) : null;
        const unit = unitOf(m.unit);
        // Only trust a parsed number when a unit says how to render it; "$2.5M" without one
        // would otherwise become a bare 2.5.
        const n = unit ? num(m.value) : (typeof m.value === 'number' ? m.value : null);
        const tone = ['good', 'risk', 'bad', 'neutral'].includes(m.tone) ? m.tone : null;
        if (n != null) return { label, value: n, unit: unit ?? 'count', note, ...(tone ? { tone } : {}) };
        const text = m.text != null ? String(m.text) : m.value != null ? String(m.value) : '';
        return text ? { label, text: text.slice(0, 24), note, ...(tone ? { tone } : {}) } : null;
      })
      .filter(Boolean)
      // Four, not five: the row is a four-column grid, and a fifth card sits alone on a line.
      .slice(0, 4);
    return items.length ? { type: 'metrics', items } : null;
  }

  if (b.type === 'table') {
    const headers = (Array.isArray(b.headers) ? b.headers : []).map((h) => String(h)).slice(0, 8);
    // A unit per column, so money in a table is formatted by the renderer like money anywhere
    // else. Without it the model typed "$200K" into the one table people act on.
    const units = headers.map((_, i) => unitOf(Array.isArray(b.units) ? b.units[i] : null));
    const rows = (Array.isArray(b.rows) ? b.rows : [])
      .filter(Array.isArray)
      .map((r) => r.slice(0, headers.length).map((c, i) => {
        if (c == null) return '';
        if (units[i]) { const n = num(c); if (n !== null) return n; }
        const s = String(c);
        // A cell holding only a dash is an empty cell wearing a costume. The model reaches for
        // one whenever a row has nothing to say in a column, and a table with a column of
        // dashes reads as missing data rather than as nothing to report. Whole-cell only:
        // a hyphen inside a word (re-engage, single-threaded) is a word, not a placeholder.
        return /^[\s\-–—]+$/.test(s) ? '' : s;
      }))
      .slice(0, 30);
    if (!headers.length || !rows.length) return null;
    return {
      type: 'table', headers, rows,
      emphasis: Number.isInteger(b.emphasis) ? b.emphasis : null,
      ...(units.some(Boolean) ? { units } : {}),
      ...more(b),
    };
  }

  if (b.type === 'bullets') {
    const lines = (Array.isArray(b.lines) ? b.lines : Array.isArray(b.items) ? b.items : [])
      .map(asText).filter(Boolean).map((l) => l.replace(/^[-•*]\s+/, '').slice(0, 300)).slice(0, 8);
    if (!lines.length) return null;
    const heading = b.heading ? String(b.heading).slice(0, 40) : (b.title ? String(b.title).slice(0, 40) : null);
    const tone = ['good', 'risk', 'bad', 'neutral'].includes(b.tone) ? b.tone : null;
    return { type: 'bullets', heading, lines, ...(tone ? { tone } : {}) };
  }

  if (b.type === 'split') {
    // A split holds leaf blocks only: a split inside a split is a layout nobody asked for.
    const leaf = (arr) => (Array.isArray(arr) ? arr : []).map(sanitizeBlock).filter((x) => x && x.type !== 'split').slice(0, 2);
    const left = leaf(b.left), right = leaf(b.right);
    if (!left.length && !right.length) return null;
    if (!left.length || !right.length) return [...left, ...right][0];   // one side empty: just the block
    return { type: 'split', left, right };
  }

  if (b.type === 'evidence') {
    const rows = (Array.isArray(b.evidence) ? b.evidence : Array.isArray(b.rows) ? b.rows : [])
      .map((r) => (r && r.account && r.quote && r.became) ? { account: String(r.account).slice(0, 60), quote: String(r.quote).slice(0, 220), became: String(r.became).slice(0, 80), at: r.at ? String(r.at).slice(0, 10) : null } : null)
      .filter(Boolean).slice(0, 4);
    return rows.length ? { type: 'evidence', title: b.title ? String(b.title).slice(0, 120) : null, rows, ...more(b) } : null;
  }

  if (b.type === 'path') {
    const steps = (Array.isArray(b.steps) ? b.steps : [])
      .map((st) => (st && st.label) ? { label: String(st.label).slice(0, 60), pct: num(st.pct), n: num(st.n) } : null)
      .filter(Boolean).slice(0, 8);
    if (steps.length < 2) return null;
    const tone = ['good', 'risk', 'bad', 'neutral'].includes(b.tone) ? b.tone : 'bad';
    return { type: 'path', tone, title: b.title ? String(b.title).slice(0, 120) : null, cohort: b.cohort ? String(b.cohort).slice(0, 80) : null, compare: b.compare ? String(b.compare).slice(0, 120) : null, steps };
  }

  if (b.type === 'columns') {
    const cols = (Array.isArray(b.columns) ? b.columns : [])
      .map((c) => {
        if (!c || !c.title) return null;
        const cards = (Array.isArray(c.cards) ? c.cards : [])
          .map((k) => (k && k.account && k.text) ? { account: String(k.account).slice(0, 60), text: String(k.text).slice(0, 160), quote: k.quote ? String(k.quote).slice(0, 200) : null, value: num(k.value), unit: unitOf(k.unit) } : null)
          .filter(Boolean).slice(0, 6);
        return cards.length ? { title: String(c.title).slice(0, 60), tone: ['good', 'risk', 'bad', 'neutral'].includes(c.tone) ? c.tone : 'neutral', cards } : null;
      })
      .filter(Boolean).slice(0, 2);
    return cols.length === 2 ? { type: 'columns', title: b.title ? String(b.title).slice(0, 120) : null, columns: cols, ...more(b) } : null;
  }

  if (b.type === 'timeline') {
    const events = (Array.isArray(b.events) ? b.events : [])
      .map((e) => (e && e.at && e.event) ? { at: String(e.at).slice(0, 10), source: e.source ? String(e.source).slice(0, 40) : null, event: String(e.event).slice(0, 220), meaning: e.meaning ? String(e.meaning).slice(0, 160) : null, tone: ['good', 'risk', 'bad', 'neutral'].includes(e.tone) ? e.tone : 'neutral' } : null)
      .filter(Boolean).slice(0, 12);
    return events.length >= 2 ? { type: 'timeline', title: b.title ? String(b.title).slice(0, 120) : null, events } : null;
  }

  // chart
  const variant = ['bar', 'column', 'grouped', 'line'].includes(b.variant) ? b.variant : 'bar';
  const series = (Array.isArray(b.series) ? b.series : [])
    .map((x) => (x && x.key ? { key: String(x.key), label: String(x.label ?? x.key), color: ['accent', 'good', 'risk', 'bad'].includes(x.color) ? x.color : undefined } : null))
    .filter(Boolean).slice(0, 4);
  const keys = series.length ? series.map((x) => x.key) : ['value'];
  const data = (Array.isArray(b.data) ? b.data : [])
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const label = String(row.label ?? row.name ?? row.category ?? '').slice(0, 60);
      if (!label) return null;
      const out = { label };
      let any = false;
      for (const k of keys) { const n = num(row[k]); if (n !== null) { out[k] = n; any = true; } }
      return any ? out : null;
    })
    .filter(Boolean).slice(0, 31);
  // Two points is a sentence, not a chart.
  return data.length >= 2
    ? { type: 'chart', variant, title: b.title ? String(b.title).slice(0, 120) : null,
        unit: unitOf(b.unit), ...(series.length ? { series } : {}), data }
    : null;
}

/** The "N more" footer on a preview list: how many rows exist beyond the ones shown, and where. */
function more(b) {
  const n = Number(b.more);
  if (!Number.isInteger(n) || n <= 0) return {};
  return { more: n, ...(b.more_label ? { more_label: String(b.more_label).slice(0, 80) } : {}) };
}

/** A list of blocks, sanitized, capped. */
export function sanitizeBlocks(blocks, { max = 8, allow = BLOCK_TYPES } = {}) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(sanitizeBlock)
    .filter((b) => b && allow.has(b.type))
    .slice(0, max);
}
