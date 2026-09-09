#!/bin/sh
# Register agent-workers as an MCP server in Codex.
#
# Why this exists: codex-cli 0.153.4 discovers a plugin's MCP declaration and
# lists it (`codex mcp list`), but does not launch it - the server never starts
# and no tools appear. Registering it directly does work, and is what this
# script does, with the absolute path resolved for you.
#
# Which is also why "is it already registered?" must not be answered from
# `codex mcp list`. That listing merges plugin-declared servers with directly
# registered ones and spells both of them `agent-workers`. Install the plugin
# first - the order docs/install.md tells you to use - and the listing shows a
# row for a server that does not exist, the script skips `codex mcp add`, and
# the install completes having done nothing. The question actually asked here
# is whether $CODEX_HOME/config.toml declares [mcp_servers.agent-workers],
# which is a direct registration and nothing else.
#
# Re-running is safe and useful: it repairs a half-finished install rather than
# reporting "nothing to do". It never adds a second registration, because two
# entries would start two bridges. It fails loudly when a step does not take.
#
# Usage: install-codex.sh [--approve-tools]
#
#   --approve-tools  also set default_tools_approval_mode = "approve" in the
#                    agent-workers block, and nowhere else. Opt-in: it
#                    pre-approves tools that do write. See docs/install.md.

set -eu

usage() {
  echo "usage: install-codex.sh [--approve-tools]"
}

approve_tools=no
for arg in "$@"; do
  case "$arg" in
    --approve-tools) approve_tools=yes ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "agent-workers: unknown option '$arg'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bridge="$root/plugins/agent-workers/dist/agent-workers.mjs"
codex_config="${CODEX_HOME:-$HOME/.codex}/config.toml"

if [ ! -f "$bridge" ]; then
  echo "agent-workers: bundle not found at $bridge" >&2
  echo "Run 'npm run build' first, or clone the repository rather than copying a subset of it." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "agent-workers: the codex CLI is not on PATH" >&2
  exit 1
fi

# Is agent-workers declared as an MCP server in this config file, and in a form
# we can add a key to?
#
#   header  [mcp_servers.agent-workers] - what `codex mcp add` writes
#   other   the same server written as a dotted key or an inline table, which
#           still counts as registered (do not add a second one) but which this
#           script will not try to rewrite
#   none    not registered here
registration() {
  [ -f "$codex_config" ] || {
    echo none
    return 0
  }
  awk '
    /^[[:space:]]*\[/ {
      line = $0
      sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line)
      if (line ~ /^\[mcp_servers\."?agent-workers"?\]$/) hdr = 1
      table = line
      next
    }
    # mcp_servers.agent-workers = { ... }  /  mcp_servers.agent-workers.command = ...
    /^[[:space:]]*mcp_servers\."?agent-workers"?[[:space:]]*[=.]/ { oth = 1 }
    # ... or the same server declared as a key of an [mcp_servers] table.
    table ~ /^\[mcp_servers\]$/ && /^[[:space:]]*"?agent-workers"?[[:space:]]*=/ { oth = 1 }
    END { print (hdr ? "header" : (oth ? "other" : "none")) }
  ' "$codex_config"
}

# What to paste when we cannot do it for you.
manual_block() {
  echo "Add this to $codex_config by hand:" >&2
  echo >&2
  echo "  [mcp_servers.agent-workers]" >&2
  echo "  command = \"node\"" >&2
  echo "  args = [\"$bridge\"]" >&2
}

before=$(registration)
if [ "$before" != "none" ]; then
  echo "agent-workers is already registered with Codex in $codex_config."
else
  if ! codex mcp add agent-workers -- node "$bridge"; then
    echo >&2
    echo "agent-workers: 'codex mcp add agent-workers' failed; nothing was registered." >&2
    manual_block
    exit 1
  fi
  # Believe the config, not the exit status. This is the check that catches the
  # plugin-row false positive, so it stays even though `codex mcp add` has just
  # claimed success.
  if [ "$(registration)" = "none" ]; then
    echo "agent-workers: 'codex mcp add' reported success but $codex_config still has no" >&2
    echo "[mcp_servers.agent-workers] entry, so no server is registered and no worker_* tools" >&2
    echo "will appear." >&2
    manual_block
    exit 1
  fi
  echo "Registered agent-workers with Codex in $codex_config."
fi

# Codex asks for approval before every MCP tool call, and a session running with
# approval policy "never" - which is what `codex exec` and most automation use -
# refuses them outright rather than prompting: "MCP tool call requires approval,
# but approval policy is never". Pre-approving the server's tools is what makes
# them usable there, and it is opt-in because those tools do write: worker_start
# creates a git worktree under .worktrees/ in the repository you point it at and
# appends an entry to that repository's .git/info/exclude, and can launch a
# worker that edits files; worker_stop(purge=true) deletes a worker's state
# directory and artifacts. What it does not do is grant anything to any other
# MCP server: the key goes in the agent-workers block only.
if [ "$approve_tools" = "yes" ]; then
  mode=approve
else
  mode=--check
fi

approval_status=0
approval=$(sh "$root/scripts/ensure-codex-approval.sh" "$codex_config" "$mode") || approval_status=$?

case "$approval" in
  added)
    echo 'Set default_tools_approval_mode = "approve" for agent-workers, and for nothing else.'
    echo "Remove that line if you would rather approve every worker_* call by hand."
    ;;
  already-set:*)
    echo "Left your existing tool approval policy alone: default_tools_approval_mode = ${approval#already-set:}"
    ;;
  unset)
    echo
    echo "No tool approval policy is set for agent-workers, so Codex will ask before every"
    echo "worker_* call - and a session whose approval policy is 'never' (codex exec and most"
    echo "automation) will refuse them outright. To pre-approve them for this server only:"
    echo
    echo "  sh $root/scripts/install-codex.sh --approve-tools"
    echo
    echo "That grants the worker_* tools, which can create a git worktree and a .git/info/exclude"
    echo "entry in a repository you point them at, launch workers that edit files, and delete a"
    echo "worker's artifacts on worker_stop(purge=true). See docs/install.md."
    ;;
  missing-section)
    # Registration exists (checked above) but not as a section header we can
    # edit, so say so rather than writing a stray key at the end of the file.
    echo "agent-workers: $codex_config registers agent-workers in a form this script does not" >&2
    echo "edit (not a [mcp_servers.agent-workers] table header), so its tool approval policy" >&2
    echo "was neither read nor changed." >&2
    if [ "$approve_tools" = "yes" ]; then
      echo "Set default_tools_approval_mode = \"approve\" in that block by hand." >&2
      exit 1
    fi
    ;;
  *)
    echo "agent-workers: could not read the tool approval policy in $codex_config" >&2
    echo "(ensure-codex-approval.sh exited $approval_status)." >&2
    if [ "$approve_tools" = "yes" ]; then
      exit 1
    fi
    ;;
esac

# Not `codex mcp list`: it shows an agent-workers row for the plugin too, which
# is exactly the confusion this script exists to avoid repeating.
echo
echo "Verify with:"
echo "  grep -A2 '^\[mcp_servers.agent-workers\]' $codex_config"
echo "  codex exec 'Call the agent-workers MCP tool worker_list and report its output.'"
echo
echo "The plugin (skills and commands) installs separately:"
echo "  codex plugin marketplace add todorkolev/agent-workers"
echo "  codex plugin add agent-workers@agent-workers"
