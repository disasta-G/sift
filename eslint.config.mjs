import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"test/fixtures/vault/**",
			"esbuild.config.mjs",
			"version-bump.mjs",
			"scripts/*.mjs",
			"dev/**",
			"eslint.config.mjs",
			"vitest.config.mts",
		],
	},
	js.configs.recommended,
	tseslint.configs.recommended,
	// The plugin's flat preset carries the rules the community review bot mirrors.
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"no-var": "error",
			"prefer-const": "error",
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"no-console": ["error", { allow: ["warn", "error"] }],
		},
	},
	{
		// Test harness and build scripts are not plugin code. They run under Node,
		// they print, and the obsidian stub has to REIMPLEMENT the very helpers the
		// preset insists plugin code use — so the guideline rules that exist to
		// police shipped code are turned off here and only here. Everything under
		// src/ keeps the full preset.
		files: ["test/**/*.ts", "scripts/**/*.ts"],
		languageOptions: {
			globals: { process: "readonly", setImmediate: "readonly", Buffer: "readonly" },
		},
		rules: {
			"no-console": "off",
			// The preset routes several guideline checks (no-console among them)
			// through this one wrapper rule.
			"obsidianmd/rule-custom-message": "off",
			// test/stubs/obsidian.ts defines createEl/createDiv; it cannot use them.
			"obsidianmd/prefer-create-el": "off",
			// Same file reimplements Obsidian's own show()/hide().
			"obsidianmd/no-static-styles-assignment": "off",
			// The stub patches prototypes on globalThis; there is no window in Node.
			"obsidianmd/no-global-this": "off",
			"obsidianmd/prefer-window-timers": "off",
			// The fixture generator and loader read and write real files.
			"obsidianmd/no-nodejs-modules": "off",
			// The fake vault constructs TFile instances; instanceof is not available
			// across the stub/real type boundary.
			"obsidianmd/no-tfile-tfolder-cast": "off",
			// Fixture text is test data, not user interface copy.
			"obsidianmd/ui/sentence-case": "off",
			// The settings tab keeps display() as the path for Obsidian versions
			// before 1.13.0, which is exactly what these tests exercise. A test
			// for a deprecated fallback has to call it; warning about that in
			// every assertion buries the warnings that mean something.
			"@typescript-eslint/no-deprecated": "off",
		},
	},
);
