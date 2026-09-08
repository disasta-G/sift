/**
 * Sift performance gate — `npm run bench` (runs through tsx).
 *
 * Measures exactly the three numbers docs/performance-targets.md sets, against
 * the real engine rather than a stand-in:
 *
 *   - a cold index of 10 000 notes in under 5 s,
 *   - a search in under 100 ms,
 *   - an index that costs under 100 MB.
 *
 * WHY IT DRIVES THE SHIPPED CLASSES
 * ---------------------------------
 * The script imports `Store`, `Indexer`, `QueryParser`, `Searcher` and `Ranker`
 * from `src/` and nothing else. A benchmark that reimplements the hot loop
 * measures the reimplementation, so every number below comes out of the same
 * code path the plugin runs in Obsidian. Two things have to be bridged for that
 * code to run under Node:
 *
 *   1. `src/index/Indexer.ts` imports `normalizePath` from `obsidian`, a package
 *      that only exists inside the app (`node_modules/obsidian` ships types and
 *      no runtime). Vitest solves this with an alias; tsx has no alias, so the
 *      CommonJS resolver is patched to point the bare specifier `obsidian` at
 *      `test/stubs/obsidian.ts` — the same stub the unit tests run against.
 *   2. The Indexer slices its work across `window.requestIdleCallback`. Node has
 *      no `window`, so a minimal one is installed over `setImmediate`. Using
 *      `setImmediate` rather than `setTimeout` matters: Node clamps
 *      `setTimeout(fn, 0)` to a millisecond, which on a 10 000-note build would
 *      add hundreds of milliseconds of pure scheduler latency to a number that
 *      is being compared against a 5 s budget.
 *
 * Both shims must be in place before the engine modules are evaluated, which is
 * why they are loaded with `await import()` inside `main()` instead of with
 * static imports.
 *
 * Node APIs are fine here: this file is a script and never ships.
 *
 * Usage:
 *   tsx scripts/benchmark.ts [--count 10000] [--vault <dir>] [--runs 3] [--json <path>]
 */

import 'fake-indexeddb/auto';

import { mkdirSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { arch, cpus, platform, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearImmediate, setImmediate } from 'node:timers';
import { serialize } from 'node:v8';

import type {
	IndexStats,
	QueryAst,
	SearchFilters,
	SiftSettings,
	SiftTuning,
	SortKey,
	VaultPath,
} from '../src/types';
import type { FakeApp } from '../test/helpers/fakeVault';
import type { LoadedVault } from '../test/fixtures/loadVault';

/* ========================================================================== */
/* 1. Targets                                                                 */
/* ========================================================================== */

/** The note count the targets are stated for. */
const REFERENCE_COUNT = 10_000;

/** Cold index of {@link REFERENCE_COUNT} notes, in ms. See docs/performance-targets.md. */
const COLD_INDEX_BUDGET_MS = 5_000;

/** Index footprint at {@link REFERENCE_COUNT} notes, in bytes. See docs/performance-targets.md. */
const INDEX_BYTES_BUDGET = 100 * 1024 * 1024;

/** One search, in ms. Not scaled: a smaller vault only makes it easier. */
const SEARCH_BUDGET_MS = 100;

/**
 * Fuzzy search, in ms. NOT a stated target — the "Similar" toggle is opt-in
 * and walks every candidate's packed word list, so it is allowed to cost more
 * than an exact search. The number is the point at which the feature stops
 * feeling instant: the UI debounces at 120 ms, so anything past half a second
 * reads as a hang.
 */
const FUZZY_SEARCH_BUDGET_MS = 500;

/** One changed file re-indexed and persisted, in ms. Benchmark-owned; a keystroke-rate operation. */
const INCREMENTAL_BUDGET_MS = 150;

/** How many times each query is repeated inside one run, to get a per-query p50/p95. */
const QUERY_REPETITIONS = 7;

/* ========================================================================== */
/* 2. Command line                                                            */
/* ========================================================================== */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VAULT_DIR = resolve(SCRIPT_DIR, '../test/fixtures/vault');

interface BenchOptions {
	count: number;
	vaultDir: string;
	runs: number;
	jsonPath: string | null;
}

const USAGE = 'usage: tsx scripts/benchmark.ts [--count 10000] [--vault <dir>] [--runs 3] [--json <path>]';

export function parseArgs(argv: readonly string[]): BenchOptions {
	let count = REFERENCE_COUNT;
	let vaultDir = DEFAULT_VAULT_DIR;
	let runs = 3;
	let jsonPath: string | null = null;

	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === '--count' || flag === '-n') {
			count = positiveInteger('--count', value);
			i++;
		} else if (flag === '--vault' || flag === '-v') {
			if (value === undefined) throw new Error('--vault needs a directory');
			vaultDir = resolve(value);
			i++;
		} else if (flag === '--runs' || flag === '-r') {
			runs = positiveInteger('--runs', value);
			i++;
		} else if (flag === '--json') {
			if (value === undefined) throw new Error('--json needs a file path');
			jsonPath = resolve(value);
			i++;
		} else if (flag === '--help' || flag === '-h') {
			throw new Error(USAGE);
		} else {
			throw new Error(`unknown flag "${String(flag)}"\n${USAGE}`);
		}
	}
	return { count, vaultDir, runs, jsonPath };
}

function positiveInteger(flag: string, value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${flag} needs a positive integer, got "${String(value)}"`);
	}
	return parsed;
}

/* ========================================================================== */
/* 3. Node shims                                                              */
/* ========================================================================== */

type CjsResolver = (this: unknown, request: string, ...rest: unknown[]) => string;

/**
 * Points the bare specifier `obsidian` at the test stub.
 *
 * tsx compiles this project's TypeScript to CommonJS (no `"type": "module"` in
 * package.json), so every `import` inside `src/` ends up as a `require` and one
 * patch on the CommonJS resolver covers the whole dependency graph.
 */
function aliasObsidianModule(): void {
	const stubPath = resolve(SCRIPT_DIR, '../test/stubs/obsidian.ts');
	const loader = Module as unknown as { _resolveFilename: CjsResolver };
	const original = loader._resolveFilename;
	loader._resolveFilename = function patched(request: string, ...rest: unknown[]): string {
		if (request === 'obsidian') return stubPath;
		return original.call(this, request, ...rest);
	};
}

/**
 * Installs the slice of `window` the Indexer schedules against.
 *
 * `requestIdleCallback` is backed by `setImmediate` so the measurement reflects
 * the engine rather than Node's one-millisecond timer floor.
 */
function installWindowShim(): void {
	const scope = globalThis as unknown as Record<string, unknown>;
	if (scope.window !== undefined) return;
	scope.window = {
		setTimeout: (handler: () => void, ms?: number): unknown => setTimeout(handler, ms),
		clearTimeout: (handle: unknown): void => {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		},
		requestIdleCallback: (handler: () => void): unknown => setImmediate(handler),
		cancelIdleCallback: (handle: unknown): void => {
			clearImmediate(handle as ReturnType<typeof setImmediate>);
		},
	};
}

/* ========================================================================== */
/* 4. Engine handle                                                           */
/* ========================================================================== */

type StoreModule = typeof import('../src/index/Store');
type IndexerModule = typeof import('../src/index/Indexer');
type SearcherModule = typeof import('../src/search/Searcher');
type RankerModule = typeof import('../src/search/Ranker');
type ParserModule = typeof import('../src/search/QueryParser');
type LoaderModule = typeof import('../test/fixtures/loadVault');
type GeneratorModule = typeof import('../test/fixtures/generate');

/** Everything the benchmark drives, imported after the shims are in place. */
interface Engine {
	Store: StoreModule['Store'];
	/** Pinned to the current generation so a schema bump does not silently keep the benchmark on an old store. */
	schemaVersion: StoreModule['SIFT_SCHEMA_VERSION'];
	Indexer: IndexerModule['Indexer'];
	Searcher: SearcherModule['Searcher'];
	Ranker: RankerModule['Ranker'];
	parseQuery: ParserModule['parseQuery'];
	settings: SiftSettings;
	tuning: SiftTuning;
	loadFakeApp: LoaderModule['loadFakeApp'];
	readManifest: LoaderModule['readManifest'];
	generateVault: GeneratorModule['generateVault'];
	seed: GeneratorModule['SEED'];
}

async function loadEngine(): Promise<Engine> {
	const store = await import('../src/index/Store');
	const indexer = await import('../src/index/Indexer');
	const searcher = await import('../src/search/Searcher');
	const ranker = await import('../src/search/Ranker');
	const parser = await import('../src/search/QueryParser');
	const settings = await import('../src/settings');
	const loader = await import('../test/fixtures/loadVault');
	const generator = await import('../test/fixtures/generate');
	return {
		Store: store.Store,
		schemaVersion: store.SIFT_SCHEMA_VERSION,
		Indexer: indexer.Indexer,
		Searcher: searcher.Searcher,
		Ranker: ranker.Ranker,
		parseQuery: parser.parseQuery,
		settings: settings.DEFAULT_SETTINGS,
		tuning: settings.DEFAULT_TUNING,
		loadFakeApp: loader.loadFakeApp,
		readManifest: loader.readManifest,
		generateVault: generator.generateVault,
		seed: generator.SEED,
	};
}

/* ========================================================================== */
/* 5. Query set                                                               */
/* ========================================================================== */

/** No filters at all — the shape every unfiltered case shares. */
const NO_FILTERS: SearchFilters = {
	folder: null,
	includeSubfolders: true,
	createdFrom: null,
	createdTo: null,
	modifiedFrom: null,
	modifiedTo: null,
	excludedFolders: [],
};

interface BenchQuery {
	/** What the case exists to cover, printed in the table. */
	label: string;
	query: string;
	filters: SearchFilters;
	/**
	 * Order the result list is in when the keystroke lands. Omitted means
	 * {@link SiftSettings.defaultSort}, which is what an install that never
	 * touched the dropdown runs — and the order `Ranker.rank` already returns,
	 * so the modal skips its own sort pass there. A case that names another key
	 * pays for that pass, exactly as the modal does.
	 */
	sort?: SortKey;
}

function withFilters(overrides: Partial<SearchFilters>): SearchFilters {
	return { ...NO_FILTERS, ...overrides };
}

/**
 * The fixed query set. Every entry is answerable by the generated vault, and
 * between them they cover each retrieval path the Searcher has: trigram
 * intersection, the linear short-term scan, phrase matching, negation, OR
 * groups, field restrictions, the alias/contraction variants, the fuzzy typo
 * path, the filter pass and the term-less search that is nothing but filters.
 */
function buildQueries(vault: LoadedVault): readonly BenchQuery[] {
	const range = timeWindow(vault);
	return [
		{ label: 'single term', query: 'wärmepumpe', filters: NO_FILTERS },
		{ label: 'single term (en)', query: 'ventilation', filters: NO_FILTERS },
		{ label: 'infix term', query: 'maschine', filters: NO_FILTERS },
		{ label: 'infix term (2)', query: 'heizung', filters: NO_FILTERS },
		{ label: 'two terms', query: 'kaffee maschine', filters: NO_FILTERS },
		{ label: 'two terms (en)', query: 'heat pump', filters: NO_FILTERS },
		{ label: 'three terms', query: 'bericht wärmepumpe auslegung', filters: NO_FILTERS },
		{ label: 'three terms (2)', query: 'kaffee maschine küche', filters: NO_FILTERS },
		{ label: 'phrase', query: '"heat pump"', filters: NO_FILTERS },
		{ label: 'phrase (2)', query: '"underfloor heating"', filters: NO_FILTERS },
		{ label: 'exclusion', query: 'heizung -lüftung', filters: NO_FILTERS },
		{ label: 'phrase + exclusion', query: '"wärmepumpe" -altbau', filters: NO_FILTERS },
		{ label: 'or group', query: 'kaffee OR tee', filters: NO_FILTERS },
		{ label: 'or group (3)', query: 'wärmepumpe OR erdsondenfeld OR lüftungsanlage', filters: NO_FILTERS },
		{ label: 'short term (2 chars)', query: 'ss', filters: NO_FILTERS },
		{ label: 'short term + term', query: 'ss heizung', filters: NO_FILTERS },
		{ label: 'field: path', query: 'path:Projekte', filters: NO_FILTERS },
		{ label: 'field: title', query: 'title:Küche', filters: NO_FILTERS },
		{ label: 'field: tag', query: 'tag:heizung', filters: NO_FILTERS },
		{ label: 'umlaut', query: 'küche', filters: NO_FILTERS },
		{ label: 'umlaut (2)', query: 'größe', filters: NO_FILTERS },
		{ label: 'sharp s', query: 'straße', filters: NO_FILTERS },
		{ label: 'alias', query: 'kueche', filters: NO_FILTERS },
		{ label: 'alias (2)', query: 'strasse', filters: NO_FILTERS },
		// Two dropped letters, one short word and one long. They are here because
		// the fuzzy pre-filter used to reject exactly this shape: one edit destroys
		// up to three trigrams whatever the term's length, so a constant SHARE
		// threshold threw away the short term before the distance check ever ran
		// and "Similar" found nothing for a typo. Both are answered on the fuzzy
		// pass, where the recall is what these two cases exist to keep honest.
		{ label: 'fuzzy typo (short)', query: 'heizng', filters: NO_FILTERS },
		{ label: 'fuzzy typo (long)', query: 'kafeemaschine', filters: NO_FILTERS },
		{ label: 'filter: folder', query: 'heizung', filters: withFilters({ folder: 'Projekte' }) },
		{
			label: 'filter: folder, no subfolders',
			query: 'notiz',
			filters: withFilters({ folder: 'Projekte', includeSubfolders: false }),
		},
		{
			label: 'filter: folder + date',
			query: 'maschine',
			filters: withFilters({ folder: 'Projekte', createdFrom: range.from, createdTo: range.to }),
		},
		{
			label: 'filter: modified range',
			query: 'kaffee',
			filters: withFilters({ modifiedFrom: range.from, modifiedTo: range.to }),
		},
		// A search with no query term at all: the filters ARE the query. Both
		// cases return a large share of the vault, so they measure the two things
		// that path is made of — the scan over the file records and the sort of
		// everything it returns — without a single trigram lookup.
		{
			label: 'no term: date range',
			query: '',
			filters: withFilters({ createdFrom: range.from, createdTo: range.to }),
		},
		{ label: 'no term: folder', query: '', filters: withFilters({ folder: 'Projekte' }) },
		// The two orders that cost a second pass over the whole result set. They
		// are separate cases rather than a flag on an existing one so the table
		// shows what choosing another order in the dropdown adds to a keystroke.
		{ label: 'sort: modified', query: 'maschine', filters: NO_FILTERS, sort: 'modified-desc' },
		{ label: 'sort: title', query: 'maschine', filters: NO_FILTERS, sort: 'title-asc' },
	];
}

/**
 * A date window the filtered cases can use, spanning the middle half of the
 * vault's timestamps.
 *
 * Derived from the loaded notes rather than hardcoded, so a date filter still
 * selects roughly half the vault — and therefore still costs something — if the
 * generator's date range ever moves. The literal span is only the fallback for a
 * vault with no notes at all.
 */
function timeWindow(vault: LoadedVault): { from: number; to: number } {
	const times: number[] = [];
	for (const spec of Object.values(vault.files)) {
		if (spec.mtime !== undefined) times.push(spec.mtime);
	}
	if (times.length === 0) return { from: Date.UTC(2019, 0, 1), to: Date.UTC(2026, 5, 30) };
	times.sort((a, b) => a - b);
	return { from: times[Math.floor(times.length * 0.25)], to: times[Math.floor(times.length * 0.75)] };
}

/* ========================================================================== */
/* 6. Measurement primitives                                                  */
/* ========================================================================== */

function median(samples: readonly number[]): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	if (sorted.length % 2 === 1) return sorted[middle];
	return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest-rank percentile, so p95 of seven samples is a sample and not an interpolation. */
function percentile(samples: readonly number[], fraction: number): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	const rank = Math.ceil(fraction * sorted.length);
	const at = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[at];
}

/**
 * Lets the event loop drain and the allocator settle before heap is read.
 *
 * Deliberately does not call `global.gc`: the benchmark has to produce the same
 * number whether or not it was started with `--expose-gc`, so the heap figure is
 * reported as an upper bound that still contains unreclaimed garbage.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		await new Promise<void>((done) => {
			setTimeout(done, 25);
		});
	}
}

/** Structured-clone byte size of everything the Store wrote, read back out of IndexedDB. */
async function measureStorePayload(dbName: string): Promise<{ bytes: number; records: number }> {
	const db = await new Promise<IDBDatabase>((accept, fail) => {
		const request = indexedDB.open(dbName);
		request.onsuccess = (): void => {
			accept(request.result);
		};
		request.onerror = (): void => {
			fail(request.error ?? new Error('could not open the index database'));
		};
	});
	try {
		const rows = await new Promise<unknown[]>((accept, fail) => {
			const tx = db.transaction(['files', 'meta'], 'readonly');
			const files = tx.objectStore('files').getAll();
			const meta = tx.objectStore('meta').getAll();
			tx.oncomplete = (): void => {
				accept([...(files.result as unknown[]), ...(meta.result as unknown[])]);
			};
			tx.onerror = (): void => {
				fail(tx.error ?? new Error('could not read the index database'));
			};
		});
		let bytes = 0;
		// One record at a time: `serialize` on a 10 000-element array would build
		// a single buffer larger than the index itself.
		for (const row of rows) bytes += serialize(row).byteLength;
		return { bytes, records: rows.length };
	} finally {
		db.close();
	}
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise<void>((accept) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = (): void => {
			accept();
		};
		request.onerror = (): void => {
			accept();
		};
		request.onblocked = (): void => {
			accept();
		};
	});
}

/* ========================================================================== */
/* 7. One run                                                                 */
/* ========================================================================== */

/** Timings and counters of a single pass over the vault. */
interface RunResult {
	coldIndexMs: number;
	warmIndexMs: number;
	incrementalMs: number;
	stats: IndexStats;
	heapDeltaBytes: number;
	payloadBytes: number;
	payloadRecords: number;
	exact: QueryTiming[];
	fuzzy: QueryTiming[];
}

interface QueryTiming {
	label: string;
	query: string;
	hits: number;
	/** Hits left after the `maxResults` cap — the number of cards the modal would build. */
	shown: number;
	p50: number;
	p95: number;
	samples: number[];
}

async function runOnce(engine: Engine, app: FakeApp, vault: LoadedVault, runIndex: number): Promise<RunResult> {
	const vaultId = app.appId;
	const dbName = `sift-index-${vaultId}`;
	await deleteDatabase(dbName);

	/* --- cold build ---------------------------------------------------- */
	await settle();
	const heapBefore = process.memoryUsage().heapUsed;

	const coldStore = new engine.Store(vaultId, engine.schemaVersion, engine.tuning.storeBatchSize);
	const indexer = new engine.Indexer(app.asApp(), coldStore, engine.settings, engine.tuning);
	const coldStart = performance.now();
	await indexer.start();
	const coldIndexMs = performance.now() - coldStart;
	if (!indexer.isReady()) throw new Error('the indexer did not become ready');
	if (indexer.fileCount() !== Object.keys(vault.files).length) {
		throw new Error(`indexed ${indexer.fileCount()} of ${Object.keys(vault.files).length} notes`);
	}
	// start() resolves as soon as the index answers queries; the write to
	// IndexedDB continues in the background and the warm run depends on it.
	await indexer.flushPending();

	const stats = indexer.stats();
	await settle();
	const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
	const payload = await measureStorePayload(dbName);

	/* --- queries -------------------------------------------------------- */
	const searcher = new engine.Searcher(indexer, engine.tuning);
	const ranker = new engine.Ranker(engine.tuning.weights);
	const queries = buildQueries(vault);
	const now = Date.now();

	/**
	 * Times one keystroke, end to end.
	 *
	 * THE WINDOW IS THE WHOLE KEYSTROKE
	 * ---------------------------------
	 * `performance.now()` opens before `searcher.search` and closes after the
	 * slice, so it covers every step `SearchModal.executeSearch` runs between the
	 * key going down and the result list being handed to the renderer:
	 *
	 *   search -> rank -> sort (only for a non-relevance order) -> slice
	 *
	 * It used to close right after `rank`, which left the sort and the cap
	 * outside the number this gate publishes. Rendering stays outside on purpose:
	 * it is DOM work, it is windowed to the cards that fit on screen, and it
	 * cannot run under Node at all.
	 */
	const timeQueries = (fuzzy: boolean): QueryTiming[] =>
		queries.map((entry) => {
			const ast: QueryAst = engine.parseQuery(entry.query, engine.tuning);
			if (ast.errors.length > 0) {
				throw new Error(`query "${entry.query}" does not parse: ${ast.errors[0]?.code ?? 'unknown'}`);
			}
			const sort = entry.sort ?? engine.settings.defaultSort;
			const limit = Math.max(1, engine.settings.maxResults);
			const samples: number[] = [];
			let hits = 0;
			let shown = 0;
			for (let i = 0; i < QUERY_REPETITIONS; i++) {
				const started = performance.now();
				const raw = searcher.search(ast, { filters: entry.filters, fuzzy, limit: engine.settings.maxResults });
				const ranked = ranker.rank(raw, ast, now);
				// `rank` returns its hits in relevance order already, so the modal
				// re-sorts only for another key. Mirrored here: sorting every case
				// would charge the gate for a pass no default install runs.
				const sorted = sort === 'relevance' ? ranked : engine.Ranker.sort(ranked, sort);
				const capped = sorted.slice(0, limit);
				samples.push(performance.now() - started);
				hits = sorted.length;
				shown = capped.length;
			}
			return {
				label: entry.label,
				query: entry.query,
				hits,
				shown,
				p50: median(samples),
				p95: percentile(samples, 0.95),
				samples,
			};
		});

	// One untimed pass first: the first search through a fresh JIT is not what a
	// user experiences after a few keystrokes, and it would dominate the p95.
	timeQueries(false);
	const exact = timeQueries(false);
	timeQueries(true);
	const fuzzy = timeQueries(true);

	/* --- incremental update --------------------------------------------- */
	const target = pickChangeTarget(vault, runIndex);
	const before = app.contentOf(target);
	if (before === null) throw new Error(`no note at "${target}" to modify`);
	// German markers on purpose: the re-fold and the re-post have to do the same
	// alias work an ordinary edit in this vault would cause.
	const changed = `${before}\n\nChanged for benchmark run ${runIndex + 1}: Wärmepumpe, Küche, Espressomaschine.\n`;
	const file = app.writeFile(target, changed);
	const incrementalStart = performance.now();
	indexer.applyChange({ kind: 'modified', file, path: target });
	await indexer.flushPending();
	const incrementalMs = performance.now() - incrementalStart;
	// Put the note back so every run starts from the same vault, and let the
	// index follow — otherwise the warm run below finds one stale record and
	// measures a re-read that has nothing to do with a warm start.
	const restored = app.writeFile(target, before);
	indexer.applyChange({ kind: 'modified', file: restored, path: target });
	await indexer.flushPending();

	indexer.stop();
	coldStore.close();

	/* --- warm build ------------------------------------------------------ */
	// Same vault, same database, nothing changed on disk: the Indexer should
	// load the records it wrote and re-read no file at all.
	const warmStore = new engine.Store(vaultId, engine.schemaVersion, engine.tuning.storeBatchSize);
	const warmIndexer = new engine.Indexer(app.asApp(), warmStore, engine.settings, engine.tuning);
	app.resetReadCounts();
	const warmStart = performance.now();
	await warmIndexer.start();
	const warmIndexMs = performance.now() - warmStart;
	await warmIndexer.flushPending();
	const rereads = app.totalReadCount();
	warmIndexer.stop();
	warmStore.close();
	if (rereads > 0) {
		console.warn(`  note: the warm run re-read ${rereads} file(s); the staleness check let something through`);
	}

	return {
		coldIndexMs,
		warmIndexMs,
		incrementalMs,
		stats,
		heapDeltaBytes,
		payloadBytes: payload.bytes,
		payloadRecords: payload.records,
		exact,
		fuzzy,
	};
}

/** A different note per run, so no run benefits from the previous one's cache. */
function pickChangeTarget(vault: LoadedVault, runIndex: number): VaultPath {
	const paths = Object.keys(vault.files).sort();
	if (paths.length === 0) throw new Error('the fixture vault is empty');
	return paths[(runIndex * 37) % paths.length];
}

/* ========================================================================== */
/* 8. Fixture vault                                                           */
/* ========================================================================== */

/** Generates the vault when it is absent or holds the wrong number of notes. */
function ensureVault(engine: Engine, dir: string, count: number): void {
	const manifest = engine.readManifest(dir);
	if (manifest !== null && manifest.count === count) return;
	const why = manifest === null ? 'no vault' : `${manifest.count} notes`;
	console.log(`Generating the fixture vault (${why} -> ${count} notes) in ${dir} ...`);
	const result = engine.generateVault({ count, outDir: dir, seed: engine.seed });
	console.log(`  ${result.manifest.count} notes, ${formatBytes(result.manifest.totalBytes)}, ${result.elapsedMs} ms`);
}

/* ========================================================================== */
/* 9. Reporting                                                               */
/* ========================================================================== */

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return 'n/a';
	const sign = bytes < 0 ? '-' : '';
	const value = Math.abs(bytes);
	if (value < 1024) return `${sign}${value} B`;
	if (value < 1024 * 1024) return `${sign}${(value / 1024).toFixed(1)} KB`;
	if (value < 1024 * 1024 * 1024) return `${sign}${(value / (1024 * 1024)).toFixed(1)} MB`;
	return `${sign}${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatMs(ms: number): string {
	if (!Number.isFinite(ms)) return 'n/a';
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	if (ms >= 10) return `${ms.toFixed(1)} ms`;
	return `${ms.toFixed(2)} ms`;
}

function formatCount(value: number): string {
	return value.toLocaleString('en-US');
}

type Align = 'left' | 'right';

/** Fixed-width table with a rule under the header. Text columns left, numbers right. */
function renderTable(
	header: readonly string[],
	rows: readonly (readonly string[])[],
	align: readonly Align[],
): string {
	const widths = header.map((cell, column) =>
		Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)),
	);
	const line = (cells: readonly string[]): string =>
		cells
			.map((cell, column) => {
				const width = widths[column] ?? 0;
				return align[column] === 'right' ? cell.padStart(width) : cell.padEnd(width);
			})
			.join('  ')
			.trimEnd();
	const rule = widths.map((width) => '-'.repeat(width)).join('  ');
	return [line(header), rule, ...rows.map(line)].join('\n');
}

interface Check {
	name: string;
	measured: string;
	budget: string;
	source: 'target' | 'benchmark';
	passed: boolean;
}

function renderChecks(checks: readonly Check[]): string {
	const rows = checks.map((check) => [
		check.name,
		check.measured,
		check.budget,
		check.source,
		check.passed ? 'PASS' : 'FAIL',
	]);
	return renderTable(
		['Target', 'Measured', 'Budget', 'Source', 'Result'],
		rows,
		['left', 'right', 'right', 'left', 'left'],
	);
}

function machineContext(): string[] {
	const cores = cpus();
	const model = cores[0]?.model.trim().replace(/\s+/g, ' ') ?? 'unknown CPU';
	return [
		`node ${process.version} · ${platform()} ${arch()}`,
		`${cores.length} logical cpus · ${model}`,
		`${formatBytes(totalmem())} system memory · heap limit not raised`,
	];
}

/* ========================================================================== */
/* 10. Aggregation                                                            */
/* ========================================================================== */

/** A query's timing across every run, folded to one row. */
interface QuerySummary {
	label: string;
	query: string;
	hits: number;
	/** Hits left after the `maxResults` cap, i.e. the cards the modal would build. */
	shown: number;
	p50: number;
	p95: number;
}

function summarizeQueries(runs: readonly QueryTiming[][]): QuerySummary[] {
	const first = runs[0];
	if (first === undefined) return [];
	return first.map((entry, index) => {
		const across = runs.map((run) => run[index]).filter((timing): timing is QueryTiming => timing !== undefined);
		const samples = across.flatMap((timing) => timing.samples);
		return {
			label: entry.label,
			query: entry.query,
			hits: Math.round(median(across.map((timing) => timing.hits))),
			shown: Math.round(median(across.map((timing) => timing.shown))),
			p50: percentile(samples, 0.5),
			p95: percentile(samples, 0.95),
		};
	});
}

function worst(summaries: readonly QuerySummary[]): QuerySummary | null {
	let found: QuerySummary | null = null;
	for (const summary of summaries) {
		if (found === null || summary.p95 > found.p95) found = summary;
	}
	return found;
}

/* ========================================================================== */
/* 11. Main                                                                   */
/* ========================================================================== */

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));

	aliasObsidianModule();
	installWindowShim();
	const engine = await loadEngine();

	ensureVault(engine, options.vaultDir, options.count);
	const { app, vault } = engine.loadFakeApp(options.vaultDir);
	const noteCount = Object.keys(vault.files).length;

	const scale = noteCount / REFERENCE_COUNT;
	const coldBudget = COLD_INDEX_BUDGET_MS * scale;
	const memoryBudget = INDEX_BYTES_BUDGET * scale;

	console.log('Sift benchmark');
	for (const line of machineContext()) console.log(`  ${line}`);
	console.log(
		`  vault ${options.vaultDir}\n  ${formatCount(noteCount)} notes · ${formatBytes(vault.totalLength * 2)} of UTF-16 text · ${options.runs} run(s)`,
	);
	if (noteCount !== REFERENCE_COUNT) {
		console.log(
			`  NOTE: the index budgets are stated for ${formatCount(REFERENCE_COUNT)} notes. They are scaled linearly to ${formatCount(noteCount)} here,`,
		);
		console.log('        so this run is an indication, not the release gate. Run with --count 10000 for that.');
	}
	console.log('');

	const results: RunResult[] = [];
	for (let run = 0; run < options.runs; run++) {
		process.stdout.write(`  run ${run + 1}/${options.runs} ... `);
		const result = await runOnce(engine, app, vault, run);
		results.push(result);
		process.stdout.write(`cold ${formatMs(result.coldIndexMs)}, warm ${formatMs(result.warmIndexMs)}\n`);
	}
	console.log('');

	const coldIndexMs = median(results.map((result) => result.coldIndexMs));
	const warmIndexMs = median(results.map((result) => result.warmIndexMs));
	const incrementalMs = median(results.map((result) => result.incrementalMs));
	const approximateBytes = median(results.map((result) => result.stats.approximateBytes));
	// First run only, deliberately: it is the only one whose baseline was taken
	// before any index existed. From run two on, V8 may collect the previous
	// run's index between the two readings and the delta comes out negative,
	// which a median would then present as a plausible-looking number.
	const heapDeltaBytes = results[0]?.heapDeltaBytes ?? Number.NaN;
	const payloadBytes = median(results.map((result) => result.payloadBytes));
	const lastStats = results[results.length - 1]?.stats;

	const exact = summarizeQueries(results.map((result) => result.exact));
	const fuzzy = summarizeQueries(results.map((result) => result.fuzzy));
	const exactWorst = worst(exact);
	const fuzzyWorst = worst(fuzzy);

	console.log('Index');
	console.log(
		renderTable(
			['Measurement', 'Median', 'Detail'],
			[
				['Cold index (empty IndexedDB)', formatMs(coldIndexMs), `${formatCount(noteCount)} notes read and folded`],
				['Warm index (nothing changed)', formatMs(warmIndexMs), 'records loaded from IndexedDB, no file re-read'],
				['Incremental update (1 file)', formatMs(incrementalMs), 'edit, re-fold, re-post, persist'],
				[
					'Index memory (stats)',
					formatBytes(approximateBytes),
					lastStats === undefined
						? ''
						: `${formatCount(lastStats.trigramCount)} trigrams · ${formatCount(lastStats.postingCount)} postings · compacted ${String(lastStats.compacted)}`,
				],
				[
					'Heap delta (heapUsed)',
					formatBytes(heapDeltaBytes),
					'first run only, no gc forced; upper bound, includes garbage',
				],
				[
					'IndexedDB payload',
					formatBytes(payloadBytes),
					`${formatCount(results[0]?.payloadRecords ?? 0)} records, structured-clone size`,
				],
			],
			['left', 'right', 'left'],
		),
	);
	console.log('');

	console.log(`Queries — exact (${formatCount(exact.length)} cases, ${QUERY_REPETITIONS} repetitions per run)`);
	console.log('  timed window per keystroke: search + rank + sort (non-relevance orders only) + result cap');
	console.log(renderQueryTable(exact));
	console.log('');
	console.log(`Queries — fuzzy / "Similar" on (${formatCount(fuzzy.length)} cases)`);
	console.log(renderQueryTable(fuzzy));
	console.log('');

	const checks: Check[] = [
		{
			name: `Cold index of ${formatCount(noteCount)} note${noteCount === 1 ? '' : 's'}`,
			measured: formatMs(coldIndexMs),
			budget: `< ${formatMs(coldBudget)}`,
			source: 'target',
			passed: coldIndexMs < coldBudget,
		},
		{
			name: `Search p95, worst case (${exactWorst === null ? 'none' : exactWorst.label})`,
			measured: exactWorst === null ? 'n/a' : formatMs(exactWorst.p95),
			budget: `< ${formatMs(SEARCH_BUDGET_MS)}`,
			source: 'target',
			passed: exactWorst !== null && exactWorst.p95 < SEARCH_BUDGET_MS,
		},
		{
			name: 'Index memory',
			measured: formatBytes(approximateBytes),
			budget: `< ${formatBytes(memoryBudget)}`,
			source: 'target',
			passed: approximateBytes < memoryBudget,
		},
		{
			name: `Fuzzy search p95, worst case (${fuzzyWorst === null ? 'none' : fuzzyWorst.label})`,
			measured: fuzzyWorst === null ? 'n/a' : formatMs(fuzzyWorst.p95),
			budget: `< ${formatMs(FUZZY_SEARCH_BUDGET_MS)}`,
			source: 'benchmark',
			passed: fuzzyWorst !== null && fuzzyWorst.p95 < FUZZY_SEARCH_BUDGET_MS,
		},
		{
			name: 'Warm index',
			measured: formatMs(warmIndexMs),
			budget: `< ${formatMs(coldBudget)}`,
			source: 'benchmark',
			passed: warmIndexMs < coldBudget,
		},
		{
			name: 'Incremental update',
			measured: formatMs(incrementalMs),
			budget: `< ${formatMs(INCREMENTAL_BUDGET_MS)}`,
			source: 'benchmark',
			passed: incrementalMs < INCREMENTAL_BUDGET_MS,
		},
	];

	console.log('Targets');
	console.log(renderChecks(checks));
	console.log('');

	const failed = checks.filter((check) => !check.passed);
	if (options.jsonPath !== null) {
		writeReport(options, {
			noteCount,
			machine: machineContext(),
			coldIndexMs,
			warmIndexMs,
			incrementalMs,
			approximateBytes,
			heapDeltaBytes,
			payloadBytes,
			exact,
			fuzzy,
			checks,
			medianQueryP50: median(exact.map((summary) => summary.p50)),
			runs: results,
		});
		console.log(`JSON report written to ${options.jsonPath}`);
	}

	if (failed.length === 0) {
		console.log(`All ${checks.length} targets met.`);
		return 0;
	}
	console.error(`${failed.length} of ${checks.length} targets missed: ${failed.map((check) => check.name).join(', ')}`);
	return 1;
}

function renderQueryTable(summaries: readonly QuerySummary[]): string {
	return renderTable(
		['Case', 'Query', 'Hits', 'p50', 'p95'],
		summaries.map((summary) => [
			summary.label,
			// A filter-only case has no query string; an empty cell would read as
			// a formatting fault rather than as the point of the case.
			summary.query.length === 0 ? '(filters only)' : summary.query,
			formatCount(summary.hits),
			formatMs(summary.p50),
			formatMs(summary.p95),
		]),
		['left', 'left', 'right', 'right', 'right'],
	);
}

/* ========================================================================== */
/* 12. JSON report                                                            */
/* ========================================================================== */

interface Report {
	noteCount: number;
	machine: string[];
	coldIndexMs: number;
	warmIndexMs: number;
	incrementalMs: number;
	approximateBytes: number;
	heapDeltaBytes: number;
	payloadBytes: number;
	exact: QuerySummary[];
	fuzzy: QuerySummary[];
	checks: Check[];
	medianQueryP50: number;
	runs: RunResult[];
}

function writeReport(options: BenchOptions, report: Report): void {
	const path = options.jsonPath;
	if (path === null) return;
	mkdirSync(dirname(path), { recursive: true });
	const payload = {
		generatedAt: new Date().toISOString(),
		options: { count: options.count, vault: options.vaultDir, runs: options.runs },
		machine: report.machine,
		noteCount: report.noteCount,
		index: {
			coldIndexMs: report.coldIndexMs,
			warmIndexMs: report.warmIndexMs,
			incrementalMs: report.incrementalMs,
			approximateBytes: report.approximateBytes,
			heapDeltaBytes: report.heapDeltaBytes,
			payloadBytes: report.payloadBytes,
		},
		queries: { exact: report.exact, fuzzy: report.fuzzy, medianP50: report.medianQueryP50 },
		checks: report.checks,
		perRun: report.runs.map((run) => ({
			coldIndexMs: run.coldIndexMs,
			warmIndexMs: run.warmIndexMs,
			incrementalMs: run.incrementalMs,
			stats: run.stats,
			heapDeltaBytes: run.heapDeltaBytes,
			payloadBytes: run.payloadBytes,
		})),
	};
	writeFileSync(path, `${JSON.stringify(payload, null, '\t')}\n`, 'utf8');
}

/* ========================================================================== */

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	},
);
