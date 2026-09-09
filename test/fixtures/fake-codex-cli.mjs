#!/usr/bin/env node
/**
 * A stand-in for the `codex` CLI, as far as `scripts/install-codex.sh` uses it.
 *
 * The behaviour that matters is the one that broke the installer: `codex mcp
 * list` on codex-cli 0.153.4 merges plugin-declared MCP servers with directly
 * registered ones into a single table, and the plugin's row is spelled
 * `agent-workers` exactly like a registered one. Install the plugin first and
 * the listing advertises a server that `config.toml` does not declare and that
 * Codex never launches.
 *
 * So this fake keeps the two sources apart: the listing is
 * `[mcp_servers.*]` sections in $CODEX_HOME/config.toml *plus* a plugin row,
 * while only `mcp add` writes a section.
 *
 * Environment:
 *   CODEX_HOME             required; config.toml lives here
 *   FAKE_CODEX_LOG         append one JSON argv array per invocation
 *   FAKE_CODEX_PLUGIN_ROW  "0" drops the plugin-contributed agent-workers row
 *   FAKE_CODEX_ADD         write (default) | fail | silent
 *                          `silent` exits 0 without writing anything, the way a
 *                          version that refuses to shadow a plugin server might
 */

import * as fs from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME;
if (home === undefined || home.length === 0) {
  process.stderr.write("fake-codex: CODEX_HOME must be set\n");
  process.exit(2);
}
const config = path.join(home, "config.toml");

if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(argv)}\n`);
}

/** Servers this config.toml actually declares - the ones Codex would launch. */
function registeredServers() {
  let text;
  try {
    text = fs.readFileSync(config, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(/^\s*\[mcp_servers\."?([^\]"]+)"?\]\s*$/gm)].map((m) => m[1]);
}

const sub = argv.slice(0, 2).join(" ");

if (sub === "mcp list") {
  const names = new Set(registeredServers());
  if (process.env.FAKE_CODEX_PLUGIN_ROW !== "0") names.add("agent-workers");
  process.stdout.write("Name             Command  Status\n");
  for (const name of [...names].sort()) {
    process.stdout.write(`${name.padEnd(17)}node     enabled\n`);
  }
  process.exit(0);
}

if (sub === "mcp add") {
  const mode = process.env.FAKE_CODEX_ADD ?? "write";
  if (mode === "fail") {
    process.stderr.write("error: an MCP server named `agent-workers` already exists\n");
    process.exit(1);
  }
  if (mode === "silent") process.exit(0);

  const name = argv[2];
  const dashdash = argv.indexOf("--");
  const rest = dashdash === -1 ? [] : argv.slice(dashdash + 1);
  const [command, ...args] = rest;
  if (name === undefined || command === undefined) {
    process.stderr.write("error: usage: codex mcp add <name> -- <command> [args...]\n");
    process.exit(2);
  }
  fs.mkdirSync(home, { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(config, "utf8");
  } catch {
    /* first write */
  }
  const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const block =
    `[mcp_servers.${name}]\n` +
    `command = ${JSON.stringify(command)}\n` +
    `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
  fs.appendFileSync(config, separator + block);
  process.stdout.write(`Added MCP server '${name}'.\n`);
  process.exit(0);
}

process.stderr.write(`fake-codex: unsupported invocation: ${argv.join(" ")}\n`);
process.exit(2);
