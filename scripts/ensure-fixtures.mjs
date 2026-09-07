/**
 * Generates the fixture vault when it is missing, so `npm test` is green on a
 * fresh clone.
 *
 * The vault is git-ignored on purpose: it is generated from a seed, not
 * authored, and six test files plus the benchmark read it. Without this hook
 * the first command a stranger runs after cloning fails with MissingVaultError
 * in six suites, which reads as a broken project rather than a missing build
 * step.
 *
 * It is deliberately NOT a regeneration: an existing vault is left exactly as
 * it is, whatever size it has. `npm run bench` writes 10 000 notes into the
 * same directory, and silently replacing that on every `npm test` would throw
 * away a benchmark run and make the suite's runtime depend on what someone
 * measured last.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const vault = join(repo, "test", "fixtures", "vault");
const manifest = join(vault, "_manifest.json");

if (existsSync(manifest)) {
	process.exit(0);
}

console.log("Fixture vault missing — generating 2000 notes (once).");
const result = spawnSync(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["tsx", "test/fixtures/generate.ts", "--count", "2000"],
	{ cwd: repo, stdio: "inherit" },
);

if (result.status !== 0) {
	console.error("Could not generate the fixture vault. Run `npm run fixtures` by hand.");
	process.exit(result.status ?? 1);
}
