import { useEffect, useMemo, useState } from "react";
import { externalImagesOn, faviconUrl } from "@/lib/externalImages";

// A profile image with graceful fallback — no Unipile required.
//
//   person  → photo_url (real, from Slack, sync or enrichment when present)
//           → Gravatar, also when the photo link fails (the email is SHA-256 hashed, never sent in clear)
//           → initials
//   company → photo_url
//           → domain logo (Google favicon — the same source the app already uses)
//           → initials
//
// Every <img> falls through to the next source on error, so a 404 never leaves a broken
// image — it quietly degrades to initials. referrerPolicy="no-referrer" keeps the app URL
// out of the request to the third-party avatar host.

/**
 * The image to draw for someone, or null to fall back to initials — the same order EntityAvatar
 * uses, exported so the stacked roster avatars on the Accounts list resolve faces identically
 * instead of only ever drawing a letter (GET-312).
 */
export function useResolvedAvatar({ kind, email, domain, photoUrl }: {
  kind: "person" | "company"; email?: string | null; domain?: string | null; photoUrl?: string | null;
}): string | null {
  const [grav, setGrav] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setGrav(null);
    if (externalImagesOn && kind === "person" && email && !photoUrl && typeof crypto !== "undefined" && crypto.subtle) {
      gravatarUrl(email).then(u => alive && setGrav(u)).catch(() => {});
    }
    return () => { alive = false; };
  }, [kind, email, photoUrl]);
  if (photoUrl) return photoUrl;
  if (kind === "company" && domain) return faviconUrl(cleanDomain(domain), 128);
  return grav;
}

async function gravatarUrl(email: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `https://www.gravatar.com/avatar/${hex}?d=404&s=160`;
}

const cleanDomain = (d: string) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

export function EntityAvatar({
  kind, name, email, domain, photoUrl, className = "", textClassName = "",
}: {
  kind: "person" | "company";
  name?: string | null;
  email?: string | null;
  domain?: string | null;
  photoUrl?: string | null;
  className?: string;      // sizing + shape for the container (e.g. "h-7 w-7 rounded-full")
  textClassName?: string;  // font for the initials fallback
}) {
  const initials =
    (name || "?").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";

  // Gravatar hash is async (crypto.subtle), so resolve it into state.
  const [grav, setGrav] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setGrav(null);
    // Asked for even when there is a photo: a photo link that has stopped working (GET-1010) then
    // falls through to their Gravatar, not straight to initials.
    if (externalImagesOn && kind === "person" && email && typeof crypto !== "undefined" && crypto.subtle) {
      gravatarUrl(email).then((u) => alive && setGrav(u)).catch(() => {});
    }
    return () => { alive = false; };
  }, [kind, email]);

  const sources = useMemo(() => {
    const s: string[] = [];
    if (photoUrl) s.push(photoUrl);
    const favicon = kind === "company" && domain ? faviconUrl(cleanDomain(domain), 128) : null;
    if (favicon) s.push(favicon);
    if (kind === "person" && grav) s.push(grav);
    return s;
  }, [photoUrl, kind, domain, grav]);

  const key = sources.join("|");
  const [step, setStep] = useState(0);
  useEffect(() => { setStep(0); }, [key]);

  const src = sources[step];
  return (
    <span className={`inline-flex items-center justify-center overflow-hidden bg-muted text-muted-foreground ${className}`}>
      {src
        ? <img src={src} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setStep((s) => s + 1)}
            // Google answers a domain it has no logo for with a tiny default globe, not an error: an image
            // under 32px is no logo, so the initials come back (the same rule as the sidebar's Space mark).
            onLoad={(e) => { if (src.includes("favicon") && e.currentTarget.naturalWidth < 32) setStep((s) => s + 1); }} />
        : <span className={textClassName}>{initials}</span>}
    </span>
  );
}
