/**
 * Indexer tests.
 *
 * WHY fake-indexeddb: the staleness contract ("a record whose mtime still
 * matches is never re-read") only means something across a real store round
 * trip. Every test that does not care about persistence gets a Store over a
 * fresh, empty database, so it cold-builds.
 *
 * WHY A WINDOW SHIM instead of the happy-dom environment: the Indexer schedules
 * its slices through `window` — `requestIdleCallback` where the platform has
 * one, `window.setTimeout(0)` otherwise. happy-dom would supply a window, but
 * it also rewrites `import.meta.url` to a non-file URL, and
 * `test/fixtures/generate.ts` resolves that at module scope, so importing the
 * fixture loader under happy-dom throws before a single test runs. The node
 * environment plus the two timer functions the scheduler actually calls keeps
 * the real fixture vault available; the default run therefore exercises the
 * mobile fallback, and one test installs an idle callback for the other branch.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Indexer } from '../../src/index/Indexer';
import { Store } from '../../src/index/Store';
import { DEFAULT_SETTINGS, DEFAULT_TUNING } from '../../src/settings';
import type { FileChange, IndexedFile, Postings, SiftSettings, SiftTuning, VaultPath } from '../../src/types';
import { createFakeApp, type FakeApp, type FakeFileSpec } from '../helpers/fakeVault';
import { loadVault } from '../fixtures/loadVault';

/* ========================================================================== */
/* Harness                                                                    */
/* ========================================================================== */

/** The slice of `window` the Indexer's scheduler touches. */
interface SchedulerWindow {
	setTimeout(handler: () => void, timeout?: number): number;
	clearTimeout(handle: number): void;
	requestIdleCallback?: (callback: () => void) => number;
	cancelIdleCallback?: (handle: number) => void;
}

const globalScope = globalThis as unknown as { window?: SchedulerWindow };

if (globalScope.window === undefined) {
	globalScope.window = {
		setTimeout: (handler: () => void, timeout?: number): number =>
			setTimeout(handler, timeout) as unknown as number,
		clearTimeout: (handle: number): void => {
			clearTimeout(handle as unknown as Parameters<typeof clearTimeout>[0]);
		},
	};
}

const schedulerWindow: SchedulerWindow = globalScope.window;

let storeCounter = 0;

/** A store over a database no other test has touched, so `start()` cold-builds. */
function freshStore(): Store {
	storeCounter += 1;
	return new Store(`indexer-${storeCounter}-${Date.now()}`);
}

function settingsWith(overrides: Partial<SiftSettings> = {}): SiftSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

function tuningWith(overrides: Partial<SiftTuning> = {}): SiftTuning {
	return { ...DEFAULT_TUNING, ...overrides };
}

interface Harness {
	app: FakeApp;
	store: Store;
	indexer: Indexer;
}

function harness(
	files: Record<string, FakeFileSpec>,
	overrides: { settings?: Partial<SiftSettings>; tuning?: Partial<SiftTuning>; store?: Store } = {},
): Harness {
	const app = createFakeApp(files);
	const store = overrides.store ?? freshStore();
	const indexer = new Indexer(
		app.asApp(),
		store,
		settingsWith(overrides.settings),
		tuningWith(overrides.tuning),
	);
	return { app, store, indexer };
}

function change(kind: FileChange['kind'], app: FakeApp, path: VaultPath, oldPath?: VaultPath): FileChange {
	const file = kind === 'deleted' ? null : app.vault.getFileByPath(path);
	const built: FileChange = { kind, file, path };
	if (oldPath !== undefined) built.oldPath = oldPath;
	return built;
}

function postingSize(postings: Postings): number {
	return postings instanceof Uint32Array ? postings.length : postings.size;
}

/** Every path the index holds a record for. Two entries for one path is the bug LIFE-01 describes. */
function indexedPaths(indexer: Indexer): string[] {
	return [...indexer.allFiles()].map((file) => file.path).sort(compareText);
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Comparison helper                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A representation-independent view of an index.
 *
 * FileIds are an implementation detail — an incrementally updated index hands
 * out different ones than a rebuild over the same vault — so postings are
 * translated to paths and everything is sorted before two snapshots are
 * compared. Postings also come in two shapes, `Set` and `Uint32Array`, which
 * `postingsToArray` flattens.
 */
interface IndexSnapshot {
	files: readonly unknown[];
	trigrams: readonly (readonly [string, readonly string[]])[];
}

function snapshot(indexer: Indexer): IndexSnapshot {
	const pathOf = new Map<number, string>();
	for (const file of indexer.allFiles()) pathOf.set(file.id, file.path);

	const files = [...indexer.allFiles()]
		.map((file) => ({
			path: file.path,
			title: file.title,
			titleNormalized: file.titleNormalized,
			folder: file.folder,
			pathNormalized: file.pathNormalized,
			text: file.text,
			offsetMap: file.offsetMap === null ? null : [...file.offsetMap],
			blockBreaks: file.blockBreaks === undefined ? null : [...file.blockBreaks],
			frontmatterSpan: file.frontmatterSpan,
			headings: file.headings.map((heading) => ({ ...heading })),
			tags: [...file.tags],
			words: file.words.packed,
			createdAt: file.createdAt,
			createdSource: file.createdSource,
			modifiedAt: file.modifiedAt,
			size: file.size,
			indexedMtime: file.indexedMtime,
		}))
		.sort((a, b) => compareText(a.path, b.path));

	const trigrams: Array<readonly [string, readonly string[]]> = [];
	for (const [key, postings] of indexer.trigrams) {
		const paths = [...Indexer.postingsToArray(postings)]
			.map((id) => pathOf.get(id) ?? `<unknown ${id}>`)
			.sort(compareText);
		trigrams.push([key, paths]);
	}
	trigrams.sort((a, b) => compareText(a[0], b[0]));

	return { files, trigrams };
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const GERMAN_NOTE = [
	'---',
	'created: 2026-03-14',
	'tags: [kaffee, kueche]',
	'---',
	'',
	'# Küche und Espressomaschine',
	'',
	'Die Küche an der Bahnhofstraße hat eine große Espressomaschine.',
].join('\n');

const ENGLISH_NOTE = ['# Coffee grinder', '', 'The coffee grinder sits next to the kettle.'].join('\n');

const STREET_NOTE = ['# Straße', '', 'Die Straße ist im Winter gesperrt.'].join('\n');

/**
 * Three notes that share no vocabulary: every word below occurs in exactly one
 * of them, so a record that outlives its file is visible as a posting.
 */
const REPLACE_VAULT: Record<string, FakeFileSpec> = {
	'A.md': { content: '# A\n\nAlpha mit Zebrastreifen.', ctime: 1_700_000_010_000 },
	'B.md': { content: '# B\n\nBravo mit Quallenfeld.', ctime: 1_700_000_011_000 },
	'C.md': { content: '# C\n\nCharlie mit Dachziegel.', ctime: 1_700_000_012_000 },
};

const BASE_VAULT: Record<string, FakeFileSpec> = {
	'Notizen/Küche.md': { content: GERMAN_NOTE, ctime: 1_700_000_000_000, mtime: 1_700_000_000_000 },
	'Notizen/Coffee.md': { content: ENGLISH_NOTE, ctime: 1_700_000_001_000, mtime: 1_700_000_001_000 },
	'Projekte/Strasse.md': { content: STREET_NOTE, ctime: 1_700_000_002_000, mtime: 1_700_000_002_000 },
	'Projekte2/Nachbar.md': { content: '# Nachbar\n\nEin Nachbarprojekt.', ctime: 1_700_000_003_000 },
	'Archiv/Alt.md': { content: '# Alt\n\nAlter Kram im Archiv.', ctime: 1_700_000_004_000 },
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/* ========================================================================== */
/* Tests                                                                      */
/* ========================================================================== */

describe('Indexer — cold build', () => {
	it('indexes every markdown file and reports usable statistics', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		await indexer.start();

		expect(indexer.isReady()).toBe(true);
		expect(indexer.fileCount()).toBe(5);
		expect([...indexer.allFiles()].map((file) => file.path).sort(compareText)).toEqual(app.paths());

		const stats = indexer.stats();
		expect(stats.fileCount).toBe(5);
		expect(stats.trigramCount).toBeGreaterThan(0);
		expect(stats.postingCount).toBeGreaterThanOrEqual(stats.trigramCount);
		expect(stats.compacted).toBe(true);
		expect(stats.builtAt).toBeGreaterThan(0);
		let expectedTextLength = 0;
		for (const file of indexer.allFiles()) expectedTextLength += file.text.length;
		expect(stats.totalTextLength).toBe(expectedTextLength);
		expect(stats.approximateBytes).toBeGreaterThan(stats.totalTextLength);
	});

	it('derives the record fields the searcher and ranker rely on', async () => {
		const { indexer } = harness(BASE_VAULT);
		await indexer.start();

		const record = indexer.getFileByPath('Notizen/Küche.md');
		expect(record).toBeDefined();
		if (record === undefined) return;
		expect(record.title).toBe('Küche');
		expect(record.titleNormalized).toBe('kuche');
		expect(record.folder).toBe('Notizen');
		expect(record.pathNormalized).toBe('notizen/kuche.md');
		// One break per blank line of the note, each landing on whitespace of the
		// folded text — the Searcher's phrase rule reads them as block edges.
		expect(record.blockBreaks).toBeInstanceOf(Uint32Array);
		expect([...(record.blockBreaks ?? [])].length).toBe(2);
		for (const offset of record.blockBreaks ?? []) {
			expect(record.text.charAt(offset), `offset ${String(offset)}`).toBe(' ');
			expect(GERMAN_NOTE.charAt(offset)).toBe('\n');
		}
		// The offset contract: nothing in a plain NFC file may change its length.
		expect(record.text.length).toBe(GERMAN_NOTE.length);
		expect(record.offsetMap).toBeNull();
		expect(record.createdSource).toBe('frontmatter');
		expect(record.createdAt).toBe(Date.parse('2026-03-14T00:00:00'));
		expect(record.indexedMtime).toBe(1_700_000_000_000);
		expect(indexer.getFile(record.id)).toBe(record);
	});

	/**
	 * A decomposed file name is the macOS default, and the two folded name fields
	 * used to be built with the length-preserving `stripFold`, which cannot drop a
	 * combining mark. The document text dropped it, the query side composes before
	 * folding — so the mark survived in `titleNormalized` and `pathNormalized`
	 * alone and no query could ever produce it again.
	 */
	it('folds a decomposed file name the way it folds the document text', async () => {
		const path = 'Küche/Notiz Küche.md'.normalize('NFD');
		const { indexer } = harness({ [path]: { content: '# Notiz\n\nText ohne Umlaut.\n' } });
		await indexer.start();

		const record = indexer.getFileByPath(path);
		expect(record).toBeDefined();
		expect(record?.titleNormalized).toBe('notiz kuche');
		expect(record?.pathNormalized).toBe('kuche/notiz kuche.md');
		// And the folded form is in the trigram map, so the name is reachable at all.
		expect(indexer.getPostings('uch')).toBeDefined();
		indexer.stop();
	});

	it('folds a decomposed rename target the same way', async () => {
		const target = 'Küche/Gasse.md'.normalize('NFD');
		const { app, indexer } = harness({ 'a/Alt.md': { content: '# Alt\n\nText.\n' } });
		await indexer.start();

		app.renameFile('a/Alt.md', target);
		indexer.applyChange(change('renamed', app, target, 'a/Alt.md'));
		await indexer.flushPending();

		const record = indexer.getFileByPath(target);
		expect(record?.pathNormalized).toBe('kuche/gasse.md');
		expect(record?.titleNormalized).toBe('gasse');
		indexer.stop();
	});

	it('falls back to ctime when the created field does not parse', async () => {
		const { indexer } = harness({
			'a.md': { content: '---\ncreated: irgendwann\n---\n\nText', ctime: 4242 },
		});
		await indexer.start();

		const record = indexer.getFileByPath('a.md');
		expect(record?.createdSource).toBe('ctime');
		expect(record?.createdAt).toBe(4242);
	});
});

describe('Indexer — trigrams', () => {
	it('indexes body, title and path into one map', async () => {
		const { indexer } = harness(BASE_VAULT);
		await indexer.start();
		const record = indexer.getFileByPath('Projekte/Strasse.md');
		expect(record).toBeDefined();
		if (record === undefined) return;

		const holds = (trigram: string): boolean => {
			const postings = indexer.getPostings(trigram);
			return postings !== undefined && [...Indexer.postingsToArray(postings)].includes(record.id);
		};
		// Body, path and title all reach the same map; the Searcher filters by
		// field only at verification time.
		expect(holds('win')).toBe(true); // 'Winter', body
		expect(holds('pro')).toBe(true); // 'projekte/', path
		expect(holds('str')).toBe(true); // title and body
	});

	it('adds supplementary alias trigrams per body word', async () => {
		// Deliberately ASCII file names in an ASCII folder: every alias trigram
		// asserted below can only have come from the body text.
		const { indexer } = harness({
			'Notes/report.md': { content: 'Die Küche wird gross.' },
			'Notes/traffic.md': { content: 'Die Straße ist gesperrt.' },
		});
		await indexer.start();
		const kitchen = indexer.getFileByPath('Notes/report.md');
		const street = indexer.getFileByPath('Notes/traffic.md');
		expect(kitchen).toBeDefined();
		expect(street).toBeDefined();
		if (kitchen === undefined || street === undefined) return;

		const holds = (trigram: string, id: number): boolean => {
			const postings = indexer.getPostings(trigram);
			return postings !== undefined && [...Indexer.postingsToArray(postings)].includes(id);
		};

		// 'Küche' is stored strip-folded as 'kuche' ...
		expect(kitchen.text).toContain('kuche');
		expect(holds('kuc', kitchen.id)).toBe(true);
		// ... and its alias form 'kueche' contributes trigrams of its own.
		expect(holds('kue', kitchen.id)).toBe(true);
		expect(holds('uec', kitchen.id)).toBe(true);
		expect(holds('ech', kitchen.id)).toBe(true);

		// 'Straße' -> stored 'strase', alias 'strasse'.
		expect(street.text).toContain('strase');
		for (const trigram of ['str', 'tra', 'ras', 'ass', 'sse']) {
			expect(holds(trigram, street.id)).toBe(true);
		}
		// The alias forms belong to their own file only.
		expect(holds('kue', street.id)).toBe(false);
	});

	it('keeps alias trigrams word-local instead of aliasing the whole document', async () => {
		// Aliasing the document would turn 'für alle' into 'fuer alle' and invent
		// the boundary-crossing trigram 'r a' at a shifted position; per word it
		// cannot happen, and no alias trigram may span the space.
		const { indexer } = harness({ 'a.md': { content: 'für alle' } });
		await indexer.start();
		expect(indexer.getPostings('er ')).toBeUndefined();
		expect(indexer.getPostings('fue')).toBeDefined();
		expect(indexer.getPostings('uer')).toBeDefined();
	});

	it('indexes the alias form of an umlaut in the title and the path', async () => {
		const { indexer } = harness({ 'Küche/Grüße.md': { content: 'nichts' } });
		await indexer.start();
		// 'Grüße' -> stored title 'gruse', alias 'gruesse'.
		expect(indexer.getPostings('rue')).toBeDefined();
		expect(indexer.getPostings('ess')).toBeDefined();
		// 'Küche/' in the path -> 'kueche'.
		expect(indexer.getPostings('uec')).toBeDefined();
	});
});

describe('Indexer — compaction', () => {
	it('converts sets to sorted arrays, preserves membership and is idempotent', async () => {
		const { indexer } = harness(BASE_VAULT, { tuning: { indexSliceMs: 12 } });
		await indexer.start();

		const before = snapshot(indexer);
		for (const postings of indexer.trigrams.values()) {
			expect(postings).toBeInstanceOf(Uint32Array);
		}
		indexer.compact();
		expect(snapshot(indexer)).toEqual(before);
		expect(indexer.stats().compacted).toBe(true);
	});

	it('re-expands only the key an incremental write touches', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		await indexer.start();
		expect(indexer.getPostings('kuc')).toBeInstanceOf(Uint32Array);

		app.writeFile('Notizen/Neu.md', 'zylinderkopfdichtung');
		indexer.applyChange(change('created', app, 'Notizen/Neu.md'));
		// Drain by hand so the state is observed before the trailing compact().
		await indexer.flushPending();

		// flushPending settles the map again, so the observable end state is
		// compacted; what matters is that the untouched keys were never rebuilt.
		expect(indexer.stats().compacted).toBe(true);
		const postings = indexer.getPostings('zyl');
		expect(postings).toBeDefined();
		if (postings === undefined) return;
		expect([...Indexer.postingsToArray(postings)]).toHaveLength(1);
	});

	it('postingsToArray sorts and deduplicates both representations', () => {
		const fromSet = Indexer.postingsToArray(new Set([9, 2, 7, 2]));
		expect([...fromSet]).toEqual([2, 7, 9]);

		const messy = new Uint32Array([5, 5, 1, 3]);
		expect([...Indexer.postingsToArray(messy)]).toEqual([1, 3, 5]);

		const clean = new Uint32Array([1, 4, 8]);
		// Already ascending and unique: handed straight back, no copy.
		expect(Indexer.postingsToArray(clean)).toBe(clean);
	});
});

describe('Indexer — incremental updates', () => {
	it('coalesces two modifications of one file into a single read', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		await indexer.start();
		app.resetReadCounts();

		app.writeFile('Notizen/Coffee.md', '# Coffee\n\nErste Änderung.');
		indexer.applyChange(change('modified', app, 'Notizen/Coffee.md'));
		app.writeFile('Notizen/Coffee.md', '# Coffee\n\nZweite Änderung.');
		indexer.applyChange(change('modified', app, 'Notizen/Coffee.md'));
		await indexer.flushPending();

		expect(app.readCount('Notizen/Coffee.md')).toBe(1);
		expect(indexer.getFileByPath('Notizen/Coffee.md')?.text).toContain('zweite');
	});

	it('keeps the FileId across a rename and moves the path fields with it', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		await indexer.start();
		const before = indexer.getFileByPath('Projekte/Strasse.md');
		expect(before).toBeDefined();
		if (before === undefined) return;
		app.resetReadCounts();

		app.renameFile('Projekte/Strasse.md', 'Projekte/Unterordner/Gasse.md');
		indexer.applyChange(change('renamed', app, 'Projekte/Unterordner/Gasse.md', 'Projekte/Strasse.md'));
		await indexer.flushPending();

		const after = indexer.getFileByPath('Projekte/Unterordner/Gasse.md');
		expect(after).toBeDefined();
		if (after === undefined) return;
		expect(after.id).toBe(before.id);
		expect(after.folder).toBe('Projekte/Unterordner');
		expect(after.pathNormalized).toBe('projekte/unterordner/gasse.md');
		expect(after.title).toBe('Gasse');
		expect(after.titleNormalized).toBe('gasse');
		expect(after.text).toBe(before.text);
		expect(indexer.getFileByPath('Projekte/Strasse.md')).toBeUndefined();
		// A rename changes no bytes, so it must not cost a read.
		expect(app.totalReadCount()).toBe(0);

		// The old path's trigrams went with it.
		const oldPathPostings = indexer.getPostings('sse');
		const ids = oldPathPostings === undefined ? [] : [...Indexer.postingsToArray(oldPathPostings)];
		expect(ids).toContain(after.id); // 'gasse' still has it
	});

	it('removes a deleted file from every postings list and leaves no empty key', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		await indexer.start();
		app.writeFile('Notizen/Unikat.md', 'zylinderkopfdichtung');
		indexer.applyChange(change('created', app, 'Notizen/Unikat.md'));
		await indexer.flushPending();

		const record = indexer.getFileByPath('Notizen/Unikat.md');
		expect(record).toBeDefined();
		if (record === undefined) return;
		expect(indexer.getPostings('zyl')).toBeDefined();

		app.deleteFile('Notizen/Unikat.md');
		indexer.applyChange({ kind: 'deleted', file: null, path: 'Notizen/Unikat.md' });
		await indexer.flushPending();

		expect(indexer.getFileByPath('Notizen/Unikat.md')).toBeUndefined();
		expect(indexer.getFile(record.id)).toBeUndefined();
		// The only holder of these keys is gone, so the keys are gone too.
		expect(indexer.getPostings('zyl')).toBeUndefined();
		expect(indexer.getPostings('nik')).toBeUndefined();
		for (const [key, postings] of indexer.trigrams) {
			expect(postingSize(postings), `empty postings for "${key}"`).toBeGreaterThan(0);
			expect([...Indexer.postingsToArray(postings)]).not.toContain(record.id);
		}
	});

	it('drops a file that a rename moved into an excluded folder', async () => {
		const { app, indexer } = harness(BASE_VAULT, { settings: { excludedFolders: ['Archiv'] } });
		await indexer.start();
		expect(indexer.getFileByPath('Notizen/Coffee.md')).toBeDefined();

		app.renameFile('Notizen/Coffee.md', 'Archiv/Coffee.md');
		indexer.applyChange(change('renamed', app, 'Archiv/Coffee.md', 'Notizen/Coffee.md'));
		await indexer.flushPending();

		expect(indexer.getFileByPath('Notizen/Coffee.md')).toBeUndefined();
		expect(indexer.getFileByPath('Archiv/Coffee.md')).toBeUndefined();
	});

	it('indexes a file that a rename moved out of an excluded folder', async () => {
		const { app, indexer } = harness(BASE_VAULT, { settings: { excludedFolders: ['Archiv'] } });
		await indexer.start();
		expect(indexer.getFileByPath('Archiv/Alt.md')).toBeUndefined();

		app.renameFile('Archiv/Alt.md', 'Notizen/Alt.md');
		indexer.applyChange(change('renamed', app, 'Notizen/Alt.md', 'Archiv/Alt.md'));
		await indexer.flushPending();

		// No record existed to relocate, so the file has to be read for the first time.
		const record = indexer.getFileByPath('Notizen/Alt.md');
		expect(record).toBeDefined();
		expect(record?.text).toContain('alter kram');
		expect(app.readCount('Notizen/Alt.md')).toBe(1);
	});

	it('does no work for a change event that reports no change', async () => {
		// Obsidian re-parses the whole vault after a metadata-cache reset and
		// fires 'changed' for every note without a byte moving. Re-reading,
		// re-normalizing and re-writing each one reproduces the record exactly,
		// so the incremental path applies the staleness test the cold path uses.
		const { app, indexer } = harness(BASE_VAULT);
		await indexer.start();
		const before = snapshot(indexer);
		app.resetReadCounts();

		for (const file of app.vault.getMarkdownFiles()) {
			indexer.applyChange({ kind: 'modified', file, path: file.path });
		}
		await indexer.flushPending();

		expect(app.totalReadCount()).toBe(0);
		expect(snapshot(indexer)).toEqual(before);
	});

	it('re-reads an edit that kept the file size, because the mtime moved', async () => {
		// The shape an mtime-and-size guard could swallow: a replacement of equal
		// length. The mtime still moves, and that is what the guard tests.
		const { app, indexer } = harness({ 'note.md': { content: 'zylinderkopf abcdefgh' } });
		await indexer.start();
		expect(indexer.getPostings('abc')).toBeDefined();
		app.resetReadCounts();

		app.writeFile('note.md', 'zylinderkopf hgfedcba');
		expect(app.contentOf('note.md')?.length).toBe(21);
		indexer.applyChange(change('modified', app, 'note.md'));
		await indexer.flushPending();

		expect(app.readCount('note.md')).toBe(1);
		expect(indexer.getPostings('abc')).toBeUndefined();
		expect(indexer.getPostings('hgf')).toBeDefined();
	});

	it('re-reads a record that came back from the store, whose alias trigrams it cannot hold', async () => {
		const vaultId = `alias-${Date.now()}`;
		const app = createFakeApp({ 'Notes/report.md': { content: 'Die Küche wird gross.' } });
		const firstStore = new Store(vaultId);
		const first = new Indexer(app.asApp(), firstStore, settingsWith(), tuningWith());
		await first.start();
		await first.flushPending();
		first.stop();
		firstStore.close();

		app.resetReadCounts();
		const secondStore = new Store(vaultId);
		const second = new Indexer(app.asApp(), secondStore, settingsWith(), tuningWith());
		await second.start();
		expect(app.totalReadCount()).toBe(0);
		// The body alias form of 'Küche' is not derivable from a stored record ...
		expect(second.getPostings('uec')).toBeUndefined();

		const file = app.vault.getFileByPath('Notes/report.md');
		expect(file).not.toBeNull();
		if (file === null) return;
		second.applyChange({ kind: 'modified', file, path: file.path });
		await second.flushPending();

		// ... so this read is not redundant: it is what restores those trigrams.
		expect(app.totalReadCount()).toBe(1);
		expect(second.getPostings('uec')).toBeDefined();
		second.stop();
		secondStore.close();
	});

	it('produces exactly the index a rebuild would, after create, modify, rename and delete', async () => {
		const app = createFakeApp(BASE_VAULT);
		const live = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await live.start();

		app.writeFile('Notizen/Neu.md', '# Neue Notiz\n\nEine große Küche mit Straßenblick.');
		live.applyChange(change('created', app, 'Notizen/Neu.md'));

		app.writeFile('Notizen/Coffee.md', '# Coffee\n\nDer Kaffeevollautomat ist neu.');
		live.applyChange(change('modified', app, 'Notizen/Coffee.md'));

		app.renameFile('Projekte/Strasse.md', 'Projekte/Wege/Gasse.md');
		live.applyChange(change('renamed', app, 'Projekte/Wege/Gasse.md', 'Projekte/Strasse.md'));

		app.deleteFile('Projekte2/Nachbar.md');
		live.applyChange({ kind: 'deleted', file: null, path: 'Projekte2/Nachbar.md' });

		await live.flushPending();

		// Same vault, built from nothing, in a database of its own.
		const fresh = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await fresh.start();

		expect(live.fileCount()).toBe(fresh.fileCount());
		expect(snapshot(live)).toEqual(snapshot(fresh));
	});

	it('survives a rename chain and a delete of the renamed file', async () => {
		const app = createFakeApp(BASE_VAULT);
		const live = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await live.start();

		// a -> b -> c inside one batch: the record filed under a must be found.
		app.renameFile('Notizen/Coffee.md', 'Notizen/Coffee2.md');
		live.applyChange(change('renamed', app, 'Notizen/Coffee2.md', 'Notizen/Coffee.md'));
		app.renameFile('Notizen/Coffee2.md', 'Notizen/Kaffee.md');
		live.applyChange(change('renamed', app, 'Notizen/Kaffee.md', 'Notizen/Coffee2.md'));
		// ... and a file created then deleted before the drain leaves no trace.
		app.writeFile('Notizen/Kurz.md', 'zylinderkopfdichtung');
		live.applyChange(change('created', app, 'Notizen/Kurz.md'));
		app.deleteFile('Notizen/Kurz.md');
		live.applyChange({ kind: 'deleted', file: null, path: 'Notizen/Kurz.md' });

		await live.flushPending();

		const fresh = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await fresh.start();
		expect(snapshot(live)).toEqual(snapshot(fresh));
		expect(live.getFileByPath('Notizen/Kaffee.md')).toBeDefined();
		expect(live.getPostings('zyl')).toBeUndefined();
	});
});

/* -------------------------------------------------------------------------- */
/* A rename that lands on a path another record already holds                 */
/* -------------------------------------------------------------------------- */

/**
 * The pending queue is keyed by path, and a rename files its entry under the
 * DESTINATION. Everything below is a way for a second record to end up under
 * one path: the queued entry that the rename replaces, and the record that the
 * relocation lands on top of. Each case is checked against an index built from
 * nothing over the resulting vault, because "the deleted note is still
 * searchable" is exactly a difference from that index.
 */
describe('Indexer — a rename onto an occupied path', () => {
	it('forgets the buried note when its delete and the rename share one batch', async () => {
		const app = createFakeApp(REPLACE_VAULT);
		const live = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await live.start();
		const alpha = live.getFileByPath('A.md');
		expect(alpha).toBeDefined();
		if (alpha === undefined) return;

		// Delete B.md, then rename A.md onto the path it freed. Both events reach
		// the queue before it drains — the whole duration of a cold build.
		app.deleteFile('B.md');
		live.applyChange({ kind: 'deleted', file: null, path: 'B.md' });
		app.renameFile('A.md', 'B.md');
		live.applyChange(change('renamed', app, 'B.md', 'A.md'));
		await live.flushPending();

		expect(indexedPaths(live)).toEqual(['B.md', 'C.md']);
		expect(live.fileCount()).toBe(2);
		expect(live.getFileByPath('B.md')?.id).toBe(alpha.id);
		// 'Quallenfeld' existed only in the note that was deleted.
		expect(live.getPostings('qua')).toBeUndefined();
		expect(live.getPostings('zeb')).toBeDefined();

		const fresh = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await fresh.start();
		expect(snapshot(live)).toEqual(snapshot(fresh));
	});

	it('forgets a record the destination already holds when no delete arrives at all', async () => {
		// metadataCache batches its 'deleted' events, so a rename can reach the
		// Indexer while the delete of the note it buried is still on its way — or
		// never arrives, because the file was removed outside Obsidian.
		const app = createFakeApp(REPLACE_VAULT);
		const live = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await live.start();

		app.deleteFile('B.md');
		app.renameFile('A.md', 'B.md');
		live.applyChange(change('renamed', app, 'B.md', 'A.md'));
		await live.flushPending();

		expect(indexedPaths(live)).toEqual(['B.md', 'C.md']);
		expect(live.getPostings('qua')).toBeUndefined();

		const fresh = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await fresh.start();
		expect(snapshot(live)).toEqual(snapshot(fresh));
	});

	it('survives a rename chain that returns to the path it started from', async () => {
		const app = createFakeApp(REPLACE_VAULT);
		const live = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await live.start();
		const alpha = live.getFileByPath('A.md');
		expect(alpha).toBeDefined();
		if (alpha === undefined) return;
		app.resetReadCounts();

		app.renameFile('A.md', 'Zwischen.md');
		live.applyChange(change('renamed', app, 'Zwischen.md', 'A.md'));
		app.renameFile('Zwischen.md', 'A.md');
		live.applyChange(change('renamed', app, 'A.md', 'Zwischen.md'));
		await live.flushPending();

		expect(indexedPaths(live)).toEqual(['A.md', 'B.md', 'C.md']);
		expect(live.getFileByPath('A.md')?.id).toBe(alpha.id);
		// The intermediate name never reached the index.
		expect(live.getPostings('zwi')).toBeUndefined();
		// Nothing moved and nothing changed, so nothing had to be read.
		expect(app.totalReadCount()).toBe(0);

		const fresh = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await fresh.start();
		expect(snapshot(live)).toEqual(snapshot(fresh));
	});

	it('keeps a note created under the path a displaced delete would have claimed', async () => {
		const app = createFakeApp(REPLACE_VAULT);
		const live = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await live.start();

		// C.md moves onto B.md, a new C.md is written, and A.md then takes B.md.
		// The delete that the last rename displaces points at C.md — where a live
		// note now sits, so it must not be turned into a delete of that note.
		app.deleteFile('B.md');
		live.applyChange({ kind: 'deleted', file: null, path: 'B.md' });
		app.renameFile('C.md', 'B.md');
		live.applyChange(change('renamed', app, 'B.md', 'C.md'));
		app.writeFile('C.md', '# C\n\nNeuer Inhalt mit Kupferrohr.');
		live.applyChange(change('created', app, 'C.md'));
		app.deleteFile('B.md');
		live.applyChange({ kind: 'deleted', file: null, path: 'B.md' });
		app.renameFile('A.md', 'B.md');
		live.applyChange(change('renamed', app, 'B.md', 'A.md'));
		await live.flushPending();

		expect(indexedPaths(live)).toEqual(['B.md', 'C.md']);
		expect(live.getPostings('kup')).toBeDefined();
		expect(live.getPostings('dac')).toBeUndefined();

		const fresh = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await fresh.start();
		expect(snapshot(live)).toEqual(snapshot(fresh));
	});

	it('applies a queued delete that a second rename displaced from its path', async () => {
		const app = createFakeApp(REPLACE_VAULT);
		const live = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await live.start();
		const alpha = live.getFileByPath('A.md');
		expect(alpha).toBeDefined();
		if (alpha === undefined) return;

		// B.md is filled and emptied twice before the queue drains. The delete
		// that matters for C.md is queued under B.md — the path the last rename
		// claims — so it is the entry most easily lost.
		app.deleteFile('B.md');
		live.applyChange({ kind: 'deleted', file: null, path: 'B.md' });
		app.renameFile('C.md', 'B.md');
		live.applyChange(change('renamed', app, 'B.md', 'C.md'));
		app.deleteFile('B.md');
		live.applyChange({ kind: 'deleted', file: null, path: 'B.md' });
		app.renameFile('A.md', 'B.md');
		live.applyChange(change('renamed', app, 'B.md', 'A.md'));
		await live.flushPending();

		expect(app.paths()).toEqual(['B.md']);
		expect(indexedPaths(live)).toEqual(['B.md']);
		expect(live.getFileByPath('B.md')?.id).toBe(alpha.id);
		expect(live.getPostings('qua')).toBeUndefined();
		expect(live.getPostings('dac')).toBeUndefined();

		const fresh = new Indexer(app.asApp(), freshStore(), settingsWith(), tuningWith());
		await fresh.start();
		expect(snapshot(live)).toEqual(snapshot(fresh));
	});
});

describe('Indexer — staleness', () => {
	it('reuses stored records whose mtime still matches and re-reads only the changed one', async () => {
		const vaultId = `stale-${Date.now()}`;
		const app = createFakeApp(BASE_VAULT);

		const firstStore = new Store(vaultId);
		const first = new Indexer(app.asApp(), firstStore, settingsWith(), tuningWith());
		await first.start();
		await first.flushPending();
		first.stop();
		firstStore.close();

		app.resetReadCounts();
		const secondStore = new Store(vaultId);
		const second = new Indexer(app.asApp(), secondStore, settingsWith(), tuningWith());
		await second.start();
		expect(app.totalReadCount()).toBe(0);
		expect(second.fileCount()).toBe(5);
		expect(second.getPostings('kuc')).toBeDefined();
		await second.flushPending();
		second.stop();
		secondStore.close();

		// One file changes; the mtime moves with it.
		app.writeFile('Notizen/Coffee.md', '# Coffee\n\nNeuer Inhalt.');
		app.resetReadCounts();
		const thirdStore = new Store(vaultId);
		const third = new Indexer(app.asApp(), thirdStore, settingsWith(), tuningWith());
		await third.start();
		expect(app.readCount('Notizen/Coffee.md')).toBe(1);
		expect(app.totalReadCount()).toBe(1);
		expect(third.getFileByPath('Notizen/Coffee.md')?.text).toContain('neuer inhalt');
		third.stop();
		thirdStore.close();
	});

	/**
	 * The store carries no generation number for this: `SIFT_SCHEMA_VERSION` in
	 * `src/index/Store.ts` still reads 1, so a row written before `blockBreaks`
	 * existed passes every check the Store makes. Adopted as it is, it would say
	 * the note has no block break anywhere and a quoted phrase would go on
	 * matching across a paragraph break — in exactly the files that came back
	 * unchanged from IndexedDB. `seed` therefore refuses such a row and the
	 * ordinary staleness path re-reads the file.
	 */
	it('re-reads a stored record written before block breaks existed', async () => {
		const vaultId = `legacy-${Date.now()}`;
		const app = createFakeApp(BASE_VAULT);

		const firstStore = new Store(vaultId);
		const first = new Indexer(app.asApp(), firstStore, settingsWith(), tuningWith());
		await first.start();
		await first.flushPending();
		const legacy = [...first.allFiles()].map((file) => {
			const row: Record<string, unknown> = { ...file };
			delete row.blockBreaks;
			return row as unknown as IndexedFile;
		});
		first.stop();
		firstStore.close();

		// Put the rows back in the shape the previous schema wrote them.
		const patchStore = new Store(vaultId);
		await patchStore.open();
		await patchStore.putFiles(legacy);
		patchStore.close();

		app.resetReadCounts();
		const secondStore = new Store(vaultId);
		const second = new Indexer(app.asApp(), secondStore, settingsWith(), tuningWith());
		await second.start();

		// Every row was refused, so every file was read again — the control being
		// the test above, where an unchanged vault costs no read at all.
		expect(app.totalReadCount()).toBe(5);
		expect(second.fileCount()).toBe(5);
		expect(indexedPaths(second)).toEqual(app.paths());
		for (const file of second.allFiles()) {
			expect(file.blockBreaks, file.path).toBeInstanceOf(Uint32Array);
		}
		await second.flushPending();
		second.stop();
		secondStore.close();

		// The control that makes the count above mean something: the repaired rows
		// go back through the same store and cost no read, so the five reads came
		// from the missing field and not from the patch or a rejected store.
		app.resetReadCounts();
		const thirdStore = new Store(vaultId);
		const third = new Indexer(app.asApp(), thirdStore, settingsWith(), tuningWith());
		await third.start();
		expect(app.totalReadCount()).toBe(0);
		expect(third.getFileByPath('Notizen/Küche.md')?.blockBreaks).toBeInstanceOf(Uint32Array);
		third.stop();
		thirdStore.close();
	});

	it('drops records for files that vanished while the plugin was off', async () => {
		const vaultId = `vanish-${Date.now()}`;
		const app = createFakeApp(BASE_VAULT);
		const firstStore = new Store(vaultId);
		const first = new Indexer(app.asApp(), firstStore, settingsWith(), tuningWith());
		await first.start();
		await first.flushPending();
		first.stop();
		firstStore.close();

		app.deleteFile('Projekte2/Nachbar.md');
		const secondStore = new Store(vaultId);
		const second = new Indexer(app.asApp(), secondStore, settingsWith(), tuningWith());
		await second.start();
		await second.flushPending();

		expect(second.fileCount()).toBe(4);
		expect(second.getFileByPath('Projekte2/Nachbar.md')).toBeUndefined();
		for (const [key, postings] of second.trigrams) {
			expect(postingSize(postings), `empty postings for "${key}"`).toBeGreaterThan(0);
		}
		second.stop();
		secondStore.close();
	});

	it('rebuilds from the vault when forceRebuild is set', async () => {
		const vaultId = `forced-${Date.now()}`;
		const app = createFakeApp(BASE_VAULT);
		const firstStore = new Store(vaultId);
		const first = new Indexer(app.asApp(), firstStore, settingsWith(), tuningWith());
		await first.start();
		await first.flushPending();
		first.stop();
		firstStore.close();

		app.resetReadCounts();
		const secondStore = new Store(vaultId);
		const second = new Indexer(app.asApp(), secondStore, settingsWith({ forceRebuild: true }), tuningWith());
		await second.start();
		expect(app.totalReadCount()).toBe(5);

		// The flag is consumed, so a second start in the same session reuses what
		// the first one just wrote.
		await second.flushPending();
		app.resetReadCounts();
		await second.start();
		expect(app.totalReadCount()).toBe(0);
		second.stop();
		secondStore.close();
	});
});

describe('Indexer — excluded folders', () => {
	it('never reads or indexes a file inside an excluded folder', async () => {
		const { app, indexer } = harness(BASE_VAULT, { settings: { excludedFolders: ['Archiv'] } });
		await indexer.start();

		expect(indexer.fileCount()).toBe(4);
		expect(indexer.getFileByPath('Archiv/Alt.md')).toBeUndefined();
		expect(app.readCount('Archiv/Alt.md')).toBe(0);
	});

	it('matches on a path segment, so Projekte does not swallow Projekte2', async () => {
		const { indexer } = harness(BASE_VAULT, { settings: { excludedFolders: ['Projekte'] } });
		await indexer.start();

		expect(indexer.getFileByPath('Projekte/Strasse.md')).toBeUndefined();
		expect(indexer.getFileByPath('Projekte2/Nachbar.md')).toBeDefined();
	});

	it('rebuilds when the exclusion list changes and does nothing when it does not', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		await indexer.start();
		expect(indexer.fileCount()).toBe(5);

		app.resetReadCounts();
		// A setting outside the fingerprint must not cost a rebuild.
		await indexer.updateSettings(settingsWith({ maxResults: 50 }));
		expect(app.totalReadCount()).toBe(0);
		expect(indexer.fileCount()).toBe(5);

		await indexer.updateSettings(settingsWith({ maxResults: 50, excludedFolders: ['Archiv'] }));
		expect(indexer.fileCount()).toBe(4);
		expect(indexer.getFileByPath('Archiv/Alt.md')).toBeUndefined();
		expect(app.totalReadCount()).toBeGreaterThan(0);
		for (const [key, postings] of indexer.trigrams) {
			expect(postingSize(postings), `empty postings for "${key}"`).toBeGreaterThan(0);
		}
	});

	it('ignores an exclusion entry that resolves to the vault root', async () => {
		const { indexer } = harness(BASE_VAULT, { settings: { excludedFolders: ['   ', '/'] } });
		await indexer.start();
		expect(indexer.fileCount()).toBe(5);
	});
});

describe('Indexer — slicing', () => {
	it('never spends more than the slice budget on one synchronous run', async () => {
		// A clock that ticks once per reading makes the budget countable: with a
		// budget of N the loop can do at most N items before it has to yield.
		let clock = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => {
			clock += 1;
			return clock;
		});

		const files: Record<string, FakeFileSpec> = {};
		for (let i = 0; i < 40; i++) files[`Notes/note-${i}.md`] = { content: `Notiz ${i} über die Küche` };
		const budget = 4;
		const { indexer } = harness(files, { tuning: { indexSliceMs: budget } });

		const building: number[] = [];
		await indexer.start((progress) => {
			if (progress.phase === 'building') building.push(progress.done);
		});

		expect(building.length).toBeGreaterThan(1);
		expect(building[building.length - 1]).toBe(40);
		for (let i = 1; i < building.length; i++) {
			expect(building[i] - building[i - 1]).toBeLessThanOrEqual(budget);
		}
	});

	it('yields after every item when the budget is exhausted immediately', async () => {
		const files: Record<string, FakeFileSpec> = {};
		for (let i = 0; i < 8; i++) files[`Notes/note-${i}.md`] = { content: `Notiz ${i}` };
		const { indexer } = harness(files, { tuning: { indexSliceMs: 0 } });

		const building: number[] = [];
		await indexer.start((progress) => {
			if (progress.phase === 'building') building.push(progress.done);
		});

		expect(building).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it('gives an oversized note a slice of its own at the end of the pass', async () => {
		// The clock cannot bound one file — both loops finish the file they hold
		// before they consult it — so what is bounded instead is how much shares
		// a slice: a note above the size threshold moves to the end of the pass
		// and is processed alone.
		const files: Record<string, FakeFileSpec> = {};
		for (let i = 0; i < 12; i++) files[`Notes/small-${i}.md`] = { content: `Notiz ${i} über die Küche` };
		files['Notes/big-a.md'] = { content: 'kaffee und kuchen '.repeat(12_000) };
		files['Notes/big-b.md'] = { content: 'espresso und gipfeli '.repeat(12_000) };
		// A budget nothing ordinary can exhaust, so every boundary below comes
		// from the size split rather than from the clock.
		const { indexer } = harness(files, { tuning: { indexSliceMs: 60_000 } });

		const reading: number[] = [];
		const building: number[] = [];
		await indexer.start((progress) => {
			if (progress.phase === 'reading') reading.push(progress.done);
			if (progress.phase === 'building') building.push(progress.done);
		});

		// Twelve ordinary notes in one slice, then one slice per large note.
		expect(reading).toEqual([0, 12, 13, 14]);
		expect(building).toEqual([0, 12, 13, 14]);
		// Deferred, never skipped.
		expect(indexer.fileCount()).toBe(14);
		expect(indexer.getFileByPath('Notes/big-a.md')?.text).toContain('kaffee');
		expect(indexer.getPostings('gip')).toBeDefined();
	});

	it('reports the phases in order and ends ready', async () => {
		const { indexer } = harness(BASE_VAULT);
		const phases: string[] = [];
		await indexer.start((progress) => {
			if (phases[phases.length - 1] !== progress.phase) phases.push(progress.phase);
		});
		expect(phases).toEqual(['loading', 'scanning', 'reading', 'building', 'compacting', 'ready']);
	});

	it('uses requestIdleCallback when the platform provides one', async () => {
		const scheduled: Array<() => void> = [];
		schedulerWindow.requestIdleCallback = (callback: () => void): number => {
			scheduled.push(callback);
			// Run on a microtask, which is all the Indexer needs from a scheduler.
			void Promise.resolve().then(callback);
			return scheduled.length;
		};
		schedulerWindow.cancelIdleCallback = (): void => undefined;
		try {
			const files: Record<string, FakeFileSpec> = {};
			for (let i = 0; i < 6; i++) files[`Notes/note-${i}.md`] = { content: `Notiz ${i}` };
			const { indexer } = harness(files, { tuning: { indexSliceMs: 0 } });
			await indexer.start();
			expect(indexer.fileCount()).toBe(6);
			expect(scheduled.length).toBeGreaterThan(0);
		} finally {
			delete schedulerWindow.requestIdleCallback;
			delete schedulerWindow.cancelIdleCallback;
		}
	});

	it('stop() cancels the pending slice and unblocks the build', async () => {
		const files: Record<string, FakeFileSpec> = {};
		for (let i = 0; i < 30; i++) files[`Notes/note-${i}.md`] = { content: `Notiz ${i}` };
		const { indexer } = harness(files, { tuning: { indexSliceMs: 0 } });

		const started = indexer.start((progress) => {
			if (progress.phase === 'reading' && progress.done >= 2) indexer.stop();
		});
		await expect(started).resolves.toBeUndefined();
		expect(indexer.isReady()).toBe(false);
		expect(indexer.fileCount()).toBeLessThan(30);
	});
});

describe('Indexer — a build that throws', () => {
	it('records the failure so it cannot pass for an empty vault', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		vi.spyOn(app.vault, 'getMarkdownFiles').mockImplementation((): never => {
			throw new Error('vault unavailable');
		});

		const phases: string[] = [];
		await expect(
			indexer.start((progress) => {
				phases.push(progress.phase);
			}),
		).resolves.toBeUndefined();

		// The partial index stays queryable on purpose, which is exactly why the
		// failure has to be readable somewhere: isReady() alone cannot tell a
		// broken index from an empty one.
		expect(indexer.isReady()).toBe(true);
		expect(indexer.fileCount()).toBe(0);
		expect(phases).toContain('error');
		// The error name only — never a message, a path or note content.
		expect(indexer.lastError()).toBe('Error');
	});

	it('clears the failure once a build succeeds', async () => {
		const { app, indexer } = harness(BASE_VAULT);
		const markdownFiles = app.vault.getMarkdownFiles.bind(app.vault);
		let broken = true;
		vi.spyOn(app.vault, 'getMarkdownFiles').mockImplementation(() => {
			if (broken) throw new Error('vault unavailable');
			return markdownFiles();
		});

		await indexer.start();
		expect(indexer.lastError()).not.toBeNull();

		broken = false;
		await indexer.rebuild();
		expect(indexer.lastError()).toBeNull();
		expect(indexer.fileCount()).toBe(5);
	});
});

describe('Indexer — the fixture vault', () => {
	it('indexes the generated vault and keeps the offset invariant', async () => {
		const loaded = loadVault(undefined, 120);
		const { indexer } = harness(loaded.files);
		await indexer.start();

		expect(indexer.fileCount()).toBe(Object.keys(loaded.files).length);
		for (const file of indexer.allFiles()) {
			const raw = loaded.files[file.path]?.content ?? '';
			if (file.offsetMap === null) expect(file.text.length).toBe(raw.length);
			else expect(file.offsetMap.length).toBe(file.text.length + 1);
		}
		for (const [key, postings] of indexer.trigrams) {
			expect(key.length).toBe(3);
			expect(postingSize(postings)).toBeGreaterThan(0);
		}
	});

	it('costs far less memory compacted than as sets — the reason compact() exists', async () => {
		const loaded = loadVault(undefined, 120);
		const { app, indexer } = harness(loaded.files);
		await indexer.start();

		const compacted = indexer.stats();
		expect(compacted.compacted).toBe(true);

		// One incremental write re-expands a handful of keys; a full expansion is
		// what the estimate below models, and it is roughly an order of magnitude
		// dearer per posting.
		app.writeFile('Notizen/Neu.md', 'Eine neue Notiz über die Küche.');
		indexer.applyChange(change('created', app, 'Notizen/Neu.md'));
		await indexer.flushPending();
		expect(indexer.stats().compacted).toBe(true);

		const setBytes = compacted.approximateBytes + compacted.postingCount * (32 - 4);
		// 32 bytes per Set entry against 4 per typed-array element: the same index
		// held as sets does not fit a budget the compacted one clears easily.
		expect(setBytes).toBeGreaterThan(compacted.approximateBytes * 2);
	});
});
