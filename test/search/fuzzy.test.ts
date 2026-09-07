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

/* -------------------------------------------------------------------------- */
/* The dropped-letter corpus                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One word per note, of every length band the distance budget distinguishes.
 *
 * Hand-built rather than taken from the generated vault so the suite does not
 * depend on which words happen to be on disk: here the ONLY thing that can
 * answer `heiung` is the `Heizung` in note 0, and the surrounding sentence is
 * the same in every note so it cannot answer anything by itself.
 */
const DELETION_WORDS: readonly string[] = [
	'Pumpe',
	'Kueche',
	'Heizung',
	'Kitchen',
	'Lueftung',
	'Kaffeemaschine',
];

/** Vault-relative path of the note that carries `DELETION_WORDS[index]`. */
function deletionPath(index: number): string {
	return `Woerter/Notiz ${index}.md`;
}

const DELETION_VAULT: Record<string, FakeFileSpec> = Object.fromEntries(
	DELETION_WORDS.map((word, index) => [
		deletionPath(index),
		{
			content: [`# Notiz ${index}`, '', `Hier steht ${word} und sonst nichts von Belang.`].join('\n'),
			ctime: 1_700_000_100_000 + index,
		},
	]),
);

/** Every single-letter deletion of `word`, deduplicated (a doubled letter yields the same word twice). */
function singleLetterDeletions(word: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < word.length; i++) {
		const deleted = word.slice(0, i) + word.slice(i + 1);
		if (out.indexOf(deleted) < 0) out.push(deleted);
	}
	return out;
}

/** `[word, deletion, path]` for every word in {@link DELETION_WORDS} and every deletion of it. */
function deletionCases(): Array<[string, string, string]> {
	const cases: Array<[string, string, string]> = [];
	DELETION_WORDS.forEach((word, index) => {
		for (const deleted of singleLetterDeletions(word)) {
			cases.push([word, deleted, deletionPath(index)]);
		}
	});
	return cases;
}

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
let deletions: Harness;
let vault: LoadedVault;
let fixture: Harness;

beforeAll(async () => {
	small = await buildHarness(FUZZY_VAULT);
	deletions = await buildHarness(DELETION_VAULT);
	vault = loadVault(undefined, VAULT_NOTES);
	fixture = await buildHarness(vault.files);
}, 120_000);

afterAll(() => {
	small?.indexer.stop();
	deletions?.indexer.stop();
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
/* A dropped letter                                                           */
/* ========================================================================== */

/**
 * The bug the owner reported: "Similar" finding nothing for a word with one
 * letter missing. Of 209 single-letter deletions across the generated vault,
 * six came back empty — every one of them from a short or medium word, while
 * long words always worked. The asymmetry was the tell: the candidate filter
 * asked for a constant SHARE of the term's trigrams, and one edit destroys up
 * to three trigrams however long the word is, so the surviving share falls with
 * the term's length. The six are pinned here by name, and the property below
 * covers the rest.
 */
describe('Searcher — a single dropped letter', () => {
	const REPORTED: Array<[string, string, number]> = [
		['Heizung', 'heiung', 2],
		['Heizung', 'heizng', 2],
		['Heizung', 'heizug', 2],
		['Pumpe', 'pmpe', 0],
		['Pumpe', 'pupe', 0],
		['Kitchen', 'kitcen', 3],
	];

	it.each(REPORTED)('finds %s for "%s"', (word, deleted, index) => {
		const hits = run(deletions.searcher, deleted, true);
		expect(paths(hits), `${deleted} -> ${word}`).toContain(deletionPath(index));
	});

	it('reaches the file through the candidate step, not only through the scan', () => {
		for (const [, deleted, index] of REPORTED) {
			const term = parseQuery(deleted, DEFAULT_TUNING).terms[0];
			const file = deletions.indexer.getFileByPath(deletionPath(index));
			if (file === undefined) throw new Error(`fixture note missing for "${deleted}"`);
			// A file the candidate step drops is never verified at all, so this is
			// the assertion that actually pins the fix.
			expect(deletions.searcher.candidates(term, true).has(file.id), deleted).toBe(true);
		}
	});

	/**
	 * The general property, and the one that would have caught the regression:
	 * whatever the word's length, dropping one letter from it still finds it.
	 */
	it.each(deletionCases())('finds %s for "%s", one letter short', (word, deleted, path) => {
		const hits = run(deletions.searcher, deleted, true);
		expect(paths(hits), `${deleted} -> ${word}`).toContain(path);
	});

	it('does not turn the switch into a match-everything toggle', () => {
		// A word that is not a deletion of anything in the corpus stays unanswered,
		// so the widened candidate set is still filtered by the distance pass.
		expect(run(deletions.searcher, 'zylinderkopfdichtung', true)).toEqual([]);
		expect(run(deletions.searcher, 'xyzzyfoo', true)).toEqual([]);
	});
});

/* ========================================================================== */
/* sharedTrigramFloor                                                         */
/* ========================================================================== */

describe('Searcher.sharedTrigramFloor', () => {
	it('is the term trigram count less three per edit', () => {
		expect(Searcher.sharedTrigramFloor(11, 2)).toBe(5);
		expect(Searcher.sharedTrigramFloor(12, 2)).toBe(6);
		expect(Searcher.sharedTrigramFloor(8, 1)).toBe(5);
	});

	it('admits the long misspellings the plan names', () => {
		// A dropped letter in a long word is the case the old share handled well,
		// and the bound has to keep handling it: "kaffeemschine" has 11 trigrams,
		// keeps 9 of them, and the floor is 5.
		const term = trigramSet('kaffeemschine');
		const file = trigramSet('kaffeemaschine');
		let shared = 0;
		for (const gram of term) {
			if (file.has(gram)) shared++;
		}
		expect(term.size).toBe(11);
		expect(shared).toBe(9);
		expect(Searcher.sharedTrigramFloor(term.size, DEFAULT_TUNING.fuzzyMaxDistanceLong)).toBe(5);
		expect(shared).toBeGreaterThanOrEqual(Searcher.sharedTrigramFloor(term.size, DEFAULT_TUNING.fuzzyMaxDistanceLong));
	});

	it('proves nothing for the short terms that used to be rejected', () => {
		// "heizng": 4 trigrams, budget 2. "pmpe": 2 trigrams, budget 1. Under the
		// old 0.6 share both kept exactly half and were dropped; the bound says
		// there is nothing to filter on.
		expect(trigramSet('heizng').size).toBe(4);
		expect(Searcher.sharedTrigramFloor(4, DEFAULT_TUNING.fuzzyMaxDistanceLong)).toBeLessThanOrEqual(0);
		expect(trigramSet('pmpe').size).toBe(2);
		expect(Searcher.sharedTrigramFloor(2, DEFAULT_TUNING.fuzzyMaxDistanceShort)).toBeLessThanOrEqual(0);
	});

	it('survives a hand-edited tuning object', () => {
		expect(Searcher.sharedTrigramFloor(Number.NaN, 2)).toBe(0);
		expect(Searcher.sharedTrigramFloor(11, Number.POSITIVE_INFINITY)).toBe(0);
		// A negative budget cannot buy back trigrams.
		expect(Searcher.sharedTrigramFloor(11, -5)).toBe(11);
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
