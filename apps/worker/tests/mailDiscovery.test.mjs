// Without a CRM or notetaker, people come from the mailbox's own conversations (GET-1087).
//
// Run: node --test apps/worker/tests/mailDiscovery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentCounterparts, repliedAmong, isExternalPerson, displayName } from '../src/services/mailDiscovery.mjs';

const scope = { internal: new Set(['ines@fernpoint.example']), ownDomains: new Set(['fernpoint.example']) };

test('the people we wrote to, busiest first, without us or machines', () => {
  const sent = [
    { to: 'Mara Velde <mara@harborline.example>, dana@fernpoint.example' },
    { to: 'mara@harborline.example', cc: 'teo@quillfield.example' },
    { to: 'noreply@harborline.example' },
    { to: 'support@harborline.example' },
    { to: 'notifications@github.com' },
  ];
  assert.deepEqual(sentCounterparts(sent, scope), ['mara@harborline.example', 'teo@quillfield.example']);
});

test('only someone who wrote back is a conversation', () => {
  const messages = [
    { sender: 'Mara Velde <mara@harborline.example>', labelIds: ['INBOX'] },
    { sender: 'ines@fernpoint.example', to: 'teo@quillfield.example', labelIds: ['SENT'] },
    { sender: 'Pitch Person <pitch@cold.example>', labelIds: ['INBOX'] },
    { sender: 'teo@quillfield.example', labelIds: ['CATEGORY_PROMOTIONS'] },
  ];
  const people = repliedAmong(messages, ['mara@harborline.example', 'teo@quillfield.example']);
  assert.deepEqual([...people.keys()], ['mara@harborline.example']);
  assert.equal(people.get('mara@harborline.example'), 'Mara Velde');
});

test('a free-mail person is a person, and a teammate on our domain is not', () => {
  assert.equal(isExternalPerson('someone@gmail.com', { ownDomains: new Set(['gmail.com']) }), true);
  assert.equal(isExternalPerson('dana@fernpoint.example', scope), false);
});

test('a display name is a name or nothing', () => {
  assert.equal(displayName('"Mara Velde" <mara@x.example>'), 'Mara Velde');
  assert.equal(displayName('mara@x.example'), null);
  assert.equal(displayName('mara@x.example <mara@x.example>'), null);
});
