/**
 * Indexer — owns the in-memory index: file records plus the trigram inverted
 * index.
 *
 * Cold start loads from Store, compares mtime per file, re-reads only stale
 * ones, deletes vanished ones, then builds the trigram map — all sliced across
 * idle callbacks so the UI never blocks. The plugin registers the vault and
 * metadataCache listeners itself and forwards {@link FileChange} objects to
 * {@link Indexer.applyChange}; nothing in this module touches the plugin
 * lifecycle, so it stays unit-testable without a Plugin instance.
 *
 * ---------------------------------------------------------------------------
 * WHAT GOES INTO THE TRIGRAM MAP
 * ---------------------------------------------------------------------------
 * One map, one posting per (trigram, file). Three sources feed it:
 *
 *   1. every 3-code-unit window of the strip-folded body text;
 *   2. every window of `titleNormalized` and of `pathNormalized`, so `title:`
 *      and `path:` terms have candidates — the Searcher filters by field at
 *      verification time, which is why they share one map;
 *   3. supplementary ALIAS trigrams, per distinct word rather than per
 *      document: a word whose original spelling changes under the alias fold
 *      (`Küche` -> stored `kuche`) additionally contributes the trigrams of its
 *      alias form (`kueche`). Word-level, so no trigram can span a word
 *      boundary that does not exist in the text.
 *
 * The alias postings only ever WIDEN the candidate set; the Searcher verifies
 * every candidate against the stored text, so a missing alias posting can never
 * produce a wrong hit, only a missed candidate. That matters for one documented
 * asymmetry: the alias form of a body word is not recoverable from the stored
 * record (`text` is already folded, and {@link IndexedFile} has no field for
 * it), so body alias trigrams exist for files read in this session and not for
 * records that came back unchanged from IndexedDB. Title and path alias forms
 * ARE recoverable — `title` and `path` are stored unfolded — so those are
 * recomputed from the record and survive a store round trip.
 *
 * ---------------------------------------------------------------------------
 * SLICING
 * ---------------------------------------------------------------------------
 * Every pass over the vault runs in slices and then yields through
 * {@link Indexer.scheduleSlice} — the single place that talks to the scheduler,
 * so a test can drive the whole build with fake timers. `requestIdleCallback`
 * when the platform has it, `setTimeout(0)` otherwise: Obsidian on iOS has no
 * idle callback.
 *
 * A slice consults the clock BETWEEN files and never inside one, so
 * `tuning.indexSliceMs` bounds a slice only up to the cost of the single file
 * that is in flight when the budget runs out — normalizing a note and emitting
 * its trigrams is synchronous and scales with its length. The honest bound is
 * therefore `indexSliceMs` plus one note, and `LARGE_NOTE_UNITS` is what keeps
 * that second term from growing without limit: a note above that size moves to
 * the end of the pass and gets a slice to itself, so oversized notes never
 * stack with one another and never land on top of a slice that has already
 * spent its budget. Bounding the work WITHIN one note would mean chunking
 * `normalizeDocument`, which computes whole-document artefacts (offset map,
 * frontmatter span, headings, tags, words) that cannot be produced from a
 * window of the text.
 *
 * Mutating operations are serialized through one promise chain, so a build, a
 * drain of queued changes and a settings change can never interleave and see
 * half-updated maps.
 */

import { normalizePath } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type {
	CreatedSource,
	FileChange,
	FileId,
	IndexPhase,
	IndexProgress,
	IndexStats,
	IndexedFile,
	Millis,
	NormalizedDoc,
	Postings,
	SiftSettings,
	SiftTuning,
	TrigramIndex,
	VaultPath,
} from '../types';
import { aliasFold, foldFieldValue, normalizeDocument, parseDateValue, stripFold, toOriginalOffset } from './Normalizer';
import { SIFT_SCHEMA_VERSION, Store } from './Store';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Trigram length. `SiftTuning.trigramSize` is 3 and every window here assumes it. */
const TRIGRAM_SIZE = 3;

/**
 * Upper bound on how long an idle callback may be postponed before the browser
 * runs it anyway. Without it a busy main thread can starve the build entirely.
 */
const SLICE_IDLE_TIMEOUT_MS = 200;

/**
 * Size at which a note stops sharing a slice with its neighbours, in UTF-16
 * code units on the trigram pass and in bytes on the reading pass — the two are
 * the same number for the ASCII-and-Latin bulk of a Markdown vault, and the
 * threshold is a scheduling heuristic, not a measurement.
 *
 * 128 KiB is roughly one slice budget of synchronous work on a desktop
 * (normalizing plus indexing costs on the order of 50-80 ms per megabyte), so a
 * note at the threshold is about as expensive as a whole slice of ordinary
 * notes and everything above it is deferred and isolated. Nothing is skipped:
 * an oversized note is indexed like any other, just last and alone.
 */
const LARGE_NOTE_UNITS = 128 * 1024;

/**
 * Heap-estimate constants for {@link IndexStats.approximateBytes}.
 *
 * The estimate is deliberately coarse — it exists for the settings readout and
 * for the benchmark gate, never for a decision the code makes:
 *
 *   - `BYTES_PER_CODE_UNIT` 2: the worst case for a JS string. V8 stores pure
 *     ASCII in one byte per unit, so this over-counts a Latin vault, which is
 *     the safe direction for a budget check.
 *   - `BYTES_PER_ARRAY_POSTING` 4: one `Uint32Array` element, exactly.
 *   - `BYTES_PER_SET_POSTING` 32: a `Set` entry is a boxed number plus hash
 *     table slack. This is the whole reason {@link Indexer.compact} exists —
 *     nine million postings cost roughly 36 MB compacted and roughly 290 MB as
 *     sets, and only the first fits the 100 MB budget.
 *   - `BYTES_PER_TRIGRAM_KEY` 48: the Map entry, the three-character key string
 *     with its header, and the postings container header, amortised.
 *   - `BYTES_PER_FILE_RECORD` 256: object header plus the fields of
 *     {@link IndexedFile} and its small arrays. The rare `offsetMap` is not
 *     counted; in a Markdown vault it is a rounding error.
 *   - `BYTES_PER_BLOCK_BREAK` 4: one `Uint32Array` element of
 *     {@link IndexedFile.blockBreaks}. Unlike `offsetMap` this one is NOT rare —
 *     every note with a blank line has some — so it is counted rather than
 *     waved away; the array header is inside the 256 above.
 */
const BYTES_PER_CODE_UNIT = 2;
const BYTES_PER_ARRAY_POSTING = 4;
const BYTES_PER_SET_POSTING = 32;
const BYTES_PER_TRIGRAM_KEY = 48;
const BYTES_PER_FILE_RECORD = 256;
const BYTES_PER_BLOCK_BREAK = 4;

/* -------------------------------------------------------------------------- */
/* Local types                                                                */
/* -------------------------------------------------------------------------- */

type ProgressSink = (p: IndexProgress) => void;

/**
 * What a queued vault mutation resolves to when the drain runs.
 *
 * `index` re-reads the file, `move` relocates an existing record without a read
 * (a rename changes no bytes), `delete` drops it.
 */
type PendingKind = 'index' | 'move' | 'delete';

interface PendingChange {
	kind: PendingKind;
	/** Where the file lives now. */
	path: VaultPath;
	/** Where the record is currently filed, when a rename moved the file. */
	fromPath: VaultPath | null;
	file: TFile | null;
}

/** `App.appId` is real and per-vault, but absent from the published typings. */
interface AppWithId {
	appId?: unknown;
}

/**
 * `requestIdleCallback` is present on desktop and on Android and absent on iOS,
 * where the typings still promise it. The guard narrows the window instead of
 * trusting the declaration.
 */
function hasIdleCallback(target: Window): boolean {
	return typeof target.requestIdleCallback === 'function' && typeof target.cancelIdleCallback === 'function';
}

/* -------------------------------------------------------------------------- */
/* Free functions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Word characters of already strip-folded text. Mirrors the classification in
 * `Normalizer.extractWords`, which is what defines a word for the whole engine:
 * the strip fold reduces every Latin letter to `a`-`z`, so those plus the
 * digits are the complete set.
 */
function isFoldedWordChar(code: number): boolean {
	return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
}

/**
 * True when a stored row already carries {@link IndexedFile.blockBreaks}.
 *
 * A row written before that field existed is not a lesser record but a WRONG
 * one: read back as it is, it says the note has no block break anywhere, and a
 * quoted phrase would go on matching across paragraph breaks in exactly the
 * files that came back unchanged from IndexedDB. The clean fix is a bump of
 * `SIFT_SCHEMA_VERSION` in `src/index/Store.ts`, which discards the whole store;
 * until that happens this check drops the individual row, and the ordinary
 * staleness path re-reads the file — self-healing, one re-read per stale row
 * instead of a full rebuild.
 */
function carriesBlockBreaks(record: IndexedFile): boolean {
	return record.blockBreaks instanceof Uint32Array;
}

/** Adds every 3-code-unit window of `text` to `out`. */
function addTrigrams(out: Set<string>, text: string): void {
	for (let i = 0; i + TRIGRAM_SIZE <= text.length; i++) {
		out.add(text.slice(i, i + TRIGRAM_SIZE));
	}
}

/**
 * Adds the alias form of every word of `normalized` whose source spelling
 * changes under the alias fold.
 *
 * `original` must be offset-parallel to `normalized`, which is exactly what the
 * offset contract guarantees; when a file carries an offset map, `toOriginal`
 * bridges the two. Word-level on purpose: aliasing the whole document would
 * shift every following character and invent trigrams across word boundaries.
 */
function collectAliasForms(
	normalized: string,
	original: string,
	out: Set<string>,
	toOriginal?: (offset: number) => number,
): void {
	let i = 0;
	while (i < normalized.length) {
		if (!isFoldedWordChar(normalized.charCodeAt(i))) {
			i++;
			continue;
		}
		const start = i;
		while (i < normalized.length && isFoldedWordChar(normalized.charCodeAt(i))) i++;
		const from = toOriginal === undefined ? start : toOriginal(start);
		const to = toOriginal === undefined ? i : toOriginal(i);
		const alias = aliasFold(original.slice(from, to));
		if (alias !== normalized.slice(start, i)) out.add(alias);
	}
}

/** `'\n'` cannot occur inside a word, so it is an unambiguous separator. */
function packAliasForms(forms: ReadonlySet<string>): string {
	return forms.size === 0 ? '' : [...forms].join('\n');
}

/** True when a note is big enough that it has to get a slice to itself. */
function isLargeNote(units: number): boolean {
	return units > LARGE_NOTE_UNITS;
}

/**
 * Stable partition: notes below the size threshold first, oversized ones after,
 * order preserved inside each group.
 *
 * The slice loops break before an oversized note, so putting them last is what
 * turns "one big note may overrun the budget" into "one big note is the whole
 * slice". A vault with none — nearly all of them — keeps the array it already
 * has and pays one scan.
 */
function smallNotesFirst<T>(items: readonly T[], unitsOf: (item: T) => number): readonly T[] {
	let large = 0;
	for (const item of items) {
		if (isLargeNote(unitsOf(item))) large++;
	}
	if (large === 0 || large === items.length) return items;
	const below: T[] = [];
	const above: T[] = [];
	for (const item of items) {
		if (isLargeNote(unitsOf(item))) above.push(item);
		else below.push(item);
	}
	return below.concat(above);
}

function folderOf(path: VaultPath): VaultPath {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * User-typed folder names, sanitized. An entry that normalizes to the vault
 * root is dropped: excluding the root would empty the index, which is never
 * what the setting means.
 */
function normalizeExcluded(folders: readonly VaultPath[]): string[] {
	const out: string[] = [];
	for (const raw of folders) {
		if (typeof raw !== 'string') continue;
		const trimmed = raw.trim();
		if (trimmed === '') continue;
		const normalized = normalizePath(trimmed);
		if (normalized === '' || normalized === '/') continue;
		if (out.indexOf(normalized) < 0) out.push(normalized);
	}
	return out;
}

/** True when `sorted` holds `id`. The array is ascending, so this is a binary search. */
function arrayHasId(sorted: Uint32Array, id: FileId): boolean {
	let low = 0;
	let high = sorted.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const value = sorted[mid];
		if (value === id) return true;
		if (value < id) low = mid + 1;
		else high = mid - 1;
	}
	return false;
}

/** True when the array is strictly ascending, which implies sorted and duplicate-free. */
function isStrictlyAscending(values: Uint32Array): boolean {
	for (let i = 1; i < values.length; i++) {
		if (values[i - 1] >= values[i]) return false;
	}
	return true;
}

function sortedUnique(values: Uint32Array): Uint32Array {
	const copy = values.slice();
	copy.sort();
	let write = 0;
	for (let read = 0; read < copy.length; read++) {
		if (read > 0 && copy[read] === copy[read - 1]) continue;
		copy[write] = copy[read];
		write++;
	}
	return copy.subarray(0, write);
}

/* -------------------------------------------------------------------------- */
/* Indexer                                                                    */
/* -------------------------------------------------------------------------- */

export class Indexer {
	/** Exposed read-only for the Searcher's intersection loop; never mutate from outside. */
	readonly trigrams: TrigramIndex = new Map<string, Postings>();

	private readonly app: App;
	private readonly store: Store;
	private readonly tuning: SiftTuning;

	/** Own copy: the caller's object is frozen and `forceRebuild` is consumed here. */
	private settings: SiftSettings;
	private excluded: string[];
	private fingerprint: string;

	private readonly byId = new Map<FileId, IndexedFile>();
	private readonly byPath = new Map<VaultPath, IndexedFile>();

	/**
	 * Alias forms of the BODY words of a file, `'\n'`-joined, for files read in
	 * this session. Not persisted and not derivable from a stored record — see
	 * the note at the top of this file. Keeping it here is what makes removal
	 * exact: `trigramsOf` reproduces precisely the key set a file contributed,
	 * so deleting a file leaves no posting and no empty key behind.
	 */
	private readonly bodyAlias = new Map<FileId, string>();

	private nextFileId: FileId = 1;
	private ready = false;
	private compacted = false;
	private builtAt: Millis = 0;
	/** Error name of the last build that threw; see {@link Indexer.lastError}. */
	private failure: string | null = null;

	private readonly pending = new Map<VaultPath, PendingChange>();
	/** Records whose IndexedDB row is behind the in-memory index. */
	private readonly dirty = new Set<FileId>();
	private readonly removed = new Set<FileId>();
	private metaDirty = false;

	private onProgress: ProgressSink | null = null;
	private stopped = false;

	private timeoutHandle: number | null = null;
	private idleHandle: number | null = null;
	private sliceWaiters: Array<() => void> = [];
	private drainScheduled = false;

	/** Serializes every mutating operation; see the note at the top of this file. */
	private queue: Promise<void> = Promise.resolve();
	/** Persistence runs behind the build so `start()` resolves as soon as the index is searchable. */
	private persistTask: Promise<void> = Promise.resolve();

	constructor(app: App, store: Store, settings: SiftSettings, tuning: SiftTuning) {
		this.app = app;
		this.store = store;
		this.tuning = tuning;
		this.settings = { ...settings };
		this.excluded = normalizeExcluded(settings.excludedFolders);
		this.fingerprint = Store.fingerprintSettings(settings.createdField, settings.excludedFolders);
	}

	/* ---------------------------------------------------------------------- */
	/* Lifecycle                                                              */
	/* ---------------------------------------------------------------------- */

	/** Load-or-build. Resolves when the index is searchable; persistence continues in the background. */
	start(onProgress?: (p: IndexProgress) => void): Promise<void> {
		this.onProgress = onProgress ?? null;
		this.stopped = false;
		return this.enqueue(() => this.build(false));
	}

	/** Cancels pending idle slices. Called from Plugin.onunload. */
	stop(): void {
		this.stopped = true;
		this.cancelScheduledSlice();
		// Release whoever is waiting on the next slice; the loops check
		// `stopped` right after the await and unwind.
		this.releaseSliceWaiters();
	}

	rebuild(onProgress?: (p: IndexProgress) => void): Promise<void> {
		this.onProgress = onProgress ?? null;
		this.stopped = false;
		return this.enqueue(() => this.build(true));
	}

	/** Rebuilds only if the settings fingerprint changed; otherwise just swaps the reference. */
	updateSettings(settings: SiftSettings): Promise<void> {
		return this.enqueue(async () => {
			const next = Store.fingerprintSettings(settings.createdField, settings.excludedFolders);
			const changed = next !== this.fingerprint;
			this.settings = { ...settings };
			this.excluded = normalizeExcluded(settings.excludedFolders);
			this.fingerprint = next;
			if (!changed || !this.ready) return;
			this.metaDirty = true;
			await this.build(true);
		});
	}

	/* ---------------------------------------------------------------------- */
	/* Incremental updates                                                    */
	/* ---------------------------------------------------------------------- */

	/** Queues a vault mutation; coalesced and applied on the next idle slice. */
	applyChange(change: FileChange): void {
		const path = change.path;
		if (path === '') return;
		switch (change.kind) {
			case 'created':
			case 'modified': {
				const previous = this.pending.get(path);
				// A second 'modified' for the same path overwrites the first, so
				// the drain reads the file once no matter how many events land.
				this.pending.set(path, {
					kind: 'index',
					path,
					fromPath: previous?.fromPath ?? null,
					file: change.file,
				});
				break;
			}
			case 'deleted': {
				const previous = this.pending.get(path);
				this.pending.set(path, {
					kind: 'delete',
					path,
					fromPath: previous?.fromPath ?? null,
					file: null,
				});
				break;
			}
			case 'renamed': {
				const oldPath = change.oldPath ?? path;
				const previous = this.pending.get(oldPath);
				this.pending.delete(oldPath);
				// A rename chain a -> b -> c must still find the record filed
				// under a, so the origin is carried forward, never overwritten.
				const fromPath = previous?.fromPath ?? oldPath;
				const kind: PendingKind =
					previous === undefined ? 'move' : previous.kind === 'delete' ? 'delete' : 'index';
				// The queue is keyed by destination, so this entry would otherwise
				// silently replace one already queued for the same path — a delete
				// of the note the rename is about to bury. That note still has to
				// leave the index; keepDisplaced re-files it under the path where
				// its record actually lives.
				this.keepDisplaced(path, fromPath);
				this.pending.set(path, { kind, path, fromPath, file: change.file });
				break;
			}
		}
		this.scheduleDrain();
	}

	/**
	 * Rescues the entry a rename onto `path` is about to overwrite.
	 *
	 * Whatever was queued for `path` describes a DIFFERENT file: the vault only
	 * lets a rename land on an occupied path once the occupant is gone, so the
	 * queued entry is that occupant's own delete, or a move that had brought it
	 * there. Dropping it would leave its record in the index for good.
	 *
	 * Its record lives under the entry's origin. When that origin is `path`
	 * itself, the drain already handles it — {@link Indexer.relocate} forgets
	 * whoever occupies the destination — so nothing is re-filed and the queue
	 * keeps one entry per path. When the origin is somewhere else, the record
	 * sits under a path the rename never touches, and only an explicit delete
	 * there removes it. `keep` is the incoming rename's own origin and is never
	 * displaced: that record is the one being moved, not buried.
	 */
	private keepDisplaced(path: VaultPath, keep: VaultPath): void {
		const displaced = this.pending.get(path);
		if (displaced === undefined) return;
		const origin = displaced.fromPath ?? displaced.path;
		if (origin === path || origin === keep) return;
		// Something is queued for that origin already — a file created there
		// since, say. That entry owns the path and will settle it; overwriting it
		// with a delete would drop a note that does exist.
		if (this.pending.has(origin)) return;
		this.pending.delete(path);
		this.pending.set(origin, { kind: 'delete', path: origin, fromPath: null, file: null });
	}

	/** Drains the queue and persists. Awaited by tests and by the benchmark. */
	flushPending(): Promise<void> {
		return this.enqueue(async () => {
			await this.drainPending();
			this.schedulePersist();
			await this.persistTask;
		});
	}

	/* ---------------------------------------------------------------------- */
	/* Reads                                                                  */
	/* ---------------------------------------------------------------------- */

	isReady(): boolean {
		return this.ready;
	}

	/**
	 * Error name of the last build, or `null` when it finished.
	 *
	 * A build that throws keeps whatever it had indexed and reports ready, so
	 * `isReady()` alone cannot tell a broken index from an empty vault. This is
	 * what the UI reads to say so: the name of the error class only, never a
	 * message, a path or note content. Cleared by the next build that succeeds.
	 */
	lastError(): string | null {
		return this.failure;
	}

	getFile(id: FileId): IndexedFile | undefined {
		return this.byId.get(id);
	}

	getFileByPath(path: VaultPath): IndexedFile | undefined {
		return this.byPath.get(path);
	}

	allFiles(): IterableIterator<IndexedFile> {
		return this.byId.values();
	}

	fileCount(): number {
		return this.byId.size;
	}

	getPostings(trigram: string): Postings | undefined {
		return this.trigrams.get(trigram);
	}

	/** Normalizes either representation to a sorted Uint32Array for intersection. */
	static postingsToArray(postings: Postings): Uint32Array {
		if (postings instanceof Uint32Array) {
			// Compaction already produces ascending, duplicate-free lists, so the
			// common case hands back the very array the Searcher will intersect.
			return isStrictlyAscending(postings) ? postings : sortedUnique(postings);
		}
		const out = new Uint32Array(postings.size);
		let at = 0;
		for (const id of postings) {
			out[at] = id;
			at++;
		}
		out.sort();
		return out;
	}

	/** Set -> sorted Uint32Array. Idempotent. Re-expands lazily on the next incremental write. */
	compact(): void {
		for (const [key, postings] of this.trigrams) {
			if (postings instanceof Uint32Array) continue;
			const packed = new Uint32Array(postings.size);
			let at = 0;
			for (const id of postings) {
				packed[at] = id;
				at++;
			}
			packed.sort();
			this.trigrams.set(key, packed);
		}
		this.compacted = true;
	}

	stats(): IndexStats {
		let totalTextLength = 0;
		let storedCodeUnits = 0;
		let blockBreakEntries = 0;
		for (const file of this.byId.values()) {
			totalTextLength += file.text.length;
			storedCodeUnits +=
				file.text.length + file.titleNormalized.length + file.pathNormalized.length + file.words.packed.length;
			blockBreakEntries += file.blockBreaks === undefined ? 0 : file.blockBreaks.length;
		}
		let postingCount = 0;
		let setPostings = 0;
		for (const postings of this.trigrams.values()) {
			if (postings instanceof Uint32Array) {
				postingCount += postings.length;
			} else {
				postingCount += postings.size;
				setPostings += postings.size;
			}
		}
		const approximateBytes =
			storedCodeUnits * BYTES_PER_CODE_UNIT +
			(postingCount - setPostings) * BYTES_PER_ARRAY_POSTING +
			setPostings * BYTES_PER_SET_POSTING +
			this.trigrams.size * BYTES_PER_TRIGRAM_KEY +
			this.byId.size * BYTES_PER_FILE_RECORD +
			blockBreakEntries * BYTES_PER_BLOCK_BREAK;
		return {
			fileCount: this.byId.size,
			trigramCount: this.trigrams.size,
			postingCount,
			totalTextLength,
			approximateBytes,
			builtAt: this.builtAt,
			compacted: this.compacted,
		};
	}

	/* ---------------------------------------------------------------------- */
	/* Build                                                                  */
	/* ---------------------------------------------------------------------- */

	private async build(force: boolean): Promise<void> {
		this.ready = false;
		this.failure = null;
		try {
			this.emit('loading', 0, 0);
			await this.store.open();
			// The flag is consumed here, so a second start() in the same session
			// does not rebuild again; writing the cleared value back to data.json
			// is the plugin's job.
			const forced = force || this.settings.forceRebuild;
			this.settings = { ...this.settings, forceRebuild: false };

			const loaded = await this.store.load(
				{ vaultId: this.vaultId(), settingsFingerprint: this.fingerprint },
				forced,
			);
			this.resetIndex();
			if (loaded.files === null) {
				// Nothing usable in storage. Wipe it so a rebuilt index cannot
				// collide with rows left over from the rejected one.
				await this.clearStore();
				this.metaDirty = true;
			} else {
				this.seed(loaded.files, loaded.meta === null ? 1 : loaded.meta.nextFileId);
			}

			this.emit('scanning', 0, 0);
			const live = this.liveFiles();
			this.dropVanished(live);
			const stale = this.staleFiles(live);

			this.emit('reading', 0, stale.length);
			await this.readSliced(stale);
			if (this.stopped) return;

			const records = [...this.byId.values()];
			this.emit('building', 0, records.length);
			await this.buildTrigramsSliced(records);
			if (this.stopped) return;

			this.emit('compacting', 0, 0);
			this.compact();

			this.builtAt = Date.now();
			this.metaDirty = true;
			this.ready = true;
			this.emit('ready', this.byId.size, this.byId.size);
			this.schedulePersist();
		} catch (error) {
			// A build that fails leaves whatever was indexed in place: a partial
			// index still answers queries, and the message carries no path and no
			// note content. It is recorded as well as emitted, because a caller
			// that attaches its sink after the fact would otherwise never learn
			// that the index it is querying is incomplete.
			this.failure = describeError(error);
			this.ready = true;
			this.emit('error', this.byId.size, this.byId.size, this.failure);
		}
	}

	/** Seeds the record maps from storage, dropping rows that no longer belong in the index. */
	private seed(files: readonly IndexedFile[], nextFileId: FileId): void {
		let highest = 0;
		for (const record of files) {
			if (record.id > highest) highest = record.id;
			if (
				this.isExcluded(record.path)
				|| this.byPath.has(record.path)
				|| this.byId.has(record.id)
				|| !carriesBlockBreaks(record)
			) {
				// Excluded after a settings change, a duplicate row from an
				// interrupted write, or a row written before the record grew its
				// block breaks: none of the three may enter the index.
				this.removed.add(record.id);
				continue;
			}
			this.byId.set(record.id, record);
			this.byPath.set(record.path, record);
		}
		this.nextFileId = Math.max(1, nextFileId, highest + 1);
	}

	/** Markdown files the settings allow, keyed by path. */
	private liveFiles(): Map<VaultPath, TFile> {
		const live = new Map<VaultPath, TFile>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.isExcluded(file.path)) continue;
			live.set(file.path, file);
		}
		return live;
	}

	/** Drops records whose file is gone from the vault or from the indexable set. */
	private dropVanished(live: ReadonlyMap<VaultPath, TFile>): void {
		for (const record of [...this.byPath.values()]) {
			if (!live.has(record.path)) this.forget(record.path);
		}
	}

	private staleFiles(live: ReadonlyMap<VaultPath, TFile>): TFile[] {
		const stale: TFile[] = [];
		for (const file of live.values()) {
			const record = this.byPath.get(file.path);
			// An unchanged mtime is the whole point of persistence: the record is
			// reused verbatim and the file is never read.
			if (record === undefined || record.indexedMtime !== file.stat.mtime) stale.push(file);
		}
		return stale;
	}

	private async readSliced(targets: readonly TFile[]): Promise<void> {
		const budget = this.sliceBudget();
		const ordered = smallNotesFirst(targets, (file) => file.stat.size);
		let done = 0;
		while (done < ordered.length) {
			if (this.stopped) return;
			const started = Date.now();
			do {
				const file = ordered[done];
				done++;
				await this.readInto(file, false);
			} while (
				done < ordered.length
				&& !this.stopped
				// An oversized note begins a slice of its own; see LARGE_NOTE_UNITS.
				&& !isLargeNote(ordered[done].stat.size)
				&& Date.now() - started < budget
			);
			this.emit('reading', done, ordered.length);
			if (done < ordered.length) await this.yieldSlice();
		}
	}

	private async buildTrigramsSliced(records: readonly IndexedFile[]): Promise<void> {
		const budget = this.sliceBudget();
		const ordered = smallNotesFirst(records, (record) => record.text.length);
		let done = 0;
		while (done < ordered.length) {
			if (this.stopped) return;
			const started = Date.now();
			do {
				this.indexRecord(ordered[done]);
				done++;
			} while (
				done < ordered.length
				&& !isLargeNote(ordered[done].text.length)
				&& Date.now() - started < budget
			);
			this.emit('building', done, ordered.length);
			if (done < ordered.length) await this.yieldSlice();
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Record maintenance                                                     */
	/* ---------------------------------------------------------------------- */

	/**
	 * Reads one file and folds it into the index.
	 *
	 * `indexNow` is false during a cold build, where the dedicated building pass
	 * adds every record's trigrams in one go, and true for an incremental change,
	 * where only this one file is touched.
	 *
	 * The incremental path re-checks staleness first. A `metadataCache.changed`
	 * event means Obsidian re-parsed the file, not that its bytes moved, and
	 * Obsidian re-parses the whole vault after a cache reset — without the check
	 * that costs one read, one normalization, one trigram remove-and-re-add and
	 * one IndexedDB write per note, all of which reproduce the record byte for
	 * byte. The cold path applies the same mtime test in `staleFiles`.
	 */
	private async readInto(file: TFile, indexNow: boolean): Promise<void> {
		const known = this.byPath.get(file.path);
		if (indexNow && known !== undefined && this.reproducesRecord(known, file)) return;
		let raw: string;
		try {
			raw = await this.app.vault.cachedRead(file);
		} catch {
			// The file disappeared between the scan and the read. Dropping it is
			// the same outcome the delete event would have produced.
			this.forget(file.path);
			return;
		}
		const existing = this.byPath.get(file.path);
		if (existing !== undefined && indexNow) this.removeTrigrams(existing);
		const id = existing === undefined ? this.claimId() : existing.id;
		const doc = normalizeDocument(raw, this.settings);
		const record = this.toRecord(id, file, doc);
		this.bodyAlias.set(id, packAliasForms(bodyAliasForms(doc, raw)));
		this.byId.set(id, record);
		this.byPath.set(record.path, record);
		this.removed.delete(id);
		this.dirty.add(id);
		if (indexNow) this.indexRecord(record);
	}

	/**
	 * True when reading `file` again would produce exactly `record`.
	 *
	 * mtime and size are the test `staleFiles` already trusts on the cold path.
	 * The bodyAlias lookup is the condition only the incremental path needs: a
	 * record that came back from IndexedDB has no body alias forms — they are
	 * not persisted and not derivable from the record, see the note at the top
	 * of this file — and re-reading it is what restores those trigrams. For
	 * those the read is not redundant, so the guard stays out of its way.
	 */
	private reproducesRecord(record: IndexedFile, file: TFile): boolean {
		return (
			record.indexedMtime === file.stat.mtime
			&& record.size === file.stat.size
			&& this.bodyAlias.has(record.id)
		);
	}

	/**
	 * `foldFieldValue`, not `stripFold`, for the two folded name fields: neither
	 * carries an offset into the file, and both have to fold the way the document
	 * text does. `stripFold` is length-preserving by contract and therefore leaves
	 * a combining mark standing, so a note whose FILE NAME is decomposed — what
	 * macOS hands out — ended up with `text` reading `kuche` and `titleNormalized`
	 * reading `ku` + U+0308 + `che`. The query side composes before folding, so no
	 * query could produce that mark again and the note was unreachable through
	 * `title:` and `path:` — and invisible altogether when its name was the only
	 * place the word occurred.
	 */
	private toRecord(id: FileId, file: TFile, doc: NormalizedDoc): IndexedFile {
		const created = this.resolveCreated(doc, file);
		return {
			id,
			path: file.path,
			title: file.basename,
			titleNormalized: foldFieldValue(file.basename),
			folder: folderOf(file.path),
			pathNormalized: foldFieldValue(file.path),
			text: doc.text,
			offsetMap: doc.offsetMap,
			frontmatterSpan: doc.frontmatterSpan,
			headings: doc.headings,
			blockBreaks: doc.blockBreaks,
			tags: doc.tags,
			words: doc.words,
			properties: doc.frontmatter,
			createdAt: created.at,
			modifiedAt: file.stat.mtime,
			createdSource: created.source,
			size: file.stat.size,
			indexedMtime: file.stat.mtime,
		};
	}

	/** Frontmatter date when the configured field parses, `ctime` otherwise. */
	private resolveCreated(doc: NormalizedDoc, file: TFile): { at: Millis; source: CreatedSource } {
		const key = stripFold(this.settings.createdField).trim();
		if (key !== '') {
			const value = doc.frontmatter[key];
			if (typeof value === 'string') {
				const parsed = parseDateValue(value);
				if (parsed !== null) return { at: parsed, source: 'frontmatter' };
			}
		}
		return { at: file.stat.ctime, source: 'ctime' };
	}

	/**
	 * Moves an existing record to a new path without reading the file: a rename
	 * changes no bytes, so only the path-derived fields and their trigrams move.
	 * The FileId is deliberately kept — it is what links search results, the
	 * store row and the in-memory record across a rename.
	 *
	 * A record already filed under the destination belongs to the note the
	 * rename buried, and is dropped first. Without that, `byPath` would forget
	 * it while `byId` and every one of its postings kept it: a ghost record that
	 * answers searches with the buried note's text under the surviving note's
	 * path, and hands Snippets offsets into a file it was never computed from.
	 */
	private relocate(record: IndexedFile, file: TFile): IndexedFile {
		const occupant = this.byPath.get(file.path);
		if (occupant !== undefined && occupant.id !== record.id) this.forget(file.path);
		this.removeTrigrams(record);
		this.byPath.delete(record.path);
		const moved: IndexedFile = {
			...record,
			path: file.path,
			title: file.basename,
			// The same fold `toRecord` uses; a rename must not produce a record a
			// read would not have produced.
			titleNormalized: foldFieldValue(file.basename),
			folder: folderOf(file.path),
			pathNormalized: foldFieldValue(file.path),
		};
		this.byId.set(moved.id, moved);
		this.byPath.set(moved.path, moved);
		this.indexRecord(moved);
		this.dirty.add(moved.id);
		return moved;
	}

	private forget(path: VaultPath): void {
		const record = this.byPath.get(path);
		if (record === undefined) return;
		this.removeTrigrams(record);
		this.byPath.delete(record.path);
		this.byId.delete(record.id);
		// After removeTrigrams: the alias forms are part of the key set it walks.
		this.bodyAlias.delete(record.id);
		this.dirty.delete(record.id);
		this.removed.add(record.id);
	}

	private claimId(): FileId {
		const id = this.nextFileId;
		this.nextFileId = id + 1;
		return id;
	}

	private resetIndex(): void {
		this.trigrams.clear();
		this.byId.clear();
		this.byPath.clear();
		this.bodyAlias.clear();
		this.dirty.clear();
		this.removed.clear();
		this.nextFileId = 1;
		this.compacted = false;
		this.builtAt = 0;
	}

	/* ---------------------------------------------------------------------- */
	/* Trigram map                                                            */
	/* ---------------------------------------------------------------------- */

	/**
	 * Every trigram this file contributes. Deterministic given the current
	 * state, which is what lets removal be exact — see the note on
	 * {@link Indexer.bodyAlias}.
	 */
	private trigramsOf(file: IndexedFile): Set<string> {
		const out = new Set<string>();
		addTrigrams(out, file.text);
		addTrigrams(out, file.titleNormalized);
		addTrigrams(out, file.pathNormalized);

		const alias = new Set<string>();
		// Title and path keep their original spelling in the record, so their
		// alias forms are recomputed here and survive a store round trip.
		collectAliasForms(file.titleNormalized, file.title, alias);
		collectAliasForms(file.pathNormalized, file.path, alias);
		const body = this.bodyAlias.get(file.id);
		if (body !== undefined && body !== '') {
			for (const word of body.split('\n')) alias.add(word);
		}
		for (const word of alias) addTrigrams(out, word);
		return out;
	}

	private indexRecord(file: IndexedFile): void {
		for (const trigram of this.trigramsOf(file)) this.addPosting(trigram, file.id);
	}

	private removeTrigrams(file: IndexedFile): void {
		for (const trigram of this.trigramsOf(file)) this.removePosting(trigram, file.id);
	}

	private addPosting(key: string, id: FileId): void {
		const existing = this.trigrams.get(key);
		if (existing === undefined) {
			this.trigrams.set(key, new Set<FileId>([id]));
			this.compacted = false;
			return;
		}
		if (existing instanceof Uint32Array) {
			if (arrayHasId(existing, id)) return;
			// An incremental write re-expands just this key back to a Set; the
			// rest of the map stays compacted until the next compact() call.
			const expanded = new Set<FileId>(existing);
			expanded.add(id);
			this.trigrams.set(key, expanded);
			this.compacted = false;
			return;
		}
		existing.add(id);
	}

	private removePosting(key: string, id: FileId): void {
		const existing = this.trigrams.get(key);
		if (existing === undefined) return;
		if (existing instanceof Uint32Array) {
			if (!arrayHasId(existing, id)) return;
			const expanded = new Set<FileId>(existing);
			expanded.delete(id);
			this.compacted = false;
			if (expanded.size === 0) this.trigrams.delete(key);
			else this.trigrams.set(key, expanded);
			return;
		}
		existing.delete(id);
		if (existing.size === 0) this.trigrams.delete(key);
	}

	/* ---------------------------------------------------------------------- */
	/* Pending queue                                                          */
	/* ---------------------------------------------------------------------- */

	private scheduleDrain(): void {
		if (this.drainScheduled || this.stopped) return;
		this.drainScheduled = true;
		void this.yieldSlice()
			.then(() => {
				this.drainScheduled = false;
				if (this.stopped || this.pending.size === 0) return undefined;
				return this.flushPending();
			})
			.catch(() => undefined);
	}

	private async drainPending(): Promise<void> {
		if (this.pending.size === 0) return;
		const budget = this.sliceBudget();
		while (this.pending.size > 0) {
			if (this.stopped) return;
			const batch = [...this.pending.values()];
			this.pending.clear();
			let done = 0;
			while (done < batch.length) {
				const started = Date.now();
				do {
					await this.applyPending(batch[done]);
					done++;
				} while (done < batch.length && !this.stopped && Date.now() - started < budget);
				this.emit('building', done, batch.length);
				if (done < batch.length) await this.yieldSlice();
				if (this.stopped) return;
			}
		}
		// A batch of edits leaves the touched keys expanded; settle them again so
		// the steady state stays inside the memory budget.
		this.compact();
		this.builtAt = Date.now();
	}

	private async applyPending(entry: PendingChange): Promise<void> {
		const origin = entry.fromPath === null ? entry.path : entry.fromPath;
		const file = entry.kind === 'delete' ? null : (entry.file ?? this.app.vault.getFileByPath(entry.path));
		if (file === null || this.isExcluded(entry.path)) {
			// Deleted, gone, or moved into a folder the settings exclude. All
			// three mean the same thing to the index.
			this.forget(origin);
			if (origin !== entry.path) this.forget(entry.path);
			return;
		}
		const moved = origin !== entry.path;
		const record = this.byPath.get(origin);
		// Adopt the record under its new path first, so a re-read reuses the same
		// FileId instead of handing out a fresh one.
		if (moved && record !== undefined) this.relocate(record, file);
		// A rename changes no bytes: relocating the record is the whole update.
		if (entry.kind === 'move' && record !== undefined) return;
		await this.readInto(file, true);
	}

	/* ---------------------------------------------------------------------- */
	/* Persistence                                                            */
	/* ---------------------------------------------------------------------- */

	private schedulePersist(): void {
		this.persistTask = this.persistTask.then(() => this.persist()).catch(() => undefined);
	}

	private async persist(): Promise<void> {
		if (!this.store.isAvailable()) {
			this.dirty.clear();
			this.removed.clear();
			return;
		}
		const records: IndexedFile[] = [];
		for (const id of this.dirty) {
			const record = this.byId.get(id);
			if (record !== undefined) records.push(record);
		}
		const removed = [...this.removed];
		this.dirty.clear();
		this.removed.clear();
		if (records.length === 0 && removed.length === 0 && !this.metaDirty) return;
		this.metaDirty = false;
		try {
			if (removed.length > 0) await this.store.deleteFiles(removed);
			if (records.length > 0) await this.store.putFiles(records);
			await this.store.writeMeta({
				schemaVersion: SIFT_SCHEMA_VERSION,
				vaultId: this.vaultId(),
				settingsFingerprint: this.fingerprint,
				builtAt: this.builtAt,
				nextFileId: this.nextFileId,
			});
		} catch {
			// Storage is a cache. A failed write costs a rebuild next start, and
			// the in-memory index stays authoritative for this session.
			this.metaDirty = true;
		}
	}

	private async clearStore(): Promise<void> {
		try {
			await this.store.clear();
		} catch {
			// Same reasoning as in persist(): storage failures are survivable.
		}
	}

	private vaultId(): string {
		const appId = (this.app as App & AppWithId).appId;
		return typeof appId === 'string' && appId !== '' ? appId : this.app.vault.getName();
	}

	/* ---------------------------------------------------------------------- */
	/* Scheduling                                                             */
	/* ---------------------------------------------------------------------- */

	/**
	 * Milliseconds after which a slice stops taking on ANOTHER file.
	 *
	 * Not a bound on the slice: every loop completes the file it is holding
	 * before it consults the clock, so a slice runs for `budget` plus the cost of
	 * one note, and that cost is proportional to the note's length. What keeps
	 * the second term finite is the size split in the slice loops — see
	 * {@link LARGE_NOTE_UNITS} and the note at the top of this file.
	 *
	 * A budget of 0 — or a nonsensical tuning value — therefore yields after
	 * every single item rather than spinning.
	 */
	private sliceBudget(): number {
		const budget = this.tuning.indexSliceMs;
		return Number.isFinite(budget) && budget > 0 ? budget : 0;
	}

	private yieldSlice(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.sliceWaiters.push(resolve);
			this.scheduleSlice();
		});
	}

	/**
	 * The single place that talks to the scheduler.
	 *
	 * `requestIdleCallback` keeps indexing out of the way of typing and
	 * scrolling, but Obsidian on iOS does not have it — hence the runtime check
	 * and the `setTimeout(0)` fallback. Wrapping both in one method is also what
	 * makes the whole build drivable from a test with fake timers.
	 */
	private scheduleSlice(): void {
		if (this.timeoutHandle !== null || this.idleHandle !== null) return;
		const run = (): void => {
			this.timeoutHandle = null;
			this.idleHandle = null;
			this.releaseSliceWaiters();
		};
		if (hasIdleCallback(window)) {
			this.idleHandle = window.requestIdleCallback(run, { timeout: SLICE_IDLE_TIMEOUT_MS });
			return;
		}
		this.timeoutHandle = window.setTimeout(run, 0);
	}

	private cancelScheduledSlice(): void {
		if (this.timeoutHandle !== null) {
			window.clearTimeout(this.timeoutHandle);
			this.timeoutHandle = null;
		}
		if (this.idleHandle !== null) {
			if (hasIdleCallback(window)) window.cancelIdleCallback(this.idleHandle);
			this.idleHandle = null;
		}
	}

	private releaseSliceWaiters(): void {
		const waiters = this.sliceWaiters;
		this.sliceWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.queue.then(task);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private emit(phase: IndexPhase, done: number, total: number, error?: string): void {
		const sink = this.onProgress;
		if (sink === null) return;
		const progress: IndexProgress = { phase, done, total };
		if (error !== undefined) progress.error = error;
		sink(progress);
	}

	private isExcluded(path: VaultPath): boolean {
		for (const folder of this.excluded) {
			// Prefix plus separator, so 'Projekte' never swallows 'Projekte2'.
			if (path === folder || path.startsWith(`${folder}/`)) return true;
		}
		return false;
	}
}

/* -------------------------------------------------------------------------- */
/* Helpers that need no instance state                                        */
/* -------------------------------------------------------------------------- */

/** Alias forms of the body words, taken from the raw text through the offset contract. */
function bodyAliasForms(doc: NormalizedDoc, raw: string): Set<string> {
	const out = new Set<string>();
	if (doc.offsetMap === null) {
		collectAliasForms(doc.text, raw, out);
		return out;
	}
	collectAliasForms(doc.text, raw, out, (offset) => toOriginalOffset(doc, offset));
	return out;
}

/** Error names only. A message must never be able to carry a path or note content. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.name : 'IndexError';
}
