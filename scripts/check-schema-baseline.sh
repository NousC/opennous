#!/usr/bin/env bash
# Is supabase/schema.sql still the whole schema? (GET-757)
#
# supabase/schema.sql is what a FRESH install applies, once. supabase/migrations/ is what an
# EXISTING install applies, one file at a time. supabase/schema-baseline-migrations.txt lists the
# migration files already folded into schema.sql. The two drift apart whenever a migration lands
# without the baseline being regenerated; by 2026-10-07 the hand-kept baseline was missing 75
# tables, 32 functions and 264 indexes and did not apply on an empty database at all.
#
# Docker only, on a throwaway local Postgres. It never connects to any Supabase project.
#
#   scripts/check-schema-baseline.sh              check (exit 0 = current, 1 = stale or broken)
#   scripts/check-schema-baseline.sh regenerate   fold the migrations not yet in the manifest into
#                                                 schema.sql and append them to the manifest
#
# check:
#   1. db `baseline`: shims + schema.sql in ONE transaction with ON_ERROR_STOP. Must succeed.
#   2. Every file in the manifest must exist. Migrations NOT in the manifest are the new ones.
#   3. db `replay`: shims + schema.sql + the new migrations, in order (below). Compare
#      `pg_dump --schema-only -n public` of the two plus the reference rows, normalised. A
#      difference means schema.sql is behind the migrations.
#
# Why only the new migrations and not all of them on top: replaying old files over a current
# schema is not a no-op. Several recreate the contacts/companies views wholesale or patch them with
# a regex over pg_get_viewdef, so an old file re-run puts back a definition a later one replaced.
#
# Order: filename order is not dependency order. Undated files (v1_to_v2.sql, team_join_tokens.sql,
# ...) would sort after every dated one, and some same-day files need a sibling that sorts after
# them. So files are grouped by date (undated ones by the date they were added, table below), and
# within a day a file that fails is retried after its siblings. Files that never apply are listed.
#
# Cloud (GET-924): Nous Cloud's own tables live in supabase/cloud/migrations/, which the open-source
# export leaves out, so schema.sql and the manifest above are the public schema only. Where that
# folder exists (a private checkout), supabase/cloud/schema.sql is what Cloud adds on top of
# schema.sql for a fresh database: every file in supabase/cloud/migrations, in an order that applies
# (by date, a failing file retried after its same-day siblings), each kept whole. `regenerate`
# writes it; `check` proves schema.sql + cloud/schema.sql applies on an empty database and that
# cloud/schema.sql still holds exactly the files in the folder. A public checkout has no folder and
# skips both.
#
# Env: PG_IMAGE (default pgvector/pgvector:pg17), KEEP=1 keeps the container.
set -euo pipefail

MODE="${1:-check}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$ROOT/supabase/migrations"
MANIFEST="$ROOT/supabase/schema-baseline-migrations.txt"
CLOUD_MIG="$ROOT/supabase/cloud/migrations"
CLOUD_SCHEMA="$ROOT/supabase/cloud/schema.sql"
IMAGE="${PG_IMAGE:-pgvector/pgvector:pg17}"
NAME="nous-schema-check-$$"
WORK="$(mktemp -d)"

# Undated files, by the date they entered the repo: supabase/undated-migrations.txt, shared
# with the bundled self-host stack's db-schema service so both apply in the same order.
# New migrations must be named YYYY_MM_DD_*.sql; an undated file missing there stops the script.
UNDATED="$ROOT/supabase/undated-migrations.txt"
undated_date() {
  local d pat
  while read -r d pat; do
    case "$d" in ''|'#'*) continue ;; esac
    # shellcheck disable=SC2254 # $pat is a pattern on purpose
    case "$1" in $pat) echo "$d"; return 0 ;; esac
  done < "$UNDATED"
  echo "undated migration $1: rename it YYYY_MM_DD_$1 or add it to supabase/undated-migrations.txt" >&2; exit 2
}
# "date<TAB>file" for the given files, in apply order.
ordered() {
  local f
  for f in "$@"; do
    if [[ "$f" =~ ^[0-9]{4}_[0-9]{2}_[0-9]{2}_ ]]; then printf '%s\t%s\n' "${f:0:10}" "$f"
    else printf '%s\t%s\n' "$(undated_date "$f")" "$f"; fi
  done | LC_ALL=C sort
}

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

docker run -d --name "$NAME" --tmpfs /var/lib/postgresql/data:rw,size=2g \
  -e POSTGRES_PASSWORD=postgres -v "$ROOT":/repo:ro "$IMAGE" >/dev/null
until docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null; do sleep 1; done
sleep 2 # the entrypoint restarts the server once after initdb
until docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null; do sleep 1; done

psql_() { docker exec -i "$NAME" psql -U postgres -q -X "$@"; }
newdb() {
  psql_ -c "drop database if exists $1" -c "create database $1" >/dev/null 2>&1
  psql_ -d "$1" -v ON_ERROR_STOP=1 -f /repo/supabase/bare-postgres-shims.sql >/dev/null
}
# The folder apply_file reads, relative to the repo: the public migrations, or Cloud's.
DIR=supabase/migrations
apply_file() { # db file -> 0 if it applied; appends it to $WORK/applied.txt when it did
  local tx="-1"
  if grep -qi 'concurrently' "$ROOT/$DIR/$2"; then tx=""; fi # CREATE INDEX CONCURRENTLY refuses a transaction
  psql_ -d "$1" -v ON_ERROR_STOP=1 $tx -f "/repo/$DIR/$2" >"$WORK/$2.log" 2>&1 && echo "$2" >> "$WORK/applied.txt"
}
# Apply files (args) to db, a day at a time; prints "  file: error" for each that never applied.
apply_migrations() {
  local db=$1; shift
  : > "$WORK/applied.txt"
  local day f pending failed progress leftovers=""
  [ $# -eq 0 ] && return 0
  for day in $(ordered "$@" | cut -f1 | uniq); do
    pending=$(ordered "$@" | awk -F'\t' -v d="$day" '$1==d {print $2}')
    while :; do
      failed=""; progress=0
      for f in $pending; do
        if apply_file "$db" "$f"; then progress=1; else failed="$failed $f"; fi
      done
      pending=$failed
      if [ "$progress" -eq 0 ] || [ -z "$pending" ]; then break; fi
    done
    leftovers="$leftovers $pending"
  done
  for f in $leftovers; do
    echo "  $f: $(grep -m1 ERROR "$WORK/$f.log" | sed -E 's/^psql:[^:]+:[0-9]+: //')"
  done
}
dump() { docker exec "$NAME" pg_dump -U postgres --schema-only --no-owner -n public -d "$1"; }
# Reference rows the migrations insert (workflow_providers, source_authority, ...). Part of the
# baseline: without them a fresh install has no connectable providers.
dump_data() {
  docker exec "$NAME" pg_dump -U postgres --data-only --inserts --on-conflict-do-nothing \
    --no-owner -n public -d "$1" 2>/dev/null | grep -E '^INSERT INTO ' | LC_ALL=C sort
}
normalise() {
  grep -v -E '^\\(un)?restrict ' | grep -v -E '^--' \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | grep -v '^$'
}
# Reference rows compare by content: ids are gen_random_uuid() and timestamps now().
mask() {
  sed -E "s/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/'<uuid>'/g; s/'[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+\\+00'/'<ts>'/g" \
    | LC_ALL=C sort -u
}
inventory() {
  psql_ -d "$1" -At <<'SQL'
select
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')) || ' tables, ' ||
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')) || ' views, ' ||
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')) || ' functions, ' ||
  (select count(*) from pg_policies where schemaname = 'public') || ' policies, ' ||
  (select count(*) from pg_indexes where schemaname = 'public') || ' indexes, ' ||
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal) || ' triggers';
SQL
}

all_migrations() { (cd "$MIG" && ls -1 -- *.sql); }
cloud_migrations() { if [ -d "$CLOUD_MIG" ]; then (cd "$CLOUD_MIG" && ls -1 -- *.sql 2>/dev/null) || true; fi; }
# supabase/cloud/schema.sql for the files in $WORK/applied.txt, in that order (Cloud only).
write_cloud_schema() {
  local f
  {
    cat <<'EOF'
--
-- Nous Cloud's additions to supabase/schema.sql for a FRESH database (GET-924). Generated by
-- `scripts/check-schema-baseline.sh regenerate`: every file in supabase/cloud/migrations, whole,
-- in an order that applies. Do not edit by hand: add a migration there and regenerate.
--
-- Apply after schema.sql, without --single-transaction (each file below is its own transaction):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/schema.sql -f supabase/cloud/schema.sql
-- The open-source export leaves out supabase/cloud/, so a self-hosted database never has these.
--
EOF
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      printf '\n-- ── supabase/cloud/migrations/%s ──\n\n' "$f"
      cat "$CLOUD_MIG/$f"
    done < "$WORK/applied.txt"
  } > "$1"
}
# Cloud's files on top of schema.sql in db: fills $WORK/applied.txt with the order they applied in,
# and prints "  file: error" for each that never applied.
apply_cloud() {
  local db=$1
  DIR=supabase/cloud/migrations
  # shellcheck disable=SC2046
  apply_migrations "$db" $(cloud_migrations)
  DIR=supabase/migrations
}
in_manifest() { if [ -f "$MANIFEST" ]; then grep -v -E '^(#|$)' "$MANIFEST" || true; fi; }
new_migrations() { all_migrations | LC_ALL=C sort | comm -23 - <(in_manifest | LC_ALL=C sort); }

for f in $(in_manifest); do
  [ -f "$MIG/$f" ] || { echo "FAIL: manifest lists $f, which is not in supabase/migrations"; exit 1; }
done
for f in $(all_migrations); do
  [[ "$f" =~ ^[0-9]{4}_[0-9]{2}_[0-9]{2}_ ]] || undated_date "$f" >/dev/null
done
NEW=$(new_migrations)

if [ "$MODE" = "regenerate" ]; then
  # Built from the current schema.sql plus the migrations it does not include yet. A hand-edited
  # schema.sql can reference a table before creating it, so it is applied twice, tolerating
  # errors; anything still wrong shows up when `check` applies the output strictly.
  newdb replay
  psql_ -d replay -f /repo/supabase/schema.sql >/dev/null 2>&1 || true
  psql_ -d replay -f /repo/supabase/schema.sql >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  apply_migrations replay $NEW > "$WORK/failed.txt"
  echo "$(echo $NEW | wc -w | tr -d ' ') new migrations replayed; these did not apply:"; cat "$WORK/failed.txt"
  last=$(all_migrations | grep -E '^[0-9]{4}_' | LC_ALL=C sort | tail -1)
  {
    cat <<EOF
--
-- Nous baseline schema for a FRESH install. Generated by \`scripts/check-schema-baseline.sh regenerate\`.
--
-- Current through supabase/migrations/$last (generated $(date -u +%Y-%m-%d)).
-- supabase/schema-baseline-migrations.txt lists every migration file folded in here.
-- Do not edit by hand: add a migration, run the script with \`regenerate\`, commit both files.
-- \`scripts/check-schema-baseline.sh\` proves this file applies on an empty database and matches.
--
-- Applies on a Supabase project as is, or on plain Postgres 15+ with pgvector after
-- supabase/bare-postgres-shims.sql (roles anon/authenticated/service_role, auth.users, auth.uid()).
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;

CREATE SCHEMA IF NOT EXISTS public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

EOF
    # pg_dump's own preamble is replaced by the one above: \restrict is a psql 17.6+ meta-command
    # the Supabase SQL editor and older psql reject, and transaction_timeout needs PG17.
    dump replay \
      | grep -v -E '^\\(un)?restrict ' \
      | grep -v -E '^SET [a-z_]+ = ' \
      | grep -v -F "SELECT pg_catalog.set_config('search_path', '', false);" \
      | grep -v -E '^-- Dumped (from|by) ' \
      | grep -v -E '^ALTER DEFAULT PRIVILEGES ' \
      | sed -E 's/^CREATE SCHEMA public;$/-- (schema public is created above)/' \
      | awk '!done && /Type: ACL;/ {
          print "-- Privileges. Supabase (and the shims) grant every new table, sequence and function to"
          print "-- anon, authenticated and service_role by default, and pg_dump only writes GRANTs, not"
          print "-- the REVOKEs migrations made since (entity_list_rows, visible_observations, ...). Start"
          print "-- those three roles from nothing so the GRANTs below are exactly what they end up with."
          print "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;"
          print "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated, service_role;"
          print "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, service_role;"
          print "--"
          done = 1
        } { print }'
    echo
    echo "--"
    echo "-- Reference rows the migrations insert (providers, source authority, categories)."
    echo "--"
    echo
    dump_data replay
  } > "$WORK/schema.sql"
  cp "$WORK/schema.sql" "$ROOT/supabase/schema.sql"
  {
    echo "# Migration files folded into supabase/schema.sql. Maintained by scripts/check-schema-baseline.sh."
    echo "# Files listed here that did not apply when folded in target the pre-v2 schema or were"
    echo "# superseded (the script prints them); they are listed so they are never replayed again."
    { in_manifest; echo "$NEW"; } | grep -v '^$' | LC_ALL=C sort -u
  } > "$WORK/manifest"
  cp "$WORK/manifest" "$MANIFEST"
  echo "wrote supabase/schema.sql ($(wc -l < "$ROOT/supabase/schema.sql" | tr -d ' ') lines): $(inventory replay)"
  if [ -n "$(cloud_migrations)" ]; then
    newdb cloud
    psql_ -d cloud -v ON_ERROR_STOP=1 -1 -f /repo/supabase/schema.sql >/dev/null
    apply_cloud cloud > "$WORK/cloud-failed.txt"
    if [ -s "$WORK/cloud-failed.txt" ]; then
      echo "FAIL: these Cloud migrations do not apply on top of schema.sql:"; cat "$WORK/cloud-failed.txt"; exit 1
    fi
    write_cloud_schema "$CLOUD_SCHEMA"
    echo "wrote supabase/cloud/schema.sql ($(wc -l < "$WORK/applied.txt" | tr -d ' ') files): with it, $(inventory cloud)"
  fi
  exit 0
fi

# check
newdb baseline
if ! psql_ -d baseline -v ON_ERROR_STOP=1 -1 -f /repo/supabase/schema.sql >"$WORK/baseline.log" 2>&1; then
  echo "FAIL: supabase/schema.sql does not apply on an empty database:"
  grep -m5 ERROR "$WORK/baseline.log" | sed 's/^/  /'
  exit 1
fi
echo "baseline: schema.sql applies cleanly: $(inventory baseline)"
if [ -n "$(cloud_migrations)" ]; then
  newdb cloud
  psql_ -d cloud -v ON_ERROR_STOP=1 -1 -f /repo/supabase/schema.sql >/dev/null 2>&1
  if [ ! -f "$CLOUD_SCHEMA" ] || ! psql_ -d cloud -v ON_ERROR_STOP=1 -f /repo/supabase/cloud/schema.sql >"$WORK/cloud.log" 2>&1; then
    echo "FAIL: supabase/cloud/schema.sql is missing or does not apply on top of schema.sql:"
    grep -m5 ERROR "$WORK/cloud.log" 2>/dev/null | sed 's/^/  /'
    exit 1
  fi
  # Current when it holds exactly the files in supabase/cloud/migrations, as they are now.
  newdb cloudorder
  psql_ -d cloudorder -v ON_ERROR_STOP=1 -1 -f /repo/supabase/schema.sql >/dev/null 2>&1
  apply_cloud cloudorder >/dev/null
  write_cloud_schema "$WORK/cloud-schema.sql"
  if ! cmp -s "$WORK/cloud-schema.sql" "$CLOUD_SCHEMA"; then
    echo "FAIL: supabase/cloud/schema.sql is not the files in supabase/cloud/migrations. Run regenerate."
    exit 1
  fi
  echo "cloud: schema.sql + cloud/schema.sql applies cleanly: $(inventory cloud)"
fi
if [ -z "$NEW" ]; then
  echo "OK: every migration in supabase/migrations is folded into schema.sql."
  exit 0
fi
echo "migrations not in the manifest: $(echo $NEW)"
newdb replay
psql_ -d replay -v ON_ERROR_STOP=1 -1 -f /repo/supabase/schema.sql >/dev/null 2>&1
# shellcheck disable=SC2086
apply_migrations replay $NEW > "$WORK/failed.txt"
if [ -s "$WORK/failed.txt" ]; then echo "these did not apply on top of the baseline:"; cat "$WORK/failed.txt"; fi
{ dump baseline | normalise; dump_data baseline | mask; } > "$WORK/baseline.sql"
{ dump replay   | normalise; dump_data replay   | mask; } > "$WORK/replay.sql"
if diff -u "$WORK/baseline.sql" "$WORK/replay.sql" > "$WORK/diff.txt"; then
  echo "OK: the new migrations change nothing schema.sql lacks. Run regenerate to record them in the manifest."
  exit 0
fi
echo "FAIL: schema.sql is behind the migrations ($(grep -c '^[-+][^-+]' "$WORK/diff.txt") lines differ)."
echo "Run scripts/check-schema-baseline.sh regenerate, review the diff, and commit schema.sql and the manifest."
head -200 "$WORK/diff.txt"
exit 1
