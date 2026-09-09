/**
 * Live smoke test: drive the real MCP bridge as a real MCP client.
 *
 * This is the check that adapter unit tests cannot make - it exercises the
 * whole path a host takes: stdio MCP, tool dispatch, a detached supervisor, a
 * real provider CLI, journals on disk, and the control socket.
 *
 * Usage:
 *   node scripts/smoke.mjs <provider> [scenario]
 *
 *   provider  claude | codex
 *   scenario  basic     start, read, second turn, result   (default)
 *             steer     send guidance mid-turn, then interrupt
 *             recover   kill the supervisor, then worker_resume
 *             worktree  isolated write in a git worktree, then inspect the commit
 *
 * Set AGENT_WORKERS_HOME to keep the run out of your real state directory.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bridge = path.join(root, "plugins/agent-workers/dist/agent-workers.mjs");

const provider = process.argv[2] ?? "claude";
const scenario = process.argv[3] ?? "basic";
const model = process.env.SMOKE_MODEL ?? (provider === "claude" ? "sonnet" : "gpt-5.6-sol");
const effort = process.env.SMOKE_EFFORT ?? (provider === "claude" ? "low" : "low");

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const say = (...args) => console.log(stamp(), ...args);
let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`${stamp()} PASS  ${label}`);
  else {
    failures += 1;
    console.log(`${stamp()} FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
  }
}

const workdir = process.env.SMOKE_WORKDIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "aw-smoke-"));
fs.mkdirSync(workdir, { recursive: true });

const client = new Client({ name: "agent-workers-smoke", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridge],
  env: { ...process.env, AGENT_WORKERS_PROJECT_DIR: workdir },
  stderr: "pipe",
});

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, isError: res.isError === true };
}

/** Poll worker_read until `predicate` sees the accumulated transcript. */
async function readUntil(workerId, predicate, { timeoutMs = 180000, mode } = {}) {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let all = "";
  while (Date.now() < deadline) {
    const res = await call("worker_read", { workerId, cursor, ...(mode ? { mode } : {}) });
    const next = /cursor \d+ -> (\d+)/.exec(res.text);
    if (next) cursor = Number(next[1]);
    if (res.text.includes("(nothing new)") === false) all += `\n${res.text}`;
    if (predicate(all, res.text)) return { all, cursor, hit: true };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { all, cursor, hit: false };
}

/** Like readUntil, but starting from an explicit cursor. */
async function readFrom(workerId, startCursor, predicate, { timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let cursor = startCursor;
  let all = "";
  while (Date.now() < deadline) {
    const res = await call("worker_read", { workerId, cursor });
    const next = /cursor \d+ -> (\d+)/.exec(res.text);
    if (next) cursor = Number(next[1]);
    if (!res.text.includes("(nothing new)")) all += `\n${res.text}`;
    if (predicate(all, res.text)) return { all, cursor, hit: true };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { all, cursor, hit: false };
}

function workerIdFrom(text) {
  const m = /worker "([^"]+)"/.exec(text);
  return m ? m[1] : undefined;
}

async function scenarioBasic() {
  say(`starting a ${provider} worker (${model}) in ${workdir}`);
  const started = await call("worker_start", {
    provider,
    model,
    effort,
    cwd: workdir,
    task: "Remember the codeword ZANDER-7741. Reply with exactly the word ALPHA and nothing else.",
    transcriptMode: "activity",
  });
  say(started.text.split("\n").slice(0, 4).join(" | "));
  check("worker_start succeeded", !started.isError, started.text.slice(0, 300));
  const workerId = workerIdFrom(started.text);
  check("worker_start returned an id", Boolean(workerId));
  if (!workerId) return;

  const first = await readUntil(workerId, (all) => /ALPHA/.test(all));
  check("worker produced an intermediate message before the end", first.hit, first.all.slice(-400));

  say("sending a second turn on the same session (context check)");
  const cursorBeforeSend = first.cursor;
  const sent = await call("worker_send", {
    workerId,
    text: "What codeword did I ask you to remember? Answer with only that codeword.",
  });
  check("worker_send accepted", !sent.isError, sent.text.slice(0, 200));
  say(sent.text.split("\n")[1] ?? "");

  // Read strictly from after the first turn, so the codeword can only come from
  // the worker recalling it - never from an echo of our own opening message.
  const second = await readFrom(workerId, cursorBeforeSend, (all) => /ZANDER-7741/.test(all));
  check("context survived across turns", second.hit, second.all.slice(-400));

  const result = await call("worker_result", { workerId });
  check("worker_result returned a final answer", /final answer/.test(result.text), result.text.slice(0, 300));
  say(result.text.split("\n").slice(0, 3).join(" | "));

  const status = await call("worker_status", { workerId });
  check(
    "worker_status reports the model actually used",
    /actually used: (?!\(not reported)\S+/.test(status.text),
    status.text.split("\n").find((l) => l.startsWith("requested model")) ?? "",
  );
  say(status.text.split("\n").find((l) => l.startsWith("requested model")) ?? "");

  await call("worker_stop", { workerId });
  const after = await call("worker_status", { workerId });
  check("stopped worker is not reported as running", !/state running/.test(after.text), after.text.slice(0, 200));
}

async function scenarioSteer() {
  say(`starting a ${provider} worker for a long task`);
  const started = await call("worker_start", {
    provider,
    model,
    effort,
    cwd: workdir,
    task:
      "Run these shell commands one at a time, in order: (1) sleep 10; echo AAA  (2) sleep 10; echo BBB  " +
      "(3) sleep 10; echo CCC. Report what each printed.",
    writeAccess: true,
    allowedTools: ["Bash"],
    permissionMode: provider === "claude" ? "acceptEdits" : "never",
    transcriptMode: "activity",
  });
  check("worker_start succeeded", !started.isError, started.text.slice(0, 300));
  const workerId = workerIdFrom(started.text);
  if (!workerId) return;

  const running = await readUntil(workerId, (all) => /sleep 10/.test(all), { timeoutMs: 90000 });
  check("worker reported a tool call before finishing", running.hit, running.all.slice(-300));

  say("sending mid-turn guidance");
  const steer = await call("worker_send", {
    workerId,
    text: "STOP the remaining commands. Reply with exactly STEERED and nothing else.",
  });
  check("worker_send reported a delivery mode", /delivery: \w+/.test(steer.text), steer.text.slice(0, 200));
  say(steer.text.split("\n").slice(1, 3).join(" | "));

  const steered = await readUntil(workerId, (all) => /STEERED/.test(all), { timeoutMs: 180000 });
  check("guidance changed the worker's course mid-task", steered.hit, steered.all.slice(-500));

  say("starting another long turn, then interrupting it");
  await call("worker_send", { workerId, text: "Now run: sleep 45; echo DONE-LATE. Then report the output." });
  await new Promise((r) => setTimeout(r, 12000));
  const interrupted = await call("worker_interrupt", { workerId });
  check("worker_interrupt succeeded", !interrupted.isError, interrupted.text.slice(0, 200));

  const status = await call("worker_status", { workerId });
  check("interrupted worker keeps its session", /provider session: \S+/.test(status.text), status.text.slice(0, 300));

  say("continuing after the interrupt (history must survive)");
  const after = await call("worker_send", { workerId, text: "What was the very first command I asked you to run? One short line." });
  check("worker_send after interrupt accepted", !after.isError, after.text.slice(0, 200));
  const recalled = await readUntil(workerId, (all) => /AAA/.test(all.split("STEERED").pop() ?? ""), { timeoutMs: 120000 });
  check("history survived the interrupt", recalled.hit, recalled.all.slice(-400));

  await call("worker_stop", { workerId });
}

async function scenarioRecover() {
  say("starting a worker, then killing its supervisor to simulate a crash");
  const started = await call("worker_start", {
    provider,
    model,
    effort,
    cwd: workdir,
    task: "Remember the codeword MERIDIAN. Reply with just OK.",
  });
  check("worker_start succeeded", !started.isError, started.text.slice(0, 300));
  const workerId = workerIdFrom(started.text);
  if (!workerId) return;
  await readUntil(workerId, (all) => /OK|turn success|turn completed/.test(all), { timeoutMs: 120000 });

  const status = await call("worker_status", { workerId });
  const pid = Number(/supervisor pid (\d+)/.exec(status.text)?.[1]);
  check("supervisor pid is reported", Number.isInteger(pid) && pid > 0);
  process.kill(pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 1500));

  const orphaned = await call("worker_status", { workerId });
  check("a dead supervisor is reported honestly, not as running", /orphaned/.test(orphaned.text), orphaned.text.slice(0, 300));
  check("the dead pid is flagged", /NOT RUNNING/.test(orphaned.text));

  const send = await call("worker_send", { workerId, text: "anything" });
  check("worker_send on an orphan fails with guidance", send.isError, send.text.slice(0, 200));

  say("resuming onto the saved provider session");
  const resumed = await call("worker_resume", {
    workerId,
    task: "What codeword did I ask you to remember? Answer with only that word.",
  });
  check("worker_resume succeeded", !resumed.isError, resumed.text.slice(0, 400));

  const recalled = await readUntil(workerId, (all) => /MERIDIAN/.test(all), { timeoutMs: 150000 });
  check("context survived the crash and resume", recalled.hit, recalled.all.slice(-400));
  await call("worker_stop", { workerId });
}

async function scenarioWorktree() {
  const repo = path.join(workdir, "repo");
  if (!fs.existsSync(repo)) {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# smoke repo\n");
    const g = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    g("init", "-q");
    g("config", "user.email", "smoke@example.invalid");
    g("config", "user.name", "Smoke Test");
    g("add", "-A");
    g("commit", "-qm", "initial");
  }
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  say(`repo ${repo} at ${baseSha.slice(0, 12)}`);

  const started = await call("worker_start", {
    provider,
    model,
    effort,
    cwd: repo,
    writeAccess: true,
    worktree: true,
    base: baseSha,
    task:
      "Create a file named NOTE.md in the current directory containing exactly the line 'isolated worker note', " +
      "then commit it with the message 'add note'. Report the commit sha.",
    allowedTools: ["Bash", "Write", "Read"],
    permissionMode: provider === "claude" ? "acceptEdits" : "never",
  });
  check("worker_start with a worktree succeeded", !started.isError, started.text.slice(0, 400));
  say(started.text.split("\n").slice(0, 4).join(" | "));
  const workerId = workerIdFrom(started.text);
  if (!workerId) return;
  check("a worktree was created", /worktree: .*branch agent\//.test(started.text), started.text.slice(0, 400));

  const done = await readUntil(workerId, (all) => /NOTE\.md/.test(all), { timeoutMs: 240000 });
  check("the worker reported its file work", done.hit, done.all.slice(-600));

  // Collect only once the turn has actually ended - reading a result mid-turn
  // reports what exists so far, which for a commit is nothing yet.
  say("waiting for the worker to finish before collecting");
  let waited = { text: "" };
  for (let i = 0; i < 8; i += 1) {
    waited = await call("worker_wait", { workerId, until: "idle", timeoutMs: 30000 });
    if (/state (idle|completed|interrupted|failed|stopped)/.test(waited.text)) break;
  }
  check("worker_wait returned once the worker went idle", /state (idle|completed|interrupted)/.test(waited.text), waited.text.slice(0, 200));

  const result = await call("worker_result", { workerId });
  say(result.text.split("\n").slice(0, 8).join("\n"));
  check("result names the changed file or the commit", /NOTE\.md|commit: /.test(result.text), result.text.slice(0, 500));

  const mainClean = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString().trim();
  check("the main checkout was left untouched", mainClean === "", mainClean);

  // A second write worker in the same directory must be refused.
  const conflict = await call("worker_start", {
    provider,
    workerId: `${workerId}-conflict`,
    cwd: path.join(repo, ".worktrees", `aw-${workerId}`),
    writeAccess: true,
    task: "do nothing",
  });
  check("a second writer in the same directory is refused", conflict.isError, conflict.text.slice(0, 300));

  await call("worker_stop", { workerId });
}

const SCENARIOS = { basic: scenarioBasic, steer: scenarioSteer, recover: scenarioRecover, worktree: scenarioWorktree };

async function main() {
  await client.connect(transport);
  transport.stderr?.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line.length > 0 && process.env.SMOKE_VERBOSE) console.log("  [bridge]", line.slice(0, 300));
  });

  const tools = await client.listTools();
  say(`bridge exposes ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);
  check("all worker tools are exposed", tools.tools.length >= 12);

  const run = SCENARIOS[scenario];
  if (!run) throw new Error(`unknown scenario "${scenario}"`);
  await run();

  await client.close();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} (${provider}/${scenario})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke run crashed:", err);
  process.exit(1);
});
