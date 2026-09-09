/**
 * Supervisor entry point.
 *
 * Spawned detached by the bridge as:
 *
 *   node dist/supervisor.mjs --spec <path-to-spec.json>
 *
 * stdout and stderr are redirected by the parent into the worker's
 * `supervisor.log`, so anything written here is diagnostics, never protocol.
 */

import { readJsonSync } from "../core/store.ts";
import { createLogger } from "../core/logger.ts";
import { Supervisor } from "./supervisor.ts";
import type { SupervisorSpec } from "./spec.ts";

const log = createLogger("supervisor-main");

function specPathFromArgv(argv: string[]): string | undefined {
  const index = argv.indexOf("--spec");
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const specPath = specPathFromArgv(process.argv.slice(2));
  if (specPath === undefined) {
    log.error("usage: supervisor --spec <spec.json>");
    process.exit(2);
  }
  const spec = readJsonSync<SupervisorSpec>(specPath);
  if (spec === undefined) {
    log.error(`cannot read supervisor spec at ${specPath}`);
    process.exit(2);
  }
  process.title = `agentic-worker:${spec.workerId}`;
  log.info(`starting ${spec.provider} worker ${spec.workerId} (pid ${process.pid})`);
  await new Supervisor(spec).run();
}

main().catch((err: unknown) => {
  log.error("supervisor crashed:", err);
  process.exit(1);
});
