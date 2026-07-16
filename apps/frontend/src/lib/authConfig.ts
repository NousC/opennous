import { useEffect, useState } from "react";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type AuthConfig = {
  // When true, the instance has closed public registration (self-host).
  signupsDisabled: boolean;
  // Whether Google OAuth is configured (hide the dead button if not).
  googleEnabled: boolean;
};

// Hosted-product defaults — used until the config loads or if the request
// fails, so a transient error never hides sign-in or locks anyone out.
const DEFAULTS: AuthConfig = { signupsDisabled: false, googleEnabled: true };

let cached: AuthConfig | null = null;

export async function fetchAuthConfig(): Promise<AuthConfig> {
  if (cached) return cached;
  try {
    const res = await fetch(`${apiUrl}/api/auth/config`);
    if (res.ok) {
      const json = await res.json();
      cached = {
        signupsDisabled: Boolean(json.signupsDisabled),
        googleEnabled: json.googleEnabled !== false,
      };
      return cached;
    }
  } catch {
    /* fall through to defaults; do not cache so we retry next time */
  }
  return DEFAULTS;
}

export function useAuthConfig(): AuthConfig {
  const [cfg, setCfg] = useState<AuthConfig>(cached ?? DEFAULTS);
  useEffect(() => {
    let alive = true;
    fetchAuthConfig().then((c) => { if (alive) setCfg(c); });
    return () => { alive = false; };
  }, []);
  return cfg;
}
