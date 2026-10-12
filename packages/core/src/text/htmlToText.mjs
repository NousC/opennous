// HTML → readable text, once, for every surface that shows or reads a message (GET-249).
//
// Gmail's messageText arrives as HTML for most real emails, and it was stored as-is: the timeline
// previewed `<div dir="ltr">Thank you, we will send…`, the 300-character preview spent itself on
// markup, and the agent, the reply classifier, extraction and search embeddings all read tags and
// `&#39;`. The codebase already held four private copies of a tag stripper, each a little different;
// this is the one to use.
//
// Not a parser: a sequence of replacements that is safe on hostile input (no DOM, no eval) and good
// enough for mail.

const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', zwnj: '', zwj: '', shy: '' };

/** Decode HTML entities: named (a common subset), decimal and hex. */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch { return ''; }
    }
    const v = NAMED[code.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/** Does this string look like HTML markup (rather than text that mentions a `<`)? */
export function looksLikeHtml(s) {
  return /<\/?(div|p|br|span|table|td|tr|a|b|i|u|strong|em|ul|ol|li|blockquote|html|body|font|img|h[1-6])\b[^>]*>/i.test(String(s ?? ''));
}

/**
 * HTML to plain text. Block elements become line breaks; scripts, styles, comments and head are
 * dropped; entities decoded; whitespace collapsed.
 *   dropQuoted: remove quoted history (Gmail's gmail_quote block, <blockquote>) — what a preview wants.
 */
export function htmlToText(html, { dropQuoted = false } = {}) {
  if (html == null || html === '') return '';
  let s = String(html);
  s = s.replace(/<(script|style|noscript|svg|head|title)[\s\S]*?<\/\1>/gi, ' ')
       .replace(/<!--[\s\S]*?-->/g, ' ');
  if (dropQuoted) {
    // Gmail wraps the thread being replied to in <div class="gmail_quote">…; everyone uses <blockquote>.
    s = s.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, ' ')
         .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ');
  }
  s = s.replace(/<br\s*\/?>/gi, '\n')
       .replace(/<\/(p|div|section|article|h[1-6]|tr|table|blockquote|ul|ol)>/gi, '\n')
       .replace(/<li[^>]*>/gi, '\n• ')
       .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
       .replace(/ /g, ' ')
       .replace(/[ \t\f\v]+/g, ' ')
       .replace(/ *\n */g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();
  return s;
}

/**
 * Remove a plain-text reply's quoted history: "On <date>, <person> wrote:" and "> " lines.
 *
 * A message that is NOTHING but quoted history (a forward with no note, a reply whose text sits
 * under the quote) returns ''. It used to return the whole thread, because the cut was taken only
 * when the quote started past character 0 — which is how one timeline row came to show four
 * people's emails stacked inside it.
 */
export function dropQuotedText(text) {
  const t = String(text ?? '');
  const cut = t.search(/\n?\s*(On .{4,200}? wrote:|Am .{4,200}? schrieb .{0,80}?:|-----\s*Original Message\s*-----|From: .+\nSent: |_{10,}|\bForwarded message\b)/i);
  const head = cut >= 0 ? t.slice(0, cut) : t;
  return head.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').trim();
}

/**
 * A message body as clean text, whether it arrived as HTML or text.
 *   preview: also drop quoted history, so a reply shows what was newly written.
 */
export function messageBodyText(body, { preview = false } = {}) {
  if (body == null) return '';
  const raw = String(body);
  const text = looksLikeHtml(raw) ? htmlToText(raw, { dropQuoted: preview }) : decodeEntities(raw).trim();
  // No fallback to the full thread. A message whose own text is empty stores nothing and shows its
  // subject: repeating the thread on every row is the same content filed three or four times, and
  // it made each row read as somebody else's email (GET-277).
  return preview ? dropQuotedText(text) : text;
}

/**
 * One message, split from the thread quoted under it: what this person actually wrote, and how much
 * history was dropped. Every email in the thread is its own row, so the quote is never lost — it is
 * simply not repeated. `quoted_chars` is kept on the row so a reader knows a thread was there.
 */
export function splitMessage(body) {
  const full = messageBodyText(body);
  const written = messageBodyText(body, { preview: true });
  return { written, full, quotedChars: Math.max(0, full.length - written.length) };
}
