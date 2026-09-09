# Architecture

## The problem this shape solves

A worker has to outlive the tool call that created it, survive its manager
restarting, be readable by a second manager without corrupting anything, and
never be reported as running when its process is gone. Those four requirements,
together, rule out keeping worker state in the MCP server's memory.

So the MCP bridge holds no worker state at all.

```
Manager host  (Claude Code, or Codex - the same tools either way)
     |
     |  MCP over stdio
     v
  agent-workers bridge          thin, stateless, restartable
     |                    \
     |  reads journals     \  control requests over a Unix socket
     v                      v
  <state>/workers/<id>/   worker supervisor   (detached, one per worker)
     journal.ndjson             |
     events.ndjson              |  stdio
     worker.json                v
     ...                   provider process
                            |            |
                 claude -p --input-  codex app-server
                 format stream-json
```

Reads go straight to the files. Control goes over the socket. Nothing about a
worker lives only in the bridge, so:

- **the worker keeps working** after `worker_start` returns;
- **a bridge restart changes nothing** - a new bridge reads the same directory
  and dials the same sockets;
- **two managers can attach at once** - see the single-writer rule below;
- **liveness is a fact, not a memory** - `worker_status` signals the supervisor's
  pid and reports `orphaned` if nothing answers.

## The single-writer rule

Every file has exactly one writer.

A worker's supervisor owns that worker's directory: it is the only process that
writes `worker.json`, appends to the journals, and updates the result snapshot.
Bridges only read. There is no shared registry file for a Claude host and a Codex
host to overwrite each other in - listing workers is a `readdir`.

Three mechanisms keep that true in practice:

1. `writeJsonAtomic` writes to a **per-call unique** temp file and renames. A
   shared temp name (even one per process) lets two overlapping writes clobber
   each other; that produced a torn `worker.json` in testing, and the fix is
   covered by a test.
2. The supervisor serializes its own record writes through a promise chain, so
   "one writer" also means "one write at a time".
3. A write worker takes an exclusive lock on the directory it will edit, keyed
   by a hash of that path under the state directory. The bridge's "is anyone
   already writing here?" scan runs before either supervisor exists, so on its
   own it is check-then-act: two starts racing each other both pass it. Creating
   the lock is atomic, so exactly one wins. A lock whose owner is gone is
   reclaimed, or one crash would make a directory permanently unusable.

## Ownership vs. reading

Reading is always allowed, from any host. **Control** - send, interrupt, stop,
resume, respond - belongs to one owner at a time, identified by a stable client
id derived from `(host kind, project directory)` so it survives a restart. A
second manager gets a clear `not_owner` error naming the current owner, and can
take control deliberately with `takeover: true`. Silent co-driving is how two
agents end up fighting over one worktree.

## Layers

```
src/core/        provider- and host-agnostic
  types.ts       the whole contract: states, events, records, the adapter seam
  store.ts       state directory layout, atomic writes, append-only journals
  control.ts     bridge <-> supervisor wire, client and server
  config.ts      exec profiles, path mapping, limits
  git.ts         worktree creation/adoption and work summaries
  availability.ts  "can this provider run right now?"
  logger.ts      stderr only, always

src/providers/
  claude/adapter.ts   persistent `claude` streaming session
  codex/adapter.ts    `codex app-server` thread

src/supervisor/  the detached per-worker process
src/bridge/      the MCP server, its tools, and their rendering
```

`ProviderAdapter` is the only seam a new backend has to implement: start,
resume, startTurn, steer, interrupt, respond, dispose, plus event subscriptions
and two live getters (`turnId`, `actualModel`). Everything above it - journals,
recovery, ownership, worktrees, rendering - is shared.

## Worker lifecycle

```
        start / resume
             |
             v
        starting ---> failed
             |
             v
   +----->  idle  <---------------+
   |         |  ^                 |
   |     send|  | turn_completed  |
   |         v  |                 |
   |      running ----------------+
   |         |  \
   |  block  |   \ interrupt
   |         v    v
   |     blocked  interrupted
   |         |         |
   +-- respond+         +-- send
             |
        stop / provider exit
             |
             v
     stopped / failed        (orphaned = record says live, pid says otherwise)
```

`interrupted` is deliberately sticky: it stays visible until the manager does
something with the worker, because collapsing straight back to `idle` would hide
that work was cut short. `orphaned` is never written by the supervisor - it is
what the bridge reports when a record claims a live state but the pid is gone.

## Event flow

```
provider line
   |
   |-- persisted raw, before any filtering  -> events.ndjson
   |
   +-- normalized by the adapter            -> WorkerEvent
            |
            +-- journaled with a seq        -> journal.ndjson
            |
            +-- may change worker state     -> worker.json
```

`seq` is the cursor unit. `worker_read(cursor)` returns only events after it,
under a character budget, and reports the next cursor plus whether more remains.
Filtered-out events still advance the cursor - otherwise a transcript mode that
hides the newest event would replay the same page forever.

Transcript modes are applied at **read** time, not write time, so `worker_trace`
can always show everything that was recorded.

## Execution environment

Four things are kept separate on purpose:

| | what it decides |
|---|---|
| host | which product's MCP client is calling (never changes behavior) |
| provider | claude or codex - which backend runs the worker |
| model / effort | per worker, forwarded to the backend verbatim |
| exec profile | **where** the provider process runs |

The supervisor always runs beside the bridge, so journals, the registry and
recovery stay on one filesystem. Only the provider child is launched through the
profile's `launcher` argv, with `pathMap` translating the working directory into
the target's namespace. "Manager outside the container, workers inside" is then
configuration, not a code path - and no container provisioning is involved.

## Nesting

A worker does not inherit this MCP server unless nesting is enabled:
Claude workers get `--strict-mcp-config`, Codex workers get `-c mcp_servers={}`,
and the bridge additionally refuses `worker_start` when it detects it is itself
running inside a worker. "Any host can drive any provider" is not the same claim
as "agents spawn agents by default".
