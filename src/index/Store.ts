/**
 * Store — IndexedDB persistence of the index.
 *
 * Stores per-file records only — the inverted index is derived, never
 * persisted, so an incremental change writes one small record instead of
 * touching thousands of postings rows. Validates schema version, vault id and
 * a settings fingerprint on load and rejects the store rather than serving a
 * stale index. Pure browser APIs: IndexedDB and structured-clone semantics, no
 * Node, no `fs`, works on mobile.
 *
 * Availability is never assumed. A private window, a locked-down mobile
 * WebView or a browser with storage disabled can make `indexedDB` missing or
 * make `open()` fail; both cases leave {@link Store.isAvailable} false and turn
 * every other method into a no-op, so the caller simply keeps its index in
 * memory for the session. Nothing in this module throws out of `open()` or
 * `load()`, and no promise created here is left unhandled.
 */

import type {
	FileId,
	HeadingSpan,
	IndexedFile,
	PackedWords,
	SchemaVersion,
	Span,
	StoreLoadResult,
	StoreMeta,
	StoreRejectReason,
	StoredFileStat,
	VaultPath,
} from '../types';

/**
 * Persisted-schema generation. Bumping it discards the IndexedDB content and
 * forces a full rebuild on the next start.
 */
export const SIFT_SCHEMA_VERSION: SchemaVersion = 2;

/**
 * Records written per transaction when the caller injects no batch size.
 * Mirrors `SiftTuning.storeBatchSize`; the plugin passes the tuned value into
 * the constructor so that this module keeps `src/types.ts` as its only
 * dependency.
 */
export const DEFAULT_STORE_BATCH_SIZE = 200;

/**
 * Layout version of the database itself: which object stores and indexes
 * exist. Independent of {@link SIFT_SCHEMA_VERSION}, which describes the
 * *content* of a record and is validated through the meta record instead. Only
 * a change to the object-store layout bumps this.
 */
const DB_VERSION = 1;

const META_STORE = 'meta';
const FILES_STORE = 'files';
const PATH_INDEX = 'path';

/** The `meta` store holds exactly one record, under this out-of-line key. */
const META_KEY = 'meta';

/* -------------------------------------------------------------------------- */
/* Promise wrappers around the callback-based IndexedDB API                   */
/* -------------------------------------------------------------------------- */

/** Wraps one request. The caller must not also await the transaction, or a failure would reject twice. */
function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = (): void => resolve(request.result);
		request.onerror = (): void => reject(storeError('IndexedDB request failed', request.error));
	});
}

/**
 * Wraps a whole transaction. Write paths use this instead of one promise per
 * request: an unhandled request error bubbles to the transaction and aborts
 * it, so a single promise reports the outcome and nothing rejects twice.
 */
function transactionToPromise(tx: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = (): void => resolve();
		tx.onerror = (): void => reject(storeError('IndexedDB transaction failed', tx.error));
		tx.onabort = (): void => reject(storeError('IndexedDB transaction aborted', tx.error));
	});
}

/** Aborting a transaction that already finished throws; that is not an error worth propagating. */
function abortQuietly(tx: IDBTransaction): void {
	try {
		tx.abort();
	} catch {
		// The transaction had already completed or aborted.
	}
}

/** Error names only — never a path, a query or note content. */
function storeError(message: string, cause?: DOMException | null): Error {
	return new Error(cause ? `${message} (${cause.name})` : message);
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error('IndexedDB operation failed');
}

/* -------------------------------------------------------------------------- */
/* Record validation — a stored record is untrusted input                     */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isSpan(value: unknown): value is Span {
	const span = asRecord(value);
	return span !== null && typeof span.start === 'number' && typeof span.end === 'number';
}

function isHeadingSpan(value: unknown): value is HeadingSpan {
	const heading = asRecord(value);
	return heading !== null
		&& typeof heading.level === 'number'
		&& isSpan(heading.span)
		&& isSpan(heading.textSpan);
}

function isPackedWords(value: unknown): value is PackedWords {
	const words = asRecord(value);
	return words !== null
		&& typeof words.packed === 'string'
		&& words.bounds instanceof Uint32Array
		&& typeof words.count === 'number';
}

function isStringArray(value: unknown): boolean {
	if (!Array.isArray(value)) {
		return false;
	}
	for (const entry of value as unknown[]) {
		if (typeof entry !== 'string') {
			return false;
		}
	}
	return true;
}

function isHeadingArray(value: unknown): boolean {
	if (!Array.isArray(value)) {
		return false;
	}
	for (const entry of value as unknown[]) {
		if (!isHeadingSpan(entry)) {
			return false;
		}
	}
	return true;
}

/** Returns the record typed, or `null` when anything about its shape is off. */
function toIndexedFile(value: unknown): IndexedFile | null {
	const file = asRecord(value);
	if (file === null) {
		return null;
	}
	if (typeof file.id !== 'number' || !Number.isInteger(file.id)) {
		return null;
	}
	if (typeof file.path !== 'string' || typeof file.title !== 'string' || typeof file.titleNormalized !== 'string') {
		return null;
	}
	if (typeof file.folder !== 'string' || typeof file.pathNormalized !== 'string' || typeof file.text !== 'string') {
		return null;
	}
	if (file.offsetMap !== null && !(file.offsetMap instanceof Uint32Array)) {
		return null;
	}
	if (file.frontmatterSpan !== null && !isSpan(file.frontmatterSpan)) {
		return null;
	}
	if (!isHeadingArray(file.headings) || !isStringArray(file.tags) || !isPackedWords(file.words)) {
		return null;
	}
	// Generation 2. A row from generation 1 has no `blockBreaks`, and a phrase
	// query would silently match across a paragraph break if one reached memory.
	if (!(file.blockBreaks instanceof Uint32Array)) {
		return null;
	}
	if (typeof file.createdAt !== 'number' || typeof file.modifiedAt !== 'number') {
		return null;
	}
	if (file.createdSource !== 'frontmatter' && file.createdSource !== 'ctime') {
		return null;
	}
	if (typeof file.size !== 'number' || typeof file.indexedMtime !== 'number') {
		return null;
	}
	return value as IndexedFile;
}

/** Projection of a stored record down to the staleness fields. */
function toStoredFileStat(value: unknown): StoredFileStat | null {
	const file = asRecord(value);
	if (file === null) {
		return null;
	}
	if (typeof file.id !== 'number' || typeof file.path !== 'string') {
		return null;
	}
	if (typeof file.indexedMtime !== 'number' || typeof file.size !== 'number') {
		return null;
	}
	return { id: file.id, path: file.path, indexedMtime: file.indexedMtime, size: file.size };
}

function toStoreMeta(value: unknown): StoreMeta | null {
	const meta = asRecord(value);
	if (meta === null) {
		return null;
	}
	if (typeof meta.schemaVersion !== 'number' || typeof meta.vaultId !== 'string') {
		return null;
	}
	if (typeof meta.settingsFingerprint !== 'string') {
		return null;
	}
	if (typeof meta.builtAt !== 'number' || typeof meta.nextFileId !== 'number') {
		return null;
	}
	return value as StoreMeta;
}

/* -------------------------------------------------------------------------- */
/* Settings fingerprint                                                       */
/* -------------------------------------------------------------------------- */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over both bytes of every UTF-16 code unit. Pure JS on purpose:
 * `crypto.subtle` is async and Node's `crypto` is off limits on mobile, and a
 * fingerprint only ever gets compared against exactly one other fingerprint.
 */
function fnv1a(input: string, seed: number): number {
	let hash = seed;
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME);
		hash = Math.imul(hash ^ (code >>> 8), FNV_PRIME);
	}
	return hash >>> 0;
}

function toHex8(value: number): string {
	return value.toString(16).padStart(8, '0');
}

function fingerprint(canonical: string): string {
	// Two seeds, 64 bits of output: a single 32-bit hash would collide once in
	// four billion, and a collision here means silently serving a stale index.
	return toHex8(fnv1a(canonical, FNV_OFFSET_BASIS)) + toHex8(fnv1a(canonical, FNV_OFFSET_BASIS ^ 0x5bf03635));
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

export class Store {
	private readonly dbName: string;
	private readonly schemaVersion: SchemaVersion;
	private readonly batchSize: number;
	private db: IDBDatabase | null = null;
	/** In-flight `open()`, so concurrent callers share one connection attempt. */
	private opening: Promise<void> | null = null;
	/** Set when the environment has no IndexedDB at all; retrying would be pointless. */
	private unsupported = false;
	/**
	 * Bumped by every {@link Store.close}. `openConnection` samples it before it
	 * awaits and compares afterwards, which is what makes closing a Store whose
	 * `open()` is still in flight actually close it — see the note there.
	 */
	private generation = 0;

	/**
	 * Database name is `sift-index-${vaultId}`; object stores `meta` and
	 * `files` (keyPath 'id', index on 'path').
	 *
	 * @param batchSize records per write transaction; the plugin passes
	 * `SiftTuning.storeBatchSize`, tests pass a small value.
	 */
	constructor(vaultId: string, schemaVersion: SchemaVersion = SIFT_SCHEMA_VERSION, batchSize: number = DEFAULT_STORE_BATCH_SIZE) {
		this.dbName = `sift-index-${vaultId}`;
		this.schemaVersion = schemaVersion;
		this.batchSize = Number.isFinite(batchSize) && batchSize >= 1 ? Math.floor(batchSize) : DEFAULT_STORE_BATCH_SIZE;
	}

	/** Opens the connection. Resolves either way — check {@link isAvailable} afterwards. */
	open(): Promise<void> {
		if (this.db !== null || this.unsupported) {
			return Promise.resolve();
		}
		if (this.opening === null) {
			const attempt: Promise<void> = this.openConnection().then((): void => {
				// Only clear the attempt that is still current: a close() during
				// this one drops it and a later open() may already have started
				// another.
				if (this.opening === attempt) {
					this.opening = null;
				}
			});
			this.opening = attempt;
		}
		return this.opening;
	}

	/**
	 * Closes the connection, including one that has not arrived yet.
	 *
	 * `this.db` is still null while `openConnection` waits on the open request,
	 * so a plain `db.close()` would be a no-op there and the connection would
	 * outlive the Store — a plugin disabled during its first build would leave a
	 * live `IDBDatabase` behind and {@link isAvailable} would keep saying true.
	 * Bumping the generation makes the in-flight attempt discard what it gets.
	 */
	close(): void {
		const db = this.db;
		this.db = null;
		this.generation++;
		this.opening = null;
		if (db !== null) {
			db.close();
		}
	}

	/**
	 * False when IndexedDB is blocked (private window, locked-down mobile) and
	 * also before {@link open} has run or after {@link close}. Callers then run
	 * in memory only.
	 */
	isAvailable(): boolean {
		return this.db !== null;
	}

	/**
	 * Reads meta, validates it, and on success streams every file record back.
	 * Never throws; failures come back as `reject`, always together with
	 * `files: null` so a half-loaded index can never reach the Indexer.
	 *
	 * Opens the connection if that has not happened yet, because this is the
	 * startup path.
	 */
	async load(
		expected: Pick<StoreMeta, 'vaultId' | 'settingsFingerprint'>,
		forceRebuild: boolean,
	): Promise<StoreLoadResult> {
		if (forceRebuild) {
			return rejectLoad('forced');
		}
		try {
			await this.open();
			const db = this.db;
			if (db === null) {
				return rejectLoad('missing');
			}
			const storedMeta = await this.readMetaRecord(db);
			if (storedMeta === undefined || storedMeta === null) {
				return rejectLoad('missing');
			}
			const meta = toStoreMeta(storedMeta);
			if (meta === null) {
				return rejectLoad('corrupt');
			}
			if (meta.schemaVersion !== this.schemaVersion) {
				return rejectLoad('schema-mismatch');
			}
			if (meta.vaultId !== expected.vaultId) {
				return rejectLoad('vault-mismatch');
			}
			if (meta.settingsFingerprint !== expected.settingsFingerprint) {
				return rejectLoad('settings-changed');
			}
			const files = await this.readAllFiles(db);
			if (files === null) {
				return rejectLoad('corrupt');
			}
			return { files, meta, reject: null };
		} catch {
			// A read that fails mid-way is indistinguishable from damaged data
			// as far as the caller is concerned: rebuild from the vault.
			return rejectLoad('corrupt');
		}
	}

	/**
	 * Cheap staleness pass: path + mtime + size only, no text.
	 *
	 * The record layout is one store, so the rows still have to be read; the
	 * cursor projects each one and drops it again, which keeps peak memory at
	 * one record plus the result array instead of the whole index.
	 */
	readStats(): Promise<StoredFileStat[]> {
		const db = this.db;
		if (db === null) {
			return Promise.resolve([]);
		}
		return new Promise<StoredFileStat[]>((resolve, reject) => {
			const stats: StoredFileStat[] = [];
			let request: IDBRequest<IDBCursorWithValue | null>;
			try {
				request = db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE).openCursor();
			} catch (error) {
				reject(toError(error));
				return;
			}
			request.onerror = (): void => reject(storeError('IndexedDB cursor failed', request.error));
			request.onsuccess = (): void => {
				const cursor = request.result;
				if (cursor === null) {
					resolve(stats);
					return;
				}
				const stat = toStoredFileStat(cursor.value);
				if (stat !== null) {
					stats.push(stat);
				}
				try {
					cursor.continue();
				} catch (error) {
					reject(toError(error));
				}
			};
		});
	}

	async readFile(id: FileId): Promise<IndexedFile | null> {
		const db = this.db;
		if (db === null) {
			return null;
		}
		const stored = await requestToPromise<unknown>(
			db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE).get(id),
		);
		if (stored === undefined || stored === null) {
			return null;
		}
		return toIndexedFile(stored);
	}

	/** Batched write, `batchSize` records per transaction; each batch is atomic. */
	async putFiles(files: readonly IndexedFile[]): Promise<void> {
		const db = this.db;
		if (db === null || files.length === 0) {
			return;
		}
		for (let start = 0; start < files.length; start += this.batchSize) {
			const end = Math.min(start + this.batchSize, files.length);
			await this.writeFileBatch(db, files, start, end);
		}
	}

	async deleteFiles(ids: readonly FileId[]): Promise<void> {
		const db = this.db;
		if (db === null || ids.length === 0) {
			return;
		}
		for (let start = 0; start < ids.length; start += this.batchSize) {
			const end = Math.min(start + this.batchSize, ids.length);
			const tx = db.transaction(FILES_STORE, 'readwrite');
			const done = transactionToPromise(tx);
			try {
				const store = tx.objectStore(FILES_STORE);
				for (let i = start; i < end; i++) {
					store.delete(ids[i]);
				}
			} catch (error) {
				abortQuietly(tx);
				await done.catch((): void => undefined);
				throw toError(error);
			}
			await done;
		}
	}

	async deleteByPaths(paths: readonly VaultPath[]): Promise<void> {
		const db = this.db;
		if (db === null || paths.length === 0) {
			return;
		}
		for (let start = 0; start < paths.length; start += this.batchSize) {
			const end = Math.min(start + this.batchSize, paths.length);
			const tx = db.transaction(FILES_STORE, 'readwrite');
			const done = transactionToPromise(tx);
			try {
				const store = tx.objectStore(FILES_STORE);
				const byPath = store.index(PATH_INDEX);
				for (let i = start; i < end; i++) {
					// The index is not unique, so resolve every key that carries
					// this path and delete them all. Errors bubble to the
					// transaction, which is what `done` reports.
					const lookup = byPath.getAllKeys(paths[i]);
					lookup.onsuccess = (): void => {
						for (const key of lookup.result) {
							store.delete(key);
						}
					};
				}
			} catch (error) {
				abortQuietly(tx);
				await done.catch((): void => undefined);
				throw toError(error);
			}
			await done;
		}
	}

	async writeMeta(meta: StoreMeta): Promise<void> {
		const db = this.db;
		if (db === null) {
			return;
		}
		const tx = db.transaction(META_STORE, 'readwrite');
		const done = transactionToPromise(tx);
		try {
			tx.objectStore(META_STORE).put(meta, META_KEY);
		} catch (error) {
			abortQuietly(tx);
			await done.catch((): void => undefined);
			throw toError(error);
		}
		await done;
	}

	async readMeta(): Promise<StoreMeta | null> {
		const db = this.db;
		if (db === null) {
			return null;
		}
		const stored = await this.readMetaRecord(db);
		if (stored === undefined || stored === null) {
			return null;
		}
		return toStoreMeta(stored);
	}

	/** Empties both object stores in one transaction. */
	async clear(): Promise<void> {
		const db = this.db;
		if (db === null) {
			return;
		}
		const tx = db.transaction([META_STORE, FILES_STORE], 'readwrite');
		const done = transactionToPromise(tx);
		try {
			tx.objectStore(META_STORE).clear();
			tx.objectStore(FILES_STORE).clear();
		} catch (error) {
			abortQuietly(tx);
			await done.catch((): void => undefined);
			throw toError(error);
		}
		await done;
	}

	/**
	 * Stable hash over the settings that change index content (createdField,
	 * excludedFolders). Order-insensitive: the folder list is sorted before
	 * hashing, so reordering the setting does not force a rebuild while adding,
	 * removing or editing an entry does.
	 */
	static fingerprintSettings(createdField: string, excludedFolders: readonly VaultPath[]): string {
		const folders = [...excludedFolders].sort();
		// U+0000 separates the fields and U+0001 the folders; neither can occur
		// in a vault path or a frontmatter key, so the encoding is unambiguous.
		const canonical = `1\u0000${createdField}\u0000${folders.length}\u0000${folders.join('\u0001')}`;
		return fingerprint(canonical);
	}

	/* ---------------------------------------------------------------------- */
	/* Internals                                                              */
	/* ---------------------------------------------------------------------- */

	private async openConnection(): Promise<void> {
		if (typeof indexedDB === 'undefined' || indexedDB === null) {
			// No storage backend in this environment at all.
			this.unsupported = true;
			return;
		}
		const generation = this.generation;
		try {
			const db = await this.requestConnection();
			if (generation !== this.generation) {
				// close() ran while the request was in flight. The Store is shut
				// down, so this connection belongs to nobody: hand it back rather
				// than let it outlive the plugin that asked for it.
				db.close();
				return;
			}
			// IndexedDB has no Obsidian-registered event equivalent; these two
			// handlers live and die with the connection object itself, which
			// `close()` drops.
			db.onversionchange = (): void => this.close();
			db.onclose = (): void => {
				this.db = null;
			};
			this.db = db;
		} catch {
			// Private windows and locked-down mobile WebViews refuse to open a
			// database. Nothing the plugin can fix; the caller stays in memory.
			// Only this attempt's own failure clears the field: a close plus a
			// second open may already have put a live connection there.
			if (generation === this.generation) {
				this.db = null;
			}
		}
	}

	private requestConnection(): Promise<IDBDatabase> {
		return new Promise<IDBDatabase>((resolve, reject) => {
			let request: IDBOpenDBRequest;
			try {
				request = indexedDB.open(this.dbName, DB_VERSION);
			} catch (error) {
				// `open()` itself throws in some hardened environments.
				reject(toError(error));
				return;
			}
			let settled = false;
			request.onupgradeneeded = (): void => createObjectStores(request.result);
			request.onsuccess = (): void => {
				if (settled) {
					// Already given up on this attempt; do not leak the handle.
					request.result.close();
					return;
				}
				settled = true;
				resolve(request.result);
			};
			request.onerror = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				reject(storeError('IndexedDB open failed', request.error));
			};
			request.onblocked = (): void => {
				if (settled) {
					return;
				}
				settled = true;
				reject(storeError('IndexedDB open blocked'));
			};
		});
	}

	private readMetaRecord(db: IDBDatabase): Promise<unknown> {
		return requestToPromise<unknown>(
			db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(META_KEY),
		);
	}

	/** Returns `null` as soon as one record fails validation, so the caller can reject the whole store. */
	private async readAllFiles(db: IDBDatabase): Promise<IndexedFile[] | null> {
		const stored = await requestToPromise<unknown[]>(
			db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE).getAll(),
		);
		const files: IndexedFile[] = [];
		for (const value of stored) {
			const file = toIndexedFile(value);
			if (file === null) {
				return null;
			}
			files.push(file);
		}
		return files;
	}

	private async writeFileBatch(
		db: IDBDatabase,
		files: readonly IndexedFile[],
		start: number,
		end: number,
	): Promise<void> {
		const tx = db.transaction(FILES_STORE, 'readwrite');
		const done = transactionToPromise(tx);
		try {
			const store = tx.objectStore(FILES_STORE);
			for (let i = start; i < end; i++) {
				store.put(files[i]);
			}
		} catch (error) {
			// A record that cannot be structured-cloned throws synchronously.
			// Abort so the batch stays all-or-nothing, and drain `done` before
			// rethrowing so the abort never surfaces as an unhandled rejection.
			abortQuietly(tx);
			await done.catch((): void => undefined);
			throw toError(error);
		}
		await done;
	}
}

function createObjectStores(db: IDBDatabase): void {
	if (!db.objectStoreNames.contains(META_STORE)) {
		db.createObjectStore(META_STORE);
	}
	if (!db.objectStoreNames.contains(FILES_STORE)) {
		const files = db.createObjectStore(FILES_STORE, { keyPath: 'id' });
		files.createIndex(PATH_INDEX, 'path', { unique: false });
	}
}

function rejectLoad(reason: StoreRejectReason): StoreLoadResult {
	return { files: null, meta: null, reject: reason };
}
