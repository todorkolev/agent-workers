/**
 * Regression tests for the Codex installer and the approval-mode edit.
 *
 * Two failures are pinned here, both of which shipped:
 *
 *  - `install-codex.sh` asked `codex mcp list` whether agent-workers was
 *    registered. That listing merges plugin-declared servers with directly
 *    registered ones, so on a machine where the plugin was installed first the
 *    row exists while no server does: the installer skipped `codex mcp add`,
 *    warned about a missing section and exited 0, having installed nothing.
 *
 *  - `ensure-codex-approval.sh` searched the whole config.toml for
 *    `default_tools_approval_mode`, so another MCP server that already set it
 *    made the installer skip the server that needed it - and a half-finished
 *    install (server registered, key missing) looked complete on a re-run.
 *
 * The codex CLI is faked (`fixtures/fake-codex-cli.mjs`), so this costs nothing
 * and still exercises the real scripts end to end.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "scripts/ensure-codex-approval.sh");
const installer = path.join(root, "scripts/install-codex.sh");
const fakeCodex = path.join(root, "test/fixtures/fake-codex-cli.mjs");
const bridge = path.join(root, "plugins/agent-workers/dist/agent-workers.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-install-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function withConfig(content: string): string {
  const file = path.join(tmp, `config-${n++}.toml`);
  fs.writeFileSync(file, content);
  return file;
}

type Run = { out: string; err: string; code: number };

/** spawnSync, not execFileSync: the advice these scripts print on a success
 *  path goes to stderr, which execFileSync only hands back when the exit code
 *  is non-zero. */
function sh(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const res = spawnSync("sh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  if (res.error !== undefined) throw res.error;
  return { out: (res.stdout ?? "").trim(), err: res.stderr ?? "", code: res.status ?? 1 };
}

function run(file: string, value?: string): Run {
  return sh([script, file, ...(value !== undefined ? [value] : [])]);
}

/** The value of default_tools_approval_mode inside the agent-workers section. */
function approvalInSection(file: string, section = "agent-workers"): string | undefined {
  let inSection = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*\[/.test(line)) {
      inSection = new RegExp(`^\\s*\\[mcp_servers\\."?${section}"?\\]\\s*$`).test(line);
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*default_tools_approval_mode\s*=\s*"?([^"\s]+)"?/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

describe("ensure-codex-approval", () => {
  it("adds the key to a freshly registered agent-workers server", () => {
    const file = withConfig(`model = "gpt-5.6-sol"

[mcp_servers.agent-workers]
command = "node"
args = ["/x/agent-workers.mjs"]
`);
    const res = run(file);
    assert.equal(res.out, "added");
    assert.equal(approvalInSection(file), "approve");
  });

  it("still adds it when a DIFFERENT server already sets the same key", () => {
    // The bug: a whole-file grep found someone else's key and skipped ours.
    const file = withConfig(`[mcp_servers.other-thing]
default_tools_approval_mode = "prompt"
command = "other"

[mcp_servers.agent-workers]
command = "node"
args = ["/x/agent-workers.mjs"]
`);
    const res = run(file);
    assert.equal(res.out, "added");
    assert.equal(approvalInSection(file), "approve");
    // And the other server's setting is untouched.
    assert.equal(approvalInSection(file, "other-thing"), "prompt");
  });

  it("repairs a half-finished install instead of reporting nothing to do", () => {
    const file = withConfig(`[mcp_servers.agent-workers]
command = "node"
args = ["/x/agent-workers.mjs"]

[mcp_servers.later]
command = "later"
`);
    assert.equal(approvalInSection(file), undefined);
    assert.equal(run(file).out, "added");
    assert.equal(approvalInSection(file), "approve");
    // The section that follows must not have absorbed the key.
    assert.equal(approvalInSection(file, "later"), undefined);
  });

  it("never overrides a policy the user chose", () => {
    const file = withConfig(`[mcp_servers.agent-workers]
default_tools_approval_mode = "prompt"
command = "node"
`);
    const res = run(file);
    assert.equal(res.out, "already-set:prompt");
    assert.equal(approvalInSection(file), "prompt");
  });

  it("is idempotent", () => {
    const file = withConfig(`[mcp_servers.agent-workers]
command = "node"
`);
    assert.equal(run(file).out, "added");
    assert.equal(run(file).out, "already-set:approve");
    const occurrences = fs.readFileSync(file, "utf8").split("default_tools_approval_mode").length - 1;
    assert.equal(occurrences, 1, "the key must not be duplicated");
  });

  it("reports a missing section rather than writing a stray key", () => {
    const file = withConfig(`model = "gpt-5.6-sol"

[mcp_servers.something-else]
command = "x"
`);
    const res = run(file);
    assert.equal(res.out, "missing-section");
    assert.equal(res.code, 1);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /default_tools_approval_mode/);
  });

  it("handles a quoted section name", () => {
    const file = withConfig(`[mcp_servers."agent-workers"]
command = "node"
`);
    assert.equal(run(file).out, "added");
    assert.equal(approvalInSection(file), "approve");
  });

  it("reports a config file that does not exist", () => {
    const res = run(path.join(tmp, "nope.toml"));
    assert.equal(res.out, "missing-section");
    assert.equal(res.code, 1);
  });

  it("keeps the config's permissions instead of handing it the umask's", () => {
    // Writing a temp file and renaming it over the config replaced 0600 with
    // whatever the umask allowed, quietly publishing a file that can hold
    // per-server environment values.
    const file = withConfig(`[mcp_servers.agent-workers]
command = "node"
`);
    fs.chmodSync(file, 0o600);
    assert.equal(run(file).out, "added");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("--check reports the policy without touching the file", () => {
    const unset = withConfig(`[mcp_servers.agent-workers]
command = "node"
`);
    const chosen = withConfig(`[mcp_servers.agent-workers]
default_tools_approval_mode = "prompt"
command = "node"
`);
    const absent = withConfig(`[mcp_servers.other]
command = "x"
`);
    const beforeUnset = fs.readFileSync(unset, "utf8");

    assert.equal(run(unset, "--check").out, "unset");
    assert.equal(run(chosen, "--check").out, "already-set:prompt");

    const missing = run(absent, "--check");
    assert.equal(missing.out, "missing-section");
    assert.equal(missing.code, 1);

    assert.equal(fs.readFileSync(unset, "utf8"), beforeUnset, "--check must not write");
  });

  it("edits through a symlinked config rather than replacing the link", () => {
    // ~/.codex/config.toml is often a link into a dotfiles repo; replacing the
    // link with a regular file detaches it from the repo it came from.
    const target = withConfig(`[mcp_servers.agent-workers]
command = "node"
`);
    const link = path.join(tmp, `link-${n++}.toml`);
    fs.symlinkSync(target, link);
    assert.equal(run(link).out, "added");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the config must still be a symlink");
    assert.equal(approvalInSection(target), "approve");
  });

  it("rejects an empty approval value rather than writing one", () => {
    const file = withConfig(`[mcp_servers.agent-workers]
command = "node"
`);
    const res = run(file, "");
    assert.equal(res.code, 2);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /default_tools_approval_mode/);
  });
});

/** A throwaway CODEX_HOME with a `codex` on PATH that behaves like 0.153.4. */
type FakeCodex = {
  config: string;
  /** Every `codex ...` invocation, in order. */
  calls: () => string[][];
  install: (args?: string[], env?: NodeJS.ProcessEnv) => Run;
  codex: (args: string[]) => Run;
  read: () => string;
};

function fakeCodexHome(config?: string): FakeCodex {
  const home = fs.mkdtempSync(path.join(tmp, "codex-home-"));
  const bin = fs.mkdtempSync(path.join(tmp, "codex-bin-"));
  const log = path.join(bin, "calls.log");
  const configFile = path.join(home, "config.toml");
  if (config !== undefined) fs.writeFileSync(configFile, config);
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeCodex)} "$@"\n`,
    { mode: 0o755 },
  );
  const env = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    CODEX_HOME: home,
    FAKE_CODEX_LOG: log,
    ...extra,
  });
  return {
    config: configFile,
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as string[])
        : [],
    install: (args = [], extra = {}) => sh([installer, ...args], env(extra)),
    codex: (args) => sh(["-c", `codex "$@"`, "sh", ...args], env({})),
    read: () => (fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : ""),
  };
}

const addCalls = (fake: FakeCodex): string[][] =>
  fake.calls().filter((call) => call[0] === "mcp" && call[1] === "add");

describe("install-codex", () => {
  it("registers the server even though `codex mcp list` already shows a plugin row", () => {
    // The exact shape of the shipped failure: plugin installed first, so the
    // listing has an unprefixed `agent-workers` row and config.toml has no
    // [mcp_servers.agent-workers] at all.
    const fake = fakeCodexHome(`model = "gpt-5.6-sol"
`);
    const listing = fake.codex(["mcp", "list"]);
    assert.equal(listing.code, 0);
    assert.match(
      listing.out,
      /^agent-workers[ \t]/m,
      "the fake must reproduce the plugin row that the old check matched",
    );

    const res = fake.install();
    assert.equal(res.code, 0, res.err);
    assert.equal(addCalls(fake).length, 1, "the missing registration must be added");
    assert.deepEqual(addCalls(fake)[0], ["mcp", "add", "agent-workers", "--", "node", bridge]);
    assert.match(fake.read(), /^\[mcp_servers\.agent-workers\]$/m);
    assert.match(fake.read(), /^model = "gpt-5\.6-sol"$/m, "unrelated settings must survive");
  });

  it("registers when there is no config file yet", () => {
    const fake = fakeCodexHome();
    assert.equal(fake.install().code, 0);
    assert.match(fake.read(), /^\[mcp_servers\.agent-workers\]$/m);
  });

  it("does not register a second time", () => {
    const fake = fakeCodexHome();
    assert.equal(fake.install().code, 0);
    const second = fake.install();
    assert.equal(second.code, 0);
    assert.match(second.out, /already registered/);
    assert.equal(addCalls(fake).length, 1, "two entries would start two bridges");
    assert.equal(fake.read().split("[mcp_servers.agent-workers]").length - 1, 1);
  });

  it("fails when `codex mcp add` fails", () => {
    const fake = fakeCodexHome(`model = "gpt-5.6-sol"\n`);
    const res = fake.install([], { FAKE_CODEX_ADD: "fail" });
    assert.notEqual(res.code, 0, "a failed registration must not exit 0");
    assert.match(res.err, /nothing was registered/);
    assert.match(res.err, /\[mcp_servers\.agent-workers\]/, "tell the user what to paste");
    assert.doesNotMatch(fake.read(), /agent-workers/);
  });

  it("fails when `codex mcp add` claims success but registers nothing", () => {
    // The other half of the trap: believing the exit status instead of the
    // config leaves an install that reports success and installs nothing.
    const fake = fakeCodexHome(`model = "gpt-5.6-sol"\n`);
    const res = fake.install([], { FAKE_CODEX_ADD: "silent" });
    assert.notEqual(res.code, 0);
    assert.match(res.err, /reported success/);
    assert.doesNotMatch(fake.read(), /agent-workers/);
  });

  it("leaves the approval policy alone by default and says how to opt in", () => {
    const fake = fakeCodexHome();
    const res = fake.install();
    assert.equal(res.code, 0, res.err);
    assert.doesNotMatch(fake.read(), /default_tools_approval_mode/, "broad pre-approval is opt-in");
    assert.match(res.out, /--approve-tools/);
  });

  it("--approve-tools pre-approves agent-workers and nothing else", () => {
    const fake = fakeCodexHome(`[mcp_servers.other-thing]
command = "other"
args = []
`);
    const res = fake.install(["--approve-tools"]);
    assert.equal(res.code, 0, res.err);
    assert.equal(approvalInSection(fake.config), "approve");
    assert.equal(
      approvalInSection(fake.config, "other-thing"),
      undefined,
      "another server's policy is not ours to set",
    );
    assert.match(fake.read(), /^command = "other"$/m, "the other server's block must survive");
  });

  it("--approve-tools keeps a policy the user already chose", () => {
    const fake = fakeCodexHome(`[mcp_servers.agent-workers]
default_tools_approval_mode = "prompt"
command = "node"
args = ["/x/agent-workers.mjs"]
`);
    const res = fake.install(["--approve-tools"]);
    assert.equal(res.code, 0, res.err);
    assert.equal(approvalInSection(fake.config), "prompt");
    assert.equal(addCalls(fake).length, 0, "already registered");
    assert.match(res.out, /Left your existing tool approval policy alone/);
  });

  it("repairs a registration whose approval key is missing", () => {
    const fake = fakeCodexHome(`[mcp_servers.agent-workers]
command = "node"
args = ["/x/agent-workers.mjs"]
`);
    const res = fake.install(["--approve-tools"]);
    assert.equal(res.code, 0, res.err);
    assert.equal(approvalInSection(fake.config), "approve");
    assert.equal(addCalls(fake).length, 0);
  });

  it("counts an inline-table registration as registered", () => {
    // Written by hand rather than by `codex mcp add`. Adding a second entry
    // would start a second bridge, so leave it alone - and say that the policy
    // could not be read rather than appending a stray key.
    const fake = fakeCodexHome(`[mcp_servers]
agent-workers = { command = "node", args = ["/x/agent-workers.mjs"] }
`);
    const res = fake.install();
    assert.equal(res.code, 0, res.err);
    assert.equal(addCalls(fake).length, 0);
    assert.match(res.err, /form this script does not/);

    const strict = fake.install(["--approve-tools"]);
    assert.notEqual(strict.code, 0, "a policy we were asked for and could not set is a failure");
    assert.doesNotMatch(fake.read(), /default_tools_approval_mode/);
  });

  it("rejects an unknown option instead of installing something else", () => {
    const fake = fakeCodexHome();
    const res = fake.install(["--approve-everything"]);
    assert.equal(res.code, 2);
    assert.match(res.err, /unknown option/);
    assert.equal(fake.calls().length, 0);
  });
});
