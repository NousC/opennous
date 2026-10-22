#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Update a self-hosted Nous instance to the latest release.
#
#   1. pulls the latest code from your current branch
#   2. rebuilds + restarts the containers (api, worker, mcp, frontend)
#   3. reminds you to apply any new database migrations (on the bundled stack,
#      docker-compose.selfhost.yaml, step 2 already applied them)
#
# Run it from the repo root on your server:  ./update.sh
#
# Released images instead of building (GET-758): set NOUS_VERSION in nous.env (or the
# environment) to a release, e.g. NOUS_VERSION=1.2.3, or NOUS_VERSION=latest for the newest
# release tag. Then this checks out that tag, pulls ghcr.io/nousc/opennous-* images through
# docker-compose.release.yaml and restarts, without building. Without NOUS_VERSION nothing
# changes: pull the branch, rebuild, restart.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

# The whole release path lives in this function: bash parses a function body before running
# it, so checking out another tag (which rewrites this file) cannot change what runs next.
update_to_release() {
  local want="${1#v}" tag ver files
  echo "→ Fetching release tags…"
  git fetch --tags --force --quiet origin
  if [ "$want" = "latest" ]; then
    # Newest stable release: a pre-release (v1.3.0-rc.1) is never "latest".
    tag=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | { grep -v -e '-' || true; } | head -n1)
    [ -n "$tag" ] || { echo "✗ No release tags (vX.Y.Z) found on origin." >&2; exit 1; }
  else
    tag="v${want}"
    git rev-parse -q --verify "refs/tags/${tag}" >/dev/null \
      || { echo "✗ No release ${tag}. Releases: $(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -n5 | tr '\n' ' ')" >&2; exit 1; }
  fi
  ver="${tag#v}"

  echo "→ Checking out ${tag}…"
  git -c advice.detachedHead=false checkout --quiet "${tag}"

  COMMIT=$(git rev-parse --short HEAD)
  if grep -q '^APP_COMMIT=' nous.env 2>/dev/null; then
    sed -i.bak "s|^APP_COMMIT=.*|APP_COMMIT=${COMMIT}|" nous.env && rm -f nous.env.bak
  else
    echo "APP_COMMIT=${COMMIT}" >> nous.env
  fi
  echo "  release: ${ver} (${COMMIT})"

  # Layer docker-compose.release.yaml on whatever stack this install runs. The shell value
  # wins over nous.env for both variables, so nous.env itself is left as it is.
  files="${COMPOSE_FILE:-$( (sed -n 's/^COMPOSE_FILE=//p' nous.env 2>/dev/null || true) | tail -n1 | tr -d "\"' \r")}"
  files="${files:-docker-compose.yaml}"
  case ":${files}:" in
    *:docker-compose.release.yaml:*) ;;
    *) files="${files}:docker-compose.release.yaml" ;;
  esac
  # The list is joined with ':' on every OS; Windows compose needs telling (GET-1013).
  export COMPOSE_FILE="${files}" COMPOSE_PATH_SEPARATOR=":" NOUS_VERSION="${ver}"

  echo "→ Pulling images ghcr.io/nousc/opennous-*:${ver}…"
  if ! docker compose --env-file nous.env pull api worker mcp frontend; then
    echo "⚠  Pull failed; services without an image are built from source by the next step."
  fi
  echo "→ Restarting containers…"
  docker compose --env-file nous.env up -d

  echo
  echo "✓ Nous ${ver} running."
  echo
  case ":${files}:" in
    *:docker-compose.selfhost.yaml:*)
      echo "✓ Database migrations applied by the db-schema service (bundled database)."
      echo "   See what ran: docker compose --env-file nous.env logs db-schema"
      ;;
    *)
      echo "⚠  Database changes are NOT applied automatically."
      echo "   Run any supabase/migrations files new since your last release in your"
      echo "   Supabase SQL editor (oldest first). They're idempotent."
      ;;
  esac
  echo "   Back to building from source: remove NOUS_VERSION from nous.env, then"
  echo "   git checkout main && ./update.sh"
  exit 0
}

NOUS_VERSION_WANTED="${NOUS_VERSION:-$( (sed -n 's/^NOUS_VERSION=//p' nous.env 2>/dev/null || true) | tail -n1 | tr -d "\"' \r")}"
if [ -n "${NOUS_VERSION_WANTED}" ]; then
  update_to_release "${NOUS_VERSION_WANTED}"
fi

echo "→ Pulling latest code…"
git pull --ff-only

# Stamp the running build so the in-app version widget can show it + detect updates.
COMMIT=$(git rev-parse --short HEAD)
if grep -q '^APP_COMMIT=' nous.env 2>/dev/null; then
  sed -i.bak "s|^APP_COMMIT=.*|APP_COMMIT=${COMMIT}|" nous.env && rm -f nous.env.bak
else
  echo "APP_COMMIT=${COMMIT}" >> nous.env
fi
echo "  build: ${COMMIT}"

# Installs set up before WORKER_SECRET existed: give them one, so the api <-> worker
# internal calls (deal overview, account summary, automations) switch on.
if [ -f nous.env ] && ! grep -Eq '^WORKER_SECRET=.+' nous.env; then
  sed -i.bak '/^WORKER_SECRET=$/d' nous.env && rm -f nous.env.bak
  printf '\nWORKER_SECRET=%s\n' "$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" >> nous.env
  echo "→ Added WORKER_SECRET to nous.env"
fi

echo "→ Rebuilding and restarting containers (this can take a few minutes)…"
docker compose --env-file nous.env up -d --build

echo
echo "✓ App updated and running."
echo

# Bundled stack (docker-compose.selfhost.yaml, set up by scripts/selfhost-keys.mjs):
# its db-schema service applied any new supabase/migrations files during the `up`
# above. Detected from COMPOSE_FILE in nous.env or the environment; an install
# without it (an external Supabase project) gets the manual instructions below.
if { [ -n "${COMPOSE_FILE:-}" ] && printf '%s' "$COMPOSE_FILE" | grep -q 'docker-compose.selfhost.yaml'; } \
  || grep -Eq '^COMPOSE_FILE=.*docker-compose\.selfhost\.yaml' nous.env 2>/dev/null; then
  echo "✓ Database migrations applied by the db-schema service (bundled database)."
  echo "   See what ran: docker compose --env-file nous.env logs db-schema"
  echo "   Do not run supabase/migrations files by hand here; the ledger in"
  echo "   selfhost.schema_migrations tracks what this database already has."
  exit 0
fi

echo "⚠  Database changes are NOT applied automatically."
echo "   If supabase/migrations/ has new files since your last update, open each"
echo "   (newest by date) in your Supabase SQL editor and run it. They're"
echo "   idempotent, so re-running an already-applied one is safe."
echo "   (A brand-new install instead runs supabase/schema.sql once.)"
