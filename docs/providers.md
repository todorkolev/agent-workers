# Provider protocols — measured ground truth

Everything here was verified by running the installed CLIs, not read from
documentation. Where a claim came from a generated type binding rather than an
observed run, that is said explicitly. Versions matter: re-verify after a CLI
upgrade, and treat the engine as authoritative over this file.

Verified on **Claude Code 2.1.263** and **codex-cli 0.153.4**, linux x86_64,
2026-09-08.

---

## 1. Claude — persistent streaming session

### Transport

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --replay-user-messages [--session-id <uuid> | --resume <uuid>] \
       [--model M] [--effort E] [--permission-mode P] [--permission-prompts none] \
       [--allowedTools ...] [--disallowedTools ...] [--append-system-prompt ...] \
       [--strict-mcp-config]
```

stdin and stdout each carry newline-delimited JSON. **The process stays alive as
long as stdin is open**, which is what makes one child a durable session rather
than a one-shot call.

`--bare` is never passed: it disables OAuth and forces `ANTHROPIC_API_KEY`,
which would silently move a worker from the user's subscription onto paid API
billing.

### Inbound message types

| `type` | meaning | normalized to |
|---|---|---|
| `system` / `init` | a turn is starting; carries `session_id`, `model`, tool list | `status` (and the source of `actualModel`) |
| `system` / `permission_denied` | a tool the permission mode forbade; the model is told and continues | `permission_denied` |
| `system` / other | task lifecycle chatter | `status` |
| `assistant` → `content[].text` | what the worker says | `agent_message` |
| `assistant` → `content[].tool_use` | a tool call, summarized | `tool_started` (+ `file_changed` for Write/Edit) |
| `assistant` → `content[].thinking` | reasoning | `status` |
| `user` → `content[].tool_result` | tool output, summarized | `tool_completed` |
| `user` → `content[].text` | our own message, echoed by `--replay-user-messages` | (not forwarded) |
| `result` | end of a turn; `subtype`, `result`, `num_turns`, `total_cost_usd` | `final` + `turn_completed` |
| `rate_limit_event` | subscription window state | `status` (evidence the CLI login is in use) |
| `control_response` | answer to a control request we sent | (internal) |
| `control_request` | the CLI asking the host something | answered with an explicit error |

### Turn boundaries

`system/init` is emitted at the **start of every turn**, and `result` ends it.
The turn id is therefore assigned on `init`; minting one when the message is
written produces two ids for one turn.

### Sending into a running turn — measured

Sending a `user` message while a turn is in flight does **not** interrupt it and
is **not** an acknowledged injection. Two runs make the shape clear:

```
+5.2s  tool_use Bash "sleep 8; echo A"      (first of four planned commands)
+9.2s  we write the steering message
+13.4s tool_result "A"
+13.4s the steering message is delivered    <- next tool boundary, same turn
+20.5s assistant: STEERED-OK                <- the model changed course
+20.5s result subtype=success num_turns=2
```

but when the worker is inside one long tool call:

```
+5.4s  tool_use Bash "sleep 20; echo phase1"
+8.4s  we write the steering message
+19.4s still nothing — the model has not seen it
```

So: **queued, delivered at the next tool boundary inside the running turn, with
no read receipt.** This tool reports that as `queued_for_turn` and never as a
guaranteed steer. When a worker has to stop *now*, interrupt it.

### Interrupt — measured

```json
{"type":"control_request","request_id":"aw-1","request":{"subtype":"interrupt"}}
```

answered with

```json
{"type":"control_response","response":{"subtype":"success","request_id":"aw-1",
 "response":{"still_queued":[]}}}
```

The running tool is cancelled, the model is told
`[Request interrupted by user for tool use]`, and the turn ends with
`result subtype=error_during_execution`. **The session survives**: the next
message continues with full history. `still_queued` lists messages the interrupt
left undelivered.

### Resume — measured

`--resume <session-id>` in a **brand-new process** restored the full
conversation (a token from before the restart was recalled verbatim) and kept
the same `session_id`. Passing `--session-id <uuid>` at start makes that id
known in advance, so recovery does not depend on having seen `system/init`.

### Permissions — measured

With `--permission-mode manual --permission-prompts none`, a disallowed tool
produces a `system/permission_denied` event, the model is told, and it carries
on. It does **not** hang.

Routing the decision back to the manager (`can_use_tool`) was tested and does
**not** happen for a plain stdio host: neither `--permission-prompts host` alone
nor a `control_request`/`initialize` handshake made the CLI ask us. The CLI's
help states that path needs `--permission-prompt-tool <mcp-tool>`, i.e. an MCP
tool the worker can call. That is a known limitation, recorded in the README;
the workaround is to start the worker with the tools it legitimately needs
(`allowedTools`) rather than a blanket bypass.

Read-only workers additionally get `--disallowedTools Write Edit NotebookEdit`.

### Effort and model

Both are forwarded verbatim, and neither is checked against a list here — that
is how a perfectly valid `max` ends up silently downgraded.

Measured, and worth knowing: `--effort` advertises
`low, medium, high, xhigh, max`, but an unrecognised value is **not** rejected.
A worker started with `--effort not-an-effort` ran a normal turn to completion.
So an invalid effort is quietly ignored by the CLI rather than failing, and
there is no field that reports the effort actually applied. `worker_status`
shows the effort that was **requested**; treat it as a request, not a receipt.

An invalid **model** does fail, and visibly — the turn ends with an error the
manager can read.

`system/init.model` is the model that was really used and is what
`worker_status` reports as "actually used".

---

## 2. Codex — app-server thread

### Transport

```
codex app-server [-c key=value ...]
```

Newline-delimited JSON-RPC over stdio (**not** LSP `Content-Length` framing).
Classify every inbound line before doing anything with it:

| shape | meaning |
|---|---|
| `id` + `result`/`error`, no `method` | a response to one of our requests |
| `method`, no `id` | a notification |
| `method` **and** `id` | a server request we **must** answer |

Responses have been observed without a `jsonrpc` field — match on `id`.

### Lifecycle — measured

```
initialize -> thread/start -> turn/start -> notifications -> turn/completed
                                   |
                 turn/steer (active turn)   turn/interrupt   thread/resume
```

- `thread/start` → `result.thread.id` is the session id; `result.model` echoes
  the model actually selected.
- `turn/start` → `result.turn.id`, returned **immediately**; the work streams as
  notifications. Never block on this response for completion.
- `turn/steer` requires `expectedTurnId` and fails if it is not the active turn.

Observed on 0.153.4 with `model: "gpt-5.6-sol"`, `effort: "max"`:

```
+1.0s thread/start  threadId=01a0835a-…  model=gpt-5.6-sol
+1.1s turn/start    turnId=01a0835a-b799-…
+10.1s cmd start    /bin/bash -lc 'sleep 8; echo A'
+14.1s turn/steer   -> {"turnId":"01a0835a-b799-…"}   (accepted immediately)
+18.0s cmd done     exit=0
+20.5s agentMessage STEERED-OK                        (course changed)
+20.6s turn/completed status=completed
```

Note the nuance worth being honest about: the *acceptance* is synchronous, but
the model still reads it at its next reasoning boundary — the command already
running finished first. The practical difference from Claude is the
acknowledgement and the `expectedTurnId` precondition, not instant delivery.

### Notifications used

| method | normalized to |
|---|---|
| `turn/started` | `status` |
| `turn/completed` | `turn_completed` |
| `turn/plan/updated` | `plan` |
| `turn/diff/updated` | `diff` |
| `item/completed` `agentMessage` | `agent_message` |
| `item/started` / `item/completed` `commandExecution` | `tool_started` / `tool_completed` |
| `item/completed` `fileChange` | `file_changed` |
| `item/completed` `reasoning` | `status` |
| `error` (`willRetry: true`) | `error`, turn stays open |
| `error` (`willRetry: false`) | `error`, turn ends |

`aggregatedOutput` on a completed command is the **full** output: persisted raw,
summarized in the transcript, never forwarded by default.

### Server requests and their exact response shapes

From the bindings the installed CLI generates
(`codex app-server generate-ts --out <dir>`):

| method | response |
|---|---|
| `item/commandExecution/requestApproval` | `{ decision: "accept" \| "acceptForSession" \| "decline" \| "cancel" }` |
| `item/fileChange/requestApproval` | `{ decision: "accept" \| "acceptForSession" \| "decline" \| "cancel" }` |
| `execCommandApproval` (legacy) | `{ decision: "approved" \| "approved_for_session" \| { denied: { rejection } } \| "abort" }` |
| `applyPatchApproval` (legacy) | same `ReviewDecision` union |
| `item/tool/requestUserInput` | `{ answers: { [questionId]: answer } }` |
| `item/permissions/requestApproval` | `{ permissions, scope }` — not answerable from here; a JSON-RPC error is returned so Codex can fall back |
| `account/chatgptAuthTokens/refresh`, `attestation/generate` | infrastructure; answered with a JSON-RPC error |

Never leave a server request unanswered: the worker stalls until it gets a reply.

### Invalid model, measured

Codex rejects an unknown model with a clear error rather than substituting one:

```
[1] turn started
[2] ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error",
     "message":"The 'definitely-not-a-model-xyz' model is not supported when using Codex with a ChatGPT account."}}
[3] turn failed
```

The worker stays usable afterwards; the failure is recorded on the worker as
`last turn error` so `idle` is never mistaken for success.

### Enums, as generated

```ts
type ReasoningEffort = string;                       // any value; the engine validates
type SandboxMode     = "read-only" | "workspace-write" | "danger-full-access";
type AskForApproval  = "untrusted" | "on-request" | { granular: {...} } | "never";
```

`ReasoningEffort` being a bare `string` is why effort is forwarded verbatim.
Note that `"on-failure"`, accepted by older versions, is gone from `AskForApproval`
in 0.153.

### Config overrides

`-c key=value` (TOML-parsed) works on `app-server`. `-c mcp_servers={}` was
verified to start a thread normally and is how a worker is kept from inheriting
this MCP server when nested workers are disabled.

---

## 3. What the two have in common, and where they do not

| | Claude | Codex |
|---|---|---|
| session identity | `session_id` (uuid, can be chosen up front) | `thread.id` (uuid, server-assigned) |
| resume in a new process | `--resume <id>` | `thread/resume { threadId }` |
| turn id | not exposed; derived from `system/init` | `turn.id` from `turn/start` |
| message into a running turn | queued, next tool boundary, no receipt | `turn/steer`, acknowledged, `expectedTurnId` gated |
| interrupt | `control_request` `interrupt` | `turn/interrupt` |
| approval routed to the manager | not available over stdio (see above) | yes, as a server request |
| effort | `--effort`, validated by the CLI | `effort` on `turn/start`, any string |
| model actually used | `system/init.model` | `thread/start.model` |

These differences are surfaced, not hidden. `worker_send` reports the delivery
mode it actually got, and `worker_respond` works where the backend supports it.
