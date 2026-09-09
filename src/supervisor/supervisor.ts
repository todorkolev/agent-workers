/**
 * The worker supervisor: one detached process per worker.
 *
 * Why a separate process at all — the three requirements that force it:
 *
 *   1. A worker must keep working after the short MCP call that started it.
 *   2. A worker must survive the bridge being restarted (a manager reconnects
 *      by reading the journal and dialling the control socket again).
 *   3. Two managers (Claude Code and Codex) may be attached at once without
 *      clobbering each other, which is only safe if every file has exactly one
 *      writer. That writer is this process.
 *
 * Reads never come through here: managers tail `journal.ndjson` directly, so a
 * busy worker can never block a `worker_read`.
 */

import type { Server } from "node:net";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  acquireSupervisorLock,
  acquireWriteLock,
  appendLine,
  appendText,
  ensureDirs,
  readRecord,
  readJson,
  workerPaths,
  writeJsonAtomic,
  type WriteLock,
} from "../core/store.ts";
import { serveControl, type ControlRequest, type ControlResponse } from "../core/control.ts";
import { repoRoot, resolveCommit, summarizeWork } from "../core/git.ts";
import { createLogger } from "../core/logger.ts";
import type {
  ProviderAdapter,
  RespondDecision,
  SendDelivery,
  WorkerEvent,
  WorkerOwner,
  WorkerRecord,
  WorkerResult,
  WorkerState,
} from "../core/types.ts";
import { ClaudeCliAdapter } from "../providers/claude/adapter.ts";
import { CodexAppServerAdapter } from "../providers/codex/adapter.ts";
import type { SupervisorSpec } from "./spec.ts";

const log = createLogger("supervisor");

/** The highest `seq` actually written to a journal file. */
async function lastJournalSeq(file: string): Promise<number> {
  const { readSince } = await import("../core/store.ts");
  let highest = 0;
  for (;;) {
    const { entries, more } = await readSince<{ seq: number }>(file, highest, 5000);
    if (entries.length === 0) return highest;
    highest = entries[entries.length - 1]?.seq ?? highest;
    if (!more) return highest;
  }
}

/** Text queued while the worker was blocked on a decision. */
type QueuedSend = { text: string; at: string };

export class Supervisor {
  private readonly spec: SupervisorSpec;
  private readonly adapter: ProviderAdapter;
  private record: WorkerRecord;
  private server: Server | undefined;

  private seq = 0;
  private interruptRequested = false;
  private stopping = false;
  private shutdownTask: Promise<void> | undefined;
  private controlChain: Promise<unknown> = Promise.resolve();
  private readonly queued: QueuedSend[] = [];
  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();
  /** Most recent `final` text, kept for `worker_result`. */
  private lastFinal: string | undefined;
  /** Union of every file the worker touched, for `worker_result`. */
  private readonly touchedFiles = new Set<string>();
  private latestDiff: string | undefined;
  /** Tail of the serialized record-write chain (see {@link persist}). */
  private writeChain: Promise<void> = Promise.resolve();
  /** Held for the lifetime of a write worker; see {@link acquireWriteLock}. */
  private writeLock: WriteLock | undefined;
  /** Held for this process's whole life: exactly one supervisor per worker. */
  private supervisorLock: WriteLock | undefined;

  constructor(spec: SupervisorSpec) {
    this.spec = spec;
    this.adapter = spec.provider === "claude" ? new ClaudeCliAdapter() : new CodexAppServerAdapter();
    const paths = workerPaths(spec.workerId);
    this.record = {
      workerId: spec.workerId,
      provider: spec.provider,
      state: "starting",
      task: spec.task,
      ...(spec.model !== undefined ? { requestedModel: spec.model } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      cwd: spec.cwd,
      ...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}),
      writeAccess: spec.writeAccess,
      transcriptMode: spec.transcriptMode,
      execProfile: spec.execProfile,
      supervisorPid: process.pid,
      lastSeq: 0,
      pending: [],
      owner: spec.owner,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paths,
      version: spec.version,
    };
  }

  /* ── boot ────────────────────────────────────────────────────────────── */

  async run(): Promise<void> {
    await ensureDirs(this.spec.workerId);
    const own = await acquireSupervisorLock(this.spec.workerId);
    if ("heldBy" in own) {
      log.error(`another supervisor (pid ${own.heldBy.pid}) already owns worker ${this.spec.workerId}`);
      process.exit(3);
    }
    this.supervisorLock = own.lock;

    // Continue an existing worker's history rather than starting a new one on
    // top of it. The journal is append-only and `seq` is the manager's cursor:
    // restarting at 0 after a resume would append duplicate sequence numbers,
    // and every cursor the manager holds would then point at the wrong event.
    const prior = await readRecord(this.spec.workerId);
    if (prior && prior.owner.clientId !== (this.spec.expectedOwnerClientId ?? this.spec.owner.clientId)) {
      await this.supervisorLock.release();
      throw new Error("worker ownership changed before startup; read its current owner and retry explicitly");
    }
    await writeJsonAtomic(path.join(this.record.paths.dir, "spec.json"), this.spec);
    if (prior !== undefined) {
      // The journal, not the checkpoint, is the authority. Events are appended
      // before `lastSeq` is persisted, so a crash in that window leaves the
      // record behind the file - and starting from the record would reuse a
      // sequence number a manager may already hold as a cursor.
      const journalSeq = await lastJournalSeq(this.record.paths.journal);
      this.seq = Math.max(prior.lastSeq, journalSeq);
      this.record.lastSeq = this.seq;
      this.record.createdAt = prior.createdAt;
      if (this.spec.resumeSessionId !== undefined && this.record.actualModel === undefined && prior.actualModel !== undefined) {
        this.record.actualModel = prior.actualModel;
      }
      // Restore what a manager would otherwise silently lose on recovery.
      if (this.spec.resumeSessionId !== undefined) this.queued.push(...(prior.queued ?? []));
      const snapshot = await readJson<WorkerResult>(this.record.paths.result);
      if (snapshot !== undefined && this.spec.resumeSessionId !== undefined) {
        this.lastFinal = snapshot.final;
        for (const f of snapshot.changedFiles) this.touchedFiles.add(f);
      }
    }

    if (this.spec.resumeSessionId === undefined) {
      // A fresh run must never expose a stopped run's result if startup fails.
      // The worker-id lock makes this reset exclusive; the journal stays intact.
      for (const file of [this.record.paths.result, this.record.paths.final, this.record.paths.diff, this.record.paths.changedFiles]) {
        await fsp.rm(file, { force: true });
      }
    }

    // Claim the worker id first. Two concurrent resumes would otherwise both
    // probe the dead socket, both remove it, and both bind - putting two
    // processes on one provider session, one journal and one socket path.
    // Claim the directory before anything can edit it. The bridge's scan for a
    // conflicting writer happens before this process exists, so on its own it is
    // check-then-act: two starts racing each other both pass it.
    if (this.spec.writeAccess) {
      const dir = this.spec.worktree?.path ?? this.spec.cwd;
      const claim = await acquireWriteLock(dir, this.spec.workerId);
      if ("heldBy" in claim) {
        await this.fail(
          new Error(`worker "${claim.heldBy.workerId}" (pid ${claim.heldBy.pid}) is already writing in ${dir}`),
          "Give this worker its own worktree, or stop the one that holds the directory.",
        );
        return;
      }
      this.writeLock = claim.lock;
      this.record.startingHead = this.spec.resumeSessionId !== undefined ? prior?.startingHead : await resolveCommit(dir, "HEAD");
    }

    await this.persist();

    // The socket goes up FIRST: a manager that polls immediately after
    // worker_start should find a reachable supervisor even while the provider
    // session is still being established.
    this.server = await serveControl(this.record.paths.socket, (req) => this.handleControl(req));

    this.wireAdapter();

    try {
      const info =
        this.spec.resumeSessionId !== undefined
          ? await this.adapter.resume(this.spec.resumeSessionId, this.sessionOptions())
          : await this.adapter.start(this.sessionOptions());
      this.record.sessionId = info.sessionId;
      if (info.actualModel !== undefined) this.record.actualModel = info.actualModel;
    } catch (err) {
      await this.fail(err, "Check that the provider CLI is installed and logged in in the target environment.");
      return;
    }

    // The initial task is just the first turn on the new session. The worker
    // stays `starting` until that turn is under way: publishing `idle` in
    // between would let a caller waiting for idle return before the task had
    // even begun, and read an empty journal as though the work were done.
    if (this.spec.task.trim().length > 0) {
      try {
        const delivery = await this.adapter.startTurn(this.spec.task);
        this.record.turnId = delivery.turnId;
        await this.setState("running");
      } catch (err) {
        await this.fail(err);
        return;
      }
    } else {
      await this.setState("idle");
    }

    process.on("SIGTERM", () => void this.shutdown("stopped"));
    process.on("SIGINT", () => void this.shutdown("stopped"));
  }

  private sessionOptions(): Parameters<ProviderAdapter["start"]>[0] {
    return {
      workerId: this.spec.workerId,
      cwd: this.spec.cwd,
      targetCwd: this.spec.targetCwd,
      ...(this.spec.model !== undefined ? { model: this.spec.model } : {}),
      ...(this.spec.effort !== undefined ? { effort: this.spec.effort } : {}),
      writeAccess: this.spec.writeAccess,
      ...(this.spec.permissionMode !== undefined ? { permissionMode: this.spec.permissionMode } : {}),
      ...(this.spec.instructions !== undefined ? { instructions: this.spec.instructions } : {}),
      launcher: this.spec.launcher,
      env: this.spec.env,
      bin: this.spec.bin,
      ...(this.spec.allowedTools !== undefined ? { allowedTools: this.spec.allowedTools } : {}),
      ...(this.spec.disallowedTools !== undefined ? { disallowedTools: this.spec.disallowedTools } : {}),
      ...(this.spec.providerArgs !== undefined ? { providerArgs: this.spec.providerArgs } : {}),
    };
  }

  /* ── event plumbing ──────────────────────────────────────────────────── */

  private wireAdapter(): void {
    // Every raw provider message is persisted BEFORE any filtering, so a
    // surprising worker can always be diagnosed after the fact.
    this.adapter.onRaw((msg) => appendLine(this.record.paths.events, { ts: Date.now(), msg }));
    this.adapter.onStderr((line) => appendText(this.record.paths.providerLog, line));
    this.adapter.onEvent((ev) => void this.onEvent(ev));
    this.adapter.onExit((info) => void this.onProviderExit(info));
  }

  private async onEvent(ev: Omit<WorkerEvent, "seq">): Promise<void> {
    this.seq += 1;
    const event: WorkerEvent = { seq: this.seq, ...ev };
    appendLine(this.record.paths.journal, event);
    this.record.lastSeq = this.seq;
    // The adapter owns the turn id and the model actually in use; mirroring
    // both here keeps the record honest even for providers that only reveal
    // them once a turn has begun.
    this.record.turnId = this.adapter.turnId;
    const model = this.adapter.actualModel;
    if (model !== undefined) this.record.actualModel = model;

    switch (event.type) {
      case "final":
        if (event.text !== undefined) this.lastFinal = event.text;
        break;
      case "file_changed": {
        const paths = event.data?.["paths"];
        if (Array.isArray(paths)) {
          for (const p of paths) {
            if (typeof p === "string" && p.length > 0) this.touchedFiles.add(p);
          }
        }
        const single = event.data?.["path"];
        if (typeof single === "string" && single.length > 0) this.touchedFiles.add(single);
        break;
      }
      case "diff": {
        const diff = event.data?.["diff"];
        if (typeof diff === "string") this.latestDiff = diff;
        break;
      }
      case "error":
        // Keep it on the record: a turn can fail and still leave the session
        // usable, and `idle` alone would not tell the manager anything went wrong.
        if (event.text !== undefined) this.record.lastError = { message: event.text, ts: event.ts };
        break;
      case "permission_request":
      case "question":
        if (event.requestId !== undefined) {
          this.record.pending.push({
            requestId: event.requestId,
            kind: event.type === "question" ? "question" : "permission",
            text: event.text ?? "",
            ts: event.ts,
          });
          this.armApprovalTimer(event.requestId);
          await this.setState("blocked");
          return;
        }
        break;
      case "turn_completed":
        this.record.turnId = undefined;
        // An interrupt stays visible until the manager does something with the
        // worker; reporting plain `idle` would hide that work was cut short.
        await this.setState(
          this.spec.provider === "codex"
            ? (event.data?.["status"] === "interrupted" ? "interrupted" : "idle")
            : (this.interruptRequested ? "interrupted" : "idle"),
        );
        await this.snapshotResult();
        await this.drainQueue();
        return;
      default:
        break;
    }
    await this.persist();
  }

  private async onProviderExit(info: { code: number | null; signal: string | null }): Promise<void> {
    if (this.stopping) return;
    await this.fail(
      new Error(`the ${this.spec.provider} process exited unexpectedly (code=${info.code} signal=${info.signal})`),
      "Inspect provider.log in the worker directory, then use worker_resume to continue from the saved session.",
    );
  }

  /** Deliver anything the manager sent while the worker was blocked. */
  private async drainQueue(): Promise<void> {
    const next = this.queued.shift();
    this.record.queued = [...this.queued];
    if (next === undefined) return;
    try {
      const result = await this.adapter.startTurn(next.text);
      this.record.turnId = result.turnId;
      this.record.lastError = undefined;
      this.interruptRequested = false;
      await this.setState("running");
    } catch (err) {
      await this.fail(err);
    }
  }

  /* ── control ops ─────────────────────────────────────────────────────── */

  private async handleControl(request: ControlRequest): Promise<ControlResponse> {
    if (request.op === "status" || request.op === "collect") return this.applyControl(request);
    const operation = this.controlChain.then(() => this.applyControl(request));
    this.controlChain = operation.catch(() => undefined);
    return operation;
  }

  private async applyControl(request: ControlRequest): Promise<ControlResponse> {
    if (request.op === "status") return { ok: true, op: "status", record: this.record };
    if (request.op === "collect") {
      await this.snapshotResult();
      return { ok: true, op: "collect", result: await this.buildResult(), record: this.record };
    }

    const ownershipError = this.checkOwner(request);
    if (ownershipError) return ownershipError;
    if (request.owner !== undefined) {
      this.record.owner = request.owner;
      await this.persist();
    }

    switch (request.op) {
      case "send":
        return this.opSend(request.text);
      case "interrupt":
        return this.opInterrupt();
      case "stop":
        return this.opStop();
      case "resume":
        return this.opResume(request.task);
      case "respond":
        return this.opRespond(request.requestId, request.decision);
    }
  }

  /**
   * One worker has one controlling manager. A second manager can read freely
   * but must say `takeover: true` before it may steer — silent co-driving is
   * how two agents end up fighting over the same worktree.
   */
  private checkOwner(request: ControlRequest & { owner?: WorkerOwner; takeover?: boolean }): ControlResponse | undefined {
    const incoming = request.owner;
    if (incoming === undefined) return undefined;
    const current = this.record.owner;
    if (current.clientId === incoming.clientId || request.takeover === true) return undefined;
    return {
      ok: false,
      code: "not_owner",
      error: `worker "${this.record.workerId}" is controlled by ${current.host} (client ${current.clientId}, since ${current.since})`,
      recovery: "Read it freely, or repeat the call with takeover: true to take control.",
    };
  }

  private async opSend(text: string): Promise<ControlResponse> {
    if (this.isTerminal()) {
      return { ok: false, code: "terminal", error: `worker is ${this.record.state}; nothing was delivered` };
    }
    if (this.record.state === "blocked") {
      this.queued.push({ text, at: new Date().toISOString() });
      // Persisted, because the manager was told this text was accepted: losing
      // it to a crash would make that acknowledgement a lie.
      this.record.queued = [...this.queued];
      await this.persist();
      return { ok: true, op: "send", delivery: "queued_after_block", record: this.record,
        note: "The worker is waiting on a decision. Answer it with worker_respond; this text follows." };
    }
    try {
      const running = this.record.state === "running";
      const result = running
        ? await this.adapter.steer(text, this.record.turnId)
        : await this.adapter.startTurn(text);
      this.record.turnId = result.turnId ?? this.record.turnId;
      // A fresh turn supersedes the previous turn's failure.
      if (!running) this.record.lastError = undefined;
      this.interruptRequested = false;
      await this.setState("running");
      const response: ControlResponse = {
        ok: true,
        op: "send",
        delivery: result.delivery as SendDelivery,
        record: this.record,
      };
      if (result.turnId !== undefined) response.turnId = result.turnId;
      if (result.note !== undefined) response.note = result.note;
      return response;
    } catch (err) {
      return { ok: false, code: "provider_error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async opInterrupt(): Promise<ControlResponse> {
    if (this.isTerminal()) {
      return { ok: false, code: "terminal", error: `worker is ${this.record.state}` };
    }
    if (this.record.turnId === undefined) {
      return { ok: false, code: "bad_request", error: "There is no active turn to cancel; the worker is unchanged." };
    }
    this.interruptRequested = true;
    try {
      await this.adapter.interrupt();
    } catch (err) {
      this.interruptRequested = false;
      return { ok: false, code: "provider_error", error: err instanceof Error ? err.message : String(err) };
    }
    this.record.turnId = undefined;
    await this.setState("interrupted");
    return { ok: true, op: "interrupt", record: this.record };
  }

  private async opStop(): Promise<ControlResponse> {
    await this.shutdown("stopped");
    return { ok: true, op: "stop", record: this.record };
  }

  /**
   * `resume` on a live supervisor just un-sticks an interrupted worker. Restart
   * after the supervisor died is the bridge's job: it spawns a fresh supervisor
   * with `resumeSessionId` set.
   */
  private async opResume(task: string | undefined): Promise<ControlResponse> {
    if (this.isTerminal()) {
      return {
        ok: false,
        code: "terminal",
        error: `worker is ${this.record.state}; a stopped session must be resumed by starting a new supervisor`,
        recovery: "Call worker_resume, which will spawn a supervisor on the saved provider session.",
      };
    }
    if (task !== undefined && task.trim().length > 0) {
      const sent = await this.opSend(task);
      if (!sent.ok) return sent;
      return { ok: true, op: "resume", record: this.record };
    }
    this.interruptRequested = false;
    if (this.record.state === "interrupted") await this.setState("idle");
    return { ok: true, op: "resume", record: this.record };
  }

  private async opRespond(requestId: string, decision: RespondDecision): Promise<ControlResponse> {
    const index = this.record.pending.findIndex((p) => p.requestId === requestId);
    if (index < 0) {
      return { ok: false, code: "bad_request", error: `no pending request "${requestId}" on this worker` };
    }
    const entry = this.record.pending[index];
    this.clearApprovalTimer(requestId);
    try {
      await this.adapter.respond(requestId, decision);
    } catch (err) {
      this.armApprovalTimer(requestId);
      return { ok: false, code: "provider_error", error: err instanceof Error ? err.message : String(err) };
    }
    this.record.pending = this.record.pending.filter(p => p.requestId !== requestId);
    await this.onEvent({
      ts: new Date().toISOString(),
      type: "status",
      text: `manager ${decision.decision === "deny" ? "denied" : "answered"}: ${entry?.text ?? requestId}`,
      data: { requestId, decision: decision.decision },
    });
    if (this.record.pending.length === 0 && this.record.state === "blocked") await this.setState("running");
    return { ok: true, op: "respond", record: this.record };
  }

  /* ── approval timeouts ───────────────────────────────────────────────── */

  private armApprovalTimer(requestId: string): void {
    const ms = this.spec.approvalTimeoutMs;
    if (ms <= 0) return;
    const timer = setTimeout(() => {
      const timeoutOperation = this.controlChain.then(async () => {
        this.approvalTimers.delete(requestId);
        const index = this.record.pending.findIndex((p) => p.requestId === requestId);
        if (index < 0) return;
        const response = await this.opRespond(requestId, { decision: "deny", text: "no answer from the manager in time" });
        if (!response.ok) return;
        await this.onEvent({
          ts: new Date().toISOString(),
          type: "permission_denied",
          text: `denied automatically: no manager answered within ${Math.round(ms / 1000)}s`,
          data: { requestId, auto: true },
        });
      });
      this.controlChain = timeoutOperation.catch(err => log.warn("failed to process approval timeout:", err));
    }, ms);
    timer.unref?.();
    this.approvalTimers.set(requestId, timer);
  }

  private clearApprovalTimer(requestId: string): void {
    const timer = this.approvalTimers.get(requestId);
    if (timer !== undefined) clearTimeout(timer);
    this.approvalTimers.delete(requestId);
  }

  /* ── state + persistence ─────────────────────────────────────────────── */

  private isTerminal(): boolean {
    return this.record.state === "completed" || this.record.state === "failed" || this.record.state === "stopped";
  }

  private async setState(state: WorkerState): Promise<void> {
    if (this.isTerminal()) return;
    this.record.state = state;
    await this.persist();
  }

  /**
   * Serialize record writes.
   *
   * Events arrive faster than a write completes, and two overlapping writes to
   * one file are how a "single writer" quietly stops being one. Chaining them
   * keeps the on-disk record both atomic and in order.
   */
  private async persist(): Promise<void> {
    this.record.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(this.record);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await writeJsonAtomic(snapshot.paths.record, snapshot);
      } catch (err) {
        // If the worker's directory is gone, someone purged this worker. There
        // is nothing left to write to and no manager can reach us any more, so
        // continuing would leave a provider process running with no way to
        // observe or stop it.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          log.warn("worker directory has been removed; shutting down");
          this.stopping = true;
          void this.teardown();
          return;
        }
        log.error("failed to persist worker record:", err);
      }
    });
    return this.writeChain;
  }

  private async fail(err: unknown, recovery?: string): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`worker ${this.spec.workerId} failed:`, message);
    await this.onEvent({ ts: new Date().toISOString(), type: "error", text: message });
    this.record.error = { message, ...(recovery !== undefined ? { recovery } : {}) };
    this.record.state = "failed";
    await this.persist();
    await this.teardown();
  }

  private async shutdown(state: WorkerState): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    this.shutdownTask = (async () => {
      await this.adapter.dispose();
      this.record.state = state;
      await this.snapshotResult();
      await this.persist();
      await this.teardown();
    })();
    try { await this.shutdownTask; }
    catch (err) { this.shutdownTask = undefined; throw err; }
  }

  private async teardown(): Promise<void> {
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    // Ownership remains held while the child can still write.
    await this.adapter.dispose();
    try {
      this.server?.close();
    } catch {
      /* best effort */
    }
    try {
      await fsp.rm(this.record.paths.socket, { force: true });
    } catch {
      /* best effort */
    }
    for (const lock of [this.writeLock, this.supervisorLock]) await lock?.release();
    // Give the record write a moment to land before the process goes away.
    setTimeout(() => process.exit(0), 150).unref?.();
  }

  /* ── results ─────────────────────────────────────────────────────────── */

  /** Refresh the on-disk artifacts a manager collects with `worker_result`. */
  private async snapshotResult(): Promise<void> {
    const result = await this.buildResult();
    try {
      await writeJsonAtomic(this.record.paths.result, result);
      if (result.final !== undefined) await fsp.writeFile(this.record.paths.final, result.final, { encoding: "utf8", mode: 0o600 });
      if (result.changedFiles.length > 0) {
        await fsp.writeFile(this.record.paths.changedFiles, `${result.changedFiles.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      } else {
        await fsp.rm(this.record.paths.changedFiles, { force: true });
      }
    } catch (err) {
      log.warn("failed to write result artifacts:", err);
    }
  }

  private async buildResult(): Promise<WorkerResult> {
    const dir = this.record.worktree?.path ?? this.record.cwd;
    let changedFiles = [...this.touchedFiles];
    let diffStat: string | undefined;
    let commit: WorkerResult["commit"] | undefined;

    // Git is the authority for a write worker; the event stream only fills in
    // when the worker is not in a repository.
    if (this.record.writeAccess) {
      try {
        const summary = await summarizeWork(dir, this.record.startingHead);
        if (await repoRoot(dir)) changedFiles = summary.changedFiles;
        if (summary.diffStat.length > 0) diffStat = summary.diffStat;
        if (summary.commit !== undefined) commit = summary.commit;
        if (summary.diff.length > 0) {
          this.latestDiff = summary.diff;
          await fsp.writeFile(this.record.paths.diff, summary.diff, { encoding: "utf8", mode: 0o600 });
        } else if (await repoRoot(dir)) {
          this.latestDiff = undefined;
          await fsp.rm(this.record.paths.diff, { force: true });
        }
      } catch (err) {
        log.warn("failed to summarize git work:", err);
      }
    }
    if (this.latestDiff !== undefined && diffStat === undefined) {
      diffStat = `${this.latestDiff.split("\n").length} diff lines`;
    }

    return {
      workerId: this.record.workerId,
      provider: this.record.provider,
      state: this.record.state,
      ...(this.lastFinal !== undefined ? { final: this.lastFinal } : {}),
      ...(this.record.actualModel !== undefined ? { actualModel: this.record.actualModel } : {}),
      changedFiles,
      ...(commit !== undefined ? { commit } : {}),
      ...(diffStat !== undefined ? { diffStat } : {}),
      artifacts: {
        dir: this.record.paths.dir,
        journal: this.record.paths.journal,
        rawEvents: this.record.paths.events,
        providerLog: this.record.paths.providerLog,
        ...(this.lastFinal !== undefined ? { final: this.record.paths.final } : {}),
        ...(this.latestDiff !== undefined ? { diff: this.record.paths.diff } : {}),
      },
    };
  }
}
