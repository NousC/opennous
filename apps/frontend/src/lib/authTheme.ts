/**
 * The auth shell (login, signup, CLI login, invitations) is the first thing a
 * person sees after clicking "Get started" on opennous.cloud. It uses the same
 * tokens as the marketing site so the seam is invisible.
 *
 * Source of truth: prototypes/index.html on the marketing site.
 */
export const AUTH = {
  bg: "#EFEBE2",      // warm paper
  panel: "#FBFAF5",   // card
  line: "#E4DED1",    // border
  ink: "#1A1712",     // text
  muted: "#6B655B",   // secondary text
  faint: "#A79F91",   // tertiary text
  amber: "#E0912B",   // the one accent
  warm: "#96601f",    // amber, pressed / on light
  onAmber: "#1a1000", // text that sits on amber
} as const;

export const PAGE_STYLE = {
  backgroundColor: AUTH.bg,
  backgroundImage:
    "radial-gradient(1100px 700px at 78% -8%, rgba(224,145,43,0.07), transparent 60%), " +
    "radial-gradient(900px 600px at 12% 108%, rgba(150,96,31,0.05), transparent 60%)",
} as const;

export const BOX_SHADOW = {
  boxShadow:
    "0 1px 0 rgba(255,255,255,0.8) inset, " +
    "0 18px 50px -22px rgba(70,58,34,0.28), " +
    "0 6px 18px -12px rgba(150,96,31,0.16)",
} as const;
