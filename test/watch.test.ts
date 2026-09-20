import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { compileWakeRegex, waitForWorker } from "../src/bridge/registry.ts";
import { appendLine, ensureDirs, readSince, workerPaths, writeJsonAtomic } from "../src/core/store.ts";
import type { WorkerEvent, WorkerRecord } from "../src/core/types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-watch-"));
const previousHome = process.env.AGENT_WORKERS_HOME;
process.env.AGENT_WORKERS_HOME = tmp;
const children: ChildProcess[] = [];
const bundle = path.resolve("plugins/agent-workers/dist/worker-watch.mjs");
const run = promisify(execFile);
after(() => {
  for (const child of children) child.kill();
  if (previousHome === undefined) delete process.env.AGENT_WORKERS_HOME;
  else process.env.AGENT_WORKERS_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function fixture(id: string) {
  const child = spawn(process.execPath, ["-e", `process.title='agent-worker:${id}'; console.log('ready'); setInterval(()=>{},1000);`]);
  children.push(child);
  await once(child.stdout!, "data");
  await ensureDirs(id);
  const record: WorkerRecord = {
    workerId: id, provider: "claude", state: "running", task: "fixture", turnId: "turn-one",
    cwd: tmp, writeAccess: false, transcriptMode: "activity", execProfile: "local",
    supervisorPid: child.pid!, lastSeq: 0, pending: [],
    owner: { clientId: "test", host: "unknown", since: new Date().toISOString() },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    paths: workerPaths(id), version: "test",
  };
  const save = () => writeJsonAtomic(record.paths.record, record);
  const add = (type: WorkerEvent["type"], text: string) => {
    record.lastSeq++;
    appendLine(record.paths.journal, { seq: record.lastSeq, ts: new Date().toISOString(), type, text });
  };
  await save();
  return { record, save, add, child };
}

it("finds a custom milestone beyond a backlog without acknowledging or changing the journal", async () => {
  const f = await fixture("backlog");
  for (let i = 0; i < 1200; i++) f.add("tool_completed", "routine");
  f.add("agent_message", "phase completed\n[[READY:phase-2]]\ndetails");
  await f.save();
  const before = fs.readFileSync(f.record.paths.journal);
  const result = await waitForWorker("backlog", { timeoutMs: 1000, sinceSeq: 0, attentionOnly: true,
    wakeRegex: compileWakeRegex(["^ask:", "^\\[\\[ready:phase-\\d+\\]\\]$"], "im") });
  assert.equal(result.reason, "event");
  assert.equal(result.event?.seq, 1201);
  assert.equal(result.matchedRegex, 1);
  assert.deepEqual(fs.readFileSync(f.record.paths.journal), before);
  assert.equal((await readSince<WorkerEvent>(f.record.paths.journal, 0, 1500)).entries.length, 1201);
  const legacy = await waitForWorker("backlog", { timeoutMs: 1000, sinceSeq: 0, messagesOnly: true });
  assert.equal(legacy.reason, "event", "legacy message waits must also drain past the first page");
});

it("has no fixed vocabulary and does not reset the deadline on routine activity", async () => {
  const f = await fixture("quiet");
  f.add("agent_message", "ATTENTION: this word is not implicitly configured");
  await f.save();
  const timer = setInterval(() => {
    f.add("agent_message", "routine progress");
    fs.writeFileSync(f.record.paths.record, JSON.stringify(f.record));
  }, 15);
  const start = Date.now();
  try {
    const result = await waitForWorker("quiet", { timeoutMs: 110, sinceSeq: 0, attentionOnly: true, pollMs: 10 });
    assert.equal(result.reason, "timeout");
    assert.ok(Date.now() - start >= 100);
    assert.ok(Date.now() - start < 1000);
    assert.ok((result.lastEvent?.seq ?? 0) > 1);
  } finally { clearInterval(timer); }
});

it("matches arbitrary normalized event text and resets stateful regex flags", async () => {
  const f = await fixture("regex");
  f.add("tool_completed", "build: OK 42");
  await f.save();
  const patterns = compileWakeRegex(["^BUILD: OK \\d+$"], "gim");
  for (let i = 0; i < 2; i++) {
    const result = await waitForWorker("regex", { timeoutMs: 100, sinceSeq: 0, attentionOnly: true, wakeRegex: patterns });
    assert.equal(result.matchedRegex, 0);
    assert.equal(result.event?.type, "tool_completed");
  }
  assert.throws(() => compileWakeRegex(["["]), /Invalid wake regex #0/);
  assert.throws(() => compileWakeRegex(["ok"], "invalid"), /Invalid wake regex/);
});

it("keeps built-in decision, error and completion signals even when regexes do not match", async () => {
  const f = await fixture("signals");
  for (const type of ["question", "permission_request", "permission_denied", "error", "final", "turn_completed"] as const) {
    const cursor = f.record.lastSeq;
    f.add(type, "no keyword needed");
    await f.save();
    const result = await waitForWorker("signals", { timeoutMs: 100, sinceSeq: cursor, attentionOnly: true,
      wakeRegex: compileWakeRegex(["never-match-this"]) });
    assert.equal(result.event?.type, type);
    assert.equal(result.matchedRegex, undefined);
  }
});

it("reports blocked, idle, missing, orphaned and replaced workers without controlling them", async () => {
  const f = await fixture("states");
  f.record.pending.push({ requestId: "q", kind: "question", text: "help", ts: new Date().toISOString() });
  await f.save();
  assert.equal((await waitForWorker("states", { timeoutMs: 100, attentionOnly: true })).reason, "state");
  f.record.pending = []; f.record.state = "idle"; await f.save();
  assert.equal((await waitForWorker("states", { timeoutMs: 100, states: ["idle"] })).reason, "state");
  assert.equal((await waitForWorker("absent", { timeoutMs: 100 })).reason, "gone");
  assert.equal((await waitForWorker("states", { timeoutMs: 100, expectedSupervisorPid: f.record.supervisorPid + 1 })).reason, "changed");
  assert.equal((await waitForWorker("states", { timeoutMs: 100, expectedTurnId: "other-turn" })).reason, "changed");
  f.record.state = "running"; await f.save();
  const exited = once(f.child, "exit"); f.child.kill(); await exited;
  const dead = await waitForWorker("states", { timeoutMs: 100 });
  assert.equal(dead.worker?.record.state, "orphaned");
});

it("does not confuse a journal ahead of the record snapshot with a restarted worker", async () => {
  const f = await fixture("snapshot-lag");
  f.add("tool_completed", "one"); await f.save();
  f.add("tool_completed", "two"); // the journal is durable before record publication
  const result = await waitForWorker("snapshot-lag", { timeoutMs: 60, sinceSeq: 0, attentionOnly: true, pollMs: 10 });
  assert.equal(result.reason, "timeout");
  assert.equal(result.lastEvent?.seq, 2);
});

it("retries a partial final line and reports an unreadable journal", async () => {
  const f = await fixture("partial");
  fs.writeFileSync(f.record.paths.journal, '{"seq":1,"type":"agent_message","text":"milestone');
  f.record.lastSeq = 1; await f.save();
  const waiting = waitForWorker("partial", { timeoutMs: 1000, sinceSeq: 0, attentionOnly: true,
    wakeRegex: compileWakeRegex(["milestone done"]), pollMs: 10 });
  await sleep(30);
  fs.appendFileSync(f.record.paths.journal, ' done"}\n');
  assert.equal((await waiting).matchedRegex, 0);
  fs.unlinkSync(f.record.paths.journal);
  await assert.rejects(waitForWorker("partial", { timeoutMs: 100, sinceSeq: 0, attentionOnly: true }), /ENOENT/);
});

it("can cancel an otherwise quiet wait", async () => {
  await fixture("cancel");
  await assert.rejects(waitForWorker("cancel", { timeoutMs: 10000, sinceSeq: 0, attentionOnly: true,
    signal: AbortSignal.timeout(40) }), /abort/i);
});

it("the standalone process stays silent and alive until a custom event, emitting one bounded result", async () => {
  const f = await fixture("cli");
  f.add("agent_message", "routine"); await f.save();
  const child = spawn(process.execPath, [bundle, "--worker", "cli", "--cursor", "0", "--deadline",
    new Date(Date.now() + 5000).toISOString(), "--wake-regex", "^Milestone \\d+: done$"]);
  children.push(child);
  let stdout = ""; let stderr = "";
  child.stdout!.on("data", (data) => { stdout += String(data); });
  child.stderr!.on("data", (data) => { stderr += String(data); });
  const exited = once(child, "exit");
  await sleep(250);
  assert.equal(stdout, ""); assert.equal(child.exitCode, null);
  f.add("agent_message", "Milestone 3: done"); await f.save();
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim().split("\n").length, 1);
  assert.ok(stdout.length < 2500);
  const result = JSON.parse(stdout);
  assert.equal(result.reason, "event"); assert.equal(result.matchedRegex, 0);
  assert.equal(result.readFromCursor, 0); assert.equal(result.event.seq, 2);
  assert.equal(result.state, "running", "a milestone does not certify task completion");
});

it("the CLI validates rules before waiting, preserves the absolute deadline and handles signals", async () => {
  await fixture("cli-deadline");
  const args = [bundle, "--worker", "cli-deadline", "--cursor", "0", "--deadline", new Date(Date.now() + 450).toISOString()];
  const started = Date.now();
  const output = await run(process.execPath, args);
  assert.equal(JSON.parse(output.stdout).reason, "deadline");
  assert.ok(Date.now() - started >= 350);
  await assert.rejects(run(process.execPath, [...args, "--wake-regex", "["]), (error: unknown) => {
    const result = error as { code: number; stdout: string };
    return result.code === 1 && JSON.parse(result.stdout).reason === "error";
  });
  const child = spawn(process.execPath, [bundle, "--worker", "cli-deadline", "--cursor", "0", "--deadline", new Date(Date.now() + 10000).toISOString()]);
  children.push(child);
  let stdout = ""; child.stdout!.on("data", (data) => { stdout += String(data); });
  const exited = once(child, "exit");
  await sleep(200); child.kill("SIGTERM");
  assert.equal((await exited)[0], 130);
  assert.equal(JSON.parse(stdout).reason, "cancelled");
});
