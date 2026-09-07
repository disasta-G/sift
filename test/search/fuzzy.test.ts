/**
 * Fuzzy path and its two primitives.
 *
 * The suite is deliberately split between a hand-built vault, where the exact
 * distance between a query and the single word that may answer it is known, and
 * the generated vault, which carries the two misspellings the plan names
 * ("Espresomaschine", "Kafeemaschine") among three hundred notes of noise.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import 'fake-indexeddb/auto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Indexer } from '../../src/index/Indexer';
import { trigramSet } from '../../src/index/Normalizer';
import { Store } from '../../src/index/Store';
import { parseQuery } from '../../src/search/QueryParser';
import { Searcher } from '../../src/search/Searcher';
import { DEFAULT_SETTINGS, DEFAULT_TUNING } from '../../src/settings';
import type { Match, RawHit, SearchFilters, SearchOptions } from '../../src/types';
import { createFakeApp, type FakeFileSpec } from '../helpers/fakeVault';
import { loadVault, type LoadedVault } from '../fixtures/loadVault';

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
	const store = new Store(`fuzzy-${storeCounter}-${Date.now()}`);
	const indexer = new Indexer(app.asApp(), store, { ...DEFAULT_SETTINGS }, DEFAULT_TUNING);
	await indexer.start();
	return { indexer, searcher: new Searcher(indexer, DEFAULT_TUNING) };
}

function noFilters(): SearchFilters {
	return {
		folder: null,
		includeSubfolders: true,
		createdFrom: null,
		createdTo: null,
		modifiedFrom: null,
		modifiedTo: null,
		excludedFolders: [],
	};
}

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
	return { filters: noFilters(), fuzzy: false, limit: 200, ...overrides };
}

function run(searcher: Searcher, query: string, fuzzy: boolean): RawHit[] {
	return searcher.search(parseQuery(query, DEFAULT_TUNING), options({ fuzzy }));
}

function paths(hits: readonly RawHit[]): string[] {
	return hits.map((hit) => hit.path).sort();
}

function similarWords(hit: RawHit): string[] {
	const out = new Set<string>();
	for (const match of hit.matches) {
		if (match.quality === 'fuzzy' && match.matchedText !== undefined) out.add(match.matchedText);
	}
	return [...out].sort();
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const DEVICES = ['# Geräte', '', 'Die Espressomaschine steht neben der Kaffeemaschine.'].join('\n');

/**
 * The same misspelling the user typed, written out. Nothing here needs the
 * fuzzy path.
 *
 * The dropped `f` rather than a dropped `s`: `ss -> s` is one of the alias
 * contractions, so a note reading "Espresomaschine" is a legitimate ALIAS hit
 * for the query "Espressomaschine" — that pair could never tell the fuzzy path
 * apart from the ß fold.
 */
const TYPO = ['# Tippfehler', '', 'Hier steht Kafeemaschine als Tippfehler.'].join('\n');

/**
 * The distance-budget corpus.
 *
 * `kellner` sits at distance 2 from both `kelle` and `kellen`, and neither is a
 * substring of it, so nothing here can be reached literally. The term's own
 * length is then the only thing that decides: five characters buy a budget of
 * one and find nothing, six buy two and find the word. `schnelle` is in the
 * sentence so the file holds the `lle` trigram and clears the candidate floor
 * for both queries — otherwise the test would be measuring the candidate step
 * instead of the budget.
 */
const BUDGET = ['# Wortliste', '', 'Der Kellner brachte die schnelle Antwort.'].join('\n');

const FUZZY_VAULT: Record<string, FakeFileSpec> = {
	'Kaffee/Geraete.md': { content: DEVICES, ctime: 1_700_000_000_000 },
	'Kaffee/Exakt.md': { content: TYPO, ctime: 1_700_000_001_000 },
	'Wortliste/Budget.md': { content: BUDGET, ctime: 1_700_000_002_000 },
};

const DEVICES_PATH = 'Kaffee/Geraete.md';
const TYPO_PATH = 'Kaffee/Exakt.md';
const BUDGET_PATH = 'Wortliste/Budget.md';

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
	small = await buildHarness(FUZZY_VAULT);
	vault = loadVault(undefined, VAULT_NOTES);
	fixture = await buildHarness(vault.files);
}, 120_000);

afterAll(() => {
	small?.indexer.stop();
	fixture?.indexer.stop();
});

/* ========================================================================== */
/* The switch                                                                 */
/* ========================================================================== */

describe('Searcher — fuzzy off', () => {
	it('finds nothing for a misspelling no note contains', () => {
		expect(run(small.searcher, 'espresomaschine', false)).toEqual([]);
	});

	it('still finds the misspelling where it is written out', () => {
		expect(paths(run(small.searcher, 'kafeemaschine', false))).toEqual([TYPO_PATH]);
	});
});

describe('Searcher — fuzzy on', () => {
	it('finds "Espressomaschine" for "Espresomaschine" and labels the word it hit', () => {
		const hits = run(small.searcher, 'espresomaschine', true);
		expect(paths(hits)).toEqual([DEVICES_PATH]);
		expect(hits[0].quality).toBe('fuzzy');
		expect(similarWords(hits[0])).toEqual(['espressomaschine']);
		const body = hits[0].matches.filter((match: Match) => match.field === 'body');
		expect(body.length).toBe(1);
		expect(DEVICES.slice(body[0].start, body[0].end)).toBe('Espressomaschine');
		// The fuzzy path emits whole words, never a fragment of a longer one.
		expect(body[0].wholeWord).toBe(true);
	});

	it('finds "Kaffeemaschine" for "Kafeemaschine" and keeps the literal note exact', () => {
		const hits = run(small.searcher, 'kafeemaschine', true);
		expect(paths(hits)).toEqual([TYPO_PATH, DEVICES_PATH].sort());
		const exact = hits.find((hit) => hit.path === TYPO_PATH);
		const similar = hits.find((hit) => hit.path === DEVICES_PATH);
		expect(exact?.quality).toBe('exact');
		expect(similar?.quality).toBe('fuzzy');
		expect(similarWords(similar as RawHit)).toEqual(['kaffeemaschine']);
		// An exact occurrence is never downgraded by a near miss in the same file.
		expect(exact?.matches.every((match: Match) => match.quality === 'exact')).toBe(true);
	});

	it('keeps a literal hit exact while the switch widens the set', () => {
		// Without the switch only the note that spells the word out is found.
		expect(paths(run(small.searcher, 'kaffeemaschine', false))).toEqual([DEVICES_PATH]);
		const hits = run(small.searcher, 'kaffeemaschine', true);
		expect(hits.find((hit) => hit.path === DEVICES_PATH)?.quality).toBe('exact');
		// The note carrying the typo comes in behind it, marked as such.
		expect(hits.find((hit) => hit.path === TYPO_PATH)?.quality).toBe('fuzzy');
	});

	it('never applies inside a phrase', () => {
		expect(run(small.searcher, '"espresomaschine"', true)).toEqual([]);
		const ast = parseQuery('"espresomaschine"', DEFAULT_TUNING);
		expect(ast.terms[0].fuzzyEligible).toBe(false);
	});

	it('never applies to an exclusion', () => {
		// `Geraete.md` holds "Kaffeemaschine", one edit from the excluded term.
		// It survives only because an exclusion is matched literally: a near miss
		// must not remove a file the user never typed.
		const hits = run(small.searcher, 'espressomaschine -kafeemaschine', true);
		expect(paths(hits)).toEqual([DEVICES_PATH]);
		expect(parseQuery('-kafeemaschine', DEFAULT_TUNING).mustNot[0].fuzzyEligible).toBe(false);
	});
});

/* ========================================================================== */
/* Budget                                                                     */
/* ========================================================================== */

describe('Searcher — distance budget at the 5/6 boundary', () => {
	it('the corpus word sits exactly two edits away', () => {
		expect(Searcher.damerauLevenshteinWithin('kellner', 'kelle', 2)).toBe(2);
		expect(Searcher.damerauLevenshteinWithin('kellner', 'kellen', 2)).toBe(2);
		expect(BUDGET.includes('kelle ')).toBe(false);
	});

	it('a five-character term gets one edit and does not reach it', () => {
		expect(DEFAULT_TUNING.fuzzyShortTermMaxLength).toBe(5);
		expect(DEFAULT_TUNING.fuzzyMaxDistanceShort).toBe(1);
		expect(run(small.searcher, 'kelle', true)).toEqual([]);
	});

	it('a six-character term gets two edits and reaches it', () => {
		expect(DEFAULT_TUNING.fuzzyMaxDistanceLong).toBe(2);
		const hits = run(small.searcher, 'kellen', true);
		expect(paths(hits)).toEqual([BUDGET_PATH]);
		expect(similarWords(hits[0])).toEqual(['kellner']);
		const body = hits[0].matches.filter((match: Match) => match.field === 'body');
		expect(BUDGET.slice(body[0].start, body[0].end)).toBe('Kellner');
	});
});

/* ========================================================================== */
/* Candidates                                                                 */
/* ========================================================================== */

describe('Searcher — candidate sets', () => {
	it('the fuzzy candidate set contains every exact candidate', () => {
		for (const query of ['kafeemaschine', 'espresomaschine', 'kellen', 'kueche', 'strasse']) {
			const term = parseQuery(query, DEFAULT_TUNING).terms[0];
			const exact = fixture.searcher.candidates(term, false);
			const similar = fixture.searcher.candidates(term, true);
			for (const id of exact) {
				expect(similar.has(id), `${query}: ${id}`).toBe(true);
			}
		}
	});

	it('turning fuzzy on never loses an alias hit', () => {
		const off = paths(run(fixture.searcher, 'kueche', false));
		const on = paths(run(fixture.searcher, 'kueche', true));
		expect(off.length).toBeGreaterThan(0);
		for (const path of off) expect(on).toContain(path);
	});
});

/* ========================================================================== */
/* Against the generated vault                                                */
/* ========================================================================== */

describe('Searcher — fuzzy over the generated vault', () => {
	it('a misspelling reaches the compound it was meant to be', () => {
		const off = run(fixture.searcher, 'Espresomaschine', false);
		const on = run(fixture.searcher, 'Espresomaschine', true);
		expect(on.length).toBeGreaterThan(off.length + 10);

		const introduced = on.filter((hit) => !off.some((earlier) => earlier.path === hit.path));
		expect(introduced.length).toBeGreaterThan(10);
		for (const hit of introduced) {
			expect(hit.quality).toBe('fuzzy');
			expect(similarWords(hit)).toContain('espressomaschine');
			expect(vault.files[hit.path].content.toLowerCase()).toContain('espressomaschine');
		}
	});

	it('a fuzzy match still points at a real word in the file', () => {
		for (const hit of run(fixture.searcher, 'Kafeemaschine', true)) {
			const original = vault.files[hit.path].content;
			for (const match of hit.matches) {
				if (match.quality !== 'fuzzy') continue;
				if (match.field === 'title' || match.field === 'path') continue;
				expect(original.slice(match.start, match.end).toLowerCase()).toBe(match.matchedText);
				expect(match.wholeWord).toBe(true);
			}
		}
	});
});

/* ========================================================================== */
/* trigramSimilarity                                                          */
/* ========================================================================== */

describe('Searcher.trigramSimilarity', () => {
	it('is 1 for identical sets and 0 for disjoint ones', () => {
		const a = trigramSet('kaffee');
		expect(Searcher.trigramSimilarity(a, trigramSet('kaffee'))).toBe(1);
		expect(Searcher.trigramSimilarity(trigramSet('abcdef'), trigramSet('uvwxyz'))).toBe(0);
	});

	it('is |A ∩ B| / |A ∪ B|', () => {
		const a = new Set(['abc', 'bcd']);
		const b = new Set(['bcd', 'cde']);
		expect(Searcher.trigramSimilarity(a, b)).toBeCloseTo(1 / 3, 12);
		expect(Searcher.trigramSimilarity(b, a)).toBeCloseTo(1 / 3, 12);
	});

	it('is 0 when either side is empty', () => {
		expect(Searcher.trigramSimilarity(new Set(), new Set(['abc']))).toBe(0);
		expect(Searcher.trigramSimilarity(new Set(['abc']), new Set())).toBe(0);
		expect(Searcher.trigramSimilarity(new Set(), new Set())).toBe(0);
	});

	it('clears the tuning floor for the misspellings the plan names', () => {
		const floor = DEFAULT_TUNING.fuzzyTrigramSimilarity;
		expect(Searcher.trigramSimilarity(trigramSet('kafeemaschine'), trigramSet('kaffeemaschine'))).toBeGreaterThan(
			floor,
		);
		expect(
			Searcher.trigramSimilarity(trigramSet('espresomaschine'), trigramSet('espressomaschine')),
		).toBeGreaterThan(floor);
	});
});

/* ========================================================================== */
/* damerauLevenshteinWithin                                                   */
/* ========================================================================== */

describe('Searcher.damerauLevenshteinWithin', () => {
	it('is 0 for equal strings', () => {
		expect(Searcher.damerauLevenshteinWithin('kaffee', 'kaffee', 2)).toBe(0);
		expect(Searcher.damerauLevenshteinWithin('', '', 0)).toBe(0);
	});

	it('counts one deletion, insertion or substitution as 1', () => {
		expect(Searcher.damerauLevenshteinWithin('kaffee', 'kaffe', 2)).toBe(1);
		expect(Searcher.damerauLevenshteinWithin('kaffe', 'kaffee', 2)).toBe(1);
		expect(Searcher.damerauLevenshteinWithin('kaffee', 'kaffek', 2)).toBe(1);
	});

	it('counts an adjacent transposition as 1', () => {
		expect(Searcher.damerauLevenshteinWithin('form', 'from', 2)).toBe(1);
		expect(Searcher.damerauLevenshteinWithin('from', 'form', 2)).toBe(1);
		expect(Searcher.damerauLevenshteinWithin('espressomaschine', 'espressomaschien', 2)).toBe(1);
	});

	it('adds up independent edits', () => {
		expect(Searcher.damerauLevenshteinWithin('kaffeemaschine', 'kafeemaschine', 2)).toBe(1);
		expect(Searcher.damerauLevenshteinWithin('kaffeemaschine', 'kafemaschine', 2)).toBe(2);
		expect(Searcher.damerauLevenshteinWithin('kitten', 'sitting', 3)).toBe(3);
	});

	it('returns maxDistance + 1 once the budget is exceeded', () => {
		expect(Searcher.damerauLevenshteinWithin('kaffee', 'tee', 1)).toBe(2);
		expect(Searcher.damerauLevenshteinWithin('kitten', 'sitting', 2)).toBe(3);
		expect(Searcher.damerauLevenshteinWithin('form', 'from', 0)).toBe(1);
		expect(Searcher.damerauLevenshteinWithin('a', 'a', 0)).toBe(0);
	});

	it('handles an empty side within and beyond the budget', () => {
		expect(Searcher.damerauLevenshteinWithin('', 'ab', 2)).toBe(2);
		expect(Searcher.damerauLevenshteinWithin('ab', '', 1)).toBe(2);
		expect(Searcher.damerauLevenshteinWithin('abc', '', 2)).toBe(3);
	});

	it('is symmetric', () => {
		for (const [a, b] of [
			['kaffeemaschine', 'kafeemaschine'],
			['form', 'from'],
			['kellner', 'kellen'],
			['abc', 'cba'],
		] as const) {
			expect(Searcher.damerauLevenshteinWithin(a, b, 3)).toBe(Searcher.damerauLevenshteinWithin(b, a, 3));
		}
	});

	it('gives up on the band instead of filling the matrix', () => {
		// A full 20 000 x 20 000 matrix is four hundred million cells; the band
		// is exhausted after two rows. The bound is generous on purpose — this
		// asserts an algorithmic difference of five orders of magnitude, not a
		// particular machine's speed.
		const a = 'x'.repeat(20_000);
		const b = 'y'.repeat(20_000);
		const started = Date.now();
		expect(Searcher.damerauLevenshteinWithin(a, b, 1)).toBe(2);
		expect(Date.now() - started).toBeLessThan(500);
	});

	it('short-circuits on the length difference alone', () => {
		expect(Searcher.damerauLevenshteinWithin('a'.repeat(50_000), 'a', 2)).toBe(3);
	});
});
