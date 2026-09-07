/**
 * Searcher tests — retrieval, verification and the offset contract.
 *
 * WHY A REAL INDEXER: the Searcher's whole job is to read the index the way the
 * Indexer wrote it — trigram postings in both representations, `IndexedFile`
 * records with their spans, the alias postings that make the ä/ae round trip
 * work. A hand-built stub index would only prove that the Searcher agrees with
 * the test's idea of an index, which is exactly the class of bug this suite has
 * to catch. Every case therefore builds a real index over a real (fake) vault.
 *
 * WHY fake-indexeddb AND A WINDOW SHIM: the Indexer opens a Store and schedules
 * its build slices through `window`. Neither exists in the node environment, so
 * the two are shimmed here the same way `test/index/indexer.test.ts` does.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import 'fake-indexeddb/auto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Indexer } from '../../src/index/Indexer';
import { stripFold } from '../../src/index/Normalizer';
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

/** The slice of `window` the Indexer's scheduler touches. */
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
	const store = new Store(`searcher-${storeCounter}-${Date.now()}`);
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

function run(searcher: Searcher, query: string, overrides: Partial<SearchOptions> = {}): RawHit[] {
	return searcher.search(parseQuery(query, DEFAULT_TUNING), options(overrides));
}

function paths(hits: readonly RawHit[]): string[] {
	return hits.map((hit) => hit.path).sort();
}

function matchesOf(hit: RawHit, field: Match['field']): Match[] {
	return hit.matches.filter((match) => match.field === field);
}

/**
 * The fold the offset contract has to survive.
 *
 * NFC first, because three of the fixture notes are stored decomposed: there the
 * original slice carries the combining mark that the index dropped, and
 * composing it is precisely what `termVariants` does to the query before the two
 * are compared.
 */
function foldSlice(original: string, match: Match): string {
	return stripFold(original.slice(match.start, match.end).normalize('NFC'));
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const NOTE_ONE = [
	'---',
	'created: 2024-03-01',
	'tags: [protokoll, norm/sia]',
	'---',
	'',
	'# Die Wärmepumpe',
	'',
	'In der Küche steht die Espressomaschine an der Straße.',
	'Ein Gruß mit Weiß und #lüftung.',
].join('\n');

const NOTE_TWO = [
	'# Zweite Notiz',
	'',
	'Hier steht Kueche als ASCII und die Wärmepumpe im Altbau.',
	'Das Protokoll liegt vor.',
].join('\n');

const NOTE_THREE = ['# Dritte Notiz', '', 'Die Wärmepumpe in einer Altbauwohnung.'].join('\n');

/** Two whitespace traps at once: a blanked `**` inside a phrase, and a phrase across a line break. */
const NOTE_FOUR = ['# Vierte Notiz', '', 'Die  **Wärme**pumpe   steht', 'im Keller.'].join('\n');

/**
 * Block edges a phrase must not cross: a heading line, the frontmatter fence and
 * a plain paragraph break. Folding turns every line break into a space, so
 * without the block rule `"wärme pumpe"` matched all three of these.
 */
const BLOCK_VAULT: Record<string, FakeFileSpec> = {
	// Heading ends on the first word, the paragraph under it opens with the second.
	'Blöcke/Titel.md': { content: '# Wärme\n\nPumpe im Keller.\n' },
	// Two paragraphs of ordinary body text.
	'Blöcke/Absatz.md': { content: 'Ende mit Wärme\n\nPumpe am Anfang.\n' },
	// Frontmatter value and the first body word.
	'Blöcke/Vorspann.md': { content: '---\ntitel: Wärme\n---\n\nPumpe steht hier.\n' },
	// The control: the phrase really is in this one, inside a single paragraph.
	'Blöcke/Echt.md': { content: '# Notiz\n\nDie Wärme Pumpe steht im Keller.\n' },
	// The phrase inside one heading line stays a hit.
	'Blöcke/Imtitel.md': { content: '## Wärme Pumpe im Altbau\n\nText.\n' },
};

const SMALL_VAULT: Record<string, FakeFileSpec> = {
	'Kaffee/Notiz eins.md': { content: NOTE_ONE, ctime: 1_700_000_000_000 },
	'Kaffee/Notiz zwei.md': { content: NOTE_TWO, ctime: 1_700_000_001_000 },
	'Archiv/Notiz drei.md': { content: NOTE_THREE, ctime: 1_700_000_002_000 },
	'Archiv/Alt/Notiz vier.md': { content: NOTE_FOUR, ctime: 1_700_000_003_000 },
};

const ONE = 'Kaffee/Notiz eins.md';
const TWO = 'Kaffee/Notiz zwei.md';
const THREE = 'Archiv/Notiz drei.md';
const FOUR = 'Archiv/Alt/Notiz vier.md';

let small: Harness;
let vault: LoadedVault;
let fixture: Harness;

/**
 * How many fixture notes this suite indexes.
 *
 * `loadVault` takes a deterministic prefix, so these are byte for byte the notes
 * `tsx test/fixtures/generate.ts --count 600` writes — a vault big enough to
 * carry every property this file asserts (infixes, aliases, decomposed notes,
 * both postings representations) and small enough that the runtime does not
 * depend on how many notes happen to be on disk. Without the limit the suite
 * scaled with the ambient vault: after `npm run bench`, which regenerates the
 * SAME directory at 10 000 notes, the NFD test below ran into vitest's 5 s
 * default and the whole suite went red on a passing engine.
 */
const VAULT_NOTES = 600;

beforeAll(async () => {
	small = await buildHarness(SMALL_VAULT);
	vault = loadVault(undefined, VAULT_NOTES);
	fixture = await buildHarness(vault.files);
}, 120_000);

afterAll(() => {
	small?.indexer.stop();
	fixture?.indexer.stop();
});

/* ========================================================================== */
/* Acceptance                                                                 */
/* ========================================================================== */

describe('Searcher — infix retrieval', () => {
	it('finds a true infix: "maschine" hits "Espressomaschine"', () => {
		const hits = run(small.searcher, 'maschine');
		expect(paths(hits)).toEqual([ONE]);
		const body = matchesOf(hits[0], 'body');
		expect(body.length).toBe(1);
		expect(NOTE_ONE.slice(body[0].start, body[0].end)).toBe('maschine');
		expect(body[0].quality).toBe('exact');
		// The hit sits inside a longer word, so it is not a whole word.
		expect(body[0].wholeWord).toBe(false);
	});

	it('finds the same infix across the generated vault', () => {
		const hits = run(fixture.searcher, 'maschine');
		expect(hits.length).toBeGreaterThan(20);
		const expected = new Set(
			Object.keys(vault.files).filter((path) => stripFold(vault.files[path].content).includes('maschine')),
		);
		for (const hit of hits) {
			const hasBody = hit.matches.some((match) => match.field === 'body' || match.field === 'heading');
			if (hasBody) expect(expected.has(hit.path)).toBe(true);
		}
		for (const path of expected) {
			expect(hits.some((hit) => hit.path === path)).toBe(true);
		}
	});

	it('reports whole-word hits as such', () => {
		const hits = run(small.searcher, 'keller');
		expect(paths(hits)).toEqual([FOUR]);
		const body = matchesOf(hits[0], 'body');
		expect(body.length).toBe(1);
		expect(body[0].wholeWord).toBe(true);
	});
});

/* ========================================================================== */
/* Alias round trip                                                           */
/* ========================================================================== */

describe('Searcher — alias round trip', () => {
	it('"kueche" finds a note written "Küche" and calls it alias', () => {
		const hits = run(small.searcher, 'kueche');
		expect(paths(hits)).toEqual([ONE, TWO].sort());
		const one = hits.find((hit) => hit.path === ONE);
		expect(one?.quality).toBe('alias');
		const body = matchesOf(one as RawHit, 'body');
		expect(body.length).toBe(1);
		expect(NOTE_ONE.slice(body[0].start, body[0].end)).toBe('Küche');
		expect(body[0].quality).toBe('alias');
	});

	it('"küche" finds a note written "Kueche" and calls it alias', () => {
		const hits = run(small.searcher, 'küche');
		const two = hits.find((hit) => hit.path === TWO);
		expect(two).toBeDefined();
		expect(two?.quality).toBe('alias');
		const body = matchesOf(two as RawHit, 'body');
		expect(body.length).toBe(1);
		expect(NOTE_TWO.slice(body[0].start, body[0].end)).toBe('Kueche');
		// The note written with the umlaut matched the user's own spelling.
		const one = hits.find((hit) => hit.path === ONE);
		expect(one?.quality).toBe('exact');
	});

	it('"strasse" finds "Straße" and calls it alias', () => {
		const hits = run(small.searcher, 'strasse');
		expect(paths(hits)).toEqual([ONE]);
		expect(hits[0].quality).toBe('alias');
		const body = matchesOf(hits[0], 'body');
		expect(NOTE_ONE.slice(body[0].start, body[0].end)).toBe('Straße');
	});

	it('finds every ß/ss and umlaut pair in the generated vault', () => {
		for (const [query, spelling] of [
			['strasse', 'Straße'],
			['groesse', 'Größe'],
			['ueberpruefung', 'Überprüfung'],
			['massnahme', 'Maßnahme'],
		] as const) {
			const hits = run(fixture.searcher, query);
			const found = hits.some((hit) =>
				hit.matches.some(
					(match) =>
						(match.field === 'body' || match.field === 'heading') &&
						vault.files[hit.path].content.slice(match.start, match.end).normalize('NFC') === spelling,
				),
			);
			expect(found, `${query} -> ${spelling}`).toBe(true);
		}
	});
});

/* ========================================================================== */
/* The offset regression net                                                  */
/* ========================================================================== */

describe('Searcher — offsets map back to the original text', () => {
	/** Word terms only: a phrase spans whitespace runs whose source may be blanked markdown. */
	const QUERIES = [
		'maschine',
		'pumpe',
		'heizung',
		'anlage',
		'küche',
		'kueche',
		'strasse',
		'straße',
		'weiss',
		'grösse',
		'überprüfung',
		'protokoll',
		'norm',
		'espresso',
		'building',
		'wasser',
		'ku',
		'öl',
	];

	it('every body, heading, frontmatter and tag match folds back to a term variant', () => {
		let checked = 0;
		for (const query of QUERIES) {
			const ast = parseQuery(query, DEFAULT_TUNING);
			const variants = new Set(ast.terms[0].variants);
			for (const hit of fixture.searcher.search(ast, options())) {
				const original = vault.files[hit.path].content;
				for (const match of hit.matches) {
					if (match.field === 'title' || match.field === 'path') continue;
					const folded = foldSlice(original, match);
					expect(variants.has(folded), `${query} in ${hit.path}: "${folded}"`).toBe(true);
					checked++;
				}
			}
		}
		// Guards the guard: an assertion that never ran would pass silently.
		expect(checked).toBeGreaterThan(500);
	});

	it('title and path offsets index into the normalized title and path', () => {
		const hits = run(fixture.searcher, 'wärmepumpe');
		let titles = 0;
		let pathHits = 0;
		for (const hit of hits) {
			const file = fixture.indexer.getFileByPath(hit.path);
			expect(file).toBeDefined();
			for (const match of hit.matches) {
				if (match.field === 'title') {
					expect(file?.titleNormalized.slice(match.start, match.end)).toBe('warmepumpe');
					titles++;
				}
				if (match.field === 'path') {
					expect(file?.pathNormalized.slice(match.start, match.end)).toBe('warmepumpe');
					pathHits++;
				}
			}
		}
		expect(titles).toBeGreaterThan(0);
		expect(pathHits).toBeGreaterThan(0);
	});

	/**
	 * One search per query, not one per note.
	 *
	 * The search used to sit inside the loop over decomposed notes, so the cost
	 * was O(NFD notes × queries × vault size) and the test timed out on a large
	 * fixture while asserting nothing. Bucketing the hits by path measures the
	 * same thing in five searches instead of hundreds.
	 */
	it('maps through the offset map of an NFD note', () => {
		// A note written decomposed only needs a map when a combining mark
		// actually survived into its text; some of the generated ones are plain
		// ASCII and keep `offsetMap === null`, which is the identity path.
		const decomposed = new Set(
			(vault.manifest?.notes ?? [])
				.filter((note) => note.nfd && (fixture.indexer.getFileByPath(note.path)?.offsetMap ?? null) !== null)
				.map((note) => note.path),
		);
		expect(decomposed.size).toBeGreaterThan(0);
		let seen = 0;
		for (const query of ['küche', 'grösse', 'maschine', 'pumpe', 'strasse']) {
			const ast = parseQuery(query, DEFAULT_TUNING);
			const variants = new Set(ast.terms[0].variants);
			for (const hit of fixture.searcher.search(ast, options())) {
				if (!decomposed.has(hit.path)) continue;
				const original = vault.files[hit.path].content;
				for (const match of hit.matches) {
					if (match.field === 'title' || match.field === 'path') continue;
					expect(variants.has(foldSlice(original, match)), `${query} in ${hit.path}`).toBe(true);
					seen++;
				}
			}
		}
		expect(seen).toBeGreaterThan(0);
	});
});

/* ========================================================================== */
/* Phrases and exclusion                                                      */
/* ========================================================================== */

describe('Searcher — phrases and exclusion', () => {
	it('"wärmepumpe" -altbau excludes by substring, altbauwohnung included', () => {
		const hits = run(small.searcher, '"wärmepumpe" -altbau');
		expect(paths(hits)).toEqual([ONE]);
		// Both excluded notes DO contain the phrase; only the exclusion removes them.
		expect(paths(run(small.searcher, '"wärmepumpe"'))).toEqual([ONE, THREE, TWO].sort());
	});

	it('matches a phrase across a blanked markdown run', () => {
		const hits = run(small.searcher, '"wärme pumpe"');
		expect(paths(hits)).toEqual([FOUR]);
		const body = matchesOf(hits[0], 'body');
		expect(body.length).toBe(1);
		expect(NOTE_FOUR.slice(body[0].start, body[0].end)).toBe('Wärme**pumpe');
	});

	it('matches a phrase across a line break', () => {
		const hits = run(small.searcher, '"pumpe steht im keller"');
		expect(paths(hits)).toEqual([FOUR]);
		const body = matchesOf(hits[0], 'body');
		expect(NOTE_FOUR.slice(body[0].start, body[0].end)).toBe('pumpe   steht\nim Keller');
	});

	it('never runs two phrase words together', () => {
		expect(run(small.searcher, '"wärme pumpe"').some((hit) => hit.path === ONE)).toBe(false);
	});

	/**
	 * A phrase gap may swallow a line break and blanked markdown, but not a block
	 * edge: the words either side of a heading line or of the frontmatter fence
	 * are not the phrase the user typed, and the card would put one `<mark>`
	 * around text the note does not contain.
	 */
	it('never matches a phrase across a heading or the frontmatter fence', async () => {
		const blocks = await buildHarness(BLOCK_VAULT);
		const hits = paths(run(blocks.searcher, '"wärme pumpe"'));

		expect(hits).not.toContain('Blöcke/Titel.md');
		expect(hits).not.toContain('Blöcke/Vorspann.md');
		// Still found: the note that really carries the phrase, and the one that
		// carries it inside a single heading line.
		expect(hits).toContain('Blöcke/Echt.md');
		expect(hits).toContain('Blöcke/Imtitel.md');

		// The control proves the words are all indexed and reachable separately.
		expect(paths(run(blocks.searcher, 'wärme pumpe')).length).toBe(5);
		blocks.indexer.stop();
	});

	/**
	 * The hardest of the three edges, and the one the Searcher cannot see: after
	 * folding, `\n\n` is the same two spaces a blanked `**` leaves behind — and
	 * the `**` case two tests up must keep matching. The separation therefore has
	 * to come from the index, as `IndexedFile.blockBreaks`, which the Normalizer
	 * fills while the source is still intact.
	 *
	 * The note carries no frontmatter and no heading, so nothing but the block
	 * breaks can reject it: it is the case that isolates them.
	 */
	it('does not match a phrase across a blank line between two paragraphs', async () => {
		const blocks = await buildHarness(BLOCK_VAULT);
		const hits = paths(run(blocks.searcher, '"wärme pumpe"'));

		expect(hits).not.toContain('Blöcke/Absatz.md');
		// The two notes that really carry the phrase are untouched, so the rule
		// rejects a block edge and not simply a wide gap.
		expect(hits).toContain('Blöcke/Echt.md');
		expect(hits).toContain('Blöcke/Imtitel.md');
		// Both words are still indexed and reachable on their own.
		expect(paths(run(blocks.searcher, 'wärme pumpe')).length).toBe(5);
		blocks.indexer.stop();
	});

	/**
	 * The four gaps a phrase IS allowed to close, in one place: a blanked `**`, a
	 * single line break, a run of plain spaces, and a phrase that sits inside one
	 * heading. Every one of them is intra-block, and an over-strict block rule
	 * would break them — which is what this test is here to catch.
	 */
	it('still closes every gap that stays inside one block', async () => {
		expect(paths(run(small.searcher, '"wärme pumpe"'))).toEqual([FOUR]);
		expect(paths(run(small.searcher, '"pumpe steht"'))).toEqual([FOUR]);
		expect(paths(run(small.searcher, '"pumpe steht im keller"'))).toEqual([FOUR]);

		const blocks = await buildHarness(BLOCK_VAULT);
		expect(paths(run(blocks.searcher, '"wärme pumpe im altbau"'))).toEqual(['Blöcke/Imtitel.md']);
		blocks.indexer.stop();
	});

	it('keeps matching a phrase that sits inside one heading', async () => {
		const blocks = await buildHarness(BLOCK_VAULT);
		const hits = run(blocks.searcher, '"pumpe im altbau"');

		expect(paths(hits)).toEqual(['Blöcke/Imtitel.md']);
		const match = hits[0].matches[0];
		expect(BLOCK_VAULT['Blöcke/Imtitel.md'].content.slice(match.start, match.end)).toBe('Pumpe im Altbau');
		blocks.indexer.stop();
	});

	it('drops a file that matches the exclusion in its path', () => {
		expect(paths(run(small.searcher, 'notiz -path:archiv'))).toEqual([ONE, TWO].sort());
	});
});

/* ========================================================================== */
/* Boolean shape                                                              */
/* ========================================================================== */

describe('Searcher — query shape', () => {
	it('ANDs must terms', () => {
		// Note two carries the phrase as well, but not the second term.
		expect(paths(run(small.searcher, '"wärmepumpe" espressomaschine'))).toEqual([ONE]);
		expect(run(small.searcher, 'wärmepumpe hongkong')).toEqual([]);
	});

	it('takes one member of an OR group', () => {
		expect(paths(run(small.searcher, 'espressomaschine OR altbauwohnung'))).toEqual([ONE, THREE].sort());
	});

	it('indexes matches by their position in ast.terms', () => {
		const ast = parseQuery('wärmepumpe espressomaschine', DEFAULT_TUNING);
		const hits = small.searcher.search(ast, options());
		expect(hits.length).toBe(1);
		const used = new Set(hits[0].matches.map((match) => match.termIndex));
		expect([...used].sort()).toEqual([0, 1]);
		for (const match of hits[0].matches) {
			expect(ast.terms[match.termIndex]).toBeDefined();
		}
	});

	it('returns nothing for an empty query', () => {
		expect(run(small.searcher, '')).toEqual([]);
		expect(run(small.searcher, '   ')).toEqual([]);
	});

	it('orders matches by start and never overlaps within one term and field', () => {
		const hits = run(fixture.searcher, 'pumpe heizung');
		expect(hits.length).toBeGreaterThan(0);
		for (const hit of hits) {
			for (let i = 1; i < hit.matches.length; i++) {
				expect(hit.matches[i].start).toBeGreaterThanOrEqual(hit.matches[i - 1].start);
			}
			const lastEnd = new Map<string, number>();
			for (const match of hit.matches) {
				const key = `${match.termIndex}|${match.field}`;
				const previous = lastEnd.get(key);
				if (previous !== undefined) expect(match.start).toBeGreaterThanOrEqual(previous);
				lastEnd.set(key, match.end);
			}
		}
	});
});

/* ========================================================================== */
/* Field-restricted terms                                                     */
/* ========================================================================== */

describe('Searcher — field restriction', () => {
	it('title: searches only the title', () => {
		const hits = run(small.searcher, 'title:zwei');
		expect(paths(hits)).toEqual([TWO]);
		expect(hits[0].matches.every((match) => match.field === 'title')).toBe(true);
		// The word occurs in no title, only in a body.
		expect(run(small.searcher, 'title:espressomaschine')).toEqual([]);
	});

	it('path: searches only the path', () => {
		const hits = run(small.searcher, 'path:archiv');
		expect(paths(hits)).toEqual([FOUR, THREE].sort());
		expect(hits[0].matches.every((match) => match.field === 'path')).toBe(true);
	});

	it('tag: matches frontmatter tags, inline tags and nested tags', () => {
		expect(paths(run(small.searcher, 'tag:protokoll'))).toEqual([ONE]);
		expect(paths(run(small.searcher, 'tag:sia'))).toEqual([ONE]);
		expect(paths(run(small.searcher, 'tag:lüftung'))).toEqual([ONE]);
	});

	it('tag: reports the field and points at the tag in the file', () => {
		const hits = run(small.searcher, 'tag:protokoll');
		const match = hits[0].matches[0];
		expect(match.field).toBe('tag');
		expect(NOTE_ONE.slice(match.start, match.end)).toBe('protokoll');
		// The plain word in the OTHER note is not a tag and must not match.
		expect(hits.some((hit) => hit.path === TWO)).toBe(false);
	});

	it('an unrestricted term also reaches title and path', () => {
		const hits = run(small.searcher, 'eins');
		expect(paths(hits)).toEqual([ONE]);
		const fields = new Set(hits[0].matches.map((match) => match.field));
		expect(fields.has('title')).toBe(true);
		expect(fields.has('path')).toBe(true);
	});

	/**
	 * A tag written decomposed used to be reachable by no query at all: the tag
	 * list kept the combining mark that the document text drops, and the query
	 * side composes before folding, so nothing the user could type ever met it.
	 * Both spellings of the note must answer both spellings of the query.
	 */
	it('finds a decomposed tag through tag:, whichever way the query is typed', async () => {
		// Built through `normalize('NFD')` rather than pasted, so no editor and no
		// tool can quietly compose the fixture back and hide the case.
		const nfd = (text: string): string => text.normalize('NFD');
		const content = '---\ntags: [küche]\n---\n\nEin #lüftung Tag.\n';
		const tagged = await buildHarness({
			// Frontmatter tag and inline tag, both carrying a combining mark.
			'Notizen/NFD.md': { content: nfd(content) },
			'Notizen/NFC.md': { content: content.normalize('NFC') },
		});
		const both = ['Notizen/NFC.md', 'Notizen/NFD.md'];

		for (const query of ['tag:küche', nfd('tag:küche'), 'tag:kueche', 'tag:lüftung']) {
			expect(paths(run(tagged.searcher, query)), query).toEqual(both);
		}

		expect(tagged.indexer.getFileByPath('Notizen/NFD.md')?.tags).toEqual(['kuche', 'luftung']);
		tagged.indexer.stop();
	});
});

/* ========================================================================== */
/* Short terms                                                                */
/* ========================================================================== */

describe('Searcher — short terms', () => {
	it('takes the linear path and still returns correct offsets', () => {
		const ast = parseQuery('ku', DEFAULT_TUNING);
		expect(ast.terms[0].short).toBe(true);
		expect(ast.terms[0].trigrams).toEqual([]);
		const hits = small.searcher.search(ast, options());
		expect(hits.some((hit) => hit.path === ONE)).toBe(true);
		for (const hit of hits) {
			const original = SMALL_VAULT[hit.path].content;
			for (const match of hit.matches) {
				if (match.field === 'title' || match.field === 'path') continue;
				expect(stripFold(original.slice(match.start, match.end).normalize('NFC'))).toBe('ku');
			}
		}
	});

	it('hands back every file for a term without trigrams', () => {
		const ast = parseQuery('ku', DEFAULT_TUNING);
		expect(small.searcher.candidates(ast.terms[0], false).size).toBe(small.indexer.fileCount());
	});

	it('combines a short term with a long one', () => {
		expect(paths(run(small.searcher, 'espressomaschine ku'))).toEqual([ONE]);
	});
});

/* ========================================================================== */
/* fieldAt                                                                    */
/* ========================================================================== */

describe('Searcher.fieldAt', () => {
	it('separates frontmatter, heading and body on half-open boundaries', () => {
		const file = small.indexer.getFileByPath(ONE);
		expect(file).toBeDefined();
		if (file === undefined) return;

		const frontmatter = file.frontmatterSpan;
		expect(frontmatter).not.toBeNull();
		if (frontmatter === null) return;
		expect(Searcher.fieldAt(file, frontmatter.start)).toBe('frontmatter');
		expect(Searcher.fieldAt(file, frontmatter.end - 1)).toBe('frontmatter');
		expect(Searcher.fieldAt(file, frontmatter.end)).toBe('body');

		expect(file.headings.length).toBe(1);
		const heading = file.headings[0].span;
		expect(Searcher.fieldAt(file, heading.start - 1)).toBe('body');
		expect(Searcher.fieldAt(file, heading.start)).toBe('heading');
		expect(Searcher.fieldAt(file, heading.end - 1)).toBe('heading');
		expect(Searcher.fieldAt(file, heading.end)).toBe('body');

		expect(Searcher.fieldAt(file, file.text.length - 1)).toBe('body');
	});

	it('finds the right heading among many', () => {
		const file = fixture.indexer.getFileByPath('Inbox/Bericht Wärmepumpe 103.md');
		expect(file).toBeDefined();
		if (file === undefined) return;
		expect(file.headings.length).toBeGreaterThan(1);
		for (const heading of file.headings) {
			expect(Searcher.fieldAt(file, heading.span.start)).toBe('heading');
			expect(Searcher.fieldAt(file, heading.textSpan.start)).toBe('heading');
			expect(Searcher.fieldAt(file, heading.span.end)).not.toBe('heading');
		}
	});

	it('reports the field of every match it produced', () => {
		const hits = run(small.searcher, 'wärmepumpe protokoll');
		const one = hits.find((hit) => hit.path === ONE);
		expect(one).toBeDefined();
		const fields = new Set(one?.matches.map((match) => match.field));
		expect(fields.has('heading')).toBe(true);
		expect(fields.has('frontmatter')).toBe(true);
	});
});

/* ========================================================================== */
/* Abort                                                                      */
/* ========================================================================== */

describe('Searcher — AbortSignal', () => {
	it('returns nothing for an already aborted search', () => {
		const controller = new AbortController();
		controller.abort();
		expect(run(small.searcher, 'wärmepumpe', { signal: controller.signal })).toEqual([]);
	});

	it('aborts between candidate batches and leaves no partial result', () => {
		expect(run(fixture.searcher, 'de').length).toBeGreaterThan(0);
		let reads = 0;
		const signal = {
			get aborted(): boolean {
				reads++;
				// False for the entry check, true at the first batch boundary.
				return reads > 1;
			},
		} as unknown as AbortSignal;
		expect(run(fixture.searcher, 'de', { signal })).toEqual([]);
		expect(reads).toBeGreaterThan(1);
	});
});

/* ========================================================================== */
/* Hit shape                                                                  */
/* ========================================================================== */

describe('Searcher — hit shape', () => {
	it('carries the record fields the Ranker sorts by', () => {
		const hits = run(small.searcher, 'espressomaschine');
		expect(hits.length).toBe(1);
		const file = small.indexer.getFileByPath(ONE);
		expect(hits[0]).toMatchObject({
			fileId: file?.id,
			path: ONE,
			title: 'Notiz eins',
			folder: 'Kaffee',
			createdAt: file?.createdAt,
			modifiedAt: file?.modifiedAt,
			quality: 'exact',
		});
	});

	it('takes the worst quality across the matches of a hit', () => {
		const hits = run(small.searcher, 'kueche');
		const one = hits.find((hit) => hit.path === ONE);
		expect(one?.matches.some((match) => match.quality === 'alias')).toBe(true);
		expect(one?.quality).toBe('alias');
	});
});
