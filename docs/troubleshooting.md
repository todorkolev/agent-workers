# Troubleshooting

Every worker keeps its own directory under `~/.agent-workers/workers/<id>/`.
When something is unclear, that is where to look:

| file | what it holds |
|---|---|
| `worker.json` | the record: state, session, model, owner, pending decisions |
| `journal.ndjson` | normalized events — the same stream `worker_read` pages through |
| `events.ndjson` | every raw provider message, before any filtering |
| `provider.log` | the provider CLI's stderr |
| `supervisor.log` | the supervisor's own diagnostics |
| `spec.json` | exactly how this worker was started |

`worker_trace(workerId)` returns the unfiltered journal and points at the rest.

---

## The tools do not appear in my host

- Claude Code: `/mcp` should list `agent-workers`. If it does not, confirm the
  plugin is installed (`/plugin`) and **restart** — plugin MCP servers are wired
  in at startup.
- Codex: `codex mcp list`. If the plugin is installed but the server is missing,
  add it manually (see [install.md](install.md)) — and remove the plugin
  registration if you do, so the server is not started twice.
- Check Node: the bridge needs Node 20+. `node --version`.
- Run the bridge by hand to see its startup line:
  ```bash
  node ~/.claude/plugins/cache/agent-workers/*/dist/agent-workers.mjs
  ```
  It should print an `INFO [bridge] agent-workers <version> | host=…` line to
  stderr and then wait. Ctrl-C to exit.

## "the claude/codex CLI is not runnable"

The probe runs `<bin> --version` through the same execution profile the worker
would use. If you are using a profile, the CLI has to exist **inside** the target,
not just on your machine:

```bash
docker exec -i my-container claude --version
```

Set `bin` in the profile if the path differs there.

## "the codex CLI is not logged in"

```bash
codex login status      # and inside the container, if you use a profile
```

Claude has no equivalent offline check, so its login is confirmed on the
worker's first turn. If that turn fails with an auth error, run `claude` once
interactively in the same environment.

## Workers are billing the API instead of my subscription

`worker_start` reports the auth situation it can see. If it says
`ANTHROPIC_API_KEY is set in the environment`, that key will be used. Unset it
for the manager process (workers inherit its environment), or override it in the
exec profile's `env`.

`--bare` is never passed to Claude, precisely because it disables OAuth.

## The worker says `orphaned`

Its supervisor process is gone — a reboot, an OOM kill, a `pkill`. The record is
intact and so is the provider session:

```
worker_resume(workerId="…")                      # reattach, send nothing
worker_resume(workerId="…", task="carry on")     # reattach and continue
```

Resume reattaches to the same provider session, so the worker's history is
preserved. Check `supervisor.log` and `provider.log` for why it died.

If the record never recorded a session id, there is nothing to reattach to and
`worker_resume` says so — start a new worker.

## The worker says `blocked`

It is waiting on you and is not making progress. `worker_status` lists the
pending requests with their ids:

```
worker_respond(workerId="…", requestId="codex-9001", decision="allow")
worker_respond(workerId="…", requestId="codex-9001", decision="deny", text="not that path")
worker_respond(workerId="…", requestId="…", decision="answer", text="use the staging URL")
```

A message sent while blocked is held (`queued_after_block`) and delivered once
the worker is unblocked. Unanswered requests are auto-denied after 15 minutes so
a worker cannot wedge forever; that denial appears in the journal.

## I sent a message and the worker ignored it

Read what `worker_send` reported:

- `steered_into_turn` — Codex accepted it into the running turn. The model reads
  it at its next reasoning boundary, so a command already running finishes first.
- `queued_for_turn` — Claude queued it. It is delivered inside the running turn
  at the **next tool boundary**. A worker inside one long tool call will not see
  it until that call ends, and nothing acknowledges that it was read.
- `started_new_turn` — the worker was idle; this began a new turn.

If it has to stop now, `worker_interrupt`. That cancels the turn and keeps the
session, so the next `worker_send` continues with full history.

## A Claude worker keeps hitting "permission denied"

That is the permission mode doing its job, and it is reported as an event rather
than a hang. Give the worker the tools it actually needs:

```
worker_start(provider="claude", writeAccess=true, worktree=true,
             allowedTools=["Bash", "Read", "Write", "Edit"], …)
```

Claude worker permission decisions cannot currently be routed back to the
manager for a live approval — see the limitation in the [README](../README.md)
and the measurement in [providers.md](providers.md). Do not reach for
`permissionMode: "bypassPermissions"` to work around missing interactivity.

## "already writing in <dir>"

Two live write workers may never share a directory. Either give this one its own
worktree (`worktree: true`), or stop the one that holds it:

```
worker_list(live=true)
worker_stop(workerId="…")
```

## "<dir> already exists but is not a git worktree"

Something else is at the path. Remove it, or pass `worktreePath` pointing at a
real worktree — an existing worktree is adopted, not recreated.

## "a branch named … already exists"

You should not see this. Passing `branch` (with or without `worktreePath`) makes
the tool attach a worktree to the existing branch instead of creating it. If you
do hit it, the branch exists but is checked out somewhere else — `git worktree
list` will show where.

## "worker … is controlled by <host>"

Another manager owns it. Reading is always allowed; to steer it, repeat the call
with `takeover: true`. Ownership is per `(host kind, project directory)`, so a
restart of your own editor does not cost you control.

## Model or effort was rejected

The value is forwarded verbatim and the backend validates it — the error text is
the backend's own. An invalid model fails visibly: the turn ends with an error,
and `worker_status` shows it as `last turn error` so an `idle` worker is never
mistaken for a successful one.

Effort is different, and measured: the Claude CLI does **not** reject an
unrecognised `--effort`. A worker started with a nonsense effort runs normally,
presumably at the default, and nothing reports which effort was actually
applied. `worker_status` shows what was **requested**. If effort matters, use a
value the CLI documents (`low`, `medium`, `high`, `xhigh`, `max`) — a typo will
not tell you it was a typo.

`worker_status` always shows the model that was **actually** used, which is the
one to trust.

## The output is too big / too small

`worker_read` takes `maxChars`, `maxMessages` and `mode`:

- `messages` — only what the worker said, asked, or failed on
- `activity` — plus one-line tool, file and diff summaries (default)
- `verbose` — everything normalized

Raw provider events are always recorded regardless, and reachable through
`worker_trace` and `events.ndjson`.

## Everything is stuck; start over

```
worker_list()
worker_stop(workerId="…", purge=true)     # kills the process and deletes artifacts
```

Nuclear option, once nothing is running:

```bash
pkill -f 'agent-worker:' ; rm -rf ~/.agent-workers
```
