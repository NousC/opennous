// Intelligence v2, "edit, don't rewrite" (GET-1054): the document model (sections and blocks with
// persistent ids), the edit operations, their strict validation, and the changelog written in code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, renderDoc, parseOps, applyOps, changelogOf, newBlockId, slugify, fragments, buildEditPrompt, skippedRetryPrompt } from '../src/lib/livingDoc.mjs';
import { createHash } from 'node:crypto';

const FILE = `# Win/loss

3 won, 2 lost so far.

## Why we lose

- Price vs Brightlist (Brindle, Atlas Freight): 2 accounts.
- No admin seat (Brindle).

| Competitor | Met | Won |
| --- | --- | --- |
| Brightlist | 2 | 0 |

## By competitor

\`\`\`
code with a blank line

inside it
\`\`\`

Trailing paragraph with two spaces  
and a hard break.
`;
const ids = (doc) => doc.sections.flatMap(s => s.blocks.map(b => b.id));
const sec = (doc, id) => doc.sections.find(s => s.id === id);

test('parse: sections by heading, one block per paragraph/list/table/code block, ids from the text', () => {
  const doc = parseDoc(FILE);
  assert.deepEqual(doc.sections.map(s => [s.id, s.heading, s.level, s.blocks.length]), [['win-loss', 'Win/loss', 1, 1], ['why-we-lose', 'Why we lose', 2, 2], ['by-competitor', 'By competitor', 2, 2]]);
  const code = sec(doc, 'by-competitor').blocks[0];
  assert.match(code.text, /blank line\n\ninside it/, 'a blank line inside a fence does not split the block');
  const first = sec(doc, 'why-we-lose').blocks[0];
  assert.equal(first.id, `b${createHash('sha1').update(first.text).digest('hex').slice(0, 8)}`);
  assert.equal(slugify('By segment and deal size'), 'by-segment-and-deal-size');
});

test('render round-trips byte for byte, and an op leaves every untouched block byte-identical', () => {
  const doc = parseDoc(FILE);
  assert.equal(renderDoc(doc), FILE);
  assert.equal(renderDoc(parseDoc(renderDoc(doc))), renderDoc(doc));
  const { doc: next } = applyOps(doc, [{ op: 'append_block', section_id: 'why-we-lose', text: '- Slow security review (Atlas).' }]);
  const out = renderDoc(next);
  assert.equal(out, FILE.replace('| Brightlist | 2 | 0 |\n', '| Brightlist | 2 | 0 |\n\n- Slow security review (Atlas).\n'));
  assert.match(out, /two spaces {2}\nand a hard break\./, 'trailing double spaces survive');
  assert.deepEqual(ids(next).filter(id => ids(doc).includes(id)), ids(doc), 'the old ids are all still there, in order');
  assert.equal(ids(next).length, ids(doc).length + 1);
  assert.equal(doc.sections[1].blocks.length, 2, 'the input doc is never changed');
});

test('a block keeps its id when its text changes, by op and by re-parse', () => {
  const doc = parseDoc(FILE);
  const id = sec(doc, 'why-we-lose').blocks[0].id;
  const { doc: next } = applyOps(doc, [{ op: 'replace_block', section_id: 'why-we-lose', block_id: id, text: '- Price vs Brightlist (Brindle, Atlas Freight, Lanternly): 3 accounts.' }]);
  assert.equal(sec(next, 'why-we-lose').blocks[0].id, id);
  assert.match(renderDoc(next), /3 accounts/);
  // Re-parsing the rendered text against the doc keeps every id, the replaced block's included.
  assert.deepEqual(ids(parseDoc(renderDoc(next), next)), ids(next));
});

test('a hand edit is re-parsed keeping the ids of unchanged blocks; an edited block keeps its place and id', () => {
  const doc = parseDoc(FILE);
  const edited = FILE
    .replace('- No admin seat (Brindle).', '- No admin seat (Brindle). Fixed in v2.')    // edited in place
    .replace('## By competitor', '## Why we win\n\n- Came for the API (Atlas).\n\n## By competitor');   // a new section
  const re = parseDoc(edited, doc);
  assert.deepEqual(re.sections.map(s => s.id), ['win-loss', 'why-we-lose', 'why-we-win', 'by-competitor']);
  assert.deepEqual(sec(re, 'why-we-lose').blocks.map(b => b.id), sec(doc, 'why-we-lose').blocks.map(b => b.id));
  assert.deepEqual(sec(re, 'by-competitor').blocks.map(b => b.id), sec(doc, 'by-competitor').blocks.map(b => b.id));
  assert.equal(sec(re, 'why-we-win').blocks[0].id, newBlockId('- Came for the API (Atlas).', new Set()));
  // A moved block keeps its id too.
  const moved = parseDoc(FILE.replace('3 won, 2 lost so far.\n\n', '').replace('## By competitor\n\n', '## By competitor\n\n3 won, 2 lost so far.\n\n'), doc);
  assert.equal(sec(moved, 'by-competitor').blocks[0].id, doc.sections[0].blocks[0].id);
});

test('each of the 8 ops applies', () => {
  const doc = parseDoc(FILE);
  const [p1, p2] = sec(doc, 'why-we-lose').blocks.map(b => b.id);
  const run = (op) => { const r = applyOps(doc, [op], { required: ['Win/loss', 'Why we lose'] }); assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped)); return r.doc; };
  assert.equal(sec(run({ op: 'append_block', section_id: 'why-we-lose', text: '- New.' }), 'why-we-lose').blocks.at(-1).text, '- New.');
  assert.equal(sec(run({ op: 'insert_block', section_id: 'why-we-lose', after_block_id: null, text: 'First.' }), 'why-we-lose').blocks[0].text, 'First.');
  assert.equal(sec(run({ op: 'insert_block', section_id: 'why-we-lose', after_block_id: p1, text: 'Second.' }), 'why-we-lose').blocks[1].text, 'Second.');
  assert.equal(sec(run({ op: 'replace_block', section_id: 'why-we-lose', block_id: p1, text: '- Price.' }), 'why-we-lose').blocks[0].text, '- Price.');
  assert.deepEqual(sec(run({ op: 'remove_block', section_id: 'why-we-lose', block_id: p2 }), 'why-we-lose').blocks.map(b => b.id), [p1]);
  const added = run({ op: 'add_section', heading: 'Recent closes', level: 2, blocks: ['- 2026-10-20 · Brindle · lost · price'], after_section_id: 'why-we-lose' });
  assert.deepEqual(added.sections.map(s => s.id), ['win-loss', 'why-we-lose', 'recent-closes', 'by-competitor']);
  assert.deepEqual(run({ op: 'add_section', heading: 'At the end', level: 2, blocks: ['x'] }).sections.at(-1).id, 'at-the-end');
  assert.deepEqual(run({ op: 'remove_section', section_id: 'by-competitor' }).sections.map(s => s.id), ['win-loss', 'why-we-lose']);
  const rsb = sec(run({ op: 'replace_section_blocks', section_id: 'why-we-lose', blocks: [sec(doc, 'why-we-lose').blocks[0].text, '- Timing.'] }), 'why-we-lose');
  assert.equal(rsb.blocks[0].id, p1, 'a block re-sent unchanged keeps its id');
  assert.equal(rsb.blocks[1].text, '- Timing.');
  const renamed = run({ op: 'rename_section', section_id: 'by-competitor', new_heading: 'Against each competitor' });
  assert.deepEqual([sec(renamed, 'by-competitor').heading], ['Against each competitor'], 'the id is kept');
  // Two paragraphs in one text become two blocks.
  assert.equal(sec(run({ op: 'append_block', section_id: 'why-we-lose', text: 'One.\n\nTwo.' }), 'why-we-lose').blocks.length, 4);
  assert.deepEqual(fragments('One.\n\n\nTwo.'), ['One.', 'Two.']);
});

test('unknown ids, a block in another section and a required section are skipped with a reason; the rest apply', () => {
  const doc = parseDoc(FILE);
  const p1 = sec(doc, 'why-we-lose').blocks[0].id;
  const r = applyOps(doc, [
    { op: 'append_block', section_id: 'why-we-wins', text: 'x' },
    { op: 'replace_block', section_id: 'by-competitor', block_id: p1, text: 'x' },
    { op: 'remove_block', section_id: 'why-we-lose', block_id: 'b00000000' },
    { op: 'remove_section', section_id: 'why-we-lose' },
    { op: 'rename_section', section_id: 'win-loss', new_heading: 'Wins' },
    { op: 'add_section', heading: 'why we lose', level: 2, blocks: ['x'] },
    { op: 'replace_block', section_id: 'why-we-lose', block_id: p1, text: sec(doc, 'why-we-lose').blocks[0].text },
    { op: 'append_block', section_id: 'by-competitor', text: '- Kept.' },
  ], { required: ['Win/loss', 'Why we lose'] });
  assert.deepEqual(r.skipped.map(s => s.reason), [
    'unknown section_id why-we-wins',
    `block ${p1} is in section why-we-lose, not by-competitor`,
    'unknown block_id b00000000 in section why-we-lose',
    'section why-we-lose is required and cannot be removed',
    'section win-loss is required; its heading stays "Win/loss"',
    'a section "why we lose" already exists (id why-we-lose); add to it instead',
    `no change: block ${p1} already says this`,
  ]);
  assert.equal(applyOps(doc, [{ op: 'rename_section', section_id: 'win-loss', new_heading: 'win/loss' }], { required: ['Win/loss'] }).skipped[0].no_change, true, 'a case-only rename is no change');
  assert.equal(r.skipped.at(-1).no_change, true);
  assert.equal(r.applied.length, 1);
  assert.match(skippedRetryPrompt(r.skipped, doc), /section why-we-lose "Why we lose": blocks b[0-9a-f]{8}, b[0-9a-f]{8}/);
});

test('the reply is strict: any shape error rejects all of it', () => {
  assert.deepEqual(parseOps('{"operations":[{"op":"append_block","section_id":"a","text":"x"}]}'), { ops: [{ op: 'append_block', section_id: 'a', text: 'x' }] });
  assert.deepEqual(parseOps('```json\n{"operations": []}\n```'), { ops: [] });
  const bad = parseOps(JSON.stringify({ operations: [
    { op: 'append_block', section_id: 'a', text: 'x' },
    { op: 'append_block', section_id: 'a', block_id: null, text: 'x' },
    { op: 'replace_block', section_id: 'a', text: 'x' },
    { op: 'rewrite', section_id: 'a' },
    { op: 'add_section', heading: '## Two', level: 9, blocks: [] },
    { op: 'append_block', section_id: 'a', text: '## A heading\n\ntext' },
    { op: 'insert_block', section_id: 'a', text: 'x' },
  ] }));
  assert.equal(bad.ops, undefined);
  assert.deepEqual(bad.errors, [
    'operations[1] (append_block) has a key it does not take: block_id',
    'operations[2] (replace_block) is missing block_id',
    'operations[3]: unknown op "rewrite"; the ops are append_block, insert_block, replace_block, remove_block, add_section, remove_section, replace_section_blocks, rename_section',
    'operations[4].heading is the heading text without the leading #',
    'operations[4].level must be an integer from 1 to 6',
    'operations[4].blocks must be a non-empty list of markdown texts',
    'operations[5].text holds a heading line; add a section with add_section instead',
    'operations[6] (insert_block) is missing after_block_id',
  ]);
  assert.deepEqual(parseOps(JSON.stringify({ operations: [{ op: 'append_block', section_id: 'a', text: '```\nno close' }] })).errors, ['operations[0].text opens a code fence it does not close']);
  assert.deepEqual(parseOps(JSON.stringify({ operations: [{ op: 'append_block', section_id: 'a', text: '````\n```\nstill code\n````' }] })).ops.length, 1, 'a shorter fence inside a longer one does not close it');
  assert.deepEqual(parseOps('{"file":"# Win/loss"}').errors, ['The reply must be {"operations": [...]}.']);
  assert.deepEqual(parseOps('sorry').errors, ['The reply is not a JSON object.']);
});

test('the changelog is written from what was applied', () => {
  const doc = parseDoc(FILE);
  const p1 = sec(doc, 'why-we-lose').blocks[0].id;
  const { applied } = applyOps(doc, [
    { op: 'append_block', section_id: 'why-we-lose', text: '- A.' },
    { op: 'append_block', section_id: 'why-we-lose', text: '- B.' },
    { op: 'replace_block', section_id: 'why-we-lose', block_id: p1, text: '- Price (3 accounts).' },
    { op: 'rename_section', section_id: 'by-competitor', new_heading: 'Competitors' },
  ]);
  assert.equal(changelogOf(applied), '+2 points under Why we lose, 1 updated under Why we lose, renamed By competitor to Competitors');
  assert.equal(changelogOf(applyOps(doc, [{ op: 'add_section', heading: 'Recent closes', level: 2, blocks: ['- one', '- two'] }, { op: 'remove_section', section_id: 'by-competitor' }]).applied), 'new section Recent closes (+2), removed section By competitor');
  assert.equal(changelogOf([]), 'No change');
  const many = Array.from({ length: 12 }, (_, i) => ({ op: 'append_block', section: `A long section heading ${i}`, added: 1, updated: 0, removed: 0 }));
  const line = changelogOf(many);
  assert.ok(line.length <= 120, line);
  assert.match(line, /, and \d+ more$/);
});

test('the edit prompt holds the doc with its ids, the new items and the rules', () => {
  const doc = parseDoc(FILE);
  const p = buildEditPrompt({ topic: 'a win/loss file.', doc, itemsHeader: 'DEALS THAT CLOSED SINCE:', itemsText: '1. LOST · Brindle', fileRules: '# Win/loss, ## Why we win' });
  assert.match(p, /"id": "why-we-lose"/);
  assert.ok(p.includes(`"id": "${sec(doc, 'why-we-lose').blocks[0].id}"`));
  assert.match(p, /DEALS THAT CLOSED SINCE:\n1\. LOST · Brindle/);
  assert.match(p, /Absence is not contradiction/);
  assert.match(p, /\{"op": "rename_section", "section_id": "\.\.\.", "new_heading": "\.\.\."\}/);
});
