/**
 * Legal entity — single source of truth for the operator's company details shown
 * on the Impressum and the legal pages (Privacy, Terms, Cookie).
 *
 * The public repo ships PLACEHOLDERS. A real deployment supplies the values at
 * BUILD TIME via VITE_LEGAL_* env vars — Nous Cloud sets its own, a self-host
 * operator sets theirs — so no personal or company detail is hardcoded in the
 * open-source source.
 *
 * To go live, set these on the build environment (e.g. in nous.env / the CI build):
 *   VITE_LEGAL_OPERATOR_NAME   "Nous GmbH"            legal entity / operator name
 *   VITE_LEGAL_STREET          "Musterstraße 1"       street + number
 *   VITE_LEGAL_POSTAL_CODE     "10115"                postal / ZIP code
 *   VITE_LEGAL_CITY            "Berlin"               city
 *   VITE_LEGAL_COUNTRY         "Germany"              country
 *   VITE_LEGAL_EMAIL           "legal@yourdomain.com" contact email
 *   VITE_LEGAL_PHONE           "+49 ..."              phone (optional)
 *   VITE_LEGAL_VAT_ID          "DE123456789"          VAT / USt-IdNr.
 *   VITE_LEGAL_WEB             "opennous.cloud"       website shown on the notice
 *
 * Any var left unset falls back to a clearly-marked placeholder, so the pages
 * still render and it is obvious what remains to be filled in.
 */
const env = import.meta.env as Record<string, string | undefined>;

export const legalEntity = {
  operatorName: env.VITE_LEGAL_OPERATOR_NAME || "[Operator Name]",
  street: env.VITE_LEGAL_STREET || "[Street Address]",
  postalCode: env.VITE_LEGAL_POSTAL_CODE || "[Postal Code]",
  city: env.VITE_LEGAL_CITY || "[City]",
  country: env.VITE_LEGAL_COUNTRY || "[Country]",
  email: env.VITE_LEGAL_EMAIL || "contact@yourdomain.com",
  phone: env.VITE_LEGAL_PHONE || "[Phone]",
  vatId: env.VITE_LEGAL_VAT_ID || "[VAT ID]",
  web: env.VITE_LEGAL_WEB || "opennous.cloud",
} as const;

/** One-line postal address: "Street, Postal City, Country". */
export const legalAddress =
  `${legalEntity.street}, ${legalEntity.postalCode} ${legalEntity.city}, ${legalEntity.country}`;
