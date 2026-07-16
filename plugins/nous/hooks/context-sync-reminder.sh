#!/usr/bin/env bash
# Nous — PostToolUse hook.
# After an ICP / context / playbook FILE is edited, remind Claude to sync it into
# Nous THIS turn. An unsynced edit is silently inert — it does NOT change the ICP
# score, the exclusions, or what any other agent reads until sync_icp / sync_playbook
# runs. This is the deterministic backstop to the tool-description instruction: it
# fires every time such a file is written, so an edit can't slip through unsynced.
# Never blocks (always exits 0); silent on every non-context file.
set -euo pipefail

INPUT="$(cat)"

FILE=""
if command -v jq >/dev/null 2>&1; then
  FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null || true)"
fi
[ -z "$FILE" ] && exit 0

# Only fire for GTM context / ICP / playbook markdown — never ordinary code edits.
case "$FILE" in
  *context/*.md|*icp*.md|*ICP*.md|*positioning*.md|*pricing*.md|*competitors*.md|\
*market*.md|*messaging*.md|*gtm*.md|*playbook*.md|*references/voice*.md|*references/outreach*.md)
    ;;
  *)
    exit 0
    ;;
esac

# ICP/context files sync with sync_icp; voice/outreach policy files with sync_playbook.
TOOL="sync_icp"
case "$FILE" in
  *voice*.md|*outreach*.md) TOOL="sync_playbook" ;;
esac

REMINDER="You just edited a GTM context file (${FILE}). This edit is INERT until synced — it does not change the ICP score, the exclusions, or what other agents read. Call ${TOOL} now, in THIS same turn, to sync it into Nous. Do not end the turn with an unsynced context edit."

# Emit as additionalContext so the agent (not just the user) acts on it.
if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$REMINDER" \
    '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}' "$REMINDER"
fi
exit 0
