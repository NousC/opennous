// How a context file's text is shown in the document sheet (GET-895), pinned.
//
// Run: node --test apps/frontend/tests/contextDoc.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { docFormat, isEmptyDoc, plainParagraphs, prettyJson, withoutFrontmatter, withoutRepeatedTitle } from "../src/lib/contextDoc.ts";

test("docFormat: markdown when the text carries markdown syntax", () => {
  assert.equal(docFormat("## Report format\n\nLead with the number."), "markdown");
  assert.equal(docFormat("Steps:\n1. Pull the deal\n2. Score it"), "markdown");
  assert.equal(docFormat("Rules:\n- one ask\n- no exclamation marks"), "markdown");
  assert.equal(docFormat("| Tier | Size |\n|---|---|\n| A | 100+ |"), "markdown");
  assert.equal(docFormat("Always say **why** it matters."), "markdown");
  assert.equal(docFormat("Use the `deal_closed` trigger."), "markdown");
  assert.equal(docFormat("See [the guide](https://example.com/guide)."), "markdown");
  assert.equal(docFormat("> Quote the buyer."), "markdown");
  assert.equal(docFormat("```\ncode\n```"), "markdown");
});

test("docFormat: plain text stays plain", () => {
  assert.equal(docFormat("Plain, short sentences. One ask per email. No exclamation marks."), "plain");
  assert.equal(docFormat("Ideal customer: B2B SaaS, 100-1,000 employees.\nPoor fit: under 50 employees."), "plain");
  assert.equal(docFormat("Use snake_case field names like deal_value and close_date."), "plain");
  assert.equal(docFormat("Price is 5 * 3 = 15 seats, give or take."), "plain");
  assert.equal(docFormat(""), "plain");
  assert.equal(docFormat(null), "plain");
  assert.equal(docFormat("   \n "), "plain");
});

test("docFormat: a JSON upload is json, a brace that is not JSON is not", () => {
  assert.equal(docFormat('{"tiers":["A","B"]}'), "json");
  assert.equal(docFormat("[1, 2, 3]"), "json");
  assert.equal(docFormat("{not json} just text"), "plain");
});

test("plainParagraphs: blank lines split paragraphs, single line breaks are kept", () => {
  assert.deepEqual(plainParagraphs("First line\nsecond line\n\nNext paragraph\r\n\r\n\n  \nLast"), ["First line\nsecond line", "Next paragraph", "Last"]);
  assert.deepEqual(plainParagraphs(""), []);
  assert.deepEqual(plainParagraphs(undefined), []);
});

test("prettyJson: indents valid JSON, leaves anything else alone", () => {
  assert.equal(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyJson("{oops"), "{oops");
});

test("withoutRepeatedTitle: drops a first heading that only repeats the title", () => {
  assert.equal(withoutRepeatedTitle("# Report format\n\nLead with the number.", "Report format"), "Lead with the number.");
  assert.equal(withoutRepeatedTitle("## ICP\nBody", "ICP.md"), "Body");
  assert.equal(withoutRepeatedTitle("# Something else\n\nBody", "Report format"), "# Something else\n\nBody");
  assert.equal(withoutRepeatedTitle("Intro\n# Report format", "Report format"), "Intro\n# Report format");
  assert.equal(withoutRepeatedTitle("### Report format\nBody", "Report format"), "### Report format\nBody");
});

test("isEmptyDoc", () => {
  assert.equal(isEmptyDoc("  \n"), true);
  assert.equal(isEmptyDoc(null), true);
  assert.equal(isEmptyDoc("x"), false);
});

test("withoutFrontmatter: drops a leading YAML block, keeps everything else", () => {
  const fm = '---\ntitle: "ICP Scoring File"\nkind: playbook\n---\n\n# OpenNous ICP\n\nBody';
  assert.equal(withoutFrontmatter(fm), "# OpenNous ICP\n\nBody");
  assert.equal(withoutFrontmatter("---\r\nkind: x\r\n---\r\nBody"), "Body");
  assert.equal(withoutFrontmatter("# Title\n\n---\n\nAfter a rule"), "# Title\n\n---\n\nAfter a rule");
  assert.equal(withoutFrontmatter("Plain text"), "Plain text");
  assert.equal(withoutFrontmatter(null), "");
});
