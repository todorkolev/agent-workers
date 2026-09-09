/**
 * Integration tests: a real MCP client, the real bridge bundle, real detached
 * supervisors, real journals and real control sockets - with scripted provider
 * CLIs standing in for `claude` and `codex`.
 *
 * The fakes speak the protocols the live spikes recorded, which is what makes
 * these tests meaningful: they cover the machinery around the providers
 * (delivery semantics, blocking, recovery, ownership, write isolation) at a
 * speed and determinism live model calls cannot offer. The live smoke script
 * covers the other half - that the real CLIs still behave this way.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const bridgeBundle = path.join(root, "plugins/agent-workers/dist/agent-workers.mjs");
const fakeClaude = path.join(here, "fixtures/fake-claude.mjs");
const fakeCodex = path.join(here, "fixtures/fake-codex.mjs");

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "aw-int-state-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-int-proj-"));

/** One connected MCP client against a freshly spawned bridge process. */
type Bridge = {
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
};

async function openBridge(clientId: string, extraEnv: Record<string, string> = {}): Promise<Bridge> {
  const client = new Client({ name: `test-${clientId}`, version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgeBundle],
    env: {
      ...process.env,
      AGENT_WORKERS_HOME: stateHome,
      AGENT_WORKERS_PROJECT_DIR: projectDir,
      AGENT_WORKERS_CLIENT_ID: clientId,
      AGENT_WORKERS_CLAUDE_BIN: fakeClaude,
      AGENT_WORKERS_CODEX_BIN: fakeCodex,
      AGENT_WORKERS_LOG: "error",
      ...extraEnv,
    },
    stderr: "ignore",
  });
  await client.connect(transport);
  return {
    client,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const content = (res.content ?? []) as Array<{ text?: string }>;
      return { text: content.map((c) => c.text ?? "").join("\n"), isError: res.isError === true };
    },
    async close() {
      await client.close();
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll worker_read until the accumulated transcript satisfies `predicate`. */
async function readUntil(
  bridge: Bridge,
  workerId: string,
  predicate: (all: string) => boolean,
  { timeoutMs = 20_000, from = 0 } = {},
): Promise<{ hit: boolean; all: string; cursor: number }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = from;
  let all = "";
  while (Date.now() < deadline) {
    const res = await bridge.call("worker_read", { workerId, cursor, mode: "verbose" });
    const next = /cursor \d+ -> (\d+)/.exec(res.text);
    if (next?.[1] !== undefined) cursor = Number(next[1]);
    if (!res.text.includes("(nothing new)")) all += `\n${res.text}`;
    if (predicate(all)) return { hit: true, all, cursor };
    await sleep(150);
  }
  return { hit: false, all, cursor };
}

async function waitForState(
  bridge: Bridge,
  workerId: string,
  state: string,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = (await bridge.call("worker_status", { workerId })).text;
    if (text.includes(`state ${state}`)) return text;
    await sleep(150);
  }
  return text;
}

function idOf(text: string): string {
  const m = /worker "([^"]+)"/.exec(text);
  assert.ok(m?.[1], `no worker id in: ${text.slice(0, 300)}`);
  return m[1] as string;
}

let bridge: Bridge;

before(async () => {
  assert.ok(fs.existsSync(bridgeBundle), "run `npm run build` before the integration tests");
  fs.chmodSync(fakeClaude, 0o755);
  fs.chmodSync(fakeCodex, 0o755);
  bridge = await openBridge("test-primary");
});

after(async () => {
  try {
    const list = await bridge.call("worker_list", {});
    for (const line of list.text.split("\n").slice(1)) {
      const id = line.split("\t")[0];
      if (id && id !== "id") await bridge.call("worker_stop", { workerId: id, takeover: true });
    }
  } catch {
    /* best effort */
  }
  await bridge.close().catch(() => undefined);
  fs.rmSync(stateHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("exposes the full worker contract to the host", async () => {
    const tools = await bridge.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "worker_interrupt",
      "worker_list",
      "worker_read",
      "worker_respond",
      "worker_result",
      "worker_resume",
      "worker_send",
      "worker_start",
      "worker_status",
      "worker_stop",
      "worker_trace",
      "worker_wait",
    ]);
  });
});

for (const provider of ["claude", "codex"] as const) {
  describe(`${provider} worker`, () => {
    it("keeps its context across several turns", async () => {
      const started = await bridge.call("worker_start", {
        provider,
        cwd: projectDir,
        task: "REMEMBER halcyon",
        waitFor: "started",
      });
      assert.equal(started.isError, false, started.text);
      const workerId = idOf(started.text);
      // waitFor "started" must not have skipped past the opening task.
      assert.doesNotMatch(started.text, /state idle .* seq 0/);

      const first = await readUntil(bridge, workerId, (all) => /OK/.test(all));
      assert.ok(first.hit, first.all);

      const sent = await bridge.call("worker_send", { workerId, text: "RECALL" });
      assert.equal(sent.isError, false, sent.text);
      assert.match(sent.text, /delivery: started_new_turn/);

      const recalled = await readUntil(bridge, workerId, (all) => /halcyon/.test(all), { from: first.cursor });
      assert.ok(recalled.hit, `the worker did not recall across turns:\n${recalled.all}`);

      // Both providers must produce a final answer: Codex has no distinct
      // "final" message, so its last agentMessage before turn/completed is it.
      for (let i = 0; i < 20; i += 1) {
        const status = await bridge.call("worker_status", { workerId });
        if (/state idle/.test(status.text)) break;
        await sleep(200);
      }
      const result = await bridge.call("worker_result", { workerId });
      assert.match(result.text, /final answer/);
      assert.doesNotMatch(result.text, /has not produced a final answer/);
      await bridge.call("worker_stop", { workerId });
    });

    it("reports how a mid-turn message was really delivered, and can interrupt", async () => {
      const started = await bridge.call("worker_start", { provider, cwd: projectDir, task: "SLOW work" });
      const workerId = idOf(started.text);
      await readUntil(bridge, workerId, (all) => /sleep 30/.test(all));

      const steered = await bridge.call("worker_send", { workerId, text: "STOP now" });
      assert.equal(steered.isError, false, steered.text);
      // The two backends really do differ here, and the tool says which happened
      // rather than pretending they are the same thing.
      const expected = provider === "codex" ? /delivery: steered_into_turn/ : /delivery: queued_for_turn/;
      assert.match(steered.text, expected);

      const done = await readUntil(bridge, workerId, (all) => /STEERED/.test(all));
      assert.ok(done.hit, `mid-turn guidance did not take effect:\n${done.all}`);

      // Now a turn we cut short.
      await bridge.call("worker_send", { workerId, text: "SLOW again" });
      await readUntil(bridge, workerId, (all) => /sleep 30/.test(all), { from: done.cursor });
      const interrupted = await bridge.call("worker_interrupt", { workerId });
      assert.equal(interrupted.isError, false, interrupted.text);

      const status = await waitForState(bridge, workerId, "interrupted");
      assert.match(status, /state interrupted/);
      // The session must survive an interrupt - that is the whole difference
      // between interrupt and stop.
      assert.match(status, /provider session: \S+/);

      const after = await bridge.call("worker_send", { workerId, text: "RECALL" });
      assert.equal(after.isError, false, after.text);
      const recalled = await readUntil(bridge, workerId, (all) => /halcyon|NOTHING|echo:/.test(all));
      assert.ok(recalled.hit, recalled.all);
      await bridge.call("worker_stop", { workerId });
    });

    it("survives its supervisor being killed and resumes the same session", async () => {
      const started = await bridge.call("worker_start", {
        provider,
        cwd: projectDir,
        task: "REMEMBER meridian",
      });
      const workerId = idOf(started.text);
      await readUntil(bridge, workerId, (all) => /OK/.test(all));

      const status = await bridge.call("worker_status", { workerId });
      const pid = Number(/supervisor pid (\d+)/.exec(status.text)?.[1]);
      const sessionBefore = /provider session: (\S+)/.exec(status.text)?.[1];
      assert.ok(Number.isInteger(pid) && pid > 0, status.text);
      process.kill(pid, "SIGKILL");
      await sleep(400);

      const orphaned = await bridge.call("worker_status", { workerId });
      // The one thing that must never happen: reporting a dead process as running.
      assert.match(orphaned.text, /state orphaned/);
      assert.match(orphaned.text, /NOT RUNNING/);

      const rejected = await bridge.call("worker_send", { workerId, text: "hello" });
      assert.equal(rejected.isError, true);
      assert.match(rejected.text, /worker_resume/);

      const seqBefore = Number(/seq (\d+)/.exec(status.text)?.[1] ?? 0);
      const resumed = await bridge.call("worker_resume", { workerId, task: "RECALL" });
      assert.equal(resumed.isError, false, resumed.text);
      const after = await bridge.call("worker_status", { workerId });
      assert.equal(/provider session: (\S+)/.exec(after.text)?.[1], sessionBefore);
      assert.doesNotMatch(after.text, /NOT RUNNING/);

      // The journal is append-only and seq is the manager's cursor: a resume
      // that restarted numbering would append duplicate seqs and every cursor
      // held by a manager would then point at the wrong event.
      const recalled = await readUntil(bridge, workerId, (all) => /meridian|RESUMED/.test(all), {
        from: seqBefore,
      });
      assert.ok(recalled.hit, `nothing new after the resume:\n${recalled.all}`);
      const final = await bridge.call("worker_status", { workerId });
      const seqAfter = Number(/seq (\d+)/.exec(final.text)?.[1] ?? 0);
      assert.ok(seqAfter > seqBefore, `seq went backwards across a resume: ${seqBefore} -> ${seqAfter}`);
      await bridge.call("worker_stop", { workerId });
    });
  });
}

describe("blocking on a decision", () => {
  it("surfaces a Codex approval as a pending request and unblocks on an answer", async () => {
    const started = await bridge.call("worker_start", {
      provider: "codex",
      cwd: projectDir,
      task: "APPROVAL please",
      writeAccess: false,
    });
    const workerId = idOf(started.text);

    const blocked = await waitForState(bridge, workerId, "blocked");
    assert.match(blocked, /state blocked/);
    const requestId = /(\S+) \(permission\)/.exec(blocked)?.[1];
    assert.ok(requestId, `no pending requestId in:\n${blocked}`);

    // A message sent while blocked must be held, not silently dropped.
    const queued = await bridge.call("worker_send", { workerId, text: "later" });
    assert.match(queued.text, /delivery: queued_after_block/);

    const answered = await bridge.call("worker_respond", { workerId, requestId, decision: "allow" });
    assert.equal(answered.isError, false, answered.text);

    const seen = await readUntil(bridge, workerId, (all) => /approval:accept/.test(all));
    assert.ok(seen.hit, `the approval decision never reached the worker:\n${seen.all}`);
    await bridge.call("worker_stop", { workerId });
  });

  it("reports a permission denial as an event rather than a hung worker", async () => {
    const started = await bridge.call("worker_start", { provider: "claude", cwd: projectDir, task: "DENY this" });
    const workerId = idOf(started.text);
    const seen = await readUntil(bridge, workerId, (all) => /DENIED:/.test(all));
    assert.ok(seen.hit, seen.all);
    const status = await waitForState(bridge, workerId, "idle");
    assert.match(status, /state idle/);
    await bridge.call("worker_stop", { workerId });
  });
});

describe("write isolation", () => {
  const repo = path.join(projectDir, "repo");

  before(() => {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
    const g = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    };
    g("init", "-q");
    g("config", "user.email", "t@example.invalid");
    g("config", "user.name", "T");
    g("add", "-A");
    g("commit", "-qm", "initial");
  });

  it("rejects different-prefix launcher worktrees before Git creates anything", async () => {
    const config=path.join(projectDir,"mapped-config.json");
    fs.writeFileSync(config,JSON.stringify({execProfiles:{mapped:{name:"mapped",launcher:["env"],pathMap:[{host:repo,target:"/container/repo"}]}}}));
    const mapped=await openBridge("mapped-test",{AGENT_WORKERS_CONFIG:config});
    const before=execFileSync("git",["worktree","list","--porcelain"],{cwd:repo}).toString();
    try {
      const res=await mapped.call("worker_start",{provider:"codex",workerId:"mapped-wt",cwd:repo,execProfile:"mapped",worktree:true,writeAccess:true,task:"WRITE"});
      assert.equal(res.isError,true,res.text);
      assert.match(res.text,/different host and target paths/);
      assert.equal(execFileSync("git",["worktree","list","--porcelain"],{cwd:repo}).toString(),before);
    } finally { await mapped.close(); }
  });

  it("puts a write worker in its own worktree cut from an exact base", async () => {
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const started = await bridge.call("worker_start", {
      provider: "codex",
      workerId: "wt-writer",
      cwd: repo,
      task: "WRITE something",
      writeAccess: true,
      worktree: true,
      base,
    });
    try {
      assert.equal(started.isError, false, started.text);
      assert.match(started.text, /branch agent\/wt-writer \(created, base /);
      assert.ok(fs.existsSync(path.join(repo, ".worktrees", "aw-wt-writer")));

      // A write worker without isolation is refused before anything starts.
      const unguarded = await bridge.call("worker_start", {
        provider: "claude",
        workerId: "wt-unguarded",
        cwd: repo,
        task: "anything",
        writeAccess: true,
      });
      assert.equal(unguarded.isError, true);
      assert.match(unguarded.text, /needs its own worktree/);

      // And a second writer aimed at the same worktree is refused as a conflict.
      const conflict = await bridge.call("worker_start", {
        provider: "claude",
        workerId: "wt-writer-2",
        cwd: repo,
        worktreePath: path.join(repo, ".worktrees", "aw-wt-writer"),
        branch: "agent/wt-writer",
        task: "anything",
        writeAccess: true,
      });
      assert.equal(conflict.isError, true, conflict.text);
      assert.match(conflict.text, /already writing in/);

      // Isolation has to be invisible from the main checkout: a stray
      // `?? .worktrees/` is scaffolding someone will eventually commit.
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString().trim(), "");
    } finally {
      await bridge.call("worker_stop", { workerId: "wt-writer", takeover: true });
    }
  });

  it("refuses to edit the repository's own checkout as a worktree", async () => {
    const res = await bridge.call("worker_start", {
      provider: "codex",
      workerId: "wt-primary",
      cwd: repo,
      worktreePath: repo,
      task: "WRITE",
      writeAccess: true,
    });
    assert.equal(res.isError, true, res.text);
    assert.match(res.text, /main checkout/);
  });

  it("refuses a second writer even when two starts race", async () => {
    // The bridge's conflict scan runs before either supervisor exists, so on its
    // own it is check-then-act. Starting both at once is the case that matters.
    const dir = path.join(repo, ".worktrees", "aw-race");
    const [a, b] = await Promise.all([
      bridge.call("worker_start", {
        provider: "codex",
        workerId: "race-a",
        cwd: repo,
        worktreePath: dir,
        branch: "agent/race",
        task: "WRITE a",
        writeAccess: true,
        waitFor: "started",
      }),
      bridge.call("worker_start", {
        provider: "claude",
        workerId: "race-b",
        cwd: repo,
        worktreePath: dir,
        branch: "agent/race",
        task: "WRITE b",
        writeAccess: true,
        waitFor: "started",
      }),
    ]);
    try {
      // The invariant is "never two", not "always exactly one": two concurrent
      // `git worktree add` calls on one path may both legitimately fail.
      const winners = [a, b].filter((r) => !r.isError && !/state failed/.test(r.text));
      assert.ok(winners.length <= 1, `both starts claimed the same directory:\nA: ${a.text}\n\nB: ${b.text}`);
      const loser = [a, b].find((r) => r.isError || /state failed/.test(r.text));
      assert.ok(loser !== undefined, "one of the racing starts had to be refused");
      assert.match(loser.text, /already writing in|already exists|not a git worktree|failed/);
    } finally {
      for (const id of ["race-a", "race-b"]) {
        await bridge.call("worker_stop", { workerId: id, takeover: true }).catch(() => undefined);
      }
    }
  });

  it("retains directory ownership until the old provider has exited", async () => {
    const marker=path.join(stateHome,"stop-marker");
    const slow=await openBridge("slow-owner",{FAKE_STOP_DELAY_MS:"1000",FAKE_STOP_MARKER:marker});
    const id="slow-dispose";
    try {
      const start=await slow.call("worker_start",{provider:"codex",workerId:id,cwd:repo,task:"hello",writeAccess:true,worktree:true,waitFor:"idle"});
      assert.equal(start.isError,false,start.text);
      const stopping=slow.call("worker_stop",{workerId:id});
      for(let i=0;i<100&&!fs.existsSync(marker);i++) await sleep(10);
      assert.ok(fs.existsSync(marker),"provider entered its slow shutdown");
      const next=await bridge.call("worker_start",{provider:"codex",workerId:"early-replacement",cwd:path.join(repo,".worktrees","aw-"+id),task:"hello",writeAccess:true,allowMainCheckout:true});
      assert.equal(next.isError,true,next.text);
      assert.match(next.text,/already writing/);
      assert.equal((await stopping).isError,false);
    } finally { await slow.close(); }
  });

  it("starts a fresh attribution baseline when worker_start reuses a stopped ID", async () => {
    const id="fresh-reuse",dir=path.join(repo,".worktrees","aw-"+id);
    const args={provider:"codex",workerId:id,cwd:repo,worktree:true,writeAccess:true,task:"first run",waitFor:"idle"};
    const first=await bridge.call("worker_start",args);assert.equal(first.isError,false,first.text);
    execFileSync("git",["-C",dir,"commit","--allow-empty","-m","prior-run-commit"],{stdio:"pipe"});
    const prior=(await bridge.call("worker_result",{workerId:id})).text;
    assert.match(prior,/prior-run-commit/);
    await bridge.call("worker_stop",{workerId:id});await sleep(250);
    const second=await bridge.call("worker_start",{...args,task:"second run"});assert.equal(second.isError,false,second.text);
    const result=(await bridge.call("worker_result",{workerId:id})).text;
    assert.doesNotMatch(result,/commit:|prior-run-commit/);
    await bridge.call("worker_stop",{workerId:id});
  });

  it("adopts a worktree that already exists instead of recreating its branch", async () => {
    const dir = path.join(repo, ".worktrees", "aw-wt-writer");
    // Same worktree, same branch, second worker: this is the case that used to
    // fail with "a branch named ... already exists".
    const again = await bridge.call("worker_start", {
      provider: "codex",
      workerId: "wt-adopter",
      cwd: repo,
      worktreePath: dir,
      branch: "agent/wt-writer",
      task: "WRITE more",
      writeAccess: true,
    });
    try {
      assert.equal(again.isError, false, again.text);
      assert.match(again.text, /adopted/);
    } finally {
      await bridge.call("worker_stop", { workerId: "wt-adopter", takeover: true });
    }
  });
});

describe("two managers at once", () => {
  it("keeps one owner, lets the other read, and requires an explicit takeover", async () => {
    const other = await openBridge("test-secondary");
    try {
      const started = await bridge.call("worker_start", {
        provider: "codex",
        workerId: "shared-worker",
        cwd: projectDir,
        task: "REMEMBER shared",
      });
      assert.equal(started.isError, false, started.text);

      // The second manager can always read.
      const read = await other.call("worker_read", { workerId: "shared-worker", cursor: 0 });
      assert.equal(read.isError, false, read.text);
      const list = await other.call("worker_list", {});
      assert.match(list.text, /shared-worker/);

      // But it may not steer without saying so.
      const denied = await other.call("worker_send", { workerId: "shared-worker", text: "RECALL" });
      assert.equal(denied.isError, true, denied.text);
      assert.match(denied.text, /takeover: true/);

      const taken = await other.call("worker_send", {
        workerId: "shared-worker",
        text: "RECALL",
        takeover: true,
      });
      assert.equal(taken.isError, false, taken.text);

      const status = await other.call("worker_status", { workerId: "shared-worker" });
      assert.match(status.text, /client test-secondary/);
    } finally {
      await other.close().catch(() => undefined);
      await bridge.call("worker_stop", { workerId: "shared-worker", takeover: true });
    }
  });

  it("finds and controls a worker from a brand new bridge process", async () => {
    const started = await bridge.call("worker_start", {
      provider: "claude",
      workerId: "survivor",
      cwd: projectDir,
      task: "REMEMBER persistence",
    });
    assert.equal(started.isError, false, started.text);
    await readUntil(bridge, "survivor", (all) => /OK/.test(all));

    // A different bridge process - the same thing that happens when a host
    // restarts - must see the worker and be able to drive it.
    const restarted = await openBridge("test-primary");
    try {
      const status = await restarted.call("worker_status", { workerId: "survivor" });
      assert.doesNotMatch(status.text, /NOT RUNNING/);
      const sent = await restarted.call("worker_send", { workerId: "survivor", text: "RECALL" });
      assert.equal(sent.isError, false, sent.text);
      const recalled = await readUntil(restarted, "survivor", (all) => /persistence/.test(all));
      assert.ok(recalled.hit, recalled.all);
    } finally {
      await restarted.close().catch(() => undefined);
      await bridge.call("worker_stop", { workerId: "survivor", takeover: true });
    }
  });
});

describe("waiting", () => {
  it("waitFor idle means the opening task finished, not that it never started", async () => {
    // The supervisor briefly has a live session and no turn yet. Publishing
    // `idle` there would let waitFor: "idle" return an empty journal as if the
    // work were already done.
    const started = await bridge.call("worker_start", {
      provider: "claude",
      cwd: projectDir,
      task: "REMEMBER pumice",
      waitFor: "idle",
      waitMs: 20000,
    });
    assert.equal(started.isError, false, started.text);
    const workerId = idOf(started.text);
    const seq = Number(/seq (\d+)/.exec(started.text)?.[1] ?? 0);
    assert.ok(seq > 0, `worker_start(waitFor: "idle") returned before any work happened:\n${started.text}`);
    await bridge.call("worker_stop", { workerId });
  });
});

describe("failure reporting", () => {
  it("reports a provider that dies as failed, with the log to look at", async () => {
    const started = await bridge.call("worker_start", { provider: "claude", cwd: projectDir, task: "CRASH now", waitFor: "idle" });
    // Await the opening turn: an init notification can race the immediate
    // process exit, whereas waitFor idle must report that turn's failure.
    assert.equal(started.isError, true, started.text);
    assert.match(started.text, /exited unexpectedly/);
    assert.match(started.text, /supervisor\.log/);

    const workerId = /Worker "([^"]+)"/.exec(started.text)?.[1];
    assert.ok(workerId, started.text);
    const status = await bridge.call("worker_status", { workerId });
    assert.match(status.text, /state failed/);
  });

  it("refuses a worker whose provider CLI is missing, before starting anything", async () => {
    const other = await openBridge("test-missing-bin");
    try {
      const res = await other.client.callTool({
        name: "worker_start",
        arguments: { provider: "codex", cwd: projectDir, task: "x", execProfile: "does-not-exist" },
      });
      const text = ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
      assert.equal(res.isError, true);
      assert.match(text, /unknown execProfile/);
    } finally {
      await other.close().catch(() => undefined);
    }
  });

  it("refuses to start when the provider CLI is not logged in", async () => {
    // The real CLI on a developer machine reports logged in even from an
    // isolated home, so this branch is only reachable with a scripted provider.
    const other = await openBridge("test-logged-out", { FAKE_CODEX_LOGGED_OUT: "1" });
    try {
      const res = await other.client.callTool({
        name: "worker_start",
        arguments: { provider: "codex", cwd: projectDir, task: "x", workerId: "logged-out" },
      });
      const text = ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
      assert.equal(res.isError, true, text);
      assert.match(text, /not logged in/);
      assert.match(text, /codex login/);
    } finally {
      await other.close().catch(() => undefined);
    }
  });

  it("closes out a worker whose supervisor is already gone", async () => {
    const started = await bridge.call("worker_start", {
      provider: "claude",
      workerId: "stop-orphan",
      cwd: projectDir,
      task: "REMEMBER tombstone",
    });
    assert.equal(started.isError, false, started.text);
    const status = await bridge.call("worker_status", { workerId: "stop-orphan" });
    process.kill(Number(/supervisor pid (\d+)/.exec(status.text)?.[1]), "SIGKILL");
    await sleep(400);
    assert.match((await bridge.call("worker_status", { workerId: "stop-orphan" })).text, /state orphaned/);

    await bridge.call("worker_stop", { workerId: "stop-orphan" });
    // An explicit stop must settle the state, not leave it reading `orphaned`
    // as though recovery were still on the table.
    const after = await bridge.call("worker_status", { workerId: "stop-orphan" });
    assert.match(after.text, /state stopped/);
  });

  it("says a worker does not exist rather than inventing one", async () => {
    const res = await bridge.call("worker_status", { workerId: "no-such-worker" });
    assert.equal(res.isError, true);
    assert.match(res.text, /No worker "no-such-worker"/);
  });
});


describe("persisted ownership", () => {
  it("requires explicit takeover to resume, stop, purge or reuse another manager's dead worker", async () => {
    const id="dead-owned";
    const start=await bridge.call("worker_start",{provider:"codex",workerId:id,task:"hello",waitFor:"idle"});
    assert.equal(start.isError,false,start.text);
    await bridge.call("worker_stop",{workerId:id});
    await sleep(400);
    const other=await openBridge("other-manager");
    try {
      for (const [tool,args] of [
        ["worker_resume",{workerId:id}], ["worker_stop",{workerId:id}],
        ["worker_stop",{workerId:id,purge:true}],
        ["worker_start",{workerId:id,provider:"codex",task:"new"}],
      ] as const) {
        const res=await other.call(tool,args);
        assert.equal(res.isError,true,res.text);assert.match(res.text,/not_owner/);
      }
      assert.ok(fs.existsSync(path.join(stateHome,"workers",id,"journal.ndjson")));
      const resumed=await other.call("worker_resume",{workerId:id,takeover:true,task:"hello again"});
      assert.equal(resumed.isError,false,resumed.text);
      const stopped=await other.call("worker_stop",{workerId:id});
      assert.equal(stopped.isError,false,stopped.text);
    } finally { await other.close(); }
  });
});
