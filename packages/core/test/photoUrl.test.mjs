// A person's photo (GET-1010): an expired LinkedIn link is no photo, so Slack, Gravatar or the
// initials show instead of a broken image. Slack's own photo is kept; its generated default is not.
//
// Run: node --test packages/core/test/photoUrl.test.mjs   (after tsc)
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsablePhotoUrl, usablePhotoUrl } from '../dist/utils/photoUrl.js';
import { slackPhotoUrl } from '../dist/cloud/slackIdentity.mjs';

const NOW = Date.parse('2026-10-22T00:00:00Z');
const li = (e) => `https://media.licdn.com/dms/image/v2/C4E03AQ/profile-displayphoto-shrink_200_200/0/1?e=${e}&v=beta&t=x`;

test('a LinkedIn photo link past its expiry is no photo', () => {
  assert.equal(isUsablePhotoUrl(li(Math.floor(Date.parse('2026-07-01') / 1000)), NOW), false);
  assert.equal(isUsablePhotoUrl(li(Math.floor(Date.parse('2026-11-01') / 1000)), NOW), true);
  assert.equal(usablePhotoUrl(li(1750000000), NOW), null);
});

test('other photo links stand; anything not https is no photo', () => {
  assert.equal(isUsablePhotoUrl('https://avatars.slack-edge.com/2026-01-01/123_abc_512.jpg', NOW), true);
  assert.equal(isUsablePhotoUrl('https://www.gravatar.com/avatar/abc?e=1', NOW), true);
  assert.equal(isUsablePhotoUrl('http://example.com/a.png', NOW), false);
  assert.equal(isUsablePhotoUrl(null, NOW), false);
  assert.equal(isUsablePhotoUrl({ value: 'https://x' }, NOW), false);
});

test("Slack: a member's own photo, never the default Slack draws", () => {
  const url = 'https://avatars.slack-edge.com/2026-01-01/123_abc_512.jpg';
  assert.equal(slackPhotoUrl({ profile: { is_custom_image: true, image_512: url } }), url);
  assert.equal(slackPhotoUrl({ profile: { is_custom_image: false, image_512: 'https://secure.gravatar.com/avatar/x.jpg' } }), null);
  assert.equal(slackPhotoUrl({ profile: { is_custom_image: true } }), null);
  assert.equal(slackPhotoUrl(null), null);
});
