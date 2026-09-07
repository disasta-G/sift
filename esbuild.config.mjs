import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";

const banner = `/*
Sift — local search for your notes.
This bundle is generated from the TypeScript sources in src/.
It is intentionally NOT minified so the code stays readable for review.
Sources: https://github.com/disasta-G/sift
*/
`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	// Never minify: the Obsidian developer policies forbid obfuscated builds.
	minify: false,
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
