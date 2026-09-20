# Unattended observation

The supervisor already writes a durable journal. One read-only watcher process
filters that journal without model calls. It performs filesystem checks once a
second; no MCP requests are kept open. Existing supervisors survive an upgrade.

## Run

Run **where the supervisor and its state live**, including inside its container.
Use the same `AGENT_WORKERS_HOME` as the bridge (default `~/.agent-workers`).
The bundle lives at `<plugin-root>/dist/worker-watch.mjs`.

```sh
node /absolute/plugin-root/dist/worker-watch.mjs \
  --worker worker-id --cursor 123 \
  --deadline 2026-10-01T12:30:00Z \
  --wake-regex '^\[\[(NEEDS_INPUT|MILESTONE)\]\]' --wake-flags im
```

Replace the example deadline with the existing task's next meaningful progress
or completion deadline. Do not extend it automatically when routine output
arrives. Keep claim/lease renewal in the existing project wrapper, in the same
bounded process, without waking the model or launching another observer.

`--cursor` is the last cursor actually delivered by `worker_read`, not the
header's latest sequence. `--turn-id` optionally pins the expected provider
turn. The watcher also detects a changed supervisor, a different active turn,
or a regressed record sequence, so a resumed worker is not silently adopted.

## Manager-defined regexes

Repeat `--wake-regex SOURCE` for alternatives. These are JavaScript regex
sources without `/` delimiters; shared flags default to `m`. They match each
normalized event's **text**, including message and tool summaries, not raw
provider streams or a concatenation of several events. Invalid expressions
fail before waiting. Prefer simple, specific patterns; normal JavaScript regex
performance applies. Global/sticky match state resets for each event.

Choose markers with the worker, for example: “Begin a message with
`[[NEEDS_INPUT]]` when you cannot proceed, and `[[MILESTONE]]` when the agreed
integration stage is ready.” Those names are examples, not reserved words.
Send that convention with the task or existing guidance channel; creating a
watcher does not send instructions to the worker. A pattern can also match
existing output without introducing any marker.

Structured questions, permission requests/denials, errors, final answers and
turn completion always wake the watcher, as do idle, blocked, interrupted,
stopped, failed, completed and orphaned states. Custom patterns cannot mute
these signals. A prose question from a backend without structured question
events needs a configured pattern to wake before the deadline.

For a short MCP wait the same rules are available through:

```text
worker_wait(workerId, cursor, until="attention",
            wakeRegex=["^READY_FOR_REVIEW:", "^HELP:"], wakeRegexFlags="m")
```

MCP request timeouts still apply. Repeated short MCP waits from the model are
not the unattended workflow.

## Let the host wait too

- Claude Code: start the command with `Bash(run_in_background=true)` and yield.
  Its background-task completion notification wakes the manager.
- Codex: use the host's completion notification if available. Otherwise keep
  command supervision and lease renewal inside **one existing execution cell**,
  and wait on that cell until its meaningful deadline. Use the longest supported
  outer wait that reaches that deadline. Intermediate process/MCP timeouts stay
  inside the cell; they are not reasons to run the model again. A detached
  `nohup` process alone does not arrange a Codex wake-up.

Keep only one observer for an assignment. User steering should interrupt the
host wait; stop only that observer when replacing it, not the worker. Report an
actual host limitation if background completion or long waits are unavailable.

## Interpret the single report

`reason` is `event`, `state`, `deadline`, `changed` or `gone`. `matchedRegex` is
the zero-based expression index when a custom rule matched. The report includes
the event sequence and a bounded excerpt, latest observed activity, pending
decision count and journal path. The complete journal is retained.

`readFromCursor` remains unchanged: watching acknowledges nothing.
`observedSeq` is only a record snapshot, never a replacement read cursor.
Read the relevant delta with `worker_read`, then save the cursor it actually
returned. Drill into the triggering event by its sequence when appropriate;
do not repeatedly replay the entire trace. `worker_result` remains a separate
collection step. A milestone match can occur while the worker is still running.

Exit 0 means an observation, **not task success**. Exit 1 reports an inspection
or argument error; exit 130 reports cancellation. None of these grants an
approval, controls a worker, or certifies a commit/test result.
