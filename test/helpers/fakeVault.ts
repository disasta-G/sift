/**
 * In-memory `App` double for the Indexer, Searcher and Snippets tests.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * Three things the real vault does are load-bearing for those suites and are
 * therefore modelled properly rather than faked away:
 *
 *  1. `cachedRead` call counting. "A file whose mtime still matches is never
 *     re-read" is only assertable if reads are counted per path.
 *  2. Event ordering. Obsidian fires the `vault` event first and the
 *     `metadataCache` event after parsing; an indexer that reacts to the wrong
 *     one, or assumes the other order, has to fail here.
 *  3. Identity. `getFileByPath` returns the SAME `TFile` object across calls, and
 *     a rename mutates that object in place instead of creating a new one —
 *     which is exactly why "rename keeps the FileId" is a real test and not a
 *     tautology.
 *
 * TYPES: the runtime objects come from `test/stubs/obsidian.ts`, but the public
 * surface is typed with Obsidian's own declarations so a test can hand
 * `fake.asApp()` straight to a constructor that wants an `App`. The casts that
 * bridge the two live here and nowhere else.
 */

import type { App, DataAdapter, EventRef, TAbstractFile, TFile } from 'obsidian';
import { TFile as StubTFile, TFolder as StubTFolder } from '../stubs/obsidian';

/* ========================================================================== */
/* 1. Inputs                                                                  */
/* ========================================================================== */

/** One file of the starting vault. Times default to a fixed epoch so tests are deterministic. */
export interface FakeFileSpec {
	content: string;
	/** Creation time in ms. Default {@link DEFAULT_CTIME}. */
	ctime?: number;
	/** Modification time in ms. Defaults to `ctime`. */
	mtime?: number;
}

/** 2026-01-01T00:00:00Z — an arbitrary but fixed instant, so nothing depends on the wall clock. */
export const DEFAULT_CTIME = Date.UTC(2026, 0, 1);

/** Vault event names the fake emits. */
export type VaultEventName = 'create' | 'modify' | 'delete' | 'rename';
/** Metadata-cache event names the fake emits. */
export type MetadataEventName = 'changed' | 'deleted' | 'resolve' | 'resolved';

/** One dispatched event, in order, for tests that assert ordering. */
export interface RecordedEvent {
	source: 'vault' | 'metadataCache';
	name: string;
	path: string;
	/** Only for `rename`. */
	oldPath?: string;
}

/* ========================================================================== */
/* 2. Internals                                                               */
/* ========================================================================== */

type Handler = (...args: unknown[]) => unknown;

interface Registration extends EventRef {
	name: string;
	handler: Handler;
	detach(): void;
}

/** Minimal emitter. Kept local so `Component.registerEvent`'s cleanup path works on these refs. */
class Emitter {
	private readonly handlers = new Map<string, Registration[]>();

	on(name: string, handler: Handler): EventRef {
		const registration: Registration = {
			name,
			handler,
			detach: () => {
				this.remove(name, handler);
			},
		};
		const list = this.handlers.get(name);
		if (list === undefined) this.handlers.set(name, [registration]);
		else list.push(registration);
		return registration;
	}

	off(name: string, handler: Handler): void {
		this.remove(name, handler);
	}

	offref(ref: EventRef): void {
		const registration = ref as Registration;
		if (typeof registration.detach === 'function') registration.detach();
	}

	trigger(name: string, ...args: unknown[]): void {
		const list = this.handlers.get(name);
		if (list === undefined) return;
		for (const registration of list.slice()) registration.handler(...args);
	}

	listenerCount(name: string): number {
		return this.handlers.get(name)?.length ?? 0;
	}

	private remove(name: string, handler: Handler): void {
		const list = this.handlers.get(name);
		if (list === undefined) return;
		const at = list.findIndex((registration) => registration.handler === handler);
		if (at >= 0) list.splice(at, 1);
	}
}

function folderOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/** Byte length, so `stat.size` matches what a real vault reports for UTF-8 content. */
function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/* ========================================================================== */
/* 3. Public surface                                                          */
/* ========================================================================== */

/** The subset of `Vault` the fake implements, plus its test affordances. */
export interface FakeVault {
	getName(): string;
	getMarkdownFiles(): TFile[];
	getFiles(): TFile[];
	getAllLoadedFiles(): TAbstractFile[];
	getRoot(): TAbstractFile;
	getFileByPath(path: string): TFile | null;
	getFolderByPath(path: string): TAbstractFile | null;
	getAbstractFileByPath(path: string): TAbstractFile | null;
	/** Counted. A test asserting "not re-read" watches {@link FakeApp.readCount}. */
	cachedRead(file: TFile): Promise<string>;
	/** Counted too, under the same key. */
	read(file: TFile): Promise<string>;
	adapter: DataAdapter;
	on(name: string, handler: Handler): EventRef;
	off(name: string, handler: Handler): void;
	offref(ref: EventRef): void;
	trigger(name: string, ...args: unknown[]): void;
	/** Fires a vault event by hand, for tests that drive the indexer directly. */
	emit(name: VaultEventName, ...args: unknown[]): void;
	/** Live handler count for `name`. Proves `onunload` detached everything. */
	listenerCount(name: string): number;
}

/** The subset of `MetadataCache` the fake implements. */
export interface FakeMetadataCache {
	getFileCache(file: TFile): Record<string, unknown> | null;
	getCache(path: string): Record<string, unknown> | null;
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
	on(name: string, handler: Handler): EventRef;
	off(name: string, handler: Handler): void;
	offref(ref: EventRef): void;
	trigger(name: string, ...args: unknown[]): void;
	emit(name: MetadataEventName, ...args: unknown[]): void;
	listenerCount(name: string): number;
}

/** A workspace leaf, enough for "open the hit". */
export interface FakeLeaf {
	view: unknown;
	openFile(file: TFile): Promise<void>;
	/** Test affordance: every file opened through this leaf, in order. */
	readonly opened: string[];
}

/** The subset of `Workspace` the fake implements. */
export interface FakeWorkspace {
	onLayoutReady(callback: () => unknown): void;
	/** Test affordance: runs the callbacks queued by `onLayoutReady`. */
	triggerLayoutReady(): void;
	getLeaf(newLeaf?: boolean | string): FakeLeaf;
	getActiveViewOfType(): null;
	on(name: string, handler: Handler): EventRef;
	off(name: string, handler: Handler): void;
	offref(ref: EventRef): void;
	trigger(name: string, ...args: unknown[]): void;
	/** Test affordance: every `getLeaf` result, newest last. */
	readonly leaves: FakeLeaf[];
}

/** Everything `createFakeApp` returns: an `App`-shaped object plus mutation and inspection helpers. */
export interface FakeApp {
	/** Obsidian's per-vault id. Undocumented in the public typings, so `Store` casts for it. */
	appId: string;
	vault: FakeVault;
	metadataCache: FakeMetadataCache;
	workspace: FakeWorkspace;

	/** The same object, typed as Obsidian's `App`. The only cast a test should ever need. */
	asApp(): App;

	/**
	 * Creates or overwrites a file.
	 *
	 * A new path fires `vault:create` then `metadataCache:changed`; an existing
	 * one fires `vault:modify` then `metadataCache:changed` — the order the app
	 * uses. `mtime` advances by one millisecond per write unless given, so a
	 * staleness check has something to see.
	 */
	writeFile(path: string, content: string, times?: { ctime?: number; mtime?: number }): TFile;

	/** Fires `vault:delete` then `metadataCache:deleted`. */
	deleteFile(path: string): void;

	/**
	 * Renames in place: the SAME `TFile` object comes back with a new path, which
	 * is what makes "rename keeps the FileId" a meaningful assertion. Fires
	 * `vault:rename` with `(file, oldPath)`.
	 */
	renameFile(oldPath: string, newPath: string): TFile;

	/** How often `cachedRead`/`read` was called for `path` since the last reset. */
	readCount(path: string): number;
	/** Total reads across every path. */
	totalReadCount(): number;
	resetReadCounts(): void;

	/** Every event dispatched so far, in order. Cleared by {@link resetEvents}. */
	readonly events: RecordedEvent[];
	resetEvents(): void;

	/** Current content of `path`, without counting a read. */
	contentOf(path: string): string | null;
	/** Every path currently in the vault, sorted. */
	paths(): string[];
}

/* ========================================================================== */
/* 4. Factory                                                                 */
/* ========================================================================== */

/**
 * Builds a fake app over `files`.
 *
 * ```ts
 * const fake = createFakeApp({ 'Projekte/Kaffee.md': { content: '# Espressomaschine' } });
 * const indexer = new Indexer(fake.asApp(), store, settings, tuning);
 * ```
 */
export function createFakeApp(files: Record<string, FakeFileSpec>): FakeApp {
	const contents = new Map<string, string>();
	const entries = new Map<string, StubTFile>();
	const folders = new Map<string, StubTFolder>();
	const readCounts = new Map<string, number>();
	const events: RecordedEvent[] = [];

	const vaultEmitter = new Emitter();
	const metadataEmitter = new Emitter();
	const workspaceEmitter = new Emitter();
	const layoutReadyCallbacks: Array<() => unknown> = [];
	const leaves: FakeLeaf[] = [];

	const root = new StubTFolder('');

	function ensureFolders(path: string): StubTFolder {
		const parent = folderOf(path);
		if (parent === '') return root;
		const existing = folders.get(parent);
		if (existing !== undefined) return existing;
		const folder = new StubTFolder(parent);
		folder.parent = ensureFolders(parent);
		folder.parent.children.push(folder);
		folders.set(parent, folder);
		return folder;
	}

	function put(path: string, spec: FakeFileSpec): StubTFile {
		const ctime = spec.ctime ?? DEFAULT_CTIME;
		const mtime = spec.mtime ?? ctime;
		const file = new StubTFile(path, { ctime, mtime, size: byteLength(spec.content) });
		file.parent = ensureFolders(path);
		file.parent.children.push(file);
		entries.set(path, file);
		contents.set(path, spec.content);
		return file;
	}

	for (const path of Object.keys(files).sort()) {
		const spec = files[path];
		if (spec !== undefined) put(path, spec);
	}

	function countRead(path: string): void {
		readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
	}

	function record(source: RecordedEvent['source'], name: string, path: string, oldPath?: string): void {
		const entry: RecordedEvent = { source, name, path };
		if (oldPath !== undefined) entry.oldPath = oldPath;
		events.push(entry);
	}

	const adapter: DataAdapter = {
		getName: () => 'fake',
		exists: async (path: string) => contents.has(path),
		stat: async (path: string) => {
			const file = entries.get(path);
			if (file === undefined) return null;
			return { type: 'file', ctime: file.stat.ctime, mtime: file.stat.mtime, size: file.stat.size };
		},
		list: async (path: string) => {
			const prefix = path === '' || path === '/' ? '' : `${path}/`;
			const childFiles: string[] = [];
			const childFolders = new Set<string>();
			for (const candidate of contents.keys()) {
				if (!candidate.startsWith(prefix)) continue;
				const rest = candidate.slice(prefix.length);
				const slash = rest.indexOf('/');
				if (slash < 0) childFiles.push(candidate);
				else childFolders.add(`${prefix}${rest.slice(0, slash)}`);
			}
			return { files: childFiles.sort(), folders: [...childFolders].sort() };
		},
		read: async (path: string) => {
			countRead(path);
			return contents.get(path) ?? '';
		},
		readBinary: async (path: string) => {
			countRead(path);
			return new TextEncoder().encode(contents.get(path) ?? '').buffer;
		},
		write: async (path: string, data: string) => {
			writeFile(path, data);
		},
		writeBinary: async (path: string, data: ArrayBuffer) => {
			writeFile(path, new TextDecoder().decode(data));
		},
		append: async (path: string, data: string) => {
			writeFile(path, (contents.get(path) ?? '') + data);
		},
		process: async (path: string, fn: (data: string) => string) => {
			const next = fn(contents.get(path) ?? '');
			writeFile(path, next);
			return next;
		},
		getResourcePath: (path: string) => `app://stub/${path}`,
		mkdir: async () => undefined,
		trashSystem: async () => true,
		trashLocal: async () => undefined,
		rmdir: async () => undefined,
		remove: async (path: string) => {
			deleteFile(path);
		},
		rename: async (from: string, to: string) => {
			renameFile(from, to);
		},
		copy: async (from: string, to: string) => {
			writeFile(to, contents.get(from) ?? '');
		},
		// The remaining DataAdapter members are unused by the plugin; the cast keeps
		// this object assignable without inventing behaviour nothing calls.
	} as unknown as DataAdapter;

	function writeFile(path: string, content: string, times?: { ctime?: number; mtime?: number }): TFile {
		const existing = entries.get(path);
		if (existing === undefined) {
			const created = put(path, {
				content,
				ctime: times?.ctime ?? DEFAULT_CTIME,
				mtime: times?.mtime ?? times?.ctime ?? DEFAULT_CTIME,
			});
			record('vault', 'create', path);
			vaultEmitter.trigger('create', created);
			record('metadataCache', 'changed', path);
			metadataEmitter.trigger('changed', created, content, {});
			return created as unknown as TFile;
		}
		contents.set(path, content);
		existing.stat = {
			ctime: times?.ctime ?? existing.stat.ctime,
			mtime: times?.mtime ?? existing.stat.mtime + 1,
			size: byteLength(content),
		};
		record('vault', 'modify', path);
		vaultEmitter.trigger('modify', existing);
		record('metadataCache', 'changed', path);
		metadataEmitter.trigger('changed', existing, content, {});
		return existing as unknown as TFile;
	}

	function deleteFile(path: string): void {
		const existing = entries.get(path);
		if (existing === undefined) throw new Error(`deleteFile: no such file "${path}"`);
		entries.delete(path);
		contents.delete(path);
		const siblings = existing.parent?.children;
		if (siblings !== undefined) {
			const at = siblings.indexOf(existing);
			if (at >= 0) siblings.splice(at, 1);
		}
		record('vault', 'delete', path);
		vaultEmitter.trigger('delete', existing);
		record('metadataCache', 'deleted', path);
		metadataEmitter.trigger('deleted', existing, null);
	}

	function renameFile(oldPath: string, newPath: string): TFile {
		const existing = entries.get(oldPath);
		if (existing === undefined) throw new Error(`renameFile: no such file "${oldPath}"`);
		if (entries.has(newPath)) throw new Error(`renameFile: "${newPath}" already exists`);
		const content = contents.get(oldPath) ?? '';
		entries.delete(oldPath);
		contents.delete(oldPath);
		const siblings = existing.parent?.children;
		if (siblings !== undefined) {
			const at = siblings.indexOf(existing);
			if (at >= 0) siblings.splice(at, 1);
		}
		// Mutated in place: the indexer must recognise it as the same file.
		existing.setPath(newPath);
		existing.parent = ensureFolders(newPath);
		existing.parent.children.push(existing);
		entries.set(newPath, existing);
		contents.set(newPath, content);
		record('vault', 'rename', newPath, oldPath);
		vaultEmitter.trigger('rename', existing, oldPath);
		return existing as unknown as TFile;
	}

	const vault: FakeVault = {
		getName: () => 'fake-vault',
		getMarkdownFiles: () =>
			[...entries.values()]
				.filter((file) => file.extension === 'md')
				.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) as unknown as TFile[],
		getFiles: () =>
			[...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) as unknown as TFile[],
		getAllLoadedFiles: () => [root, ...folders.values(), ...entries.values()] as unknown as TAbstractFile[],
		getRoot: () => root as unknown as TAbstractFile,
		getFileByPath: (path: string) => (entries.get(path) ?? null) as unknown as TFile | null,
		getFolderByPath: (path: string) =>
			(path === '' || path === '/' ? root : (folders.get(path) ?? null)) as unknown as TAbstractFile | null,
		getAbstractFileByPath: (path: string) => {
			if (path === '' || path === '/') return root as unknown as TAbstractFile;
			const file = entries.get(path);
			if (file !== undefined) return file as unknown as TAbstractFile;
			return (folders.get(path) ?? null) as unknown as TAbstractFile | null;
		},
		cachedRead: async (file: TFile) => {
			countRead(file.path);
			const content = contents.get(file.path);
			if (content === undefined) throw new Error(`cachedRead: no such file "${file.path}"`);
			return content;
		},
		read: async (file: TFile) => {
			countRead(file.path);
			const content = contents.get(file.path);
			if (content === undefined) throw new Error(`read: no such file "${file.path}"`);
			return content;
		},
		adapter,
		on: (name: string, handler: Handler) => vaultEmitter.on(name, handler),
		off: (name: string, handler: Handler) => {
			vaultEmitter.off(name, handler);
		},
		offref: (ref: EventRef) => {
			vaultEmitter.offref(ref);
		},
		trigger: (name: string, ...args: unknown[]) => {
			vaultEmitter.trigger(name, ...args);
		},
		emit: (name: string, ...args: unknown[]) => {
			record('vault', name, typeof args[0] === 'object' && args[0] !== null ? String((args[0] as TFile).path) : '');
			vaultEmitter.trigger(name, ...args);
		},
		listenerCount: (name: string) => vaultEmitter.listenerCount(name),
	};

	const metadataCache: FakeMetadataCache = {
		getFileCache: () => null,
		getCache: () => null,
		getFirstLinkpathDest: (linkpath: string) => {
			const direct = entries.get(linkpath) ?? entries.get(`${linkpath}.md`);
			if (direct !== undefined) return direct as unknown as TFile;
			for (const file of entries.values()) {
				if (file.basename === linkpath) return file as unknown as TFile;
			}
			return null;
		},
		on: (name: string, handler: Handler) => metadataEmitter.on(name, handler),
		off: (name: string, handler: Handler) => {
			metadataEmitter.off(name, handler);
		},
		offref: (ref: EventRef) => {
			metadataEmitter.offref(ref);
		},
		trigger: (name: string, ...args: unknown[]) => {
			metadataEmitter.trigger(name, ...args);
		},
		emit: (name: string, ...args: unknown[]) => {
			record(
				'metadataCache',
				name,
				typeof args[0] === 'object' && args[0] !== null ? String((args[0] as TFile).path) : '',
			);
			metadataEmitter.trigger(name, ...args);
		},
		listenerCount: (name: string) => metadataEmitter.listenerCount(name),
	};

	const workspace: FakeWorkspace = {
		onLayoutReady: (callback: () => unknown) => {
			layoutReadyCallbacks.push(callback);
		},
		triggerLayoutReady: () => {
			const queued = layoutReadyCallbacks.splice(0, layoutReadyCallbacks.length);
			for (const callback of queued) callback();
		},
		getLeaf: () => {
			const opened: string[] = [];
			const leaf: FakeLeaf = {
				view: null,
				opened,
				openFile: async (file: TFile) => {
					opened.push(file.path);
				},
			};
			leaves.push(leaf);
			return leaf;
		},
		getActiveViewOfType: () => null,
		on: (name: string, handler: Handler) => workspaceEmitter.on(name, handler),
		off: (name: string, handler: Handler) => {
			workspaceEmitter.off(name, handler);
		},
		offref: (ref: EventRef) => {
			workspaceEmitter.offref(ref);
		},
		trigger: (name: string, ...args: unknown[]) => {
			workspaceEmitter.trigger(name, ...args);
		},
		leaves,
	};

	const fake: FakeApp = {
		appId: 'fake-vault-id',
		vault,
		metadataCache,
		workspace,
		asApp: () => fake as unknown as App,
		writeFile,
		deleteFile,
		renameFile,
		readCount: (path: string) => readCounts.get(path) ?? 0,
		totalReadCount: () => {
			let total = 0;
			for (const count of readCounts.values()) total += count;
			return total;
		},
		resetReadCounts: () => {
			readCounts.clear();
		},
		events,
		resetEvents: () => {
			events.length = 0;
		},
		contentOf: (path: string) => contents.get(path) ?? null,
		paths: () => [...contents.keys()].sort(),
	};

	return fake;
}

/** True when `file` came out of a fake vault. Useful in assertions that mix real and fake types. */
export function isFakeFile(file: unknown): file is TFile {
	return file instanceof StubTFile;
}
