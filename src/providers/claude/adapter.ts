/**
 * Claude worker adapter — a persistent `claude` CLI session in streaming mode.
 *
 * Transport (verified against Claude Code 2.1.263 on linux):
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *
 * stdin and stdout each carry newline-delimited JSON. The process stays alive
 * for as long as stdin is open, so one child = one long-lived session across
 * many turns, and the model keeps its context between them.
 *
 * What was measured, and what this adapter therefore promises:
 *
 *   • Multi-turn context   — a second message on the same child recalls the
 *     first. (spike: "remember 4271" → "4271")
 *   • Mid-turn delivery    — a user message written while a turn is running is
 *     QUEUED and handed to the model at its next tool boundary, inside the same
 *     turn. It is not an acknowledged injection: if the worker is blocked in one
 *     long tool call, delivery waits for that call to finish. Reported as
 *     `queued_for_turn`, never as a guaranteed steer.
 *   • Interrupt            — `{type:"control_request",request:{subtype:"interrupt"}}`
 *     cancels the running turn and answers with
 *     `{subtype:"success", response:{still_queued:[...]}}`. The session survives.
 *   • Resume               — `--resume <session-id>` in a NEW process restores
 *     the full conversation and keeps the same session id.
 *   • Permissions          — anything the permission mode does not allow surfaces
 *     as a `system/permission_denied` event and the model is told; it never hangs.
 *
 * Auth is whatever the installed CLI already uses; nothing here forces an API
 * key. `--bare` is deliberately never passed, because it would disable OAuth and
 * silently switch the worker to paid API billing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type {
  DeliveryResult,
  ProviderAdapter,
  RespondDecision,
  SessionInfo,
  SessionOptions,
  WorkerEvent,
} from "../../core/types.ts";
import { createLogger } from "../../core/logger.ts";

const log = createLogger("claude-adapter");

type Emitted = Omit<WorkerEvent, "seq">;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Compact a tool input into a one-line summary; never dump whole payloads. */
function summarizeToolInput(name: string, input: unknown): string {
  const r = rec(input);
  if (!r) return name;
  const pick = (key: string): string | undefined => {
    const v = r[key];
    return typeof v === "string" ? v : undefined;
  };
  const detail =
    pick("command") ??
    pick("file_path") ??
    pick("path") ??
    pick("pattern") ??
    pick("url") ??
    pick("description");
  if (detail === undefined) return name;
  const flat = detail.replace(/\s+/g, " ").trim();
  return `${name}: ${flat.length > 160 ? `${flat.slice(0, 157)}…` : flat}`;
}

/** Flatten a tool_result content block into a short single line. */
function summarizeToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const r = rec(part);
        return r ? (str(r["text"]) ?? `[${String(r["type"] ?? "block")}]`) : String(part);
      })
      .join(" ");
  }
  return "";
}

function firstLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class ClaudeCliAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  private child: ChildProcessWithoutNullStreams | undefined;
  private sessionId: string | undefined;
  private _actualModel: string | undefined;
  private _turnId: string | undefined;
  private turnCounter = 0;
  private disposed = false;

  private readonly rawCbs: Array<(msg: unknown) => void> = [];
  private readonly eventCbs: Array<(ev: Emitted) => void> = [];
  private readonly stderrCbs: Array<(line: string) => void> = [];
  private readonly exitCbs: Array<(info: { code: number | null; signal: string | null }) => void> = [];

  /** Resolvers for in-flight `control_request`s, keyed by request id. */
  private readonly pendingControl = new Map<string, (response: unknown) => void>();
  private controlCounter = 0;

  /** Text of the most recent assistant message; becomes the turn's `final`. */
  private lastAssistantText: string | undefined;
  /** Resolves once the first `system/init` for the session arrives. */
  private ready: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } | undefined;

  get turnId(): string | undefined {
    return this._turnId;
  }

  /** Captured from `system/init`, which is the first place the CLI states it. */
  get actualModel(): string | undefined {
    return this._actualModel;
  }

  /* ── lifecycle ───────────────────────────────────────────────────────── */

  async start(opts: SessionOptions): Promise<SessionInfo> {
    // A caller-chosen session id makes recovery deterministic: the supervisor
    // can `--resume` it after a crash without having to have seen system/init.
    const sessionId = randomUUID();
    await this.launch(opts, ["--session-id", sessionId]);
    this.sessionId = sessionId;
    return { sessionId, ...(this._actualModel !== undefined ? { actualModel: this._actualModel } : {}) };
  }

  async resume(sessionId: string, opts: SessionOptions): Promise<SessionInfo> {
    await this.launch(opts, ["--resume", sessionId]);
    this.sessionId = sessionId;
    return { sessionId, ...(this._actualModel !== undefined ? { actualModel: this._actualModel } : {}) };
  }

  /** Build argv and spawn the child. Shared by start/resume. */
  private async launch(opts: SessionOptions, sessionArgs: string[]): Promise<void> {
    if (this.child) throw new Error("ClaudeCliAdapter already launched");

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      ...sessionArgs,
    ];

    // Model and effort are forwarded verbatim. The CLI is the authority on which
    // values exist; we never gate them against a hard-coded enum (that is how a
    // valid "max" ends up silently downgraded) and we never substitute a model.
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);

    // Approval posture. `writeAccess` only picks a conservative default; a
    // blanket bypass is never implied and must be asked for by name.
    const mode = opts.permissionMode ?? (opts.writeAccess ? "acceptEdits" : "manual");
    args.push("--permission-mode", mode);
    if (mode !== "bypassPermissions") {
      // Nobody is sitting at this session, so anything that would open a prompt
      // is denied and reported as an event rather than left hanging forever.
      args.push("--permission-prompts", "none");
    }
    if (!opts.writeAccess) args.push("--disallowedTools", "Write", "Edit", "NotebookEdit");
    if (opts.allowedTools?.length) args.push("--allowedTools", ...opts.allowedTools);
    if (opts.disallowedTools?.length) args.push("--disallowedTools", ...opts.disallowedTools);
    if (opts.instructions) args.push("--append-system-prompt", opts.instructions);
    if (opts.providerArgs?.length) args.push(...opts.providerArgs);

    const argv = [...opts.launcher, opts.bin, ...args];
    const command = argv[0];
    if (command === undefined) throw new Error("empty provider argv");

    log.info(`spawning claude worker ${opts.workerId}: ${argv.slice(0, 6).join(" ")} …`);

    // Only spawn with a local cwd when the process really runs locally; under a
    // launcher the working directory belongs to the target and is expressed in
    // the launcher argv (e.g. `docker exec -w {cwd}`).
    const child = spawn(command, argv.slice(1), {
      ...(opts.launcher.length === 0 ? { cwd: opts.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.ready = { promise, resolve: resolveReady, reject: rejectReady };

    child.on("error", (err) => {
      const message = `claude CLI failed to start: ${err.message}`;
      this.ready?.reject(new Error(message));
      this.emit({ ts: new Date().toISOString(), type: "error", text: message });
    });

    child.on("exit", (code, signal) => {
      this.ready?.reject(new Error(`claude CLI exited before it was ready (code=${code} signal=${signal})`));
      for (const cb of this.exitCbs) cb({ code, signal });
    });

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onStdoutLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.length === 0) return;
      for (const cb of this.stderrCbs) cb(line);
    });

    // `system/init` is emitted at the start of every turn, so the handshake is
    // "the child accepted our argv" — which we learn from the first turn.
    // Waiting for init here would deadlock (no turn has been sent yet), so we
    // only wait for a fast failure window.
    await Promise.race([
      promise,
      new Promise<void>((resolve) => setTimeout(resolve, 400).unref?.()),
    ]).catch((err: Error) => {
      throw err;
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        done();
      }, 3000);
      timer.unref?.();
    });
  }

  /* ── turns ───────────────────────────────────────────────────────────── */

  async startTurn(text: string): Promise<DeliveryResult> {
    // The turn id is assigned by `system/init`, which is the CLI telling us a
    // turn really started. Minting one here as well produced two ids for one
    // turn and made the first turn look like the second.
    this.writeUser(text);
    return { delivery: "started_new_turn" };
  }

  async steer(text: string): Promise<DeliveryResult> {
    this.writeUser(text);
    return {
      delivery: "queued_for_turn",
      ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
      note:
        "Claude Code queues the message and delivers it inside the running turn at the next tool boundary. " +
        "If the worker is inside one long tool call, delivery waits for that call to finish; there is no read receipt.",
    };
  }

  async interrupt(): Promise<void> {
    const response = await this.controlRequest({ subtype: "interrupt" }, 15_000);
    const r = rec(response);
    const stillQueued = r?.["still_queued"];
    this._turnId = undefined;
    if (Array.isArray(stillQueued) && stillQueued.length > 0) {
      this.emit({
        ts: new Date().toISOString(),
        type: "status",
        text: `interrupt left ${stillQueued.length} queued message(s) undelivered`,
        data: { stillQueued: stillQueued.length },
      });
    }
  }

  /**
   * Claude's non-interactive session has no approval callback we can answer, so
   * the only decision it can act on is an answer to a question — delivered the
   * same way any other guidance is. Denials are reported as events instead.
   */
  async respond(requestId: string, decision: RespondDecision): Promise<void> {
    if (decision.decision === "answer" || decision.decision === "allow") {
      const body = decision.text ?? "Approved. Continue.";
      this.writeUser(body);
      return;
    }
    this.writeUser(decision.text ?? "Do not proceed with that. Stop and explain what you need instead.");
  }

  /* ── subscriptions ───────────────────────────────────────────────────── */

  onRaw(cb: (msg: unknown) => void): void {
    this.rawCbs.push(cb);
  }
  onEvent(cb: (ev: Emitted) => void): void {
    this.eventCbs.push(cb);
  }
  onStderr(cb: (line: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void {
    this.exitCbs.push(cb);
  }

  /* ── internals ───────────────────────────────────────────────────────── */

  private emit(ev: Emitted): void {
    for (const cb of this.eventCbs) {
      try {
        cb(ev);
      } catch (err) {
        log.error("event callback threw:", err);
      }
    }
  }

  private write(value: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("claude worker stdin is not writable");
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private writeUser(text: string): void {
    this.write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    });
  }

  private controlRequest(request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    this.controlCounter += 1;
    const requestId = `aw-${this.controlCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`claude control_request "${String(request["subtype"])}" timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingControl.set(requestId, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      try {
        this.write({ type: "control_request", request_id: requestId, request });
      } catch (err) {
        clearTimeout(timer);
        this.pendingControl.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Route one stdout line. Unknown shapes are persisted raw and ignored. */
  private onStdoutLine(line: string): void {
    if (line.trim().length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug("non-JSON line from claude:", line.slice(0, 200));
      return;
    }
    for (const cb of this.rawCbs) {
      try {
        cb(msg);
      } catch (err) {
        log.error("raw callback threw:", err);
      }
    }

    const m = rec(msg);
    if (!m) return;
    const ts = new Date().toISOString();
    const type = str(m["type"]);

    switch (type) {
      case "system":
        this.onSystem(m, ts);
        return;
      case "assistant":
        this.onAssistant(m, ts);
        return;
      case "user":
        this.onUser(m, ts);
        return;
      case "result":
        this.onResult(m, ts);
        return;
      case "control_response": {
        const r = rec(m["response"]);
        const id = r ? str(r["request_id"]) : undefined;
        if (id !== undefined) {
          const resolve = this.pendingControl.get(id);
          this.pendingControl.delete(id);
          resolve?.(r?.["response"]);
        }
        return;
      }
      case "control_request": {
        // The CLI only opens these when a host has registered for them. We have
        // not, so answer explicitly rather than let the worker stall on silence.
        const id = str(m["request_id"]);
        if (id !== undefined) {
          try {
            this.write({
              type: "control_response",
              response: { subtype: "error", request_id: id, error: "agentic-workers does not host this control request" },
            });
          } catch {
            /* child gone */
          }
        }
        return;
      }
      case "rate_limit_event": {
        const info = rec(m["rate_limit_info"]);
        this.emit({
          ts,
          type: "status",
          rawType: "rate_limit_event",
          text: `rate limit: ${String(info?.["status"] ?? "unknown")} (${String(info?.["rateLimitType"] ?? "?")})`,
          data: { auth: "subscription-window", status: info?.["status"] },
        });
        return;
      }
      default:
        return; // already persisted raw
    }
  }

  private onSystem(m: Record<string, unknown>, ts: string): void {
    const subtype = str(m["subtype"]);
    if (subtype === "init") {
      const sid = str(m["session_id"]);
      if (sid !== undefined) this.sessionId = sid;
      const model = str(m["model"]);
      if (model !== undefined) this._actualModel = model;
      this.ready?.resolve();
      this.turnCounter += 1;
      this._turnId = `turn-${this.turnCounter}`;
      this.emit({
        ts,
        type: "status",
        rawType: "system/init",
        text: `turn started (model ${model ?? "unknown"})`,
        turnId: this._turnId,
        data: { sessionId: sid, model },
      });
      return;
    }
    if (subtype === "permission_denied") {
      const tool = str(m["tool_name"]) ?? "tool";
      const message = str(m["message"]) ?? "permission denied";
      this.emit({
        ts,
        type: "permission_denied",
        rawType: "system/permission_denied",
        text: `${tool} was denied by the worker's permission settings: ${firstLine(message, 300)}`,
        ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
        data: { tool, toolUseId: str(m["tool_use_id"]) },
      });
      return;
    }
    this.emit({
      ts,
      type: "status",
      rawType: `system/${subtype ?? "?"}`,
      text: `system: ${subtype ?? "event"}`,
      ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
    });
  }

  private onAssistant(m: Record<string, unknown>, ts: string): void {
    const message = rec(m["message"]);
    const content = message?.["content"];
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = rec(raw);
      if (!block) continue;
      const blockType = str(block["type"]);
      if (blockType === "text") {
        const text = str(block["text"]);
        if (text === undefined || text.trim().length === 0) continue;
        this.lastAssistantText = text;
        this.emit({
          ts,
          type: "agent_message",
          rawType: "assistant.text",
          text,
          ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
        });
      } else if (blockType === "tool_use") {
        const name = str(block["name"]) ?? "tool";
        this.emit({
          ts,
          type: "tool_started",
          rawType: "assistant.tool_use",
          text: summarizeToolInput(name, block["input"]),
          ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
          data: { tool: name, toolUseId: str(block["id"]) },
        });
        if (name === "Write" || name === "Edit" || name === "NotebookEdit") {
          const input = rec(block["input"]);
          const file = input ? str(input["file_path"]) : undefined;
          if (file !== undefined) {
            this.emit({
              ts,
              type: "file_changed",
              rawType: "assistant.tool_use",
              text: file,
              ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
              data: { path: file, tool: name },
            });
          }
        }
      } else if (blockType === "thinking") {
        this.emit({
          ts,
          type: "status",
          rawType: "assistant.thinking",
          text: "thinking…",
          ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
        });
      }
    }
  }

  private onUser(m: Record<string, unknown>, ts: string): void {
    const message = rec(m["message"]);
    const content = message?.["content"];
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = rec(raw);
      if (!block) continue;
      if (str(block["type"]) !== "tool_result") continue;
      const isError = block["is_error"] === true;
      const summary = firstLine(summarizeToolResult(block["content"]), 240);
      this.emit({
        ts,
        type: "tool_completed",
        rawType: "user.tool_result",
        text: isError ? `tool failed: ${summary}` : summary,
        ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
        data: { isError, toolUseId: str(block["tool_use_id"]) },
      });
    }
  }

  private onResult(m: Record<string, unknown>, ts: string): void {
    const subtype = str(m["subtype"]) ?? "unknown";
    const isError = m["is_error"] === true;
    const text = str(m["result"]) ?? this.lastAssistantText;
    const sid = str(m["session_id"]);
    if (sid !== undefined) this.sessionId = sid;

    if (!isError && text !== undefined && text.trim().length > 0) {
      this.emit({
        ts,
        type: "final",
        rawType: "result",
        text,
        ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
      });
    }
    if (isError) {
      this.emit({
        ts,
        type: "error",
        rawType: `result/${subtype}`,
        text:
          subtype === "error_during_execution"
            ? "the turn ended early (interrupted or aborted)"
            : `turn failed: ${subtype}`,
        ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
        data: { subtype },
      });
    }
    this.emit({
      ts,
      type: "turn_completed",
      rawType: "result",
      text: `turn ${subtype}`,
      ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
      data: {
        subtype,
        isError,
        durationMs: m["duration_ms"],
        numTurns: m["num_turns"],
        totalCostUsd: m["total_cost_usd"],
      },
    });
    this._turnId = undefined;
  }
}
