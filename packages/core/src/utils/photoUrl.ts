// A person's photo link, if it can still be shown (GET-1010).
//
// LinkedIn signs its image links (media.licdn.com/…?e=<unix seconds>&…) and they stop working
// after a few weeks; nearly every LinkedIn photo we stored has expired. An expired one is no photo:
// served, it draws a broken image instead of falling back to Slack, Gravatar or initials.

/** True when `url` is an https image link that has not expired. Pure. */
export function isUsablePhotoUrl(url: unknown, now: number = Date.now()): url is string {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) return false;
  if (!/(^|\.)licdn\.com$/.test(hostOf(url))) return true;
  const e = /[?&]e=(\d{9,11})(?:&|$)/.exec(url);
  return !e || Number(e[1]) * 1000 > now;
}

/** The photo to show, or null. Pure. */
export const usablePhotoUrl = (url: unknown, now: number = Date.now()): string | null => (isUsablePhotoUrl(url, now) ? url : null);

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
