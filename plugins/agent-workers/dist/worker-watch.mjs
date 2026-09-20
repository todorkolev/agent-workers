#!/usr/bin/env node

// src/bridge/watch.ts
import { parseArgs } from "node:util";

// src/bridge/registry.ts
import { setTimeout as sleep } from "node:timers/promises";

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

// src/core/store.ts
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";
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
var WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function workerDir(workerId) {
  if (!WORKER_ID_PATTERN.test(workerId)) throw new Error("invalid worker id: expected 1-64 letters, digits, underscores or hyphens, starting with a letter or digit");
  const root = path.resolve(stateDir(), "workers");
  const dir = path.resolve(root, workerId);
  if (path.dirname(dir) !== root) throw new Error("worker directory must be directly inside the state workers directory");
  return dir;
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
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return void 0;
  }
}
async function readSince(file, sinceSeq, maxEntries, strict = false) {
  const entries = [];
  let more = false;
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch (error) {
    if (strict) throw error;
    return { entries, more };
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed.seq !== "number" || parsed.seq <= sinceSeq) continue;
      if (entries.length >= maxEntries) {
        more = true;
        break;
      }
      entries.push(parsed);
    }
  } catch (error) {
    if (strict) throw error;
  } finally {
    rl.close();
    stream.destroy();
  }
  return { entries, more };
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
function supervisorAlive(pid, workerId) {
  if (!pidAlive(pid)) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    if (cmdline.length === 0) return true;
    return cmdline.includes(`agent-worker:${workerId}`) || cmdline.includes(workerId);
  } catch {
    return true;
  }
}

// src/core/types.ts
var LIVE_STATES = [
  "starting",
  "running",
  "idle",
  "blocked",
  "interrupted"
];
function isLiveState(state) {
  return LIVE_STATES.includes(state);
}
var HIGH_SIGNAL_EVENTS = [
  "agent_message",
  "final",
  "permission_request",
  "permission_denied",
  "question",
  "error"
];

// src/bridge/registry.ts
var log = createLogger("registry");
async function resolveWorker(workerId) {
  const record = await readRecord(workerId);
  if (record === void 0) return void 0;
  const alive = supervisorAlive(record.supervisorPid, record.workerId);
  if (!alive && isLiveState(record.state)) {
    return { record: { ...record, state: "orphaned" }, alive: false };
  }
  return { record, alive };
}
async function waitForWorker(workerId, opts) {
  const deadline = Date.now() + opts.timeoutMs;
  const states = new Set(opts.states ?? []);
  let scanCursor = opts.sinceSeq;
  let lastEvent;
  let previousRecordSeq = 0;
  for (; ; ) {
    opts.signal?.throwIfAborted();
    const worker = await resolveWorker(workerId);
    if (worker === void 0) return { worker: void 0, reason: "gone" };
    if (opts.expectedSupervisorPid !== void 0 && worker.record.supervisorPid !== opts.expectedSupervisorPid || opts.expectedTurnId !== void 0 && worker.record.turnId !== void 0 && worker.record.turnId !== opts.expectedTurnId || worker.record.lastSeq < previousRecordSeq) {
      return { worker, reason: "changed", lastEvent };
    }
    previousRecordSeq = worker.record.lastSeq;
    let more = false;
    if (scanCursor !== void 0 && worker.record.lastSeq > scanCursor) {
      if (!opts.messagesOnly && !opts.attentionOnly) return { worker, reason: "event" };
      const page = await readSince(worker.record.paths.journal, scanCursor, 500, opts.attentionOnly);
      let matchedRegex;
      const event = page.entries.find((e) => {
        const index = opts.wakeRegex?.findIndex((regex) => {
          regex.lastIndex = 0;
          return regex.test(e.text ?? "");
        }) ?? -1;
        if (index >= 0) {
          matchedRegex = index;
          return true;
        }
        return opts.attentionOnly ? needsAttention(e) : HIGH_SIGNAL_EVENTS.includes(e.type);
      });
      lastEvent = page.entries.at(-1) ?? lastEvent;
      if (event) return { worker, reason: "event", event, lastEvent, matchedRegex };
      scanCursor = lastEvent?.seq ?? scanCursor;
      more = page.more;
    }
    if (states.size > 0 && states.has(worker.record.state) || opts.attentionOnly && worker.record.pending.length > 0) {
      return { worker, reason: "state", lastEvent };
    }
    if (!worker.alive && !isLiveState(worker.record.state)) return { worker, reason: "state", lastEvent };
    if (Date.now() >= deadline) return { worker, reason: "timeout", lastEvent };
    if (more) continue;
    await sleep(Math.min(opts.pollMs ?? 250, Math.max(1, deadline - Date.now())), void 0, { signal: opts.signal });
  }
}
function needsAttention(event) {
  return ["final", "question", "permission_request", "permission_denied", "error", "turn_completed"].includes(event.type);
}
function compileWakeRegex(patterns = [], flags = "m") {
  return patterns.map((pattern, index) => {
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`Invalid wake regex #${index}: ${String(error)}`);
    }
  });
}

// src/bridge/watch.ts
var controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
var summarize = (event) => event && {
  seq: event.seq,
  type: event.type,
  text: event.text?.slice(0, 800),
  requestId: event.requestId,
  turnId: event.turnId
};
try {
  const { values } = parseArgs({ options: {
    worker: { type: "string" },
    cursor: { type: "string" },
    deadline: { type: "string" },
    "turn-id": { type: "string" },
    help: { type: "boolean" },
    version: { type: "boolean" },
    "wake-regex": { type: "string", multiple: true },
    "wake-flags": { type: "string" }
  } });
  if (values.help) {
    console.log("Usage: node worker-watch.mjs --worker ID --cursor N --deadline ISO8601 [--turn-id ID]\n  [--wake-regex SOURCE ...] [--wake-flags FLAGS]\nExpressions are JavaScript regex sources (no / delimiters), ORed against each normalized\nevent's text. Flags default to m. Lifecycle/decision/error signals always remain enabled.\nRun beside the supervisor, with the same AGENT_WORKERS_HOME. Waits silently for attention,\nworker/turn change or the absolute deadline. Outputs one JSON object; never acknowledges\ntranscripts or controls workers. Exit 0: observation (not task success); 1: inspection error; 130: cancelled.");
  } else if (values.version) {
    console.log("0.2.0");
  } else {
    const workerId = values.worker ?? "";
    const cursor = Number(values.cursor);
    const deadline = Date.parse(values.deadline ?? "");
    if (!WORKER_ID_PATTERN.test(workerId) || !/^\d+$/.test(values.cursor ?? "") || !Number.isSafeInteger(cursor) || !Number.isFinite(deadline) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(values.deadline ?? "")) {
      throw new Error("Required: --worker valid-id --cursor nonnegative-integer --deadline ISO8601-with-timezone. See --help.");
    }
    const wakeRegex = compileWakeRegex(values["wake-regex"], values["wake-flags"]);
    const initial = await resolveWorker(workerId);
    const outcome = await waitForWorker(workerId, {
      timeoutMs: Math.max(0, deadline - Date.now()),
      sinceSeq: cursor,
      attentionOnly: true,
      expectedSupervisorPid: initial?.record.supervisorPid,
      expectedTurnId: values["turn-id"] ?? initial?.record.turnId,
      states: ["idle", "blocked", "interrupted", "completed", "failed", "stopped", "orphaned"],
      signal: controller.signal,
      pollMs: 1e3,
      wakeRegex
    });
    const record = outcome.worker?.record;
    console.log(JSON.stringify({
      workerId,
      reason: outcome.reason === "timeout" ? "deadline" : outcome.reason,
      state: record?.state,
      supervisorPid: record?.supervisorPid,
      turnId: record?.turnId,
      readFromCursor: cursor,
      observedSeq: record?.lastSeq,
      deadline: new Date(deadline).toISOString(),
      event: summarize(outcome.event),
      lastActivity: summarize(outcome.lastEvent),
      matchedRegex: outcome.matchedRegex,
      pendingDecisions: record?.pending.length,
      journal: record?.paths.journal
    }));
  }
} catch (error) {
  console.log(JSON.stringify({ reason: controller.signal.aborted ? "cancelled" : "error", message: String(error).slice(0, 800) }));
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
