/**
 * Filter tests — folder, subfolder, date ranges and the excluded folders from
 * settings.
 *
 * The folder cases run against a vault built for one trap in particular: a
 * `Projekte2` next to `Projekte`. A prefix comparison lets the first leak into
 * a search restricted to the second, and nothing but a name-prefix pair makes
 * that visible.
 *
 * The date cases run against the generated vault, because "created uses the
 * frontmatter date where there is one" only means something over notes that
 * write that date in four different notations and sometimes not at all.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import 'fake-indexeddb/auto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Indexer } from '../../src/index/Indexer';
import { Store } from '../../src/index/Store';
import { parseQuery } from '../../src/search/QueryParser';
import { Searcher } from '../../src/search/Searcher';
import { DEFAULT_SETTINGS, DEFAULT_TUNING } from '../../src/settings';
import type { Millis, RawHit, SearchFilters, SearchOptions } from '../../src/types';
import { createFakeApp, type FakeFileSpec } from '../helpers/fakeVault';
import { loadVault, notesWhere, type LoadedVault } from '../fixtures/loadVault';

/* ========================================================================== */
/* Harness                                                                    */
/* ========================================================================== */

interface SchedulerWindow {
	setTimeout(handler: () => void, timeout?: number): number;
	clearTimeout(handle: number): void;
}

const globalScope = globalThis as unknown as { window?: SchedulerWindow };
if (globalScope.window === undefined) {
	globalScope.window = {
		setTimeout: (handler: () => void, timeout?: number): number => setTimeout(handler, timeout) as unknown as number,
		clearTimeout: (handle: number): void => {
			clearTimeout(handle as unknown as Parameters<typeof clearTimeout>[0]);
		},
	};
}

let storeCounter = 0;

interface Harness {
	indexer: Indexer;
	searcher: Searcher;
}

async function buildHarness(files: Record<string, FakeFileSpec>): Promise<Harness> {
	storeCounter += 1;
	const app = createFakeApp(files);
	const store = new Store(`filters-${storeCounter}-${Date.now()}`);
	const indexer = new Indexer(app.asApp(), store, { ...DEFAULT_SETTINGS }, DEFAULT_TUNING);
	await indexer.start();
	return { indexer, searcher: new Searcher(indexer, DEFAULT_TUNING) };
}

function filtersWith(overrides: Partial<SearchFilters> = {}): SearchFilters {
	return {
		folder: null,
		includeSubfolders: true,
		createdFrom: null,
		createdTo: null,
		modifiedFrom: null,
		modifiedTo: null,
		excludedFolders: [],
		...overrides,
	};
}

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
	return { filters: filtersWith(), fuzzy: false, limit: 200, ...overrides };
}

function run(searcher: Searcher, query: string, filters: SearchFilters, fuzzy = false): RawHit[] {
	return searcher.search(parseQuery(query, DEFAULT_TUNING), options({ filters, fuzzy }));
}

function paths(hits: readonly RawHit[]): string[] {
	return hits.map((hit) => hit.path).sort();
}

/** Every indexed file the filters let through, by path. */
function passing(harness: Harness, filters: SearchFilters): string[] {
	const out: string[] = [];
	for (const file of harness.indexer.allFiles()) {
		if (harness.searcher.passesFilters(file, filters)) out.push(file.path);
	}
	return out.sort();
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const DAY: Millis = 86_400_000;
const BASE: Millis = Date.UTC(2026, 0, 1);

function note(name: string): string {
	return `# ${name}\n\nHier steht Kaffee im Text.\n`;
}

const FOLDER_VAULT: Record<string, FakeFileSpec> = {
	'Projekte/Alpha.md': { content: note('Alpha'), ctime: BASE, mtime: BASE + 10 * DAY },
	'Projekte/2024/Beta.md': { content: note('Beta'), ctime: BASE + DAY, mtime: BASE + 11 * DAY },
	'Projekte2/Gamma.md': { content: note('Gamma'), ctime: BASE + 2 * DAY, mtime: BASE + 12 * DAY },
	'Archiv/Delta.md': { content: note('Delta'), ctime: BASE + 3 * DAY, mtime: BASE + 13 * DAY },
	'Root.md': { content: note('Root'), ctime: BASE + 4 * DAY, mtime: BASE + 14 * DAY },
};

const ALPHA = 'Projekte/Alpha.md';
const BETA = 'Projekte/2024/Beta.md';
const GAMMA = 'Projekte2/Gamma.md';
const DELTA = 'Archiv/Delta.md';
const ROOT = 'Root.md';
const ALL = [ALPHA, BETA, GAMMA, DELTA, ROOT].sort();

/**
 * How many fixture notes this suite indexes.
 *
 * `loadVault` takes a deterministic prefix, so the runtime does not depend on
 * how many notes happen to be on disk. `npm run bench` regenerates that same
 * directory at 10 000 notes, and an unbounded load made every suite that reads
 * it slower — up to a timeout — without a line of engine code changing.
 */
const VAULT_NOTES = 600;

let small: Harness;
let vault: LoadedVault;
let fixture: Harness;

beforeAll(async () => {
	small = await buildHarness(FOLDER_VAULT);
	vault = loadVault(undefined, VAULT_NOTES);
	fixture = await buildHarness(vault.files);
}, 120_000);

afterAll(() => {
	small?.indexer.stop();
	fixture?.indexer.stop();
	vi.restoreAllMocks();
});

/* ========================================================================== */
/* Folder                                                                     */
/* ========================================================================== */

describe('Searcher — folder filter', () => {
	it('matches everything without a folder', () => {
		expect(paths(run(small.searcher, 'kaffee', filtersWith()))).toEqual(ALL);
	});

	it('does not let "Projekte2" into a search for "Projekte"', () => {
		const hits = run(small.searcher, 'kaffee', filtersWith({ folder: 'Projekte' }));
		expect(paths(hits)).toEqual([ALPHA, BETA].sort());
		expect(paths(hits)).not.toContain(GAMMA);
	});

	it('keeps the sibling reachable under its own name', () => {
		expect(paths(run(small.searcher, 'kaffee', filtersWith({ folder: 'Projekte2' })))).toEqual([GAMMA]);
	});

	it('restricts to direct children when subfolders are off', () => {
		const filters = filtersWith({ folder: 'Projekte', includeSubfolders: false });
		expect(paths(run(small.searcher, 'kaffee', filters))).toEqual([ALPHA]);
	});

	it('reaches a nested folder directly', () => {
		expect(paths(run(small.searcher, 'kaffee', filtersWith({ folder: 'Projekte/2024' })))).toEqual([BETA]);
	});

	it('treats the vault root as the whole vault, or as its own files only', () => {
		for (const root of ['', '/']) {
			expect(passing(small, filtersWith({ folder: root }))).toEqual(ALL);
			expect(passing(small, filtersWith({ folder: root, includeSubfolders: false }))).toEqual([ROOT]);
		}
	});

	it('tolerates the slashes normalizePath leaves behind', () => {
		expect(passing(small, filtersWith({ folder: '/Projekte/' }))).toEqual([ALPHA, BETA].sort());
	});

	it('matches nothing for a folder that does not exist', () => {
		expect(run(small.searcher, 'kaffee', filtersWith({ folder: 'Projek' }))).toEqual([]);
	});
});

/* ========================================================================== */
/* Excluded folders                                                           */
/* ========================================================================== */

describe('Searcher — excluded folders', () => {
	it('removes the folder from every search', () => {
		const hits = run(small.searcher, 'kaffee', filtersWith({ excludedFolders: ['Archiv'] }));
		expect(paths(hits)).not.toContain(DELTA);
		expect(paths(hits).length).toBe(ALL.length - 1);
	});

	it('wins over an explicit folder filter pointing into it', () => {
		const filters = filtersWith({ folder: 'Projekte', excludedFolders: ['Projekte'] });
		expect(run(small.searcher, 'kaffee', filters)).toEqual([]);
	});

	it('is segment-aware in both directions', () => {
		// A partial name excludes nothing …
		expect(passing(small, filtersWith({ excludedFolders: ['Projekt'] }))).toEqual(ALL);
		// … and excluding "Projekte" leaves "Projekte2" alone.
		expect(passing(small, filtersWith({ excludedFolders: ['Projekte'] }))).toEqual(
			[GAMMA, DELTA, ROOT].sort(),
		);
	});

	it('ignores an empty or root-only entry instead of hiding the vault', () => {
		expect(passing(small, filtersWith({ excludedFolders: ['', '  ', '/'] }))).toEqual(ALL);
	});

	it('applies to the fuzzy path as well', () => {
		const filters = filtersWith({ excludedFolders: ['Archiv'] });
		// "Delte" is one edit from the title word "Delta" and would match it.
		expect(run(small.searcher, 'delte', filtersWith(), true).map((hit) => hit.path)).toEqual([DELTA]);
		expect(run(small.searcher, 'delte', filters, true)).toEqual([]);
	});
});

/* ========================================================================== */
/* Dates                                                                      */
/* ========================================================================== */

describe('Searcher — date filters', () => {
	it('includes both ends of a created range', () => {
		const filters = filtersWith({ createdFrom: BASE + DAY, createdTo: BASE + 3 * DAY });
		expect(passing(small, filters)).toEqual([BETA, GAMMA, DELTA].sort());
	});

	it('includes both ends of a modified range', () => {
		const filters = filtersWith({ modifiedFrom: BASE + 11 * DAY, modifiedTo: BASE + 13 * DAY });
		expect(passing(small, filters)).toEqual([BETA, GAMMA, DELTA].sort());
	});

	it('accepts an open end', () => {
		expect(passing(small, filtersWith({ createdFrom: BASE + 3 * DAY }))).toEqual([DELTA, ROOT].sort());
		expect(passing(small, filtersWith({ createdTo: BASE }))).toEqual([ALPHA]);
	});

	it('combines with the folder filter', () => {
		const filters = filtersWith({ folder: 'Projekte', createdFrom: BASE + DAY });
		expect(paths(run(small.searcher, 'kaffee', filters))).toEqual([BETA]);
	});

	it('reads the created date out of the frontmatter, not the file stamp', () => {
		// `notesWhere` reads the whole manifest; only the loaded prefix is indexed.
		const dated = notesWhere(
			vault,
			(candidate) =>
				vault.files[candidate.path] !== undefined &&
				candidate.createdMs !== null &&
				candidate.createdMs !== candidate.ctime,
		);
		expect(dated.length).toBeGreaterThan(50);
		for (const candidate of dated.slice(0, 40)) {
			const file = fixture.indexer.getFileByPath(candidate.path);
			expect(file?.createdSource, candidate.path).toBe('frontmatter');
			// Within a day, not exact: the generator resolves a bare `created:`
			// date to UTC midnight while the plugin reads it as local midnight,
			// so on any machine outside UTC the two differ by the zone offset.
			// What matters here is that the frontmatter date won over the file
			// stamp, which sits ten to two hundred days away.
			expect(Math.abs((file?.createdAt ?? 0) - (candidate.createdMs ?? 0)), candidate.path).toBeLessThan(DAY);
			expect(file?.createdAt).not.toBe(candidate.ctime);
		}
	});

	it('selects exactly the notes the manifest puts inside the window', () => {
		// Midday boundaries: the manifest's dates land on midnight, so a zone
		// offset can never move a note across an edge and make this flaky.
		const from = Date.UTC(2024, 5, 15, 12);
		const to = Date.UTC(2025, 1, 20, 12);
		const filters = filtersWith({ createdFrom: from, createdTo: to });
		const expected = notesWhere(vault, (candidate) => {
			if (vault.files[candidate.path] === undefined) return false;
			const created = candidate.createdMs ?? candidate.ctime;
			return created >= from && created <= to;
		})
			.map((candidate) => candidate.path)
			.sort();
		expect(expected.length).toBeGreaterThan(10);
		expect(passing(fixture, filters)).toEqual(expected);
	});

	it('lets no hit through that the filter rejects', () => {
		const from = Date.UTC(2024, 5, 15, 12);
		const to = Date.UTC(2025, 1, 20, 12);
		const filters = filtersWith({ createdFrom: from, createdTo: to });
		const hits = run(fixture.searcher, 'maschine', filters);
		expect(hits.length).toBeGreaterThan(0);
		for (const hit of hits) {
			expect(hit.createdAt).toBeGreaterThanOrEqual(from);
			expect(hit.createdAt).toBeLessThanOrEqual(to);
		}
		// The same query without the range finds strictly more.
		expect(run(fixture.searcher, 'maschine', filtersWith()).length).toBeGreaterThan(hits.length);
	});
});

/* ========================================================================== */
/* Filters come before verification                                           */
/* ========================================================================== */

describe('Searcher — filtered files are never scanned', () => {
	it('skips excluded files even when nothing narrowed the candidate set', () => {
		const ast = parseQuery('ka', DEFAULT_TUNING);
		// A two-character term has no trigram, so the scan walks the whole vault
		// and the filter is the only thing keeping it off a file.
		expect(ast.terms[0].short).toBe(true);
		const spy = vi.spyOn(small.searcher, 'verify');
		const hits = small.searcher.search(ast, options({ filters: filtersWith({ folder: 'Projekte' }) }));
		const scanned = spy.mock.calls.map((call) => call[1].path);
		spy.mockRestore();

		expect(scanned.length).toBeGreaterThan(0);
		for (const path of scanned) {
			expect([ALPHA, BETA]).toContain(path);
		}
		expect(paths(hits)).toEqual([ALPHA, BETA].sort());
	});

	it('skips files outside a date range before reading their text', () => {
		const ast = parseQuery('ka', DEFAULT_TUNING);
		const spy = vi.spyOn(small.searcher, 'verify');
		small.searcher.search(ast, options({ filters: filtersWith({ createdTo: BASE }) }));
		const scanned = spy.mock.calls.map((call) => call[1].path);
		spy.mockRestore();
		expect(scanned).toEqual([ALPHA]);
	});
});

/* ========================================================================== */
/* passesFilters on its own                                                   */
/* ========================================================================== */

describe('Searcher.passesFilters', () => {
	it('answers for a single record the way the search does', () => {
		const alpha = small.indexer.getFileByPath(ALPHA);
		const gamma = small.indexer.getFileByPath(GAMMA);
		expect(alpha).toBeDefined();
		expect(gamma).toBeDefined();
		if (alpha === undefined || gamma === undefined) return;

		expect(small.searcher.passesFilters(alpha, filtersWith())).toBe(true);
		expect(small.searcher.passesFilters(alpha, filtersWith({ folder: 'Projekte' }))).toBe(true);
		expect(small.searcher.passesFilters(gamma, filtersWith({ folder: 'Projekte' }))).toBe(false);
		expect(
			small.searcher.passesFilters(alpha, filtersWith({ folder: 'Projekte', includeSubfolders: false })),
		).toBe(true);
		expect(small.searcher.passesFilters(alpha, filtersWith({ excludedFolders: ['Projekte'] }))).toBe(false);
		expect(small.searcher.passesFilters(alpha, filtersWith({ createdFrom: BASE, createdTo: BASE }))).toBe(true);
		expect(small.searcher.passesFilters(alpha, filtersWith({ createdFrom: BASE + 1 }))).toBe(false);
		expect(small.searcher.passesFilters(alpha, filtersWith({ modifiedTo: BASE }))).toBe(false);
	});
});
