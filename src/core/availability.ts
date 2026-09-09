/**
 * "Can this provider actually run right now?" probes.
 *
 * These run before a worker is started so a missing CLI or a missing login is
 * reported as a clear, actionable failure instead of a worker that starts and
 * then dies. They never throw and never block for long.
 */

import { execFile } from "node:child_process";
import type { Provider, ProviderAvailability } from "./types.ts";

type Run = { stdout: string; stderr: string; code: number | null };

function run(argv: string[], timeoutMs: number): Promise<Run> {
  return new Promise<Run>((resolve) => {
    const command = argv[0];
    if (command === undefined) {
      resolve({ stdout: "", stderr: "empty argv", code: null });
      return;
    }
    const child = execFile(
      command,
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? null : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
    child.on("error", () => resolve({ stdout: "", stderr: "spawn failed", code: null }));
  });
}

/**
 * Probe one provider. `launcher` lets the probe run inside the same target the
 * workers will use, so "it works on the host" never masks "it is missing in the
 * container".
 */
export async function probeProvider(
  provider: Provider,
  bin: string,
  launcher: string[] = [],
): Promise<ProviderAvailability> {
  if (provider === "claude") return probeClaude(bin, launcher);
  return probeCodex(bin, launcher);
}

async function probeClaude(bin: string, launcher: string[]): Promise<ProviderAvailability> {
  const version = await run([...launcher, bin, "--version"], 20_000);
  if (version.code !== 0) {
    return {
      provider: "claude",
      available: false,
      error: "the claude CLI is not runnable",
      recovery: `Install Claude Code and make sure "${bin}" is on PATH${launcher.length ? " inside the target environment" : ""}.`,
    };
  }
  // There is no cheap offline way to assert an OAuth login without spending a
  // request, so we report what is knowable and let the first turn confirm the
  // rest. What we CAN flag is the case that silently changes who pays.
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const auth =
    apiKey && apiKey.length > 0
      ? "ANTHROPIC_API_KEY is set in the environment — workers may bill the API instead of your subscription"
      : "the CLI's own login (confirmed on the worker's first turn)";
  return { provider: "claude", available: true, version: version.stdout.trim(), auth };
}

async function probeCodex(bin: string, launcher: string[]): Promise<ProviderAvailability> {
  const version = await run([...launcher, bin, "--version"], 20_000);
  if (version.code !== 0) {
    return {
      provider: "codex",
      available: false,
      error: "the codex CLI is not runnable",
      recovery: `Install the Codex CLI and make sure "${bin}" is on PATH${launcher.length ? " inside the target environment" : ""}.`,
    };
  }
  const login = await run([...launcher, bin, "login", "status"], 20_000);
  const combined = `${login.stdout}\n${login.stderr}`.toLowerCase();
  const loggedIn = login.code === 0 || combined.includes("logged in");
  if (!loggedIn) {
    return {
      provider: "codex",
      available: false,
      version: version.stdout.trim(),
      error: "the codex CLI is not logged in",
      recovery: "Run `codex login` in the environment where the workers run.",
    };
  }
  return {
    provider: "codex",
    available: true,
    version: version.stdout.trim(),
    auth: login.stdout.trim() || "logged in",
  };
}
