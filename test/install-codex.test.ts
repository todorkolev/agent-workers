/**
 * Regression tests for the Codex approval-mode edit.
 *
 * The first version searched the whole config.toml for
 * `default_tools_approval_mode`, so another MCP server that already set it made
 * the installer skip the server that needed it - and a half-finished install
 * (server registered, key missing) looked complete on a re-run. Both are
 * covered here, without spawning the codex CLI.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "scripts/ensure-codex-approval.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aw-install-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function withConfig(content: string): string {
  const file = path.join(tmp, `config-${n++}.toml`);
  fs.writeFileSync(file, content);
  return file;
}

function run(file: string, value?: string): { out: string; code: number } {
  try {
    const out = execFileSync("sh", [script, file, ...(value !== undefined ? [value] : [])], {
      encoding: "utf8",
    });
    return { out: out.trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { out: (e.stdout ?? "").trim(), code: e.status ?? 1 };
  }
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
});
