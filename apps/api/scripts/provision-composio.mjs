#!/usr/bin/env node
/**
 * Provision Composio for one Nous box (Gmail + Google Calendar).
 *
 * This automates steps 2–4 of the 5-step recipe. Step 1 (create the Composio PROJECT and get
 * its API key) is a dashboard/account-level action — the @composio/core SDK has no `projects`
 * namespace — so do that first and pass the project key in as COMPOSIO_API_KEY. Step 5 (deploy)
 * is your normal VPS deploy.
 *
 *   1. [manual] dashboard.composio.dev → create a project → copy its API key (ak_…).
 *   2. [this script] create Gmail + Calendar auth configs (Composio-managed OAuth by default).
 *   3. [this script] set the project webhook → https://<their-host>/inbound/composio.
 *   4. [this script] prints the 4 env vars to paste into their .env.
 *   5. [manual] deploy.
 *
 * USAGE
 *   COMPOSIO_API_KEY=<project key> \
 *   node apps/api/scripts/provision-composio.mjs \
 *     --host https://api.opennous.cloud \
 *     [--google-client-id <id> --google-client-secret <secret>]   # omit → Composio-managed OAuth (NOT white-labeled)
 *     [--base-url http://composio:PORT]                            # self-hosted Composio
 *     [--dry-run]                                                  # print the plan, call nothing
 *
 * NOTE: exact arg shapes for authConfigs.create / triggers.setWebhookSubscription vary by
 * Composio version — the calls below are best-effort. Run with --dry-run first, then against a
 * real (test) project. On a create error the script prints the toolkit's required creation
 * fields (toolkits.getAuthConfigCreationFields) so you can see what it wants.
 */

import { Composio } from '@composio/core';

// v1 toolkits: Gmail + Google Calendar. The env var each id lands in.
const TOOLKITS = [
  { slug: 'gmail',          envVar: 'COMPOSIO_AUTHCONFIG_GMAIL' },
  { slug: 'googlecalendar', envVar: 'COMPOSIO_AUTHCONFIG_GOOGLECALENDAR' },
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = args['host'] || args['vps-url'];
  const googleClientId = args['google-client-id'];
  const googleClientSecret = args['google-client-secret'];
  const baseUrl = args['base-url'] || process.env.COMPOSIO_BASE_URL;
  const apiKey = process.env.COMPOSIO_API_KEY;
  const dryRun = !!args.dryRun;

  if (!host) die('Missing --host (the public API/worker base URL, e.g. https://api.opennous.cloud).');
  if (!apiKey && !dryRun) die('Missing COMPOSIO_API_KEY (the PROJECT key from the Composio dashboard — step 1).');
  const webhookUrl = `${host.replace(/\/$/, '')}/inbound/composio`;
  const usingOwnApp = !!(googleClientId && googleClientSecret);

  console.log('\nComposio provisioning (Gmail + Google Calendar)');
  console.log(`  project key   : ${apiKey ? apiKey.slice(0, 8) + '…' : '(dry-run, none)'}`);
  console.log(`  webhook URL   : ${webhookUrl}`);
  console.log(`  OAuth app     : ${usingOwnApp ? "Nous's Google app (white-labeled)" : 'Composio-managed (⚠ shows composio.dev on consent)'}`);
  console.log(`  Composio host : ${baseUrl || 'cloud'}`);
  console.log(`  mode          : ${dryRun ? 'DRY RUN (no calls)' : 'LIVE'}\n`);

  if (dryRun) {
    console.log('Would create auth configs for:', TOOLKITS.map(t => t.slug).join(', '));
    console.log('Would set project webhook to:', webhookUrl);
    console.log('\nThen print COMPOSIO_API_KEY / COMPOSIO_WEBHOOK_SECRET / COMPOSIO_AUTHCONFIG_* for the .env.\n');
    return;
  }

  const composio = new Composio({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const out = { COMPOSIO_API_KEY: apiKey };

  // Step 2 — auth configs, one per toolkit. Reuse an existing one for the toolkit if present
  // (idempotent re-runs), else create.
  //   type 'use_composio_managed_auth'  → Composio's OAuth app (consent shows composio.dev)
  //   type 'use_custom_auth' + OAUTH2 + { client_id, client_secret } → Nous's app (white-labeled)
  let existing = [];
  try { const l = await composio.authConfigs.list(); existing = l?.items || l?.data || []; } catch { /* fall through to create */ }

  for (const { slug, envVar } of TOOLKITS) {
    const found = existing.find((i) => (i.toolkit?.slug || i.toolkitSlug) === slug);
    if (found) {
      out[envVar] = found.id || found.nanoId;
      console.log(`• auth config ${slug} → ${out[envVar]} (reused existing)`);
      continue;
    }
    try {
      const cfg = await composio.authConfigs.create(slug, {
        name: `nous-${slug}`,
        ...(usingOwnApp
          ? { type: 'use_custom_auth', authScheme: 'OAUTH2', credentials: { client_id: googleClientId, client_secret: googleClientSecret } }
          : { type: 'use_composio_managed_auth' }),
      });
      const id = cfg?.id || cfg?.nanoId || cfg?.authConfigId;
      if (!id) throw new Error(`created but no id in response: ${JSON.stringify(cfg).slice(0, 200)}`);
      out[envVar] = id;
      console.log(`✓ auth config ${slug} → ${id} (created)`);
    } catch (err) {
      console.error(`✗ auth config ${slug}: ${err.message}`);
      try {
        const fields = await composio.toolkits.getAuthConfigCreationFields(slug);
        console.error(`  ${slug} creation fields:`, JSON.stringify(fields, null, 2));
      } catch { /* best effort */ }
      die(`Failed creating the ${slug} auth config — see required fields above, adjust the create() call, retry.`);
    }
  }

  // Step 3 — project webhook → the box's public /inbound/composio.
  try {
    const wh = await composio.triggers.setWebhookSubscription({ webhookUrl });
    const secret = wh?.webhookSecret || wh?.secret || null;
    if (secret) out.COMPOSIO_WEBHOOK_SECRET = secret;
    console.log(`✓ webhook → ${webhookUrl}${secret ? ' (secret captured)' : ' (⚠ no secret returned — copy it from the dashboard)'}`);
  } catch (err) {
    console.error(`✗ webhook: ${err.message}`);
    console.error('  Set it manually in the Composio dashboard → project webhook → ' + webhookUrl + ', then copy the signing secret.');
  }

  // Step 4 — the env block to paste into the box's .env.
  console.log('\n─── paste into the box .env ───');
  for (const k of ['COMPOSIO_API_KEY', 'COMPOSIO_WEBHOOK_SECRET', 'COMPOSIO_AUTHCONFIG_GMAIL', 'COMPOSIO_AUTHCONFIG_GOOGLECALENDAR']) {
    console.log(`${k}=${out[k] ?? '   # <-- fill from dashboard'}`);
  }
  if (baseUrl) console.log(`COMPOSIO_BASE_URL=${baseUrl}`);
  console.log('──────────────────────────────\n');
  console.log('Then: deploy the box. Members connect via `nous connect gmail` / `nous connect calendar` or the Integrations page.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
