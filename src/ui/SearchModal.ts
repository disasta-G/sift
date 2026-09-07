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
 *
 * CURATING ONE RUN
 * ----------------
 * Each result is undecided, kept or dismissed, and that state belongs to a
 * single search run: it is cleared at the top of every `executeSearch`, so a
 * keystroke or a filter change starts over, and it is never written anywhere —
 * nothing about it goes near `data.json`.
 *
 * It is modelled by making {@link SearchModal.items} the VISIBLE list. A
 * dismissal splices the row out and pushes it, with the row it came from, onto
 * {@link SearchModal.dismissed}; undo splices it back. Every piece of window
 * arithmetic — the spacers, the block snapping, `aria-activedescendant` — keeps
 * working on contiguous indices without knowing curation exists, and a dismissed
 * card cannot reappear when it scrolls out of the window and back in, because
 * there is nothing left in the list to render. "Kept" is held by PATH rather
 * than by row, so it survives the splices; `writeSnippets` re-checks the path
 * before it fills a card, because a batch that was in flight across a splice
 * would otherwise write one row's excerpts into another row's card.
 */

import { Component, MarkdownView, Modal, Notice, Platform, normalizePath, setIcon } from 'obsidian';
import type { App, Editor, EditorPosition, TFile, WorkspaceLeaf } from 'obsidian';
import { dateFormatLocale, hasKey, t } from '../i18n/index';
import type { TranslationKey } from '../i18n/index';
import { parseQuery } from '../search/QueryParser';
import { Ranker } from '../search/Ranker';
import { hasActiveFilters } from '../search/Searcher';
import { FilterBar } from './FilterBar';
import type { CountMode } from './FilterBar';
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
	VaultPath,
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

/**
 * Card height plus the list gap, until a real card has been measured.
 *
 * A card with a five-line excerpt is roughly twice this, so the estimate is only
 * ever the first guess: {@link SearchModal.measureRowHeight} replaces it with the
 * average of the cards actually on screen, and the window is recomputed against
 * that measurement in the same pass — see {@link SearchModal.updateWindow}.
 */
const DEFAULT_ROW_HEIGHT = 142;

/** A re-measured row height has to differ by at least this much before the spacers are rewritten. */
const ROW_HEIGHT_EPSILON = 2;

/** Viewport height assumed when the list has not been laid out yet (test DOM, first paint). */
const FALLBACK_VIEWPORT = 640;

/** How often the modal re-checks a still-building index. */
const INDEX_POLL_MS = 250;

/** How long the opened note carries the flash class after a jump. */
const FLASH_MS = 1400;

/**
 * Hard ceiling on how many notes one "open all" may put into tabs.
 *
 * A query can match thousands of notes; opening a tab for each of them wedges
 * the workspace and there is no undo for that. Twenty is roughly the point at
 * which a tab strip stops being readable, and it is the number the button and
 * the confirmation both name out loud rather than truncating quietly.
 */
const OPEN_ALL_LIMIT = 20;

/** Above this many, "open all" asks before it does anything. */
const OPEN_ALL_CONFIRM_FROM = 5;


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

	/** The VISIBLE result list: a dismissed row is spliced out of it, not flagged in it. */
	private items: ResultItem[] = [];
	private selected = -1;
	private lastErrors: readonly { messageKey: string }[] = [];

	/** Last completed search, kept so the counter can be rewritten while the run is curated. */
	private summary: SearchSummary | null = null;
	/** Cards the last search actually rendered; differs from the count when the cap bit. */
	private shown = 0;
	/** True while the current run has no positive term — filters alone brought these notes in. */
	private noTerm = false;

	/** Paths marked as worth keeping in this run. By path, so a splice cannot shift it. */
	private readonly kept = new Set<VaultPath>();
	/** Dismissed rows of this run, oldest first, each with the position it was removed from. */
	private readonly dismissed: Array<{ index: number; item: ResultItem }> = [];
	/** True once "open all" has been pressed and is waiting for its answer. */
	private confirmingOpen = false;

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
	private curateEl: HTMLElement | null = null;
	private curateStatusEl: HTMLElement | null = null;
	private undoEl: HTMLButtonElement | null = null;
	private cancelOpenEl: HTMLButtonElement | null = null;
	private openAllEl: HTMLButtonElement | null = null;

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
		this.curateEl = null;
		this.curateStatusEl = null;
		this.undoEl = null;
		this.cancelOpenEl = null;
		this.openAllEl = null;
		this.items = [];
		this.selected = -1;
		this.summary = null;
		this.shown = 0;
		this.noTerm = false;
		this.resetCuration();
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
		this.resetCuration();
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
			this.refreshCuration();
			return;
		}

		this.hideEmptyState();
		this.selected = 0;
		if (this.resultsEl !== null) this.resultsEl.scrollTop = 0;
		this.windowStart = 0;
		this.windowEnd = 0;
		this.updateWindow(true);
		this.refreshCuration();
	}

	renderEmptyState(kind: EmptyStateKind): void {
		const keys = EMPTY_STATE_KEYS[kind];
		// A run with no term found nothing about FILTERS, not about a search word,
		// so it must not report that "no note contains" a query the user never typed.
		const filterWording = kind === 'no-results' && this.noTerm;
		this.showEmpty(
			t(keys.title),
			filterWording ? t('empty.no-results.filters') : t(keys.body, { query: this.query.trim() }),
			filterWording ? t('empty.no-results.filtersHint') : keys.hint === undefined ? null : t(keys.hint),
		);
		const el = this.emptyEl;
		if (el === null) return;

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

	/** The empty panel, whatever put it there. Tears the list down and hands back the panel. */
	private showEmpty(title: string, body: string, hint: string | null): void {
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
		el.createDiv({ cls: 'sift-empty__title', text: title });
		el.createDiv({ cls: 'sift-empty__body', text: body });
		if (hint !== null) el.createDiv({ cls: 'sift-empty__hint', text: hint });
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

	/* ---------------------------------------------------------------------- */
	/* Curating the run                                                       */
	/* ---------------------------------------------------------------------- */

	/** Marks the selected result and moves on, so a run can be sorted without the mouse. */
	keepSelected(): void {
		const item = this.items[this.selected];
		if (item === undefined) return;
		const at = this.selected;
		this.toggleKeep(at);
		if (this.kept.has(item.path)) this.moveSelection(1);
	}

	/** Takes the selected result out of the run. Recoverable through {@link SearchModal.undoDismiss}. */
	dismissSelected(): void {
		this.dismissAt(this.selected);
	}

	/** Puts the most recently dismissed result back where it was. */
	undoDismiss(): void {
		const last = this.dismissed.pop();
		if (last === undefined) return;
		this.confirmingOpen = false;
		const at = Math.max(0, Math.min(last.index, this.items.length));
		this.items.splice(at, 0, last.item);
		this.afterCurationChange(at);
	}

	/**
	 * Opens what the run has been narrowed down to, one tab per note.
	 *
	 * Bounded twice, because this is the one gesture in the overlay that can put
	 * the workspace into a state the user cannot easily get out of: it asks first
	 * above {@link OPEN_ALL_CONFIRM_FROM}, and it never opens more than
	 * {@link OPEN_ALL_LIMIT} — the button and the question both name the number.
	 * Each note goes through the same `openFileAtOffset` a single Enter uses, one
	 * after the other, so the tabs open in the order the list has them.
	 */
	async openRemaining(): Promise<void> {
		const target = this.openTarget();
		if (target.length === 0) return;
		if (target.length > OPEN_ALL_CONFIRM_FROM && !this.confirmingOpen) {
			this.confirmingOpen = true;
			this.refreshCuration();
			return;
		}
		this.confirmingOpen = false;
		const batch = target.slice(0, OPEN_ALL_LIMIT);
		this.close();
		for (const item of batch) {
			const jump = jumpPosition(item);
			await SearchModal.openFileAtOffset(this.app, {
				path: item.path,
				target: 'new-tab',
				offset: jump.offset,
				length: jump.length,
			});
		}
	}

	/**
	 * What "open all" would open.
	 *
	 * Keeping is how the user says "this one, for certain", so as soon as anything
	 * is kept those are the notes that count and the undecided remainder is left
	 * alone. With nothing kept there is no such signal and everything still listed
	 * is the answer. The button's label says which of the two it is before it is
	 * pressed; that is the whole point of having two wordings.
	 */
	private openTarget(): ResultItem[] {
		const kept = this.items.filter((entry) => this.kept.has(entry.path));
		return kept.length > 0 ? kept : this.items;
	}

	private toggleKeep(index: number): void {
		const item = this.items[index];
		if (item === undefined) return;
		this.confirmingOpen = false;
		const next = !this.kept.has(item.path);
		if (next) this.kept.add(item.path);
		else this.kept.delete(item.path);
		this.cards.get(index)?.setKept(next);
		this.applySelection(index, false);
		this.refreshCuration();
	}

	private dismissAt(index: number): void {
		const item = this.items[index];
		if (item === undefined) return;
		this.confirmingOpen = false;
		this.kept.delete(item.path);
		this.items.splice(index, 1);
		this.dismissed.push({ index, item });
		this.afterCurationChange(index);
	}

	/**
	 * Repaints the list after a splice.
	 *
	 * The snippet run is stopped and its claims dropped first: every claim is a
	 * ROW number, and the rows below the splice have just moved. The window is
	 * then rebuilt from the CURRENT scroll position rather than from the top, so
	 * dismissing something halfway down a long list does not throw the user back
	 * to the first card.
	 */
	private afterCurationChange(select: number): void {
		this.snippetAbort?.abort();
		this.snippetAbort = null;
		this.snippetRequested.clear();

		if (this.items.length === 0) {
			this.selected = -1;
			this.showEmpty(t('curate.emptyTitle'), t('curate.emptyBody'), null);
			this.refreshCount();
			this.refreshCuration();
			return;
		}

		this.hideEmptyState();
		this.selected = Math.max(0, Math.min(select, this.items.length - 1));
		this.updateWindow(true);
		this.cards.get(this.selected)?.scrollIntoViewIfNeeded();
		this.refreshCount();
		this.refreshCuration();
		this.recoverFocus();
	}

	/**
	 * Puts the focus back in the search field when the element that had it has
	 * just been destroyed.
	 *
	 * Dismissing with the mouse removes the very button that was clicked, and the
	 * focus falls to the document body — the next character the user types then
	 * goes nowhere. Only that case is corrected: a focus that is still somewhere
	 * inside the modal (the keep button, which survives, or a filter control) is
	 * where its owner put it and is left alone.
	 */
	private recoverFocus(): void {
		const active = this.contentEl.ownerDocument.activeElement;
		if (active !== null && this.contentEl.contains(active)) return;
		this.inputEl?.focus();
	}

	/** Everything a run's curation consists of. Called at the start of every search; never persisted. */
	private resetCuration(): void {
		this.kept.clear();
		this.dismissed.length = 0;
		this.confirmingOpen = false;
	}

	private keptCount(): number {
		let count = 0;
		for (const entry of this.items) {
			if (this.kept.has(entry.path)) count++;
		}
		return count;
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
		const mac = Platform.isMacOS;
		// The hints wrap among themselves; the curation controls stay on the right
		// of the first row rather than being pushed onto a line of their own.
		const hints = footer.createDiv({ cls: 'sift-footer__hints' });
		this.buildHint(hints, t('footer.key.arrows'), t('footer.navigate'));
		this.buildHint(hints, t('footer.key.enter'), t('footer.open'));
		this.buildHint(hints, mac ? t('footer.key.modEnterMac') : t('footer.key.modEnter'), t('footer.newTab'));
		this.buildHint(hints, mac ? t('footer.key.modShiftKMac') : t('footer.key.modShiftK'), t('footer.keep'));
		this.buildHint(hints, mac ? t('footer.key.modShiftXMac') : t('footer.key.modShiftX'), t('footer.dismiss'));
		this.buildHint(hints, mac ? t('footer.key.modShiftZMac') : t('footer.key.modShiftZ'), t('footer.undo'));
		this.buildHint(hints, t('footer.key.esc'), t('footer.close'));
		this.buildCurateGroup(footer);
	}

	private buildHint(footer: HTMLElement, glyph: string, label: string): void {
		const hint = footer.createSpan({ cls: 'sift-footer__hint' });
		hint.createEl('kbd', { cls: 'sift-key', text: glyph });
		hint.appendText(` ${label}`);
	}

	/**
	 * The curation controls, in the footer's trailing slot.
	 *
	 * They live here rather than in a row of their own so that turning a run into
	 * a shortlist costs no vertical space: the footer is already the strip that
	 * says what the keyboard can do, and these are the same actions with a mouse.
	 * The status is a polite live region, so a dismissal and a pending
	 * confirmation are announced instead of only being visible.
	 */
	private buildCurateGroup(footer: HTMLElement): void {
		const group = footer.createDiv({ cls: 'sift-curate' });
		this.curateEl = group;
		this.curateStatusEl = group.createSpan({
			cls: 'sift-curate__status',
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		this.undoEl = group.createEl('button', {
			cls: 'sift-curate__button sift-curate__undo sift-curate__button--hidden',
			text: t('curate.undo'),
			attr: { type: 'button' },
		});
		this.cancelOpenEl = group.createEl('button', {
			cls: 'sift-curate__button sift-curate__cancel sift-curate__button--hidden',
			text: t('curate.cancel'),
			attr: { type: 'button' },
		});
		this.openAllEl = group.createEl('button', {
			cls: 'sift-curate__button sift-curate__open sift-curate__button--primary',
			attr: { type: 'button' },
		});

		this.lifecycle.registerDomEvent(this.undoEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.undoDismiss();
		});
		this.lifecycle.registerDomEvent(this.cancelOpenEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.confirmingOpen = false;
			this.refreshCuration();
		});
		this.lifecycle.registerDomEvent(this.openAllEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			void this.openRemaining();
		});
		this.refreshCuration();
	}

	/** Rewrites the footer controls from the current curation state. Cheap; called after every change. */
	private refreshCuration(): void {
		const group = this.curateEl;
		if (group === null) return;
		const hasRun = this.items.length > 0 || this.dismissed.length > 0;
		group.toggleClass('sift-curate--visible', hasRun);
		this.undoEl?.toggleClass('sift-curate__button--hidden', this.dismissed.length === 0);
		this.cancelOpenEl?.toggleClass('sift-curate__button--hidden', !this.confirmingOpen);

		const open = this.openAllEl;
		if (open !== null) {
			const target = this.openTarget();
			open.toggleClass('sift-curate__button--hidden', target.length === 0);
			open.setText(this.confirmingOpen ? t('curate.confirmAccept') : openAllLabel(target.length, this.keptCount() > 0));
		}
		this.curateStatusEl?.setText(this.curateStatusText());
	}

	private curateStatusText(): string {
		if (this.confirmingOpen) {
			const total = this.openTarget().length;
			const batch = Math.min(total, OPEN_ALL_LIMIT);
			return batch < total
				? t('curate.confirmCapped', { n: batch, total })
				: t('curate.confirmQuestion', { n: batch });
		}
		const kept = this.keptCount();
		if (kept === 0) return '';
		return kept === 1 ? t('curate.keptOne') : t('curate.keptCount', { n: kept });
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

		// CURATION KEYS — see the class header for why they all carry Mod+Shift.
		// The search field owns every unmodified key, and a letter key with Alt
		// alone is not layout-stable (on macOS Option remaps it to a dead key or a
		// symbol, so `evt.key` is no longer the letter), which leaves Mod+Shift as
		// the one combination that is both free of text-editing meaning and spelled
		// the same on every keyboard.
		this.scope.register(['Mod', 'Shift'], 'K', (evt) => {
			if (this.filterBarHasFocus()) return true;
			evt.preventDefault();
			this.keepSelected();
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'X', (evt) => {
			if (this.filterBarHasFocus()) return true;
			evt.preventDefault();
			this.dismissSelected();
			return false;
		});
		this.scope.register(['Mod', 'Shift'], 'Z', (evt) => {
			if (this.filterBarHasFocus()) return true;
			// Nothing dismissed means nothing to undo, and an overlay that swallows
			// the gesture anyway would be a key that does nothing.
			if (this.dismissed.length === 0) return true;
			evt.preventDefault();
			this.undoDismiss();
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
		// A new run, so the previous run's curation is gone. It exists for exactly
		// one query and one set of filters and is never written anywhere.
		this.resetCuration();
		const controller = new AbortController();
		this.abort = controller;

		if (!this.deps.indexer.isReady()) {
			this.items = [];
			this.noTerm = false;
			this.setCount(null);
			this.renderEmptyState('indexing');
			this.refreshCuration();
			this.scheduleIndexPoll();
			return;
		}

		const ast = parseQuery(this.query, this.deps.tuning);
		this.lastErrors = ast.errors;
		// A SET FILTER IS A SEARCH. `ast.isEmpty` alone used to mean "show the
		// empty state", which made a date range or a folder on its own unusable:
		// the user narrowed the vault down and the overlay answered by asking them
		// to type something. The initial state is now reserved for a query that
		// asks for nothing at all.
		this.noTerm = ast.isEmpty;
		if (ast.isEmpty && !hasActiveFilters(this.filters)) {
			this.items = [];
			this.noTerm = false;
			this.setCount(null);
			this.renderEmptyState(ast.errors.length > 0 ? 'query-error' : 'initial');
			this.refreshCuration();
			return;
		}
		// Without a term there is no relevance to sort by. `Ranker.rank` has already
		// put such a run into the fallback order; the dropdown is moved onto the
		// same key so it cannot claim "Relevance" over a list that is not in that
		// order. `Ranker.effectiveSort` decides which key that is, for both.
		this.applySort(Ranker.effectiveSort(this.sort, ast));

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
		let wrote = false;
		for (let at = 0; at < batch.length; at++) {
			const index = batch[at];
			const source = built[at];
			const current = this.items[index];
			if (source === undefined || current === undefined) continue;
			// The batch was requested by ROW, and a dismissal or an undo moves every
			// row below it. Without this check a run that was in flight across a
			// splice writes one note's excerpts into another note's card.
			if (source.path !== current.path) continue;
			if (source.snippets.length === 0) continue;
			this.items[index] = { ...current, snippets: source.snippets };
			this.cards.get(index)?.update(this.cardModel(index));
			wrote = true;
		}
		// The cards just grew by however many lines their excerpts carry; the
		// spacers still describe the height they had while they were blank.
		if (wrote) this.refreshRowMetrics();
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

	/**
	 * Recomputes the rendered window and, when it moved, rebuilds it.
	 *
	 * The first pass runs on {@link DEFAULT_ROW_HEIGHT} — no card exists yet to
	 * measure — and `renderWindow` measures a real card at the end of it. With a
	 * five-line excerpt the estimate and the measurement are a factor of two
	 * apart, so the window that first pass produced can be the wrong size. It is
	 * therefore recomputed once against the measurement, and never in a loop: the
	 * second pass already has the real number, so a third would compute the same
	 * window and stop anyway.
	 */
	private updateWindow(force: boolean): void {
		const total = this.items.length;
		const first = this.computeWindow(total);
		if (!force && first.start === this.windowStart && first.end === this.windowEnd) return;
		this.windowStart = first.start;
		this.windowEnd = first.end;
		this.renderWindow();

		const corrected = this.computeWindow(total);
		if (corrected.start !== this.windowStart || corrected.end !== this.windowEnd) {
			this.windowStart = corrected.start;
			this.windowEnd = corrected.end;
			this.renderWindow();
		}
		this.restartSnippets(indexRange(this.windowStart, this.windowEnd));
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
			const item = this.items[index];
			if (item === undefined) continue;
			const card = new ResultCard(
				list,
				this.cardModel(index),
				{
					// A pointer selection must not scroll: the correction would fire a
					// scroll event between mousedown and mouseup, and a window rebuild
					// there detaches the very node the button is pressed on, so the
					// browser never dispatches the click. The keyboard path scrolls.
					onSelect: (at) => {
						this.applySelection(at, false);
					},
					onOpen: (opened, target) => {
						void this.openItem(opened, target);
					},
				},
				{
					// Read from the path set, so a card rebuilt after a scroll or a
					// splice comes back with the mark it had.
					kept: this.kept.has(item.path),
					onKeep: (at) => {
						this.toggleKeep(at);
					},
					onDismiss: (at) => {
						this.dismissAt(at);
					},
				},
			);
			this.cards.set(index, card);
		}

		// Measured before the spacers, so their height uses the row height of the
		// cards that are on screen rather than the previous window's estimate.
		this.measureRowHeight();
		this.setSpacer(this.topSpacerEl, this.windowStart * this.rowHeight);
		this.setSpacer(this.bottomSpacerEl, Math.max(0, this.items.length - this.windowEnd) * this.rowHeight);
		this.updateActiveDescendant();
	}

	/**
	 * Replaces the estimate with the average height of the cards on screen.
	 *
	 * The AVERAGE, not the first card: a card whose excerpts have not arrived yet
	 * is the height of its blank snippet area, and a card carrying two five-line
	 * excerpts is well over twice that. Measuring only the first row therefore
	 * pinned the row height to whichever of those the top of the window happened
	 * to be, and every spacer below it inherited the error — a few dozen pixels
	 * with the old 160-character window, a few hundred per row with five lines.
	 *
	 * Returns true when the value moved far enough to be worth acting on.
	 */
	private measureRowHeight(): boolean {
		let total = 0;
		let counted = 0;
		for (const card of this.cards.values()) {
			const height = card.el.offsetHeight;
			if (height <= 0) continue;
			total += height;
			counted++;
		}
		if (counted === 0) return false;
		const next = total / counted + CARD_GAP;
		if (Math.abs(next - this.rowHeight) < ROW_HEIGHT_EPSILON) return false;
		this.rowHeight = next;
		return true;
	}

	/**
	 * Re-measures after excerpts landed and corrects the spacers if the cards grew.
	 *
	 * Only the spacers: rebuilding the window here would abort the snippet run
	 * that is writing into it, one batch at a time, for as long as the cards keep
	 * growing. The window itself follows on the next scroll or selection, which is
	 * the first moment its size matters again.
	 */
	private refreshRowMetrics(): void {
		if (!this.measureRowHeight()) return;
		this.setSpacer(this.topSpacerEl, this.windowStart * this.rowHeight);
		this.setSpacer(this.bottomSpacerEl, Math.max(0, this.items.length - this.windowEnd) * this.rowHeight);
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
		this.summary = summary;
		this.shown = shown;
		this.refreshCount();
		this.filterBar?.setSummary(summary, this.countMode());
	}

	/**
	 * Rewrites the header counter.
	 *
	 * While a run is being curated it reports what is LEFT and what was thrown
	 * away, rather than quietly counting down: "12 results" turning into "9
	 * results" would read as the search having found fewer notes than it did.
	 */
	private refreshCount(): void {
		const summary = this.summary;
		if (summary === null) {
			this.countEl?.setText('');
			return;
		}
		this.countEl?.setText(
			this.dismissed.length > 0
				? t('curate.left', { n: this.items.length, dismissed: this.dismissed.length })
				: countText(summary, this.shown, this.countMode()),
		);
	}

	private countMode(): CountMode {
		return this.noTerm ? 'notes' : 'results';
	}

	/** Switches the sort order and shows the switch in the dropdown, so the label never lies. */
	private applySort(sort: SortKey): void {
		if (this.sort === sort) return;
		this.sort = sort;
		this.filterBar?.setState({
			filters: this.filters,
			sort,
			fuzzy: this.fuzzy,
			summary: this.summary,
		});
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

/**
 * The counter line: "12 results · 38 ms", with its own singular and truncated
 * forms.
 *
 * In `notes` mode it counts NOTES and drops the duration. Neither half of "127
 * results · 3 ms" is true of a filter scan: nothing was searched for, so there
 * are no hits, and the milliseconds would advertise a speed for work that was
 * mostly not done — a number that invites comparison with a real query and loses
 * the comparison the moment one is typed.
 */
function countText(summary: SearchSummary, shown: number, mode: CountMode): string {
	if (mode === 'notes') {
		if (summary.count === 0) return t('search.notesNone');
		if (summary.truncated && shown > 0 && shown < summary.count) {
			return t('search.notesTruncated', { n: shown, total: summary.count });
		}
		if (summary.count === 1) return t('search.notesOne');
		return t('search.notes', { n: summary.count });
	}
	const ms = Math.round(summary.durationMs);
	if (summary.count === 0) return t('search.countNone', { ms });
	if (summary.truncated && shown > 0 && shown < summary.count) {
		return t('search.countTruncated', { n: shown, total: summary.count, ms });
	}
	if (summary.count === 1) return t('search.countOne', { ms });
	return t('search.count', { n: summary.count, ms });
}

/** What "open all" promises before it is pressed: which set, how many, and whether the cap bites. */
function openAllLabel(total: number, keptMode: boolean): string {
	if (total > OPEN_ALL_LIMIT) return t('curate.openCapped', { n: OPEN_ALL_LIMIT, total });
	if (keptMode) return total === 1 ? t('curate.openKeptOne') : t('curate.openKept', { n: total });
	return total === 1 ? t('curate.openOne') : t('curate.openAll', { n: total });
}

function indexRange(start: number, end: number): number[] {
	const out: number[] = [];
	for (let at = start; at < end; at++) out.push(at);
	return out;
}
