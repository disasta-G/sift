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
 * The last section covers the search that has NO query term: a date range or a
 * folder on its own is a valid search and returns everything the filters let
 * through, while an empty query with no filter — and a query of nothing but
 * negations — still returns nothing.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import 'fake-indexeddb/auto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Indexer } from '../../src/index/Indexer';
import { Store } from '../../src/index/Store';
import { parseQuery } from '../../src/search/QueryParser';
import { hasActiveFilters, Searcher } from '../../src/search/Searcher';
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
		property: null,
		note: null,
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

/**
 * Notes with frontmatter, for the property filter. `Status` and `Fällig` are
 * spelled with a capital and an umlaut on purpose: the index folds both the key
 * and the value, and the filter has to travel folded to meet them.
 */
const PROPERTY_VAULT: Record<string, FakeFileSpec> = {
	'Offen.md': {
		content: `---\nStatus: Offen\nFällig: 2026-03-01\n---\n\nHier steht Kaffee im Text.\n`,
		ctime: BASE,
		mtime: BASE,
	},
	'Erledigt.md': {
		content: `---\nstatus: erledigt\n---\n\nHier steht Kaffee im Text.\n`,
		ctime: BASE,
		mtime: BASE,
	},
	'Ohne.md': { content: note('Ohne'), ctime: BASE, mtime: BASE },
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
let properties: Harness;
let vault: LoadedVault;
let fixture: Harness;

beforeAll(async () => {
	small = await buildHarness(FOLDER_VAULT);
	properties = await buildHarness(PROPERTY_VAULT);
	vault = loadVault(undefined, VAULT_NOTES);
	fixture = await buildHarness(vault.files);
}, 120_000);

afterAll(() => {
	small?.indexer.stop();
	properties?.indexer.stop();
	fixture?.indexer.stop();
	vi.restoreAllMocks();
});

/* ========================================================================== */
/* Property                                                                   */
/* ========================================================================== */

describe('Searcher — property filter', () => {
	it('matches every note that carries the property, whatever its value', () => {
		expect(passing(properties, filtersWith({ property: { key: 'status', value: null } }))).toEqual([
			'Erledigt.md',
			'Offen.md',
		]);
	});

	it('narrows to a value, matching a fragment of the folded text', () => {
		expect(passing(properties, filtersWith({ property: { key: 'status', value: 'offen' } }))).toEqual([
			'Offen.md',
		]);
		// A fragment, not an equality: what the user types is more often part of
		// the value than the whole of it.
		expect(passing(properties, filtersWith({ property: { key: 'status', value: 'erled' } }))).toEqual([
			'Erledigt.md',
		]);
	});

	it('reads a key that was written with a capital and an umlaut', () => {
		expect(passing(properties, filtersWith({ property: { key: 'fallig', value: null } }))).toEqual([
			'Offen.md',
		]);
	});

	it('matches nothing for a property no note has', () => {
		expect(passing(properties, filtersWith({ property: { key: 'prioritat', value: null } }))).toEqual([]);
	});

	it('counts as an active filter, so it searches on its own', () => {
		expect(hasActiveFilters(filtersWith({ property: { key: 'status', value: null } }))).toBe(true);
		expect(hasActiveFilters(filtersWith())).toBe(false);
	});
});

describe('Searcher — note filter', () => {
	it('keeps the one note and nothing else', () => {
		expect(passing(small, filtersWith({ note: ALPHA }))).toEqual([ALPHA]);
	});

	it('matches nothing for a note that is not in the index', () => {
		expect(passing(small, filtersWith({ note: 'Weg.md' }))).toEqual([]);
	});

	it('counts as an active filter, so one note can be searched without a term', () => {
		expect(hasActiveFilters(filtersWith({ note: ALPHA }))).toBe(true);
	});
});

describe('Searcher — prop: operator', () => {
	function paths(query: string): string[] {
		return run(properties.searcher, query, filtersWith())
			.map((hit) => hit.path)
			.sort();
	}

	it('finds every note carrying the property', () => {
		expect(paths('prop:status')).toEqual(['Erledigt.md', 'Offen.md']);
	});

	it('narrows to a value, folded on both sides', () => {
		expect(paths('prop:status=offen')).toEqual(['Offen.md']);
		// Typed with a capital, matched against the folded record.
		expect(paths('prop:Status=Offen')).toEqual(['Offen.md']);
	});

	it('reports the match inside the frontmatter, so the excerpt can show it', () => {
		const hits = run(properties.searcher, 'prop:status=offen', filtersWith());
		expect(hits.length).toBe(1);
		expect(hits[0].matches.length).toBe(1);
		expect(hits[0].matches[0].field).toBe('frontmatter');
		expect(hits[0].matches[0].end).toBeGreaterThan(hits[0].matches[0].start);
	});

	it('excludes with a leading minus, next to an ordinary term', () => {
		// "Kaffee" is in all three notes; the exclusion removes the two that carry
		// the property, which is the combination the chip cannot express.
		expect(paths('Kaffee -prop:status')).toEqual(['Ohne.md']);
	});

	it('finds nothing for a property no note carries', () => {
		expect(paths('prop:prioritat')).toEqual([]);
	});
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

/* ========================================================================== */
/* A search with no query term                                                */
/* ========================================================================== */

describe('hasActiveFilters', () => {
	it('is false for filters that constrain nothing', () => {
		expect(hasActiveFilters(filtersWith())).toBe(false);
		expect(hasActiveFilters(filtersWith({ includeSubfolders: false }))).toBe(false);
	});

	it('is true for a date bound at either end of either field', () => {
		expect(hasActiveFilters(filtersWith({ createdFrom: BASE }))).toBe(true);
		expect(hasActiveFilters(filtersWith({ createdTo: BASE }))).toBe(true);
		expect(hasActiveFilters(filtersWith({ modifiedFrom: BASE }))).toBe(true);
		expect(hasActiveFilters(filtersWith({ modifiedTo: BASE }))).toBe(true);
	});

	it('is true for a folder, slashes and all', () => {
		expect(hasActiveFilters(filtersWith({ folder: 'Projekte' }))).toBe(true);
		expect(hasActiveFilters(filtersWith({ folder: '/Projekte/' }))).toBe(true);
	});

	it('treats the vault root as a filter only when subfolders are off', () => {
		for (const root of ['', '/']) {
			expect(hasActiveFilters(filtersWith({ folder: root }))).toBe(false);
			expect(hasActiveFilters(filtersWith({ folder: root, includeSubfolders: false }))).toBe(true);
		}
	});

	it('does not count the excluded folders from the settings', () => {
		// Otherwise an empty query would list the whole vault for anyone who has
		// ever excluded a folder.
		expect(hasActiveFilters(filtersWith({ excludedFolders: ['Archiv'] }))).toBe(false);
	});
});

describe('Searcher — search without a query term', () => {
	it('returns nothing at all when no filter is set', () => {
		for (const query of ['', '   ', '""']) {
			expect(run(small.searcher, query, filtersWith())).toEqual([]);
		}
	});

	it('returns nothing for negations alone, however they are written', () => {
		// "Every note except those" is not a question anyone types on purpose.
		expect(run(small.searcher, '-kaffee', filtersWith())).toEqual([]);
		expect(run(small.searcher, '-kaffee -alpha', filtersWith())).toEqual([]);
		expect(run(small.searcher, '-path:Projekte', filtersWith())).toEqual([]);
	});

	it('returns exactly the notes created inside a date range, both ends included', () => {
		const filters = filtersWith({ createdFrom: BASE + DAY, createdTo: BASE + 3 * DAY });
		expect(paths(run(small.searcher, '', filters))).toEqual([BETA, GAMMA, DELTA].sort());
	});

	it('includes a note that sits exactly on either boundary and excludes the neighbours', () => {
		// BETA is created at BASE + 1 day, DELTA at BASE + 3 days: the range is
		// precisely those two ends.
		const closed = filtersWith({ createdFrom: BASE + DAY, createdTo: BASE + 3 * DAY });
		expect(paths(run(small.searcher, '', closed))).toContain(BETA);
		expect(paths(run(small.searcher, '', closed))).toContain(DELTA);
		// One millisecond in from each end drops exactly those two.
		const open = filtersWith({ createdFrom: BASE + DAY + 1, createdTo: BASE + 3 * DAY - 1 });
		expect(paths(run(small.searcher, '', open))).toEqual([GAMMA]);
	});

	it('accepts an open-ended range and a single day', () => {
		expect(paths(run(small.searcher, '', filtersWith({ createdFrom: BASE + 3 * DAY })))).toEqual(
			[DELTA, ROOT].sort(),
		);
		expect(paths(run(small.searcher, '', filtersWith({ createdTo: BASE })))).toEqual([ALPHA]);
		const oneDay = filtersWith({ createdFrom: BASE + 2 * DAY, createdTo: BASE + 2 * DAY });
		expect(paths(run(small.searcher, '', oneDay))).toEqual([GAMMA]);
	});

	it('works on the modified range as well', () => {
		const filters = filtersWith({ modifiedFrom: BASE + 11 * DAY, modifiedTo: BASE + 13 * DAY });
		expect(paths(run(small.searcher, '', filters))).toEqual([BETA, GAMMA, DELTA].sort());
	});

	it('returns exactly one folder subtree, and only its direct children without subfolders', () => {
		expect(paths(run(small.searcher, '', filtersWith({ folder: 'Projekte' })))).toEqual([ALPHA, BETA].sort());
		const direct = filtersWith({ folder: 'Projekte', includeSubfolders: false });
		expect(paths(run(small.searcher, '', direct))).toEqual([ALPHA]);
		expect(paths(run(small.searcher, '', filtersWith({ folder: 'Projekte/2024' })))).toEqual([BETA]);
	});

	it('does not let a name-prefix sibling bleed into the folder', () => {
		expect(paths(run(small.searcher, '', filtersWith({ folder: 'Projekte' })))).not.toContain(GAMMA);
		expect(paths(run(small.searcher, '', filtersWith({ folder: 'Projekte2' })))).toEqual([GAMMA]);
	});

	it('lists the loose root notes when the root is chosen without subfolders', () => {
		expect(paths(run(small.searcher, '', filtersWith({ folder: '', includeSubfolders: false })))).toEqual([ROOT]);
	});

	it('combines a folder with a date range', () => {
		const filters = filtersWith({ folder: 'Projekte', createdFrom: BASE + DAY });
		expect(paths(run(small.searcher, '', filters))).toEqual([BETA]);
	});

	it('lets the excluded folders win', () => {
		const wide = filtersWith({ createdFrom: BASE, createdTo: BASE + 10 * DAY, excludedFolders: ['Archiv'] });
		expect(paths(run(small.searcher, '', wide))).not.toContain(DELTA);
		expect(paths(run(small.searcher, '', wide))).toEqual([ALPHA, BETA, GAMMA, ROOT].sort());
		const pointed = filtersWith({ folder: 'Archiv', excludedFolders: ['Archiv'] });
		expect(run(small.searcher, '', pointed)).toEqual([]);
	});

	it('applies a negation beside the filter', () => {
		// "That folder, without the Alpha note."
		const filters = filtersWith({ folder: 'Projekte' });
		expect(paths(run(small.searcher, '-alpha', filters))).toEqual([BETA]);
		expect(paths(run(small.searcher, '-kaffee', filters))).toEqual([]);
	});

	it('never fuzzy-matches a negation away', () => {
		// "Alphb" is one edit from "Alpha" and must not remove it.
		const filters = filtersWith({ folder: 'Projekte' });
		expect(paths(run(small.searcher, '-alphb', filters, true))).toEqual([ALPHA, BETA].sort());
	});

	it('carries no matches, no quality damage and the metadata of the record', () => {
		const hits = run(small.searcher, '', filtersWith({ folder: 'Projekte', includeSubfolders: false }));
		expect(hits).toHaveLength(1);
		expect(hits[0].matches).toEqual([]);
		expect(hits[0].quality).toBe('exact');
		expect(hits[0].path).toBe(ALPHA);
		expect(hits[0].title).toBe('Alpha');
		expect(hits[0].folder).toBe('Projekte');
		expect(hits[0].createdAt).toBe(BASE);
		expect(hits[0].modifiedAt).toBe(BASE + 10 * DAY);
	});

	it('reads no file text when there is nothing to verify', () => {
		const spy = vi.spyOn(small.searcher, 'verify');
		run(small.searcher, '', filtersWith({ createdFrom: BASE }));
		const calls = spy.mock.calls.length;
		spy.mockRestore();
		expect(calls).toBe(0);
	});

	it('does no trigram work either', () => {
		// The pass is a scan over the file records: there is no literal to look
		// up, so no posting list is touched. This is what keeps it fast on a
		// large vault.
		const spy = vi.spyOn(small.searcher, 'candidates');
		const hits = run(small.searcher, '', filtersWith({ folder: 'Projekte' }));
		const calls = spy.mock.calls.length;
		spy.mockRestore();
		expect(calls).toBe(0);
		expect(hits).toHaveLength(2);
	});

	it('verifies a negation only for the files the filter kept', () => {
		const spy = vi.spyOn(small.searcher, 'verify');
		run(small.searcher, '-kaffee', filtersWith({ folder: 'Projekte' }));
		const scanned = spy.mock.calls.map((call) => call[1].path);
		spy.mockRestore();
		expect(scanned.sort()).toEqual([ALPHA, BETA].sort());
	});

	it('respects an already aborted signal', () => {
		const controller = new AbortController();
		controller.abort();
		const hits = small.searcher.search(
			parseQuery('', DEFAULT_TUNING),
			options({ filters: filtersWith({ folder: 'Projekte' }), signal: controller.signal }),
		);
		expect(hits).toEqual([]);
	});

	it('agrees with passesFilters over the generated vault', () => {
		// The whole point of the term-less pass: it is passesFilters and nothing
		// else, so the two have to select the same notes at vault scale.
		const from = Date.UTC(2024, 5, 15, 12);
		const to = Date.UTC(2025, 1, 20, 12);
		const filters = filtersWith({ createdFrom: from, createdTo: to });
		const expected = passing(fixture, filters);
		expect(expected.length).toBeGreaterThan(10);
		expect(paths(run(fixture.searcher, '', filters))).toEqual(expected);
	});
});
