/** One read-only process, one deadline, one bounded result. No model polling. */
import { parseArgs } from "node:util";
import { compileWakeRegex, resolveWorker, waitForWorker } from "./registry.ts";
import { WORKER_ID_PATTERN } from "../core/store.ts";
import type { WorkerEvent } from "../core/types.ts";

declare const __AGENT_WORKERS_VERSION__: string;

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const summarize = (event?: WorkerEvent) => event && ({
  seq: event.seq, type: event.type, text: event.text?.slice(0, 800),
  requestId: event.requestId, turnId: event.turnId,
});

try {
  const { values } = parseArgs({ options: {
    worker: { type: "string" }, cursor: { type: "string" }, deadline: { type: "string" },
    "turn-id": { type: "string" }, help: { type: "boolean" }, version: { type: "boolean" },
    "wake-regex": { type: "string", multiple: true }, "wake-flags": { type: "string" },
  } });
  if (values.help) {
    console.log("Usage: node worker-watch.mjs --worker ID --cursor N --deadline ISO8601 [--turn-id ID]\n" +
      "  [--wake-regex SOURCE ...] [--wake-flags FLAGS]\n" +
      "Expressions are JavaScript regex sources (no / delimiters), ORed against each normalized\n" +
      "event's text. Flags default to m. Lifecycle/decision/error signals always remain enabled.\n" +
      "Run beside the supervisor, with the same AGENT_WORKERS_HOME. Waits silently for attention,\n" +
      "worker/turn change or the absolute deadline. Outputs one JSON object; never acknowledges\n" +
      "transcripts or controls workers. Exit 0: observation (not task success); 1: inspection error; 130: cancelled.");
  } else if (values.version) {
    console.log(__AGENT_WORKERS_VERSION__);
  } else {
    const workerId = values.worker ?? "";
    const cursor = Number(values.cursor);
    const deadline = Date.parse(values.deadline ?? "");
    if (!WORKER_ID_PATTERN.test(workerId) || !/^\d+$/.test(values.cursor ?? "") || !Number.isSafeInteger(cursor) ||
        !Number.isFinite(deadline) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(values.deadline ?? "")) {
      throw new Error("Required: --worker valid-id --cursor nonnegative-integer --deadline ISO8601-with-timezone. See --help.");
    }
    const wakeRegex = compileWakeRegex(values["wake-regex"], values["wake-flags"]);
    const initial = await resolveWorker(workerId);
    const outcome = await waitForWorker(workerId, {
      timeoutMs: Math.max(0, deadline - Date.now()), sinceSeq: cursor, attentionOnly: true,
      expectedSupervisorPid: initial?.record.supervisorPid,
      expectedTurnId: values["turn-id"] ?? initial?.record.turnId,
      states: ["idle", "blocked", "interrupted", "completed", "failed", "stopped", "orphaned"],
      signal: controller.signal, pollMs: 1000,
      wakeRegex,
    });
    const record = outcome.worker?.record;
    console.log(JSON.stringify({
      workerId, reason: outcome.reason === "timeout" ? "deadline" : outcome.reason,
      state: record?.state, supervisorPid: record?.supervisorPid, turnId: record?.turnId,
      readFromCursor: cursor, observedSeq: record?.lastSeq, deadline: new Date(deadline).toISOString(),
      event: summarize(outcome.event), lastActivity: summarize(outcome.lastEvent),
      matchedRegex: outcome.matchedRegex,
      pendingDecisions: record?.pending.length, journal: record?.paths.journal,
    }));
  }
} catch (error) {
  console.log(JSON.stringify({ reason: controller.signal.aborted ? "cancelled" : "error", message: String(error).slice(0, 800) }));
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
