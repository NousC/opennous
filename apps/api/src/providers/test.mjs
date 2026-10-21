/**
 * "Does this key actually work?" — one live call per provider, before we save anything.
 *
 * This is the difference between an integration that is connected and one that merely
 * looks connected. A mistyped key used to come back verified:true with a cheerful
 * "saved, could not verify" message, which is the worst outcome this product can
 * produce: the row goes green, nothing is ever ingested, and nobody goes looking for a
 * broken integration that says it is working. So an unknown provider now fails CLOSED.
 *
 * Moved out of the route file so that connect.mjs can call it without importing a
 * router — the import cycle that forced the old duplicate-test arrangement, where the
 * same provider was tested by one code path and waved through by another.
 */

import { fellowApiBase } from './webhooks.mjs';
import { normalizeCredentials } from './credentials.mjs';
import { ringCentralAuth, ringCentralToken, ringCentralGet, RingCentralError, posthogSettings, posthogRequest } from '@nous/core';
import { assertPublicUrl } from '../lib/ssrf.mjs';

// Cal.com's v2 API requires a dated cal-api-version header on every request.
const CAL_COM_API_VERSION = '2026-05-01';

// A key-based provider we can verify with a live call.
export const TESTABLE_PROVIDERS = ['anthropic', 'openai', 'apollo', 'instantly', 'lemlist', 'emailbison', 'heyreach', 'smartlead', 'prospeo', 'findymail', 'millionverifier', 'neverbounce', 'hubspot', 'pipedrive', 'attio', 'calendly', 'fireflies', 'fathom', 'cal_com', 'apify', 'granola'];

export async function testProviderCredentials(provider, rawCredentials) {
  // A pasted key often carries a trailing newline or a zero-width character. Strip it before
  // we judge the key — otherwise we call a good key invalid over something nobody can see.
  const credentials = normalizeCredentials(rawCredentials);
  const token = credentials.access_token || credentials.api_key || credentials.api_token || Object.values(credentials).find(Boolean);

  try {
    const p = (provider || '').toLowerCase();
    if (p === 'fellow') {
      // Two fields: the key only works against the workspace's own subdomain. /me is the
      // lightest read and names the account, so the user sees WHICH Fellow they connected.
      const base = fellowApiBase(credentials.subdomain);
      if (!base) return { verified: false, message: 'Enter your Fellow workspace subdomain — the part before .fellow.app (for acme.fellow.app, enter acme).' };
      if (!credentials.api_key) return { verified: false, message: 'No Fellow API key provided' };
      const r = await fetch(`${base}/me`, { headers: { 'X-API-KEY': credentials.api_key } });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        const who = d.user?.email || d.user?.full_name || 'Fellow user';
        return { verified: true, message: `Connected as ${who}${d.workspace?.name ? ` (${d.workspace.name})` : ''}` };
      }
      if (r.status === 401 || r.status === 403) {
        // The subdomain answered, so the workspace is real and this is about the key itself.
        return { verified: false, message: `${new URL(base).host} rejected this key. Check it was copied whole, that it has not been revoked, and that your Fellow admin has enabled the Developer API (Workspace settings → Security).` };
      }
      if (r.status === 404) return { verified: false, message: `No Fellow workspace answered at ${new URL(base).host} — check the subdomain` };
      return { verified: false, message: `Fellow returned ${r.status} — check your API key and subdomain` };
    }
    if (p === 'ringcentral') return await testRingCentral(credentials);
    if (p === 'posthog') return await testPostHog(credentials);
    // Your own model (GET-528): listing the models is the lightest call that proves the key.
    if (p === 'anthropic' || p === 'openai') {
      if (!token) return { verified: false, message: 'No API key provided' };
      const { listModels } = await import('../lib/ownModel.mjs');
      const name = p === 'anthropic' ? 'Claude' : 'ChatGPT';
      try {
        const models = await listModels(p, token);
        return { verified: true, message: `Connected to ${name} · ${models.length} model${models.length === 1 ? '' : 's'} available` };
      } catch (err) {
        return { verified: false, message: err?.status === 401 ? `${name} rejected this key.` : `${name}: ${String(err?.message ?? err).slice(0, 160)}` };
      }
    }
    if (p === 'hubspot') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        // WHOSE PORTAL IS THIS. A CRM owner is a person who works at the company, so their address
        // names the workspace's own domain (GET-291) — the second source of evidence that lets a
        // client's own staff be told apart from their customers. Best-effort: a token without the
        // owners scope still connects, it just contributes no evidence.
        const owners = await fetch('https://api.hubapi.com/crm/v3/owners?limit=10', { headers: { Authorization: `Bearer ${token}` } })
          .then(x => x.ok ? x.json() : null).catch(() => null);
        const accountEmail = (owners?.results ?? []).map(o => o?.email).find(Boolean) || null;
        return { verified: true, message: 'Connected to HubSpot', accountEmail };
      }
      const e = await r.json().catch(() => ({}));
      return { verified: false, message: e.message || `HubSpot returned ${r.status}` };
    }
    if (p === 'pipedrive') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch(`https://api.pipedrive.com/v1/users/me?api_token=${token}`);
      if (r.ok) return { verified: true, message: 'Connected to Pipedrive' };
      return { verified: false, message: `Pipedrive returned ${r.status}` };
    }
    if (p === 'attio') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.attio.com/v2/self', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) return { verified: true, message: 'Connected to Attio' };
      const e = await r.json().catch(() => ({}));
      return { verified: false, message: e.message || `Attio returned ${r.status}` };
    }
    if (p === 'instantly') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.instantly.ai/api/v2/campaigns?limit=1', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) return { verified: true, message: 'Connected to Instantly' };
      return { verified: false, message: `Instantly returned ${r.status} — check your API key` };
    }
    if (p === 'emailbison') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      // /api/users is what the EmailBison docs call out as the sample connectivity test
      const r = await fetch('https://dedi.emailbison.com/api/users', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (r.ok) return { verified: true, message: 'Connected to EmailBison' };
      if (r.status === 401) return { verified: false, message: 'Invalid EmailBison API key' };
      return { verified: false, message: `EmailBison returned ${r.status} — check your API key` };
    }
    if (p === 'heyreach') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.heyreach.io/api/public/auth/CheckApiKey', {
        headers: { 'X-API-KEY': token, Accept: 'text/plain' },
      });
      if (r.ok) return { verified: true, message: 'Connected to HeyReach' };
      if (r.status === 401) return { verified: false, message: 'Invalid HeyReach API key' };
      return { verified: false, message: `HeyReach returned ${r.status} — check your API key` };
    }
    if (p === 'smartlead') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(token)}&limit=1`);
      if (r.ok) return { verified: true, message: 'Connected to Smartlead' };
      if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Smartlead API key' };
      return { verified: false, message: `Smartlead returned ${r.status} — check your API key` };
    }
    if (p === 'fireflies') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.fireflies.ai/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ query: '{ user { name email } }' }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.data?.user?.email) return { verified: true, message: `Connected as ${d.data.user.email}` };
      return { verified: false, message: d.errors?.[0]?.message || 'Invalid Fireflies API key' };
    }
    if (p === 'fathom') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      // Fathom's external API authenticates with X-Api-Key, NOT Authorization: Bearer.
      const r = await fetch('https://api.fathom.ai/external/v1/meetings?limit=1', {
        headers: { 'X-Api-Key': token },
      });
      if (r.ok) return { verified: true, message: 'Connected to Fathom' };
      return { verified: false, message: `Fathom returned ${r.status} — check your API key` };
    }
    if (p === 'salesforce') {
      const access = credentials.access_token;
      const instance = credentials.instance_url;
      if (!access || !instance) return { verified: false, message: 'Salesforce token or instance URL missing — reconnect via OAuth' };
      const r = await fetch(`${instance.replace(/\/$/, '')}/services/data/v59.0/sobjects/`, {
        headers: { Authorization: `Bearer ${access}` },
      });
      if (r.ok) return { verified: true, message: `Connected to Salesforce (${new URL(instance).host})` };
      if (r.status === 401) return { verified: false, message: 'Salesforce token expired — reconnect via OAuth' };
      return { verified: false, message: `Salesforce returned ${r.status}` };
    }
    if (p === 'calendly') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.calendly.com/users/me', {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        const name = d.resource?.name || d.resource?.email || 'Calendly user';
        return { verified: true, message: `Connected as ${name}` };
      }
      return { verified: false, message: `Calendly returned ${r.status} — check your personal access token` };
    }
    if (p === 'smtp') {
      const host     = credentials.host;
      const username = credentials.username;
      const password = credentials.password;
      if (!host || !username || !password) {
        return { verified: false, message: 'host, username, and password are required' };
      }

      // The user case this provider serves is inbound email reception via IMAP.
      // Verify the IMAP side specifically so the test exercises the same path
      // the worker poller uses. Derive the IMAP host from the SMTP-style host
      // unless the user provided imap_host explicitly.
      const imapHost = credentials.imap_host
        || (/office365\.com|smtp-mail\.outlook\.com/i.test(host) ? 'outlook.office365.com' : host.replace(/^smtp\./i, 'imap.'));
      const imapPort = parseInt(credentials.imap_port || '993');

      try {
        const { ImapFlow } = await import('imapflow');
        const client = new ImapFlow({
          host: imapHost,
          port: imapPort,
          secure: imapPort === 993,
          auth: { user: username, pass: password },
          logger: false,
        });
        await client.connect();
        await client.logout();
        return { verified: true, message: `IMAP connected (${username} via ${imapHost})` };
      } catch (err) {
        return { verified: false, message: `IMAP connection failed: ${err.message || err.code || 'unknown'}` };
      }
    }
    if (p === 'apollo') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.apollo.io/v1/auth/health', {
        headers: { 'X-Api-Key': token, 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      if (r.ok) return { verified: true, message: 'Connected to Apollo' };
      if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Apollo API key' };
      return { verified: false, message: `Apollo returned ${r.status} — check your API key` };
    }
    if (p === 'prospeo') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch('https://api.prospeo.io/account-information', {
        method: 'POST',
        headers: { 'X-KEY': token, 'Content-Type': 'application/json' },
      });
      if (r.ok) return { verified: true, message: 'Connected to Prospeo' };
      if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Prospeo API key' };
      return { verified: false, message: `Prospeo returned ${r.status} — check your API key` };
    }
    if (p === 'apify') {
      if (!token) return { verified: false, message: 'No credentials provided' };
      const r = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`);
      if (r.ok) return { verified: true, message: 'Connected to Apify' };
      if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Apify token' };
      return { verified: false, message: `Apify returned ${r.status} — check your token` };
    }
    if (!token) return { verified: false, message: 'No credentials provided' };

    // Anything key-based that didn't match above already has a live test in
    // testNamedProvider — that's the one the Integrations page calls. Delegate
    // rather than maintain a second, thinner copy of the same checks: this is
    // how lemlist, findymail, millionverifier, neverbounce and cal_com went
    // untested on THIS path while being tested on the other one.
    if (TESTABLE_PROVIDERS.includes(p)) return await testNamedProvider(p, token);

    // Genuinely unknown provider. Fail closed.
    //
    // This used to return verified:true, which is the worst failure this product
    // can have: a mistyped key "connects", the integration shows green, and then
    // silently ingests nothing forever. Nobody goes looking for a broken
    // integration that says it is working. If a provider reaches this line the
    // fix is to give it a test, not to wave the key through.
    return {
      verified: false,
      message: `No connectivity test exists for "${provider}", so we can't confirm this key works and won't claim it does.`,
    };
  } catch (err) {
    const msg = err.message || 'Connection failed';
    return { verified: false, message: msg.includes('ECONNREFUSED') ? `Cannot connect to SMTP server — check host and port` : msg };
  }
}

export async function testNamedProvider(name, apiKey) {
  if (!apiKey) return { verified: false, message: 'API key is required' };

  if (name === 'apollo') {
    const r = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ reveal_personal_emails: false }),
    });
    if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Apollo API key' };
    return { verified: true, message: 'Apollo API key verified' };
  }

  if (name === 'instantly') {
    const r = await fetch('https://api.instantly.ai/api/v2/campaigns?limit=1', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) return { verified: true, message: 'Connected to Instantly' };
    return { verified: false, message: `Instantly returned ${r.status} — check your API key` };
  }

  if (name === 'emailbison') {
    // /api/users is what the EmailBison docs call out as the sample connectivity test
    const r = await fetch('https://dedi.emailbison.com/api/users', {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (r.ok) return { verified: true, message: 'Connected to EmailBison' };
    if (r.status === 401) return { verified: false, message: 'Invalid EmailBison API key' };
    return { verified: false, message: `EmailBison returned ${r.status} — check your API key` };
  }

  if (name === 'heyreach') {
    const r = await fetch('https://api.heyreach.io/api/public/auth/CheckApiKey', {
      headers: { 'X-API-KEY': apiKey, Accept: 'text/plain' },
    });
    if (r.ok) return { verified: true, message: 'Connected to HeyReach' };
    if (r.status === 401) return { verified: false, message: 'Invalid HeyReach API key' };
    return { verified: false, message: `HeyReach returned ${r.status} — check your API key` };
  }

  if (name === 'smartlead') {
    const r = await fetch(`https://server.smartlead.ai/api/v1/campaigns/?api_key=${encodeURIComponent(apiKey)}&limit=1`);
    if (r.ok) return { verified: true, message: 'Connected to Smartlead' };
    if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Smartlead API key' };
    return { verified: false, message: `Smartlead returned ${r.status} — check your API key` };
  }

  if (name === 'lemlist') {
    const r = await fetch('https://api.lemlist.com/api/team', {
      headers: { Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}` },
    });
    if (r.ok) return { verified: true, message: 'Connected to Lemlist' };
    return { verified: false, message: `Lemlist returned ${r.status} — check your API key` };
  }

  if (name === 'prospeo') {
    const r = await fetch('https://api.prospeo.io/domain-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-KEY': apiKey },
      body: JSON.stringify({ company: 'test.com', limit: 1 }),
    });
    if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Prospeo API key' };
    return { verified: true, message: 'Prospeo API key verified' };
  }

  if (name === 'findymail') {
    // Remaining-credits endpoint is the lightest connectivity check (no credit
    // spent). Bearer auth. NOTE: confirm the path against current Findymail docs.
    const r = await fetch('https://app.findymail.com/api/credits', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Findymail API key' };
    if (!r.ok) return { verified: false, message: `Findymail returned ${r.status} — check your API key` };
    return { verified: true, message: 'Findymail API key verified' };
  }

  if (name === 'millionverifier') {
    // The credits endpoint is the lightest connectivity check (no email spent).
    const r = await fetch(`https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(apiKey)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return { verified: false, message: d.error || 'Invalid MillionVerifier API key' };
    const credits = d.credits?.total ?? d.credits ?? null;
    return { verified: true, message: credits != null ? `Connected to MillionVerifier (${credits} credits)` : 'Connected to MillionVerifier' };
  }

  if (name === 'neverbounce') {
    const r = await fetch(`https://api.neverbounce.com/v4/account/info?key=${encodeURIComponent(apiKey)}`);
    const d = await r.json().catch(() => ({}));
    if (d.status && d.status !== 'success') return { verified: false, message: d.message || 'Invalid NeverBounce API key' };
    if (!r.ok) return { verified: false, message: `NeverBounce returned ${r.status} — check your API key` };
    return { verified: true, message: 'Connected to NeverBounce' };
  }

  if (name === 'hubspot') {
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) return { verified: true, message: 'Connected to HubSpot' };
    const e = await r.json().catch(() => ({}));
    return { verified: false, message: e.message || `HubSpot returned ${r.status} — check your private-app token` };
  }

  if (name === 'pipedrive') {
    const r = await fetch(`https://api.pipedrive.com/v1/users/me?api_token=${encodeURIComponent(apiKey)}`);
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const name = d.data?.name || d.data?.email || 'Pipedrive user';
      return { verified: true, message: `Connected as ${name}` };
    }
    return { verified: false, message: `Pipedrive returned ${r.status} — check your API token` };
  }

  if (name === 'attio') {
    const r = await fetch('https://api.attio.com/v2/self', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) return { verified: true, message: 'Connected to Attio' };
    const e = await r.json().catch(() => ({}));
    return { verified: false, message: e.message || `Attio returned ${r.status} — check your API key` };
  }

  if (name === 'calendly') {
    const r = await fetch('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const who = d.resource?.name || d.resource?.email || 'Calendly user';
      return { verified: true, message: `Connected as ${who}` };
    }
    return { verified: false, message: `Calendly returned ${r.status} — check your personal access token` };
  }

  if (name === 'fireflies') {
    const r = await fetch('https://api.fireflies.ai/graphql', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body:    JSON.stringify({ query: '{ user { name email } }' }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.data?.user?.email) return { verified: true, message: `Connected as ${d.data.user.email}` };
    return { verified: false, message: d.errors?.[0]?.message || 'Invalid Fireflies API key' };
  }

  if (name === 'fathom') {
    // Fathom's external API authenticates with X-Api-Key, NOT Authorization: Bearer.
    const r = await fetch('https://api.fathom.ai/external/v1/meetings?limit=1', {
      headers: { 'X-Api-Key': apiKey },
    });
    if (r.ok) return { verified: true, message: 'Connected to Fathom' };
    return { verified: false, message: `Fathom returned ${r.status} — check your API key` };
  }

  if (name === 'cal_com') {
    const r = await fetch('https://api.cal.com/v2/me', {
      headers: {
        Authorization:     `Bearer ${apiKey}`,
        'cal-api-version': CAL_COM_API_VERSION,
      },
    });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const me = d.data || d;
      const who = me.email || me.username || me.name || 'Cal.com user';
      return { verified: true, message: `Connected as ${who}` };
    }
    return { verified: false, message: `Cal.com returned ${r.status} — check your API key` };
  }

  if (name === 'apify') {
    // /v2/users/me is the lightest connectivity check (no actor run, no credits).
    const r = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(apiKey)}`);
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const who = d.data?.username || d.data?.email || 'Apify account';
      return { verified: true, message: `Connected to Apify (${who})` };
    }
    if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Apify token' };
    return { verified: false, message: `Apify returned ${r.status} — check your token` };
  }

  if (name === 'granola') {
    // Listing one note is the lightest connectivity check — no note is created and
    // it exercises the exact read scope the poller/handler need.
    const r = await fetch('https://public-api.granola.ai/v1/notes?page_size=1', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) return { verified: true, message: 'Connected to Granola' };
    if (r.status === 401 || r.status === 403) return { verified: false, message: 'Invalid Granola API key' };
    return { verified: false, message: `Granola returned ${r.status} — check your API key (it should start with grn_)` };
  }

  return { verified: false, message: 'Unknown provider' };
}

/**
 * RingCentral (GET-289): three questions, in the order a customer can act on the answers.
 *   1. Does the JWT exchange? (wrong paste, revoked, or restricted to a different app)
 *   2. Whose is it? (/extension/~ names the service user, so they see WHAT they connected)
 *   3. Can it read the COMPANY call log? A JWT for an ordinary user exchanges fine and reads only
 *      that user's calls — saved, it would show green and ingest one person's phone. So a 403 here
 *      fails the connect and says which permission is missing.
 */
async function testRingCentral(credentials) {
  if (!String(credentials.jwt || '').trim()) return { verified: false, message: 'Paste the JWT credential from the RingCentral Developer Console.' };
  if (credentials.client_id && !credentials.client_secret) return { verified: false, message: 'You entered a client ID — add its client secret too, or leave both empty to connect through the OpenNous app.' };
  const auth = ringCentralAuth(credentials);
  if (!auth) return { verified: false, message: 'RingCentral is not set up on this server yet (no RingCentral app configured). Enter your own app\'s client ID and secret, or ask us to enable it.' };

  try {
    await ringCentralToken(auth, { fresh: true });
  } catch (e) {
    const code = e instanceof RingCentralError ? e.code : null;
    if (code === 'invalid_client') return { verified: false, message: 'RingCentral rejected the app credentials. Check the client ID and secret, or leave both empty to connect through the OpenNous app.' };
    if (code === 'unauthorized_client') return { verified: false, message: 'This JWT is not allowed for this app. When creating the JWT, restrict it to the OpenNous app (or to your own app, if you entered its client ID) — or allow all apps in your organization.' };
    return { verified: false, message: `RingCentral rejected this JWT (${e.message}). Check it was copied whole and has not expired or been revoked.` };
  }

  const me = await ringCentralGet(auth, '/restapi/v1.0/account/~/extension/~');
  if (!me.ok) return { verified: false, message: `RingCentral accepted the JWT but would not say whose it is (${me.status}: ${me.message}).` };
  const who = me.data?.contact?.email || me.data?.name || 'RingCentral user';

  const log = await ringCentralGet(auth, '/restapi/v1.0/account/~/call-log', {
    perPage: 1, dateFrom: new Date(Date.now() - 86400000).toISOString(),
  });
  if (!log.ok && (log.status === 403 || log.status === 401)) {
    return { verified: false, message: `${who} cannot read the company call log. Create the JWT as a Super Admin (or a role with Full Company Call Log and company recordings access), so every rep's calls come in — not just one person's.` };
  }
  if (!log.ok && log.rateLimited) return { verified: false, message: 'RingCentral is rate limiting this app right now. Wait a minute and connect again.' };
  if (!log.ok) return { verified: false, message: `RingCentral returned ${log.status} reading the call log: ${log.message}` };

  // The address this JWT belongs to is evidence of which domain the WORKSPACE is (GET-291), and
  // we already have it — returning it costs nothing and saves a second round trip later.
  return { verified: true, message: `Connected as ${who} — reading your company call log`, accountEmail: me.data?.contact?.email || null };
}

// PostHog (GET-751): the project itself is the lightest read that proves the key, the project id
// and the host together, and names the project so the user sees WHICH one they connected.
export async function testPostHog(credentials, { fetchImpl = fetch } = {}) {
  const read = posthogSettings(credentials);
  if (!read.ok) {
    return { verified: false, message: read.reason === 'posthog_host_invalid'
      ? 'Enter us or eu for PostHog Cloud, or the https address of your own PostHog.'
      : 'Enter your PostHog project ID: the number after /project/ in your PostHog address.' };
  }
  const key = String(credentials?.api_key ?? '').trim();
  if (!key) return { verified: false, message: 'No PostHog personal API key provided' };
  if (key.startsWith('phc_')) return { verified: false, message: 'That is the project token, which can only send events. Create a personal API key (it starts with phx_) under Settings → Personal API keys.' };
  const { apiBase, projectId } = read.settings;
  if (!apiBase.endsWith('.posthog.com')) {
    try { await assertPublicUrl(apiBase); }
    catch { return { verified: false, message: `${new URL(apiBase).host} is not a public address we can reach.` }; }
  }
  try {
    const project = await posthogRequest(key, apiBase, `/api/projects/${projectId}/`, { fetchImpl });
    return { verified: true, message: `Connected to ${project?.name ? `"${project.name}"` : `project ${projectId}`} on ${new URL(apiBase).host}` };
  } catch (err) {
    if (err.status === 401) return { verified: false, message: 'PostHog rejected this key. Check it was copied whole and has not been revoked.' };
    if (err.status === 403) return { verified: false, message: `This key cannot read project ${projectId}. Give it the Project read scope, and access to this project.` };
    if (err.status === 404) return { verified: false, message: `No project ${projectId} on ${new URL(apiBase).host}. Check the project ID and the region (us or eu).` };
    return { verified: false, message: `PostHog returned ${err.status ?? 'an error'}: ${err.message}` };
  }
}
