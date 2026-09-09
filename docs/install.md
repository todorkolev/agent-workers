# Install, update, verify

One repository installs into both hosts. The bundles under
`plugins/agent-workers/dist/` are committed, so an install is a clone — no
toolchain, no `npm install`, no network fetch on your machine.

**Requirements**

- Node 20 or newer (`node --version`)
- the provider CLIs you intend to use, logged in the normal way:
  - `claude --version`
  - `codex --version` and `codex login status`

You only need the CLI for the providers you actually want to run. A missing or
logged-out CLI is reported by `worker_start` before anything is spawned.

---

## Claude Code

```bash
claude
```

```
/plugin marketplace add todorkolev/agentic-workers
/plugin install agent-workers@agent-workers
```

Restart Claude Code, then check the tools are there:

```
/mcp
```

You should see one server, `agent-workers`, with twelve `worker_*` tools.

<details>
<summary>Manual MCP entry instead of the plugin</summary>

If you would rather not use the plugin system, clone the repo and add the server
yourself — but then do **not** also install the plugin, or the same server would
be started twice:

```json
{
  "mcpServers": {
    "agent-workers": {
      "command": "node",
      "args": ["/path/to/agent-workers/plugins/agent-workers/dist/agent-workers.mjs"],
      "env": { "AGENT_WORKERS_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" }
    }
  }
}
```

</details>

---

## Codex

```bash
codex plugin marketplace add todorkolev/agentic-workers
codex plugin add agent-workers@agent-workers
```

Then verify:

```bash
codex plugin list | grep agent-workers
codex mcp list
```

<details>
<summary>Manual MCP entry instead of the plugin</summary>

```bash
git clone https://github.com/todorkolev/agentic-workers.git ~/src/agent-workers
codex mcp add agent-workers -- node ~/src/agent-workers/plugins/agent-workers/dist/agent-workers.mjs
```

Which writes an `[mcp_servers.agent-workers]` block into `~/.codex/config.toml`.
Again: pick **one** of the plugin or the manual entry, never both.

</details>

---

## Do not register the same server twice

Each host must end up with exactly one `agent-workers` MCP server. Two entries
means two bridge processes.

Two bridges are not actually dangerous here — workers live in their own
supervisor processes and every file has a single writer, so a duplicate bridge
duplicates nothing but the process itself. It is still waste and confusing
tool lists, so check with `/mcp` (Claude) or `codex mcp list` (Codex) after
installing, and remove whichever registration you did not intend.

---

## Updating

**Claude Code**

```
/plugin marketplace update agent-workers
/plugin update agent-workers@agent-workers
```

Then restart Claude Code. Plugins are cached per version under
`~/.claude/plugins/cache/`, so a restart is what actually picks up new bundles.
If a stale version seems to be in use, check which one is installed:

```bash
cat ~/.claude/plugins/installed_plugins.json
```

**Codex**

```bash
codex plugin marketplace upgrade agent-workers
codex plugin add agent-workers@agent-workers   # re-add to move to the new version
```

**A manual clone**

```bash
git -C /path/to/agent-workers pull
```

Running workers are unaffected by any of this: they live in their own processes
and the new bridge reads the same state directory.

---

## Verify it works

Ask the host to run a trivial worker end to end:

```
Start a codex worker in this directory that replies with just the word ALPHA,
read its output, then collect the result.
```

Or drive the tools directly:

```
worker_start(provider="codex", cwd="<this repo>", task="Reply with exactly ALPHA.")
worker_read(workerId="<id>", cursor=0)
worker_result(workerId="<id>")
worker_stop(workerId="<id>")
```

For the maintainer-level check against the real CLIs:

```bash
git clone https://github.com/todorkolev/agentic-workers.git
cd agent-workers && npm install && npm run check     # no model usage

AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs codex basic
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs claude steer
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs codex recover
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs claude worktree
```

The smoke scenarios spend real model usage; `npm run check` does not.

---

## Where things live

```
~/.agent-workers/            state root (override with AGENT_WORKERS_HOME)
  workers/<workerId>/          one directory per worker, written only by its supervisor
    worker.json                the record
    journal.ndjson             normalized events (the cursor stream)
    events.ndjson              raw provider messages
    provider.log               provider stderr
    supervisor.log             supervisor diagnostics
    result.json / final.md / diff.patch / changed-files.txt
    spec.json                  how to restart this worker
  config.json                  optional configuration
$XDG_RUNTIME_DIR/agent-workers/*.sock    control sockets
```

Nothing here is written into your project except worktrees you asked for, which
are excluded from the main checkout via `.git/info/exclude`.

## Uninstall

**Claude Code**

```
/plugin uninstall agent-workers@agent-workers
/plugin marketplace remove agent-workers
```

**Codex**

```bash
codex plugin remove agent-workers@agent-workers
codex plugin marketplace remove agent-workers
```

Stop any workers first (`worker_stop`), or their supervisor processes will keep
running. To clear all state afterwards: `rm -rf ~/.agent-workers`.
