/**
 * The MCP tool surface.
 *
 * One contract, four combinations: whichever product is driving (Claude Code or
 * Codex) sees exactly these tools, and each tool works the same way for a Claude
 * worker and a Codex worker.
 *
 * Where the two backends genuinely differ - above all in what happens to a
 * message sent to a worker that is already working - the difference is reported
 * rather than smoothed over. `worker_send` says whether the text was steered
 * into the running turn, queued for it, or started a new one, because a manager
 * that believes it steered when it only queued will misread everything after.
 */

import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  launcherArgv,
  loadConfig,
  providerBin,
  resolveExecProfile,
  toTargetPath,
  type Config,
} from "../core/config.ts";
import { probeProvider } from "../core/availability.ts";
import { ensureWorktree, repoRoot } from "../core/git.ts";
import { WORKER_ID_PATTERN, acquireSupervisorLock, canonical, readJson, readSince, purgeWorker, workerPaths, writeJsonAtomic } from "../core/store.ts";
import {
  DEFAULT_TRANSCRIPT_MODE,
  isTerminalState,
  type HostKind,
  type Provider,
  type TranscriptMode,
  type WorkerEvent,
  type WorkerOwner,
  type WorkerRecord,
  type WorkerResult,
} from "../core/types.ts";
import type { SupervisorSpec } from "../supervisor/spec.ts";
import {
  callSupervisor,
  findWriteConflict,
  listLiveWorkers,
  listWorkers,
  resolveWorker,
  spawnSupervisor,
  waitForSupervisor,
  waitForWorker,
  type ResolvedWorker,
} from "./registry.ts";
import { renderEvents, renderHeader, renderHint, renderList, renderResult } from "./render.ts";

export type ToolContext = {
  version: string;
  host: HostKind;
  clientId: string;
  projectDir: string;
};

/** What every tool returns: one block of text for the manager to read. */
export type ToolOutput = { text: string; isError?: boolean };

const ok = (text: string): ToolOutput => ({ text });
const fail = (text: string): ToolOutput => ({ text, isError: true });

/* ------------------------------------------------------------------------
 * Schemas
 * --------------------------------------------------------------------- */

const safeWorkerIdSchema = z.string().regex(WORKER_ID_PATTERN);
const providerSchema = z.enum(["claude", "codex"]);
const transcriptSchema = z.enum(["messages", "activity", "verbose"]);

export const startSchema = {
  provider: providerSchema.describe("Which backend runs this worker: claude or codex."),
  task: z.string().min(1).describe("The worker's opening instruction. It becomes the first turn."),
  workerId: safeWorkerIdSchema
    .optional()
    .describe("Stable id, reused across restarts. Derived from the task when omitted."),
  model: z
    .string()
    .optional()
    .describe(
      "Model name, forwarded to the backend verbatim (e.g. 'opus', 'gpt-5.6-sol'). " +
        "Never rewritten or substituted; an unknown name fails loudly.",
    ),
  effort: z
    .string()
    .optional()
    .describe("Reasoning effort, forwarded verbatim (e.g. 'high', 'max'). The backend validates it."),
  cwd: z.string().optional().describe("Working directory. Defaults to the manager's project directory."),
  writeAccess: z.boolean().optional().describe("Allow the worker to edit files. Default false (read-only)."),
  allowMainCheckout: z
    .boolean()
    .optional()
    .describe(
      "Permit a write worker to edit the directory directly instead of an isolated worktree. " +
        "Off by default: without it, writeAccess requires worktree or worktreePath, so a worker " +
        "never edits your own checkout by omission.",
    ),
  worktree: z
    .boolean()
    .optional()
    .describe("Run in a dedicated git worktree. Strongly recommended with writeAccess."),
  worktreePath: z
    .string()
    .optional()
    .describe("Use this worktree directory. An existing one is adopted, not recreated."),
  branch: z.string().optional().describe("Branch for the worktree. Default agent/<workerId>."),
  base: z.string().optional().describe("Exact git base for a new branch (sha, tag or ref). Default HEAD."),
  permissionMode: z
    .string()
    .optional()
    .describe(
      "Approval posture, forwarded verbatim: claude --permission-mode " +
        "(manual|acceptEdits|auto|plan|bypassPermissions); codex approvalPolicy " +
        "(untrusted|on-request|never). Defaults are conservative and never a blanket bypass.",
    ),
  allowedTools: z.array(z.string()).optional().describe("Tool allowlist passed to the provider (e.g. ['Bash','Read'])."),
  disallowedTools: z.array(z.string()).optional().describe("Tool denylist passed to the provider."),
  instructions: z.string().optional().describe("Extra system-prompt guidance for the worker."),
  transcriptMode: transcriptSchema.optional().describe("How much of the stream worker_read returns by default."),
  execProfile: z.string().optional().describe("Named execution target from config (e.g. a devcontainer)."),
  providerArgs: z.array(z.string()).optional().describe("Extra provider CLI arguments, forwarded verbatim."),
  waitFor: z
    .enum(["started", "first_message", "idle"])
    .optional()
    .describe("How long to block before returning. Default 'started' - the worker keeps going either way."),
  waitMs: z.number().int().min(0).max(600000).optional().describe("Upper bound for waitFor. Default 30000."),
};

export const readSchema = {
  workerId: safeWorkerIdSchema,
  cursor: z.number().int().min(0).optional().describe("Return only events after this sequence number. Default 0."),
  maxChars: z.number().int().min(200).max(120000).optional(),
  maxMessages: z.number().int().min(1).max(500).optional(),
  mode: transcriptSchema.optional().describe("Override the worker's transcript mode for this read."),
};

export const waitSchema = {
  workerId: safeWorkerIdSchema,
  cursor: z.number().int().min(0).optional().describe("Wait for an event after this sequence number."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(240000)
    .optional()
    .describe(
      "How long to block, default 45000. Kept under a minute by default because a " +
        "host's own MCP request timeout (often 60s) applies to this call - a longer wait " +
        "surfaces as a protocol timeout, not as a result. Just call it again to keep waiting.",
    ),
  until: z
    .enum(["message", "idle", "blocked", "end"])
    .optional()
    .describe("What to wait for. Default 'message': any new event, question or state change."),
};

export const sendSchema = {
  workerId: safeWorkerIdSchema,
  text: z.string().min(1),
  takeover: z.boolean().optional().describe("Take control of a worker another manager owns."),
};

export const respondSchema = {
  workerId: safeWorkerIdSchema,
  requestId: z.string().describe("From the permission_request or question event."),
  decision: z.enum(["allow", "deny", "answer"]),
  answers: z.record(z.array(z.string())).optional().describe("For multiple questions: answers keyed by the question IDs shown in worker_read. Supply every question ID."),
  text: z.string().optional().describe("The answer, or the reason for a denial."),
  takeover: z.boolean().optional(),
};

export const workerIdSchema = { workerId: safeWorkerIdSchema, takeover: z.boolean().optional() };

export const resumeSchema = {
  workerId: safeWorkerIdSchema,
  task: z.string().optional().describe("Optional instruction to send once the session is back."),
  takeover: z.boolean().optional(),
};

export const stopSchema = {
  workerId: safeWorkerIdSchema,
  purge: z.boolean().optional().describe("Also delete the worker's journals and artifacts."),
  takeover: z.boolean().optional(),
};

export const listSchema = {
  provider: providerSchema.optional(),
  state: z.string().optional().describe("Filter by worker state."),
  live: z.boolean().optional().describe("Only workers whose supervisor is alive."),
};

export const traceSchema = {
  workerId: safeWorkerIdSchema,
  cursor: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(200).max(200000).optional(),
};

/* ------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------- */

function owner(ctx: ToolContext): WorkerOwner {
  return { host: ctx.host, clientId: ctx.clientId, since: new Date().toISOString() };
}

/** A filesystem-safe, human-recognisable id derived from the task. */
function deriveWorkerId(provider: Provider, task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
    .slice(0, 32);
  const suffix = randomUUID().slice(0, 6);
  return `${provider}-${slug.length > 0 ? `${slug}-` : ""}${suffix}`;
}

async function needWorker(workerId: string): Promise<ResolvedWorker | ToolOutput> {
  const worker = await resolveWorker(workerId);
  if (worker === undefined) {
    return fail(`No worker "${workerId}". Use worker_list to see what exists.`);
  }
  return worker;
}

function isToolOutput(value: unknown): value is ToolOutput {
  return typeof value === "object" && value !== null && "text" in value;
}

/**
 * Turn a supervisor round-trip into a manager-readable answer. An unreachable
 * supervisor is the normal shape of "this worker's process is gone", so it gets
 * a real explanation and a next step, not a stack trace.
 */
function controlFailure(
  record: WorkerRecord,
  response: { error: string; code: string; recovery?: string },
): ToolOutput {
  const recovery = response.recovery ?? renderHint(record);
  return fail(`${response.error}\n${recovery}`);
}

/* ------------------------------------------------------------------------
 * worker_start
 * --------------------------------------------------------------------- */

export async function workerStart(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof startSchema>>,
): Promise<ToolOutput> {
  const cfg = await loadConfig(ctx.projectDir);

  // "Any host can drive any provider" must not quietly become recursive
  // fan-out: a worker only gets to start workers when that is asked for.
  const depth = Number.parseInt(process.env["AGENT_WORKERS_DEPTH"] ?? "0", 10) || 0;
  if (depth > 0 && !cfg.allowNestedWorkers) {
    return fail(
      "This bridge is itself running inside a worker, and nested workers are disabled. " +
        'Set "allowNestedWorkers": true in the agent-workers config to permit further delegation.',
    );
  }

  const provider = input.provider;
  const workerId = input.workerId ?? deriveWorkerId(provider, input.task);

  const existing = await resolveWorker(workerId);
  if (existing && existing.record.owner.clientId !== ctx.clientId) {
    return fail(`not_owner: worker "${workerId}" belongs to ${existing.record.owner.clientId}. Use worker_resume with explicit takeover or choose a new workerId.`);
  }
  if (existing !== undefined && !isTerminalState(existing.record.state) && existing.alive) {
    return fail(
      `Worker "${workerId}" already exists and is ${existing.record.state}. ` +
        "Use worker_send to talk to it, or pick a different workerId.",
    );
  }
  // A reused id keeps the previous run's journal so existing cursors stay valid.
  // Say so, or a read from cursor 0 quietly returns the old worker's output.
  const reusedFrom = existing !== undefined ? existing.record.lastSeq : undefined;

  let profile;
  try {
    profile = resolveExecProfile(cfg, input.execProfile);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const bin = providerBin(cfg, profile, provider);
  const cwd = path.resolve(input.cwd ?? ctx.projectDir);
  const probeLauncher = launcherArgv(profile, toTargetPath(profile, cwd));

  const availability = await probeProvider(provider, bin, probeLauncher);
  if (!availability.available) {
    return fail(`${availability.error}\n${availability.recovery ?? ""}`.trim());
  }

  if (cfg.maxLiveWorkers > 0) {
    const live = await listLiveWorkers();
    if (live.length >= cfg.maxLiveWorkers) {
      return fail(
        `${live.length} workers are already live (limit ${cfg.maxLiveWorkers}). ` +
          "Stop one, or raise maxLiveWorkers in the config.",
      );
    }
  }

  const writeAccess = input.writeAccess ?? false;

  // Isolation has to be the default, not the diligent choice. Forgetting
  // `worktree` on a write worker would otherwise hand it the manager's own
  // checkout, which is exactly the accident the worktree machinery exists to
  // prevent.
  const isolated = input.worktree === true || input.worktreePath !== undefined || input.branch !== undefined;
  if (writeAccess && !isolated && input.allowMainCheckout !== true) {
    return fail(
      "A write worker needs its own worktree: pass worktree: true (or worktreePath). " +
        "To let it edit this directory directly - including your main checkout - pass " +
        "allowMainCheckout: true and say so deliberately.",
    );
  }

  // Worktree resolution. An existing directory or branch is adopted rather than
  // recreated, so a caller who pre-made the worktree is never told their branch
  // already exists.
  let worktree: SupervisorSpec["worktree"];
  let effectiveCwd = cwd;
  if (input.worktree === true || input.worktreePath !== undefined || input.branch !== undefined) {
    const root = await repoRoot(cwd);
    if (root === undefined) {
      return fail(`${cwd} is not inside a git repository, so a worktree cannot be created.`);
    }
    const planned = path.resolve(input.worktreePath ?? path.join(root, ".worktrees", `aw-${workerId}`));
    if ((profile.launcher?.length ?? 0) > 0 && (toTargetPath(profile, root) !== root || toTargetPath(profile, planned) !== planned)) {
      return fail("Worktree creation/adoption with different host and target paths is unsupported: Git records absolute metadata paths. Run the MCP bridge and providers inside the same container namespace, or mount the repository and worktrees at identical paths. No worktree was created.");
    }
    try {
      const info = await ensureWorktree({
        repo: root,
        workerId,
        ...(input.base !== undefined ? { base: input.base } : {}),
        ...(input.worktreePath !== undefined ? { dir: input.worktreePath } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
      });
      worktree = info;
      effectiveCwd = info.path;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  // One live writer per directory. This is a correctness rule, not a quota:
  // two agents editing one checkout corrupt each other's work silently.
  if (writeAccess) {
    const conflict = await findWriteConflict(await canonical(effectiveCwd), workerId);
    if (conflict !== undefined) {
      return fail(
        `Worker "${conflict.workerId}" (${conflict.provider}, ${conflict.state}) is already writing in ${effectiveCwd}. ` +
          "Give this worker its own worktree, or stop that one first.",
      );
    }
  }

  const model = input.model ?? cfg.defaultModel[provider];
  const effort = input.effort ?? cfg.defaultEffort[provider];
  const targetCwd = toTargetPath(profile, effectiveCwd);

  const spec: SupervisorSpec = {
    workerId,
    provider,
    task: input.task,
    cwd: effectiveCwd,
    targetCwd,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    writeAccess,
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    transcriptMode: (input.transcriptMode ?? DEFAULT_TRANSCRIPT_MODE) as TranscriptMode,
    execProfile: profile.name,
    launcher: launcherArgv(profile, targetCwd),
    env: { ...(profile.env ?? {}), AGENT_WORKERS_DEPTH: String(depth + 1) },
    bin,
    ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
    ...(input.disallowedTools !== undefined ? { disallowedTools: input.disallowedTools } : {}),
    providerArgs: [...suppressNestedMcp(provider, cfg), ...(input.providerArgs ?? [])],
    ...(worktree !== undefined ? { worktree } : {}),
    owner: owner(ctx),
    version: ctx.version,
    ...(existing ? { expectedOwnerClientId: existing.record.owner.clientId } : {}),
    approvalTimeoutMs: 15 * 60 * 1000,
  };

  let supervisorPid: number;
  try {
    supervisorPid = (await spawnSupervisor(spec)).pid;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const waitMs = input.waitMs ?? 30_000;
  let worker = await waitForSupervisor(workerId, waitMs, supervisorPid);
  if (worker === undefined) {
    return fail(
      `Worker "${workerId}" did not publish a state within ${waitMs}ms. Check ${workerPaths(workerId).supervisorLog}.`,
    );
  }

  const waitFor = input.waitFor ?? "started";
  if (waitFor === "first_message" || waitFor === "idle") {
    const states =
      waitFor === "idle"
        ? (["idle", "blocked", "interrupted", "completed", "failed", "stopped"] as const)
        : (["blocked", "failed", "stopped"] as const);
    const outcome = await waitForWorker(workerId, {
      timeoutMs: waitMs,
      ...(waitFor === "first_message" ? { sinceSeq: 0, messagesOnly: true } : {}),
      states,
    });
    if (outcome.worker !== undefined) worker = outcome.worker;
  }

  const record = worker.record;
  if (record.state === "failed") {
    return fail(
      `Worker "${workerId}" failed to start: ${record.error?.message ?? "unknown error"}\n` +
        `${record.error?.recovery ?? ""}\nLogs: ${record.paths.supervisorLog}`,
    );
  }
  if (worker.confirmed === false) {
    return fail(
      `Worker "${workerId}" is still starting after ${waitMs}ms and has not established a ${provider} session. ` +
        `Check ${record.paths.supervisorLog}. If it recovers it will appear in worker_list.`,
    );
  }

  const lines = [renderHeader(worker)];
  lines.push(`cwd: ${record.cwd}`);
  if (record.worktree !== undefined) {
    lines.push(
      `worktree: ${record.worktree.path} - branch ${record.worktree.branch} ` +
        `(${record.worktree.created ? "created" : "adopted"}, base ${record.worktree.base.slice(0, 12)})`,
    );
  }
  if (record.sessionId !== undefined) lines.push(`session: ${record.sessionId}`);
  lines.push(
    `execProfile: ${record.execProfile}` +
      (spec.launcher.length > 0 ? ` (launcher: ${spec.launcher.join(" ")})` : ""),
  );
  if (availability.auth !== undefined) lines.push(`auth: ${availability.auth}`);
  lines.push(`artifacts: ${record.paths.dir}`);
  if (reusedFrom !== undefined && reusedFrom > 0) {
    lines.push(
      `note: this workerId was used before. Its journal continues from seq ${reusedFrom}, so read with ` +
        `cursor=${reusedFrom} to see only this run.`,
    );
  }
  lines.push("");
  lines.push(renderHint(record));
  return ok(lines.join("\n"));
}

/**
 * Keep a worker from inheriting this very MCP server unless nesting was asked
 * for. Claude honours `--strict-mcp-config`; Codex takes a config override.
 */
function suppressNestedMcp(provider: Provider, cfg: Config): string[] {
  if (cfg.allowNestedWorkers) return [];
  return provider === "claude" ? ["--strict-mcp-config"] : ["-c", "mcp_servers={}"];
}

/* ------------------------------------------------------------------------
 * worker_read / worker_trace
 * --------------------------------------------------------------------- */

export async function workerRead(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof readSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  const cfg = await loadConfig(ctx.projectDir);
  const record = found.record;
  const cursor = input.cursor ?? 0;
  const maxMessages = input.maxMessages ?? cfg.limits.maxMessages;
  const maxChars = input.maxChars ?? cfg.limits.maxMessageChars;

  const { entries, more } = await readSince<WorkerEvent>(record.paths.journal, cursor, maxMessages);
  const mode = (input.mode ?? record.transcriptMode) as TranscriptMode;
  const rendered = renderEvents(entries, mode, maxChars);
  const nextCursor = rendered.nextCursor > 0 ? rendered.nextCursor : cursor;
  const truncated = rendered.truncated || more;

  const lines = [renderHeader(found)];
  lines.push(
    `cursor ${cursor} -> ${nextCursor} | ${rendered.shown} shown (mode ${mode})` +
      (truncated ? " | MORE AVAILABLE - read again with the new cursor" : ""),
  );
  lines.push("");
  lines.push(rendered.shown > 0 ? rendered.text : "(nothing new)");
  if (record.pending.length > 0 || record.state !== "running") {
    lines.push("");
    lines.push(renderHint(record));
  }
  return ok(lines.join("\n"));
}

/** Raw provider events, for when the normalized transcript is not enough. */
export async function workerTrace(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof traceSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  const cfg = await loadConfig(ctx.projectDir);
  const maxChars = input.maxChars ?? cfg.limits.maxTraceChars;
  const record = found.record;

  const { entries } = await readSince<WorkerEvent>(record.paths.journal, input.cursor ?? 0, 500);
  const rendered = renderEvents(entries, "verbose", maxChars);
  return ok(
    [
      renderHeader(found),
      `verbose journal from cursor ${input.cursor ?? 0} -> ${rendered.nextCursor}` +
        (rendered.truncated ? " (truncated)" : ""),
      `raw provider events: ${record.paths.events}`,
      `provider stderr: ${record.paths.providerLog}`,
      "",
      rendered.text || "(nothing)",
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------------
 * worker_wait
 * --------------------------------------------------------------------- */

export async function workerWait(
  _ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof waitSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;

  const timeoutMs = input.timeoutMs ?? 45_000;
  const until = input.until ?? "message";
  const states =
    until === "idle"
      ? (["idle", "blocked", "interrupted", "completed", "failed", "stopped", "orphaned"] as const)
      : until === "end"
        ? (["completed", "failed", "stopped", "orphaned"] as const)
        : (["blocked", "failed", "stopped", "orphaned"] as const);

  const outcome = await waitForWorker(input.workerId, {
    timeoutMs,
    ...(until === "message" ? { sinceSeq: input.cursor ?? found.record.lastSeq, messagesOnly: true } : {}),
    states,
  });

  if (outcome.worker === undefined) return fail(`Worker "${input.workerId}" disappeared while waiting.`);

  const lines = [renderHeader(outcome.worker)];
  lines.push(
    outcome.reason === "timeout"
      ? `nothing new within ${timeoutMs}ms - the worker is still going; call worker_wait again to keep waiting`
      : `woke on: ${outcome.reason}`,
  );
  lines.push("");
  lines.push(renderHint(outcome.worker.record));
  if (outcome.reason === "event") {
    lines.push(
      `Read it with worker_read(workerId="${input.workerId}", cursor=${input.cursor ?? found.record.lastSeq}).`,
    );
  }
  return ok(lines.join("\n"));
}

/* ------------------------------------------------------------------------
 * control operations
 * --------------------------------------------------------------------- */

const DELIVERY_EXPLANATION: Record<string, string> = {
  started_new_turn: "The worker was idle, so this started a new turn.",
  steered_into_turn:
    "Accepted into the running Codex turn (turn/steer with an expectedTurnId precondition). " +
    "The model picks it up at its next reasoning boundary.",
  queued_for_turn:
    "Queued on the running Claude session. Claude Code delivers it inside the current turn at the next tool " +
    "boundary - if the worker is inside one long tool call, delivery waits for that call to finish, and there " +
    "is no read receipt. Use worker_interrupt when it has to stop now.",
  queued_after_block: "The worker is blocked on a decision; this follows once it is answered.",
  rejected: "Nothing was delivered.",
};

export async function workerSend(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof sendSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  if (found.record.state === "orphaned") {
    return fail(`Worker "${input.workerId}" has no live supervisor.\n${renderHint(found.record)}`);
  }

  const response = await callSupervisor(found.record, {
    op: "send",
    text: input.text,
    owner: owner(ctx),
    ...(input.takeover === true ? { takeover: true } : {}),
  });
  if (!response.ok) return controlFailure(found.record, response);
  if (response.op !== "send") return fail("unexpected control response");

  return ok(
    [
      renderHeader({ record: response.record, alive: true }),
      `delivery: ${response.delivery}`,
      DELIVERY_EXPLANATION[response.delivery] ?? "",
      response.note ?? "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

export async function workerInterrupt(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof workerIdSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  const response = await callSupervisor(found.record, {
    op: "interrupt",
    owner: owner(ctx),
    ...(input.takeover === true ? { takeover: true } : {}),
  });
  if (!response.ok) return controlFailure(found.record, response);
  if (response.op !== "interrupt") return fail("unexpected control response");
  return ok(
    [
      renderHeader({ record: response.record, alive: true }),
      "The current turn was cancelled. The session and its history are intact - " +
        "worker_send continues from here, and worker_stop ends the worker for good.",
    ].join("\n"),
  );
}

export async function workerStop(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof stopSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  if (found.record.owner.clientId !== ctx.clientId && input.takeover !== true) {
    return fail(`not_owner: worker "${input.workerId}" is controlled by ${found.record.owner.host} (client ${found.record.owner.clientId}). Use takeover: true to take control explicitly.`);
  }

  if (found.alive) {
    // Generous: the supervisor snapshots git before it dies, and that can take
    // longer than an ordinary control round-trip.
    const response = await callSupervisor(
      found.record,
      { op: "stop", owner: owner(ctx), ...(input.takeover === true ? { takeover: true } : {}) },
      90_000,
    );
    if (!response.ok) {
      // Reporting a stop that did not happen is worse than reporting a failure,
      // and purging on top of it would delete the journal of a live worker.
      return controlFailure(found.record, response);
    }
  } else {
    const claim = await acquireSupervisorLock(input.workerId);
    if ("heldBy" in claim) return fail("A supervisor is starting or stopping this worker; retry after it settles.");
    try {
      const latest = await resolveWorker(input.workerId);
      if (latest && latest.record.owner.clientId !== ctx.clientId && input.takeover !== true) return fail("not_owner: worker ownership changed; read its current owner before retrying.");
      if (input.purge === true) {
        await purgeWorker(input.workerId);
        return ok(`Worker "${input.workerId}" was stopped and its artifacts deleted.`);
      }
      const stopped: WorkerRecord = { ...(latest?.record ?? found.record), owner: owner(ctx), state: "stopped", updatedAt: new Date().toISOString() };
      await writeJsonAtomic(found.record.paths.record, stopped);
    } finally { await claim.lock.release(); }
  }

  if (input.purge === true) {
    // Only delete once the supervisor is provably gone; otherwise a live
    // process keeps writing into a directory we just removed.
    for (let i = 0; i < 40; i += 1) {
      const still = await resolveWorker(input.workerId);
      if (still === undefined || !still.alive) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const still = await resolveWorker(input.workerId);
    if (still !== undefined && still.alive) {
      return fail(
        `Worker "${input.workerId}" is still running (pid ${still.record.supervisorPid}); nothing was deleted. ` +
          "Try worker_stop again, or kill that process first.",
      );
    }
    const claim = await acquireSupervisorLock(input.workerId);
    if ("heldBy" in claim) return fail("A supervisor resumed this worker before purge; nothing was deleted.");
    try {
      const latest = await resolveWorker(input.workerId);
      if (latest && latest.record.owner.clientId !== ctx.clientId && input.takeover !== true) return fail("not_owner: ownership changed before purge; nothing was deleted.");
      await purgeWorker(input.workerId);
    } finally { await claim.lock.release(); }
    return ok(`Worker "${input.workerId}" was stopped and its artifacts deleted.`);
  }
  const after = await resolveWorker(input.workerId);
  return ok(
    [
      `Worker "${input.workerId}" stopped. Its provider process is gone; the journal and artifacts remain.`,
      after !== undefined ? `artifacts: ${after.record.paths.dir}` : "",
      "worker_resume reopens the saved provider session; worker_stop(purge=true) deletes everything.",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

export async function workerRespond(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof respondSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;

  // A permission request is a yes/no. Accepting "answer" for one meant that
  // replying with prose - even prose saying "do not run this" - was recorded as
  // approval and the command ran.
  const pending = found.record.pending.find((p) => p.requestId === input.requestId);
  if (pending?.kind === "permission" && input.decision === "answer") {
    return fail(
      `"${input.requestId}" is a permission request, not a question. Answer it with ` +
        'decision: "allow" or decision: "deny" (text is kept as the reason).',
    );
  }
  if (pending?.kind === "question" && input.decision !== "deny" && input.text === undefined && input.answers === undefined) {
    return fail(`"${input.requestId}" is a question. Answer it with decision: "answer" and the text.`);
  }
  const response = await callSupervisor(found.record, {
    op: "respond",
    requestId: input.requestId,
    decision: {
      decision: input.decision,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.answers !== undefined ? { answers: input.answers } : {}),
    },
    owner: owner(ctx),
    ...(input.takeover === true ? { takeover: true } : {}),
  });
  if (!response.ok) return controlFailure(found.record, response);
  if (response.op !== "respond") return fail("unexpected control response");
  return ok(
    [
      renderHeader({ record: response.record, alive: true }),
      `Answered ${input.requestId} with "${input.decision}".`,
    ].join("\n"),
  );
}

/* ------------------------------------------------------------------------
 * worker_resume - the recovery path
 * --------------------------------------------------------------------- */

export async function workerResume(
  ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof resumeSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  const record = found.record;

  // A live supervisor only needs un-sticking.
  if (record.owner.clientId !== ctx.clientId && input.takeover !== true) {
    return fail(`not_owner: worker "${input.workerId}" is controlled by ${record.owner.host} (client ${record.owner.clientId}). Use takeover: true to take control explicitly.`);
  }
  if (found.alive) {
    const response = await callSupervisor(record, {
      op: "resume",
      ...(input.task !== undefined ? { task: input.task } : {}),
      owner: owner(ctx),
      ...(input.takeover === true ? { takeover: true } : {}),
    });
    if (!response.ok) return controlFailure(record, response);
    const updated = "record" in response ? response.record : record;
    return ok([renderHeader({ record: updated, alive: true }), "Resumed the live worker."].join("\n"));
  }

  // Otherwise the supervisor is gone: start a fresh one on the saved session.
  if (record.sessionId === undefined) {
    return fail(
      `Worker "${input.workerId}" never recorded a provider session, so there is nothing to resume. ` +
        "Start a new worker instead.",
    );
  }

  const spec = await readJson<SupervisorSpec>(path.join(workerPaths(input.workerId).dir, "spec.json"));
  if (spec === undefined) {
    return fail(`Worker "${input.workerId}" has no saved spec on disk; it cannot be resumed automatically.`);
  }

  if (record.writeAccess) {
    const conflict = await findWriteConflict(record.worktree?.path ?? record.cwd, record.workerId);
    if (conflict !== undefined) {
      return fail(`Worker "${conflict.workerId}" is now writing in that directory. Stop it before resuming this one.`);
    }
  }

  const resumed: SupervisorSpec = {
    ...spec,
    resumeSessionId: record.sessionId,
    owner: owner(ctx),
    // An empty task means "reattach only" - the supervisor starts no turn.
    expectedOwnerClientId: record.owner.clientId,
    task: input.task ?? "",
  };

  let resumedPid: number;
  try {
    resumedPid = (await spawnSupervisor(resumed)).pid;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // Pin the pid: the previous supervisor's record is still on disk and would
  // otherwise satisfy the wait immediately.
  const worker = await waitForSupervisor(input.workerId, 30_000, resumedPid);
  if (worker === undefined) return fail(`The resumed supervisor for "${input.workerId}" did not report a state.`);
  if (worker.record.state === "failed") {
    return fail(
      `Resume failed: ${worker.record.error?.message ?? "unknown error"}\nLogs: ${worker.record.paths.supervisorLog}`,
    );
  }
  if (worker.confirmed === false) {
    // Still `starting` when the deadline passed. Saying "reattached" here would
    // be a claim we have no evidence for.
    return fail(
      `The resumed supervisor for "${input.workerId}" is still starting and has not reattached to the ` +
        `${record.provider} session yet. Check ${worker.record.paths.supervisorLog}, then try again.`,
    );
  }
  return ok(
    [
      renderHeader(worker),
      `Reattached to ${record.provider} session ${record.sessionId}. ` +
        `History is intact; the journal continues from seq ${worker.record.lastSeq}.`,
      input.task === undefined
        ? "No new instruction was sent - use worker_send when you want it to do something."
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
}

/* ------------------------------------------------------------------------
 * status / list / result
 * --------------------------------------------------------------------- */

export async function workerStatus(
  _ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof workerIdSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  const r = found.record;
  const lines = [renderHeader(found)];
  lines.push(`supervisor pid ${r.supervisorPid} - ${found.alive ? "alive" : "NOT RUNNING"}`);
  lines.push(`owner: ${r.owner.host} (client ${r.owner.clientId}) since ${r.owner.since}`);
  lines.push(`cwd: ${r.cwd}`);
  if (r.worktree !== undefined) lines.push(`worktree: ${r.worktree.path} (branch ${r.worktree.branch})`);
  lines.push(`execProfile: ${r.execProfile}`);
  lines.push(
    `requested model: ${r.requestedModel ?? "(provider default)"} | actually used: ${r.actualModel ?? "(not reported yet)"}`,
  );
  if (r.effort !== undefined) lines.push(`effort: ${r.effort}`);
  if (r.sessionId !== undefined) lines.push(`provider session: ${r.sessionId}`);
  lines.push(`created ${r.createdAt} | updated ${r.updatedAt}`);
  if (r.pending.length > 0) {
    lines.push("pending decisions:");
    for (const p of r.pending) lines.push(`  ${p.requestId} (${p.kind}): ${p.text}`);
  }
  if (r.error !== undefined) lines.push(`error: ${r.error.message}`);
  if (r.lastError !== undefined) lines.push(`last turn error (${r.lastError.ts}): ${r.lastError.message}`);
  lines.push(`artifacts: ${r.paths.dir}`);
  lines.push("");
  lines.push(renderHint(r));
  return ok(lines.join("\n"));
}

export async function workerList(
  _ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof listSchema>>,
): Promise<ToolOutput> {
  let workers = input.live === true ? await listLiveWorkers() : await listWorkers();
  if (input.provider !== undefined) workers = workers.filter((w) => w.record.provider === input.provider);
  if (input.state !== undefined) workers = workers.filter((w) => w.record.state === input.state);
  return ok(renderList(workers));
}

export async function workerResult(
  _ctx: ToolContext,
  input: z.infer<z.ZodObject<typeof workerIdSchema>>,
): Promise<ToolOutput> {
  const found = await needWorker(input.workerId);
  if (isToolOutput(found)) return found;
  const record = found.record;

  // A live supervisor recomputes the git summary; a dead one leaves the last
  // snapshot on disk, which is still the truth about what it did.
  if (found.alive) {
    const response = await callSupervisor(record, { op: "collect" }, 60_000);
    if (response.ok && response.op === "collect") {
      return ok(renderResult(response.result, response.record));
    }
  }
  const snapshot = await readJson<WorkerResult>(record.paths.result);
  if (snapshot === undefined) {
    return fail(`No result recorded for "${input.workerId}" yet (state ${record.state}).\n${renderHint(record)}`);
  }
  return ok(
    [renderResult(snapshot, record), "", "(from the last snapshot - the supervisor is no longer running)"].join("\n"),
  );
}

/** Stable per-manager identity so ownership survives a bridge restart. */
export function deriveClientId(host: HostKind, projectDir: string): string {
  const override = process.env["AGENT_WORKERS_CLIENT_ID"];
  if (override && override.length > 0) return override;
  const hash = createHash("sha256").update(`${host} ${path.resolve(projectDir)}`).digest("hex").slice(0, 12);
  return `${host}-${hash}`;
}
