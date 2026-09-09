# Configuration

Nothing has to be configured to use agent-workers. Configuration exists for
two things: running providers somewhere other than this machine, and changing
the defaults you would otherwise repeat on every `worker_start`.

## Where config comes from

Merged in increasing precedence:

1. built-in defaults
2. `~/.agent-workers/config.json`
3. the file named by `$AGENT_WORKERS_CONFIG`
4. `.agent-workers.json` in the project directory
5. environment overrides

Objects merge one level deep (so a project file can add an exec profile without
restating the others); everything else is replaced.

## The file

```jsonc
{
  // Named places a provider process can run. "local" always exists.
  "execProfiles": {
    "devcontainer": {
      "name": "devcontainer",
      "launcher": ["docker", "exec", "-i", "-w", "{cwd}", "-u", "node", "my-container"],
      "pathMap": [{ "host": "/home/me/work", "target": "/workspaces" }],
      "env": { "TERM": "dumb" },
      "bin": { "claude": "/usr/local/bin/claude" }
    }
  },

  // Used when worker_start does not name one.
  "defaultExecProfile": "local",

  // Used when worker_start does not pass model/effort. Per provider.
  "defaultModel":  { "claude": "opus",  "codex": "gpt-5.6-sol" },
  "defaultEffort": { "claude": "high",  "codex": "max" },

  // Provider executables on this machine.
  "bin": { "claude": "claude", "codex": "codex" },

  // Size budgets for a single tool result.
  "limits": { "maxMessageChars": 12000, "maxTraceChars": 20000, "maxMessages": 200 },

  // May a worker start workers of its own? Off by default.
  "allowNestedWorkers": false,

  // Ceiling on live workers in this state directory. 0 disables the check.
  "maxLiveWorkers": 16
}
```

These are examples, not product constraints. `model` and `effort` are free-form
strings forwarded to the backend verbatim — this tool never validates them
against a list of its own, because that is how a perfectly valid `max` ends up
silently downgraded.

## Execution profiles

The supervisor always runs beside the bridge, so journals, the registry and
recovery stay on one filesystem. Only the **provider process** is launched
through the profile.

**`launcher`** — an argv prefix. `{cwd}` in any element is replaced with the
worker's directory translated into target space.

```
["docker", "exec", "-i", "-w", "{cwd}", "-u", "node", "my-container"]
   ->  docker exec -i -w /workspaces/api -u node my-container claude -p --input-format ...
```

`-i` matters: the provider protocols are stdio, so stdin must stay attached.

**`pathMap`** — host↔target translation, longest host prefix wins. It is applied
to the working directory handed to the provider and to `{cwd}` in the launcher.

**`bin`** — the provider executable *inside* the target, when it differs.

**`env`** — extra environment for the provider process.

A worker records which profile it used, and `worker_status` shows it. An unknown
profile name is an error, never a silent fall back to running locally.

### Example: manager outside, workers inside a devcontainer

```json
{
  "execProfiles": {
    "dev": {
      "name": "dev",
      "launcher": ["docker", "exec", "-i", "-w", "{cwd}", "my-devcontainer"],
      "pathMap": [{ "host": "/home/me/work/api", "target": "/workspaces/api" }]
    }
  },
  "defaultExecProfile": "dev"
}
```

```
worker_start(provider="claude", cwd="/home/me/work/api", task="...")
```

The provider runs inside the container at `/workspaces/api`; the journal, the
record and the control socket stay on the host. The provider CLI must be
installed and logged in **inside** the container — `worker_start` probes for it
through the same launcher and says so if it is missing.

No container is created or managed here. Point a profile at one you already run.

## Environment variables

| variable | effect |
|---|---|
| `AGENT_WORKERS_HOME` | state root (default `~/.agent-workers`) |
| `AGENT_WORKERS_CONFIG` | extra config file to merge |
| `AGENT_WORKERS_PROJECT_DIR` | the project directory workers default to |
| `AGENT_WORKERS_EXEC_PROFILE` | override `defaultExecProfile` |
| `AGENT_WORKERS_CLAUDE_BIN` / `AGENT_WORKERS_CODEX_BIN` | provider executables |
| `AGENT_WORKERS_CLIENT_ID` | override the ownership identity of this manager |
| `AGENT_WORKERS_ALLOW_NESTED` | `1` enables nested workers |
| `AGENT_WORKERS_SUPERVISOR` | path to `supervisor.mjs` (normally found automatically) |
| `AGENT_WORKERS_LOG` | `debug` \| `info` \| `warn` \| `error` |

Two managers sharing one state directory is supported and tested. Ownership is
derived from `(host kind, project directory)` so it survives a restart; set
`AGENT_WORKERS_CLIENT_ID` when you want two managers in the same project to be
distinct owners.

## Permissions

`worker_start` takes `permissionMode`, forwarded verbatim:

| provider | flag | values |
|---|---|---|
| claude | `--permission-mode` | `manual`, `acceptEdits`, `auto`, `plan`, `bypassPermissions` |
| codex | `approvalPolicy` | `untrusted`, `on-request`, `never` |

Defaults, when you do not pass one:

| | read-only worker | `writeAccess: true` |
|---|---|---|
| claude | `manual` + `--permission-prompts none` + `Write`/`Edit`/`NotebookEdit` denied | `acceptEdits` |
| codex | sandbox `read-only`, approvals `never` | sandbox `workspace-write`, approvals `on-request` |

A blanket bypass is never a default. When a worker is blocked by permissions, the
fix is `allowedTools` with the specific tools it needs — not
`bypassPermissions`.

## Write isolation

`writeAccess: true` requires isolation. `worker_start` refuses it without
`worktree: true` or a `worktreePath`, unless you pass `allowMainCheckout: true` -
which exists so that writing into a plain directory is a decision, never an
omission.

Two live write workers may never share a target. Enforcement is an atomic lock
file under the state directory keyed by the canonical path, so:

- a race between two starts has exactly one winner;
- `/repo` and `/repo/src` conflict, because they are the same files;
- a symlink alias is not a way around it;
- a lock whose owner has died is reclaimed.

A `worktreePath` pointing at the repository's own primary checkout is refused:
that is not isolation.

## Nesting

`allowNestedWorkers` is `false` by default. While it is off:

- Claude workers are started with `--strict-mcp-config`, so they load no MCP
  servers at all;
- Codex workers are started with `-c mcp_servers={}`;
- and the bridge refuses `worker_start` when it detects it is itself running
  inside a worker.

Turn it on deliberately if you want a worker to delegate further.
