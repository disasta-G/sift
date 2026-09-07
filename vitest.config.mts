import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
	},
	resolve: {
		alias: {
			// The `obsidian` module only exists inside the app. Tests import a
			// hand-written stub that mirrors the small slice of API we rely on.
			obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)),
		},
	},
});
