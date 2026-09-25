/**
 * main — plugin entry point.
 *
 * Loads and migrates settings, constructs Store, Indexer, Searcher, Ranker and
 * Snippets, registers the open-search command with no default hotkey plus the
 * ribbon icon, wires vault and metadataCache events through registerEvent so
 * onunload is clean, and starts indexing after workspace layout is ready so
 * startup is not blocked. Owns nothing else — it is composition and lifecycle
 * only, and every rule it has to obey lives in another module.
 */

import { Notice, Plugin, TFile, getLanguage } from 'obsidian';
import type { App } from 'obsidian';

import type { FileFormat, IndexProgress, SiftSettings, SiftTuning } from './types';
import { DEFAULT_TUNING, SiftSettingTab, migrateSettings } from './settings';
import { setLanguage, t } from './i18n/index';
import { SIFT_SCHEMA_VERSION, Store } from './index/Store';
import { formatOfExtension, indexesFormat } from './index/Formats';
import { Indexer } from './index/Indexer';
import { Searcher } from './search/Searcher';
import { Ranker } from './search/Ranker';
import { Snippets } from './search/Snippets';
import { SearchModal } from './ui/SearchModal';
import type { SearchMemory } from './ui/SearchModal';

/** `App.appId` is real and per-vault, but absent from the published typings. */
interface AppWithId {
	appId?: unknown;
}

/** Lucide icon of the ribbon entry. */
const RIBBON_ICON = 'search';

/**
 * The kind Sift would index `file` as under `settings`, or `null`.
 *
 * Everything the vault emits goes through here first, so an attachment
 * never reaches the Indexer and a kind the user switched off stops arriving
 * the moment the setting changes.
 */
function indexableFormat(settings: SiftSettings, file: TFile): FileFormat | null {
	const format = formatOfExtension(file.extension);
	if (format === null) return null;
	return indexesFormat(settings, format) ? format : null;
}

export default class SiftPlugin extends Plugin {
	// `declare`, not a field: Plugin itself declares `settings?: unknown` as
	// of 1.13.0, and this only narrows that type. Emitting a field here would
	// initialise it to undefined and shadow what the base class holds.
	declare settings: SiftSettings;
	tuning!: SiftTuning;
	store!: Store;
	indexer!: Indexer;
	searcher!: Searcher;
	ranker!: Ranker;
	snippets!: Snippets;

	/**
	 * True once the five collaborators exist. `onunload` runs even when `onload`
	 * never got that far — a plugin disabled mid-load must still unload cleanly.
	 */
	private composed = false;

	/** The last search, for the overlay's restore button. In memory only; see {@link SearchMemory}. */
	private readonly searchMemory: SearchMemory = { last: null };

	override async onload(): Promise<void> {
		await this.loadSettings();
		setLanguage(this.settings.language, getLanguage());

		this.store = new Store(this.vaultId(), SIFT_SCHEMA_VERSION, this.tuning.storeBatchSize);
		this.indexer = new Indexer(this.app, this.store, this.settings, this.tuning);
		this.searcher = new Searcher(this.indexer, this.tuning);
		this.ranker = new Ranker(this.tuning.weights);
		this.snippets = new Snippets(this.app, this.indexer, this.tuning);
		this.composed = true;

		this.addSettingTab(new SiftSettingTab(this.app, this));

		// No `hotkeys` key, deliberately: a default binding would collide with
		// the user's own and with core search.
		this.addCommand({
			id: 'open-search',
			name: t('command.openSearch'),
			callback: (): void => {
				this.openSearch();
			},
		});

		this.addRibbonIcon(RIBBON_ICON, t('command.ribbonTooltip'), (): void => {
			this.openSearch();
		});

		this.registerVaultEvents();

		// Indexing is deferred on purpose: an awaited build inside `onload` would
		// hold up Obsidian's startup for as long as the vault takes to read, and
		// nothing needs the index until a search is opened. Events that land
		// while the build runs are queued and applied by the Indexer afterwards,
		// so nothing that changes in between is lost.
		this.app.workspace.onLayoutReady((): void => {
			void this.startIndexing();
		});
	}

	override onunload(): void {
		// Commands, the ribbon icon, the settings tab and every vault listener
		// went through a register call, so Obsidian tears those down itself.
		// These two are the only resources held outside that bookkeeping.
		if (!this.composed) return;
		this.indexer.stop();
		this.store.close();
	}

	/* ---------------------------------------------------------------------- */
	/* Settings                                                               */
	/* ---------------------------------------------------------------------- */

	/**
	 * `data.json` sits in the vault where anything may edit it, so neither a
	 * malformed file nor an unreadable one may keep the plugin from loading:
	 * `migrateSettings` is total, and a read that rejects degrades to defaults.
	 */
	async loadSettings(): Promise<void> {
		let raw: unknown = null;
		try {
			raw = await this.loadData();
		} catch {
			// Unreadable is indistinguishable from absent as far as Sift cares.
			raw = null;
		}
		this.settings = migrateSettings(raw);
		this.tuning = DEFAULT_TUNING;
	}

	/** Persists and propagates to the Indexer, rebuilding only if the fingerprint changed. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		await this.indexer.updateSettings(this.settings);
	}

	/* ---------------------------------------------------------------------- */
	/* Actions                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * Opens the overlay. Unconditionally: while the index is still building the
	 * modal shows its own 'indexing' state and starts searching by itself once
	 * the Indexer reports ready, which is a far better answer to an early
	 * keystroke than a disabled command.
	 */
	openSearch(initialQuery?: string): void {
		new SearchModal(
			this.app,
			{
				indexer: this.indexer,
				searcher: this.searcher,
				ranker: this.ranker,
				snippets: this.snippets,
				settings: this.settings,
				tuning: this.tuning,
				memory: this.searchMemory,
			},
			initialQuery,
		).open();
	}

	/** Full rebuild, triggered from the settings tab. */
	async rebuildIndex(): Promise<void> {
		await this.indexer.rebuild((progress): void => {
			this.reportIndexProgress(progress);
		});
		await this.clearRebuildFlag();
	}

	/* ---------------------------------------------------------------------- */
	/* Internals                                                              */
	/* ---------------------------------------------------------------------- */

	private async startIndexing(): Promise<void> {
		try {
			await this.indexer.start((progress): void => {
				this.reportIndexProgress(progress);
			});
		} catch {
			// The message names no file and carries no query; the index simply is
			// not there, and searching still works against whatever was loaded.
			new Notice(t('error.indexFailed'));
			return;
		}
		await this.clearRebuildFlag();
	}

	/**
	 * The one consumer of index progress in v1.0.
	 *
	 * A build that throws keeps its partial index and reports ready rather than
	 * rejecting, so without this sink a broken index looks exactly like an empty
	 * vault: no notice, no status, every query answering "no results". The
	 * Indexer also records the failure, which is what the settings tab reads for
	 * its status line; this raises the one notice the user sees. The text names
	 * no file and carries no query.
	 */
	private reportIndexProgress(progress: IndexProgress): void {
		if (progress.phase !== 'error') return;
		new Notice(t('error.indexFailed'));
	}

	/**
	 * The rebuild flag is written before the work starts so that a crash in the
	 * middle leaves the next start with a rebuild to do rather than half an
	 * index. The Indexer consumes it internally; writing the cleared value back
	 * to `data.json` is this module's job.
	 */
	private async clearRebuildFlag(): Promise<void> {
		if (!this.settings.forceRebuild) return;
		this.settings.forceRebuild = false;
		try {
			await this.saveSettings();
		} catch {
			// The index is built either way. A failed write costs one redundant
			// rebuild on the next start and nothing else.
		}
	}

	/**
	 * Vault mutations, translated into `FileChange`s.
	 *
	 * ---------------------------------------------------------------------
	 * WHY MARKDOWN AND THE OTHER KINDS LISTEN TO DIFFERENT EVENTS
	 * ---------------------------------------------------------------------
	 * Markdown content comes from `metadataCache.changed` rather than
	 * `vault.modify` because it fires after Obsidian has parsed the file, so the
	 * frontmatter the Indexer reads is current. `metadataCache` only ever fires
	 * for Markdown, though: a canvas or a base edited in place would sit stale
	 * in the index until the next full rebuild. Those two therefore listen to
	 * `vault.modify`.
	 *
	 * Deletion is the other way round and listens to `vault.delete` for every
	 * kind, Markdown included. `metadataCache.deleted` would cover Markdown as
	 * well, and subscribing to both would report one deleted note twice.
	 *
	 * The split has to stay a split. Registering `vault.modify` for Markdown as
	 * well would index every note twice on every save — once on the raw write
	 * and once after the parse — and the first of the two would carry
	 * frontmatter Obsidian had not finished reading.
	 *
	 * `vault.create` is registered for all kinds since a brand-new file reaches
	 * the cache event only after its first parse, and `vault.rename` because a
	 * move changes no bytes and therefore produces no content event at all.
	 */
	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.metadataCache.on('changed', (file): void => {
				if (indexableFormat(this.settings, file) !== 'markdown') return;
				this.indexer.applyChange({ kind: 'modified', file, path: file.path });
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file): void => {
				if (!(file instanceof TFile)) return;
				const format = indexableFormat(this.settings, file);
				// Markdown is the metadata cache's business; see above.
				if (format === null || format === 'markdown') return;
				this.indexer.applyChange({ kind: 'modified', file, path: file.path });
			}),
		);

		this.registerEvent(
			this.app.vault.on('delete', (file): void => {
				if (!(file instanceof TFile)) return;
				// The kind, not the setting: a file of a kind the user switched off
				// is already out of the index — the fingerprint changed and the
				// rebuild dropped it — while an attachment was never in it.
				if (formatOfExtension(file.extension) === null) return;
				this.indexer.applyChange({ kind: 'deleted', file: null, path: file.path });
			}),
		);

		this.registerEvent(
			this.app.vault.on('create', (file): void => {
				if (!(file instanceof TFile)) return;
				if (indexableFormat(this.settings, file) === null) return;
				this.indexer.applyChange({ kind: 'created', file, path: file.path });
			}),
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath): void => {
				if (!(file instanceof TFile)) return;
				if (indexableFormat(this.settings, file) !== null) {
					this.indexer.applyChange({ kind: 'renamed', file, path: file.path, oldPath });
					return;
				}
				// Renamed into a kind Sift does not index: whatever sat under the
				// old path is no longer something Sift may return.
				this.indexer.applyChange({ kind: 'deleted', file: null, path: oldPath });
			}),
		);
	}

	/**
	 * Name component of the IndexedDB database, so two vaults on one machine
	 * never share an index. `appId` is per-vault and stable; the vault name is
	 * the fallback for builds that do not expose it.
	 */
	private vaultId(): string {
		const appId = (this.app as App & AppWithId).appId;
		return typeof appId === 'string' && appId !== '' ? appId : this.app.vault.getName();
	}
}
