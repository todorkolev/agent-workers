/**
 * Bundle the bridge and the supervisor into two committed ESM files.
 *
 * They are committed because a plugin is installed by cloning the repository:
 * an install must not require a toolchain, a network fetch, or an npm install
 * on the user's machine.
 *
 * The version is inlined at build time rather than read from the environment,
 * because the real launch is a bare `node dist/agent-workers.mjs` where
 * npm_package_version is unset.
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = typeof pkg.version === "string" ? pkg.version : "0.0.0-dev";
const outDir = path.join(root, "plugins/agent-workers/dist");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  define: { __AGENT_WORKERS_VERSION__: JSON.stringify(version) },
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [path.join(root, "src/bridge/main.ts")],
  outfile: path.join(outDir, "agent-workers.mjs"),
});

await build({
  ...common,
  entryPoints: [path.join(root, "src/supervisor/main.ts")],
  outfile: path.join(outDir, "supervisor.mjs"),
});

process.stderr.write(`built agent-workers ${version} into ${path.relative(root, outDir)}\n`);
