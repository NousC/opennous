/**
 * Credentials as the user actually pastes them.
 *
 * A key copied out of a provider's "shown once" dialog routinely carries a trailing newline,
 * a leading space, or a zero-width character from the web page it was copied from. We used to
 * send that through verbatim, the provider answered 401, and we told the person their key was
 * invalid — for a key that was perfectly good. Nothing in the UI shows trailing whitespace,
 * so there is no way to see it and no way to act on the message.
 *
 * So every credential is normalised once, here, on the way in: at the test, and again before
 * we encrypt and store it. Values that are not strings (booleans, the arrays webhook ids use)
 * pass through untouched.
 */

// Zero-width space / non-joiner / joiner / BOM, plus ordinary whitespace at either end.
const INVISIBLE = /^[\s​-‍﻿]+|[\s​-‍﻿]+$/g;

export function normalizeCredentialValue(value) {
  return typeof value === 'string' ? value.replace(INVISIBLE, '') : value;
}

export function normalizeCredentials(credentials) {
  const out = {};
  for (const [k, v] of Object.entries(credentials || {})) out[k] = normalizeCredentialValue(v);
  return out;
}
