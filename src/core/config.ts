/**
 * Configuration and execution profiles.
 *
 * Four things are kept deliberately separate, because conflating them is what
 * makes "run the worker somewhere else" turn into a special case:
 *
 *   host        — which product's MCP client is calling us (never changes behavior)
 *   provider    — claude | codex, the backend that runs the worker
 *   model/effort— per worker, forwarded verbatim to that backend
 *   exec profile— WHERE the provider process runs (this file)
 *
 * Config is merged from, in increasing precedence:
 *   1. built-in defaults
 *   2. <stateDir>/config.json
 *   3. $AGENTIC_WORKERS_CONFIG (a file path)
 *   4. .agentic-workers.json in the project directory
 *   5. environment overrides
 */

import * as path from "node:path";
import { readJson, stateDir } from "./store.ts";
import type { ExecProfile, Provider } from "./types.ts";

export type Config = {
  /** Named execution targets. `local` always exists. */
  execProfiles: Record<string, ExecProfile>;
  /** Profile used when a caller does not name one. */
  defaultExecProfile: string;
  /** Default model per provider when the caller does not pass one. */
  defaultModel: Partial<Record<Provider, string>>;
  /** Default reasoning effort per provider. */
  defaultEffort: Partial<Record<Provider, string>>;
  /** Provider executable names/paths on the manager's machine. */
  bin: Record<Provider, string>;
  /** Read budgets, in characters, for a single tool result. */
  limits: { maxMessageChars: number; maxTraceChars: number; maxMessages: number };
  /**
   * Whether a worker may itself start more workers. Off by default: "any host
   * can drive any provider" must not silently become recursive fan-out.
   */
  allowNestedWorkers: boolean;
  /** Hard ceiling on live workers per state directory. 0 disables the check. */
  maxLiveWorkers: number;
};

const BUILT_IN: Config = {
  execProfiles: { local: { name: "local" } },
  defaultExecProfile: "local",
  defaultModel: {},
  defaultEffort: {},
  bin: { claude: "claude", codex: "codex" },
  limits: { maxMessageChars: 12000, maxTraceChars: 20000, maxMessages: 200 },
  allowNestedWorkers: false,
  maxLiveWorkers: 16,
};

/** Deep-ish merge: objects merge one level, everything else is replaced. */
function merge(base: Config, patch: Partial<Config> | undefined): Config {
  if (!patch) return base;
  return {
    execProfiles: { ...base.execProfiles, ...(patch.execProfiles ?? {}) },
    defaultExecProfile: patch.defaultExecProfile ?? base.defaultExecProfile,
    defaultModel: { ...base.defaultModel, ...(patch.defaultModel ?? {}) },
    defaultEffort: { ...base.defaultEffort, ...(patch.defaultEffort ?? {}) },
    bin: { ...base.bin, ...(patch.bin ?? {}) },
    limits: { ...base.limits, ...(patch.limits ?? {}) },
    allowNestedWorkers: patch.allowNestedWorkers ?? base.allowNestedWorkers,
    maxLiveWorkers: patch.maxLiveWorkers ?? base.maxLiveWorkers,
  };
}

/** Read every config source and merge them. Never throws. */
export async function loadConfig(projectDir?: string): Promise<Config> {
  let cfg = BUILT_IN;
  cfg = merge(cfg, await readJson<Partial<Config>>(path.join(stateDir(), "config.json")));

  const explicit = process.env["AGENTIC_WORKERS_CONFIG"];
  if (explicit && explicit.length > 0) {
    cfg = merge(cfg, await readJson<Partial<Config>>(path.resolve(explicit)));
  }

  if (projectDir && projectDir.length > 0) {
    cfg = merge(cfg, await readJson<Partial<Config>>(path.join(projectDir, ".agentic-workers.json")));
  }

  const envProfile = process.env["AGENTIC_WORKERS_EXEC_PROFILE"];
  if (envProfile && envProfile.length > 0) cfg = { ...cfg, defaultExecProfile: envProfile };
  if (process.env["AGENTIC_WORKERS_ALLOW_NESTED"] === "1") cfg = { ...cfg, allowNestedWorkers: true };
  const claudeBin = process.env["AGENTIC_WORKERS_CLAUDE_BIN"];
  const codexBin = process.env["AGENTIC_WORKERS_CODEX_BIN"];
  if (claudeBin || codexBin) {
    cfg = { ...cfg, bin: { claude: claudeBin ?? cfg.bin.claude, codex: codexBin ?? cfg.bin.codex } };
  }

  return cfg;
}

/** Look up a profile by name, falling back to `local` with a clear error. */
export function resolveExecProfile(cfg: Config, name: string | undefined): ExecProfile {
  const wanted = name ?? cfg.defaultExecProfile;
  const found = cfg.execProfiles[wanted];
  if (found) return { ...found, name: wanted };
  if (wanted === "local") return { name: "local" };
  const known = Object.keys(cfg.execProfiles).join(", ") || "local";
  throw new Error(`unknown execProfile "${wanted}" (configured: ${known})`);
}

/* ── host ↔ target path translation ────────────────────────────────────── */

/**
 * Translate a manager-side absolute path into the path the provider process
 * will see. Longest matching host prefix wins so nested mappings behave.
 */
export function toTargetPath(profile: ExecProfile, hostPath: string): string {
  const abs = path.resolve(hostPath);
  const rules = [...(profile.pathMap ?? [])].sort((a, b) => b.host.length - a.host.length);
  for (const rule of rules) {
    const hostRoot = path.resolve(rule.host);
    if (abs === hostRoot) return rule.target;
    if (abs.startsWith(`${hostRoot}/`)) {
      return path.posix.join(rule.target, abs.slice(hostRoot.length + 1));
    }
  }
  return abs;
}

/** The inverse of {@link toTargetPath}: rewrite provider output back to host space. */
export function toHostPath(profile: ExecProfile, targetPath: string): string {
  const rules = [...(profile.pathMap ?? [])].sort((a, b) => b.target.length - a.target.length);
  for (const rule of rules) {
    if (targetPath === rule.target) return path.resolve(rule.host);
    if (targetPath.startsWith(`${rule.target}/`)) {
      return path.join(path.resolve(rule.host), targetPath.slice(rule.target.length + 1));
    }
  }
  return targetPath;
}

/** Build the provider argv prefix, substituting `{cwd}` with the target cwd. */
export function launcherArgv(profile: ExecProfile, targetCwd: string): string[] {
  return (profile.launcher ?? []).map((arg) => arg.replaceAll("{cwd}", targetCwd));
}

/** The provider executable to invoke inside the target environment. */
export function providerBin(cfg: Config, profile: ExecProfile, provider: Provider): string {
  return profile.bin?.[provider] ?? cfg.bin[provider];
}
