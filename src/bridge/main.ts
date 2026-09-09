/**
 * The agent-workers MCP bridge.
 *
 * One stdio MCP server, installed into Claude Code and into Codex from the same
 * repository, exposing the same `worker_*` tools to both. The bridge itself is
 * thin and holds no worker state: workers live in detached supervisor processes
 * under the state directory, so the same tools keep working across a bridge
 * restart and two managers can be attached at once.
 *
 * stdout belongs to the MCP protocol. Every diagnostic goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import { createLogger } from "../core/logger.ts";
import { ensureDirs, stateDir } from "../core/store.ts";
import type { HostKind } from "../core/types.ts";
import {
  deriveClientId,
  listSchema,
  readSchema,
  respondSchema,
  resumeSchema,
  sendSchema,
  startSchema,
  stopSchema,
  traceSchema,
  waitSchema,
  workerIdSchema,
  workerInterrupt,
  workerList,
  workerRead,
  workerRespond,
  workerResult,
  workerResume,
  workerSend,
  workerStart,
  workerStatus,
  workerStop,
  workerTrace,
  workerWait,
  type ToolContext,
  type ToolOutput,
} from "./tools.ts";

declare const __AGENT_WORKERS_VERSION__: string;
const VERSION = typeof __AGENT_WORKERS_VERSION__ === "string" ? __AGENT_WORKERS_VERSION__ : "0.0.0-dev";

const log = createLogger("bridge");

/**
 * Which product is driving us. Detected from the environment the host sets
 * around its plugins; only used for ownership bookkeeping and diagnostics, so a
 * wrong guess degrades to `unknown` rather than changing any behavior.
 */
function detectHost(): HostKind {
  if (process.env["CLAUDE_PLUGIN_ROOT"] || process.env["CLAUDE_PROJECT_DIR"] || process.env["CLAUDECODE"]) {
    return "claude-code";
  }
  if (process.env["CODEX_HOME"] || process.env["CODEX_PLUGIN_ROOT"] || process.env["CODEX_SANDBOX"]) {
    return "codex";
  }
  return "unknown";
}

/** The project the manager is working in; workers default to it. */
function detectProjectDir(): string {
  const candidates = [
    process.env["AGENT_WORKERS_PROJECT_DIR"],
    process.env["CLAUDE_PROJECT_DIR"],
    process.env["CODEX_PROJECT_DIR"],
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.length > 0) return path.resolve(candidate);
  }
  return process.cwd();
}

/** Wrap a tool implementation into the MCP content envelope. */
function toResult(output: ToolOutput): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: output.text }],
    ...(output.isError === true ? { isError: true } : {}),
  };
}

async function main(): Promise<void> {
  await ensureDirs();

  const host = detectHost();
  const projectDir = detectProjectDir();
  const ctx: ToolContext = {
    version: VERSION,
    host,
    clientId: deriveClientId(host, projectDir),
    projectDir,
  };

  log.info(`agent-workers ${VERSION} | host=${host} | project=${projectDir} | state=${stateDir()}`);

  const server = new McpServer(
    { name: "agent-workers", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Persistent, interactive Claude and Codex workers.\n\n" +
        "A worker is a long-lived provider session you can talk to while it works: read its output with " +
        "worker_read, block for the next thing with worker_wait, send guidance with worker_send, cut a turn " +
        "short with worker_interrupt, answer its questions with worker_respond, and collect the outcome with " +
        "worker_result. Workers survive this bridge restarting.\n\n" +
        "Two things to keep in mind. First, worker_send reports how the text was actually delivered: Codex " +
        "steers it into the running turn, Claude queues it for the turn's next tool boundary - do not assume " +
        "either was read. Second, a worker that can write files should get its own git worktree (worktree: " +
        "true); two writers in one directory are refused.",
    },
  );

  const register = <S extends Record<string, unknown>>(
    name: string,
    description: string,
    schema: S,
    handler: (ctx: ToolContext, input: never) => Promise<ToolOutput>,
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean },
  ): void => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema as never,
        ...(annotations !== undefined ? { annotations } : {}),
      },
      (async (input: never) => toResult(await handler(ctx, input))) as never,
    );
  };

  register(
    "worker_start",
    "Start a persistent worker on a Claude or Codex session and give it its first instruction. " +
      "Returns a durable workerId immediately; the worker keeps going after this call returns. " +
      "Use worktree: true with writeAccess: true so it edits an isolated checkout.",
    startSchema,
    workerStart,
  );

  register(
    "worker_read",
    "Read what a worker has produced since a cursor. Returns only new events, bounded in size, with the " +
      "next cursor and whether more is waiting. Cheap to call repeatedly - it never replays what you read.",
    readSchema,
    workerRead,
    { readOnlyHint: true },
  );

  register(
    "worker_wait",
    "Block until a worker produces something new, asks a question, changes state, or the timeout expires. " +
      "Does not return the output itself - follow it with worker_read from the same cursor.",
    waitSchema,
    workerWait,
    { readOnlyHint: true },
  );

  register(
    "worker_send",
    "Send guidance to a worker, whether it is working or idle. The result states how it was delivered: " +
      "steered into the running Codex turn, queued for the running Claude turn (delivered at its next tool " +
      "boundary, no read receipt), or started as a new turn on an idle worker.",
    sendSchema,
    workerSend,
  );

  register(
    "worker_interrupt",
    "Cancel the worker's current turn while keeping its session and history. Unlike worker_stop, the worker " +
      "stays alive and can be continued immediately with worker_send.",
    workerIdSchema,
    workerInterrupt,
  );

  register(
    "worker_respond",
    "Answer a permission_request or question event from a worker, using the requestId it reported.",
    respondSchema,
    workerRespond,
  );

  register(
    "worker_resume",
    "Continue a worker whose supervisor died, or that was stopped or interrupted, reattaching to the same " +
      "provider session so its context is preserved.",
    resumeSchema,
    workerResume,
  );

  register(
    "worker_result",
    "Collect a worker's outcome: its final answer, the files it changed, any commit, a diff summary, and " +
      "the paths of its artifacts.",
    workerIdSchema,
    workerResult,
    { readOnlyHint: true },
  );

  register(
    "worker_status",
    "Full status of one worker, including whether its supervisor process is genuinely alive, which model it " +
      "actually used, who controls it, and any decision it is waiting on.",
    workerIdSchema,
    workerStatus,
    { readOnlyHint: true },
  );

  register("worker_list", "List known workers with their provider, state, model and directory.", listSchema, workerList, {
    readOnlyHint: true,
  });

  register(
    "worker_stop",
    "End a worker for good: its provider process is killed. Journals and artifacts are kept unless purge is " +
      "set. Use worker_interrupt instead when you only want to stop the current turn.",
    stopSchema,
    workerStop,
    { destructiveHint: true },
  );

  register(
    "worker_trace",
    "The unfiltered normalized journal plus the paths of the raw provider event log and stderr. For " +
      "debugging a worker that behaved unexpectedly.",
    traceSchema,
    workerTrace,
    { readOnlyHint: true },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("connected on stdio");
}

main().catch((err: unknown) => {
  log.error("bridge failed to start:", err);
  process.exit(1);
});
