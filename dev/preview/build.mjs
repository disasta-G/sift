import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const out = process.argv[2] ?? resolve(here, "preview.js");

// Bundled with the obsidian TEST STUB, never with the real API: this harness
// exists to render the plugin's own DOM and styles.css outside the app.

await esbuild.build({
	entryPoints: [resolve(here, "entry.ts")],
	bundle: true,
	format: "iife",
	target: "es2022",
	platform: "browser",
	minify: false,
	sourcemap: "inline",
	outfile: out,
	alias: { obsidian: resolve(repo, "test/stubs/obsidian.ts") },
	loader: { ".json": "json" },
	logLevel: "info",
});
