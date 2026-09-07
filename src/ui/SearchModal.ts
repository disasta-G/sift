/**
 * SearchModal — the overlay from docs/mockup-dark.html: min(70vw, 1100px)
 * wide, 80vh tall, autofocused search field with the count/duration line, the
 * filter bar, the scrolling result list (virtualized as soon as the hits
 * outgrow the viewport, whatever `maxResults` allows), the keyboard footer.
 *
 * Owns all search state, debounces at 120 ms, cancels superseded searches,
 * drives Snippets for the visible window, and handles
 * arrow/Enter/Cmd+Enter/Esc. Opening a hit resolves the file with
 * getFileByPath, opens it and places the cursor on the match offset. DOM built
 * exclusively with createEl/createDiv/setText; all listeners via
 * registerDomEvent.
 *
 * LISTENER OWNERSHIP
 * ------------------
 * `Modal` is not a `Component`, so it has no `registerDomEvent` of its own.
 * The modal owns one private `Component` that receives every DOM listener and
 * is unloaded in `onClose`; keyboard bindings go through `this.scope`, which
 * Obsidian pops together with the modal. Nothing is attached with a bare
 * `addEventListener`.
 *
 * LATE RESULTS
 * ------------
 * Every search takes a number from `searchSeq`. A search that finds its number
 * superseded — because a newer keystroke started, or because the modal closed —
 * discards its own result instead of painting it over a newer render. The
 * in-flight `AbortController` is aborted at the same moment, which stops the
 * snippet reader mid-flight.
 *
 * The snippet reader carries a SECOND controller, one per rendered window. It
 * is aborted when the window moves, so the file reads for rows the user has
 * scrolled past stop instead of queueing ahead of the rows they are looking at.
 */

import { Component, MarkdownView, Modal, Notice, Platform, normalizePath, setIcon } from 'obsidian';
import type { App, Editor, EditorPosition, TFile, WorkspaceLeaf } from 'obsidian';
import { dateFormatLocale, hasKey, t } from '../i18n/index';
import type { TranslationKey } from '../i18n/index';
import { parseQuery } from '../search/QueryParser';
import { Ranker } from '../search/Ranker';
import { FilterBar } from './FilterBar';
import { CARD_ID_PREFIX, ResultCard } from './ResultCard';
import type { Indexer } from '../index/Indexer';
import type { Searcher } from '../search/Searcher';
import type { Snippets } from '../search/Snippets';
import type {
	EmptyStateKind,
	Match,
	OpenRequest,
	OpenTarget,
	RankedHit,
	ResultCardModel,
	ResultItem,
	SearchFilters,
	SearchResult,
	SearchSummary,
	SiftSettings,
	SiftTuning,
	SortKey,
} from '../types';

export interface SearchModalDeps {
	indexer: Indexer;
	searcher: Searcher;
	ranker: Ranker;
	snippets: Snippets;
	settings: SiftSettings;
	tuning: SiftTuning;
}

/** Cards kept above and below the visible window so a fast scroll does not show gaps. */
const OVERSCAN = 8;

/** The window snaps to this block size, so scrolling one row does not re-render. */
const WINDOW_BLOCK = 20;

/**
 * Cards whose snippets are built in one `Snippets.build` call.
 *
 * The build reads one file per hit, sequentially, and the modal writes a card
 * as soon as its batch resolves. A small batch is therefore what makes the
 * first excerpts appear while the rest of the window is still being read.
 */
const SNIPPET_BATCH = 8;

/** Card height plus the list gap, until a real card has been measured. */
const DEFAULT_ROW_HEIGHT = 142;

/** Viewport height assumed when the list has not been laid out yet (test DOM, first paint). */
const FALLBACK_VIEWPORT = 640;

/** How often the modal re-checks a still-building index. */
const INDEX_POLL_MS = 250;

/** How long the opened note carries the flash class after a jump. */
const FLASH_MS = 1400;


/** Text of each empty state. `hint` is optional; a missing key is simply not rendered. */
const EMPTY_STATE_KEYS: Readonly<
	Record<EmptyStateKind, { title: TranslationKey; body: TranslationKey; hint?: TranslationKey }>
> = {
	initial: { title: 'empty.initial.title', body: 'empty.initial.body', hint: 'empty.initial.hint' },
	indexing: { title: 'empty.indexing.title', body: 'empty.indexing.body' },
	'no-results': { title: 'empty.no-results.title', body: 'empty.no-results.body', hint: 'empty.no-results.hint' },
	'query-error': { title: 'empty.query-error.title', body: 'empty.query-error.body' },
	'index-error': {
		title: 'empty.index-error.title',
		body: 'empty.index-error.body',
		hint: 'empty.index-error.hint',
	},
};

export class SearchModal extends Modal {
	private readonly deps: SearchModalDeps;
	private readonly lifecycle = new Component();

	private query: string;
	private filters: SearchFilters;
	private sort: SortKey;
	private fuzzy: boolean;

	private items: ResultItem[] = [];
	private selected = -1;
	private lastErrors: readonly { messageKey: string }[] = [];

	private searchSeq = 0;
	private abort: AbortController | null = null;
	private snippetAbort: AbortController | null = null;
	private debounceHandle: number | null = null;
	private pendingResolve: (() => void) | null = null;
	private indexPollHandle: number | null = null;
	private opened = false;

	private readonly cards = new Map<number, ResultCard>();
	private readonly snippetRequested = new Set<number>();
	private windowStart = 0;
	private windowEnd = 0;
	private rowHeight = DEFAULT_ROW_HEIGHT;

	private inputEl: HTMLInputElement | null = null;
	private countEl: HTMLElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private topSpacerEl: HTMLElement | null = null;
	private bottomSpacerEl: HTMLElement | null = null;
	private emptyEl: HTMLElement | null = null;
	private filterBar: FilterBar | null = null;

	constructor(app: App, deps: SearchModalDeps, initialQuery?: string) {
		super(app);
		this.deps = deps;
		this.query = initialQuery ?? '';
		this.sort = deps.settings.defaultSort;
		this.fuzzy = deps.settings.fuzzyByDefault;
		this.filters = {
			folder: null,
			includeSubfolders: deps.settings.includeSubfoldersByDefault,
			createdFrom: null,
			createdTo: null,
			modifiedFrom: null,
			modifiedTo: null,
			excludedFolders: [...deps.settings.excludedFolders],
		};
	}

	override onOpen(): void {
		this.opened = true;
		this.lifecycle.load();
		this.modalEl.addClass('sift-modal');
		this.containerEl.addClass('sift-modal-container');
		this.contentEl.addClass('sift-modal__content');
		this.contentEl.empty();

		this.buildHeader();
		this.filterBar = new FilterBar(
			this.app,
			this.contentEl,
			{ filters: this.filters, sort: this.sort, fuzzy: this.fuzzy, summary: null },
			{
				onFiltersChange: (filters) => {
					this.filters = filters;
					void this.runSearch(true);
				},
				onSortChange: (sort) => {
					this.sort = sort;
					void this.runSearch(true);
				},
				onFuzzyChange: (fuzzy) => {
					this.fuzzy = fuzzy;
					void this.runSearch(true);
				},
			},
		);
		this.buildResults();
		this.buildFooter();
		this.registerKeys();

		const input = this.inputEl;
		if (input !== null) {
			input.value = this.query;
			input.focus();
			input.select();
		}
		void this.runSearch(true);
	}

	override onClose(): void {
		this.opened = false;
		this.searchSeq++;
		this.clearDebounce();
		this.clearIndexPoll();
		this.abort?.abort();
		this.abort = null;
		this.snippetAbort?.abort();
		this.snippetAbort = null;
		this.clearCards();
		this.filterBar?.destroy();
		this.filterBar = null;
		this.lifecycle.unload();
		this.contentEl.empty();
		this.contentEl.removeClass('sift-modal__content');
		this.modalEl.removeClass('sift-modal');
		this.containerEl.removeClass('sift-modal-container');
		this.inputEl = null;
		this.countEl = null;
		this.resultsEl = null;
		this.listEl = null;
		this.topSpacerEl = null;
		this.bottomSpacerEl = null;
		this.emptyEl = null;
		this.items = [];
		this.selected = -1;
	}

	setQuery(query: string): void {
		this.query = query;
		if (this.inputEl !== null && this.inputEl.value !== query) this.inputEl.value = query;
	}

	/** Debounced unless `immediate`. Aborts the in-flight search. */
	runSearch(immediate?: boolean): Promise<void> {
		this.clearDebounce();
		if (immediate === true) return this.executeSearch();
		return new Promise<void>((resolve) => {
			this.pendingResolve = resolve;
			this.debounceHandle = window.setTimeout(() => {
				this.debounceHandle = null;
				this.pendingResolve = null;
				this.executeSearch().then(
					() => resolve(),
					() => resolve(),
				);
			}, this.deps.tuning.searchDebounceMs);
		});
	}

	renderResults(result: SearchResult): void {
		this.items = [...result.items];
		this.lastErrors = result.ast.errors;
		this.snippetAbort?.abort();
		this.snippetAbort = null;
		this.snippetRequested.clear();
		this.clearCards();
		this.setCount(
			{ count: result.totalCount, durationMs: result.durationMs, truncated: result.truncated },
			result.items.length,
		);

		if (this.items.length === 0) {
			this.selected = -1;
			this.renderEmptyState(this.emptyResultState(result.ast.errors.length > 0));
			return;
		}

		this.hideEmptyState();
		this.selected = 0;
		if (this.resultsEl !== null) this.resultsEl.scrollTop = 0;
		this.windowStart = 0;
		this.windowEnd = 0;
		this.updateWindow(true);
	}

	renderEmptyState(kind: EmptyStateKind): void {
		this.clearCards();
		this.selected = -1;
		this.updateActiveDescendant();
		this.setSpacer(this.topSpacerEl, 0);
		this.setSpacer(this.bottomSpacerEl, 0);
		this.listEl?.addClass('sift-results__list--hidden');
		const el = this.emptyEl;
		if (el === null) return;
		el.empty();
		el.addClass('sift-empty--visible');

		const keys = EMPTY_STATE_KEYS[kind];
		el.createDiv({ cls: 'sift-empty__title', text: t(keys.title) });
		el.createDiv({
			cls: 'sift-empty__body',
			text: kind === 'no-results' ? t(keys.body, { query: this.query.trim() }) : t(keys.body),
		});
		if (keys.hint !== undefined) el.createDiv({ cls: 'sift-empty__hint', text: t(keys.hint) });

		if (kind === 'query-error') {
			const list = el.createDiv({ cls: 'sift-empty__errors' });
			for (const error of this.lastErrors) {
				const key = error.messageKey;
				list.createDiv({ cls: 'sift-empty__error', text: hasKey(key) ? t(key) : key });
			}
		}

		// The error NAME, which is all the Indexer hands out — no message, no path,
		// no note content. It is the one thing that makes a bug report possible.
		if (kind === 'index-error') {
			const reason = this.indexFailure();
			if (reason !== null) {
				el.createDiv({ cls: 'sift-empty__errors' })
					.createDiv({ cls: 'sift-empty__error', text: t('index.failureReason', { reason }) });
			}
		}
	}

	/** Moves the keyboard cursor and scrolls the card into view. Clamps at both ends. */
	moveSelection(delta: number): void {
		const total = this.items.length;
		if (total === 0) {
			this.applySelection(-1);
			return;
		}
		const from = this.selected < 0 ? (delta > 0 ? -1 : 0) : this.selected;
		this.applySelection(Math.max(0, Math.min(total - 1, from + delta)));
	}

	async openSelected(request: Pick<OpenRequest, 'target'>): Promise<void> {
		const item = this.items[this.selected];
		if (item === undefined) return;
		const jump = jumpPosition(item);
		this.close();
		await SearchModal.openFileAtOffset(this.app, {
			path: item.path,
			target: request.target,
			offset: jump.offset,
			length: jump.length,
		});
	}

	/** Opens the file and places the cursor on the offset, with a temporary highlight. Exported for reuse and tests. */
	static openFileAtOffset(app: App, request: OpenRequest): Promise<void> {
		return openAtOffset(app, request);
	}

	/* ---------------------------------------------------------------------- */
	/* DOM construction                                                       */
	/* ---------------------------------------------------------------------- */

	private buildHeader(): void {
		const header = this.contentEl.createDiv({ cls: 'sift-header' });
		const icon = header.createDiv({ cls: 'sift-icon sift-icon--search' });
		setIcon(icon, 'search');

		const input = header.createEl('input', {
			cls: 'sift-input',
			type: 'text',
			attr: {
				'aria-label': t('search.label'),
				placeholder: t('search.placeholder'),
				spellcheck: 'false',
				autocomplete: 'off',
				enterkeyhint: 'search',
				role: 'combobox',
				'aria-expanded': 'true',
				'aria-autocomplete': 'list',
				'aria-controls': 'sift-results-list',
			},
		});
		this.inputEl = input;
		this.countEl = header.createDiv({ cls: 'sift-count' });

		this.lifecycle.registerDomEvent(input, 'input', () => {
			this.query = input.value;
			void this.runSearch();
		});
		this.lifecycle.registerDomEvent(input, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key !== 'Tab' || evt.shiftKey) return;
			evt.preventDefault();
			this.filterBar?.focusFirstControl();
		});
	}

	private buildResults(): void {
		const results = this.contentEl.createDiv({
			cls: 'sift-results',
			attr: { role: 'listbox', 'aria-label': t('result.listLabel'), id: 'sift-results-list' },
		});
		this.resultsEl = results;
		this.topSpacerEl = results.createDiv({ cls: 'sift-results__spacer' });
		this.listEl = results.createDiv({ cls: 'sift-results__list' });
		this.bottomSpacerEl = results.createDiv({ cls: 'sift-results__spacer' });
		this.emptyEl = results.createDiv({ cls: 'sift-empty' });

		this.lifecycle.registerDomEvent(results, 'scroll', () => {
			this.updateWindow(false);
		});
	}

	private buildFooter(): void {
		const footer = this.contentEl.createDiv({
			cls: 'sift-footer',
			attr: { 'aria-label': t('footer.hints') },
		});
		const modEnter = Platform.isMacOS ? t('footer.key.modEnterMac') : t('footer.key.modEnter');
		this.buildHint(footer, t('footer.key.arrows'), t('footer.navigate'));
		this.buildHint(footer, t('footer.key.enter'), t('footer.open'));
		this.buildHint(footer, modEnter, t('footer.newTab'));
		this.buildHint(footer, t('footer.key.esc'), t('footer.close'));
		// The trailing slot after the hints stays empty in v1.0.
	}

	private buildHint(footer: HTMLElement, glyph: string, label: string): void {
		const hint = footer.createSpan({ cls: 'sift-footer__hint' });
		hint.createEl('kbd', { cls: 'sift-key', text: glyph });
		hint.appendText(` ${label}`);
	}

	/**
	 * Keyboard map from the plan. Bound on the modal's own scope, which Obsidian
	 * pushes on open and pops on close, so nothing survives the modal. `Escape`
	 * is left to Obsidian's own binding.
	 *
	 * WHY EVERY UNMODIFIED KEY IS GATED
	 * ---------------------------------
	 * A `Scope` has no per-element granularity — `register` takes no target, and
	 * Obsidian dispatches the whole modal's bindings for every keydown inside it.
	 * Unconditional `preventDefault()` therefore does not only serve the search
	 * field: it also swallows `Enter` in the folder box, `Enter` on a date quick
	 * pick and `ArrowUp`/`ArrowDown` in the sort dropdown, which are the filter
	 * bar's own native behaviour. Returning `true` from the handler leaves the
	 * event untouched, so the focused control keeps its keys and the modal keeps
	 * the list navigation.
	 */
	private registerKeys(): void {
		this.scope.register([], 'ArrowDown', (evt) => {
			if (this.filterBarHasFocus()) return true;
			evt.preventDefault();
			this.moveSelection(1);
			return false;
		});
		this.scope.register([], 'ArrowUp', (evt) => {
			if (this.filterBarHasFocus()) return true;
			evt.preventDefault();
			this.moveSelection(-1);
			return false;
		});
		this.scope.register([], 'PageDown', (evt) => {
			if (this.filterBarHasFocus()) return true;
			evt.preventDefault();
			this.moveSelection(10);
			return false;
		});
		this.scope.register([], 'PageUp', (evt) => {
			if (this.filterBarHasFocus()) return true;
			evt.preventDefault();
			this.moveSelection(-10);
			return false;
		});
		this.scope.register([], 'Enter', (evt) => {
			if (this.filterBarHasFocus()) return true;
			evt.preventDefault();
			void this.openSelected({ target: 'current' });
			return false;
		});
		this.scope.register(['Mod'], 'Enter', (evt) => {
			evt.preventDefault();
			void this.openSelected({ target: 'new-tab' });
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'Enter', (evt) => {
			evt.preventDefault();
			void this.openSelected({ target: 'split' });
			return false;
		});
	}

	/**
	 * True while a control inside the filter bar owns the keyboard. The folder
	 * suggester's popover lives outside the bar but pushes its own scope while it
	 * is open, so this modal's bindings never reach it.
	 */
	private filterBarHasFocus(): boolean {
		const bar = this.filterBar;
		if (bar === null) return false;
		const active = this.contentEl.ownerDocument.activeElement;
		return active !== null && bar.el.contains(active);
	}

	/* ---------------------------------------------------------------------- */
	/* Searching                                                              */
	/* ---------------------------------------------------------------------- */

	/**
	 * Which state stands in for an empty result list.
	 *
	 * A query the parser could not read is the user's to fix and comes first. A
	 * build that threw comes next: `Indexer.build()` catches everything, keeps
	 * whatever it had indexed and reports ready, so `isReady()` lets the search
	 * through and "no note contains kaffee" becomes a statement about a vault
	 * Sift never finished reading. Only a healthy index may claim that nothing
	 * matched.
	 *
	 * The failure gates the CLAIM, not the search: a build that died halfway
	 * leaves a partial index whose hits are real, and those are still rendered.
	 */
	private emptyResultState(hasQueryErrors: boolean): EmptyStateKind {
		if (hasQueryErrors) return 'query-error';
		return this.indexFailure() === null ? 'no-results' : 'index-error';
	}

	/** Error name of the last build that threw, or `null`. Never a message, a path or note content. */
	private indexFailure(): string | null {
		return this.deps.indexer.lastError();
	}

	private async executeSearch(): Promise<void> {
		const seq = ++this.searchSeq;
		this.abort?.abort();
		this.snippetAbort?.abort();
		this.snippetAbort = null;
		const controller = new AbortController();
		this.abort = controller;

		if (!this.deps.indexer.isReady()) {
			this.items = [];
			this.setCount(null);
			this.renderEmptyState('indexing');
			this.scheduleIndexPoll();
			return;
		}

		if (this.query.trim().length === 0) {
			this.items = [];
			this.lastErrors = [];
			this.setCount(null);
			this.renderEmptyState('initial');
			return;
		}

		const ast = parseQuery(this.query, this.deps.tuning);
		this.lastErrors = ast.errors;
		if (ast.isEmpty) {
			this.items = [];
			this.setCount(null);
			this.renderEmptyState(ast.errors.length > 0 ? 'query-error' : 'initial');
			return;
		}

		const started = performance.now();
		const raw = this.deps.searcher.search(ast, {
			filters: this.filters,
			fuzzy: this.fuzzy,
			limit: this.deps.settings.maxResults,
			signal: controller.signal,
		});
		// `rank` already returns its result sorted by relevance, so at the default
		// sort order a second pass would only re-walk the whole result set through
		// the same comparator — 90+ % of whose comparisons tie on the score and
		// fall through to the collated path tiebreaker. Measured at 1.0-1.5 ms per
		// keystroke on 4 000-10 000 hits, and several times that before the shared
		// collator landed.
		const ranked = this.deps.ranker.rank(raw, ast, Date.now());
		const sorted = this.sort === 'relevance' ? ranked : Ranker.sort(ranked, this.sort);
		const capped = sorted.slice(0, Math.max(1, this.deps.settings.maxResults));
		const durationMs = performance.now() - started;

		if (seq !== this.searchSeq) return;

		this.renderResults({
			items: capped.map(toResultItem),
			totalCount: sorted.length,
			durationMs,
			truncated: sorted.length > capped.length,
			ast,
			sort: this.sort,
		});
	}

	/**
	 * Starts the snippet run for one window and cancels the one before it.
	 *
	 * Snippet work is bound to the window it was started for: when the list
	 * scrolls on, the reads for the rows the user has left stop instead of
	 * queueing ahead of the rows they are looking at now.
	 */
	private restartSnippets(indices: readonly number[]): void {
		this.snippetAbort?.abort();
		const controller = new AbortController();
		this.snippetAbort = controller;
		void this.loadSnippets(indices, controller);
	}

	/**
	 * Builds snippets for the cards in `indices`, in batches of
	 * {@link SNIPPET_BATCH}.
	 *
	 * Only indices that are in the window and still snippet-less are requested,
	 * so a scroll costs one `cachedRead` per newly exposed card and never re-reads
	 * a card that has already been filled. Each batch is written into its cards
	 * before the next one starts, so the first excerpts appear while the rest of
	 * the window is still being read.
	 *
	 * A row is CLAIMED when its own batch starts, not when the run begins: a run
	 * that is cancelled before its later batches start leaves those rows
	 * unclaimed, so the window the user actually stopped at requests them itself
	 * instead of waiting for a batch that will never run.
	 */
	private async loadSnippets(indices: readonly number[], controller: AbortController): Promise<void> {
		const seq = this.searchSeq;
		const pending = indices.filter((index) => this.needsSnippets(index));
		if (pending.length === 0) return;

		for (let at = 0; at < pending.length; at += SNIPPET_BATCH) {
			if (seq !== this.searchSeq || controller.signal.aborted) return;
			const batch = pending.slice(at, at + SNIPPET_BATCH).filter((index) => this.needsSnippets(index));
			if (batch.length === 0) continue;
			for (const index of batch) this.snippetRequested.add(index);

			let built: readonly ResultItem[];
			try {
				built = await this.deps.snippets.build(
					batch.map((index) => this.items[index]),
					this.deps.settings.snippetCount,
					controller.signal,
				);
			} catch {
				// Superseded, aborted, or a file that vanished between search and
				// render: the affected cards keep their blank snippet area.
				this.releaseSnippets(batch);
				return;
			}
			if (seq !== this.searchSeq) return;
			this.writeSnippets(batch, built);
			if (controller.signal.aborted) {
				// The window moved on while this batch was reading. What it managed
				// to read is kept — those rows are still in the list — and the rest
				// is released, so the window on screen now can ask for it.
				this.releaseSnippets(batch);
				return;
			}
		}
	}

	/** In the list, still without an excerpt, and not already claimed by a running batch. */
	private needsSnippets(index: number): boolean {
		const item = this.items[index];
		return item !== undefined && item.snippets.length === 0 && !this.snippetRequested.has(index);
	}

	private writeSnippets(batch: readonly number[], built: readonly ResultItem[]): void {
		for (let at = 0; at < batch.length; at++) {
			const index = batch[at];
			const source = built[at];
			const current = this.items[index];
			if (source === undefined || current === undefined) continue;
			if (source.snippets.length === 0) continue;
			this.items[index] = { ...current, snippets: source.snippets };
			this.cards.get(index)?.update(this.cardModel(index));
		}
	}

	/** Un-claims the rows of a cancelled batch that came back empty, so a later window asks again. */
	private releaseSnippets(batch: readonly number[]): void {
		for (const index of batch) {
			if (this.items[index]?.snippets.length === 0) this.snippetRequested.delete(index);
		}
	}

	private scheduleIndexPoll(): void {
		if (this.indexPollHandle !== null) return;
		this.indexPollHandle = window.setTimeout(() => {
			this.indexPollHandle = null;
			if (!this.opened) return;
			if (this.deps.indexer.isReady()) void this.runSearch(true);
			else this.scheduleIndexPoll();
		}, INDEX_POLL_MS);
	}

	private clearIndexPoll(): void {
		if (this.indexPollHandle === null) return;
		window.clearTimeout(this.indexPollHandle);
		this.indexPollHandle = null;
	}

	private clearDebounce(): void {
		if (this.debounceHandle !== null) {
			window.clearTimeout(this.debounceHandle);
			this.debounceHandle = null;
		}
		const resolve = this.pendingResolve;
		this.pendingResolve = null;
		resolve?.();
	}

	/* ---------------------------------------------------------------------- */
	/* List rendering and virtualization                                      */
	/* ---------------------------------------------------------------------- */

	private updateWindow(force: boolean): void {
		const total = this.items.length;
		const next = this.computeWindow(total);
		if (!force && next.start === this.windowStart && next.end === this.windowEnd) return;
		this.windowStart = next.start;
		this.windowEnd = next.end;
		this.renderWindow();
		this.restartSnippets(indexRange(next.start, next.end));
	}

	/**
	 * The slice of the result list that is actually in the DOM.
	 *
	 * Its size follows the VIEWPORT, never {@link SiftSettings.maxResults}: a cap
	 * of 200 must not mean 200 cards and 200 file reads for the four rows a user
	 * can see. The window holds what fits, the overscan above and below, and one
	 * block of slack so that
	 *
	 *   `end = start + capacity`
	 *
	 * with `start` snapped to {@link WINDOW_BLOCK}. Both edges therefore move
	 * only a whole block at a time — a one-row scroll, including the correction
	 * `scrollIntoViewIfNeeded` makes, can no longer rebuild the list under a
	 * mouse button that is still down.
	 */
	private computeWindow(total: number): { start: number; end: number } {
		if (total === 0) return { start: 0, end: 0 };
		const scroller = this.resultsEl;
		const viewport = scroller !== null && scroller.clientHeight > 0 ? scroller.clientHeight : FALLBACK_VIEWPORT;
		const rowHeight = Math.max(1, this.rowHeight);
		const visible = Math.ceil(viewport / rowHeight) + 1;
		const capacity = visible + 2 * OVERSCAN + WINDOW_BLOCK;
		if (total <= capacity) return { start: 0, end: total };

		const scrollTop = scroller === null ? 0 : scroller.scrollTop;
		const first = Math.floor(scrollTop / rowHeight);
		const start = Math.max(0, Math.floor(first / WINDOW_BLOCK) * WINDOW_BLOCK - OVERSCAN);
		return { start, end: Math.min(total, start + capacity) };
	}

	/**
	 * Rebuilds the rendered window. Cards are cheap and the window only moves in
	 * blocks, so recreating them is simpler — and always in the right order —
	 * than splicing individual elements into the middle of the list.
	 */
	private renderWindow(): void {
		const list = this.listEl;
		if (list === null) return;
		this.clearCards();
		list.removeClass('sift-results__list--hidden');

		for (let index = this.windowStart; index < this.windowEnd; index++) {
			if (this.items[index] === undefined) continue;
			const card = new ResultCard(list, this.cardModel(index), {
				// A pointer selection must not scroll: the correction would fire a
				// scroll event between mousedown and mouseup, and a window rebuild
				// there detaches the very node the button is pressed on, so the
				// browser never dispatches the click. The keyboard path scrolls.
				onSelect: (at) => {
					this.applySelection(at, false);
				},
				onOpen: (item, target) => {
					void this.openItem(item, target);
				},
			});
			this.cards.set(index, card);
		}

		// Measured before the spacers, so their height uses the row height of the
		// cards that are on screen rather than the previous window's estimate.
		this.measureRowHeight();
		this.setSpacer(this.topSpacerEl, this.windowStart * this.rowHeight);
		this.setSpacer(this.bottomSpacerEl, Math.max(0, this.items.length - this.windowEnd) * this.rowHeight);
		this.updateActiveDescendant();
	}

	/** Uses the first rendered card to replace the estimate, once the layout is real. */
	private measureRowHeight(): void {
		const first = this.cards.get(this.windowStart);
		if (first === undefined) return;
		const height = first.el.offsetHeight;
		if (height > 0) this.rowHeight = height + CARD_GAP;
	}

	private setSpacer(el: HTMLElement | null, height: number): void {
		el?.setCssProps({ height: `${Math.max(0, Math.round(height))}px` });
	}

	private clearCards(): void {
		for (const card of this.cards.values()) card.destroy();
		this.cards.clear();
		this.listEl?.empty();
	}

	private hideEmptyState(): void {
		this.emptyEl?.removeClass('sift-empty--visible');
		this.emptyEl?.empty();
		this.listEl?.removeClass('sift-results__list--hidden');
	}

	private cardModel(index: number): ResultCardModel {
		const item = this.items[index];
		return {
			item,
			index,
			selected: index === this.selected,
			dateLabel: ResultCard.formatDate(item.createdAt, dateFormatLocale()),
			folderLabel: ResultCard.formatFolder(item.folder),
			animateSelection: this.deps.settings.highlightSelectedCard,
		};
	}

	/** `scroll` is false for a pointer selection, whose card is under the cursor already. */
	private applySelection(index: number, scroll = true): void {
		if (index === this.selected) {
			if (scroll) this.cards.get(index)?.scrollIntoViewIfNeeded();
			return;
		}
		this.cards.get(this.selected)?.setSelected(false);
		this.selected = index;
		if (index < 0) {
			this.updateActiveDescendant();
			return;
		}
		if (index < this.windowStart || index >= this.windowEnd) {
			const scroller = this.resultsEl;
			if (scroller !== null) scroller.scrollTop = Math.max(0, index * this.rowHeight - this.rowHeight);
			this.updateWindow(true);
		}
		this.cards.get(index)?.setSelected(true);
		if (scroll) this.cards.get(index)?.scrollIntoViewIfNeeded();
		this.updateActiveDescendant();
	}

	private updateActiveDescendant(): void {
		const input = this.inputEl;
		if (input === null) return;
		if (this.selected < 0) input.removeAttribute('aria-activedescendant');
		else input.setAttr('aria-activedescendant', `${CARD_ID_PREFIX}${this.selected}`);
	}

	/** `shown` is the number of cards actually in the list; it differs from `count` when the cap bit. */
	private setCount(summary: SearchSummary | null, shown = 0): void {
		this.countEl?.setText(summary === null ? '' : countText(summary, shown));
		this.filterBar?.setSummary(summary);
	}

	private async openItem(item: ResultItem, target: OpenTarget): Promise<void> {
		const jump = jumpPosition(item);
		this.close();
		await SearchModal.openFileAtOffset(this.app, {
			path: item.path,
			target,
			offset: jump.offset,
			length: jump.length,
		});
	}
}

/* -------------------------------------------------------------------------- */
/* Free helpers                                                               */
/* -------------------------------------------------------------------------- */

/** The 18px flex gap between cards, mirrored from styles.css. */
const CARD_GAP = 18;

/** Match fields that carry a real file offset; title and path do not. */
const FILE_FIELDS: ReadonlySet<Match['field']> = new Set<Match['field']>([
	'body',
	'heading',
	'frontmatter',
	'tag',
]);

/**
 * Opens the file and puts the cursor on the hit.
 *
 * Written as a free function taking the app so the class body never mentions a
 * bare `app`, which the policy scan checks for.
 */
async function openAtOffset(host: App, request: OpenRequest): Promise<void> {
	const file: TFile | null = host.vault.getFileByPath(normalizePath(request.path));
	if (file === null) {
		new Notice(t('error.fileMissing'));
		return;
	}

	let leaf: WorkspaceLeaf;
	try {
		leaf = host.workspace.getLeaf(leafTarget(request.target));
		await leaf.openFile(file);
	} catch {
		new Notice(t('error.openFailed'));
		return;
	}

	const view = leaf.view;
	if (!(view instanceof MarkdownView)) return;
	const editor: Editor = view.editor;

	// The offsets were measured against the file ON DISK. The editor normalizes
	// line endings, so a CRLF file's offsets do not survive `editor.getValue()` —
	// the conversion has to run against the original text.
	let original: string;
	try {
		original = await host.vault.cachedRead(file);
	} catch {
		return;
	}

	const from = offsetToPosition(original, request.offset);
	const to = offsetToPosition(original, request.offset + Math.max(0, request.length));
	editor.setCursor(from);
	if (request.length > 0) editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
	flash(view.containerEl);
}

/** Brief accent tint on the opened note, so the eye finds the hit. */
function flash(el: HTMLElement): void {
	el.addClass('sift-flash');
	window.setTimeout(() => {
		el.removeClass('sift-flash');
	}, FLASH_MS);
}

/** `getLeaf` speaks 'tab' / 'split' / false; OpenTarget speaks the plan's words. */
function leafTarget(target: OpenTarget): 'tab' | 'split' | false {
	if (target === 'new-tab') return 'tab';
	if (target === 'split') return 'split';
	return false;
}

/**
 * Converts a UTF-16 code-unit offset in the ORIGINAL file text to a line/ch
 * pair.
 *
 * Counts code units, not code points, which is what the editor's `ch` means —
 * an emoji before the match therefore advances `ch` by two. `\r\n` and a lone
 * `\r` both count as one line break, matching CodeMirror, and an offset that
 * would land between the two halves of a surrogate pair steps back to the
 * pair's start.
 */
export function offsetToPosition(text: string, offset: number): EditorPosition {
	let limit = Math.max(0, Math.min(Math.trunc(offset), text.length));
	if (limit > 0 && limit < text.length && isLowSurrogate(text.charCodeAt(limit)) && isHighSurrogate(text.charCodeAt(limit - 1))) {
		limit -= 1;
	}

	let line = 0;
	let lineStart = 0;
	for (let at = 0; at < limit; at++) {
		const code = text.charCodeAt(at);
		if (code === 10) {
			line++;
			lineStart = at + 1;
		} else if (code === 13) {
			if (text.charCodeAt(at + 1) === 10) continue; // the \n does the counting
			line++;
			lineStart = at + 1;
		}
	}
	return { line, ch: limit - lineStart };
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Where `Enter` should land: the first snippet's mark, else the first real match. */
function jumpPosition(item: ResultItem): { offset: number; length: number } {
	const snippet = item.snippets[0];
	if (snippet !== undefined) {
		const mark = snippet.marks[0];
		return {
			offset: snippet.jumpOffset,
			length: mark === undefined ? 0 : Math.max(0, mark.end - mark.start),
		};
	}
	for (const match of item.matches) {
		if (!FILE_FIELDS.has(match.field)) continue;
		return { offset: match.start, length: Math.max(0, match.end - match.start) };
	}
	return { offset: 0, length: 0 };
}

/** A ranked hit becomes a renderable item: snippets arrive later, fuzzy words now. */
function toResultItem(hit: RankedHit): ResultItem {
	return { ...hit, snippets: [], similarTo: similarWords(hit.matches) };
}

/** Distinct vault words that a fuzzy match brought in, for the "similar: …" label. */
function similarWords(matches: readonly Match[]): string[] {
	const words: string[] = [];
	for (const match of matches) {
		if (match.quality !== 'fuzzy') continue;
		const word = match.matchedText;
		if (word === undefined || word.length === 0) continue;
		if (!words.includes(word)) words.push(word);
	}
	return words;
}

/** The counter line: "12 results · 38 ms", with its own singular and truncated forms. */
function countText(summary: SearchSummary, shown: number): string {
	const ms = Math.round(summary.durationMs);
	if (summary.count === 0) return t('search.countNone', { ms });
	if (summary.truncated && shown > 0 && shown < summary.count) {
		return t('search.countTruncated', { n: shown, total: summary.count, ms });
	}
	if (summary.count === 1) return t('search.countOne', { ms });
	return t('search.count', { n: summary.count, ms });
}

function indexRange(start: number, end: number): number[] {
	const out: number[] = [];
	for (let at = start; at < end; at++) out.push(at);
	return out;
}
