/**
 * FilterBar — the chip row under the search field: folder picker with a folder
 * suggester, 'Include subfolders' toggle, 'Similar' toggle, created-date range
 * with 7-day/30-day/year quick picks, sort dropdown, and the hit counter.
 *
 * Controlled component — it renders the FilterBarState it is given and reports
 * changes upward; the modal owns the state. All user path input goes through
 * normalizePath before it leaves this module.
 *
 * WHERE THE COUNTER LIVES
 * -----------------------
 * The mockup puts the visible "12 results · 38 ms" line in the header, next to
 * the query, and the modal renders it there. `setSummary` is not a second copy
 * of it: it feeds a polite live region inside the bar, so a screen reader is
 * told how many hits a filter change produced without the sighted layout
 * gaining a duplicate.
 *
 * LISTENER OWNERSHIP
 * ------------------
 * Same arrangement as ResultCard: a private `Component` receives every
 * listener, `destroy()` unloads it and detaches the folder suggester.
 *
 * DISMISSING THE QUICK-PICK MENU
 * ------------------------------
 * The menu is a popup and has to close the two ways every popup closes. The
 * outside click is a document-level listener on the bar's own `Component`, so
 * it goes away with the bar. `Escape` cannot be a DOM listener: Obsidian's
 * keymap runs on `window` in the capture phase and the modal's own `Escape`
 * would close the whole modal before a listener on this element ever saw the
 * event. The menu therefore pushes a `Scope` while it is open — the same
 * mechanism `PopoverSuggest` uses — which makes it the active scope, so its
 * `Escape` closes the menu and the modal stays where it is. The scope is popped
 * the moment the menu closes, including from `destroy()`.
 */

import { AbstractInputSuggest, Component, Scope, normalizePath, setIcon } from 'obsidian';
import type { App, TFolder } from 'obsidian';
import { dateFormatLocale, t } from '../i18n/index';
import type { TranslationKey } from '../i18n/index';
import type {
	FilterBarCallbacks,
	FilterBarState,
	Millis,
	SearchFilters,
	SearchSummary,
	SortKey,
	VaultPath,
} from '../types';

/** U+00D7 MULTIPLICATION SIGN, per the mockup — not the letter x. */
const REMOVE_GLYPH = '×';

/** One day in milliseconds. */
const DAY = 86_400_000;

/** The quick picks the plan asks for on the created-date chip. */
export type QuickPickKind = 'week' | 'month' | 'year' | 'any';

/** Sort options, in the order the dropdown offers them. */
const SORT_KEYS: readonly SortKey[] = [
	'relevance',
	'created-desc',
	'created-asc',
	'modified-desc',
	'modified-asc',
	'title-asc',
	'path-asc',
];

/**
 * Lower bound of a quick pick, measured back from `now`.
 *
 * Plain subtraction rather than calendar arithmetic: a year is 365 days here,
 * which keeps the function pure and its tests independent of the local time
 * zone. `'any'` clears the bound.
 */
export function quickPickFrom(kind: QuickPickKind, now: Millis): Millis | null {
	switch (kind) {
		case 'week':
			return now - 7 * DAY;
		case 'month':
			return now - 30 * DAY;
		case 'year':
			return now - 365 * DAY;
		case 'any':
			return null;
	}
}

/** Folder suggestions for the path chip, backed by the vault's own folder list. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private readonly onPick: (path: VaultPath) => void;

	constructor(app: App, input: HTMLInputElement, onPick: (path: VaultPath) => void) {
		super(app, input);
		this.onPick = onPick;
	}

	protected getSuggestions(query: string): TFolder[] {
		const needle = query.toLocaleLowerCase().trim();
		const folders = this.app.vault.getAllFolders(false);
		if (needle.length === 0) return folders.slice(0, this.limit);
		return folders.filter((folder) => folder.path.toLocaleLowerCase().includes(needle)).slice(0, this.limit);
	}

	renderSuggestion(value: TFolder, el: HTMLElement): void {
		el.setText(value.path);
	}

	override selectSuggestion(value: TFolder): void {
		this.setValue(value.path);
		this.onPick(value.path);
		this.close();
	}

	/**
	 * Detaches the popover.
	 *
	 * `AbstractInputSuggest` gained a `destroy()` after the typings this plugin
	 * builds against, so it is called only when the running app actually has it;
	 * `close()` is the part that is guaranteed.
	 */
	dispose(): void {
		this.close();
		(this as unknown as { destroy?: () => void }).destroy?.();
	}
}

export class FilterBar {
	readonly el: HTMLElement;

	private state: FilterBarState;
	private readonly app: App;
	private readonly callbacks: FilterBarCallbacks;
	private readonly lifecycle = new Component();
	private readonly menuScope: Scope;
	private readonly now: () => Millis;
	private readonly suggest: FolderSuggest;

	private readonly pathChipEl: HTMLElement;
	private readonly pathInputEl: HTMLInputElement;
	private readonly pathRemoveEl: HTMLElement;
	private readonly subfoldersEl: HTMLInputElement;
	private readonly subfoldersLabelEl: HTMLElement;
	private readonly fuzzyEl: HTMLInputElement;
	private readonly fuzzyLabelEl: HTMLElement;
	private readonly dateWrapEl: HTMLElement;
	private readonly dateChipEl: HTMLElement;
	private readonly dateLabelEl: HTMLElement;
	private readonly dateRemoveEl: HTMLElement;
	private readonly dateMenuEl: HTMLElement;
	private readonly sortSelectEl: HTMLSelectElement;
	private readonly statusEl: HTMLElement;

	constructor(
		app: App,
		parent: HTMLElement,
		state: FilterBarState,
		callbacks: FilterBarCallbacks,
		now: () => Millis = Date.now,
	) {
		this.state = cloneState(state);
		this.app = app;
		this.callbacks = callbacks;
		this.now = now;
		// Parented on the app scope, so the global hotkeys keep working while the
		// four-item menu is open; only `Escape` is taken over.
		this.menuScope = new Scope(this.app.scope);

		this.el = parent.createDiv({ cls: 'sift-filters' });
		this.lifecycle.load();

		/* --- folder chip ---------------------------------------------------- */
		this.pathChipEl = this.el.createDiv({ cls: 'sift-chip sift-chip--path' });
		const folderIcon = this.pathChipEl.createSpan({ cls: 'sift-chip__icon' });
		setIcon(folderIcon, 'folder');
		this.pathInputEl = this.pathChipEl.createEl('input', {
			cls: 'sift-chip__input',
			type: 'text',
			attr: {
				'aria-label': t('filter.path'),
				placeholder: t('filter.pathAll'),
				spellcheck: 'false',
				enterkeyhint: 'done',
			},
		});
		this.pathRemoveEl = this.pathChipEl.createEl('button', {
			cls: 'sift-chip__remove',
			text: REMOVE_GLYPH,
			attr: { type: 'button', 'aria-label': t('filter.remove') },
		});

		this.suggest = new FolderSuggest(app, this.pathInputEl, (path) => {
			this.commitFolder(path);
		});
		this.lifecycle.registerDomEvent(this.pathInputEl, 'change', () => {
			this.commitFolder(this.pathInputEl.value);
		});
		this.lifecycle.registerDomEvent(this.pathInputEl, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key !== 'Enter') return;
			evt.preventDefault();
			this.commitFolder(this.pathInputEl.value);
		});
		this.lifecycle.registerDomEvent(this.pathRemoveEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.commitFolder('');
		});

		/* --- toggles -------------------------------------------------------- */
		const subfolders = this.buildToggle('filter.includeSubfolders', 'sift-toggle--subfolders');
		this.subfoldersEl = subfolders.input;
		this.subfoldersLabelEl = subfolders.label;
		this.lifecycle.registerDomEvent(this.subfoldersEl, 'change', () => {
			this.emitFilters({ includeSubfolders: this.subfoldersEl.checked });
		});

		const fuzzy = this.buildToggle('filter.similar', 'sift-toggle--similar');
		this.fuzzyEl = fuzzy.input;
		this.fuzzyLabelEl = fuzzy.label;
		this.fuzzyEl.setAttr('title', t('filter.similarTooltip'));
		this.lifecycle.registerDomEvent(this.fuzzyEl, 'change', () => {
			const next = this.fuzzyEl.checked;
			this.state = { ...this.state, fuzzy: next };
			this.applyFuzzy();
			this.callbacks.onFuzzyChange(next);
		});

		/* --- created-date chip ---------------------------------------------- */
		this.dateWrapEl = this.el.createDiv({ cls: 'sift-filters__date' });
		this.dateChipEl = this.dateWrapEl.createEl('button', {
			cls: 'sift-chip sift-chip--date',
			attr: { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
		});
		const calendarIcon = this.dateChipEl.createSpan({ cls: 'sift-chip__icon' });
		setIcon(calendarIcon, 'calendar');
		this.dateLabelEl = this.dateChipEl.createSpan({ cls: 'sift-chip__label' });
		this.dateRemoveEl = this.dateWrapEl.createEl('button', {
			cls: 'sift-chip__remove sift-chip__remove--date',
			text: REMOVE_GLYPH,
			attr: { type: 'button', 'aria-label': t('filter.remove') },
		});
		this.dateMenuEl = this.dateWrapEl.createDiv({ cls: 'sift-date-menu', attr: { role: 'menu' } });
		this.buildQuickPick('week', 'filter.quick7Days');
		this.buildQuickPick('month', 'filter.quick30Days');
		this.buildQuickPick('year', 'filter.quickYear');
		this.buildQuickPick('any', 'filter.quickAnyTime');

		this.lifecycle.registerDomEvent(this.dateChipEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.toggleDateMenu(!this.isDateMenuOpen());
		});
		this.lifecycle.registerDomEvent(this.dateRemoveEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.applyQuickPick('any');
		});
		this.menuScope.register([], 'Escape', () => {
			this.toggleDateMenu(false);
			this.dateChipEl.focus();
			return false;
		});
		// Anywhere else in the window dismisses the menu — including the search
		// field above it, which is where a user who changed their mind clicks.
		this.lifecycle.registerDomEvent(this.el.ownerDocument, 'click', (evt: MouseEvent) => {
			if (!this.isDateMenuOpen()) return;
			const target = evt.target;
			if (target instanceof Node && this.dateWrapEl.contains(target)) return;
			this.toggleDateMenu(false);
		});

		/* --- spacer, sort, live region -------------------------------------- */
		this.el.createDiv({ cls: 'sift-filters__spacer' });

		const sort = this.el.createDiv({ cls: 'sift-sort' });
		const sortIcon = sort.createSpan({ cls: 'sift-sort__icon' });
		setIcon(sortIcon, 'list-filter');
		this.sortSelectEl = sort.createEl('select', {
			cls: 'sift-sort__select',
			attr: { 'aria-label': t('sort.label') },
		});
		for (const key of SORT_KEYS) {
			this.sortSelectEl.createEl('option', { text: t(`sort.${key}` as TranslationKey), value: key });
		}
		const sortChevron = sort.createSpan({ cls: 'sift-sort__chevron' });
		setIcon(sortChevron, 'chevron-down');
		this.lifecycle.registerDomEvent(this.sortSelectEl, 'change', () => {
			const next = toSortKey(this.sortSelectEl.value);
			this.state = { ...this.state, sort: next };
			this.callbacks.onSortChange(next);
		});

		this.statusEl = this.el.createDiv({
			cls: 'sift-filters__status',
			attr: { 'aria-live': 'polite', role: 'status' },
		});

		this.renderAll();
	}

	/**
	 * Applies a new state. Idempotent by contract: re-applying the state the bar
	 * already holds performs no DOM write at all, which is what keeps the modal
	 * and the bar from ping-ponging render passes.
	 */
	setState(state: FilterBarState): void {
		if (stateEquals(this.state, state)) return;
		const summaryChanged = !summaryEquals(this.state.summary, state.summary);
		const restChanged = !stateEqualsIgnoringSummary(this.state, state);
		this.state = cloneState(state);
		if (restChanged) this.renderControls();
		if (summaryChanged) this.renderSummary();
	}

	setSummary(summary: SearchSummary | null): void {
		if (summaryEquals(this.state.summary, summary)) return;
		this.state = { ...this.state, summary: summary === null ? null : { ...summary } };
		this.renderSummary();
	}

	/** Called when the user tabs out of the search field. */
	focusFirstControl(): void {
		this.pathInputEl.focus();
	}

	destroy(): void {
		this.toggleDateMenu(false);
		this.suggest.dispose();
		this.lifecycle.unload();
		this.el.detach();
	}

	/* ---------------------------------------------------------------------- */
	/* Construction helpers                                                   */
	/* ---------------------------------------------------------------------- */

	/** A real checkbox behind the mockup's custom track, so the control stays keyboard-operable. */
	private buildToggle(key: TranslationKey, modifier: string): { input: HTMLInputElement; label: HTMLElement } {
		const label = this.el.createEl('label', { cls: `sift-toggle ${modifier}` });
		const input = label.createEl('input', { cls: 'sift-toggle__input', type: 'checkbox' });
		const track = label.createSpan({ cls: 'sift-toggle__track' });
		track.createSpan({ cls: 'sift-toggle__thumb' });
		label.createSpan({ cls: 'sift-toggle__label', text: t(key) });
		return { input, label };
	}

	private buildQuickPick(kind: QuickPickKind, key: TranslationKey): void {
		const button = this.dateMenuEl.createEl('button', {
			cls: 'sift-date-menu__item',
			text: t(key),
			attr: { type: 'button', role: 'menuitem' },
		});
		this.lifecycle.registerDomEvent(button, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.applyQuickPick(kind);
		});
	}

	/* ---------------------------------------------------------------------- */
	/* Behaviour                                                              */
	/* ---------------------------------------------------------------------- */

	/**
	 * Every path the user can type passes through here, so `normalizePath` is
	 * applied exactly once and in one place. An empty box means "whole vault".
	 */
	private commitFolder(raw: string): void {
		const trimmed = raw.trim();
		const normalized = trimmed.length === 0 ? null : normalizePath(trimmed);
		const folder: VaultPath | null = normalized === null || normalized === '/' ? null : normalized;
		if (folder === this.state.filters.folder) {
			this.renderPath();
			return;
		}
		this.emitFilters({ folder });
	}

	private applyQuickPick(kind: QuickPickKind): void {
		this.toggleDateMenu(false);
		const createdFrom = quickPickFrom(kind, this.now());
		this.emitFilters({ createdFrom, createdTo: null });
	}

	private isDateMenuOpen(): boolean {
		return this.dateWrapEl.hasClass('sift-filters__date--open');
	}

	/** Idempotent: the scope is pushed and popped exactly once per open/close. */
	private toggleDateMenu(open: boolean): void {
		if (open === this.isDateMenuOpen()) return;
		this.dateWrapEl.toggleClass('sift-filters__date--open', open);
		this.dateChipEl.setAttr('aria-expanded', open ? 'true' : 'false');
		if (open) this.app.keymap.pushScope(this.menuScope);
		else this.app.keymap.popScope(this.menuScope);
	}

	/** Updates the local mirror and reports upward. Never mutates the caller's object. */
	private emitFilters(patch: Partial<SearchFilters>): void {
		const filters: SearchFilters = { ...this.state.filters, ...patch };
		this.state = { ...this.state, filters };
		this.renderControls();
		this.callbacks.onFiltersChange(filters);
	}

	/* ---------------------------------------------------------------------- */
	/* Rendering                                                              */
	/* ---------------------------------------------------------------------- */

	private renderAll(): void {
		this.renderControls();
		this.renderSummary();
	}

	private renderControls(): void {
		this.renderPath();
		this.renderSubfolders();
		this.applyFuzzy();
		this.renderDate();
		this.renderSort();
	}

	private renderPath(): void {
		const folder = this.state.filters.folder;
		const value = folder ?? '';
		if (this.pathInputEl.value !== value) this.pathInputEl.value = value;
		this.pathChipEl.toggleClass('sift-chip--active', folder !== null);
		this.pathRemoveEl.toggleClass('sift-chip__remove--visible', folder !== null);
	}

	private renderSubfolders(): void {
		const on = this.state.filters.includeSubfolders;
		if (this.subfoldersEl.checked !== on) this.subfoldersEl.checked = on;
		this.subfoldersLabelEl.toggleClass('sift-toggle--on', on);
	}

	private applyFuzzy(): void {
		const on = this.state.fuzzy;
		if (this.fuzzyEl.checked !== on) this.fuzzyEl.checked = on;
		this.fuzzyLabelEl.toggleClass('sift-toggle--on', on);
	}

	private renderDate(): void {
		const { createdFrom, createdTo } = this.state.filters;
		const active = createdFrom !== null || createdTo !== null;
		this.dateLabelEl.setText(this.dateLabel(createdFrom, createdTo));
		this.dateChipEl.toggleClass('sift-chip--active', active);
		this.dateRemoveEl.toggleClass('sift-chip__remove--visible', active);
	}

	private dateLabel(from: Millis | null, to: Millis | null): string {
		if (from === null && to === null) return t('filter.created');
		if (from !== null && to === null) {
			return t('filter.createdRange', { from: formatDay(from), to: t('filter.dateToday') });
		}
		if (from === null && to !== null) return t('filter.createdTo', { to: formatDay(to) });
		return t('filter.createdRange', { from: formatDay(from ?? 0), to: formatDay(to ?? 0) });
	}

	private renderSort(): void {
		if (this.sortSelectEl.value !== this.state.sort) this.sortSelectEl.value = this.state.sort;
	}

	private renderSummary(): void {
		const summary = this.state.summary;
		if (summary === null) {
			this.statusEl.setText('');
			return;
		}
		this.statusEl.setText(summaryText(summary));
	}
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Short numeric day for the date chip, in the interface locale. */
function formatDay(value: Millis): string {
	return new Intl.DateTimeFormat(dateFormatLocale(), {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(value));
}

/** The same anatomy the header counter uses, for the live region. */
function summaryText(summary: SearchSummary): string {
	const ms = Math.round(summary.durationMs);
	if (summary.count === 0) return t('search.countNone', { ms });
	if (summary.count === 1) return t('search.countOne', { ms });
	return t('search.count', { n: summary.count, ms });
}

/** Narrows an arbitrary `select` value back to a SortKey. */
function toSortKey(value: string): SortKey {
	const found = SORT_KEYS.find((key) => key === value);
	return found ?? 'relevance';
}

function cloneState(state: FilterBarState): FilterBarState {
	return {
		filters: { ...state.filters, excludedFolders: [...state.filters.excludedFolders] },
		sort: state.sort,
		fuzzy: state.fuzzy,
		summary: state.summary === null ? null : { ...state.summary },
	};
}

function stateEquals(a: FilterBarState, b: FilterBarState): boolean {
	return stateEqualsIgnoringSummary(a, b) && summaryEquals(a.summary, b.summary);
}

function stateEqualsIgnoringSummary(a: FilterBarState, b: FilterBarState): boolean {
	return a.sort === b.sort && a.fuzzy === b.fuzzy && filtersEqual(a.filters, b.filters);
}

function filtersEqual(a: SearchFilters, b: SearchFilters): boolean {
	return (
		a.folder === b.folder &&
		a.includeSubfolders === b.includeSubfolders &&
		a.createdFrom === b.createdFrom &&
		a.createdTo === b.createdTo &&
		a.modifiedFrom === b.modifiedFrom &&
		a.modifiedTo === b.modifiedTo &&
		a.excludedFolders.length === b.excludedFolders.length &&
		a.excludedFolders.every((folder, at) => folder === b.excludedFolders[at])
	);
}

function summaryEquals(a: SearchSummary | null, b: SearchSummary | null): boolean {
	if (a === null || b === null) return a === b;
	return a.count === b.count && a.durationMs === b.durationMs && a.truncated === b.truncated;
}
