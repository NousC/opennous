// The one-liner that installs the CLI and connects the coding agent — pointed at THIS
// instance, whichever it is.
//
// On Nous Cloud, VITE_API_URL is the API domain (https://api.opennous.cloud) and the command
// resolves there. On a same-origin self-host (nginx proxy, VITE_API_URL empty) we fall back to
// the current origin, where nginx proxies /install to the API. Either way the served script
// bakes in the right --url, so a self-hoster's users connect to THEM, not to our cloud.
// See apps/api/src/routes/public/install.mjs and apps/frontend/nginx.conf.
export function installCommand(): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || window.location.origin;
  return `curl -fsSL ${base}/install | sh`;
}
