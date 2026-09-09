#!/usr/bin/env node
/**
 * A fake `claude` CLI that speaks the real streaming protocol.
 *
 * It exists so the supervisor, journal, control socket and recovery paths can be
 * tested end to end - deterministically, with no model calls. The shapes it
 * emits are the ones observed from Claude Code 2.1.263:
 *
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"text"|"tool_use",...}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
 *   {"type":"result","subtype":"success"|"error_during_execution",...}
 *   {"type":"control_response","response":{"subtype":"success","request_id":...}}
 *
 * Behaviour is driven by the text it receives, so tests can ask for a slow turn,
 * a tool call, or a crash.
 */

import * as readline from "node:readline";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("9.9.9 (Fake Claude)\n");
  process.exit(0);
}

const resumeIndex = argv.indexOf("--resume");
const sessionIndex = argv.indexOf("--session-id");
const sessionId =
  (resumeIndex >= 0 ? argv[resumeIndex + 1] : undefined) ??
  (sessionIndex >= 0 ? argv[sessionIndex + 1] : undefined) ??
  randomUUID();
const resumed = resumeIndex >= 0;

// A resumed process must look like it remembers; the store file is how this fake
// proves the supervisor really reattached to the same session.
const memory = [];
if (resumed) memory.push("RESUMED");

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let interrupted = false;
let busy = false;
const queue = [];

function init() {
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: process.env.FAKE_CLAUDE_MODEL ?? "fake-model-1",
    cwd: process.cwd(),
    tools: ["Bash", "Read"],
  });
}

async function runTurn(text) {
  busy = true;
  interrupted = false;
  init();
  memory.push(text);

  if (text.includes("CRASH")) {
    process.exit(7);
  }

  if (text.includes("SLOW")) {
    emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "sleep 30" } }] },
    });
    for (let i = 0; i < 60; i += 1) {
      if (interrupted) break;
      await sleep(200);
      // A queued message is delivered at the next tool boundary, exactly like
      // the real CLI - not instantly.
      if (queue.length > 0) break;
    }
    if (interrupted) {
      emit({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, num_turns: 1 });
      busy = false;
      drain();
      return;
    }
    emit({
      type: "user",
      message: { content: [{ tool_use_id: "tu-1", type: "tool_result", content: "slept", is_error: false }] },
    });
    const steer = queue.shift();
    if (steer !== undefined) {
      memory.push(steer);
      emit({ type: "user", message: { content: [{ type: "text", text: steer }] } });
      const answer = steer.includes("STOP") ? "STEERED" : "CONTINUED";
      emit({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
      emit({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sessionId, num_turns: 2 });
      busy = false;
      drain();
      return;
    }
  }

  if (text.includes("DENY")) {
    emit({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu-2", name: "Write", input: { file_path: "/tmp/nope.txt" } }] },
    });
    emit({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Write",
      tool_use_id: "tu-2",
      message: "Claude requested permissions to write to /tmp/nope.txt, but you have not granted it.",
    });
    emit({ type: "assistant", message: { content: [{ type: "text", text: "the write was denied" }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: "the write was denied", session_id: sessionId });
    busy = false;
    drain();
    return;
  }

  if (text.includes("RECALL")) {
    const answer = memory.filter((m) => m.startsWith("REMEMBER ")).map((m) => m.slice(9)).join(",") || "NOTHING";
    emit({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
    emit({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sessionId });
    busy = false;
    drain();
    return;
  }

  const answer = text.includes("REMEMBER ") ? "OK" : `echo:${text.slice(0, 40)}`;
  emit({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sessionId, num_turns: 1 });
  busy = false;
  drain();
}

function drain() {
  const next = queue.shift();
  if (next !== undefined) void runTurn(next);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "control_request") {
    if (msg.request?.subtype === "interrupt") {
      interrupted = true;
      emit({
        type: "control_response",
        response: { subtype: "success", request_id: msg.request_id, response: { still_queued: queue.slice() } },
      });
    } else {
      emit({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unsupported" } });
    }
    return;
  }
  if (msg.type === "user") {
    const text = (msg.message?.content ?? []).map((c) => c.text ?? "").join(" ");
    if (busy) queue.push(text);
    else void runTurn(text);
  }
});

process.stdin.on("end", () => process.exit(0));
