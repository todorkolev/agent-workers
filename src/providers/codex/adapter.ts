/**
 * Codex worker adapter — one `codex app-server` child holding one thread.
 *
 * Transport (verified against codex-cli 0.153.4 on linux): newline-delimited
 * JSON-RPC over stdio. One JSON object per line, no Content-Length framing.
 *
 *   has id + result/error, no method → response to one of our requests
 *   has method, no id                → notification
 *   has method AND id                → a server request we MUST answer
 *
 * Lifecycle: `initialize` → `thread/start` → `turn/start` → notifications →
 * `turn/completed`. A running turn takes `turn/steer` (with an `expectedTurnId`
 * precondition); an idle thread takes a fresh `turn/start`. `thread/resume`
 * re-attaches to a persisted thread in a brand-new process.
 *
 * Wire facts below are taken from the bindings the installed CLI generates
 * (`codex app-server generate-ts`), not guessed:
 *   ReasoningEffort                  = string  (any effort value; never gated here)
 *   AskForApproval                   = "untrusted" | "on-request" | granular | "never"
 *   SandboxMode                      = "read-only" | "workspace-write" | "danger-full-access"
 *   CommandExecutionApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel" | …
 *   FileChangeApprovalDecision       = "accept" | "acceptForSession" | "decline" | "cancel"
 *   ReviewDecision (legacy)          = "approved" | "approved_for_session" | {denied:{rejection}} | "abort" | …
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import type {
  DeliveryResult,
  ProviderAdapter,
  RespondDecision,
  SessionInfo,
  SessionOptions,
  WorkerEvent,
} from "../../core/types.ts";
import { createLogger } from "../../core/logger.ts";

const log = createLogger("codex-adapter");

type Emitted = Omit<WorkerEvent, "seq">;
type JsonRpcId = number | string;

function rec(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function textInput(text: string): Array<Record<string, unknown>> {
  return [{ type: "text", text, text_elements: [] }];
}
function firstLine(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Server requests we can answer, and the decision field each expects. */
type ApprovalKind = "commandExecution" | "fileChange" | "legacyExec" | "legacyPatch" | "userInput";

const APPROVAL_METHODS: Record<string, ApprovalKind> = {
  "item/commandExecution/requestApproval": "commandExecution",
  "item/fileChange/requestApproval": "fileChange",
  execCommandApproval: "legacyExec",
  applyPatchApproval: "legacyPatch",
  "item/tool/requestUserInput": "userInput",
};

type ParkedRequest = {
  id: JsonRpcId;
  kind: ApprovalKind;
  /** Question ids, for `item/tool/requestUserInput`. */
  questionIds?: string[];
};

export class CodexAppServerAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;

  private child: ChildProcessWithoutNullStreams | undefined;
  private threadId: string | undefined;
  private _turnId: string | undefined;
  private _actualModel: string | undefined;
  private disposed = false;
  private effort: string | undefined;

  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  private readonly parked = new Map<string, ParkedRequest>();
  private turnEndWaiters: Array<() => void> = [];
  private exitError: Error | undefined;

  private readonly rawCbs: Array<(msg: unknown) => void> = [];
  private readonly eventCbs: Array<(ev: Emitted) => void> = [];
  private readonly stderrCbs: Array<(line: string) => void> = [];
  private readonly exitCbs: Array<(info: { code: number | null; signal: string | null }) => void> = [];

  get turnId(): string | undefined {
    return this._turnId;
  }

  /** Echoed by `thread/start` / `thread/resume`. */
  get actualModel(): string | undefined {
    return this._actualModel;
  }

  /* ── lifecycle ───────────────────────────────────────────────────────── */

  async start(opts: SessionOptions): Promise<SessionInfo> {
    await this.launch(opts);
    const result = await this.request("thread/start", this.threadParams(opts));
    const r = rec(result);
    const thread = r ? rec(r["thread"]) : undefined;
    const threadId = thread ? str(thread["id"]) : undefined;
    if (threadId === undefined) throw new Error("codex thread/start returned no thread.id");
    this.threadId = threadId;
    this._actualModel = r ? str(r["model"]) : undefined;
    return { sessionId: threadId, ...(this._actualModel !== undefined ? { actualModel: this._actualModel } : {}) };
  }

  async resume(sessionId: string, opts: SessionOptions): Promise<SessionInfo> {
    await this.launch(opts);
    const result = await this.request("thread/resume", { threadId: sessionId, ...this.threadParams(opts) });
    const r = rec(result);
    const thread = r ? rec(r["thread"]) : undefined;
    this.threadId = (thread ? str(thread["id"]) : undefined) ?? sessionId;
    this._actualModel = r ? str(r["model"]) : undefined;
    return { sessionId: this.threadId, ...(this._actualModel !== undefined ? { actualModel: this._actualModel } : {}) };
  }

  /** Shared `thread/start` / `thread/resume` parameters. */
  private threadParams(opts: SessionOptions): Record<string, unknown> {
    // Sandbox follows write access; approval policy defaults to asking, so a
    // write worker surfaces a decision to its manager instead of acting alone.
    const sandbox = opts.writeAccess ? "workspace-write" : "read-only";
    const approvalPolicy = opts.permissionMode ?? (opts.writeAccess ? "on-request" : "never");
    return {
      cwd: opts.targetCwd,
      sandbox,
      approvalPolicy,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.instructions !== undefined ? { baseInstructions: opts.instructions } : {}),
    };
  }

  private async launch(opts: SessionOptions): Promise<void> {
    if (this.child) throw new Error("CodexAppServerAdapter already launched");
    this.effort = opts.effort;

    const argv = [...opts.launcher, opts.bin, "app-server", ...(opts.providerArgs ?? [])];
    const command = argv[0];
    if (command === undefined) throw new Error("empty provider argv");

    log.info(`spawning codex worker ${opts.workerId}: ${argv.slice(0, 6).join(" ")} …`);

    const child = spawn(command, argv.slice(1), {
      ...(opts.launcher.length === 0 ? { cwd: opts.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.on("error", (err) => this.failAll(new Error(`codex app-server failed to start: ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`codex app-server exited (code=${code} signal=${signal})`));
      for (const cb of this.exitCbs) cb({ code, signal });
    });

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onStdoutLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      // bubblewrap notices are normal here; they are logged, never fatal.
      if (line.length === 0) return;
      for (const cb of this.stderrCbs) cb(line);
    });

    await this.request("initialize", {
      clientInfo: { name: "agentic-workers", title: "Agentic Workers", version: opts.workerId },
      capabilities: null,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.failAll(new Error("codex app-server disposed"));
      return;
    }
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
    this.failAll(new Error("codex app-server disposed"));
  }

  /* ── turns ───────────────────────────────────────────────────────────── */

  async startTurn(text: string): Promise<DeliveryResult> {
    const threadId = this.requireThread();
    // Effort rides on turn/start (ReasoningEffort is a turn parameter, not a
    // thread one) and is forwarded verbatim: the engine validates it, so the
    // accepted set grows with the CLI instead of being capped by this file.
    const result = await this.request("turn/start", {
      threadId,
      input: textInput(text),
      ...(this.effort !== undefined ? { effort: this.effort } : {}),
    });
    const turn = rec(rec(result)?.["turn"]);
    const turnId = turn ? str(turn["id"]) : undefined;
    if (turnId === undefined) throw new Error("codex turn/start returned no turn.id");
    this._turnId = turnId;
    return { delivery: "started_new_turn", turnId };
  }

  async steer(text: string, turnId: string | undefined): Promise<DeliveryResult> {
    const threadId = this.requireThread();
    const expectedTurnId = turnId ?? this._turnId;
    if (expectedTurnId === undefined) return this.startTurn(text);
    const result = await this.request("turn/steer", {
      threadId,
      input: textInput(text),
      expectedTurnId,
    });
    const echoed = str(rec(result)?.["turnId"]);
    if (echoed !== undefined) this._turnId = echoed;
    return {
      delivery: "steered_into_turn",
      ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
      note:
        "Accepted into the active Codex turn. The model reads it at its next reasoning boundary — " +
        "a command already running finishes first.",
    };
  }

  async interrupt(): Promise<void> {
    const threadId = this.threadId;
    const turnId = this._turnId;
    if (threadId === undefined || turnId === undefined) return;
    const ended = this.waitForTurnEnd();
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch (err) {
      // The interrupt can race a turn that was already completing.
      log.warn("turn/interrupt rejected:", err);
    }
    await ended;
  }

  /** Answer a parked approval / user-input request with the manager's decision. */
  async respond(requestId: string, decision: RespondDecision): Promise<void> {
    const parked = this.parked.get(requestId);
    if (!parked) throw new Error(`no pending codex request "${requestId}"`);
    this.parked.delete(requestId);
    const allow = decision.decision === "allow" || decision.decision === "answer";

    switch (parked.kind) {
      case "commandExecution":
      case "fileChange":
        this.write({ id: parked.id, result: { decision: allow ? "accept" : "decline" } });
        return;
      case "legacyExec":
      case "legacyPatch":
        this.write({
          id: parked.id,
          result: {
            decision: allow ? "approved" : { denied: { rejection: decision.text ?? "denied by the manager" } },
          },
        });
        return;
      case "userInput": {
        const answers: Record<string, unknown> = {};
        for (const qid of parked.questionIds ?? []) {
          answers[qid] = { type: "text", text: decision.text ?? "" };
        }
        this.write({ id: parked.id, result: { answers } });
        return;
      }
    }
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

  private requireThread(): string {
    const threadId = this.threadId;
    if (threadId === undefined) throw new Error("no codex thread; start() was not called");
    return threadId;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("codex app-server stdin is not writable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdoutLine(line: string): void {
    if (line.trim().length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log.debug("non-JSON line from codex:", line.slice(0, 200));
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
    const hasId = "id" in m && m["id"] !== null && m["id"] !== undefined;
    const hasMethod = typeof m["method"] === "string";

    if (hasId && hasMethod) {
      this.onServerRequest(m);
      return;
    }
    if (hasId && ("result" in m || "error" in m)) {
      this.settle(m);
      return;
    }
    if (hasMethod) this.onNotification(m["method"] as string, m["params"]);
  }

  private settle(m: Record<string, unknown>): void {
    const id = m["id"] as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = rec(m["error"]);
    if (error) {
      const message = str(error["message"]) ?? "unknown error";
      const code = error["code"];
      pending.reject(
        new Error(`codex ${pending.method} failed: ${message}${code !== undefined ? ` (code ${String(code)})` : ""}`),
      );
      return;
    }
    pending.resolve(m["result"]);
  }

  /**
   * A server request must always be answered — silence stalls the worker. We
   * park the ones a manager can decide, and return a JSON-RPC error for the
   * infrastructure ones we are not equipped to satisfy (so Codex can fall back
   * rather than wait on a fabricated result body it cannot read).
   */
  private onServerRequest(m: Record<string, unknown>): void {
    const id = m["id"] as JsonRpcId;
    const method = m["method"] as string;
    const params = rec(m["params"]) ?? {};
    const ts = new Date().toISOString();
    const kind = APPROVAL_METHODS[method];

    if (kind === undefined) {
      this.write({ id, error: { code: -32601, message: `agentic-workers cannot answer ${method}` } });
      this.emit({
        ts,
        type: "status",
        rawType: method,
        text: `declined an unsupported Codex request (${method})`,
      });
      return;
    }

    const requestId = `codex-${String(id)}`;
    if (kind === "userInput") {
      const questions = Array.isArray(params["questions"]) ? params["questions"] : [];
      const ids: string[] = [];
      const prompts: string[] = [];
      for (const raw of questions) {
        const q = rec(raw);
        if (!q) continue;
        const qid = str(q["id"]);
        if (qid !== undefined) ids.push(qid);
        prompts.push(`${str(q["header"]) ?? ""} ${str(q["question"]) ?? ""}`.trim());
      }
      this.parked.set(requestId, { id, kind, questionIds: ids });
      this.emit({
        ts,
        type: "question",
        rawType: method,
        text: prompts.join("\n") || "the worker asked a question",
        requestId,
        ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
      });
      return;
    }

    this.parked.set(requestId, { id, kind });
    this.emit({
      ts,
      type: "permission_request",
      rawType: method,
      text: describeApproval(kind, params),
      requestId,
      ...(this._turnId !== undefined ? { turnId: this._turnId } : {}),
      data: { method, cwd: str(params["cwd"]), reason: str(params["reason"]) },
    });
  }

  private onNotification(method: string, rawParams: unknown): void {
    const p = rec(rawParams) ?? {};
    const ts = new Date().toISOString();
    const turnId = this._turnId;
    const withTurn = turnId !== undefined ? { turnId } : {};

    switch (method) {
      case "turn/started": {
        const id = str(rec(p["turn"])?.["id"]);
        if (id !== undefined) this._turnId = id;
        this.emit({ ts, type: "status", rawType: method, text: "turn started", ...(id ? { turnId: id } : {}) });
        return;
      }
      case "turn/completed": {
        const status = str(rec(p["turn"])?.["status"]) ?? "completed";
        this.emit({ ts, type: "turn_completed", rawType: method, text: `turn ${status}`, ...withTurn, data: { status } });
        this._turnId = undefined;
        this.resolveTurnEnd();
        return;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(p["plan"]) ? p["plan"] : [];
        this.emit({
          ts,
          type: "plan",
          rawType: method,
          text: str(p["explanation"]) ?? `plan updated (${plan.length} step(s))`,
          ...withTurn,
          data: { steps: plan.length },
        });
        return;
      }
      case "turn/diff/updated": {
        const diff = str(p["diff"]) ?? "";
        this.emit({
          ts,
          type: "diff",
          rawType: method,
          text: `diff updated (${diff.split("\n").length} lines)`,
          ...withTurn,
          data: { diff },
        });
        return;
      }
      case "item/started":
      case "item/completed": {
        this.onItem(method, rec(p["item"]), ts, withTurn);
        return;
      }
      case "error": {
        const err = rec(p["error"]);
        const willRetry = p["willRetry"] === true;
        this.emit({
          ts,
          type: "error",
          rawType: method,
          text: `${str(err?.["message"]) ?? "codex error"}${willRetry ? " (retrying)" : ""}`,
          ...withTurn,
          data: { willRetry },
        });
        // A retryable error keeps the same turn alive; only a terminal one ends it.
        if (!willRetry) {
          this._turnId = undefined;
          this.resolveTurnEnd();
        }
        return;
      }
      default:
        return; // persisted raw; not worth a normalized event
    }
  }

  private onItem(method: string, item: Record<string, unknown> | undefined, ts: string, withTurn: { turnId?: string }): void {
    if (!item) return;
    const type = str(item["type"]);
    const completed = method === "item/completed";

    if (type === "agentMessage") {
      if (!completed) return;
      const text = str(item["text"]);
      if (text === undefined || text.trim().length === 0) return;
      this.emit({ ts, type: "agent_message", rawType: method, text, ...withTurn });
      return;
    }
    if (type === "commandExecution") {
      const command = str(item["command"]) ?? "command";
      if (!completed) {
        this.emit({ ts, type: "tool_started", rawType: method, text: firstLine(command), ...withTurn });
        return;
      }
      const exitCode = item["exitCode"];
      const durationMs = item["durationMs"];
      // aggregatedOutput is the FULL command output: summarized here, kept in
      // events.ndjson, and only ever returned in full through worker_trace.
      this.emit({
        ts,
        type: "tool_completed",
        rawType: method,
        text: `${firstLine(command, 120)} → exit ${String(exitCode ?? "?")}`,
        ...withTurn,
        data: { exitCode, durationMs },
      });
      return;
    }
    if (type === "fileChange" && completed) {
      const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
      const paths = changes.map((c) => str(rec(c)?.["path"]) ?? "").filter((s) => s.length > 0);
      this.emit({
        ts,
        type: "file_changed",
        rawType: method,
        text: paths.join(", ") || `${changes.length} file(s) changed`,
        ...withTurn,
        data: { paths, status: str(item["status"]) },
      });
      return;
    }
    if (type === "reasoning" && completed) {
      this.emit({ ts, type: "status", rawType: method, text: "reasoning", ...withTurn });
    }
  }

  private waitForTurnEnd(): Promise<void> {
    if (this._turnId === undefined) return Promise.resolve();
    return new Promise<void>((resolve) => this.turnEndWaiters.push(resolve));
  }

  private resolveTurnEnd(): void {
    const waiters = this.turnEndWaiters;
    this.turnEndWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private failAll(error: Error): void {
    if (!this.exitError) this.exitError = error;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pending) p.reject(error);
    this.resolveTurnEnd();
  }
}

/** Human-readable one-liner for an approval request. */
function describeApproval(kind: ApprovalKind, params: Record<string, unknown>): string {
  const reason = str(params["reason"]);
  const suffix = reason !== undefined && reason.length > 0 ? ` — ${firstLine(reason, 160)}` : "";
  if (kind === "legacyExec") {
    const cmd = Array.isArray(params["command"]) ? params["command"].join(" ") : "a command";
    return `Codex asks to run: ${firstLine(cmd, 200)}${suffix}`;
  }
  if (kind === "commandExecution") {
    return `Codex asks to run a command (${str(params["kind"]) ?? "command"})${suffix}`;
  }
  if (kind === "legacyPatch") {
    const files = Object.keys(rec(params["fileChanges"]) ?? {});
    return `Codex asks to write ${files.length} file(s): ${files.slice(0, 5).join(", ")}${suffix}`;
  }
  return `Codex asks to apply a file change${suffix}`;
}
