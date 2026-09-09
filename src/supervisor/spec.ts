/**
 * The hand-off contract between the bridge and a worker supervisor.
 *
 * The bridge writes one of these to disk and spawns the supervisor detached, so
 * a worker's whole definition survives the MCP request that created it — and
 * survives the bridge itself.
 */

import type { Provider, TranscriptMode, WorkerOwner } from "../core/types.ts";

export type SupervisorSpec = {
  workerId: string;
  provider: Provider;
  task: string;
  cwd: string;
  /** `cwd` as the provider process will see it (differs under a launcher). */
  targetCwd: string;
  model?: string;
  effort?: string;
  writeAccess: boolean;
  permissionMode?: string;
  instructions?: string;
  transcriptMode: TranscriptMode;
  execProfile: string;
  launcher: string[];
  env: Record<string, string>;
  bin: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  providerArgs?: string[];
  worktree?: { path: string; branch: string; base: string; created: boolean };
  owner: WorkerOwner;
  /** Owner observed by the bridge; checked again under the worker-id lock. */
  expectedOwnerClientId?: string;
  version: string;
  /** Set to re-attach to an existing provider session instead of creating one. */
  resumeSessionId?: string;
  /**
   * How long a `permission_request` or `question` may sit unanswered before the
   * supervisor denies it so the worker is not wedged forever. 0 = wait forever.
   */
  approvalTimeoutMs: number;
};
