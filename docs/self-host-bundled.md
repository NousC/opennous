# Self-host with the bundled database and auth

`docker-compose.selfhost.yaml` runs Nous with its own Postgres and its own auth
server, so you do not need a Supabase account. It sits on top of
`docker-compose.yaml`; that file on its own still runs the app against an external
Supabase project, unchanged.

## What runs

| Service | Image | Job |
|---|---|---|
| `db` | `pgvector/pgvector:pg17` | Postgres 17 with pgvector. Data in the `nous_pgdata` volume. |
| `auth` | `supabase/gotrue` | Supabase's auth server: sign-up, sign-in, password reset, magic links. |
| `db-schema` | `pgvector/pgvector:pg17` | One-shot, every start. Applies `supabase/schema.sql` to a fresh database, then any new `supabase/migrations` files, then grants. Exits. |
| `postgrest` | `postgrest/postgrest` | The REST layer `supabase-js` talks to. Internal only. |
| `api`, `worker`, `mcp`, `frontend` | built from this repo | The app, as in `docker-compose.yaml`. |
| `caddy` | `caddy:2-alpine` | TLS and routing, with `deploy/selfhost/Caddyfile`. |

Routing:

- `https://$APP_DOMAIN/auth/v1/*` goes to GoTrue. The browser's Supabase URL is
  `https://$APP_DOMAIN`. Everything else on that domain is the frontend.
- `https://$API_DOMAIN` is the API (`/inbound/*` goes to the worker). `/internal/*` answers
  404 from outside: those routes are for the worker, which calls the API on the compose
  network (`NOUS_API_INTERNAL_URL=http://api:3000`), never through Caddy.
- `https://$MCP_DOMAIN` is the hosted MCP server.
- `http://supabase:8000` exists only inside the compose network. The API, worker
  and MCP use it as `SUPABASE_URL`: `/rest/v1` goes to PostgREST, `/auth/v1` to GoTrue.
  PostgREST is never published, so the anon key cannot read tables from outside.

## Run it

You need Docker with Compose v2.24 or newer, Node 18+ (for the key script), three
DNS records (`app`, `api`, `mcp`) pointing at the server, and an AI provider key: one
OpenRouter key runs every model (recommended), or Anthropic, or any OpenAI-compatible endpoint.

```bash
git clone https://github.com/NousC/opennous.git && cd opennous
cp nous.env.example nous.env
# edit nous.env: APP_DOMAIN, API_DOMAIN, MCP_DOMAIN, OPENROUTER_API_KEY (or ANTHROPIC_API_KEY)
node scripts/selfhost-keys.mjs nous.env
docker compose --env-file nous.env up -d --build
```

The key script ends by printing the owner's setup link,
`https://$APP_DOMAIN/signup?setup=<SELFHOST_SETUP_TOKEN>`. Open it and create the first
account; it becomes the owner. A sign-up without that token is refused, even on an
empty instance, so whoever reaches the page first cannot take it over. Lost the link?
The token is `SELFHOST_SETUP_TOKEN` in `nous.env`, and
`docker compose --env-file nous.env logs db-schema` prints the link for as long as
there is no owner. After that the instance is closed: nobody else gets an account
unless you invite them with a join link (Settings → Members → Create invite). See
[Who can sign up](#who-can-sign-up).

`./update.sh` works the same way: it runs `docker compose --env-file nous.env`,
and `nous.env` names both compose files through `COMPOSE_FILE`. The `db-schema`
service applies new database migrations during that run (see [Database](#database)).

The key script refuses an env file that looks like a Nous Cloud or external-Supabase
one (`SUPABASE_URL` on `*.supabase.co`, or any `CLERK_*` key set), since it would
overwrite its URL, auth provider and secrets. Give the bundled stack its own file.
It leaves `nous.env` readable by its owner only (mode 600).

One install, one workspace per team: creating a second workspace is refused
(`self_hosted_workspace_limit`). The fictional demo workspace (`supabase/seed/demo.sql`,
removed again by `supabase/seed/demo-reset.sql`) has its own team, so it does not count.

### Ports

Caddy publishes 80 and 443 on the host. If something else already holds them, set
`HTTP_PORT` and `HTTPS_PORT` in `nous.env` (for example `8080` and `8443`). The app still
builds every link, redirect and email URL as `https://$APP_DOMAIN` (and `https://$API_DOMAIN`,
`https://$MCP_DOMAIN`), with no port, so on another HTTPS port those links only work when
something in front (a load balancer, a router port-forward) serves them on 443.

The api, worker, mcp and frontend containers have health checks (`docker compose ps` shows
`healthy`): the api, worker and mcp answer `GET /health`, the frontend its index page.

## Environment

`scripts/selfhost-keys.mjs` writes these into `nous.env`. It keeps values that are
already set, so running it twice is safe. `--force` regenerates everything; do not
use that on an install that already has data.

| Variable | What it is |
|---|---|
| `POSTGRES_PASSWORD` | Password for `postgres`, and for the `authenticator` (PostgREST) and `supabase_auth_admin` (GoTrue) roles. Fixed at first boot. |
| `SUPABASE_JWT_SECRET` | HS256 secret. GoTrue signs sessions with it; the API and PostgREST verify with it. |
| `SUPABASE_ANON_KEY`, `VITE_SUPABASE_ANON_KEY` | JWT with `role: anon`, signed with the secret. Public; built into the frontend. |
| `SUPABASE_SERVICE_ROLE_KEY` | JWT with `role: service_role`. Server-side only. |
| `ENCRYPTION_KEY` | 32-byte hex. Encrypts OAuth tokens at rest. |
| `SELFHOST_SETUP_TOKEN` | One-time secret. Only the sign-up that presents it becomes the owner. Useless once the owner exists. |
| `SUPABASE_URL` | `http://supabase:8000`, the internal gateway. |
| `VITE_SUPABASE_URL` | `https://$APP_DOMAIN`. |
| `SELF_HOSTED`, `AUTH_PROVIDER`, `VITE_AUTH_PROVIDER` | `true`, `supabase`, `supabase`. |
| `COMPOSE_FILE` | `docker-compose.yaml:docker-compose.selfhost.yaml`. |
| `COMPOSE_PATH_SEPARATOR` | `:`, so the same `COMPOSE_FILE` line works on Windows. |
| `DISABLE_SIGNUPS` | `true` (only if unset). Only the setup-token sign-up becomes the owner; after that only invitees. |
| `GOTRUE_MAILER_AUTOCONFIRM` | Only if unset: `false` when `SMTP_HOST` is set, else `true`. |
| `APP_COMMIT` | The checkout's short commit, for the sidebar's version widget (`./update.sh` keeps it current). Skipped outside a git checkout. |

Optional, read by the compose file:

| Variable | Default | Effect |
|---|---|---|
| `DISABLE_SIGNUPS` | `true` | Read by the API. `false` opens the instance: anyone who signs up gets their own team, on your AI keys. |
| `GOTRUE_MAILER_AUTOCONFIRM` | `true` | New accounts are confirmed at once and sign-up returns a session. Also passed to the API (as `AUTH_EMAIL_AUTOCONFIRM`), which then never trusts an email address on its own. |
| `GOTRUE_DISABLE_SIGNUP` | `false` | `true` closes sign-up at the auth server, which also stops the owner and invitees from creating their login. Leave it `false`; `DISABLE_SIGNUPS` is the gate. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | unset, `587` | Mail server GoTrue sends through. |
| `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` | unset, `Nous` | From address and name. |
| `HTTP_PORT`, `HTTPS_PORT` | `80`, `443` | Host ports Caddy listens on. See [Ports](#ports). |
| `VITE_EXTERNAL_IMAGES` | `true` | Company favicons (Google) and people photos (Gravatar). `false` keeps every image request on your host. Rebuild the frontend after changing it. |

## Who can sign up

Sign-up at the auth server (GoTrue) stays open, because the owner and every invitee
create their login there. What a login gets is decided by the API:

- The owner: the one sign-up that presents `SELFHOST_SETUP_TOKEN` (the setup link).
  The claim is a single row in `public.selfhost_instance_owner`, written atomically,
  so two people signing up at the same moment cannot both become owner.
- With `DISABLE_SIGNUPS=true` (the default), any other login that does not hold an
  invitation gets no account: no team, no workspace, nothing that spends your
  AI keys. The login page shows no "Create account" link.
- A teammate joins with a join token: Settings → Members → Create invite gives a
  `npx @opennous/cli join <token>` command (add `--url https://$API_DOMAIN`). They
  run it, the browser opens on the approval page, they create a login there (the
  sign-up page stays reachable from it), approve, and land in your workspace. The
  token is the proof; nothing is decided by their email address. (Email invites into
  the app are a Cloud plan feature and are refused on self-host. An email invitation
  that exists anyway is joined only through its link's token, never by matching the
  address.)

Without SMTP, GoTrue confirms every address at sign-up without sending anything, so
an address proves nothing: anyone can sign up as `someone@yourcompany.com`. The API
knows this (`AUTH_EMAIL_AUTOCONFIRM`) and then never hands anything over by email
match: an invitation is joined only through its token, a pending seat is not applied,
and a login is never bound to an existing user row by email. For the same reason a
join token cannot be limited to an email domain under autoconfirm: creating one with a
domain is refused, and an existing one cannot be redeemed (`domain_lock_unavailable`).
Treat the join link itself as the secret. With SMTP and
`GOTRUE_MAILER_AUTOCONFIRM=false`, addresses are confirmed by email.

Someone who signs up with a teammate's address first takes that login (they still
cannot join without a token). Delete it with
`docker compose --env-file nous.env exec db psql -U postgres -c "delete from auth.users where email = '...'"`.

## Email

Without SMTP, `GOTRUE_MAILER_AUTOCONFIRM` is `true`. Email and password sign-up
and sign-in work. Anything that needs an email from the auth server does not:
password reset and magic links. Join links still work: you hand the link to the
teammate yourself.

With SMTP set, all of those work, and the key script sets
`GOTRUE_MAILER_AUTOCONFIRM=false` so people confirm their address before they sign
in. Links in those emails point at `https://$APP_DOMAIN/auth/v1/verify`.

### Adding SMTP later

1. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `SMTP_ADMIN_EMAIL` in
   `nous.env`, and change `GOTRUE_MAILER_AUTOCONFIRM` to `false` (the key script does
   not change a value that is already set).
2. `docker compose --env-file nous.env up -d`. Both `auth` and `api` read the new value.

Accounts created while autoconfirm was on keep their "confirmed" stamp in GoTrue, but
the API does not count it: GoTrue never sent them an email, so the stamp proves
nothing about the address. An address counts as proven only when a confirmation or
invite email was sent and then followed (`confirmation_sent_at` / `invited_at` before
`email_confirmed_at`), when an OAuth provider vouches for it, or when the account was
created by the operator with the address marked confirmed. So someone who signed up
as `ceo@yourcompany.com` back when anyone could does not start claiming invitations,
pending seats or that person's user row the moment you add SMTP. Those older accounts
keep working for sign-in and keep whatever they already joined.

## AI models

OpenNous runs its background AI work on your own keys: reading calls and email, writing
summaries and reports, and the Insights board. Each job has its own model:

| Job | Setting | Default |
|---|---|---|
| Reading calls and email | `EXTRACTION_MODEL` | `claude-haiku-4-5-20251001` |
| Writing summaries and reports | `WRITING_MODEL` | `z-ai/glm-5.2` (falls back to the reading model) |
| Insights board | `INSIGHT_BOARD_MODEL` | `anthropic/claude-haiku-4.5` |

How a model id is served:

- An id that starts with `claude-` runs on OpenRouter when `OPENROUTER_API_KEY` is set, else on
  `ANTHROPIC_API_KEY`.
- Any other id runs on an OpenAI-compatible endpoint: OpenRouter by default
  (`OPENROUTER_API_KEY`), or whatever `LLM_BASE_URL` names, keyed by `LLM_API_KEY`. That
  covers OpenAI, Groq, Together, Fireworks, LiteLLM, and a local Ollama
  (`LLM_BASE_URL=http://host.docker.internal:11434/v1`, no key; on Linux, add
  `extra_hosts: ["host.docker.internal:host-gateway"]` to the api and worker services).

So OpenRouter alone is one key for everything (the defaults work as they are), Anthropic alone
is one key (set the models to `claude-…` ids), and you can mix them.
**Settings → Instance setup** shows which model runs each job, whether its key is set, and
recommended setups to copy. Change the settings in `nous.env`, then
`docker compose --env-file nous.env up -d`.

A Claude Pro or Max subscription cannot run these jobs: Anthropic allows it only inside its own
apps. Your agent in Claude Code does use it, since it talks to OpenNous over MCP.

Search embeddings are separate and optional: `OPENAI_API_KEY` (OpenAI `text-embedding-3-small`).
Without it, search falls back to structured retrieval.

## Integrations

Most integrations need nothing from you as the operator: each person pastes a key from that
tool into **Integrations**, and it works on any install. Two use OAuth, and OAuth needs an app
registered in your name with that vendor, so they stay off until you set one up.
**Settings → Instance setup** shows which are ready on your install.

| Integration | What it needs |
|---|---|
| HubSpot | Nothing. A HubSpot admin creates a private app and pastes its access token. |
| Attio | Nothing. An Attio admin creates an access token and pastes it. |
| Fireflies, Granola, Fathom | Nothing. Each person pastes their own API key. |
| Gmail and Google Calendar | Your Google OAuth app (below). |
| Salesforce | Your Salesforce connected app (below). |

### Gmail and Google Calendar

1. In Google Cloud Console, create a project, then **APIs & Services → Library**: enable the
   Gmail API and the Google Calendar API.
2. **OAuth consent screen**: user type *External* (or *Internal* on Google Workspace), add
   the scopes `openid`, `userinfo.email`, `gmail.readonly` and `calendar.readonly`. While the
   app is in *Testing*, add every person who will connect as a test user.
3. **Credentials → Create credentials → OAuth client ID**, type *Web application*. Authorized
   redirect URI: `https://<API_DOMAIN>/api/oauth/google/callback`.
4. Put the client ID and secret in `nous.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   (leave `GOOGLE_OAUTH_REDIRECT_URI` empty to derive it from `API_DOMAIN`), then
   `docker compose --env-file nous.env up -d`.

Members then see **Connect with Google** on the Integrations page.

### Salesforce

1. In Salesforce **Setup → App Manager → New Connected App** (or *External Client App* in
   newer orgs). Enable OAuth settings.
2. Callback URL: `https://<API_DOMAIN>/api/workflow-providers/salesforce/oauth/callback`.
   Scopes: *Manage user data via APIs (api)* and *Perform requests at any time
   (refresh_token, offline_access)*. Require PKCE.
3. Put the consumer key and secret in `nous.env` as `SALESFORCE_CLIENT_ID` and
   `SALESFORCE_CLIENT_SECRET`, and `SALESFORCE_REDIRECT_URI` as the callback above. For a
   sandbox, set `SALESFORCE_LOGIN_URL=https://test.salesforce.com`.
4. `docker compose --env-file nous.env up -d`. An owner or admin connects it from
   **Shared integrations**.

## What is not bundled

- Supabase Storage. The only user is `runtime:sandbox` skill output upload, which is
  best-effort: without Storage the run still returns its text output, just no
  download link. Sandbox skills are part of the Cloud-only Workspace layer anyway.
- Realtime and edge functions. The app uses neither.
- Studio (the Supabase dashboard). Use `docker compose --env-file nous.env exec db psql -U postgres`.
- OAuth sign-in providers (Google, GitHub) on GoTrue. Email and password only, unless
  you add the `GOTRUE_EXTERNAL_*` settings yourself.

## Database

- Schema: `supabase/schema.sql`, applied once, on first boot, by `db-schema`.
- Migrations: `db-schema` runs on every `docker compose up` (so on every
  `./update.sh`) and applies the files in `supabase/migrations/` this database does
  not have yet, each in its own transaction. Order is by date, the same one
  `scripts/check-schema-baseline.sh` uses: the `YYYY_MM_DD_` prefix, or for the few
  undated files the date in `supabase/undated-migrations.txt`, then filename. A file
  with its own transaction control (`BEGIN`, `START TRANSACTION`, `COMMIT`, `END`) or
  `CONCURRENTLY` runs without the wrapper. What a database has
  is recorded in `selfhost.schema_migrations`. On first boot that ledger is seeded,
  without running anything, with the files `schema.sql` already contains
  (`supabase/schema-baseline-migrations.txt`, or every file present when the
  checkout has no such list). Do not run migration files by hand; some older ones
  target an earlier schema and would undo later changes.
- The ledger is by filename. A migration file that is edited after it ran on this
  database is never run again; changes go in a new file.
  `docker compose --env-file nous.env logs db-schema` shows what ran.
- A database first set up from a release of 2026-10-15 or earlier can hold a few
  tables that belong to Nous Cloud features and are no longer in this schema. They
  are left in place (nothing drops them), unused, and their files stay in the ledger.
- A migration that fails stops `db-schema`, and the API does not start until it
  passes, so the app never runs against a half-migrated database. Nothing from the
  failed file is kept. Fix the cause and run `docker compose --env-file nous.env up -d`
  again.
- Backup: `docker compose --env-file nous.env exec -T db pg_dump -U postgres postgres > backup.sql`.
- `docker compose down -v` deletes the `nous_pgdata` volume, which is the whole database.

## Trying it on a laptop

Works on macOS (Docker Desktop, Colima or OrbStack), Windows (Docker Desktop with WSL2) and
Linux, on Intel and ARM. Set `APP_DOMAIN=localhost`, `API_DOMAIN=api.localhost`,
`MCP_DOMAIN=mcp.localhost`. Nothing else changes: `*.localhost` points at your own machine.

Caddy serves those names with its own local certificate authority, which your machine does
not trust yet. So the browser warns the first time (continue past it, or trust the CA below),
`curl` needs `-k`, and the CLI and other Node tools refuse to connect until you hand them the
certificate. Copy it out of the Caddy container once:

```bash
docker compose --env-file nous.env cp caddy:/data/caddy/pki/authorities/local/root.crt caddy-root.crt
```

Point Node at it (the CLI, `npx @opennous/cli init --url https://api.localhost`, any MCP client).
Until you do, the CLI stops with a one-line "certificate isn't trusted" message that links here:

```bash
export NODE_EXTRA_CA_CERTS="$PWD/caddy-root.crt"        # macOS, Linux, WSL2
$env:NODE_EXTRA_CA_CERTS = "$PWD\caddy-root.crt"         # Windows PowerShell
```

Or trust it system-wide so the browser stops warning too (undo by deleting the certificate):

```bash
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-root.crt
# Windows, PowerShell as administrator
Import-Certificate -FilePath caddy-root.crt -CertStoreLocation Cert:\LocalMachine\Root
# Debian / Ubuntu (Chrome and Firefox on Linux keep their own store: import it there as well)
sudo cp caddy-root.crt /usr/local/share/ca-certificates/caddy-local.crt && sudo update-ca-certificates
```

On Windows, clone the repo inside WSL2 (`~/opennous`, not `/mnt/c/...`): builds are much
faster and line endings stay LF. A clone on the Windows side also works; the repo's
`.gitattributes` keeps the scripts the containers run in LF either way.
