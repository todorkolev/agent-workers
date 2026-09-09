/**
 * Compact rendering for tool results.
 *
 * The default output a manager sees is small on purpose: what the worker said,
 * what it asked, one line per command, and pointers to the files that hold
 * everything else. Full traces are available on request through `worker_trace`,
 * never by flooding a manager's context.
 */

import {
  HIGH_SIGNAL_EVENTS,
  type EventType,
  type TranscriptMode,
  type WorkerEvent,
  type WorkerRecord,
  type WorkerResult,
} from "../core/types.ts";
import type { ResolvedWorker } from "./registry.ts";

const ACTIVITY_EXTRA: readonly EventType[] = [
  "tool_started",
  "tool_completed",
  "file_changed",
  "diff",
  "plan",
  "turn_completed",
];

/** Does this event survive the given transcript mode? */
export function keepEvent(event: WorkerEvent, mode: TranscriptMode): boolean {
  if (mode === "verbose") return true;
  if (HIGH_SIGNAL_EVENTS.includes(event.type)) return true;
  if (mode === "activity") return ACTIVITY_EXTRA.includes(event.type);
  return false;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** One line per event, prefixed with its cursor position. */
export function renderEvent(event: WorkerEvent): string {
  const head = `[${event.seq}] `;
  switch (event.type) {
    case "agent_message":
      return `${head}${event.text ?? ""}`;
    case "final":
      return `${head}FINAL: ${event.text ?? ""}`;
    case "question":
      return `${head}QUESTION (requestId ${event.requestId ?? "?"}): ${event.text ?? ""}`;
    case "permission_request":
      return `${head}PERMISSION (requestId ${event.requestId ?? "?"}): ${event.text ?? ""}`;
    case "permission_denied":
      return `${head}DENIED: ${event.text ?? ""}`;
    case "error":
      return `${head}ERROR: ${event.text ?? ""}`;
    case "tool_started":
      return `${head}→ ${clip(event.text ?? "tool", 200)}`;
    case "tool_completed":
      return `${head}← ${clip(event.text ?? "done", 200)}`;
    case "file_changed":
      return `${head}~ changed: ${clip(event.text ?? "", 200)}`;
    case "diff":
      return `${head}~ ${event.text ?? "diff updated"}`;
    case "plan":
      return `${head}plan: ${clip(event.text ?? "", 200)}`;
    case "turn_completed":
      return `${head}·· ${event.text ?? "turn completed"}`;
    default:
      return `${head}· ${clip(event.text ?? event.rawType ?? event.type, 160)}`;
  }
}

/**
 * Render a page of events under a character budget. Returns the cursor the
 * caller should pass next and whether the budget (not the journal) ended it.
 */
export function renderEvents(
  events: WorkerEvent[],
  mode: TranscriptMode,
  maxChars: number,
): { text: string; nextCursor: number; shown: number; truncated: boolean } {
  const lines: string[] = [];
  let used = 0;
  let nextCursor = 0;
  let truncated = false;

  for (const event of events) {
    if (!keepEvent(event, mode)) {
      // A filtered event is still consumed: the cursor must move past it or the
      // next read would replay everything the mode hides.
      nextCursor = event.seq;
      continue;
    }
    let line = renderEvent(event);
    if (line.length > maxChars) {
      // One enormous message would otherwise consume the entire budget, or be
      // returned whole and flood the manager. Clip it and point at the file.
      line = `${line.slice(0, maxChars - 60)}\n[... clipped; the full text is in the worker's journal]`;
      truncated = true;
    }
    if (used + line.length > maxChars && lines.length > 0) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
    nextCursor = event.seq;
  }

  return { text: lines.join("\n"), nextCursor, shown: lines.length, truncated };
}

/** The one-line status header shown at the top of most tool results. */
export function renderHeader(worker: ResolvedWorker): string {
  const r = worker.record;
  const model = r.actualModel ?? r.requestedModel ?? "default model";
  const effort = r.effort !== undefined ? `, effort ${r.effort}` : "";
  const turn = r.turnId !== undefined ? ` turn=${r.turnId}` : "";
  const pending = r.pending.length > 0 ? ` pending=${r.pending.length}` : "";
  return `worker "${r.workerId}" — ${r.provider} / ${model}${effort} — state ${r.state}${turn}${pending} — seq ${r.lastSeq}`;
}

/** A short reminder of what to do next, tailored to the worker's state. */
export function renderHint(record: WorkerRecord): string {
  switch (record.state) {
    case "blocked": {
      const first = record.pending[0];
      return first
        ? `Waiting on you: ${first.kind} "${clip(first.text, 160)}" — answer with worker_respond(workerId="${record.workerId}", requestId="${first.requestId}", decision=…).`
        : "The worker is blocked on a decision.";
    }
    case "running":
      return `Still working. worker_wait(workerId="${record.workerId}", cursor=…) blocks until there is something new.`;
    case "idle":
      return record.lastError !== undefined
        ? `Idle, but its last turn failed: ${clip(record.lastError.message, 240)}\n` +
            "The session is intact - worker_send starts a fresh turn, or start a new worker with different settings."
        : `Idle with its context intact. worker_send(workerId="${record.workerId}", text=…) starts the next turn.`;
    case "interrupted":
      return `Interrupted; the session is intact. worker_send or worker_resume continues it.`;
    case "orphaned":
      return `Its supervisor process is gone. worker_resume(workerId="${record.workerId}") restarts one on the saved session${record.sessionId === undefined ? " (no session id was recorded, so a fresh session is the only option)" : ""}.`;
    case "failed":
      return record.error?.recovery ?? "The worker failed; see provider.log in its directory.";
    case "stopped":
      return `Stopped. worker_resume(workerId="${record.workerId}") reopens the saved session.`;
    case "completed":
      return `Finished. worker_result(workerId="${record.workerId}") returns the outcome.`;
    default:
      return "";
  }
}

/** The `worker_list` table. */
export function renderList(workers: ResolvedWorker[]): string {
  if (workers.length === 0) return "No workers.";
  const rows = workers.map((w) => {
    const r = w.record;
    const where = r.worktree?.path ?? r.cwd;
    return `${r.workerId}\t${r.provider}\t${r.state}\t${r.actualModel ?? r.requestedModel ?? "-"}\tseq ${r.lastSeq}\t${where}`;
  });
  return ["id\tprovider\tstate\tmodel\tcursor\tdirectory", ...rows].join("\n");
}

/** The `worker_result` body. */
export function renderResult(result: WorkerResult, record: WorkerRecord): string {
  const lines: string[] = [];
  lines.push(`worker "${result.workerId}" — ${result.provider} — state ${result.state}`);
  if (result.actualModel !== undefined) lines.push(`model actually used: ${result.actualModel}`);
  if (record.worktree !== undefined) {
    lines.push(`worktree: ${record.worktree.path} (branch ${record.worktree.branch}, base ${record.worktree.base.slice(0, 12)})`);
  }
  if (result.commit !== undefined) {
    lines.push(`commit: ${result.commit.sha.slice(0, 12)} on ${result.commit.branch} — ${result.commit.subject}`);
  }
  if (result.changedFiles.length > 0) {
    const shown = result.changedFiles.slice(0, 40);
    lines.push(`changed files (${result.changedFiles.length}):`);
    for (const f of shown) lines.push(`  ${f}`);
    if (result.changedFiles.length > shown.length) lines.push(`  … ${result.changedFiles.length - shown.length} more`);
  }
  if (result.diffStat !== undefined && result.diffStat.length > 0) lines.push(`diff: ${clip(result.diffStat, 800)}`);
  lines.push("");
  lines.push(result.final !== undefined ? `final answer:\n${result.final}` : "The worker has not produced a final answer yet.");
  lines.push("");
  lines.push("artifacts:");
  for (const [key, value] of Object.entries(result.artifacts)) lines.push(`  ${key}: ${value}`);
  return lines.join("\n");
}
