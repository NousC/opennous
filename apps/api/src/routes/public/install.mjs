// The install script — the front door.
//
//   curl -fsSL https://get.opennous.cloud | sh
//
// (get.opennous.cloud is a CNAME/redirect onto this route; the API also serves it directly
// at /install so the curl works before the vanity domain is wired.)
//
// One command, from zero: it installs the CLI and runs `nous init`, which signs the user in
// (creating their account if they don't have one), registers the Nous MCP with the agent on
// the machine, and hands off. No plugin, no marketplace, no copy-paste key.
//
// The script is deliberately tiny and readable — anyone piping a URL into a shell should be
// able to read it first (`curl https://get.opennous.cloud`), and this prints to nothing they
// can't audit. It shells out to the published npm package for everything real.

import { Router } from 'express';

export const installRouter = Router();

function scriptFor(apiUrl) {
  const urlFlag = apiUrl && apiUrl !== 'https://api.opennous.cloud' ? ` --url ${apiUrl}` : '';
  return `#!/bin/sh
# Nous installer — https://opennous.cloud
# Installs the Nous CLI and connects it to your coding agent.
set -e

if ! command -v npm >/dev/null 2>&1; then
  echo "Nous needs Node.js (npm) and it isn't on your PATH."
  echo "Install Node 18+ from https://nodejs.org and run this again."
  exit 1
fi

echo "Setting up Nous..."

# npx runs the published CLI without a global install. -y skips the install prompt.
# 'init' signs you in (creating your account if needed), registers the MCP with your
# agent, and hands off to it for onboarding.
exec npx -y @opennous/cli@latest init${urlFlag}
`;
}

// GET /install  (and the API also mounts this at the bare host for get.opennous.cloud)
installRouter.get('/', (req, res) => {
  // A BROWSER landing here (Accept: text/html) wants the app, not a shell script rendered as
  // plain text — this is what happens when someone reloads /install or follows a stale link.
  // Send it to the in-app get-started page instead. curl/wget/sh send Accept: */* (no
  // text/html), so the pipe-to-shell install is untouched. Relative target resolves against
  // the address-bar host (app.opennous.cloud/install → app.opennous.cloud/get-started).
  if ((req.headers.accept || '').toLowerCase().includes('text/html')) {
    return res.redirect(302, '/get-started');
  }

  // On a SELF-HOST instance the CLI must connect to THIS server, not to Nous Cloud — else
  // the operator's users would set up an account on our cloud instead of on their own box.
  // The operator sets API_URL (their public API address), so default the script at it.
  let apiUrl = (process.env.SELF_HOSTED === 'true' && process.env.API_URL) || 'https://api.opennous.cloud';

  // Honour an explicit ?api= override too. It's user-supplied, so validate the shape before
  // reflecting it into a script someone pipes into sh — http allowed for localhost self-host.
  const q = typeof req.query.api === 'string' ? req.query.api : '';
  if (q && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(q)) apiUrl = q;

  res.type('text/plain; charset=utf-8');
  // Self-host serves an instance-specific URL, so don't let a CDN cache one box's script
  // for another. Cloud always serves the same script, so caching there is harmless anyway.
  res.set('Cache-Control', 'no-store');
  return res.send(scriptFor(apiUrl));
});
