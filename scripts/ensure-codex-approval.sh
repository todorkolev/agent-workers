#!/bin/sh
# Read or set `default_tools_approval_mode` in the agent-workers MCP server
# block of a Codex config.toml.
#
# Section-scoped on purpose. Searching the whole file for the key is wrong twice
# over: another MCP server that already sets it would make us skip the one that
# needs it, and a half-finished install (server registered, key missing) would
# look complete. Nothing outside `[mcp_servers.agent-workers]` is ever read as
# ours or written.
#
# Usage: ensure-codex-approval.sh <config.toml> [value|--check]
#
#   --check   report the current state and write nothing. This is what an
#             install that has not been asked to change the policy uses.
#   value     the value to insert when the key is absent (default: approve).
#             A value the user already chose is never overwritten.
#
# Exit status:
#   0  the agent-workers section exists and was read (or edited) successfully
#   1  the agent-workers section does not exist in that file
#   2  bad arguments
#   3  the edit failed; the config on disk is unchanged
#
# Prints exactly one of:
#   added | already-set:<value> | unset | missing-section

set -eu

config=${1:-}
arg=${2-approve}

if [ -z "$config" ] || [ $# -gt 2 ]; then
  echo "usage: ensure-codex-approval.sh <config.toml> [value|--check]" >&2
  exit 2
fi

check_only=no
want=$arg
if [ "$arg" = "--check" ]; then
  check_only=yes
  want=
elif [ -z "$arg" ]; then
  echo "ensure-codex-approval.sh: the value must not be empty" >&2
  exit 2
fi

if [ ! -f "$config" ]; then
  echo "missing-section"
  exit 1
fi

# Edit the file the link points at rather than replacing the link: a
# `~/.codex/config.toml` symlinked into a dotfiles repo must stay a symlink.
# `readlink -f` is absent on some BSDs, in which case we fall back to the old
# behaviour rather than refusing to run.
if [ -L "$config" ]; then
  target=$(readlink -f -- "$config" 2>/dev/null || true)
  if [ -n "$target" ] && [ -f "$target" ]; then
    config=$target
  fi
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

if [ "$check_only" = "yes" ]; then
  echo "unset"
  exit 0
fi

case "$config" in
  */*) dir=${config%/*} ;;
  *) dir=. ;;
esac

if ! command -v mktemp >/dev/null 2>&1; then
  echo "agent-workers: mktemp is not available, so this script cannot rewrite $config safely." >&2
  echo "Add default_tools_approval_mode = \"$want\" to [mcp_servers.agent-workers] by hand." >&2
  exit 3
fi

fail() {
  echo "agent-workers: $1" >&2
  echo "$config was not modified." >&2
  exit 3
}

# The temp file is created 0600, with an unpredictable name, in the config's own
# directory: same filesystem, so the replacement below is an atomic rename, and
# never world-readable for the moment it holds a copy of the config.
umask 077
tmp=$(mktemp -- "$dir/.agent-workers-config.XXXXXX") || fail "could not create a temporary file in $dir"
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM

# Copy the original onto the temp file for its permission bits alone. The
# rewrite that follows truncates the contents but leaves the mode as it found
# it, so replacing a 0600 config.toml cannot silently widen it to whatever the
# umask says - which is what a bare `awk > tmp && mv` did.
cp -p -- "$config" "$tmp" || fail "could not copy $config to $tmp"

awk -v want="$want" '
  # Insert immediately after the section header, so the key lands inside the
  # agent-workers table regardless of what follows it.
  /^[[:space:]]*\[mcp_servers\."?agent-workers"?\][[:space:]]*$/ {
    print
    print "default_tools_approval_mode = \"" want "\""
    next
  }
  { print }
' "$config" > "$tmp" || fail "could not write the updated config to $tmp"

mv -- "$tmp" "$config" || fail "could not replace $config with $tmp"
trap - EXIT HUP INT TERM
echo "added"
