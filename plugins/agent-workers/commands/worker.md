---
description: Start or manage a persistent Claude or Codex worker via the agent-workers MCP tools.
argument-hint: [provider] <task, or an instruction about an existing worker>
---

Use the `agent-workers` MCP tools to act on this request:

$ARGUMENTS

Follow the `agent-workers` skill. In short:

1. If the request names an existing worker, call `worker_list` / `worker_status`
   first and act on that worker rather than starting a new one.
2. Otherwise call `worker_start` with an explicit `cwd`, the provider that was
   asked for (default `codex` for review or a second opinion, `claude` for
   implementation), and `worktree: true` whenever `writeAccess` is true.
3. Then drive the loop: `worker_wait` -> `worker_read` -> `worker_send` /
   `worker_respond`, and finish with `worker_result`.
4. Report back what the worker actually said and did, including the model it
   really used and the paths of anything it changed. Do not paste raw traces;
   point at the artifact paths instead.
