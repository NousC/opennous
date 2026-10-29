// How a context file's text is shown in the document sheet (GET-895). Context used to be a wall of
// raw text in an expand/collapse row, "## Title" shown literally. The sheet renders it as a
// document instead, and these pure helpers decide HOW:
//
// - markdown: headings, lists, tables, emphasis, code. Rendered by the app's markdown renderer
//   (Prose in AgentMarkdown.tsx: react-markdown + remark-gfm, no raw HTML, so a file cannot
//   inject markup).
// - json: an uploaded .json file, shown as a code block, pretty-printed.
// - plain: anything else. Rendered as paragraphs with its own line breaks kept, because markdown
//   would fold a hand-written list of lines into one run-on paragraph.

export type DocFormat = 'markdown' | 'plain' | 'json';

// One signal is enough: a stray "**" in a plain note renders the same either way, while a real
// markdown file read as plain shows its syntax, which is the bug this replaces.
const MARKDOWN_SIGNALS: RegExp[] = [
  /^#{1,6}\s+\S/m,                 // # Heading
  /^\s{0,3}[-*+]\s+\S/m,           // - bullet
  /^\s{0,3}\d{1,3}[.)]\s+\S/m,     // 1. numbered
  /^\s{0,3}>\s?\S/m,               // > quote
  /^\s*\|.*\|\s*$/m,               // | table | row |
  /^\s{0,3}(```|~~~)/m,            // fenced code
  /\*\*[^*\n]+\*\*/,               // **bold**
  /(^|[^\w*])\*[^*\s][^*\n]*\*(?!\w)/m, // *italic*
  /`[^`\n]+`/,                     // `code`
  /\[[^\]\n]+\]\([^)\s]+\)/,       // [link](url)
];

/**
 * The body without a leading YAML front matter block (`---` … `---`). It is metadata for the repo
 * and the agents (title, kind, source); read as markdown it rendered as one bold run-on line.
 */
export function withoutFrontmatter(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\r\n?/g, '\n');
  const m = /^\s*---\n[\s\S]*?\n---[ \t]*(\n|$)/.exec(t);
  return m ? t.slice(m[0].length).replace(/^\s*\n/, '') : t;
}

/** How to render `text`: markdown when it carries markdown syntax, json for a JSON upload, else plain. */
export function docFormat(text: string | null | undefined): DocFormat {
  const t = (text ?? '').trim();
  if (!t) return 'plain';
  if (/^[[{]/.test(t)) {
    try { JSON.parse(t); return 'json'; } catch { /* not JSON: fall through */ }
  }
  return MARKDOWN_SIGNALS.some(r => r.test(t)) ? 'markdown' : 'plain';
}

/** Plain text as paragraphs: split on blank lines, each paragraph keeps its own line breaks. */
export function plainParagraphs(text: string | null | undefined): string[] {
  return (text ?? '').replace(/\r\n?/g, '\n').split(/\n(?:[ \t]*\n)+/).map(p => p.replace(/^\n+|\s+$/g, '')).filter(p => p.trim().length > 0);
}

/** A JSON upload, pretty-printed (the original text when it does not parse). */
export function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

const norm = (s: string) => s.toLowerCase().replace(/\.(md|markdown|txt)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The body without a leading "# Title" line that only repeats the file's title. The sheet already
 * shows the title as its header; the same words again as the first heading read as a stutter.
 */
export function withoutRepeatedTitle(body: string, title: string): string {
  const m = /^\s*#{1,2}\s+(.+?)\s*#*\s*(\n|$)/.exec(body);
  if (!m || !title.trim() || norm(m[1]) !== norm(title)) return body;
  return body.slice(m[0].length).replace(/^\s*\n/, '');
}

/**
 * The title to show and the body under it. A leading "# heading" that repeats the file's title is
 * dropped (see withoutRepeatedTitle). One that names it more fully ("## OpenNous ICP" in a file
 * called "ICP") becomes the title instead, so the sheet does not open on two titles in a row.
 */
export function docHeading(body: string, title: string): { title: string; body: string } {
  const m = /^\s*#{1,2}\s+(.+?)\s*#*\s*(\n|$)/.exec(body);
  const t = norm(title);
  if (!m || !t) return { title, body };
  const h = norm(m[1]);
  if (h !== t && !(m[1].length <= 80 && ` ${h} `.includes(` ${t} `))) return { title, body };
  return { title: h === t ? title : m[1].replace(/[*_`]/g, ''), body: body.slice(m[0].length).replace(/^\s*\n/, '') };
}

/** True when there is no text to show (only whitespace). */
export const isEmptyDoc = (text: string | null | undefined) => !(text ?? '').trim();
