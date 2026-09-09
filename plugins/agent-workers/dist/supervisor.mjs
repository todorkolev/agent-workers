#!/usr/bin/env node

// src/core/store.ts
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
function stateDir() {
  const fromEnv = process.env["AGENT_WORKERS_HOME"];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".agent-workers");
}
function socketDir() {
  const runtime = process.env["XDG_RUNTIME_DIR"];
  const base = runtime && runtime.length > 0 ? path.join(runtime, "agent-workers") : path.join(stateDir(), "sockets");
  return base.length > 80 ? path.join(os.tmpdir(), `agent-workers-${process.getuid?.() ?? 0}`) : base;
}
function workerDir(workerId) {
  return path.join(stateDir(), "workers", workerId);
}
function workerPaths(workerId) {
  const dir = workerDir(workerId);
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  return {
    dir,
    record: path.join(dir, "worker.json"),
    journal: path.join(dir, "journal.ndjson"),
    events: path.join(dir, "events.ndjson"),
    providerLog: path.join(dir, "provider.log"),
    supervisorLog: path.join(dir, "supervisor.log"),
    result: path.join(dir, "result.json"),
    final: path.join(dir, "final.md"),
    diff: path.join(dir, "diff.patch"),
    changedFiles: path.join(dir, "changed-files.txt"),
    socket: path.join(socketDir(), `${hash}.sock`)
  };
}
async function ensureDirs(workerId) {
  await fsp.mkdir(path.join(stateDir(), "workers"), { recursive: true });
  await fsp.mkdir(socketDir(), { recursive: true, mode: 448 });
  if (workerId !== void 0) await fsp.mkdir(workerDir(workerId), { recursive: true });
}
var tmpCounter = 0;
async function writeJsonAtomic(file, value) {
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => void 0);
    throw err;
  }
}
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return void 0;
  }
}
function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return void 0;
  }
}
function appendLine(file, value) {
  let line;
  try {
    line = `${JSON.stringify(value)}
`;
  } catch {
    line = `${JSON.stringify({ unserializable: String(value) })}
`;
  }
  try {
    fs.appendFileSync(file, line, "utf8");
  } catch {
  }
}
function appendText(file, text) {
  try {
    fs.appendFileSync(file, text.endsWith("\n") ? text : `${text}
`, "utf8");
  } catch {
  }
}
async function readRecord(workerId) {
  return readJson(workerPaths(workerId).record);
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function lockPath(writeDir) {
  const hash = createHash("sha256").update(path.resolve(writeDir)).digest("hex").slice(0, 20);
  return path.join(stateDir(), "locks", `${hash}.lock`);
}
async function acquireWriteLock(writeDir, workerId) {
  const file = lockPath(writeDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ workerId, pid: process.pid, dir: path.resolve(writeDir), at: (/* @__PURE__ */ new Date()).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(file, "wx");
      await handle.writeFile(payload, "utf8");
      await handle.close();
      return { lock: { path: file, release: async () => fsp.rm(file, { force: true }).then(() => void 0) } };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const held = await readJson(file);
      if (held !== void 0 && held.workerId !== workerId && pidAlive(held.pid)) {
        return { heldBy: held };
      }
      await fsp.rm(file, { force: true });
    }
  }
  throw new Error(`could not acquire the write lock for ${writeDir}`);
}

// src/core/logger.ts
var ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
function envLevel() {
  const raw = (process.env["AGENT_WORKERS_LOG"] ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}
function format(level, scope, args) {
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return `${(/* @__PURE__ */ new Date()).toISOString()} ${level.toUpperCase()} [${scope}] ${parts.join(" ")}
`;
}
function createLogger(scope) {
  const min = ORDER[envLevel()];
  const emit = (level) => (...args) => {
    if (ORDER[level] < min) return;
    try {
      process.stderr.write(format(level, scope, args));
    } catch {
    }
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

// src/supervisor/supervisor.ts
import * as fsp2 from "node:fs/promises";

// src/core/control.ts
import * as net from "node:net";
import * as readline from "node:readline";
async function serveControl(socketPath, handler) {
  await removeStaleSocket(socketPath);
  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket });
    rl.on("error", () => socket.destroy());
    rl.on("line", (line) => {
      void (async () => {
        let response;
        try {
          const request = JSON.parse(line);
          response = await handler(request);
        } catch (err) {
          response = {
            ok: false,
            code: "bad_request",
            error: err instanceof Error ? err.message : String(err)
          };
        }
        try {
          socket.write(`${JSON.stringify(response)}
`);
        } catch {
        }
        socket.end();
      })();
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve2();
    });
  });
  return server;
}
async function removeStaleSocket(socketPath) {
  const fs2 = await import("node:fs/promises");
  try {
    await fs2.stat(socketPath);
  } catch {
    return;
  }
  const alive = await new Promise((resolve2) => {
    const probe = net.createConnection({ path: socketPath });
    const done = (value) => {
      probe.destroy();
      resolve2(value);
    };
    probe.on("connect", () => done(true));
    probe.on("error", () => done(false));
    setTimeout(() => done(false), 1e3).unref?.();
  });
  if (alive) {
    throw new Error(`another supervisor is already listening on ${socketPath}`);
  }
  await fs2.rm(socketPath, { force: true });
}

// src/core/git.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var exec = promisify(execFile);
async function git(cwd, args, timeoutMs = 3e4) {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}
async function repoRoot(dir) {
  const res = await git(dir, ["rev-parse", "--show-toplevel"]);
  return res.code === 0 ? res.stdout.trim() : void 0;
}
async function summarizeWork(dir, base) {
  const empty = { changedFiles: [], diff: "", diffStat: "" };
  const root = await repoRoot(dir);
  if (root === void 0) return empty;
  const range = base !== void 0 ? [base] : [];
  const nameOnly = await git(dir, ["diff", "--name-only", ...range]);
  const stat = await git(dir, ["diff", "--stat", ...range]);
  const patch = await git(dir, ["diff", ...range]);
  const untracked = await git(dir, ["ls-files", "--others", "--exclude-standard"]);
  const lines = (out) => out.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const changedFiles = [.../* @__PURE__ */ new Set([...lines(nameOnly.stdout), ...lines(untracked.stdout)])].sort();
  const newFiles = lines(untracked.stdout);
  const summary = {
    changedFiles,
    diff: patch.stdout,
    // The patch covers tracked changes only, so say when new files exist that it
    // does not show rather than letting the diff imply they are not there.
    diffStat: stat.stdout.trim() + (newFiles.length > 0 ? `${stat.stdout.trim().length > 0 ? "\n" : ""}${newFiles.length} new untracked file(s): ${newFiles.slice(0, 10).join(", ")}` : "")
  };
  const head = await git(dir, ["log", "-1", "--pretty=%H%x00%s"]);
  const branchRes = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.code === 0 && head.stdout.includes("\0")) {
    const [sha, subject] = head.stdout.trim().split("\0");
    if (sha !== void 0 && sha !== base) {
      summary.commit = {
        sha,
        subject: subject ?? "",
        branch: branchRes.code === 0 ? branchRes.stdout.trim() : ""
      };
    }
  }
  return summary;
}

// src/providers/claude/adapter.ts
import { spawn } from "node:child_process";
import * as readline2 from "node:readline";
import { randomUUID } from "node:crypto";
var log = createLogger("claude-adapter");
function rec(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function summarizeToolInput(name, input) {
  const r = rec(input);
  if (!r) return name;
  const pick = (key) => {
    const v = r[key];
    return typeof v === "string" ? v : void 0;
  };
  const detail = pick("command") ?? pick("file_path") ?? pick("path") ?? pick("pattern") ?? pick("url") ?? pick("description");
  if (detail === void 0) return name;
  const flat = detail.replace(/\s+/g, " ").trim();
  return `${name}: ${flat.length > 160 ? `${flat.slice(0, 157)}\u2026` : flat}`;
}
function summarizeToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const r = rec(part);
      return r ? str(r["text"]) ?? `[${String(r["type"] ?? "block")}]` : String(part);
    }).join(" ");
  }
  return "";
}
function firstLine(text, max = 200) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}
var ClaudeCliAdapter = class {
  provider = "claude";
  child;
  sessionId;
  _actualModel;
  _turnId;
  turnCounter = 0;
  disposed = false;
  rawCbs = [];
  eventCbs = [];
  stderrCbs = [];
  exitCbs = [];
  /** Resolvers for in-flight `control_request`s, keyed by request id. */
  pendingControl = /* @__PURE__ */ new Map();
  controlCounter = 0;
  /** Text of the most recent assistant message; becomes the turn's `final`. */
  lastAssistantText;
  /** Resolves once the first `system/init` for the session arrives. */
  ready;
  get turnId() {
    return this._turnId;
  }
  /** Captured from `system/init`, which is the first place the CLI states it. */
  get actualModel() {
    return this._actualModel;
  }
  /* ── lifecycle ───────────────────────────────────────────────────────── */
  async start(opts) {
    const sessionId = randomUUID();
    await this.launch(opts, ["--session-id", sessionId]);
    this.sessionId = sessionId;
    return { sessionId, ...this._actualModel !== void 0 ? { actualModel: this._actualModel } : {} };
  }
  async resume(sessionId, opts) {
    await this.launch(opts, ["--resume", sessionId]);
    this.sessionId = sessionId;
    return { sessionId, ...this._actualModel !== void 0 ? { actualModel: this._actualModel } : {} };
  }
  /** Build argv and spawn the child. Shared by start/resume. */
  async launch(opts, sessionArgs) {
    if (this.child) throw new Error("ClaudeCliAdapter already launched");
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      ...sessionArgs
    ];
    if (opts.model) args.push("--model", opts.model);
    if (opts.effort) args.push("--effort", opts.effort);
    const mode = opts.permissionMode ?? (opts.writeAccess ? "acceptEdits" : "manual");
    args.push("--permission-mode", mode);
    if (mode !== "bypassPermissions") {
      args.push("--permission-prompts", "none");
    }
    if (!opts.writeAccess) args.push("--disallowedTools", "Write", "Edit", "NotebookEdit");
    if (opts.allowedTools?.length) args.push("--allowedTools", ...opts.allowedTools);
    if (opts.disallowedTools?.length) args.push("--disallowedTools", ...opts.disallowedTools);
    if (opts.instructions) args.push("--append-system-prompt", opts.instructions);
    if (opts.providerArgs?.length) args.push(...opts.providerArgs);
    const argv = [...opts.launcher, opts.bin, ...args];
    const command = argv[0];
    if (command === void 0) throw new Error("empty provider argv");
    log.info(`spawning claude worker ${opts.workerId}: ${argv.slice(0, 6).join(" ")} \u2026`);
    const child = spawn(command, argv.slice(1), {
      ...opts.launcher.length === 0 ? { cwd: opts.cwd } : {},
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env }
    });
    this.child = child;
    let resolveReady;
    let rejectReady;
    const promise = new Promise((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    promise.catch(() => void 0);
    this.ready = { promise, resolve: resolveReady, reject: rejectReady };
    child.on("error", (err) => {
      const message = `claude CLI failed to start: ${err.message}`;
      this.ready?.reject(new Error(message));
      this.emit({ ts: (/* @__PURE__ */ new Date()).toISOString(), type: "error", text: message });
    });
    child.on("exit", (code, signal) => {
      this.ready?.reject(new Error(`claude CLI exited before it was ready (code=${code} signal=${signal})`));
      for (const cb of this.exitCbs) cb({ code, signal });
    });
    readline2.createInterface({ input: child.stdout }).on("line", (line) => this.onStdoutLine(line));
    readline2.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.length === 0) return;
      for (const cb of this.stderrCbs) cb(line);
    });
    await Promise.race([
      promise,
      new Promise((resolve2) => setTimeout(resolve2, 400).unref?.())
    ]).catch((err) => {
      throw err;
    });
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve2) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve2();
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
        }
        done();
      }, 3e3);
      timer.unref?.();
    });
  }
  /* ── turns ───────────────────────────────────────────────────────────── */
  async startTurn(text) {
    this.writeUser(text);
    return { delivery: "started_new_turn" };
  }
  async steer(text) {
    this.writeUser(text);
    return {
      delivery: "queued_for_turn",
      ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
      note: "Claude Code queues the message and delivers it inside the running turn at the next tool boundary. If the worker is inside one long tool call, delivery waits for that call to finish; there is no read receipt."
    };
  }
  async interrupt() {
    const response = await this.controlRequest({ subtype: "interrupt" }, 15e3);
    const r = rec(response);
    const stillQueued = r?.["still_queued"];
    this._turnId = void 0;
    if (Array.isArray(stillQueued) && stillQueued.length > 0) {
      this.emit({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        type: "status",
        text: `interrupt left ${stillQueued.length} queued message(s) undelivered`,
        data: { stillQueued: stillQueued.length }
      });
    }
  }
  /**
   * Claude's non-interactive session has no approval callback we can answer, so
   * the only decision it can act on is an answer to a question — delivered the
   * same way any other guidance is. Denials are reported as events instead.
   */
  async respond(requestId, decision) {
    if (decision.decision === "answer" || decision.decision === "allow") {
      const body = decision.text ?? "Approved. Continue.";
      this.writeUser(body);
      return;
    }
    this.writeUser(decision.text ?? "Do not proceed with that. Stop and explain what you need instead.");
  }
  /* ── subscriptions ───────────────────────────────────────────────────── */
  onRaw(cb) {
    this.rawCbs.push(cb);
  }
  onEvent(cb) {
    this.eventCbs.push(cb);
  }
  onStderr(cb) {
    this.stderrCbs.push(cb);
  }
  onExit(cb) {
    this.exitCbs.push(cb);
  }
  /* ── internals ───────────────────────────────────────────────────────── */
  emit(ev) {
    for (const cb of this.eventCbs) {
      try {
        cb(ev);
      } catch (err) {
        log.error("event callback threw:", err);
      }
    }
  }
  write(value) {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("claude worker stdin is not writable");
    child.stdin.write(`${JSON.stringify(value)}
`);
  }
  writeUser(text) {
    this.write({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null
    });
  }
  controlRequest(request, timeoutMs) {
    this.controlCounter += 1;
    const requestId = `aw-${this.controlCounter}`;
    return new Promise((resolve2, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        reject(new Error(`claude control_request "${String(request["subtype"])}" timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingControl.set(requestId, (response) => {
        clearTimeout(timer);
        resolve2(response);
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
  onStdoutLine(line) {
    if (line.trim().length === 0) return;
    let msg;
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
    const ts = (/* @__PURE__ */ new Date()).toISOString();
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
        const id = r ? str(r["request_id"]) : void 0;
        if (id !== void 0) {
          const resolve2 = this.pendingControl.get(id);
          this.pendingControl.delete(id);
          resolve2?.(r?.["response"]);
        }
        return;
      }
      case "control_request": {
        const id = str(m["request_id"]);
        if (id !== void 0) {
          try {
            this.write({
              type: "control_response",
              response: { subtype: "error", request_id: id, error: "agent-workers does not host this control request" }
            });
          } catch {
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
          data: { auth: "subscription-window", status: info?.["status"] }
        });
        return;
      }
      default:
        return;
    }
  }
  onSystem(m, ts) {
    const subtype = str(m["subtype"]);
    if (subtype === "init") {
      const sid = str(m["session_id"]);
      if (sid !== void 0) this.sessionId = sid;
      const model = str(m["model"]);
      if (model !== void 0) this._actualModel = model;
      this.ready?.resolve();
      this.turnCounter += 1;
      this._turnId = `turn-${this.turnCounter}`;
      this.emit({
        ts,
        type: "status",
        rawType: "system/init",
        text: `turn started (model ${model ?? "unknown"})`,
        turnId: this._turnId,
        data: { sessionId: sid, model }
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
        ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
        data: { tool, toolUseId: str(m["tool_use_id"]) }
      });
      return;
    }
    this.emit({
      ts,
      type: "status",
      rawType: `system/${subtype ?? "?"}`,
      text: `system: ${subtype ?? "event"}`,
      ...this._turnId !== void 0 ? { turnId: this._turnId } : {}
    });
  }
  onAssistant(m, ts) {
    const message = rec(m["message"]);
    const content = message?.["content"];
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = rec(raw);
      if (!block) continue;
      const blockType = str(block["type"]);
      if (blockType === "text") {
        const text = str(block["text"]);
        if (text === void 0 || text.trim().length === 0) continue;
        this.lastAssistantText = text;
        this.emit({
          ts,
          type: "agent_message",
          rawType: "assistant.text",
          text,
          ...this._turnId !== void 0 ? { turnId: this._turnId } : {}
        });
      } else if (blockType === "tool_use") {
        const name = str(block["name"]) ?? "tool";
        this.emit({
          ts,
          type: "tool_started",
          rawType: "assistant.tool_use",
          text: summarizeToolInput(name, block["input"]),
          ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
          data: { tool: name, toolUseId: str(block["id"]) }
        });
        if (name === "Write" || name === "Edit" || name === "NotebookEdit") {
          const input = rec(block["input"]);
          const file = input ? str(input["file_path"]) : void 0;
          if (file !== void 0) {
            this.emit({
              ts,
              type: "file_changed",
              rawType: "assistant.tool_use",
              text: file,
              ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
              data: { path: file, tool: name }
            });
          }
        }
      } else if (blockType === "thinking") {
        this.emit({
          ts,
          type: "status",
          rawType: "assistant.thinking",
          text: "thinking\u2026",
          ...this._turnId !== void 0 ? { turnId: this._turnId } : {}
        });
      }
    }
  }
  onUser(m, ts) {
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
        ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
        data: { isError, toolUseId: str(block["tool_use_id"]) }
      });
    }
  }
  onResult(m, ts) {
    const subtype = str(m["subtype"]) ?? "unknown";
    const isError = m["is_error"] === true;
    const text = str(m["result"]) ?? this.lastAssistantText;
    const sid = str(m["session_id"]);
    if (sid !== void 0) this.sessionId = sid;
    if (!isError && text !== void 0 && text.trim().length > 0) {
      this.emit({
        ts,
        type: "final",
        rawType: "result",
        text,
        ...this._turnId !== void 0 ? { turnId: this._turnId } : {}
      });
    }
    if (isError) {
      this.emit({
        ts,
        type: "error",
        rawType: `result/${subtype}`,
        text: subtype === "error_during_execution" ? "the turn ended early (interrupted or aborted)" : `turn failed: ${subtype}`,
        ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
        data: { subtype }
      });
    }
    this.emit({
      ts,
      type: "turn_completed",
      rawType: "result",
      text: `turn ${subtype}`,
      ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
      data: {
        subtype,
        isError,
        durationMs: m["duration_ms"],
        numTurns: m["num_turns"],
        totalCostUsd: m["total_cost_usd"]
      }
    });
    this._turnId = void 0;
  }
};

// src/providers/codex/adapter.ts
import { spawn as spawn2 } from "node:child_process";
import * as readline3 from "node:readline";
var log2 = createLogger("codex-adapter");
function rec2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function str2(value) {
  return typeof value === "string" ? value : void 0;
}
function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}
function firstLine2(text, max = 220) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
}
var APPROVAL_METHODS = {
  "item/commandExecution/requestApproval": "commandExecution",
  "item/fileChange/requestApproval": "fileChange",
  execCommandApproval: "legacyExec",
  applyPatchApproval: "legacyPatch",
  "item/tool/requestUserInput": "userInput"
};
var CodexAppServerAdapter = class {
  provider = "codex";
  child;
  threadId;
  _turnId;
  _actualModel;
  disposed = false;
  effort;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  parked = /* @__PURE__ */ new Map();
  turnEndWaiters = [];
  exitError;
  /** Text of the most recent completed agentMessage; becomes the turn's final. */
  lastAgentMessage;
  rawCbs = [];
  eventCbs = [];
  stderrCbs = [];
  exitCbs = [];
  get turnId() {
    return this._turnId;
  }
  /** Echoed by `thread/start` / `thread/resume`. */
  get actualModel() {
    return this._actualModel;
  }
  /* ── lifecycle ───────────────────────────────────────────────────────── */
  async start(opts) {
    await this.launch(opts);
    const result = await this.request("thread/start", this.threadParams(opts));
    const r = rec2(result);
    const thread = r ? rec2(r["thread"]) : void 0;
    const threadId = thread ? str2(thread["id"]) : void 0;
    if (threadId === void 0) throw new Error("codex thread/start returned no thread.id");
    this.threadId = threadId;
    this._actualModel = r ? str2(r["model"]) : void 0;
    return { sessionId: threadId, ...this._actualModel !== void 0 ? { actualModel: this._actualModel } : {} };
  }
  async resume(sessionId, opts) {
    await this.launch(opts);
    const result = await this.request("thread/resume", { threadId: sessionId, ...this.threadParams(opts) });
    const r = rec2(result);
    const thread = r ? rec2(r["thread"]) : void 0;
    this.threadId = (thread ? str2(thread["id"]) : void 0) ?? sessionId;
    this._actualModel = r ? str2(r["model"]) : void 0;
    return { sessionId: this.threadId, ...this._actualModel !== void 0 ? { actualModel: this._actualModel } : {} };
  }
  /** Shared `thread/start` / `thread/resume` parameters. */
  threadParams(opts) {
    const sandbox = opts.writeAccess ? "workspace-write" : "read-only";
    const approvalPolicy = opts.permissionMode ?? (opts.writeAccess ? "on-request" : "never");
    return {
      cwd: opts.targetCwd,
      sandbox,
      approvalPolicy,
      ...opts.model !== void 0 ? { model: opts.model } : {},
      ...opts.instructions !== void 0 ? { baseInstructions: opts.instructions } : {}
    };
  }
  async launch(opts) {
    if (this.child) throw new Error("CodexAppServerAdapter already launched");
    this.effort = opts.effort;
    const argv = [...opts.launcher, opts.bin, "app-server", ...opts.providerArgs ?? []];
    const command = argv[0];
    if (command === void 0) throw new Error("empty provider argv");
    log2.info(`spawning codex worker ${opts.workerId}: ${argv.slice(0, 6).join(" ")} \u2026`);
    const child = spawn2(command, argv.slice(1), {
      ...opts.launcher.length === 0 ? { cwd: opts.cwd } : {},
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env }
    });
    this.child = child;
    child.on("error", (err) => this.failAll(new Error(`codex app-server failed to start: ${err.message}`)));
    child.on("exit", (code, signal) => {
      this.failAll(new Error(`codex app-server exited (code=${code} signal=${signal})`));
      for (const cb of this.exitCbs) cb({ code, signal });
    });
    readline3.createInterface({ input: child.stdout }).on("line", (line) => this.onStdoutLine(line));
    readline3.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.length === 0) return;
      for (const cb of this.stderrCbs) cb(line);
    });
    await this.request("initialize", {
      clientInfo: { name: "agent-workers", title: "Agent Workers", version: opts.workerId },
      capabilities: null
    });
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.failAll(new Error("codex app-server disposed"));
      return;
    }
    await new Promise((resolve2) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve2();
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
        }
        done();
      }, 3e3);
      timer.unref?.();
    });
    this.failAll(new Error("codex app-server disposed"));
  }
  /* ── turns ───────────────────────────────────────────────────────────── */
  async startTurn(text) {
    const threadId = this.requireThread();
    const result = await this.request("turn/start", {
      threadId,
      input: textInput(text),
      ...this.effort !== void 0 ? { effort: this.effort } : {}
    });
    const turn = rec2(rec2(result)?.["turn"]);
    const turnId = turn ? str2(turn["id"]) : void 0;
    if (turnId === void 0) throw new Error("codex turn/start returned no turn.id");
    this._turnId = turnId;
    return { delivery: "started_new_turn", turnId };
  }
  async steer(text, turnId) {
    const threadId = this.requireThread();
    const expectedTurnId = turnId ?? this._turnId;
    if (expectedTurnId === void 0) return this.startTurn(text);
    const result = await this.request("turn/steer", {
      threadId,
      input: textInput(text),
      expectedTurnId
    });
    const echoed = str2(rec2(result)?.["turnId"]);
    if (echoed !== void 0) this._turnId = echoed;
    return {
      delivery: "steered_into_turn",
      ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
      note: "Accepted into the active Codex turn. The model reads it at its next reasoning boundary \u2014 a command already running finishes first."
    };
  }
  async interrupt() {
    const threadId = this.threadId;
    const turnId = this._turnId;
    if (threadId === void 0 || turnId === void 0) return;
    const ended = this.waitForTurnEnd();
    try {
      await this.request("turn/interrupt", { threadId, turnId });
    } catch (err) {
      log2.warn("turn/interrupt rejected:", err);
    }
    await ended;
  }
  /** Answer a parked approval / user-input request with the manager's decision. */
  async respond(requestId, decision) {
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
            decision: allow ? "approved" : { denied: { rejection: decision.text ?? "denied by the manager" } }
          }
        });
        return;
      case "userInput": {
        const answers = {};
        for (const qid of parked.questionIds ?? []) {
          answers[qid] = { type: "text", text: decision.text ?? "" };
        }
        this.write({ id: parked.id, result: { answers } });
        return;
      }
    }
  }
  /* ── subscriptions ───────────────────────────────────────────────────── */
  onRaw(cb) {
    this.rawCbs.push(cb);
  }
  onEvent(cb) {
    this.eventCbs.push(cb);
  }
  onStderr(cb) {
    this.stderrCbs.push(cb);
  }
  onExit(cb) {
    this.exitCbs.push(cb);
  }
  /* ── internals ───────────────────────────────────────────────────────── */
  emit(ev) {
    for (const cb of this.eventCbs) {
      try {
        cb(ev);
      } catch (err) {
        log2.error("event callback threw:", err);
      }
    }
  }
  requireThread() {
    const threadId = this.threadId;
    if (threadId === void 0) throw new Error("no codex thread; start() was not called");
    return threadId;
  }
  request(method, params) {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  write(message) {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("codex app-server stdin is not writable");
    child.stdin.write(`${JSON.stringify(message)}
`);
  }
  onStdoutLine(line) {
    if (line.trim().length === 0) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log2.debug("non-JSON line from codex:", line.slice(0, 200));
      return;
    }
    for (const cb of this.rawCbs) {
      try {
        cb(msg);
      } catch (err) {
        log2.error("raw callback threw:", err);
      }
    }
    const m = rec2(msg);
    if (!m) return;
    const hasId = "id" in m && m["id"] !== null && m["id"] !== void 0;
    const hasMethod = typeof m["method"] === "string";
    if (hasId && hasMethod) {
      this.onServerRequest(m);
      return;
    }
    if (hasId && ("result" in m || "error" in m)) {
      this.settle(m);
      return;
    }
    if (hasMethod) this.onNotification(m["method"], m["params"]);
  }
  settle(m) {
    const id = m["id"];
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = rec2(m["error"]);
    if (error) {
      const message = str2(error["message"]) ?? "unknown error";
      const code = error["code"];
      pending.reject(
        new Error(`codex ${pending.method} failed: ${message}${code !== void 0 ? ` (code ${String(code)})` : ""}`)
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
  onServerRequest(m) {
    const id = m["id"];
    const method = m["method"];
    const params = rec2(m["params"]) ?? {};
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const kind = APPROVAL_METHODS[method];
    if (kind === void 0) {
      this.write({ id, error: { code: -32601, message: `agent-workers cannot answer ${method}` } });
      this.emit({
        ts,
        type: "status",
        rawType: method,
        text: `declined an unsupported Codex request (${method})`
      });
      return;
    }
    const requestId = `codex-${String(id)}`;
    if (kind === "userInput") {
      const questions = Array.isArray(params["questions"]) ? params["questions"] : [];
      const ids = [];
      const prompts = [];
      for (const raw of questions) {
        const q = rec2(raw);
        if (!q) continue;
        const qid = str2(q["id"]);
        if (qid !== void 0) ids.push(qid);
        prompts.push(`${str2(q["header"]) ?? ""} ${str2(q["question"]) ?? ""}`.trim());
      }
      this.parked.set(requestId, { id, kind, questionIds: ids });
      this.emit({
        ts,
        type: "question",
        rawType: method,
        text: prompts.join("\n") || "the worker asked a question",
        requestId,
        ...this._turnId !== void 0 ? { turnId: this._turnId } : {}
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
      ...this._turnId !== void 0 ? { turnId: this._turnId } : {},
      data: { method, cwd: str2(params["cwd"]), reason: str2(params["reason"]) }
    });
  }
  onNotification(method, rawParams) {
    const p = rec2(rawParams) ?? {};
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const turnId = this._turnId;
    const withTurn = turnId !== void 0 ? { turnId } : {};
    switch (method) {
      case "turn/started": {
        const id = str2(rec2(p["turn"])?.["id"]);
        if (id !== void 0) this._turnId = id;
        this.emit({ ts, type: "status", rawType: method, text: "turn started", ...id ? { turnId: id } : {} });
        return;
      }
      case "turn/completed": {
        const status = str2(rec2(p["turn"])?.["status"]) ?? "completed";
        if (this.lastAgentMessage !== void 0 && status !== "interrupted") {
          this.emit({ ts, type: "final", rawType: method, text: this.lastAgentMessage, ...withTurn });
        }
        this.lastAgentMessage = void 0;
        this.emit({ ts, type: "turn_completed", rawType: method, text: `turn ${status}`, ...withTurn, data: { status } });
        this._turnId = void 0;
        this.resolveTurnEnd();
        return;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(p["plan"]) ? p["plan"] : [];
        this.emit({
          ts,
          type: "plan",
          rawType: method,
          text: str2(p["explanation"]) ?? `plan updated (${plan.length} step(s))`,
          ...withTurn,
          data: { steps: plan.length }
        });
        return;
      }
      case "turn/diff/updated": {
        const diff = str2(p["diff"]) ?? "";
        this.emit({
          ts,
          type: "diff",
          rawType: method,
          text: `diff updated (${diff.split("\n").length} lines)`,
          ...withTurn,
          data: { diff }
        });
        return;
      }
      case "item/started":
      case "item/completed": {
        this.onItem(method, rec2(p["item"]), ts, withTurn);
        return;
      }
      case "error": {
        const err = rec2(p["error"]);
        const willRetry = p["willRetry"] === true;
        this.emit({
          ts,
          type: "error",
          rawType: method,
          text: `${str2(err?.["message"]) ?? "codex error"}${willRetry ? " (retrying)" : ""}`,
          ...withTurn,
          data: { willRetry }
        });
        if (!willRetry) {
          this._turnId = void 0;
          this.resolveTurnEnd();
        }
        return;
      }
      default:
        return;
    }
  }
  onItem(method, item, ts, withTurn) {
    if (!item) return;
    const type = str2(item["type"]);
    const completed = method === "item/completed";
    if (type === "agentMessage") {
      if (!completed) return;
      const text = str2(item["text"]);
      if (text === void 0 || text.trim().length === 0) return;
      this.lastAgentMessage = text;
      this.emit({ ts, type: "agent_message", rawType: method, text, ...withTurn });
      return;
    }
    if (type === "commandExecution") {
      const command = str2(item["command"]) ?? "command";
      if (!completed) {
        this.emit({ ts, type: "tool_started", rawType: method, text: firstLine2(command), ...withTurn });
        return;
      }
      const exitCode = item["exitCode"];
      const durationMs = item["durationMs"];
      this.emit({
        ts,
        type: "tool_completed",
        rawType: method,
        text: `${firstLine2(command, 120)} \u2192 exit ${String(exitCode ?? "?")}`,
        ...withTurn,
        data: { exitCode, durationMs }
      });
      return;
    }
    if (type === "fileChange" && completed) {
      const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
      const paths = changes.map((c) => str2(rec2(c)?.["path"]) ?? "").filter((s) => s.length > 0);
      this.emit({
        ts,
        type: "file_changed",
        rawType: method,
        text: paths.join(", ") || `${changes.length} file(s) changed`,
        ...withTurn,
        data: { paths, status: str2(item["status"]) }
      });
      return;
    }
    if (type === "reasoning" && completed) {
      this.emit({ ts, type: "status", rawType: method, text: "reasoning", ...withTurn });
    }
  }
  waitForTurnEnd() {
    if (this._turnId === void 0) return Promise.resolve();
    return new Promise((resolve2) => this.turnEndWaiters.push(resolve2));
  }
  resolveTurnEnd() {
    const waiters = this.turnEndWaiters;
    this.turnEndWaiters = [];
    for (const resolve2 of waiters) resolve2();
  }
  failAll(error) {
    if (!this.exitError) this.exitError = error;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pending) p.reject(error);
    this.resolveTurnEnd();
  }
};
function describeApproval(kind, params) {
  const reason = str2(params["reason"]);
  const suffix = reason !== void 0 && reason.length > 0 ? ` \u2014 ${firstLine2(reason, 160)}` : "";
  if (kind === "legacyExec") {
    const cmd = Array.isArray(params["command"]) ? params["command"].join(" ") : "a command";
    return `Codex asks to run: ${firstLine2(cmd, 200)}${suffix}`;
  }
  if (kind === "commandExecution") {
    return `Codex asks to run a command (${str2(params["kind"]) ?? "command"})${suffix}`;
  }
  if (kind === "legacyPatch") {
    const files = Object.keys(rec2(params["fileChanges"]) ?? {});
    return `Codex asks to write ${files.length} file(s): ${files.slice(0, 5).join(", ")}${suffix}`;
  }
  return `Codex asks to apply a file change${suffix}`;
}

// src/supervisor/supervisor.ts
var log3 = createLogger("supervisor");
var Supervisor = class {
  spec;
  adapter;
  record;
  server;
  seq = 0;
  interruptRequested = false;
  stopping = false;
  queued = [];
  approvalTimers = /* @__PURE__ */ new Map();
  /** Most recent `final` text, kept for `worker_result`. */
  lastFinal;
  /** Union of every file the worker touched, for `worker_result`. */
  touchedFiles = /* @__PURE__ */ new Set();
  latestDiff;
  /** Tail of the serialized record-write chain (see {@link persist}). */
  writeChain = Promise.resolve();
  /** Held for the lifetime of a write worker; see {@link acquireWriteLock}. */
  writeLock;
  constructor(spec) {
    this.spec = spec;
    this.adapter = spec.provider === "claude" ? new ClaudeCliAdapter() : new CodexAppServerAdapter();
    const paths = workerPaths(spec.workerId);
    this.record = {
      workerId: spec.workerId,
      provider: spec.provider,
      state: "starting",
      task: spec.task,
      ...spec.model !== void 0 ? { requestedModel: spec.model } : {},
      ...spec.effort !== void 0 ? { effort: spec.effort } : {},
      cwd: spec.cwd,
      ...spec.worktree !== void 0 ? { worktree: spec.worktree } : {},
      writeAccess: spec.writeAccess,
      transcriptMode: spec.transcriptMode,
      execProfile: spec.execProfile,
      supervisorPid: process.pid,
      lastSeq: 0,
      pending: [],
      owner: spec.owner,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      paths,
      version: spec.version
    };
  }
  /* ── boot ────────────────────────────────────────────────────────────── */
  async run() {
    await ensureDirs(this.spec.workerId);
    const prior = await readRecord(this.spec.workerId);
    if (prior !== void 0) {
      this.seq = prior.lastSeq;
      this.record.lastSeq = prior.lastSeq;
      this.record.createdAt = prior.createdAt;
      if (this.record.actualModel === void 0 && prior.actualModel !== void 0) {
        this.record.actualModel = prior.actualModel;
      }
    }
    if (this.spec.writeAccess) {
      const dir = this.spec.worktree?.path ?? this.spec.cwd;
      const claim = await acquireWriteLock(dir, this.spec.workerId);
      if ("heldBy" in claim) {
        await this.fail(
          new Error(`worker "${claim.heldBy.workerId}" (pid ${claim.heldBy.pid}) is already writing in ${dir}`),
          "Give this worker its own worktree, or stop the one that holds the directory."
        );
        return;
      }
      this.writeLock = claim.lock;
    }
    await this.persist();
    this.server = await serveControl(this.record.paths.socket, (req) => this.handleControl(req));
    this.wireAdapter();
    try {
      const info = this.spec.resumeSessionId !== void 0 ? await this.adapter.resume(this.spec.resumeSessionId, this.sessionOptions()) : await this.adapter.start(this.sessionOptions());
      this.record.sessionId = info.sessionId;
      if (info.actualModel !== void 0) this.record.actualModel = info.actualModel;
    } catch (err) {
      await this.fail(err, "Check that the provider CLI is installed and logged in in the target environment.");
      return;
    }
    if (this.spec.task.trim().length > 0) {
      try {
        const delivery = await this.adapter.startTurn(this.spec.task);
        this.record.turnId = delivery.turnId;
        await this.setState("running");
      } catch (err) {
        await this.fail(err);
        return;
      }
    } else {
      await this.setState("idle");
    }
    process.on("SIGTERM", () => void this.shutdown("stopped"));
    process.on("SIGINT", () => void this.shutdown("stopped"));
  }
  sessionOptions() {
    return {
      workerId: this.spec.workerId,
      cwd: this.spec.cwd,
      targetCwd: this.spec.targetCwd,
      ...this.spec.model !== void 0 ? { model: this.spec.model } : {},
      ...this.spec.effort !== void 0 ? { effort: this.spec.effort } : {},
      writeAccess: this.spec.writeAccess,
      ...this.spec.permissionMode !== void 0 ? { permissionMode: this.spec.permissionMode } : {},
      ...this.spec.instructions !== void 0 ? { instructions: this.spec.instructions } : {},
      launcher: this.spec.launcher,
      env: this.spec.env,
      bin: this.spec.bin,
      ...this.spec.allowedTools !== void 0 ? { allowedTools: this.spec.allowedTools } : {},
      ...this.spec.disallowedTools !== void 0 ? { disallowedTools: this.spec.disallowedTools } : {},
      ...this.spec.providerArgs !== void 0 ? { providerArgs: this.spec.providerArgs } : {}
    };
  }
  /* ── event plumbing ──────────────────────────────────────────────────── */
  wireAdapter() {
    this.adapter.onRaw((msg) => appendLine(this.record.paths.events, { ts: Date.now(), msg }));
    this.adapter.onStderr((line) => appendText(this.record.paths.providerLog, line));
    this.adapter.onEvent((ev) => void this.onEvent(ev));
    this.adapter.onExit((info) => void this.onProviderExit(info));
  }
  async onEvent(ev) {
    this.seq += 1;
    const event = { seq: this.seq, ...ev };
    appendLine(this.record.paths.journal, event);
    this.record.lastSeq = this.seq;
    this.record.turnId = this.adapter.turnId;
    const model = this.adapter.actualModel;
    if (model !== void 0) this.record.actualModel = model;
    switch (event.type) {
      case "final":
        if (event.text !== void 0) this.lastFinal = event.text;
        break;
      case "file_changed": {
        const paths = event.data?.["paths"];
        if (Array.isArray(paths)) {
          for (const p of paths) {
            if (typeof p === "string" && p.length > 0) this.touchedFiles.add(p);
          }
        }
        const single = event.data?.["path"];
        if (typeof single === "string" && single.length > 0) this.touchedFiles.add(single);
        break;
      }
      case "diff": {
        const diff = event.data?.["diff"];
        if (typeof diff === "string") this.latestDiff = diff;
        break;
      }
      case "error":
        if (event.text !== void 0) this.record.lastError = { message: event.text, ts: event.ts };
        break;
      case "permission_request":
      case "question":
        if (event.requestId !== void 0) {
          this.record.pending.push({
            requestId: event.requestId,
            kind: event.type === "question" ? "question" : "permission",
            text: event.text ?? "",
            ts: event.ts
          });
          this.armApprovalTimer(event.requestId);
          await this.setState("blocked");
          return;
        }
        break;
      case "turn_completed":
        this.record.turnId = void 0;
        await this.setState(this.interruptRequested ? "interrupted" : "idle");
        await this.snapshotResult();
        await this.drainQueue();
        return;
      default:
        break;
    }
    await this.persist();
  }
  async onProviderExit(info) {
    if (this.stopping) return;
    await this.fail(
      new Error(`the ${this.spec.provider} process exited unexpectedly (code=${info.code} signal=${info.signal})`),
      "Inspect provider.log in the worker directory, then use worker_resume to continue from the saved session."
    );
  }
  /** Deliver anything the manager sent while the worker was blocked. */
  async drainQueue() {
    const next = this.queued.shift();
    if (next === void 0) return;
    try {
      const result = await this.adapter.startTurn(next.text);
      this.record.turnId = result.turnId;
      this.record.lastError = void 0;
      this.interruptRequested = false;
      await this.setState("running");
    } catch (err) {
      await this.fail(err);
    }
  }
  /* ── control ops ─────────────────────────────────────────────────────── */
  async handleControl(request) {
    if (request.op === "status") return { ok: true, op: "status", record: this.record };
    if (request.op === "collect") {
      await this.snapshotResult();
      return { ok: true, op: "collect", result: await this.buildResult(), record: this.record };
    }
    const ownershipError = this.checkOwner(request);
    if (ownershipError) return ownershipError;
    if (request.owner !== void 0) this.record.owner = request.owner;
    switch (request.op) {
      case "send":
        return this.opSend(request.text);
      case "interrupt":
        return this.opInterrupt();
      case "stop":
        return this.opStop();
      case "resume":
        return this.opResume(request.task);
      case "respond":
        return this.opRespond(request.requestId, request.decision);
    }
  }
  /**
   * One worker has one controlling manager. A second manager can read freely
   * but must say `takeover: true` before it may steer — silent co-driving is
   * how two agents end up fighting over the same worktree.
   */
  checkOwner(request) {
    const incoming = request.owner;
    if (incoming === void 0) return void 0;
    const current = this.record.owner;
    if (current.clientId === incoming.clientId || request.takeover === true) return void 0;
    return {
      ok: false,
      code: "not_owner",
      error: `worker "${this.record.workerId}" is controlled by ${current.host} (client ${current.clientId}, since ${current.since})`,
      recovery: "Read it freely, or repeat the call with takeover: true to take control."
    };
  }
  async opSend(text) {
    if (this.isTerminal()) {
      return { ok: false, code: "terminal", error: `worker is ${this.record.state}; nothing was delivered` };
    }
    if (this.record.state === "blocked") {
      this.queued.push({ text, at: (/* @__PURE__ */ new Date()).toISOString() });
      return {
        ok: true,
        op: "send",
        delivery: "queued_after_block",
        record: this.record,
        note: "The worker is waiting on a decision. Answer it with worker_respond; this text follows."
      };
    }
    try {
      const running = this.record.state === "running";
      const result = running ? await this.adapter.steer(text, this.record.turnId) : await this.adapter.startTurn(text);
      this.record.turnId = result.turnId ?? this.record.turnId;
      if (!running) this.record.lastError = void 0;
      this.interruptRequested = false;
      await this.setState("running");
      const response = {
        ok: true,
        op: "send",
        delivery: result.delivery,
        record: this.record
      };
      if (result.turnId !== void 0) response.turnId = result.turnId;
      if (result.note !== void 0) response.note = result.note;
      return response;
    } catch (err) {
      return { ok: false, code: "provider_error", error: err instanceof Error ? err.message : String(err) };
    }
  }
  async opInterrupt() {
    if (this.isTerminal()) {
      return { ok: false, code: "terminal", error: `worker is ${this.record.state}` };
    }
    this.interruptRequested = true;
    try {
      await this.adapter.interrupt();
    } catch (err) {
      return { ok: false, code: "provider_error", error: err instanceof Error ? err.message : String(err) };
    }
    this.record.turnId = void 0;
    await this.setState("interrupted");
    return { ok: true, op: "interrupt", record: this.record };
  }
  async opStop() {
    await this.shutdown("stopped");
    return { ok: true, op: "stop", record: this.record };
  }
  /**
   * `resume` on a live supervisor just un-sticks an interrupted worker. Restart
   * after the supervisor died is the bridge's job: it spawns a fresh supervisor
   * with `resumeSessionId` set.
   */
  async opResume(task) {
    if (this.isTerminal()) {
      return {
        ok: false,
        code: "terminal",
        error: `worker is ${this.record.state}; a stopped session must be resumed by starting a new supervisor`,
        recovery: "Call worker_resume, which will spawn a supervisor on the saved provider session."
      };
    }
    if (task !== void 0 && task.trim().length > 0) {
      const sent = await this.opSend(task);
      if (!sent.ok) return sent;
      return { ok: true, op: "resume", record: this.record };
    }
    this.interruptRequested = false;
    if (this.record.state === "interrupted") await this.setState("idle");
    return { ok: true, op: "resume", record: this.record };
  }
  async opRespond(requestId, decision) {
    const index = this.record.pending.findIndex((p) => p.requestId === requestId);
    if (index < 0) {
      return { ok: false, code: "bad_request", error: `no pending request "${requestId}" on this worker` };
    }
    const [entry] = this.record.pending.splice(index, 1);
    this.clearApprovalTimer(requestId);
    try {
      await this.adapter.respond(requestId, decision);
    } catch (err) {
      return { ok: false, code: "provider_error", error: err instanceof Error ? err.message : String(err) };
    }
    await this.onEvent({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      type: "status",
      text: `manager ${decision.decision === "deny" ? "denied" : "answered"}: ${entry?.text ?? requestId}`,
      data: { requestId, decision: decision.decision }
    });
    if (this.record.pending.length === 0) await this.setState("running");
    return { ok: true, op: "respond", record: this.record };
  }
  /* ── approval timeouts ───────────────────────────────────────────────── */
  armApprovalTimer(requestId) {
    const ms = this.spec.approvalTimeoutMs;
    if (ms <= 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        this.approvalTimers.delete(requestId);
        const index = this.record.pending.findIndex((p) => p.requestId === requestId);
        if (index < 0) return;
        this.record.pending.splice(index, 1);
        try {
          await this.adapter.respond(requestId, { decision: "deny", text: "no answer from the manager in time" });
        } catch {
        }
        await this.onEvent({
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          type: "permission_denied",
          text: `denied automatically: no manager answered within ${Math.round(ms / 1e3)}s`,
          data: { requestId, auto: true }
        });
        if (this.record.pending.length === 0) await this.setState("running");
      })();
    }, ms);
    timer.unref?.();
    this.approvalTimers.set(requestId, timer);
  }
  clearApprovalTimer(requestId) {
    const timer = this.approvalTimers.get(requestId);
    if (timer !== void 0) clearTimeout(timer);
    this.approvalTimers.delete(requestId);
  }
  /* ── state + persistence ─────────────────────────────────────────────── */
  isTerminal() {
    return this.record.state === "completed" || this.record.state === "failed" || this.record.state === "stopped";
  }
  async setState(state) {
    if (this.isTerminal()) return;
    this.record.state = state;
    await this.persist();
  }
  /**
   * Serialize record writes.
   *
   * Events arrive faster than a write completes, and two overlapping writes to
   * one file are how a "single writer" quietly stops being one. Chaining them
   * keeps the on-disk record both atomic and in order.
   */
  async persist() {
    this.record.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const snapshot = structuredClone(this.record);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await writeJsonAtomic(snapshot.paths.record, snapshot);
      } catch (err) {
        log3.error("failed to persist worker record:", err);
      }
    });
    return this.writeChain;
  }
  async fail(err, recovery) {
    const message = err instanceof Error ? err.message : String(err);
    log3.error(`worker ${this.spec.workerId} failed:`, message);
    await this.onEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), type: "error", text: message });
    this.record.error = { message, ...recovery !== void 0 ? { recovery } : {} };
    this.record.state = "failed";
    await this.persist();
    await this.teardown();
  }
  async shutdown(state) {
    if (this.stopping) return;
    this.stopping = true;
    this.record.state = state;
    await this.snapshotResult();
    await this.persist();
    await this.teardown();
  }
  async teardown() {
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    try {
      await this.writeLock?.release();
    } catch {
    }
    try {
      await this.adapter.dispose();
    } catch {
    }
    try {
      this.server?.close();
    } catch {
    }
    try {
      await fsp2.rm(this.record.paths.socket, { force: true });
    } catch {
    }
    setTimeout(() => process.exit(0), 150).unref?.();
  }
  /* ── results ─────────────────────────────────────────────────────────── */
  /** Refresh the on-disk artifacts a manager collects with `worker_result`. */
  async snapshotResult() {
    const result = await this.buildResult();
    try {
      await writeJsonAtomic(this.record.paths.result, result);
      if (result.final !== void 0) await fsp2.writeFile(this.record.paths.final, result.final, "utf8");
      if (result.changedFiles.length > 0) {
        await fsp2.writeFile(this.record.paths.changedFiles, `${result.changedFiles.join("\n")}
`, "utf8");
      }
    } catch (err) {
      log3.warn("failed to write result artifacts:", err);
    }
  }
  async buildResult() {
    const dir = this.record.worktree?.path ?? this.record.cwd;
    let changedFiles = [...this.touchedFiles];
    let diffStat;
    let commit;
    if (this.record.writeAccess) {
      try {
        const summary = await summarizeWork(dir, this.record.worktree?.base);
        if (summary.changedFiles.length > 0) changedFiles = summary.changedFiles;
        if (summary.diffStat.length > 0) diffStat = summary.diffStat;
        if (summary.commit !== void 0) commit = summary.commit;
        if (summary.diff.length > 0) {
          this.latestDiff = summary.diff;
          await fsp2.writeFile(this.record.paths.diff, summary.diff, "utf8");
        }
      } catch (err) {
        log3.warn("failed to summarize git work:", err);
      }
    }
    if (this.latestDiff !== void 0 && diffStat === void 0) {
      diffStat = `${this.latestDiff.split("\n").length} diff lines`;
    }
    return {
      workerId: this.record.workerId,
      provider: this.record.provider,
      state: this.record.state,
      ...this.lastFinal !== void 0 ? { final: this.lastFinal } : {},
      ...this.record.actualModel !== void 0 ? { actualModel: this.record.actualModel } : {},
      changedFiles,
      ...commit !== void 0 ? { commit } : {},
      ...diffStat !== void 0 ? { diffStat } : {},
      artifacts: {
        dir: this.record.paths.dir,
        journal: this.record.paths.journal,
        rawEvents: this.record.paths.events,
        providerLog: this.record.paths.providerLog,
        ...this.lastFinal !== void 0 ? { final: this.record.paths.final } : {},
        ...this.latestDiff !== void 0 ? { diff: this.record.paths.diff } : {}
      }
    };
  }
};

// src/supervisor/main.ts
var log4 = createLogger("supervisor-main");
function specPathFromArgv(argv) {
  const index = argv.indexOf("--spec");
  return index >= 0 ? argv[index + 1] : void 0;
}
async function main() {
  const specPath = specPathFromArgv(process.argv.slice(2));
  if (specPath === void 0) {
    log4.error("usage: supervisor --spec <spec.json>");
    process.exit(2);
  }
  const spec = readJsonSync(specPath);
  if (spec === void 0) {
    log4.error(`cannot read supervisor spec at ${specPath}`);
    process.exit(2);
  }
  process.title = `agent-worker:${spec.workerId}`;
  log4.info(`starting ${spec.provider} worker ${spec.workerId} (pid ${process.pid})`);
  await new Supervisor(spec).run();
}
main().catch((err) => {
  log4.error("supervisor crashed:", err);
  process.exit(1);
});
