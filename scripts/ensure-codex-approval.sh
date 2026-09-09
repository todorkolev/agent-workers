#!/bin/sh
# Ensure the agent-workers MCP server block in a Codex config.toml declares
# `default_tools_approval_mode`.
#
# Section-scoped on purpose. Searching the whole file for the key is wrong twice
# over: another MCP server that already sets it would make us skip the one that
# needs it, and a half-finished install (server registered, key missing) would
# look complete.
#
# Usage: ensure-codex-approval.sh <config.toml> [value]
#
# Exit status:
#   0  the key is present in the agent-workers section (added or already there)
#   1  the agent-workers section does not exist in that file
#   2  bad arguments
#
# Prints one of: added | already-set:<value> | missing-section

set -eu

config=${1:-}
want=${2:-approve}

if [ -z "$config" ]; then
  echo "usage: ensure-codex-approval.sh <config.toml> [value]" >&2
  exit 2
fi
if [ ! -f "$config" ]; then
  echo "missing-section"
  exit 1
fi

# An explicitly chosen value is the user's decision and is never overwritten.
existing=$(awk '
  /^[[:space:]]*\[/ { in_section = ($0 ~ /^[[:space:]]*\[mcp_servers\."?agent-workers"?\][[:space:]]*$/) ; next }
  in_section && /^[[:space:]]*default_tools_approval_mode[[:space:]]*=/ {
    sub(/^[^=]*=[[:space:]]*/, ""); gsub(/[" ]/, ""); print; exit
  }
' "$config")

if [ -n "$existing" ]; then
  echo "already-set:$existing"
  exit 0
fi

has_section=$(awk '
  /^[[:space:]]*\[mcp_servers\."?agent-workers"?\][[:space:]]*$/ { print "yes"; exit }
' "$config")

if [ "$has_section" != "yes" ]; then
  echo "missing-section"
  exit 1
fi

tmp="$config.aw-tmp.$$"
awk -v want="$want" '
  # Insert immediately after the section header, so the key lands inside the
  # agent-workers table regardless of what follows it.
  /^[[:space:]]*\[mcp_servers\."?agent-workers"?\][[:space:]]*$/ {
    print
    print "default_tools_approval_mode = \"" want "\""
    next
  }
  { print }
' "$config" > "$tmp"
mv "$tmp" "$config"
echo "added"
