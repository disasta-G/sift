/**
 * Serves the preview harness on http://127.0.0.1:8791/.
 *
 * `styles.css` is served from the repository root, not from a copy, so the page
 * always shows the stylesheet that ships. Everything else comes from this
 * directory.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const port = Number(process.env.SIFT_PREVIEW_PORT ?? 8791);

const types = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
};

/** Files that live in the repository root rather than in this directory. */
const fromRepoRoot = new Set(["styles.css"]);

createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	const requested = url.pathname === "/" ? "/index.html" : url.pathname;
	const relative = normalize(requested).replace(/^[/\\]+/, "");
	const file = fromRepoRoot.has(relative) ? join(repo, relative) : join(here, relative);

	try {
		const body = await readFile(file);
		res.writeHead(200, {
			"Content-Type": types[extname(file)] ?? "application/octet-stream",
			"Cache-Control": "no-store",
		});
		res.end(body);
	} catch {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(`not found: ${relative}`);
	}
}).listen(port, "127.0.0.1", () => {
	console.log(`Sift preview on http://127.0.0.1:${port}/`);
	console.log("Narrow viewport (1366x768):     http://127.0.0.1:" + port + "/narrow.html");
});
