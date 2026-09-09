---
name: agent-workers
description: Start and drive persistent Claude or Codex workers - long-lived sessions you can read, steer, interrupt, question and resume while they work. Use when delegating implementation, investigation, review or a second opinion to another agent, when you want an independent reviewer on a specific commit, or when work should run in an isolated git worktree. Also use when asked to check on, continue, interrupt or collect results from a worker that is already running.
---

# Agent workers

A worker is a **persistent session** on another agent - Claude or Codex - that you
talk to while it works. It is not a one-shot call: it keeps its context across
turns, tells you things before it is finished, can ask you questions, and can be
redirected or interrupted mid-task.

The same tools work from Claude Code and from Codex, and either one can drive
either provider. All four combinations behave identically at this layer.

## The loop

```
worker_start   -> a durable workerId, immediately; the worker keeps going
worker_read    -> only what is new since your cursor
worker_wait    -> block until there is something new
worker_send    -> guidance, mid-task or between turns
worker_respond -> answer a question or a permission request
worker_interrupt -> cut the current turn short, keep the session
worker_result  -> final answer, changed files, commit, diff, artifact paths
worker_stop    -> end it for good
```

Read with a cursor and pass the returned cursor back. Reads never replay what
you have already seen, so polling is cheap.

## Starting one

```
worker_start(
  provider   = "codex" | "claude",
  task       = "the opening instruction",
  model      = "gpt-5.6-sol" | "opus" | ...,   # forwarded verbatim
  effort     = "max" | "high" | ...,           # forwarded verbatim
  cwd        = "/absolute/path",               # pass it explicitly
  writeAccess= true,                           # only if it must edit files
  worktree   = true                            # isolate those edits
)
```

`model` and `effort` are independent per worker and are passed to the backend
unchanged - the backend validates them, so an unknown value fails loudly instead
of being silently downgraded. `worker_status` reports the model that was
*actually* used, which is the one to trust.

## Reading and steering

`worker_send` tells you how the text was really delivered, and the difference
matters:

- **`steered_into_turn`** (Codex) - accepted into the running turn, with the
  backend checking it is still the active one. The model reads it at its next
  reasoning boundary.
- **`queued_for_turn`** (Claude) - queued on the session and handed to the model
  inside the running turn at its next tool boundary. If the worker is stuck in one
  long tool call, delivery waits for that call to finish, and nothing acknowledges
  that the model has read it.
- **`started_new_turn`** - the worker was idle, so this began a new turn.

If a worker has to stop *now*, use `worker_interrupt`, not `worker_send`.

`worker_interrupt` cancels the turn and keeps the session, so `worker_send`
continues from there with full history. `worker_stop` kills the process; only
`worker_resume` brings it back.

## Questions and permissions

A worker that needs a decision emits a `question` or `permission_request` event
carrying a `requestId`, and its state becomes `blocked`. Answer it:

```
worker_respond(workerId, requestId, decision = "allow" | "deny" | "answer", text = "...")
```

A `permission_denied` event is different: the worker already tried something its
permission settings forbade, was told so, and carried on. If that blocks real
work, restart the worker with the tools it needs (`allowedTools`), not with a
blanket permission bypass.

## Writing code safely

A worker with `writeAccess: true` should always get `worktree: true`. It then
works in `.worktrees/aw-<workerId>` on branch `agent/<workerId>`, cut from
`base` (default HEAD), and the main checkout is never touched. Two live writers
in one directory are refused outright.

Already made the worktree yourself? Pass `worktreePath` (and `branch`) and it is
adopted as-is rather than recreated.

Review the diff with `worker_result` before you merge anything.

## When something looks stuck

`worker_status` checks whether the supervisor process is genuinely alive. A
worker whose process is gone is reported as `orphaned`, never as `running`.
`worker_resume` reattaches to the saved provider session and keeps the context.

For a worker that behaved strangely, `worker_trace` gives the unfiltered journal
and the paths to the raw provider events and stderr.

## Independent review

To get a second opinion that is not anchored on your own reasoning, start a
fresh worker on the other provider, point it at an exact commit, and give it no
context beyond the task:

```
worker_start(provider="codex", model="gpt-5.6-sol", effort="max",
             cwd="<repo>",
             task="Review commit <sha> for correctness bugs. Report findings with file:line.")
```

## Notes

- Workers do not start workers of their own unless nesting is enabled in config.
- `execProfile` runs the provider somewhere else (for example inside a
  devcontainer) without changing anything else about how you drive it.
