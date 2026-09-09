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

It decides whether you are already registered by reading
`[mcp_servers.agent-workers]` out of `~/.codex/config.toml`, not by reading
`codex mcp list` — that listing merges plugin-declared servers with registered
ones, so after step 1 it shows an `agent-workers` row for a server that does not
exist yet. If a step does not take, the installer says so and exits non-zero
rather than reporting a success it did not achieve.

Or by hand:

```bash
codex mcp add agent-workers -- node ~/src/agent-workers/plugins/agent-workers/dist/agent-workers.mjs
```

which writes:

```toml
[mcp_servers.agent-workers]
command = "node"
args = ["/home/you/src/agent-workers/plugins/agent-workers/dist/agent-workers.mjs"]
```

That is the whole registration. If you also want the `worker_*` tools to work in
`codex exec` and other non-interactive sessions, see
[Pre-approving the worker tools](#pre-approving-the-worker-tools---approve-tools)
below — it is a separate, deliberate step.

Then verify:

```bash
codex plugin list | grep agent-workers
grep -A2 '^\[mcp_servers.agent-workers\]' ~/.codex/config.toml
```

`codex mcp list` is the wrong check on 0.153.4: it shows an `agent-workers` row
once the plugin is installed, whether or not a server is registered. The config
file is where a registration actually lives.

The definitive check is that a Codex turn can call a tool:

```bash
codex exec 'Call the agent-workers MCP tool worker_list with no filters and report its output.'
```

When a future Codex version launches plugin-declared MCP servers, step 2 becomes
unnecessary — remove the manual entry then, so the server is not registered
twice.

---

## Pre-approving the worker tools (`--approve-tools`)

Codex asks for approval before every MCP tool call, and a session running with
approval policy `never` — which is what `codex exec` and most automation use —
refuses them outright rather than prompting:

> MCP tool call requires approval, but approval policy is never

One line fixes that for this server:

```toml
[mcp_servers.agent-workers]
default_tools_approval_mode = "approve"
```

The installer does **not** add it for you. Ask for it explicitly:

```bash
sh ~/src/agent-workers/scripts/install-codex.sh --approve-tools
```

It is opt-in because it is a real grant, and worth reading before you make it.
`default_tools_approval_mode = "approve"` means Codex stops asking about the
`worker_*` tools of the `agent-workers` server. Those tools do write:

- `worker_start` creates a git worktree under `.worktrees/` in whichever
  repository you point it at, and appends an entry to that repository's
  `.git/info/exclude`.
- `worker_start` can launch a worker that edits files — with `writeAccess: true`
  in its own worktree, or in your checkout if you also pass
  `allowMainCheckout: true`.
- `worker_stop(purge=true)` deletes that worker's state directory and artifacts
  under `~/.agent-workers/`.

What it does **not** do:

- it does not touch any other MCP server — the key goes in the
  `[mcp_servers.agent-workers]` block only, never in a global policy;
- it does not change the approval policy of your Codex session itself, nor of
  anything Codex runs directly;
- it does not change what a worker may do. Each worker's own sandbox, permission
  mode and `writeAccess` still apply, and a write worker without isolation is
  still refused.

A value you already chose is never overwritten: if the block says
`default_tools_approval_mode = "prompt"`, `--approve-tools` reports it and
leaves it. To undo the grant, delete the line. Without it, everything still
works in an interactive session where you can answer the prompts.

---

## Do not register the same server twice

Each host must end up with exactly one `agent-workers` MCP server. Two entries
means two bridge processes. On Codex today the plugin contributes no running
server, so the single registration is the manual one; re-check after any Codex
upgrade that starts launching plugin MCP servers.

Two bridges are not actually dangerous here — workers live in their own
supervisor processes and every file has a single writer, so a duplicate bridge
duplicates nothing but the process itself. It is still waste and confusing
tool lists, so after installing check `/mcp` (Claude) or
`~/.codex/config.toml` (Codex — one `[mcp_servers.agent-workers]` block, and a
second `agent-workers` row in `codex mcp list` is the plugin, not a duplicate
registration), and remove whichever registration you did not intend.

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
