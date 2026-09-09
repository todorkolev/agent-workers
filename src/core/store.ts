/**
 * On-disk layout, atomic writes and append-only journals.
 *
 * The state directory is shared by every manager on the machine, so the
 * concurrency rule is deliberately blunt: **each file has exactly one writer.**
 * A worker's supervisor owns that worker's directory; bridges only read from it
 * and talk to the supervisor over its control socket. There is no shared
 * mutable registry file for two hosts to clobber.
 *
 *   <stateDir>/
 *     workers/<workerId>/
 *       worker.json         record snapshot   (written by the supervisor only)
 *       journal.ndjson      normalized events (append-only)
 *       events.ndjson       raw provider messages (append-only)
 *       provider.log        provider stderr
 *       supervisor.log      supervisor stdout+stderr
 *       result.json / final.md / diff.patch / changed-files.txt
 *     sockets/<hash>.sock   control sockets (kept short for sun_path limits)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { createHash } from "node:crypto";
import type { WorkerPaths, WorkerRecord } from "./types.ts";

/** Root of all worker state. Override with `AGENT_WORKERS_HOME`. */
export function stateDir(): string {
  const fromEnv = process.env["AGENT_WORKERS_HOME"];
  if (fromEnv && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".agent-workers");
}

/**
 * Directory for control sockets. Unix `sun_path` is limited to ~108 bytes, so
 * sockets never live inside the (possibly deep) worker directory.
 */
export function socketDir(): string {
  const runtime = process.env["XDG_RUNTIME_DIR"];
  const base = runtime && runtime.length > 0 ? path.join(runtime, "agent-workers") : path.join(stateDir(), "sockets");
  // Fall back to /tmp if even the base is already too long to hold a socket.
  return base.length > 80 ? path.join(os.tmpdir(), `agent-workers-${process.getuid?.() ?? 0}`) : base;
}

/** Absolute path of a worker's directory. */
export function workerDir(workerId: string): string {
  return path.join(stateDir(), "workers", workerId);
}

/** Every artifact path for one worker. */
export function workerPaths(workerId: string): WorkerPaths {
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
    socket: path.join(socketDir(), `${hash}.sock`),
  };
}

/** Create the state directories. Sockets are only readable by the owner. */
export async function ensureDirs(workerId?: string): Promise<void> {
  await fsp.mkdir(path.join(stateDir(), "workers"), { recursive: true });
  await fsp.mkdir(socketDir(), { recursive: true, mode: 0o700 });
  if (workerId !== undefined) await fsp.mkdir(workerDir(workerId), { recursive: true });
}

/* ── atomic json ───────────────────────────────────────────────────────── */

let tmpCounter = 0;

/**
 * Write JSON via a temp file + rename so a reader never observes a half-written
 * record.
 *
 * The temp name is unique per call, not just per process: two overlapping
 * writes from the same writer would otherwise share one temp path, and the
 * first rename would pull the file out from under the second - producing
 * exactly the torn record this function exists to prevent.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Read JSON, returning `undefined` for a missing or malformed file. */
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Synchronous variant, used on the supervisor's crash path. */
export function readJsonSync<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/* ── append-only journals ──────────────────────────────────────────────── */

/**
 * Append one JSON line. `fs.appendFileSync` with a single write of a line that
 * ends in `\n` is atomic enough for our single-writer-per-file rule and keeps
 * event ordering identical to the order the supervisor observed.
 */
export function appendLine(file: string, value: unknown): void {
  let line: string;
  try {
    line = `${JSON.stringify(value)}\n`;
  } catch {
    line = `${JSON.stringify({ unserializable: String(value) })}\n`;
  }
  try {
    fs.appendFileSync(file, line, "utf8");
  } catch {
    /* never let journaling kill the worker */
  }
}

/** Append a raw text line (provider stderr, supervisor diagnostics). */
export function appendText(file: string, text: string): void {
  try {
    fs.appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * Stream an NDJSON journal and yield the entries whose `seq` is greater than
 * `sinceSeq`, stopping once `maxEntries` is reached.
 *
 * Streaming (rather than reading the whole file) keeps memory flat for long
 * runs, and tolerates a torn final line — the supervisor may be mid-append.
 */
export async function readSince<T extends { seq: number }>(
  file: string,
  sinceSeq: number,
  maxEntries: number,
): Promise<{ entries: T[]; more: boolean }> {
  const entries: T[] = [];
  let more = false;
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch {
    return { entries, more };
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      let parsed: T;
      try {
        parsed = JSON.parse(line) as T;
      } catch {
        continue; // torn or partially flushed final line
      }
      if (typeof parsed.seq !== "number" || parsed.seq <= sinceSeq) continue;
      if (entries.length >= maxEntries) {
        more = true;
        break;
      }
      entries.push(parsed);
    }
  } catch {
    /* file vanished mid-read; return what we have */
  } finally {
    rl.close();
    stream.destroy();
  }
  return { entries, more };
}

/* ── worker discovery ──────────────────────────────────────────────────── */

/** Ids of every worker directory currently on disk. */
export async function listWorkerIds(): Promise<string[]> {
  try {
    const dirents = await fsp.readdir(path.join(stateDir(), "workers"), { withFileTypes: true });
    return dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/** Load one worker's persisted record. */
export async function readRecord(workerId: string): Promise<WorkerRecord | undefined> {
  return readJson<WorkerRecord>(workerPaths(workerId).record);
}

/** True when a process with this pid exists and we may signal it. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove a worker's directory and socket. Used by `worker_stop --purge`. */
export async function purgeWorker(workerId: string): Promise<void> {
  const paths = workerPaths(workerId);
  await fsp.rm(paths.dir, { recursive: true, force: true });
  await fsp.rm(paths.socket, { force: true });
}
