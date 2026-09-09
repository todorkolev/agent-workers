/**
 * Unit tests for the pieces that make concurrent, multi-host use safe:
 * atomic record writes, cursor semantics, transcript filtering, path mapping
 * and the control channel.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import { appendLine, pidAlive, readSince, writeJsonAtomic } from "../src/core/store.ts";
import { launcherArgv, resolveExecProfile, toHostPath, toTargetPath } from "../src/core/config.ts";
import { controlRequest, serveControl } from "../src/core/control.ts";
import { probeProvider } from "../src/core/availability.ts";
import { keepEvent, renderEvents } from "../src/bridge/render.ts";
import type { Config } from "../src/core/config.ts";
import type { ExecProfile, WorkerEvent } from "../src/core/types.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const event = (seq: number, type: WorkerEvent["type"], text: string): WorkerEvent => ({
  seq,
  ts: new Date().toISOString(),
  type,
  text,
});

describe("writeJsonAtomic", () => {
  it("never leaves a torn record, even when writes overlap", async () => {
    // This is the exact failure that a shared temp filename produced: two
    // in-flight writes, one rename pulling the file out from under the other.
    const file = path.join(tmp, "record.json");
    const writes = Array.from({ length: 40 }, (_, i) =>
      writeJsonAtomic(file, { n: i, filler: "x".repeat(2000) }),
    );
    await Promise.all(writes);
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { n: number };
    assert.equal(typeof parsed.n, "number");
    const leftovers = (await fsp.readdir(tmp)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "temp files must not be left behind");
  });
});

describe("readSince", () => {
  it("returns only entries after the cursor, and reports when more remain", async () => {
    const file = path.join(tmp, "journal.ndjson");
    for (let i = 1; i <= 20; i += 1) appendLine(file, event(i, "agent_message", `m${i}`));

    const first = await readSince<WorkerEvent>(file, 0, 5);
    assert.equal(first.entries.length, 5);
    assert.equal(first.entries[0]?.seq, 1);
    assert.equal(first.more, true);

    const next = await readSince<WorkerEvent>(file, 5, 100);
    assert.equal(next.entries[0]?.seq, 6);
    assert.equal(next.entries.length, 15);
    assert.equal(next.more, false);

    const none = await readSince<WorkerEvent>(file, 20, 100);
    assert.deepEqual(none.entries, []);
  });

  it("tolerates a torn final line from an in-progress append", async () => {
    const file = path.join(tmp, "torn.ndjson");
    appendLine(file, event(1, "agent_message", "complete"));
    fs.appendFileSync(file, '{"seq":2,"type":"agent_mes');
    const res = await readSince<WorkerEvent>(file, 0, 10);
    assert.equal(res.entries.length, 1);
  });

  it("returns nothing for a journal that does not exist yet", async () => {
    const res = await readSince<WorkerEvent>(path.join(tmp, "missing.ndjson"), 0, 10);
    assert.deepEqual(res.entries, []);
  });
});

describe("pidAlive", () => {
  it("is true for this process and false for a pid that cannot exist", () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(0), false);
    assert.equal(pidAlive(-1), false);
  });
});

describe("transcript filtering", () => {
  it("keeps high-signal events in every mode", () => {
    for (const mode of ["messages", "activity", "verbose"] as const) {
      assert.equal(keepEvent(event(1, "agent_message", "hi"), mode), true);
      assert.equal(keepEvent(event(2, "permission_request", "?"), mode), true);
      assert.equal(keepEvent(event(3, "error", "boom"), mode), true);
    }
  });

  it("hides activity from `messages` and status chatter from all but `verbose`", () => {
    assert.equal(keepEvent(event(1, "tool_started", "ls"), "messages"), false);
    assert.equal(keepEvent(event(1, "tool_started", "ls"), "activity"), true);
    assert.equal(keepEvent(event(1, "status", "thinking"), "activity"), false);
    assert.equal(keepEvent(event(1, "status", "thinking"), "verbose"), true);
  });

  it("advances the cursor past filtered events so they are not replayed", () => {
    // If a hidden event did not move the cursor, the next read would return the
    // same page forever whenever the newest event was one the mode hides.
    const events = [
      event(1, "status", "noise"),
      event(2, "status", "noise"),
      event(3, "status", "noise"),
    ];
    const rendered = renderEvents(events, "messages", 10_000);
    assert.equal(rendered.shown, 0);
    assert.equal(rendered.nextCursor, 3);
  });

  it("stops at the character budget and says so", () => {
    const events = Array.from({ length: 50 }, (_, i) => event(i + 1, "agent_message", "y".repeat(200)));
    const rendered = renderEvents(events, "messages", 1000);
    assert.equal(rendered.truncated, true);
    assert.ok(rendered.shown > 0 && rendered.shown < 50);
    assert.ok(rendered.nextCursor < 50, "the cursor must stop where the output stopped");
  });
});

describe("exec profiles", () => {
  const profile: ExecProfile = {
    name: "devcontainer",
    launcher: ["docker", "exec", "-i", "-w", "{cwd}", "my-container"],
    pathMap: [
      { host: "/home/me/work", target: "/workspaces" },
      { host: "/home/me/work/inner", target: "/deep" },
    ],
  };

  it("maps host paths into the target, longest prefix first", () => {
    assert.equal(toTargetPath(profile, "/home/me/work/repo"), "/workspaces/repo");
    assert.equal(toTargetPath(profile, "/home/me/work/inner/x"), "/deep/x");
    assert.equal(toTargetPath(profile, "/home/me/work"), "/workspaces");
    assert.equal(toTargetPath(profile, "/elsewhere/x"), "/elsewhere/x");
  });

  it("maps target paths back to the host", () => {
    assert.equal(toHostPath(profile, "/workspaces/repo"), "/home/me/work/repo");
    assert.equal(toHostPath(profile, "/deep/x"), "/home/me/work/inner/x");
    assert.equal(toHostPath(profile, "/unmapped"), "/unmapped");
  });

  it("substitutes {cwd} in the launcher argv", () => {
    assert.deepEqual(launcherArgv(profile, "/workspaces/repo"), [
      "docker",
      "exec",
      "-i",
      "-w",
      "/workspaces/repo",
      "my-container",
    ]);
  });

  it("rejects an unknown profile by name instead of silently running locally", () => {
    const cfg: Config = {
      execProfiles: { local: { name: "local" } },
      defaultExecProfile: "local",
      defaultModel: {},
      defaultEffort: {},
      bin: { claude: "claude", codex: "codex" },
      limits: { maxMessageChars: 100, maxTraceChars: 100, maxMessages: 10 },
      allowNestedWorkers: false,
      maxLiveWorkers: 4,
    };
    assert.throws(() => resolveExecProfile(cfg, "nope"), /unknown execProfile "nope"/);
    assert.equal(resolveExecProfile(cfg, undefined).name, "local");
  });
});

describe("login detection", () => {
  it('treats "Not logged in" as logged out, not as a match for "logged in"', async () => {
    // The substring trap: a naive includes("logged in") reports a logged-out CLI
    // as ready, and the worker only fails later, on its first turn.
    const fake = path.join(tmp, "fake-cli.sh");
    fs.writeFileSync(
      fake,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi\necho "Not logged in"; exit 1\n',
    );
    fs.chmodSync(fake, 0o755);
    const res = await probeProvider("codex", fake);
    assert.equal(res.available, false, JSON.stringify(res));
    assert.match(res.error ?? "", /not logged in/);
    assert.match(res.recovery ?? "", /codex login/);
  });

  it("accepts a logged-in CLI", async () => {
    const fake = path.join(tmp, "fake-ok.sh");
    fs.writeFileSync(
      fake,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi\necho "Logged in using ChatGPT"; exit 0\n',
    );
    fs.chmodSync(fake, 0o755);
    const res = await probeProvider("codex", fake);
    assert.equal(res.available, true, JSON.stringify(res));
  });

  it("reports a missing binary rather than guessing", async () => {
    const res = await probeProvider("claude", path.join(tmp, "definitely-not-here"));
    assert.equal(res.available, false);
    assert.match(res.error ?? "", /not runnable/);
  });
});

describe("control channel", () => {
  it("round-trips a request and a response", async () => {
    const socket = path.join(tmp, "ctl1.sock");
    const server = await serveControl(socket, async (req) => {
      assert.equal(req.op, "status");
      return { ok: true, op: "status", record: { workerId: "w1" } as never };
    });
    const res = await controlRequest(socket, { op: "status" });
    assert.equal(res.ok, true);
    server.close();
  });

  it("reports an unreachable supervisor as a recoverable error, not a crash", async () => {
    const res = await controlRequest(path.join(tmp, "nothing-here.sock"), { op: "status" }, 2000);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.code, "unreachable");
    assert.match(res.recovery ?? "", /worker_resume/);
  });

  it("reclaims a stale socket file but refuses to steal a live one", async () => {
    const socket = path.join(tmp, "ctl2.sock");
    const first = await serveControl(socket, async () => ({ ok: true, op: "status", record: {} as never }));
    await assert.rejects(
      serveControl(socket, async () => ({ ok: true, op: "status", record: {} as never })),
      /already listening/,
    );
    first.close();
    await new Promise((r) => setTimeout(r, 100));
    // The file is still there, but nothing answers on it, so it may be reclaimed.
    const second = await serveControl(socket, async () => ({ ok: true, op: "status", record: {} as never }));
    second.close();
  });

  it("answers a malformed request instead of hanging the caller", async () => {
    const socket = path.join(tmp, "ctl3.sock");
    const server = await serveControl(socket, async () => {
      throw new Error("handler blew up");
    });
    const res = await controlRequest(socket, { op: "status" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "bad_request");
    server.close();
  });
});
