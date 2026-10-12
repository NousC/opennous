#!/bin/sh
# One-shot schema step for the bundled stack (the `db-schema` service). Runs on every
# `docker compose up`, so ./update.sh migrates a bundled install with no extra step.
#
# Runs after GoTrue has created the auth schema (schema.sql has foreign keys to
# auth.users and policies that call auth.uid()).
#
#   1. Fresh database: applies supabase/schema.sql in one transaction.
#   2. Ledger: selfhost.schema_migrations records every supabase/migrations file this
#      database has, by filename. When the ledger is first created it is seeded with
#      the files schema.sql already contains, which are NOT run:
#        - supabase/schema-baseline-migrations.txt when the checkout has it (the list
#          of files folded into schema.sql), else
#        - every file in supabase/migrations at that moment (schema.sql is taken to
#          be current as of this checkout, as supabase/migrations/README.md says).
#   3. Migrate: applies each file in supabase/migrations missing from the ledger, and
#      records it. Order is the one scripts/check-schema-baseline.sh uses: by date (the
#      YYYY_MM_DD_ prefix; undated files by the date in supabase/undated-migrations.txt),
#      then by filename. Each file runs in its own transaction together with its ledger
#      row, so a failure leaves nothing half-applied and nothing recorded. A file that
#      cannot run in a transaction (CONCURRENTLY, or its own BEGIN / START TRANSACTION /
#      COMMIT / END, looked for outside comments and $$ function bodies) runs on its own
#      and is recorded after it succeeds.
#      The ledger is by filename: a file that is edited after it ran is never run again.
#      A failure stops here with a non-zero exit, so the API does not start against a
#      half-migrated database. Fix the cause and run `docker compose up -d` again. To
#      skip a file on purpose, record it by hand:
#        insert into selfhost.schema_migrations (filename, how) values ('<file>', 'manual');
#   4. Grants and the owner-claim table (post-schema.sql), idempotent, every start.
#   5. While the instance has no owner, prints the setup link (SELFHOST_SETUP_TOKEN).
set -eu

export PGHOST=db PGUSER=postgres PGDATABASE=postgres PGPASSWORD="$POSTGRES_PASSWORD"

SUPA=/supabase
MIGRATIONS="$SUPA/migrations"
BASELINE="$SUPA/schema-baseline-migrations.txt"
UNDATED="$SUPA/undated-migrations.txt"
LEDGER=selfhost.schema_migrations

q() { psql -v ON_ERROR_STOP=1 -X -q "$@"; }
val() { psql -v ON_ERROR_STOP=1 -X -tA -c "$1"; }
sqlstr() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

# The date a migration file sorts under: its YYYY_MM_DD_ prefix, or for an undated file
# the date in supabase/undated-migrations.txt. An undated file not listed there sorts
# last (scripts/check-schema-baseline.sh refuses those, so it should not happen).
file_date() {
  case "$1" in
    [0-9][0-9][0-9][0-9]_[0-9][0-9]_[0-9][0-9]_*) printf '%s\n' "$1" | cut -c1-10; return ;;
  esac
  if [ -f "$UNDATED" ]; then
    while read -r d pat; do
      case "$d" in ''|'#'*) continue ;; esac
      # shellcheck disable=SC2254 # $pat is a pattern on purpose
      case "$1" in $pat) echo "$d"; return ;; esac
    done < "$UNDATED"
  fi
  echo "db-schema: warning: $1 has no date and is not in undated-migrations.txt; applying it last" >&2
  echo 9999_99_99
}
# Files on stdin, in apply order on stdout.
in_apply_order() {
  while IFS= read -r f; do [ -n "$f" ] && printf '%s\t%s\n' "$(file_date "$f")" "$f"; done \
    | LC_ALL=C sort | cut -f2
}

# Whether a migration cannot run inside one transaction: CONCURRENTLY, or its own
# transaction control (BEGIN [WORK|TRANSACTION|ISOLATION ...], START TRANSACTION, COMMIT,
# END) at the start of a line. Looked for after dropping -- comments and $tag$-quoted
# bodies, where BEGIN/END are PL/pgSQL blocks, not transactions. A CASE ... END that
# starts a line also matches; such a file then just runs without the wrapper.
needs_own_transaction() {
  awk '
    {
      line = $0; out = ""
      while (line != "") {
        if (tag != "") {
          i = index(line, tag)
          if (i == 0) { line = ""; break }
          line = substr(line, i + length(tag)); tag = ""; continue
        }
        c = index(line, "--")
        d = match(line, /[$][A-Za-z_]*[$]/) ? RSTART : 0
        if (c > 0 && (d == 0 || c < d)) { out = out substr(line, 1, c - 1); line = ""; break }
        if (d > 0) { out = out substr(line, 1, d - 1); tag = substr(line, d, RLENGTH); line = substr(line, d + RLENGTH); continue }
        out = out line; line = ""
      }
      print out
    }' "$1" | grep -Eiq 'concurrently|^[[:space:]]*(begin|start[[:space:]]+transaction|commit|end)([^a-z0-9_]|$)'
}

# ── 1. Schema ────────────────────────────────────────────────────────────────
if [ "$(val "select to_regclass('public.workspaces') is null")" = "t" ]; then
  echo "db-schema: fresh database, applying supabase/schema.sql"
  q --single-transaction -f "$SUPA/schema.sql"
  echo "db-schema: schema.sql applied"
else
  echo "db-schema: public.workspaces exists, skipping schema.sql"
fi

# ── 2. Ledger ────────────────────────────────────────────────────────────────
ls "$MIGRATIONS" 2>/dev/null | grep '\.sql$' | LC_ALL=C sort > /tmp/migrations.txt || true

if [ "$(val "select to_regclass('$LEDGER') is null")" = "t" ]; then
  if [ -f "$BASELINE" ]; then
    grep -v '^[[:space:]]*#' "$BASELINE" | sed 's/[[:space:]]*$//' | grep '\.sql$' > /tmp/seed.txt || true
    how=baseline
    echo "db-schema: new migration ledger, seeding from schema-baseline-migrations.txt"
  else
    cp /tmp/migrations.txt /tmp/seed.txt
    how=schema.sql
    echo "db-schema: new migration ledger, no schema-baseline-migrations.txt; recording every file in supabase/migrations as contained in schema.sql"
  fi
  {
    echo "begin;"
    echo "create schema if not exists selfhost;"
    echo "revoke all on schema selfhost from public;"
    echo "create table $LEDGER (filename text primary key, applied_at timestamptz not null default now(), how text not null);"
    while IFS= read -r f; do
      [ -n "$f" ] && echo "insert into $LEDGER (filename, how) values ($(sqlstr "$f"), '$how') on conflict do nothing;"
    done < /tmp/seed.txt
    echo "commit;"
  } > /tmp/ledger.sql
  q -f /tmp/ledger.sql
  echo "db-schema: ledger seeded with $(val "select count(*) from $LEDGER") files"
fi

# ── 3. Migrate ───────────────────────────────────────────────────────────────
val "select filename from $LEDGER" | LC_ALL=C sort > /tmp/applied.txt
LC_ALL=C comm -23 /tmp/migrations.txt /tmp/applied.txt | in_apply_order > /tmp/pending.txt
pending=$(wc -l < /tmp/pending.txt | tr -d ' ')
if [ "$pending" = "0" ]; then
  echo "db-schema: migrations up to date ($(wc -l < /tmp/applied.txt | tr -d ' ') recorded)"
else
  echo "db-schema: applying $pending new migration(s)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    record="insert into $LEDGER (filename, how) values ($(sqlstr "$f"), 'applied')"
    if needs_own_transaction "$MIGRATIONS/$f"; then
      echo "db-schema:   $f (outside a transaction)"
      q -f "$MIGRATIONS/$f"
      q -c "$record"
    else
      echo "db-schema:   $f"
      q --single-transaction -f "$MIGRATIONS/$f" -c "$record"
    fi
  done < /tmp/pending.txt
  echo "db-schema: migrations applied"
fi

# ── 4. Grants ────────────────────────────────────────────────────────────────
q -f /selfhost/post-schema.sql
echo "db-schema: grants applied, $(val "select count(*) from pg_tables where schemaname = 'public'") tables in public"

# ── 5. Owner ─────────────────────────────────────────────────────────────────
if [ "$(val "select count(*) from public.selfhost_instance_owner")" = "0" ]; then
  if [ -n "${SELFHOST_SETUP_TOKEN:-}" ]; then
    echo "db-schema: no owner yet. Create the owner account at:"
    echo "db-schema:   https://${APP_DOMAIN:-<APP_DOMAIN>}/signup?setup=${SELFHOST_SETUP_TOKEN}"
    echo "db-schema: only a sign-up with this token becomes the owner."
  else
    echo "db-schema: no owner yet, and SELFHOST_SETUP_TOKEN is not set: run scripts/selfhost-keys.mjs"
  fi
fi
