/**
 * The bridge's read-side view of every worker, plus supervisor spawning.
 *
 * The bridge holds no worker state of its own. Everything it reports comes from
 * the state directory and from a liveness check, which is what lets a manager
 * restart, or a second manager attach, without losing or corrupting anything.
 *
 * Liveness is checked, never assumed: a record that still says `running` while
 * its supervisor pid is gone is reported as `orphaned`. Claiming "running" for
 * a process that no longer exists is the one failure mode that makes every
 * other guarantee worthless.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { controlRequest } from "../core/control.ts";
import { createLogger } from "../core/logger.ts";
import {
  canonical,
  ensureDirs,
  listWorkerIds,
  readRecord,
  readSince,
  supervisorAlive,
  workerPaths,
  writeJsonAtomic,
} from "../core/store.ts";
import { HIGH_SIGNAL_EVENTS, isLiveState, type WorkerEvent, type WorkerRecord } from "../core/types.ts";
import type { SupervisorSpec } from "../supervisor/spec.ts";

const log = createLogger("registry");

/** A record together with the truth about whether its process is still there. */
export type ResolvedWorker = {
  record: WorkerRecord;
  /** The supervisor process is alive AND is this worker's supervisor. */
  alive: boolean;
  /**
   * Set by {@link waitForSupervisor}: false means the deadline passed while the
   * worker was still `starting`, so nothing about it has been confirmed.
   */
  confirmed?: boolean;
};

/**
 * Load a worker and reconcile its stored state with reality.
 *
 * `orphaned` is deliberately a reported state rather than a silent repair: the
 * manager should decide whether to resume the session or abandon it.
 */
export async function resolveWorker(workerId: string): Promise<ResolvedWorker | undefined> {
  const record = await readRecord(workerId);
  if (record === undefined) return undefined;
  // Identity, not just liveness: a recycled pid would otherwise keep a dead
  // worker reporting as running indefinitely.
  const alive = supervisorAlive(record.supervisorPid, record.workerId);
  if (!alive && isLiveState(record.state)) {
    return { record: { ...record, state: "orphaned" }, alive: false };
  }
  return { record, alive };
}

/** Every worker on disk, newest first. */
export async function listWorkers(): Promise<ResolvedWorker[]> {
  const ids = await listWorkerIds();
  const resolved = await Promise.all(ids.map((id) => resolveWorker(id)));
  return resolved
    .filter((w): w is ResolvedWorker => w !== undefined)
    .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
}

/** Live workers only — the ones that occupy a slot and can be controlled. */
export async function listLiveWorkers(): Promise<ResolvedWorker[]> {
  return (await listWorkers()).filter((w) => w.alive && isLiveState(w.record.state));
}

/**
 * The directory a worker actually writes into. Two live write workers may never
 * share one, which is the whole point of the worktree machinery.
 */
export async function writeTarget(record: WorkerRecord): Promise<string> {
  return canonical(record.worktree?.path ?? record.cwd);
}

/** True when either path contains the other - they are the same write target. */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

/**
 * The live write worker already owning `dir`, if any.
 *
 * Overlap rather than equality: a worker editing `/repo` and one editing
 * `/repo/src` are writing the same files, and comparing resolved strings for
 * equality would let both start. Paths are canonicalised first so a symlink
 * alias is not a way around it.
 */
export async function findWriteConflict(dir: string, exceptWorkerId?: string): Promise<WorkerRecord | undefined> {
  const target = await canonical(dir);
  for (const worker of await listLiveWorkers()) {
    if (!worker.record.writeAccess) continue;
    if (worker.record.workerId === exceptWorkerId) continue;
    if (overlaps(await writeTarget(worker.record), target)) return worker.record;
  }
  return undefined;
}

/* ── spawning ──────────────────────────────────────────────────────────── */

/** Absolute path of the bundled supervisor entry point next to this bundle. */
function supervisorEntry(): string {
  const override = process.env["AGENT_WORKERS_SUPERVISOR"];
  if (override && override.length > 0) return path.resolve(override);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "supervisor.mjs");
}

/**
 * Write the spec and start a detached supervisor.
 *
 * `detached: true` + `unref()` is what makes the worker outlive both this MCP
 * call and the bridge process. stdio is pointed at the worker's log file rather
 * than inherited, so a bridge shutdown cannot close the supervisor's streams.
 */
export async function spawnSupervisor(spec: SupervisorSpec): Promise<{ pid: number; specPath: string }> {
  await ensureDirs(spec.workerId);
  const paths = workerPaths(spec.workerId);
  // Each attempt owns its input file. The winning supervisor alone publishes
  // spec.json after taking the worker-id lock.
  const specPath = path.join(paths.dir, `launch-${randomUUID()}.json`);
  await writeJsonAtomic(specPath, spec);

  const entry = supervisorEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(
      `supervisor bundle not found at ${entry}. Run "npm run build", or set AGENT_WORKERS_SUPERVISOR.`,
    );
  }

  const logFd = fs.openSync(paths.supervisorLog, "a", 0o600);
  fs.fchmodSync(logFd, 0o600);
  const child = spawn(process.execPath, [entry, "--spec", specPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
    cwd: os.tmpdir(),
  });
  child.unref();
  try {
    fs.closeSync(logFd);
  } catch {
    /* the child owns it now */
  }
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn the worker supervisor");
  log.info(`spawned supervisor for ${spec.workerId} (pid ${pid})`);
  return { pid, specPath };
}

/**
 * Block until the supervisor we just spawned has published a record past
 * `starting`, or the deadline passes.
 *
 * `expectedPid` is not optional detail: when a worker is being resumed there is
 * already a record on disk from the previous supervisor, and it is not in the
 * `starting` state. Without pinning the pid, this returns that stale record
 * instantly and the caller reports a resume that never actually happened.
 *
 * Returning early on failure matters more than returning fast: a worker that
 * could not authenticate should say so in the start result.
 */
export async function waitForSupervisor(
  workerId: string,
  timeoutMs: number,
  expectedPid?: number,
): Promise<ResolvedWorker | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: ResolvedWorker | undefined;
  while (Date.now() < deadline) {
    const current = await resolveWorker(workerId);
    if (current !== undefined) {
      const isOurs = expectedPid === undefined || current.record.supervisorPid === expectedPid;
      if (isOurs) {
        last = current;
        if (current.record.state !== "starting") return { ...current, confirmed: true };
      }
    }
    await delay(120);
  }
  // Deadline reached with the worker still `starting`: that is NOT a start we
  // may report as successful. The caller is told so explicitly rather than
  // being handed a record that merely looks plausible.
  return last === undefined ? undefined : { ...last, confirmed: false };
}

/**
 * Wait until a worker reaches one of `states`, a new event appears past
 * `sinceSeq`, or the deadline passes. Polling the record (rather than watching)
 * keeps this correct across filesystems where `fs.watch` is unreliable, and the
 * intervals are short enough to feel immediate.
 */
export async function waitForWorker(
  workerId: string,
  opts: {
    timeoutMs: number;
    sinceSeq?: number;
    states?: readonly string[];
    /** Only count events a manager would actually want to read. */
    messagesOnly?: boolean;
  },
): Promise<{ worker: ResolvedWorker | undefined; reason: "event" | "state" | "timeout" | "gone" }> {
  const deadline = Date.now() + opts.timeoutMs;
  const states = new Set(opts.states ?? []);
  for (;;) {
    const worker = await resolveWorker(workerId);
    if (worker === undefined) return { worker: undefined, reason: "gone" };
    if (opts.sinceSeq !== undefined && worker.record.lastSeq > opts.sinceSeq) {
      // "The worker said something" must not be satisfied by a lifecycle status
      // event - `turn started` is not a message anyone wants to read.
      if (opts.messagesOnly !== true) return { worker, reason: "event" };
      const { entries } = await readSince<WorkerEvent>(worker.record.paths.journal, opts.sinceSeq, 200);
      if (entries.some((e) => HIGH_SIGNAL_EVENTS.includes(e.type))) return { worker, reason: "event" };
    }
    if (states.size > 0 && states.has(worker.record.state)) return { worker, reason: "state" };
    if (!worker.alive && !isLiveState(worker.record.state)) return { worker, reason: "state" };
    if (Date.now() >= deadline) return { worker, reason: "timeout" };
    await delay(Math.min(250, Math.max(50, deadline - Date.now())));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Remove the socket of a worker whose supervisor is provably gone. */
export async function cleanupOrphan(record: WorkerRecord): Promise<void> {
  try {
    await fsp.rm(record.paths.socket, { force: true });
  } catch {
    /* best effort */
  }
}

/** Convenience wrapper: dial a worker's supervisor. */
export function callSupervisor(record: WorkerRecord, request: Parameters<typeof controlRequest>[1], timeoutMs?: number) {
  return controlRequest(record.paths.socket, request, timeoutMs);
}
