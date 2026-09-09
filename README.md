# agent-workers

Persistent, interactive **Claude** and **Codex** workers, driven from **either**
Claude Code or Codex through one MCP tool contract.

A worker is not a one-shot call that returns a paragraph. It is a long-lived
session you stay in conversation with while it works: you read what it says as it
says it, send guidance mid-task, answer its questions, interrupt it, and pick the
same thread back up later — including after your own editor restarts.

All four combinations work, and behave the same at the tool layer:

| manager | worker |
|---|---|
| Claude Code | Claude |
| Claude Code | Codex |
| Codex | Claude |
| Codex | Codex |

---

## The loop

```
worker_start      a durable workerId, immediately; the worker keeps going
worker_read       only what is new since your cursor, size-bounded
worker_wait       block until there is something new
worker_send       guidance, mid-task or between turns
worker_respond    answer a question or a permission request
worker_interrupt  cut the current turn short, keep the session
worker_resume     reattach after a crash, a stop, or an interrupt
worker_result     final answer, changed files, commit, diff, artifact paths
worker_list       what exists
worker_status     including whether the process is genuinely alive
worker_stop       end it for good
worker_trace      the unfiltered journal, when something looks wrong
```

```
> worker_start(provider="codex", model="gpt-5.6-sol", effort="max",
               cwd="/home/me/work/api",
               task="Review commit 4f2b1c9 for correctness bugs.")

worker "codex-review-commit-4f2b-a91c3d" - codex / gpt-5.6-sol, effort max - state running - seq 0
cwd: /home/me/work/api
session: 01a0835a-b620-7a22-8939-402ad77a5ae6
Still working. worker_wait(workerId="codex-review-commit-4f2b-a91c3d", cursor=...) blocks until there is something new.
```

## What it does not pretend

Sending a message to a worker that is already working means different things on
the two backends, and the tool says which one actually happened:

- **`steered_into_turn`** (Codex) — accepted into the running turn via
  `turn/steer`, gated on it still being the active turn. The model reads it at
  its next reasoning boundary.
- **`queued_for_turn`** (Claude) — queued on the session and handed to the model
  inside the running turn at its **next tool boundary**. If the worker is inside
  one long tool call, delivery waits for that call to finish, and nothing
  acknowledges that the model has read it.
- **`started_new_turn`** — the worker was idle.

If a worker must stop *now*, interrupt it. Everything measured about both
protocols, including the runs these claims come from, is in
[docs/providers.md](docs/providers.md).

Likewise, a worker whose supervisor process is gone is reported as `orphaned`,
never as `running`.

## Install

Both hosts install from this one repository. See
[docs/install.md](docs/install.md) for the full instructions, updating, and
verification.

**Claude Code**

```bash
claude
/plugin marketplace add todorkolev/agent-workers
/plugin install agent-workers@agent-workers
```

**Codex** — two steps, because codex-cli 0.153.4 lists a plugin's MCP server but
does not launch it:

```bash
codex plugin marketplace add todorkolev/agent-workers   # skill and command
codex plugin add agent-workers@agent-workers

git clone https://github.com/todorkolev/agent-workers.git ~/src/agent-workers
sh ~/src/agent-workers/scripts/install-codex.sh          # the MCP server itself
```

Register the MCP server exactly **once** per host.

Requirements: Node 20+, and whichever provider CLIs you intend to use
(`claude` and/or `codex`), logged in the normal way. Nothing here asks for an API
key, and `--bare` is deliberately never passed to Claude, because it would move
workers off your subscription onto paid API billing.

## Writing code safely

A worker with `writeAccess: true` **must** be isolated - `worktree: true` or an
explicit `worktreePath`. Omitting it is refused rather than quietly pointed at
your own checkout; to write directly into a directory you have to say
`allowMainCheckout: true` and mean it.

```
worker_start(provider="claude", model="opus", effort="max",
             cwd="/home/me/work/api", writeAccess=true, worktree=true,
             base="4f2b1c9",
             task="Fix the token refresh race in auth/session.ts and commit it.")
```

It works in `.worktrees/aw-<workerId>` on branch `agent/<workerId>`, cut from
the exact base you gave. Your main checkout is never touched — not even by an
untracked `.worktrees/` entry, which is added to `.git/info/exclude`.

Two live writers can never share a directory. The check is an atomic lock keyed
by the canonical path, so a race between two `worker_start` calls has exactly
one winner, and `/repo` versus `/repo/src` versus a symlink alias all count as
the same target.

Already made the worktree yourself? Pass `worktreePath` (and `branch`) and it is
adopted as-is rather than recreated.

## Running workers somewhere else

The supervisor always runs beside the bridge; only the provider process is
launched through a named execution profile. "Manager outside the container,
workers inside" is configuration, not a special mode:

```json
{
  "execProfiles": {
    "devcontainer": {
      "name": "devcontainer",
      "launcher": ["docker", "exec", "-i", "-w", "{cwd}", "-u", "node", "my-container"],
      "pathMap": [{ "host": "/home/me/work", "target": "/workspaces" }]
    }
  }
}
```

```
worker_start(provider="claude", execProfile="devcontainer", cwd="/home/me/work/api", ...)
```

Full configuration reference: [docs/configuration.md](docs/configuration.md).

## Known limitations

- **Claude permission decisions cannot be routed to the manager.** Anything the
  worker's permission mode forbids surfaces as a `permission_denied` event and
  the worker is told and continues — it never hangs — but the manager cannot
  approve it live. Claude Code's help states that path requires
  `--permission-prompt-tool <mcp-tool>`; a stdio host alone, with or without the
  control-protocol `initialize` handshake, is not offered the decision (verified,
  see [docs/providers.md](docs/providers.md)). Start the worker with the tools it
  legitimately needs via `allowedTools` rather than a blanket bypass. Codex
  approvals **are** routed, through `worker_respond`.
- **Codex `item/permissions/requestApproval`** is answered with a JSON-RPC error
  so Codex can fall back; its response shape is not something this tool can
  fabricate honestly.
- A Claude worker exposes no turn id of its own; ids are derived from the
  `system/init` that begins each turn.

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | why the bridge holds no state, and what that buys |
| [docs/providers.md](docs/providers.md) | measured protocol ground truth for both CLIs |
| [docs/install.md](docs/install.md) | install, update, verify, uninstall |
| [docs/configuration.md](docs/configuration.md) | config file, exec profiles, environment |
| [docs/troubleshooting.md](docs/troubleshooting.md) | what each failure means and what to do |

## Development

```bash
npm install
npm run check          # typecheck + build + unit and integration tests
npm run build          # rebuild the committed bundles

# live smoke against the real CLIs (costs model usage)
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs codex basic
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs claude steer
```

The bundles under `plugins/agent-workers/dist/` are committed on purpose:
installing a plugin is a `git clone`, and it must not require a toolchain on the
user's machine. Rebuild them in the same commit as any source change.

## License

MIT
