/**
 * The bridge ↔ supervisor control channel.
 *
 * A worker outlives the MCP request that created it and outlives the bridge
 * process itself, so control cannot live in the bridge's memory. Each worker's
 * supervisor listens on a Unix domain socket; any bridge — from either host —
 * connects, sends one newline-delimited JSON request, reads one response and
 * disconnects. Reads never go through this channel: they are served from the
 * journal files directly, so a busy worker cannot block a manager's `worker_read`.
 */

import * as net from "node:net";
import * as readline from "node:readline";
import type { RespondDecision, SendDelivery, WorkerOwner, WorkerRecord, WorkerResult } from "./types.ts";

/* ── wire ──────────────────────────────────────────────────────────────── */

export type ControlRequest =
  | { op: "status" }
  | { op: "send"; text: string; owner?: WorkerOwner; takeover?: boolean }
  | { op: "interrupt"; owner?: WorkerOwner; takeover?: boolean }
  | { op: "stop"; owner?: WorkerOwner; takeover?: boolean }
  | { op: "resume"; task?: string; owner?: WorkerOwner; takeover?: boolean }
  | { op: "respond"; requestId: string; decision: RespondDecision; owner?: WorkerOwner; takeover?: boolean }
  | { op: "collect" };

export type ControlResponse =
  | { ok: true; op: "status"; record: WorkerRecord }
  | { ok: true; op: "send"; delivery: SendDelivery; turnId?: string; record: WorkerRecord; note?: string }
  | { ok: true; op: "interrupt"; record: WorkerRecord }
  | { ok: true; op: "stop"; record: WorkerRecord }
  | { ok: true; op: "resume"; record: WorkerRecord }
  | { ok: true; op: "respond"; record: WorkerRecord }
  | { ok: true; op: "collect"; result: WorkerResult; record: WorkerRecord }
  | { ok: false; error: string; code: ControlErrorCode; recovery?: string };

/**
 * `not_owner` is the only "soft" failure: it means another manager holds the
 * worker and the caller can retry with `takeover: true`.
 */
export type ControlErrorCode =
  | "not_owner"
  | "terminal"
  | "unsupported"
  | "provider_error"
  | "bad_request"
  | "unreachable";

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  readonly recovery: string | undefined;
  constructor(code: ControlErrorCode, message: string, recovery?: string) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.recovery = recovery;
  }
}

/* ── client (bridge side) ──────────────────────────────────────────────── */

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Send one control request and await its response.
 *
 * Connection failure is reported as `unreachable` rather than thrown as an
 * opaque ENOENT/ECONNREFUSED: an unreachable socket is the normal signal that a
 * supervisor died, and the caller turns it into an honest `orphaned` state.
 */
export function controlRequest(
  socketPath: string,
  request: ControlRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve) => {
    let settled = false;
    const finish = (value: ControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const unreachable = (detail: string): ControlResponse => ({
      ok: false,
      code: "unreachable",
      error: `worker supervisor is not reachable (${detail})`,
      recovery: "The supervisor process is gone. Use worker_resume to start a new one on the same session.",
    });

    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => finish(unreachable("timed out")), timeoutMs);

    socket.on("error", (err) => finish(unreachable((err as NodeJS.ErrnoException).code ?? err.message)));
    socket.on("close", () => finish(unreachable("connection closed without a response")));

    const rl = readline.createInterface({ input: socket });
    // readline re-emits its input stream's errors on the Interface. Without a
    // listener here, a stale socket - the ordinary way a dead supervisor shows
    // up - would take the whole bridge process down with an unhandled 'error'.
    rl.on("error", (err: Error) => finish(unreachable((err as NodeJS.ErrnoException).code ?? err.message)));
    rl.on("line", (line) => {
      try {
        finish(JSON.parse(line) as ControlResponse);
      } catch {
        finish({ ok: false, code: "provider_error", error: `malformed control response: ${line.slice(0, 200)}` });
      }
    });

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
  });
}

/* ── server (supervisor side) ──────────────────────────────────────────── */

export type ControlHandler = (request: ControlRequest) => Promise<ControlResponse>;

/**
 * Listen on `socketPath`. A stale socket file from a crashed supervisor is
 * removed first — but only after confirming nothing answers on it, so we can
 * never steal a live worker's socket.
 */
export async function serveControl(socketPath: string, handler: ControlHandler): Promise<net.Server> {
  await removeStaleSocket(socketPath);

  const server = net.createServer((socket) => {
    const rl = readline.createInterface({ input: socket });
    // Same hazard on the serving side: a manager that disconnects mid-request
    // must not be able to kill the worker's supervisor.
    rl.on("error", () => socket.destroy());
    rl.on("line", (line) => {
      void (async () => {
        let response: ControlResponse;
        try {
          const request = JSON.parse(line) as ControlRequest;
          response = await handler(request);
        } catch (err) {
          response = {
            ok: false,
            code: "bad_request",
            error: err instanceof Error ? err.message : String(err),
          };
        }
        try {
          socket.write(`${JSON.stringify(response)}\n`);
        } catch {
          /* client vanished */
        }
        socket.end();
      })();
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

/** Delete a leftover socket file, but only if nothing is listening on it. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  const fs = await import("node:fs/promises");
  try {
    await fs.stat(socketPath);
  } catch {
    return; // nothing there
  }
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection({ path: socketPath });
    const done = (value: boolean): void => {
      probe.destroy();
      resolve(value);
    };
    probe.on("connect", () => done(true));
    probe.on("error", () => done(false));
    setTimeout(() => done(false), 1000).unref?.();
  });
  if (alive) {
    throw new Error(`another supervisor is already listening on ${socketPath}`);
  }
  await fs.rm(socketPath, { force: true });
}
