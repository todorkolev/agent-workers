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
/plugin marketplace add todorkolev/agent-workers
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

Codex takes **two steps**, and both are needed. This is not a preference - it is
what codex-cli 0.153.4 actually does, verified here:

> Codex discovers a plugin's MCP declaration and lists it in `codex mcp list`,
> but **does not launch it**. The server never starts and no `worker_*` tools
> appear. A directly registered MCP server does start and its tools are callable.
> So the plugin brings the skill and command; the MCP server is registered
> separately.

**1. The plugin** (skill, command, agent definition):

```bash
codex plugin marketplace add todorkolev/agent-workers
codex plugin add agent-workers@agent-workers
```

**2. The MCP server.** Clone the repository somewhere permanent and run the
installer, which resolves the absolute path for you and refuses to register a
duplicate:

```bash
git clone https://github.com/todorkolev/agent-workers.git ~/src/agent-workers
sh ~/src/agent-workers/scripts/install-codex.sh
```

Or by hand — **both** lines matter:

```bash
codex mcp add agent-workers -- node ~/src/agent-workers/plugins/agent-workers/dist/agent-workers.mjs
```

then add one line to the block it wrote in `~/.codex/config.toml`:

```toml
[mcp_servers.agent-workers]
default_tools_approval_mode = "approve"       # <- add this
command = "node"
args = ["/home/you/src/agent-workers/plugins/agent-workers/dist/agent-workers.mjs"]
```

Without it, Codex refuses every `worker_*` call in any session whose approval
policy is `never` — which is what `codex exec` and most automation use — with
*"MCP tool call requires approval, but approval policy is never"*. The tools it
pre-approves start and steer workers; they do not themselves touch your files,
and each worker's own sandbox and permission mode still apply. Remove the line if
you would rather approve each call by hand in an interactive session.

Then verify:

```bash
codex plugin list | grep agent-workers
codex mcp list | grep agent-workers        # status should be "enabled"
```

The definitive check is that a Codex turn can call a tool:

```bash
codex exec 'Call the agent-workers MCP tool worker_list with no filters and report its output.'
```

When a future Codex version launches plugin-declared MCP servers, step 2 becomes
unnecessary — remove the manual entry then, so the server is not registered
twice.

---

## Do not register the same server twice

Each host must end up with exactly one `agent-workers` MCP server. Two entries
means two bridge processes. On Codex today the plugin contributes no running
server, so the single registration is the manual one; re-check after any Codex
upgrade that starts launching plugin MCP servers.

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
git clone https://github.com/todorkolev/agent-workers.git
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
