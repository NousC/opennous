// A RevBox reference is checked against the viewer's accounts before its text is used (GET-868).
// getDocument returns { document, subject, … }; reading `title` or `subject_entity_id` off that wrapper
// made every check pass and every body empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleDocument } from '../src/lib/revboxSnapshot.mjs';

const detail = (subject) => ({ document: { id: 'd1', title: 'QBR notes', body_md: 'Numbers…', subject_entity_id: subject }, subject: null, sources: [] });

test('a document about an account the viewer cannot see is refused', () => {
  assert.equal(visibleDocument(detail('acct-hidden'), new Set(['acct-ok'])), null);
});

test('a visible document returns the row itself, with its title and body', () => {
  const doc = visibleDocument(detail('acct-ok'), new Set(['acct-ok']));
  assert.equal(doc.title, 'QBR notes');
  assert.equal(doc.body_md, 'Numbers…');
});

test('a document with no account subject, or a viewer with no restriction, is allowed; a missing one is not', () => {
  assert.equal(visibleDocument(detail(null), new Set()).id, 'd1');
  assert.equal(visibleDocument(detail('acct-x'), null).id, 'd1');
  assert.equal(visibleDocument(null, null), null);
});
