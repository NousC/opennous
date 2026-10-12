/**
 * The auth shell (login, signup, CLI login, invitations) is the first thing a
 * person sees after clicking "Get started" on opennous.cloud. It uses the same
 * tokens as the marketing site so the seam is invisible.
 *
 * Source of truth: prototypes/index.html on the marketing site.
 */
export const AUTH = {
  bg: "#FBFBFA",      // near-white premium canvas
  panel: "#FFFFFF",   // pure white card
  line: "#ECEAE4",    // hairline border
  ink: "#17150F",     // text
  muted: "#6B655B",   // secondary text
  faint: "#A79F91",   // tertiary text
  amber: "#FF5C00",   // the one accent (brand orange)
  warm: "#D24E00",    // accent, pressed / on light
  onAmber: "#FFFFFF", // text that sits on the accent
} as const;

// Minimalist, sophisticated white background: near-white with a whisper of a
// vignette for depth. No busy graph, no warm tint — clean and premium.
export const PAGE_STYLE = {
  backgroundColor: AUTH.bg,
  backgroundImage:
    "radial-gradient(1200px 760px at 50% -12%, rgba(23,21,15,0.025), transparent 62%)",
} as const;

export const BOX_SHADOW = {
  boxShadow:
    "0 1px 0 rgba(255,255,255,0.9) inset, " +
    "0 24px 60px -28px rgba(40,36,28,0.18), " +
    "0 8px 24px -16px rgba(40,36,28,0.10)",
} as const;
