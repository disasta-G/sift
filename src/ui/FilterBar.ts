/**
 * FilterBar — the chip row under the search field: folder picker with a folder
 * suggester, 'Include subfolders' toggle, 'Similar' toggle, created-date range
 * with 7-day/30-day/year quick picks beside a month calendar, sort dropdown,
 * and the hit counter.
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
 * DISMISSING THE DATE POPOVER
 * ---------------------------
 * The popover has to close the two ways every popup closes. The outside click is
 * a document-level listener on the bar's own `Component`, so it goes away with
 * the bar. `Escape` cannot be a DOM listener: Obsidian's keymap runs on `window`
 * in the capture phase and the modal's own `Escape` would close the whole modal
 * before a listener on this element ever saw the event. The popover therefore
 * pushes a `Scope` while it is open — the same mechanism `PopoverSuggest` uses —
 * which makes it the active scope, so its `Escape` closes the popover and the
 * modal stays where it is. The scope is popped the moment it closes, including
 * from `destroy()`.
 *
 * KEEPING THE DATE POPOVER INSIDE THE MODAL
 * -----------------------------------------
 * The popover is positioned against the chip, and the modal clips at
 * `overflow: hidden`, so a chip far enough right puts part of the calendar
 * outside the panel where it can be neither seen nor clicked. CSS alone cannot
 * decide that — it depends on where the chip ends up after the bar has wrapped —
 * so the two edges are measured when the popover opens (and again on a resize)
 * and handed to {@link placePopover}, which returns the `left` and the
 * `max-width` as two custom properties on the wrapper. The stylesheet keeps the
 * mockup's left-aligned default in the `var()` fallback, which is also what a
 * layout with no geometry yet gets.
 *
 * THE CALENDAR'S KEYS RIDE THE SAME SCOPE
 * --------------------------------------
 * Arrow keys, PageUp/PageDown and Enter drive the calendar grid, and they go
 * through that same scope rather than through a DOM listener — otherwise the
 * modal's own Arrow bindings, which move the result cursor, would fight them.
 * They are registered as ONE catch-all binding (`key: null`) instead of one
 * binding per key: `Scope.register` takes the literal `KeyboardEvent.key`
 * spelling, and the catch-all lets the comparison happen in one place, in lower
 * case, where a key this bar does not own is returned unhandled and continues on
 * to Obsidian exactly as if the binding were not there.
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

/** The quick picks the plan asks for on the created-date chip. */
export type QuickPickKind = 'week' | 'month' | 'year' | 'any';

/** How far back each quick pick reaches, in days. `'any'` has no bound. */
const QUICK_PICK_DAYS: Readonly<Record<Exclude<QuickPickKind, 'any'>, number>> = {
	week: 7,
	month: 30,
	year: 365,
};

/** Columns of the calendar, and the modulus of every weekday calculation. */
const DAYS_PER_WEEK = 7;

/** Rows of the calendar. Fixed, so the popover does not change height between a five- and a six-row month. */
const WEEKS_PER_MONTH = 6;

/** ISO 8601 first weekday, Monday. The fallback when the runtime cannot say what the locale does. */
const ISO_FIRST_WEEKDAY = 1;

/**
 * A Monday. Formatting `WEEKDAY_EPOCH + (isoDay - 1)` days gives the name of any
 * weekday without a hardcoded list: 2024-01-01 was a Monday, so 2024-01-07 is a
 * Sunday and the seven dates in between are the week in ISO order.
 */
const WEEKDAY_EPOCH = { year: 2024, month: 0, day: 1 };

/** DOM id of the month caption, so the grid can be labelled by it. */
const MONTH_LABEL_ID = 'sift-cal-month';

/**
 * Gap kept between the date popover and the edge of the modal panel.
 *
 * `.sift-modal` clips at `overflow: hidden`, so a popover flush with that edge
 * loses its own border to the clip even when the arithmetic says it fits.
 */
const POPOVER_GUTTER = 8;

/**
 * How the hit counter reads.
 *
 * A run with a search term counts RESULTS and may boast about the milliseconds
 * it took; a run that is nothing but filters counts NOTES, because a scan of
 * everything that passes a date range has neither hits nor a search time worth
 * quoting. The modal decides which it is and tells the bar, so the visible
 * counter in the header and this bar's live region cannot drift apart.
 */
export type CountMode = 'results' | 'notes';

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

/* -------------------------------------------------------------------------- */
/* Day arithmetic                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Every bound this module produces is a LOCAL day boundary, and the range is
 * inclusive at both ends: `createdFrom` is 00:00:00.000 of the first day,
 * `createdTo` is 23:59:59.999 of the last one, which is what makes a note
 * written at 23:59 on the closing day a member of its own range. The Searcher
 * compares `createdAt < createdFrom` and `createdAt > createdTo`, so those two
 * values are exactly the inclusive edges.
 *
 * All of it goes through the Date constructor's component form rather than
 * through arithmetic on milliseconds. A day is not always 86 400 000 ms — the
 * two DST switches make one 23 hours long and one 25 — and adding a fixed day
 * across either of them lands an hour off, which after a `startOfDay` is a
 * different date.
 */

/** Local midnight of the day `value` falls in. */
export function startOfDay(value: Millis): Millis {
	const source = new Date(value);
	return new Date(source.getFullYear(), source.getMonth(), source.getDate(), 0, 0, 0, 0).getTime();
}

/** The last millisecond of the day `value` falls in — the inclusive upper edge. */
export function endOfDay(value: Millis): Millis {
	const source = new Date(value);
	return new Date(source.getFullYear(), source.getMonth(), source.getDate(), 23, 59, 59, 999).getTime();
}

/** Local midnight `days` days after the day `value` falls in. Negative counts go back. */
export function addDays(value: Millis, days: number): Millis {
	const source = new Date(value);
	return new Date(source.getFullYear(), source.getMonth(), source.getDate() + days, 0, 0, 0, 0).getTime();
}

/** Local midnight of the first of the month `value` falls in. */
export function startOfMonth(value: Millis): Millis {
	const source = new Date(value);
	return new Date(source.getFullYear(), source.getMonth(), 1, 0, 0, 0, 0).getTime();
}

/** Same day-of-month `months` months away, clamped to the length of the target month (31 Jan + 1 -> 28 Feb). */
export function addMonths(value: Millis, months: number): Millis {
	const source = new Date(value);
	const wanted = source.getDate();
	const target = new Date(source.getFullYear(), source.getMonth() + months, 1, 0, 0, 0, 0);
	const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
	target.setDate(Math.min(wanted, lastDay));
	return target.getTime();
}

/** Days in the month `value` falls in. */
export function daysInMonth(value: Millis): number {
	const source = new Date(value);
	return new Date(source.getFullYear(), source.getMonth() + 1, 0).getDate();
}

/** ISO weekday of a timestamp: 1 for Monday through 7 for Sunday. */
export function isoWeekday(value: Millis): number {
	const day = new Date(value).getDay();
	return day === 0 ? DAYS_PER_WEEK : day;
}

/**
 * First weekday of the week in `locale`, as an ISO number (1 = Monday).
 *
 * Asked of `Intl`, never tabulated: German starts the week on Monday and
 * American English on Sunday, and British English — same language — on Monday
 * again, so nothing short of the locale database gets all three right. The
 * accessor was renamed mid-standardisation, so both spellings are tried; a
 * runtime that has neither falls back to the ISO 8601 default.
 */
export function firstWeekday(locale: string): number {
	try {
		const resolved = new Intl.Locale(locale) as Intl.Locale & {
			getWeekInfo?: () => { firstDay?: number };
			weekInfo?: { firstDay?: number };
		};
		const info = typeof resolved.getWeekInfo === 'function' ? resolved.getWeekInfo() : resolved.weekInfo;
		const first = info?.firstDay;
		if (typeof first === 'number' && first >= 1 && first <= DAYS_PER_WEEK) return first;
	} catch {
		// An unparseable tag is not worth a broken calendar.
	}
	return ISO_FIRST_WEEKDAY;
}

/** Empty cells before the first of the month, given the locale's first weekday. */
export function leadingBlanks(month: Millis, weekStart: number): number {
	return (isoWeekday(startOfMonth(month)) - weekStart + DAYS_PER_WEEK) % DAYS_PER_WEEK;
}

/** A pair with the earlier bound first. A caller that hands over a reversed pair gets it back in order. */
export function normalizeRange(
	from: Millis | null,
	to: Millis | null,
): { from: Millis | null; to: Millis | null } {
	if (from === null || to === null) return { from, to };
	return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * The two bounds a quick pick writes, day-aligned like every other bound this
 * bar produces, so the calendar can show what the pick selected.
 *
 * The lower edge is the midnight of the day `n` days back — the same instant the
 * old plain subtraction produced, floored to its day, so a pick can only ever
 * widen its old result set at that end. The upper edge is the end of today,
 * which is new: it excludes a note whose frontmatter dates it in the future, and
 * nothing else.
 */
export function quickPickRange(
	kind: QuickPickKind,
	now: Millis,
): { createdFrom: Millis | null; createdTo: Millis | null } {
	if (kind === 'any') return { createdFrom: null, createdTo: null };
	return { createdFrom: addDays(now, -QUICK_PICK_DAYS[kind]), createdTo: endOfDay(now) };
}

/* -------------------------------------------------------------------------- */
/* Popover placement                                                          */
/* -------------------------------------------------------------------------- */

/** Everything {@link placePopover} needs, all in one coordinate space. */
export interface PopoverGeometry {
	/** Left edge of the element the popover hangs off — its offset parent. */
	anchorLeft: number;
	/** Right edge of that element. */
	anchorRight: number;
	/** Width the popover wants, measured with no clamp applied. */
	popoverWidth: number;
	/** Left edge of the box the popover may not leave. */
	boundsLeft: number;
	/** Right edge of that box. */
	boundsRight: number;
}

/** What the popover's `left` and `max-width` should be. */
export interface PopoverPlacement {
	/** Offset from `anchorLeft`, in pixels; the popover is positioned against the anchor. */
	left: number;
	/** Widest the popover may be and still fit between the bounds. */
	maxWidth: number;
}

/**
 * Where the date popover has to sit so the modal cannot cut it off.
 *
 * The default — hanging off the anchor's LEFT edge — is what the mockup draws
 * and is kept whenever it fits. It stops fitting as soon as the chip moves right
 * inside the bar: measured in the browser at 809px of modal, the created chip
 * sat at x 714..805 with a 379px popover, so it reached x 1093 and the panel's
 * `overflow: hidden` ate the last 112px — the Saturday and Sunday columns and
 * the clear button, none of which could be clicked at all.
 *
 * The fix is the ordinary three-step of a flipping popover, and all three steps
 * are needed:
 *   1. left-align to the anchor;
 *   2. if that overflows the right bound, RIGHT-align to the anchor instead;
 *   3. clamp into the bounds, which is what catches the mirror case — an anchor
 *      so far left that the right-aligned popover would now hang off the other
 *      side — and, with the width clamp, a panel narrower than the popover.
 *
 * A wrapped filter bar needs nothing extra: wrapping moves the chip vertically,
 * and the popover follows it because it is positioned against the chip; only the
 * horizontal clamp decides whether anything is cut.
 */
export function placePopover(geometry: PopoverGeometry): PopoverPlacement {
	const available = Math.max(0, geometry.boundsRight - geometry.boundsLeft);
	const width = Math.min(geometry.popoverWidth, available);

	let left = geometry.anchorLeft;
	if (left + width > geometry.boundsRight) left = geometry.anchorRight - width;
	if (left < geometry.boundsLeft) left = geometry.boundsLeft;
	if (left + width > geometry.boundsRight) left = geometry.boundsRight - width;

	return { left: Math.round(left - geometry.anchorLeft), maxWidth: Math.round(available) };
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
	private readonly monthLabelEl: HTMLElement;
	private readonly gridEl: HTMLElement;
	private readonly sortSelectEl: HTMLSelectElement;
	private readonly statusEl: HTMLElement;

	/** The rendered day cells of the visible month, in grid order. */
	private dayCells: DayCell[] = [];
	/** Month the grid currently holds, and the locale it was laid out for. */
	private renderedMonth: Millis | null = null;
	private renderedLocale = '';
	/** First of the month on display. */
	private visibleMonth: Millis;
	/** Day the keyboard cursor sits on; also the only cell with a tab stop. */
	private cursorDay: Millis;
	/**
	 * Start of a range whose second end has not been picked yet. `null` whenever
	 * the next click is to start a new range, which is also the state a completed
	 * range leaves behind.
	 */
	private pendingStart: Millis | null = null;
	/** Day under the pointer while {@link pendingStart} is set, for the range preview. */
	private hoverDay: Millis | null = null;
	/** The created bounds the visible month was last synchronised to. */
	private syncedFrom: Millis | null;
	private syncedTo: Millis | null;
	/** How {@link FilterBar.renderSummary} words the live region. */
	private summaryMode: CountMode = 'results';

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
		const anchor = state.filters.createdFrom ?? state.filters.createdTo ?? now();
		this.visibleMonth = startOfMonth(anchor);
		this.cursorDay = startOfDay(anchor);
		this.syncedFrom = state.filters.createdFrom;
		this.syncedTo = state.filters.createdTo;
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
			attr: { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
		});
		const calendarIcon = this.dateChipEl.createSpan({ cls: 'sift-chip__icon' });
		setIcon(calendarIcon, 'calendar');
		this.dateLabelEl = this.dateChipEl.createSpan({ cls: 'sift-chip__label' });
		this.dateRemoveEl = this.dateWrapEl.createEl('button', {
			cls: 'sift-chip__remove sift-chip__remove--date',
			text: REMOVE_GLYPH,
			attr: { type: 'button', 'aria-label': t('filter.remove') },
		});
		// A dialog, not a menu: it holds a grid, and a grid is not a list of
		// menu items. The quick picks stay plain buttons inside it.
		this.dateMenuEl = this.dateWrapEl.createDiv({
			cls: 'sift-date-menu',
			attr: { role: 'dialog', 'aria-label': t('filter.created') },
		});
		const picks = this.dateMenuEl.createDiv({ cls: 'sift-date-menu__picks' });
		this.buildQuickPick(picks, 'week', 'filter.quick7Days');
		this.buildQuickPick(picks, 'month', 'filter.quick30Days');
		this.buildQuickPick(picks, 'year', 'filter.quickYear');
		this.buildQuickPick(picks, 'any', 'filter.quickAnyTime');

		const calendar = this.dateMenuEl.createDiv({ cls: 'sift-cal' });
		const head = calendar.createDiv({ cls: 'sift-cal__head' });
		const previous = head.createEl('button', {
			cls: 'sift-cal__nav',
			attr: { type: 'button', 'aria-label': t('filter.previousMonth') },
		});
		setIcon(previous, 'chevron-left');
		this.monthLabelEl = head.createDiv({
			cls: 'sift-cal__month',
			attr: { id: MONTH_LABEL_ID, 'aria-live': 'polite' },
		});
		const next = head.createEl('button', {
			cls: 'sift-cal__nav',
			attr: { type: 'button', 'aria-label': t('filter.nextMonth') },
		});
		setIcon(next, 'chevron-right');
		this.gridEl = calendar.createDiv({
			cls: 'sift-cal__grid',
			attr: { role: 'grid', 'aria-labelledby': MONTH_LABEL_ID },
		});
		const clear = calendar.createEl('button', {
			cls: 'sift-cal__clear',
			text: t('filter.clearRange'),
			attr: { type: 'button' },
		});

		this.lifecycle.registerDomEvent(previous, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.showMonth(addMonths(this.visibleMonth, -1));
		});
		this.lifecycle.registerDomEvent(next, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.showMonth(addMonths(this.visibleMonth, 1));
		});
		this.lifecycle.registerDomEvent(clear, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.applyQuickPick('any');
		});
		// Delegated, so a month change does not register 42 new listeners on a
		// Component that only lets go of them when the whole bar is destroyed.
		this.lifecycle.registerDomEvent(this.gridEl, 'click', (evt: MouseEvent) => {
			const day = this.dayOfEvent(evt);
			if (day === null) return;
			evt.preventDefault();
			this.pickDay(day);
		});
		this.lifecycle.registerDomEvent(this.gridEl, 'mouseover', (evt: MouseEvent) => {
			this.previewTo(this.dayOfEvent(evt));
		});
		this.lifecycle.registerDomEvent(this.gridEl, 'mouseleave', () => {
			this.previewTo(null);
		});

		this.lifecycle.registerDomEvent(this.dateChipEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.toggleDateMenu(!this.isDateMenuOpen());
		});
		this.lifecycle.registerDomEvent(this.dateRemoveEl, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			this.toggleDateMenu(false);
			this.applyQuickPick('any');
		});
		this.menuScope.register([], 'Escape', () => {
			this.toggleDateMenu(false);
			this.dateChipEl.focus();
			return false;
		});
		// Registered after Escape so that binding keeps it: Obsidian stops at the
		// first handler that reports the event handled.
		this.menuScope.register([], null, (evt: KeyboardEvent) => this.handleCalendarKey(evt));
		// Anywhere else in the window dismisses the menu — including the search
		// field above it, which is where a user who changed their mind clicks.
		this.lifecycle.registerDomEvent(this.el.ownerDocument, 'click', (evt: MouseEvent) => {
			if (!this.isDateMenuOpen()) return;
			const target = evt.target;
			if (target instanceof Node && this.dateWrapEl.contains(target)) return;
			this.toggleDateMenu(false);
		});
		// A resize moves the chip inside the bar — and can rewrap the bar entirely —
		// so an open popover is placed again rather than left where it was.
		const view = this.el.ownerDocument.defaultView;
		if (view !== null) {
			this.lifecycle.registerDomEvent(view, 'resize', () => {
				this.positionDateMenu();
			});
		}

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

	/** `mode` decides the wording; see {@link CountMode}. */
	setSummary(summary: SearchSummary | null, mode: CountMode = 'results'): void {
		if (summaryEquals(this.state.summary, summary) && this.summaryMode === mode) return;
		this.summaryMode = mode;
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

	private buildQuickPick(parent: HTMLElement, kind: QuickPickKind, key: TranslationKey): void {
		const button = parent.createEl('button', {
			cls: 'sift-date-menu__item',
			text: t(key),
			attr: { type: 'button' },
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

	/**
	 * A quick pick fills the same two fields the calendar does, so the calendar
	 * below it shows the range that was just chosen. That is also why it no longer
	 * closes the popover: a pick whose result is invisible is a pick the user has
	 * to reopen the popover to check.
	 */
	private applyQuickPick(kind: QuickPickKind): void {
		this.pendingStart = null;
		this.hoverDay = null;
		this.emitFilters(quickPickRange(kind, this.now()));
	}

	/**
	 * One click of the range, the way a booking site reads it: the first sets the
	 * start and leaves the end open, the second closes the range, and a click
	 * before the current start restarts the range there rather than producing a
	 * backwards one.
	 */
	private pickDay(day: Millis): void {
		const start = this.pendingStart;
		this.hoverDay = null;
		if (start === null || day < start) {
			this.pendingStart = day;
			this.cursorDay = day;
			this.emitFilters({ createdFrom: day, createdTo: null });
			return;
		}
		this.pendingStart = null;
		this.cursorDay = day;
		this.emitFilters({ createdFrom: start, createdTo: endOfDay(day) });
	}

	/** Range preview under the pointer. Only meaningful while a start is waiting for its end. */
	private previewTo(day: Millis | null): void {
		if (this.pendingStart === null) return;
		if (this.hoverDay === day) return;
		this.hoverDay = day;
		this.paintDays();
	}

	/** The day a pointer event landed on, or `null` when it missed every cell. */
	private dayOfEvent(evt: Event): Millis | null {
		const target = evt.target;
		if (!(target instanceof HTMLElement)) return null;
		const cell = target.closest('.sift-cal__day');
		return this.dayCells.find((entry) => entry.el === cell)?.day ?? null;
	}

	/**
	 * The calendar's keyboard map, dispatched from the one catch-all binding on
	 * the popover's scope. Returns true for every key it does not own, which
	 * leaves that event exactly as it was.
	 */
	private handleCalendarKey(evt: KeyboardEvent): boolean {
		if (!this.isDateMenuOpen()) return true;
		switch (evt.key.toLowerCase()) {
			case 'arrowleft':
				this.moveCursor(-1);
				break;
			case 'arrowright':
				this.moveCursor(1);
				break;
			case 'arrowup':
				this.moveCursor(-DAYS_PER_WEEK);
				break;
			case 'arrowdown':
				this.moveCursor(DAYS_PER_WEEK);
				break;
			case 'pageup':
				this.moveCursorMonths(-1);
				break;
			case 'pagedown':
				this.moveCursorMonths(1);
				break;
			case 'enter':
				this.pickDay(this.cursorDay);
				break;
			default:
				return true;
		}
		evt.preventDefault();
		return false;
	}

	/** Moves the cursor by whole days, flipping the month when it walks off either end. */
	private moveCursor(days: number): void {
		this.setCursor(addDays(this.cursorDay, days));
	}

	private moveCursorMonths(months: number): void {
		this.setCursor(addMonths(this.cursorDay, months));
	}

	private setCursor(day: Millis): void {
		this.cursorDay = day;
		this.visibleMonth = startOfMonth(day);
		this.renderCalendar();
		this.dayCells.find((entry) => entry.day === day)?.el.focus();
	}

	/** Month navigation. The cursor follows into the month so the next arrow key continues there. */
	private showMonth(month: Millis): void {
		this.visibleMonth = month;
		this.cursorDay = clampToMonth(this.cursorDay, month);
		this.renderCalendar();
	}

	private isDateMenuOpen(): boolean {
		return this.dateWrapEl.hasClass('sift-filters__date--open');
	}

	/** Idempotent: the scope is pushed and popped exactly once per open/close. */
	private toggleDateMenu(open: boolean): void {
		if (open === this.isDateMenuOpen()) return;
		this.dateWrapEl.toggleClass('sift-filters__date--open', open);
		this.dateChipEl.setAttr('aria-expanded', open ? 'true' : 'false');
		if (open) {
			// After the class, never before: a `display: none` popover measures zero.
			this.positionDateMenu();
			this.app.keymap.pushScope(this.menuScope);
		} else {
			// A half-made range does not survive a close: the filter keeps the start
			// that was already reported, and the next opening starts a new range
			// rather than silently closing the abandoned one.
			this.pendingStart = null;
			this.hoverDay = null;
			this.app.keymap.popScope(this.menuScope);
			this.paintDays();
		}
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
		this.syncVisibleMonth();
		this.renderCalendar();
		// The chip has just changed width — an empty "Created" is far narrower than
		// "Created 07.09.2025 – 07.09.2026" — and the popover is anchored to it, so
		// a placement made when it opened no longer lines up with its own chip.
		this.positionDateMenu();
	}

	/**
	 * Brings the calendar to the month a newly arrived range starts in, and
	 * nowhere else: a filter change that leaves the two created bounds alone —
	 * another folder, another sort — must not yank the month the user is browsing
	 * out from under them, and neither must a half-made range.
	 */
	private syncVisibleMonth(): void {
		const { createdFrom, createdTo } = this.state.filters;
		if (createdFrom === this.syncedFrom && createdTo === this.syncedTo) return;
		this.syncedFrom = createdFrom;
		this.syncedTo = createdTo;
		if (this.pendingStart !== null) return;

		const ordered = normalizeRange(
			createdFrom === null ? null : startOfDay(createdFrom),
			createdTo === null ? null : startOfDay(createdTo),
		);
		const first = ordered.from ?? ordered.to;
		if (first === null) return;
		const last = ordered.to ?? first;
		// The month on display already shows part of the range, so it stays: a
		// "last 7 days" that reaches back over a month boundary must not drag the
		// view into the previous month to show a start the user did not name.
		if (this.visibleMonth >= startOfMonth(first) && this.visibleMonth <= startOfMonth(last)) {
			this.cursorDay = clampToMonth(this.cursorDay, this.visibleMonth);
			return;
		}
		this.visibleMonth = startOfMonth(first);
		this.cursorDay = first;
	}

	/** Lays the month out when it changed, then paints the range onto it. */
	private renderCalendar(): void {
		const locale = dateFormatLocale();
		if (this.renderedMonth !== this.visibleMonth || this.renderedLocale !== locale) {
			this.renderMonth(locale);
		}
		this.paintDays();
	}

	/**
	 * Builds the six-week grid of the visible month.
	 *
	 * Month and weekday names come from `Intl` for the interface locale, never
	 * from a list in this file: that is what makes the German names German, the
	 * English ones English, and the column order Monday-first or Sunday-first
	 * according to the locale rather than according to whoever wrote the array.
	 * The rows are fixed at six so the popover keeps its height between a month
	 * that needs five and one that needs six.
	 */
	private renderMonth(locale: string): void {
		this.renderedMonth = this.visibleMonth;
		this.renderedLocale = locale;
		this.monthLabelEl.setText(monthLabel(this.visibleMonth, locale));

		this.gridEl.empty();
		this.dayCells = [];
		const weekStart = firstWeekday(locale);

		const header = this.gridEl.createDiv({ cls: 'sift-cal__week sift-cal__week--head', attr: { role: 'row' } });
		for (let column = 0; column < DAYS_PER_WEEK; column++) {
			const isoDay = ((weekStart - 1 + column) % DAYS_PER_WEEK) + 1;
			header.createDiv({
				cls: 'sift-cal__weekday',
				text: weekdayLabel(isoDay, locale, true),
				attr: { role: 'columnheader', 'aria-label': weekdayLabel(isoDay, locale, false) },
			});
		}

		const blanks = leadingBlanks(this.visibleMonth, weekStart);
		const length = daysInMonth(this.visibleMonth);
		for (let week = 0; week < WEEKS_PER_MONTH; week++) {
			const row = this.gridEl.createDiv({ cls: 'sift-cal__week', attr: { role: 'row' } });
			for (let column = 0; column < DAYS_PER_WEEK; column++) {
				const dayOfMonth = week * DAYS_PER_WEEK + column - blanks + 1;
				if (dayOfMonth < 1 || dayOfMonth > length) {
					row.createDiv({ cls: 'sift-cal__blank', attr: { role: 'gridcell', 'aria-disabled': 'true' } });
					continue;
				}
				const day = addDays(this.visibleMonth, dayOfMonth - 1);
				const el = row.createEl('button', {
					cls: 'sift-cal__day',
					text: String(dayOfMonth),
					attr: {
						type: 'button',
						role: 'gridcell',
						tabindex: '-1',
						'aria-selected': 'false',
						'aria-label': dayLabel(day, locale),
					},
				});
				this.dayCells.push({ el, day });
			}
		}
	}

	/** Writes the range onto the cells that are already there. No rebuild, so a hover costs 42 class writes. */
	private paintDays(): void {
		const range = this.paintedRange();
		const today = startOfDay(this.now());
		for (const cell of this.dayCells) {
			const isStart = range.start !== null && cell.day === range.start;
			const isEnd = range.end !== null && cell.day === range.end;
			const inside =
				range.start !== null && range.end !== null && cell.day > range.start && cell.day < range.end;
			cell.el.toggleClass('sift-cal__day--start', isStart);
			cell.el.toggleClass('sift-cal__day--end', isEnd);
			cell.el.toggleClass('sift-cal__day--inside', inside);
			cell.el.toggleClass('sift-cal__day--preview', range.preview && (inside || isEnd));
			cell.el.toggleClass('sift-cal__day--today', cell.day === today);
			cell.el.setAttr('aria-selected', isStart || isEnd || inside ? 'true' : 'false');
			cell.el.setAttr('tabindex', cell.day === this.cursorDay ? '0' : '-1');
		}
	}

	/**
	 * What the grid should show: the committed range, or — while a start is
	 * waiting for its end — that start plus wherever the pointer currently is.
	 * A pair that arrives reversed is put back in order rather than drawn
	 * backwards or not at all.
	 */
	private paintedRange(): { start: Millis | null; end: Millis | null; preview: boolean } {
		const start = this.pendingStart;
		if (start !== null) {
			const hover = this.hoverDay;
			const end = hover !== null && hover >= start ? hover : null;
			return { start, end, preview: end !== null };
		}
		const { createdFrom, createdTo } = this.state.filters;
		const ordered = normalizeRange(
			createdFrom === null ? null : startOfDay(createdFrom),
			createdTo === null ? null : startOfDay(createdTo),
		);
		return { start: ordered.from, end: ordered.to, preview: false };
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
		this.statusEl.setText(summaryText(summary, this.summaryMode));
	}

	/**
	 * Places the open popover inside the modal panel.
	 *
	 * The two custom properties are cleared first so the popover is MEASURED at
	 * its natural width rather than at whatever a previous placement clamped it
	 * to; without that the width would ratchet down every time the bar rewrapped.
	 * A layout that has not happened yet — a test DOM, the first paint — reports
	 * zero for every rect, and a placement computed from zeroes is a guess, so
	 * nothing is written and the popover keeps the mockup's left-aligned default.
	 */
	private positionDateMenu(): void {
		if (!this.isDateMenuOpen()) return;
		this.dateWrapEl.setCssProps({ '--sift-date-menu-left': '0px', '--sift-date-menu-max-width': 'none' });

		const anchor = this.dateWrapEl.getBoundingClientRect();
		const menu = this.dateMenuEl.getBoundingClientRect();
		const bounds = this.popoverBounds();
		if (bounds === null || menu.width <= 0) return;

		const placement = placePopover({
			anchorLeft: anchor.left,
			anchorRight: anchor.right,
			popoverWidth: menu.width,
			boundsLeft: bounds.left + POPOVER_GUTTER,
			boundsRight: bounds.right - POPOVER_GUTTER,
		});
		this.dateWrapEl.setCssProps({
			'--sift-date-menu-left': `${placement.left}px`,
			'--sift-date-menu-max-width': `${placement.maxWidth}px`,
		});
	}

	/** The box the popover may not leave: the modal panel, which is what clips it. */
	private popoverBounds(): { left: number; right: number } | null {
		const modal = this.el.closest('.sift-modal');
		const box = modal instanceof HTMLElement ? modal : this.el;
		const rect = box.getBoundingClientRect();
		return rect.width > 0 ? { left: rect.left, right: rect.right } : null;
	}
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** One rendered day cell: the button and the local midnight it stands for. */
interface DayCell {
	el: HTMLElement;
	day: Millis;
}

/** Short numeric day for the date chip, in the interface locale. */
function formatDay(value: Millis): string {
	return new Intl.DateTimeFormat(dateFormatLocale(), {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(value));
}

/** 'September 2026' / 'September 2026', in the interface locale. */
function monthLabel(month: Millis, locale: string): string {
	return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(month));
}

/** Column heading of an ISO weekday: the short form for the eye, the long one for the accessible name. */
function weekdayLabel(isoDay: number, locale: string, short: boolean): string {
	const date = new Date(WEEKDAY_EPOCH.year, WEEKDAY_EPOCH.month, WEEKDAY_EPOCH.day + isoDay - 1);
	return new Intl.DateTimeFormat(locale, { weekday: short ? 'short' : 'long' }).format(date);
}

/** Accessible name of a day cell: the whole date, so the number alone is never all a screen reader gets. */
function dayLabel(day: Millis, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	}).format(new Date(day));
}

/** The same day-of-month inside `month`, shortened to that month's last day when it has no such date. */
function clampToMonth(day: Millis, month: Millis): Millis {
	const wanted = new Date(day).getDate();
	return addDays(month, Math.min(wanted, daysInMonth(month)) - 1);
}

/** The same anatomy the header counter uses, for the live region. */
function summaryText(summary: SearchSummary, mode: CountMode): string {
	if (mode === 'notes') {
		if (summary.count === 0) return t('search.notesNone');
		if (summary.count === 1) return t('search.notesOne');
		return t('search.notes', { n: summary.count });
	}
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
