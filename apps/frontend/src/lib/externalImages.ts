// Company favicons (Google's favicon service) and people's Gravatar photos are fetched from
// third parties, which tells them which domains and (hashed) emails are in this workspace.
// Both Cloud and self-host show them by default (GET-856); an operator who would rather not
// sets VITE_EXTERNAL_IMAGES=false, and every caller falls back to initials.
export const externalImagesOn = import.meta.env.VITE_EXTERNAL_IMAGES !== "false";

/** The favicon URL for a domain, or null when external images are off or there is no domain. */
export function faviconUrl(domain: string | null | undefined, size = 64): string | null {
  if (!externalImagesOn || !domain) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}
