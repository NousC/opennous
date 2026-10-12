import { useEffect, useState } from "react";

const apiUrl = import.meta.env.VITE_API_URL ?? "";

export type AuthConfig = {
  // When true, the instance has closed public registration (self-host).
  signupsDisabled: boolean;
  // Whether Google OAuth is configured (hide the dead button if not).
  googleEnabled: boolean;
  // Bundled self-host stack only: no owner yet. The owner signs up with the setup token
  // (/signup?setup=<SELFHOST_SETUP_TOKEN>); nobody else can until then.
  setupRequired: boolean;
};

// Hosted-product defaults — used until the config loads or if the request
// fails, so a transient error never hides sign-in or locks anyone out.
const DEFAULTS: AuthConfig = { signupsDisabled: false, googleEnabled: true, setupRequired: false };

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
        setupRequired: json.setupRequired === true,
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

// Where a closed instance still lets someone create a login: the pages that redeem a
// token (a CLI join token on /cli-login, an invitation on /accept-invitation). The token
// is what the API checks; the login alone gets nothing. Open instances (Cloud) always
// allow sign-up, so this never changes what Cloud shows.
const TOKEN_PAGES = ["/cli-login", "/accept-invitation"];

export function signupAllowed(cfg: AuthConfig, redirectTo?: string | null): boolean {
  if (!cfg.signupsDisabled || cfg.setupRequired) return true;
  const path = (redirectTo || "").split(/[?#]/)[0];
  return TOKEN_PAGES.includes(path);
}
