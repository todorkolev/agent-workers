#!/bin/sh
# Register agent-workers as an MCP server in Codex.
#
# Why this exists: codex-cli 0.153.4 discovers a plugin's MCP declaration and
# lists it (`codex mcp list`), but does not launch it - the server never starts
# and no tools appear. Registering it directly does work, and is what this
# script does, with the absolute path resolved for you.
#
# Run it once. Re-running is safe: an existing registration is reported, not
# duplicated, because two entries would start two bridges.

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bridge="$root/plugins/agent-workers/dist/agent-workers.mjs"

if [ ! -f "$bridge" ]; then
  echo "agent-workers: bundle not found at $bridge" >&2
  echo "Run 'npm run build' first, or clone the repository rather than copying a subset of it." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "agent-workers: the codex CLI is not on PATH" >&2
  exit 1
fi

if codex mcp list 2>/dev/null | grep -q '^agent-workers[[:space:]]'; then
  echo "agent-workers is already registered with Codex:"
  codex mcp get agent-workers 2>/dev/null | grep -v '^WARNING' || true
  echo
  echo "Nothing to do. To point it somewhere else: codex mcp remove agent-workers, then re-run this."
  exit 0
fi

codex mcp add agent-workers -- node "$bridge"
echo
echo "Registered. Verify with:  codex mcp list"
echo "The plugin (skills and commands) installs separately:"
echo "  codex plugin marketplace add todorkolev/agent-workers"
echo "  codex plugin add agent-workers@agent-workers"
