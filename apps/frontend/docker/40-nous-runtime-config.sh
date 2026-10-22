#!/bin/sh
# Runtime settings for a prebuilt frontend image (GET-758, GET-1013).
#
# Vite bakes VITE_* values into the JS at build time. The release images on GHCR
# (ghcr.io/nousc/opennous-frontend) are built once for everyone, with placeholders in
# place of the per-install values; this script, run by the nginx image's entrypoint
# on container start, writes the real ones in from the environment:
#
#   NOUS_SUPABASE_URL        e.g. https://app.example.com (bundled stack) or your project URL
#   NOUS_SUPABASE_ANON_KEY   the anon (public) key
#   NOUS_MCP_URL             e.g. https://mcp.example.com/mcp, the address the Connect
#                            dialogs quote (without it they named Nous Cloud's)
#
# docker-compose.release.yaml passes all three from nous.env. An image built locally
# (docker compose up --build) has the real values already and no placeholders, so this
# script does nothing there.
set -eu

ROOT=/usr/share/nginx/html
URL_PH=__NOUS_RUNTIME_SUPABASE_URL__
KEY_PH=__NOUS_RUNTIME_SUPABASE_ANON_KEY__
MCP_PH=__NOUS_RUNTIME_MCP_URL__

files=$(grep -rlF -e "$URL_PH" -e "$KEY_PH" -e "$MCP_PH" "$ROOT" 2>/dev/null || true)
[ -n "$files" ] || exit 0

# An image from before GET-1013 has no MCP placeholder; nothing to fill in for it then.
mcp_files=$(grep -rlF -e "$MCP_PH" "$ROOT" 2>/dev/null || true)
mcp=${NOUS_MCP_URL:-}
if [ -n "$mcp_files" ]; then
  if [ -z "$mcp" ]; then
    echo "nous-runtime-config: this is a prebuilt image; set NOUS_MCP_URL (https://\$MCP_DOMAIN/mcp)" >&2
    exit 1
  fi
  case "$mcp" in
    http://?*|https://?*) ;;
    *) echo "nous-runtime-config: NOUS_MCP_URL must start with http:// or https://" >&2; exit 1 ;;
  esac
  if printf '%s' "$mcp" | grep -q '[^A-Za-z0-9._~:/?#@!$()*+,;=%-]'; then
    echo "nous-runtime-config: NOUS_MCP_URL has characters that are not allowed" >&2; exit 1
  fi
fi

url=${NOUS_SUPABASE_URL:-}
key=${NOUS_SUPABASE_ANON_KEY:-}
if [ -z "$url" ] || [ -z "$key" ]; then
  echo "nous-runtime-config: this is a prebuilt image; set NOUS_SUPABASE_URL and NOUS_SUPABASE_ANON_KEY" >&2
  exit 1
fi
# Both go into JS string literals through sed: allow only characters that are safe there.
case "$url" in
  http://*|https://*) ;;
  *) echo "nous-runtime-config: NOUS_SUPABASE_URL must start with http:// or https://" >&2; exit 1 ;;
esac
if printf '%s' "$url" | grep -q '[^A-Za-z0-9._~:/?#@!$()*+,;=%-]'; then
  echo "nous-runtime-config: NOUS_SUPABASE_URL has characters that are not allowed" >&2; exit 1
fi
if printf '%s' "$key" | grep -q '[^A-Za-z0-9._-]'; then
  echo "nous-runtime-config: NOUS_SUPABASE_ANON_KEY must be a JWT (letters, digits, . _ -)" >&2; exit 1
fi

for f in $files; do
  sed -i "s|$URL_PH|$url|g; s|$KEY_PH|$key|g; s|$MCP_PH|$mcp|g" "$f"
done
echo "nous-runtime-config: Supabase URL, anon key and MCP address written into $(echo "$files" | wc -l) file(s)"
