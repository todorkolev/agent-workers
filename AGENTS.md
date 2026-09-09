# Working in this repository

`agent-workers` is a plugin that installs into both Claude Code and Codex and
gives either one the same MCP tools for driving persistent, interactive Claude
and Codex workers.

Read [docs/architecture.md](docs/architecture.md) before changing anything
structural, and [docs/providers.md](docs/providers.md) before touching an
adapter.

## Before you commit

```bash
npm run check    # typecheck + build + unit and integration tests
```

The bundles in `plugins/agent-workers/dist/` are **committed**, because
installing a plugin is a clone and must not need a toolchain. Rebuild them in
the same commit as the source change that affects them, or an installed plugin
silently runs old code.

## Ground rules

**Never claim more than was measured.** The two backends are genuinely different
and the tool's value depends on saying which one did what. `worker_send` reports
the delivery it actually got; a worker whose process is gone is `orphaned`, not
`running`; `worker_status` reports the model the backend said it used, not the
one that was requested. If you add a capability that only one provider has,
report its absence on the other rather than emulating it.

**Model and effort are forwarded verbatim.** Do not add an enum, a whitelist or
a clamp. The engine validates them, so an unknown value must fail loudly rather
than being quietly downgraded — a capped `max` is a bug, not a safety feature.

**Do not paper over missing interactivity with permissions.** If a worker cannot
do something because of its permission mode, that surfaces as an event and the
manager gives it the tools it needs. `bypassPermissions` is never a default and
never a workaround.

**One writer per file.** A worker's supervisor is the only process that writes
that worker's directory; bridges only read. If you add state, put it under the
supervisor or make it derivable, and never introduce a file two processes write.

**Inspection must not mutate.** Anything that reads a user's repository —
summaries, diffs, status — must be read-only. `git add`, even `-N`, is a write.

**Nothing host-specific in the core.** No project-, domain- or
organisation-specific rules belong in this plugin; it is a general tool.

## Adding a provider

Implement `ProviderAdapter` in `src/core/types.ts` and nothing else. If the new
backend cannot do something (steer a running turn, resume a session, route an
approval), say so in its `DeliveryResult.note` and in `docs/providers.md` rather
than pretending.

Verify against the real CLI and record what you observed — the version, the
transcript, the exact message shapes. `docs/providers.md` is a log of
measurements, not a summary of documentation.

## Testing

`test/integration.test.ts` drives the real bridge as a real MCP client with
scripted provider CLIs (`test/fixtures/`). It covers everything around the
models: delivery semantics, blocking, recovery, ownership, write isolation,
bridge restart. Add to it for anything in that machinery.

`scripts/smoke.mjs` runs the same scenarios against the actual `claude` and
`codex` CLIs. It costs real model usage, and it is the only thing that proves
the protocols still behave as `docs/providers.md` claims. Run it after any
adapter change:

```bash
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs codex basic
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs claude steer
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs codex recover
AGENT_WORKERS_HOME=/tmp/aw-smoke node scripts/smoke.mjs claude worktree
```

Adapter mocks alone never prove host integration. To check that, load the plugin
in the real host and confirm the tools appear:

```bash
claude -p --plugin-dir plugins/agent-workers --output-format stream-json --verbose ...
codex mcp list && codex exec 'Call the agent-workers MCP tool worker_list.'
```

## Commits

Conventional Commits. Say what changed and, when it is not obvious, why the
obvious alternative was wrong. Bug-fix commits should name the failure they
prevent, so the next person can tell whether their change reintroduces it.

Never commit logs, worker state, or credentials. `.gitignore` covers
`.agent-workers/`, `.worktrees/` and `*.log`; keep it that way.
