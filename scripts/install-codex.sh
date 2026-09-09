#!/bin/sh
# Register agent-workers as an MCP server in Codex.
#
# Why this exists: codex-cli 0.153.4 discovers a plugin's MCP declaration and
# lists it (`codex mcp list`), but does not launch it - the server never starts
# and no tools appear. Registering it directly does work, and is what this
# script does, with the absolute path resolved for you.
#
# Re-running is safe and useful: it repairs a half-finished install rather than
# reporting "nothing to do". It never adds a second registration, because two
# entries would start two bridges.

set -eu

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

registered=no
if codex mcp list 2>/dev/null | grep -q '^agent-workers[[:space:]]'; then
  registered=yes
fi

if [ "$registered" = "yes" ]; then
  echo "agent-workers is already registered with Codex."
else
  codex mcp add agent-workers -- node "$bridge"
fi

# Codex asks for approval before every MCP tool call, and a session running with
# approval policy "never" - which is what `codex exec` and most automation use -
# refuses them outright rather than prompting: "MCP tool call requires approval,
# but approval policy is never". Declaring the server's tools as pre-approved is
# what makes them usable there. These tools start and steer workers; they do not
# themselves touch your files, and each worker's own sandbox and permission mode
# still apply.
#
# The check is scoped to the agent-workers section: another server that already
# sets the key must not make us skip the one that needs it.
approval=$(sh "$root/scripts/ensure-codex-approval.sh" "$codex_config" approve || true)
case "$approval" in
  added)
    echo 'Set default_tools_approval_mode = "approve" for agent-workers.'
    echo "Remove that line if you would rather approve every worker_* call by hand."
    ;;
  already-set:*)
    echo "Left your existing tool approval policy alone: default_tools_approval_mode = ${approval#already-set:}"
    ;;
  missing-section)
    echo "agent-workers: could not find an [mcp_servers.agent-workers] section in $codex_config." >&2
    echo "Add default_tools_approval_mode = \"approve\" to it by hand, or Codex will refuse the worker_* tools" >&2
    echo "in any session whose approval policy is 'never'." >&2
    ;;
esac

echo
echo "Verify with:  codex mcp list"
echo "The plugin (skills and commands) installs separately:"
echo "  codex plugin marketplace add todorkolev/agent-workers"
echo "  codex plugin add agent-workers@agent-workers"
