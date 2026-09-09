/**
 * Git worktree isolation for write-capable workers.
 *
 * A worker that can edit files gets its own worktree so no two agents ever
 * write into the same checkout. The rule the registry enforces on top of this
 * is simple and absolute: **one live write worker per directory.**
 *
 * Adoption matters as much as creation. If the caller already made the worktree
 * (or wants a specific existing branch), we attach to it and do NOT try to
 * create the branch again — creating a branch that already exists is the classic
 * "a branch named … already exists" failure.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type GitResult = { stdout: string; stderr: string; code: number };

/** Run a git command, never throwing; the caller inspects `code`. */
export async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

/** The repository root containing `dir`, or undefined when it is not a repo. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  const res = await git(dir, ["rev-parse", "--show-toplevel"]);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/** Resolve a committish to a full sha, or undefined when it does not exist. */
export async function resolveCommit(dir: string, ref: string): Promise<string | undefined> {
  const res = await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

export type WorktreeRequest = {
  /** Repository the worktree is cut from. */
  repo: string;
  workerId: string;
  /** Exact git base for the new branch. Defaults to HEAD. */
  base?: string;
  /** Explicit worktree directory. Defaults to <repo>/.worktrees/aw-<workerId>. */
  dir?: string;
  /** Explicit branch name. Defaults to agent/<workerId>. */
  branch?: string;
};

export type WorktreeInfo = { path: string; branch: string; base: string; created: boolean };

/**
 * Ensure a usable worktree exists, creating it only when it does not.
 *
 * Four cases, in order:
 *   1. the directory is already a worktree → adopt it, report `created: false`
 *   2. the branch already exists           → add a worktree on that branch
 *   3. neither exists                      → create branch + worktree from `base`
 *   4. anything else                       → throw with git's own message
 */
export async function ensureWorktree(req: WorktreeRequest): Promise<WorktreeInfo> {
  const repo = req.repo;
  const branch = req.branch ?? `agent/${req.workerId}`;
  const dir = path.resolve(req.dir ?? path.join(repo, ".worktrees", `aw-${req.workerId}`));
  const baseRef = req.base ?? "HEAD";

  const baseSha = await resolveCommit(repo, baseRef);
  if (baseSha === undefined) {
    throw new Error(`git base "${baseRef}" does not resolve to a commit in ${repo}`);
  }

  // 1. Already a worktree? Adopt it exactly as-is.
  const existing = await worktreeAt(repo, dir);
  if (existing !== undefined) {
    return { path: dir, branch: existing, base: baseSha, created: false };
  }

  const dirExists = await pathExists(dir);
  if (dirExists) {
    throw new Error(
      `${dir} already exists but is not a git worktree. Remove it, or pass an explicit worktree path.`,
    );
  }

  await fs.mkdir(path.dirname(dir), { recursive: true });

  // 2. Branch exists → attach a worktree to it without re-creating the branch.
  const branchExists = (await git(repo, ["rev-parse", "--verify", `refs/heads/${branch}`])).code === 0;
  const args = branchExists
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", dir, "-b", branch, baseSha];

  const res = await git(repo, args, 120_000);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`);
  }
  await excludeFromRepo(repo, dir);
  return { path: dir, branch, base: baseSha, created: !branchExists };
}

/**
 * Keep a worktree we created inside the repository from dirtying the main
 * checkout's `git status`.
 *
 * Isolation that leaves `?? .worktrees/` behind is not isolation - the next
 * person to run `git status` or `git add -A` sees, and can commit, our
 * scaffolding. The exclusion goes in `.git/info/exclude`, which is local and
 * untracked, so we never edit a file the user has committed.
 */
async function excludeFromRepo(repo: string, worktreeDir: string): Promise<void> {
  const relative = path.relative(repo, worktreeDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return; // outside the repo
  const topSegment = relative.split(path.sep)[0];
  if (topSegment === undefined || topSegment.length === 0) return;
  const entry = `${topSegment}/`;

  const gitDir = await git(repo, ["rev-parse", "--git-common-dir"]);
  if (gitDir.code !== 0) return;
  const excludeFile = path.resolve(repo, gitDir.stdout.trim(), "info", "exclude");
  try {
    let current = "";
    try {
      current = await fs.readFile(excludeFile, "utf8");
    } catch {
      await fs.mkdir(path.dirname(excludeFile), { recursive: true });
    }
    if (current.split("\n").some((line) => line.trim() === entry.trim())) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await fs.appendFile(
      excludeFile,
      `${prefix}# added by agent-workers: worker worktrees\n${entry}\n`,
      "utf8",
    );
  } catch {
    // A read-only .git is unusual but not a reason to fail the worker.
  }
}

/** The branch checked out in `dir`, when `dir` is a worktree of `repo`. */
async function worktreeAt(repo: string, dir: string): Promise<string | undefined> {
  const res = await git(repo, ["worktree", "list", "--porcelain"]);
  if (res.code !== 0) return undefined;
  let current: string | undefined;
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = path.resolve(line.slice("worktree ".length).trim());
    else if (line.startsWith("branch ") && current === path.resolve(dir)) {
      return line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/* ── result collection ─────────────────────────────────────────────────── */

export type WorkSummary = {
  changedFiles: string[];
  diff: string;
  diffStat: string;
  commit?: { sha: string; subject: string; branch: string };
};

/**
 * Summarize what a worker did in its directory: uncommitted changes against the
 * base, plus the last commit when the worker committed its own work.
 */
export async function summarizeWork(dir: string, base: string | undefined): Promise<WorkSummary> {
  const empty: WorkSummary = { changedFiles: [], diff: "", diffStat: "" };
  const root = await repoRoot(dir);
  if (root === undefined) return empty;

  // Include untracked files so a brand-new file is never invisible in the diff.
  await git(dir, ["add", "-AN"]);

  const range = base !== undefined ? [base] : [];
  const nameOnly = await git(dir, ["diff", "--name-only", ...range]);
  const stat = await git(dir, ["diff", "--stat", ...range]);
  const patch = await git(dir, ["diff", ...range]);

  const changedFiles = nameOnly.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

  const summary: WorkSummary = {
    changedFiles,
    diff: patch.stdout,
    diffStat: stat.stdout.trim(),
  };

  const head = await git(dir, ["log", "-1", "--pretty=%H%x00%s"]);
  const branchRes = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.code === 0 && head.stdout.includes("\0")) {
    const [sha, subject] = head.stdout.trim().split("\0");
    // Only report a commit when the worker actually moved HEAD past its base.
    if (sha !== undefined && sha !== base) {
      summary.commit = {
        sha,
        subject: subject ?? "",
        branch: branchRes.code === 0 ? branchRes.stdout.trim() : "",
      };
    }
  }
  return summary;
}
