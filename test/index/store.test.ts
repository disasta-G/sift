import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_STORE_BATCH_SIZE, SIFT_SCHEMA_VERSION, Store } from '../../src/index/Store';
import type { IndexedFile, SchemaVersion, StoreMeta } from '../../src/types';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const realIndexedDB: IDBFactory = indexedDB;

let vaultCounter = 0;

function nextVaultId(): string {
	vaultCounter += 1;
	return `vault-${vaultCounter}`;
}

function makeFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
	const base: IndexedFile = {
		id: 1,
		path: 'Notes/kaffee.md',
		title: 'kaffee',
		titleNormalized: 'kaffee',
		folder: 'Notes',
		hasOpenTask: false,
		pathNormalized: 'notes/kaffee.md',
		text: 'kaffee und kuchen',
		offsetMap: null,
		blockBreaks: new Uint32Array(0),
		frontmatterSpan: null,
		headings: [],
		tags: ['kaffee'],
		words: {
			packed: 'kaffee\nund\nkuchen',
			bounds: new Uint32Array([0, 7, 11, 18]),
			count: 3,
		},
		createdAt: 1_700_000_000_000,
		modifiedAt: 1_700_000_100_000,
		createdSource: 'ctime',
		properties: {},
		size: 17,
		indexedMtime: 1_700_000_100_000,
	};
	return { ...base, ...overrides };
}

function makeFiles(count: number): IndexedFile[] {
	const files: IndexedFile[] = [];
	for (let i = 0; i < count; i++) {
		files.push(makeFile({ id: i, path: `Notes/note-${i}.md`, title: `note-${i}` }));
	}
	return files;
}

function makeMeta(overrides: Partial<StoreMeta> = {}): StoreMeta {
	const base: StoreMeta = {
		schemaVersion: SIFT_SCHEMA_VERSION,
		vaultId: 'vault-0',
		settingsFingerprint: Store.fingerprintSettings('created', []),
		builtAt: 1_700_000_200_000,
		nextFileId: 42,
	};
	return { ...base, ...overrides };
}

/** Opens an already-created database directly, to plant records the Store would never write. */
function rawOpen(dbName: string): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(dbName, 1);
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(request.error ?? new Error('raw open failed'));
	});
}

async function rawPut(dbName: string, storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
	const db = await rawOpen(dbName);
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(storeName, 'readwrite');
			tx.oncomplete = (): void => resolve();
			tx.onerror = (): void => reject(tx.error ?? new Error('raw put failed'));
			tx.onabort = (): void => reject(tx.error ?? new Error('raw put aborted'));
			const store = tx.objectStore(storeName);
			if (key === undefined) {
				store.put(value);
			} else {
				store.put(value, key);
			}
		});
	} finally {
		db.close();
	}
}

interface FakeOpenRequest {
	onsuccess: ((this: unknown, event: Event) => unknown) | null;
	onerror: ((this: unknown, event: Event) => unknown) | null;
	onupgradeneeded: ((this: unknown, event: Event) => unknown) | null;
	onblocked: ((this: unknown, event: Event) => unknown) | null;
	error: DOMException | null;
	result: unknown;
}

/** A factory that behaves like a hardened browser: `open()` never yields a connection. */
function hostileFactory(mode: 'throw' | 'error' | 'blocked'): IDBFactory {
	const factory = {
		open(): IDBOpenDBRequest {
			if (mode === 'throw') {
				throw new DOMException('storage disabled', 'SecurityError');
			}
			const request: FakeOpenRequest = {
				onsuccess: null,
				onerror: null,
				onupgradeneeded: null,
				onblocked: null,
				error: new DOMException('storage disabled', 'InvalidStateError'),
				result: null,
			};
			queueMicrotask(() => {
				if (mode === 'error') {
					request.onerror?.call(request, new Event('error'));
				} else {
					request.onblocked?.call(request, new Event('blocked'));
				}
			});
			return request as unknown as IDBOpenDBRequest;
		},
	};
	return factory as unknown as IDBFactory;
}

function setIndexedDB(value: IDBFactory | undefined): void {
	if (value === undefined) {
		Reflect.deleteProperty(globalThis, 'indexedDB');
		return;
	}
	Object.defineProperty(globalThis, 'indexedDB', { value, configurable: true, writable: true });
}

/* -------------------------------------------------------------------------- */
/* No promise created by the Store may escape unhandled                       */
/* -------------------------------------------------------------------------- */

const unhandled: unknown[] = [];

function collectUnhandled(reason: unknown): void {
	unhandled.push(reason);
}

beforeEach(() => {
	unhandled.length = 0;
	process.on('unhandledRejection', collectUnhandled);
});

afterEach(async () => {
	// Give a rejected promise a full turn to be reported before we judge it.
	await new Promise<void>((resolve) => setImmediate(resolve));
	process.off('unhandledRejection', collectUnhandled);
	setIndexedDB(realIndexedDB);
	expect(unhandled).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                 */
/* -------------------------------------------------------------------------- */

describe('Store round trip', () => {
	it('keeps typed arrays intact through the structured clone', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		expect(store.isAvailable()).toBe(true);

		const file = makeFile({
			id: 7,
			offsetMap: new Uint32Array([0, 1, 2, 4, 8, 16, 4_294_967_295]),
			words: { packed: 'ae\nkuche\nstrase', bounds: new Uint32Array([0, 3, 9, 15]), count: 3 },
			frontmatterSpan: { start: 0, end: 24 },
			headings: [{ level: 2, span: { start: 30, end: 44 }, textSpan: { start: 33, end: 44 } }],
			tags: ['kaffee', 'kuche'],
		});
		await store.putFiles([file]);

		const read = await store.readFile(7);
		expect(read).not.toBeNull();
		expect(read).toEqual(file);
		expect(read?.offsetMap).toBeInstanceOf(Uint32Array);
		expect(Array.from(read?.offsetMap ?? [])).toEqual([0, 1, 2, 4, 8, 16, 4_294_967_295]);
		expect(read?.words.bounds).toBeInstanceOf(Uint32Array);
		expect(Array.from(read?.words.bounds ?? [])).toEqual([0, 3, 9, 15]);
		store.close();
	});

	it('keeps a null offsetMap null', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		await store.putFiles([makeFile({ id: 3, offsetMap: null })]);
		const read = await store.readFile(3);
		expect(read?.offsetMap).toBeNull();
		store.close();
	});

	it('returns null for an unknown id', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		expect(await store.readFile(999)).toBeNull();
		store.close();
	});

	it('survives close and reopen', async () => {
		const vaultId = nextVaultId();
		const first = new Store(vaultId);
		await first.open();
		await first.putFiles([makeFile({ id: 1 })]);
		await first.writeMeta(makeMeta({ vaultId }));
		first.close();
		expect(first.isAvailable()).toBe(false);

		const second = new Store(vaultId);
		await second.open();
		expect(await second.readMeta()).toEqual(makeMeta({ vaultId }));
		expect(await second.readFile(1)).not.toBeNull();
		second.close();
	});
});

/* -------------------------------------------------------------------------- */
/* load()                                                                     */
/* -------------------------------------------------------------------------- */

describe('Store.load', () => {
	it('returns every file when meta matches', async () => {
		const vaultId = nextVaultId();
		const fingerprint = Store.fingerprintSettings('created', ['Archiv']);
		const store = new Store(vaultId);
		await store.open();
		await store.putFiles(makeFiles(3));
		const meta = makeMeta({ vaultId, settingsFingerprint: fingerprint });
		await store.writeMeta(meta);

		const result = await store.load({ vaultId, settingsFingerprint: fingerprint }, false);
		expect(result.reject).toBeNull();
		expect(result.meta).toEqual(meta);
		expect(result.files).toHaveLength(3);
		expect(result.files?.map((file) => file.id).sort((a, b) => a - b)).toEqual([0, 1, 2]);
		store.close();
	});

	it('opens the connection itself when the caller did not', async () => {
		const vaultId = nextVaultId();
		const writer = new Store(vaultId);
		await writer.open();
		await writer.writeMeta(makeMeta({ vaultId }));
		writer.close();

		const reader = new Store(vaultId);
		expect(reader.isAvailable()).toBe(false);
		const result = await reader.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, false);
		expect(result.reject).toBeNull();
		expect(reader.isAvailable()).toBe(true);
		reader.close();
	});

	it('rejects an empty database as missing', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		const result = await store.load({ vaultId, settingsFingerprint: 'x' }, false);
		expect(result).toEqual({ files: null, meta: null, reject: 'missing' });
		store.close();
	});

	it('rejects a bumped schema version', async () => {
		const vaultId = nextVaultId();
		const written = new Store(vaultId);
		await written.open();
		await written.putFiles(makeFiles(2));
		await written.writeMeta(makeMeta({ vaultId }));
		written.close();

		// One generation past whatever the code currently declares, so the test
		// keeps meaning the same thing after every schema bump.
		const bumped = new Store(vaultId, (SIFT_SCHEMA_VERSION + 1) as unknown as SchemaVersion);
		await bumped.open();
		const result = await bumped.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, false);
		expect(result).toEqual({ files: null, meta: null, reject: 'schema-mismatch' });
		bumped.close();
	});

	it('rejects a record written by an older schema', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.writeMeta(makeMeta({ vaultId, schemaVersion: 0 as unknown as SchemaVersion }));
		const result = await store.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, false);
		expect(result.reject).toBe('schema-mismatch');
		expect(result.files).toBeNull();
		store.close();
	});

	it('rejects an index built for a different vault', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.writeMeta(makeMeta({ vaultId: 'some-other-vault' }));
		const result = await store.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, false);
		expect(result).toEqual({ files: null, meta: null, reject: 'vault-mismatch' });
		store.close();
	});

	it('rejects a changed createdField', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.writeMeta(makeMeta({ vaultId, settingsFingerprint: Store.fingerprintSettings('created', []) }));
		const result = await store.load(
			{ vaultId, settingsFingerprint: Store.fingerprintSettings('date', []) },
			false,
		);
		expect(result).toEqual({ files: null, meta: null, reject: 'settings-changed' });
		store.close();
	});

	it('rejects changed excludedFolders', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.writeMeta(
			makeMeta({ vaultId, settingsFingerprint: Store.fingerprintSettings('created', ['Archiv']) }),
		);
		const result = await store.load(
			{ vaultId, settingsFingerprint: Store.fingerprintSettings('created', ['Archiv', 'Vorlagen']) },
			false,
		);
		expect(result).toEqual({ files: null, meta: null, reject: 'settings-changed' });
		store.close();
	});

	it('reports forced without reading anything', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.putFiles(makeFiles(2));
		await store.writeMeta(makeMeta({ vaultId }));
		const result = await store.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, true);
		expect(result).toEqual({ files: null, meta: null, reject: 'forced' });
		store.close();
	});

	it('rejects a damaged meta record as corrupt', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.writeMeta(makeMeta({ vaultId }));
		store.close();
		await rawPut(`sift-index-${vaultId}`, 'meta', { nonsense: true }, 'meta');

		const reopened = new Store(vaultId);
		await reopened.open();
		const result = await reopened.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, false);
		expect(result).toEqual({ files: null, meta: null, reject: 'corrupt' });
		reopened.close();
	});

	it('rejects the whole store when a single file record is damaged', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.putFiles(makeFiles(3));
		await store.writeMeta(makeMeta({ vaultId }));
		store.close();
		await rawPut(`sift-index-${vaultId}`, 'files', { id: 1, path: 'Notes/note-1.md' });

		const reopened = new Store(vaultId);
		await reopened.open();
		const result = await reopened.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, false);
		expect(result).toEqual({ files: null, meta: null, reject: 'corrupt' });
		reopened.close();
	});

	it('rejects a file record whose typed array was replaced by a plain array', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.writeMeta(makeMeta({ vaultId }));
		store.close();
		const damaged = { ...makeFile({ id: 5 }), offsetMap: [0, 1, 2] };
		await rawPut(`sift-index-${vaultId}`, 'files', damaged);

		const reopened = new Store(vaultId);
		await reopened.open();
		const result = await reopened.load({ vaultId, settingsFingerprint: makeMeta().settingsFingerprint }, false);
		expect(result.reject).toBe('corrupt');
		expect(result.files).toBeNull();
		reopened.close();
	});
});

/* -------------------------------------------------------------------------- */
/* Stats, deletion, clear                                                     */
/* -------------------------------------------------------------------------- */

describe('Store maintenance', () => {
	it('projects stats without the text', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		await store.putFiles([makeFile({ id: 1, size: 11 }), makeFile({ id: 2, path: 'b.md', size: 22 })]);

		const stats = await store.readStats();
		expect(stats).toHaveLength(2);
		const sorted = [...stats].sort((a, b) => a.id - b.id);
		expect(sorted[0]).toEqual({ id: 1, path: 'Notes/kaffee.md', indexedMtime: 1_700_000_100_000, size: 11 });
		expect(Object.keys(sorted[0]).sort()).toEqual(['id', 'indexedMtime', 'path', 'size']);
		store.close();
	});

	it('deletes by id', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		await store.putFiles(makeFiles(5));
		await store.deleteFiles([1, 3]);
		const stats = await store.readStats();
		expect(stats.map((stat) => stat.id).sort((a, b) => a - b)).toEqual([0, 2, 4]);
		store.close();
	});

	it('deletes by path through the path index', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		await store.putFiles(makeFiles(4));
		await store.deleteByPaths(['Notes/note-0.md', 'Notes/note-2.md', 'Notes/does-not-exist.md']);
		const stats = await store.readStats();
		expect(stats.map((stat) => stat.path).sort()).toEqual(['Notes/note-1.md', 'Notes/note-3.md']);
		store.close();
	});

	it('clears both object stores', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		await store.open();
		await store.putFiles(makeFiles(3));
		await store.writeMeta(makeMeta({ vaultId }));
		await store.clear();
		expect(await store.readStats()).toEqual([]);
		expect(await store.readMeta()).toBeNull();
		store.close();
	});

	it('accepts empty batches without opening a transaction', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
		await store.putFiles([]);
		await store.deleteFiles([]);
		await store.deleteByPaths([]);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
		store.close();
	});
});

/* -------------------------------------------------------------------------- */
/* Batching                                                                   */
/* -------------------------------------------------------------------------- */

describe('Store batching', () => {
	it('writes 1000 records in ceil(1000 / storeBatchSize) transactions', async () => {
		const store = new Store(nextVaultId());
		await store.open();
		const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
		await store.putFiles(makeFiles(1000));
		const expectedTransactions = Math.ceil(1000 / DEFAULT_STORE_BATCH_SIZE);
		expect(expectedTransactions).toBe(5);
		expect(spy).toHaveBeenCalledTimes(expectedTransactions);
		spy.mockRestore();

		expect(await store.readStats()).toHaveLength(1000);
		store.close();
	});

	it('honours an injected batch size', async () => {
		const store = new Store(nextVaultId(), SIFT_SCHEMA_VERSION, 100);
		await store.open();
		const spy = vi.spyOn(IDBDatabase.prototype, 'transaction');
		await store.putFiles(makeFiles(1000));
		expect(spy).toHaveBeenCalledTimes(10);
		spy.mockRestore();
		store.close();
	});

	it('is atomic per batch: a failing batch writes none of its records', async () => {
		const store = new Store(nextVaultId(), SIFT_SCHEMA_VERSION, 100);
		await store.open();

		const files = makeFiles(300);
		// A function cannot be structured-cloned, so record 150 kills batch two.
		const poisoned = { ...files[150], poison: (): number => 1 } as unknown as IndexedFile;
		files[150] = poisoned;

		await expect(store.putFiles(files)).rejects.toBeInstanceOf(Error);

		const stats = await store.readStats();
		expect(stats).toHaveLength(100);
		expect(stats.every((stat) => stat.id < 100)).toBe(true);
		store.close();
	});
});

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

describe('Store availability', () => {
	it('is false before open()', () => {
		const store = new Store(nextVaultId());
		expect(store.isAvailable()).toBe(false);
	});

	it('runs in memory when there is no indexedDB at all', async () => {
		setIndexedDB(undefined);
		const store = new Store(nextVaultId());
		await expect(store.open()).resolves.toBeUndefined();
		expect(store.isAvailable()).toBe(false);

		const result = await store.load({ vaultId: 'v', settingsFingerprint: 'f' }, false);
		expect(result).toEqual({ files: null, meta: null, reject: 'missing' });
		await expect(store.putFiles(makeFiles(3))).resolves.toBeUndefined();
		await expect(store.deleteFiles([1])).resolves.toBeUndefined();
		await expect(store.deleteByPaths(['a.md'])).resolves.toBeUndefined();
		await expect(store.writeMeta(makeMeta())).resolves.toBeUndefined();
		await expect(store.clear()).resolves.toBeUndefined();
		expect(await store.readStats()).toEqual([]);
		expect(await store.readFile(1)).toBeNull();
		expect(await store.readMeta()).toBeNull();
		expect(() => store.close()).not.toThrow();
	});

	it('survives an open() that throws synchronously', async () => {
		setIndexedDB(hostileFactory('throw'));
		const store = new Store(nextVaultId());
		await expect(store.open()).resolves.toBeUndefined();
		expect(store.isAvailable()).toBe(false);
		expect((await store.load({ vaultId: 'v', settingsFingerprint: 'f' }, false)).reject).toBe('missing');
	});

	it('survives an open() that fires an error event', async () => {
		setIndexedDB(hostileFactory('error'));
		const store = new Store(nextVaultId());
		await expect(store.open()).resolves.toBeUndefined();
		expect(store.isAvailable()).toBe(false);
	});

	it('survives an open() that stays blocked', async () => {
		setIndexedDB(hostileFactory('blocked'));
		const store = new Store(nextVaultId());
		await expect(store.open()).resolves.toBeUndefined();
		expect(store.isAvailable()).toBe(false);
	});

	it('closes a connection that only arrives after close()', async () => {
		// The window is one indexedDB.open: `this.db` is still null while the
		// request is in flight, so a close() that lands inside it used to do
		// nothing at all and the connection outlived the Store — a plugin
		// disabled during its first build left a live handle behind.
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		const opening = store.open();
		store.close();
		await opening;

		expect(store.isAvailable()).toBe(false);
		// Every write is a no-op on a closed Store, so nothing of it reaches disk.
		await store.writeMeta(makeMeta({ vaultId }));
		await store.putFiles([makeFile({ id: 1 })]);

		const second = new Store(vaultId);
		await second.open();
		expect(await second.readMeta()).toBeNull();
		expect(await second.readFile(1)).toBeNull();
		second.close();
	});

	it('opens again after a close that landed inside an open', async () => {
		const vaultId = nextVaultId();
		const store = new Store(vaultId);
		const opening = store.open();
		store.close();
		await opening;

		// The generation guard invalidates the attempt, not the Store.
		await store.open();
		expect(store.isAvailable()).toBe(true);
		await store.writeMeta(makeMeta({ vaultId }));
		expect(await store.readMeta()).toEqual(makeMeta({ vaultId }));
		store.close();
		expect(store.isAvailable()).toBe(false);
	});

	it('shares one connection attempt between concurrent open() calls', async () => {
		const store = new Store(nextVaultId());
		const spy = vi.spyOn(realIndexedDB, 'open');
		await Promise.all([store.open(), store.open(), store.open()]);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
		expect(store.isAvailable()).toBe(true);
		store.close();
	});
});

/* -------------------------------------------------------------------------- */
/* fingerprintSettings                                                        */
/* -------------------------------------------------------------------------- */

describe('Store.fingerprintSettings', () => {
	it('is order-insensitive for excludedFolders', () => {
		const a = Store.fingerprintSettings('created', ['Archiv', 'Vorlagen', 'z']);
		const b = Store.fingerprintSettings('created', ['z', 'Archiv', 'Vorlagen']);
		expect(a).toBe(b);
	});

	it('does not mutate the caller list', () => {
		const folders = ['z', 'a'];
		Store.fingerprintSettings('created', folders);
		expect(folders).toEqual(['z', 'a']);
	});

	it('changes when an entry changes', () => {
		const base = Store.fingerprintSettings('created', ['Archiv', 'Vorlagen']);
		expect(Store.fingerprintSettings('created', ['Archiv', 'Vorlage'])).not.toBe(base);
		expect(Store.fingerprintSettings('created', ['Archiv'])).not.toBe(base);
		expect(Store.fingerprintSettings('created', ['Archiv', 'Vorlagen', 'Inbox'])).not.toBe(base);
		expect(Store.fingerprintSettings('created', [])).not.toBe(base);
	});

	it('changes when createdField changes', () => {
		expect(Store.fingerprintSettings('created', ['Archiv'])).not.toBe(
			Store.fingerprintSettings('date', ['Archiv']),
		);
		expect(Store.fingerprintSettings('', [])).not.toBe(Store.fingerprintSettings('created', []));
	});

	it('does not confuse field boundaries', () => {
		// 'ab' + no folders must not collide with 'a' + folder 'b'.
		expect(Store.fingerprintSettings('ab', [])).not.toBe(Store.fingerprintSettings('a', ['b']));
		expect(Store.fingerprintSettings('created', ['a', 'bc'])).not.toBe(
			Store.fingerprintSettings('created', ['ab', 'c']),
		);
	});

	it('is stable and 16 hex characters wide', () => {
		const first = Store.fingerprintSettings('created', ['Archiv']);
		const second = Store.fingerprintSettings('created', ['Archiv']);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{16}$/);
	});
});

/* -------------------------------------------------------------------------- */
/* Store-policy guards on the module source                                   */
/* -------------------------------------------------------------------------- */

describe('Store source hygiene', () => {
	const source = readFileSync(fileURLToPath(new URL('../../src/index/Store.ts', import.meta.url)), 'utf8');

	it('imports nothing but the shared types', () => {
		const imports = source.match(/from\s+'[^']+'/g) ?? [];
		expect(imports).toEqual(["from '../types'"]);
	});

	it('uses no Node or Electron API', () => {
		expect(source).not.toMatch(/\brequire\s*\(/);
		expect(source).not.toMatch(/from\s+'(node:)?(fs|path|os|crypto|child_process|electron|util|stream)'/);
		expect(source).not.toMatch(/\bprocess\.(env|cwd|platform)/);
		expect(source).not.toMatch(/__dirname|__filename/);
	});

	it('makes no network call and runs no dynamic code', () => {
		expect(source).not.toMatch(/\b(fetch|requestUrl|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
		expect(source).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
	});

	it('logs nothing and touches no DOM', () => {
		expect(source).not.toMatch(/\bconsole\./);
		expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\./);
	});
});
