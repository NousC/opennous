// The one command that connects the coding agent to THIS instance, whichever it is.
//
// It's `npx @opennous/cli init` — one command, identical on macOS, Linux, and Windows,
// because it runs on Node (no shell, no curl|sh that dies on native Windows). `init` signs
// the user in, registers the Nous MCP with their agent, and hands off.
//
// On Nous Cloud, VITE_API_URL is the API domain (https://api.opennous.cloud) and the CLI
// defaults there, so we show the bare command. On a self-host instance we append --url so the
// operator's users connect to THEM, not to our cloud. On a same-origin self-host (nginx proxy,
// VITE_API_URL empty) we fall back to the current origin.
export function installCommand(): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || window.location.origin;
  let isCloud = true;
  try { isCloud = /(^|\.)opennous\.cloud$/i.test(new URL(base).hostname); } catch { isCloud = false; }
  return isCloud
    ? `npx @opennous/cli@latest init`
    : `npx @opennous/cli@latest init --url ${base}`;
}
