/**
 * The shared contract for agent-workers.
 *
 * Everything in this file is provider-agnostic and host-agnostic: the same
 * types describe a Claude worker driven from Codex and a Codex worker driven
 * from Claude Code. Provider-specific wire shapes live in `src/providers/*`
 * and are normalized into these types before they reach a journal or a tool
 * result.
 *
 * Local imports are extensionless (bundler resolution + esbuild).
 */

/* ────────────────────────────────────────────────────────────────────────
 * Providers and hosts
 * ──────────────────────────────────────────────────────────────────────── */

/** The backend that actually runs a worker. */
export type Provider = "claude" | "codex";

export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

/** True when `value` is a supported provider id. */
export function isProvider(value: unknown): value is Provider {
  return value === "claude" || value === "codex";
}

/**
 * The product whose MCP client is driving the bridge. Detected best-effort
 * from the MCP `initialize` handshake and the environment; used only for
 * ownership bookkeeping and diagnostics, never to change tool behavior.
 */
export type HostKind = "claude-code" | "codex" | "unknown";

/* ────────────────────────────────────────────────────────────────────────
 * Lifecycle
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Worker lifecycle.
 *
 * `starting`  — supervisor is up, provider session not yet established.
 * `running`   — a turn is in flight.
 * `idle`      — session alive, no turn in flight; accepts a new turn.
 * `blocked`   — waiting for a decision from the manager (permission/question).
 * `interrupted` — the current turn was cancelled; the session is still alive
 *                 and can be continued. NOT terminal.
 * `stopped`   — the manager stopped the worker; the provider process is gone.
 *               Resumable only via a provider session resume.
 * `completed` — the worker finished and was collected. Terminal for control.
 * `failed`    — the supervisor or provider failed. Terminal for control.
 * `orphaned`  — the record says the worker was alive but its supervisor
 *               process is gone (e.g. machine reboot). Reported honestly
 *               instead of a lying `running`; recoverable with `worker_resume`.
 */
export type WorkerState =
  | "starting"
  | "running"
  | "idle"
  | "blocked"
  | "interrupted"
  | "stopped"
  | "completed"
  | "failed"
  | "orphaned";

/** States in which the supervisor process is expected to be alive. */
export const LIVE_STATES: readonly WorkerState[] = [
  "starting",
  "running",
  "idle",
  "blocked",
  "interrupted",
];

/** States that accept no further control operations. */
export const TERMINAL_STATES: readonly WorkerState[] = [
  "completed",
  "failed",
  "stopped",
];

export function isLiveState(state: WorkerState): boolean {
  return LIVE_STATES.includes(state);
}

export function isTerminalState(state: WorkerState): boolean {
  return TERMINAL_STATES.includes(state);
}

/* ────────────────────────────────────────────────────────────────────────
 * Normalized events — the provider-independent transcript
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The normalized event vocabulary. Both providers are mapped onto it; where a
 * provider has no equivalent the event type is simply never emitted (we do not
 * synthesize events to make the two look identical).
 */
export type EventType =
  /** Something the worker said to its manager. The primary signal. */
  | "agent_message"
  /** The worker's answer at the end of a turn. */
  | "final"
  /** Plan / todo update. */
  | "plan"
  /** Low-value lifecycle chatter (turn started, thinking, token usage). */
  | "status"
  /** A tool/command started. Summarized, never dumped. */
  | "tool_started"
  /** A tool/command finished (exit code, duration; output summarized). */
  | "tool_completed"
  /** Files were written by the worker. */
  | "file_changed"
  /** A unified diff became available. */
  | "diff"
  /** The worker needs a decision before it can continue. Answer with `worker_respond`. */
  | "permission_request"
  /** A permission was refused by the environment; the worker was told and continued. */
  | "permission_denied"
  /** The worker asked its manager a question in prose. */
  | "question"
  /** A turn ended (successfully or not). */
  | "turn_completed"
  /** An error the manager should see. */
  | "error";

/** Message-shaped events that are always worth showing to a manager. */
export const HIGH_SIGNAL_EVENTS: readonly EventType[] = [
  "agent_message",
  "final",
  "permission_request",
  "permission_denied",
  "question",
  "error",
];

/**
 * One normalized event. `seq` is a per-worker monotonic counter and is the
 * cursor unit for `worker_read` / `worker_wait`.
 */
export type WorkerEvent = {
  seq: number;
  ts: string;
  type: EventType;
  /** Human-readable body. Always present for message-shaped events. */
  text?: string;
  /** Provider's own event name, kept for debugging. */
  rawType?: string;
  /** Provider turn id, when the provider exposes one. */
  turnId?: string;
  /**
   * Set on `permission_request` and `question`: the token to pass back to
   * `worker_respond`. Absent means the event is informational only.
   */
  requestId?: string;
  /** Small structured payload (exit codes, paths, decisions). Never raw output. */
  data?: Record<string, unknown>;
};

/* ────────────────────────────────────────────────────────────────────────
 * Transcript verbosity
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * How much of a worker's stream reaches the manager by default.
 *
 * `messages`  — only high-signal events (what the worker said, asked, failed on).
 * `activity`  — default: messages plus one-line tool/file/diff summaries.
 * `verbose`   — everything normalized, including status chatter.
 *
 * Raw provider events are always persisted regardless of this setting and are
 * reachable through `worker_trace`.
 */
export type TranscriptMode = "messages" | "activity" | "verbose";

export const DEFAULT_TRANSCRIPT_MODE: TranscriptMode = "activity";

/* ────────────────────────────────────────────────────────────────────────
 * Execution environment
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Where a worker's provider CLI actually runs.
 *
 * The supervisor always runs next to the bridge (so journals, the registry and
 * recovery stay on one filesystem). Only the provider child is launched through
 * `launcher`, which makes "manager outside the container, worker inside" a
 * matter of configuration rather than a special code path.
 *
 * `launcher` is an argv prefix. `{cwd}` in any element is replaced with the
 * worker's cwd translated into target space via `pathMap`.
 *
 *   launcher: ["docker", "exec", "-i", "-w", "{cwd}", "-u", "node", "my-devcontainer"]
 *   pathMap:  [{ "host": "/home/me/work", "target": "/workspaces" }]
 */
export type ExecProfile = {
  name: string;
  /** argv prefix; empty/absent means run the provider directly on this machine. */
  launcher?: string[];
  /** Host↔target path translation, longest host prefix wins. */
  pathMap?: Array<{ host: string; target: string }>;
  /** Extra environment for the provider child. */
  env?: Record<string, string>;
  /** Override the provider executable inside the target (e.g. "/usr/local/bin/claude"). */
  bin?: Partial<Record<Provider, string>>;
};

/* ────────────────────────────────────────────────────────────────────────
 * Worker record — the persisted, single-writer state of one worker
 * ──────────────────────────────────────────────────────────────────────── */

/** Which manager currently holds control of a worker. */
export type WorkerOwner = {
  host: HostKind;
  /** Opaque id of the owning MCP client session. */
  clientId: string;
  since: string;
};

/** Paths to a worker's on-disk artifacts. All absolute. */
export type WorkerPaths = {
  dir: string;
  record: string;
  events: string;
  journal: string;
  providerLog: string;
  supervisorLog: string;
  result: string;
  final: string;
  diff: string;
  changedFiles: string;
  socket: string;
};

/**
 * Everything known about one worker. Written ONLY by that worker's supervisor
 * (single writer per file, atomic rename), read by any number of bridges. This
 * is what makes two hosts sharing one state directory safe.
 */
export type WorkerRecord = {
  workerId: string;
  provider: Provider;
  state: WorkerState;
  /** Free-form task description the worker was started with. */
  task: string;
  /** Provider session identity: Claude `session_id`, Codex `threadId`. */
  sessionId?: string;
  /** Provider turn id when a turn is in flight. */
  turnId?: string;
  /** Model requested by the caller (verbatim, never rewritten). */
  requestedModel?: string;
  /** Model the backend reported actually using. */
  actualModel?: string;
  /** Reasoning effort requested by the caller (verbatim). */
  effort?: string;
  cwd: string;
  /** Set when the worker runs in a git worktree this tool created or adopted. */
  worktree?: { path: string; branch: string; base: string; created: boolean };
  writeAccess: boolean;
  transcriptMode: TranscriptMode;
  execProfile: string;
  /** OS pid of the supervisor process (not the provider child). */
  supervisorPid: number;
  /** Highest event seq written so far. */
  lastSeq: number;
  /** Pending decisions the manager still has to answer. */
  pending: Array<{ requestId: string; kind: "permission" | "question"; text: string; ts: string }>;
  owner: WorkerOwner;
  createdAt: string;
  updatedAt: string;
  /** Populated when state is `failed`. */
  error?: { message: string; recovery?: string };
  /**
   * The most recent turn-level error, even when the worker recovered to `idle`.
   * A rejected model or a failed turn otherwise looks identical to a clean idle
   * worker in the state alone.
   */
  lastError?: { message: string; ts: string };
  paths: WorkerPaths;
  /** Bridge/supervisor version that produced this record. */
  version: string;
};

/* ────────────────────────────────────────────────────────────────────────
 * Delivery semantics — deliberately NOT unified across providers
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What actually happened to a `worker_send`.
 *
 * `started_new_turn`    — the worker was idle; the text began a fresh turn.
 * `steered_into_turn`   — Codex only: accepted into the active turn via
 *                         `turn/steer` with an `expectedTurnId` precondition.
 *                         The backend acknowledged it synchronously; the model
 *                         still sees it at its next reasoning boundary.
 * `queued_for_turn`     — Claude only: accepted onto the session's input queue.
 *                         Claude Code delivers it inside the running turn at the
 *                         next tool boundary. If the worker is blocked in one
 *                         long tool call, delivery waits for that call to end.
 *                         There is no acknowledgement that the model has read it.
 * `queued_after_block`  — the worker is waiting on a decision; the text will be
 *                         delivered once it is unblocked.
 * `rejected`            — the worker is terminal; nothing was delivered.
 */
export type SendDelivery =
  | "started_new_turn"
  | "steered_into_turn"
  | "queued_for_turn"
  | "queued_after_block"
  | "rejected";

/* ────────────────────────────────────────────────────────────────────────
 * Results
 * ──────────────────────────────────────────────────────────────────────── */

/** The collected outcome of a worker's work so far. */
export type WorkerResult = {
  workerId: string;
  provider: Provider;
  state: WorkerState;
  /** The worker's most recent final answer, if it produced one. */
  final?: string;
  actualModel?: string;
  changedFiles: string[];
  /** Present when the worker ran in a git worktree with commits. */
  commit?: { sha: string; subject: string; branch: string };
  diffStat?: string;
  artifacts: Record<string, string>;
};

/* ────────────────────────────────────────────────────────────────────────
 * Provider adapter seam
 * ──────────────────────────────────────────────────────────────────────── */

/** Everything a provider adapter needs to start or resume a session. */
export type SessionOptions = {
  workerId: string;
  cwd: string;
  /** cwd as the provider sees it (may differ from `cwd` under a launcher). */
  targetCwd: string;
  model?: string;
  effort?: string;
  writeAccess: boolean;
  /** Extra system-prompt style instructions for the worker. */
  instructions?: string;
  /** Provider argv prefix (docker exec …) and env. */
  launcher: string[];
  env: Record<string, string>;
  bin: string;
  /** Tool allow/deny lists, forwarded to whichever provider supports them. */
  allowedTools?: string[];
  disallowedTools?: string[];
  /**
   * Approval posture, forwarded verbatim to the backend:
   *   claude → `--permission-mode` (manual | acceptEdits | auto | plan | bypassPermissions)
   *   codex  → `approvalPolicy`    (untrusted | on-failure | on-request | never)
   * Omit to let `writeAccess` pick a conservative default. Never defaulted to a
   * blanket bypass.
   */
  permissionMode?: string;
  /** Provider-specific escape hatch, forwarded verbatim. */
  providerArgs?: string[];
};

/** What a provider reports once its session exists. */
export type SessionInfo = {
  sessionId: string;
  actualModel?: string;
};

/** The result of asking an adapter to deliver text. */
export type DeliveryResult = {
  delivery: SendDelivery;
  turnId?: string;
  note?: string;
};

/**
 * The seam every backend implements. One adapter instance owns exactly one
 * provider child process and one provider session.
 */
export type ProviderAdapter = {
  readonly provider: Provider;
  /** Spawn the child and establish a new session. */
  start(opts: SessionOptions): Promise<SessionInfo>;
  /** Spawn the child and re-attach to an existing provider session. */
  resume(sessionId: string, opts: SessionOptions): Promise<SessionInfo>;
  /** Begin a turn on an idle session. */
  startTurn(text: string): Promise<DeliveryResult>;
  /** Deliver text to a turn that is already running. */
  steer(text: string, turnId: string | undefined): Promise<DeliveryResult>;
  /** Cancel the running turn, keeping the session alive. */
  interrupt(): Promise<void>;
  /** Answer a pending permission request or question. */
  respond(requestId: string, decision: RespondDecision): Promise<void>;
  /** Kill the child. */
  dispose(): Promise<void>;
  /** Every raw inbound provider message, before any filtering. */
  onRaw(cb: (msg: unknown) => void): void;
  /** Normalized events. */
  onEvent(cb: (ev: Omit<WorkerEvent, "seq">) => void): void;
  /** Provider stderr lines. */
  onStderr(cb: (line: string) => void): void;
  /** Fired when the provider child exits unexpectedly. */
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void;
  /** Current turn id, when one is in flight. */
  readonly turnId: string | undefined;
  /**
   * The model the backend says it is really using. Claude only reveals this
   * once a turn starts, so it is a live getter rather than a start-time value:
   * reporting the requested model as though it were the actual one is exactly
   * the kind of silent substitution this tool must never do.
   */
  readonly actualModel: string | undefined;
};

/** A manager's answer to a `permission_request` or `question`. */
export type RespondDecision = {
  decision: "allow" | "deny" | "answer";
  /** Required for `answer`, optional explanation for `deny`. */
  text?: string;
};

/* ────────────────────────────────────────────────────────────────────────
 * Availability
 * ──────────────────────────────────────────────────────────────────────── */

/** Result of probing whether a provider CLI is usable right now. */
export type ProviderAvailability = {
  provider: Provider;
  available: boolean;
  version?: string;
  /** How the CLI is authenticated, when it can be determined. */
  auth?: string;
  error?: string;
  recovery?: string;
};
