/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from 'vitest';
import { TFolder, installDomHelpers } from '../stubs/obsidian';
import type { App } from 'obsidian';
import {
	FilterBar,
	addDays,
	addMonths,
	endOfDay,
	firstWeekday,
	leadingBlanks,
	normalizeRange,
	quickPickRange,
	startOfDay,
} from '../../src/ui/FilterBar';
import { setLanguage, t } from '../../src/i18n/index';
import type { FilterBarCallbacks, FilterBarState, Millis, SearchFilters, SortKey } from '../../src/types';

installDomHelpers();

/**
 * A fixed clock, in LOCAL time.
 *
 * Every bound the bar produces is a local day boundary, so a fixture built with
 * `Date.UTC` would name a different calendar day depending on where the test
 * runs. Monday, 7 September 2026, 10:00.
 */
const NOW = new Date(2026, 8, 7, 10, 0, 0, 0).getTime();

/** Local midnight of a calendar date, written the way a reader says it: month 1-12. */
function local(year: number, month: number, day: number): Millis {
	return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

interface Harness {
	bar: FilterBar;
	host: HTMLElement;
	state: FilterBarState;
	filters: SearchFilters[];
	sorts: SortKey[];
	fuzzies: boolean[];
	folderCalls(): number;
	/** Scopes the bar has pushed onto the keymap and not popped again. */
	pushedScopes: unknown[];
}

function baseFilters(overrides: Partial<SearchFilters> = {}): SearchFilters {
	return {
		folder: null,
		includeSubfolders: true,
		createdFrom: null,
		createdTo: null,
		modifiedFrom: null,
		modifiedTo: null,
		property: null,
		note: null,
		excludedFolders: [],
		...overrides,
	};
}

function baseState(overrides: Partial<FilterBarState> = {}): FilterBarState {
	return {
		filters: baseFilters(),
		sort: 'relevance',
		fuzzy: false,
		activeNote: 'Projekte/Offen.md',
		summary: null,
		...overrides,
	};
}

function mount(state: FilterBarState = baseState()): Harness {
	const host = document.body.createDiv();
	const filters: SearchFilters[] = [];
	const sorts: SortKey[] = [];
	const fuzzies: boolean[] = [];
	const scopes: unknown[] = [];
	let folderCalls = 0;

	const app = {
		keymap: {
			pushScope: (scope: unknown) => scopes.push(scope),
			popScope: (scope: unknown) => {
				const at = scopes.indexOf(scope);
				if (at >= 0) scopes.splice(at, 1);
			},
		},
		vault: {
			getAllFolders: (): TFolder[] => {
				folderCalls++;
				return [new TFolder('Projekte'), new TFolder('Projekte/2026'), new TFolder('Notizen')];
			},
		},
	} as unknown as App;

	const callbacks: FilterBarCallbacks = {
		onFiltersChange: (next) => filters.push(next),
		onSortChange: (next) => sorts.push(next),
		onFuzzyChange: (next) => fuzzies.push(next),
		// A tiny stand-in vault: two properties, values only under `status`.
		propertySuggestions: (key, query): readonly string[] => {
			const pool = key === null ? ['due', 'status'] : key === 'status' ? ['erledigt', 'offen'] : [];
			return pool.filter((entry) => entry.includes(query));
		},
	};

	const bar = new FilterBar(app, host, state, callbacks, () => NOW);
	return { bar, host, state, filters, sorts, fuzzies, folderCalls: () => folderCalls, pushedScopes: scopes };
}

/** Every handler the bar registered for `key` on the scope it pushes while the menu is open. */
function menuHandlers(h: Harness, key: string): Array<(evt: KeyboardEvent) => unknown> {
	const scope = h.pushedScopes[0] as { keys?: Array<{ key: string | null; handler: (evt: KeyboardEvent) => unknown }> };
	return (scope?.keys ?? []).filter((entry) => entry.key === key).map((entry) => entry.handler);
}

/**
 * Presses a key on the popover's scope, the way Obsidian's keymap would: the
 * bindings are tried in registration order and the first one that reports the
 * event handled stops the walk.
 */
function press(h: Harness, key: string): void {
	const scope = h.pushedScopes[0] as { keys?: Array<{ key: string | null; handler: (evt: KeyboardEvent) => unknown }> };
	const event = new KeyboardEvent('keydown', { key, bubbles: true });
	for (const entry of scope?.keys ?? []) {
		if (entry.key !== null && entry.key !== key) continue;
		if (entry.handler(event) === false) return;
	}
}

/** Opens the created-date popover. */
function openDates(h: Harness): void {
	button(h.bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The day button carrying `dayOfMonth` in the month currently on display. */
function day(bar: FilterBar, dayOfMonth: number): HTMLElement {
	const cells = Array.from(bar.el.querySelectorAll<HTMLElement>('.sift-cal__day'));
	const found = cells.find((cell) => cell.textContent === String(dayOfMonth));
	if (found === undefined) throw new Error(`day ${dayOfMonth} is not in the rendered month`);
	return found;
}

function clickDay(bar: FilterBar, dayOfMonth: number): void {
	day(bar, dayOfMonth).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** The day numbers carrying `cls`, in grid order. */
function daysWith(bar: FilterBar, cls: string): string[] {
	return Array.from(bar.el.querySelectorAll<HTMLElement>(`.${cls}`)).map((cell) => cell.textContent ?? '');
}

function input(bar: FilterBar, selector: string): HTMLInputElement {
	const el = bar.el.querySelector(selector);
	if (!(el instanceof HTMLInputElement)) throw new Error(`no input for ${selector}`);
	return el;
}

function button(bar: FilterBar, selector: string): HTMLElement {
	const el = bar.el.querySelector(selector);
	if (!(el instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
	return el;
}

beforeEach(() => {
	setLanguage('en');
	document.body.empty();
});

describe('folder input', () => {
	it('passes every typed path through normalizePath before reporting it', () => {
		const h = mount();
		const path = input(h.bar, '.sift-chip__input');
		path.value = '..\\Projekte\\';
		path.dispatchEvent(new Event('change'));

		expect(h.filters.length).toBe(1);
		expect(h.filters[0].folder).toBe('Projekte');
	});

	it('normalizes on Enter as well, and treats an empty box as the whole vault', () => {
		const h = mount(baseState({ filters: baseFilters({ folder: 'Projekte' }) }));
		const path = input(h.bar, '.sift-chip__input');
		expect(path.value).toBe('Projekte');

		path.value = 'Projekte//2026/';
		path.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		expect(h.filters[0].folder).toBe('Projekte/2026');

		path.value = '   ';
		path.dispatchEvent(new Event('change'));
		expect(h.filters[1].folder).toBeNull();
	});

	it('clears the folder from the chip remove button', () => {
		const h = mount(baseState({ filters: baseFilters({ folder: 'Projekte' }) }));
		button(h.bar, '.sift-chip--path .sift-chip__remove').dispatchEvent(new MouseEvent('click'));
		expect(h.filters[0].folder).toBeNull();
	});

	it('marks the chip active only while a folder is set', () => {
		const h = mount();
		const chip = button(h.bar, '.sift-chip--path');
		expect(chip.hasClass('sift-chip--active')).toBe(false);

		h.bar.setState(baseState({ filters: baseFilters({ folder: 'Projekte' }) }));
		expect(chip.hasClass('sift-chip--active')).toBe(true);
	});

	it('offers vault folders through the suggester and detaches it on destroy', async () => {
		const h = mount();
		const path = input(h.bar, '.sift-chip__input');

		path.value = 'proj';
		path.dispatchEvent(new Event('input'));
		await Promise.resolve();
		await Promise.resolve();
		expect(h.folderCalls()).toBe(1);

		h.bar.destroy();
		path.value = 'noti';
		path.dispatchEvent(new Event('input'));
		await Promise.resolve();
		await Promise.resolve();
		expect(h.folderCalls()).toBe(1);
	});
});

describe('this-note switch', () => {
	function noteToggle(h: Harness): HTMLInputElement {
		return input(h.bar, '.sift-toggle--note .sift-toggle__input');
	}

	it('confines the search to the note the overlay was called from', () => {
		const h = mount();

		noteToggle(h).checked = true;
		noteToggle(h).dispatchEvent(new Event('change'));

		expect(h.filters[0].note).toBe('Projekte/Offen.md');

		noteToggle(h).checked = false;
		noteToggle(h).dispatchEvent(new Event('change'));
		expect(h.filters[1].note).toBeNull();
	});

	it('is unavailable, not absent, when no note is open', () => {
		// A control that comes and goes is harder to find again than one that is
		// visibly out of service.
		const h = mount(baseState({ activeNote: null }));

		expect(noteToggle(h).disabled).toBe(true);
		expect(button(h.bar, '.sift-toggle--note').hasClass('sift-toggle--disabled')).toBe(true);
	});

	it('shows the filter it was given', () => {
		const h = mount(baseState({ filters: baseFilters({ note: 'Projekte/Offen.md' }) }));
		expect(noteToggle(h).checked).toBe(true);
		expect(button(h.bar, '.sift-toggle--note').hasClass('sift-toggle--on')).toBe(true);
	});
});

describe('bar order', () => {
	it('reads folder, property, date, sort, then the switches on the right', () => {
		const h = mount();
		const order = Array.from(h.bar.el.children)
			.map((el) => el.className)
			.filter((cls) => !cls.includes('sift-filters__status'));

		expect(order).toEqual([
			'sift-chip sift-chip--path',
			'sift-chip sift-chip--property',
			'sift-filters__date',
			'sift-sort',
			'sift-filters__switches',
		]);
		// The three switches, in the group, in this order.
		const switches = Array.from(
			h.bar.el.querySelectorAll('.sift-filters__switches > .sift-toggle'),
		).map((el) => el.className);
		expect(switches[0]).toContain('sift-toggle--note');
		expect(switches[1]).toContain('sift-toggle--subfolders');
		expect(switches[2]).toContain('sift-toggle--similar');
	});
});

describe('property chip', () => {
	function keyBox(h: Harness): HTMLInputElement {
		return input(h.bar, '.sift-chip__input--key');
	}

	function valueBox(h: Harness): HTMLInputElement {
		return input(h.bar, '.sift-chip__input--value');
	}

	function type(box: HTMLInputElement, value: string): void {
		box.value = value;
		box.dispatchEvent(new Event('change'));
	}

	it('filters on a property alone, which asks whether the note carries it', () => {
		const h = mount();

		type(keyBox(h), 'status');

		expect(h.filters.length).toBe(1);
		expect(h.filters[0].property).toEqual({ key: 'status', value: null });
		expect(button(h.bar, '.sift-chip--property').hasClass('sift-chip--active')).toBe(true);
	});

	it('folds both boxes the way the index folded the note', () => {
		const h = mount();

		// Typed with a capital and an umlaut; the record holds the folded form, so
		// the filter has to travel folded or it would match nothing.
		type(keyBox(h), 'Fällig');
		type(valueBox(h), 'Übermorgen');

		expect(h.filters[h.filters.length - 1].property).toEqual({ key: 'fallig', value: 'ubermorgen' });
	});

	it('waits for the key when only a value has been typed', () => {
		const h = mount();

		type(valueBox(h), 'offen');

		// Nothing to compare the value against yet, so no search is triggered - and
		// the text stays in the box rather than being thrown away.
		expect(h.filters.length).toBe(0);
		expect(valueBox(h).value).toBe('offen');

		type(keyBox(h), 'status');
		expect(h.filters[0].property).toEqual({ key: 'status', value: 'offen' });
	});

	it('clears both boxes from the chip remove button', () => {
		const h = mount();
		type(keyBox(h), 'status');
		type(valueBox(h), 'offen');

		button(h.bar, '.sift-chip--property .sift-chip__remove').dispatchEvent(new MouseEvent('click'));

		expect(h.filters[h.filters.length - 1].property).toBeNull();
		expect(keyBox(h).value).toBe('');
		expect(valueBox(h).value).toBe('');
		expect(button(h.bar, '.sift-chip--property').hasClass('sift-chip--active')).toBe(false);
	});

	it('emits nothing when a re-entered value says the same thing', () => {
		const h = mount();
		type(keyBox(h), 'status');
		expect(h.filters.length).toBe(1);

		type(keyBox(h), 'status');
		expect(h.filters.length).toBe(1);
	});
});

describe('quick picks', () => {
	it('computes both bounds against the injected clock, day-aligned and inclusive', () => {
		expect(quickPickRange('week', NOW)).toEqual({
			createdFrom: local(2026, 8, 31),
			createdTo: new Date(2026, 8, 7, 23, 59, 59, 999).getTime(),
		});
		expect(quickPickRange('month', NOW).createdFrom).toBe(local(2026, 8, 8));
		expect(quickPickRange('year', NOW).createdFrom).toBe(local(2025, 9, 7));
		expect(quickPickRange('any', NOW)).toEqual({ createdFrom: null, createdTo: null });
		// "Today" is the only pick whose two bounds sit on the same day. It is also
		// the only way to ask for a single day at all: the calendar keeps a range
		// open when the second click lands on the day that is already its start.
		expect(quickPickRange('today', NOW)).toEqual({
			createdFrom: local(2026, 9, 7),
			createdTo: new Date(2026, 8, 7, 23, 59, 59, 999).getTime(),
		});
	});

	it('applies each quick pick and clears both bounds from the chip remove button', () => {
		const h = mount();
		const items = h.bar.el.querySelectorAll('.sift-date-menu__item');
		expect(items.length).toBe(5);

		items[0].dispatchEvent(new MouseEvent('click'));
		expect(h.filters[0].createdFrom).toBe(local(2026, 9, 7));
		expect(h.filters[0].createdTo).toBe(endOfDay(NOW));

		items[1].dispatchEvent(new MouseEvent('click'));
		expect(h.filters[1].createdFrom).toBe(local(2026, 8, 31));
		expect(h.filters[1].createdTo).toBe(endOfDay(NOW));

		items[2].dispatchEvent(new MouseEvent('click'));
		expect(h.filters[2].createdFrom).toBe(local(2026, 8, 8));

		items[3].dispatchEvent(new MouseEvent('click'));
		expect(h.filters[3].createdFrom).toBe(local(2025, 9, 7));

		button(h.bar, '.sift-chip__remove--date').dispatchEvent(new MouseEvent('click'));
		expect(h.filters[4].createdFrom).toBeNull();
		expect(h.filters[4].createdTo).toBeNull();
	});

	it('leaves the popover open so the calendar shows what the quick pick selected', () => {
		const h = mount();
		const wrap = button(h.bar, '.sift-filters__date');
		openDates(h);

		// The second item: "Today" now leads the list, and a range that is one day
		// long says nothing about whether the view follows the start.
		h.bar.el
			.querySelectorAll('.sift-date-menu__item')[1]
			.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		// A pick whose result is invisible is a pick you have to reopen the
		// popover to check, so the popover stays where it is.
		expect(wrap.hasClass('sift-filters__date--open')).toBe(true);
		// "Last 7 days" from Monday 7 September reaches back to 31 August, and the
		// view stays on the month it was already showing rather than following the
		// start into August.
		expect(button(h.bar, '.sift-cal__month').textContent).toContain('September');
		expect(daysWith(h.bar, 'sift-cal__day--end')).toEqual(['7']);
		expect(daysWith(h.bar, 'sift-cal__day--inside')).toEqual(['1', '2', '3', '4', '5', '6']);
	});

	it('opens and closes the popover without losing filter values', () => {
		const h = mount(baseState({ filters: baseFilters({ folder: 'Projekte', includeSubfolders: false }) }));
		const wrap = button(h.bar, '.sift-filters__date');
		const chip = button(h.bar, '.sift-chip--date');

		chip.dispatchEvent(new MouseEvent('click'));
		expect(wrap.hasClass('sift-filters__date--open')).toBe(true);
		expect(chip.getAttribute('aria-expanded')).toBe('true');

		chip.dispatchEvent(new MouseEvent('click'));
		expect(wrap.hasClass('sift-filters__date--open')).toBe(false);
		expect(input(h.bar, '.sift-chip__input').value).toBe('Projekte');
		expect(input(h.bar, '.sift-toggle--subfolders .sift-toggle__input').checked).toBe(false);
	});

	it('closes the open popover on a click outside it', () => {
		const h = mount();
		const wrap = button(h.bar, '.sift-filters__date');
		const outside = document.body.createDiv();

		button(h.bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(wrap.hasClass('sift-filters__date--open')).toBe(true);

		// A click inside the popover is not "outside": the quick pick has to
		// survive long enough to run its own handler, and the popover stays open.
		button(h.bar, '.sift-date-menu__item').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.filters.length).toBe(1);
		expect(wrap.hasClass('sift-filters__date--open')).toBe(true);

		outside.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(wrap.hasClass('sift-filters__date--open')).toBe(false);
		expect(button(h.bar, '.sift-chip--date').getAttribute('aria-expanded')).toBe('false');
		// No filter was changed by dismissing the menu.
		expect(h.filters.length).toBe(1);
	});

	it('closes the menu on Escape through a pushed scope, so the modal stays open', () => {
		const h = mount();
		const wrap = button(h.bar, '.sift-filters__date');
		expect(h.pushedScopes.length).toBe(0);

		button(h.bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(wrap.hasClass('sift-filters__date--open')).toBe(true);
		// While the menu is open its own scope is the active one, which is the only
		// place an Escape can be caught before the modal's own binding closes it.
		expect(h.pushedScopes.length).toBe(1);

		const escapes = menuHandlers(h, 'Escape');
		expect(escapes.length).toBe(1);
		const handled = escapes[0](new KeyboardEvent('keydown', { key: 'Escape' }));

		expect(handled).toBe(false);
		expect(wrap.hasClass('sift-filters__date--open')).toBe(false);
		expect(h.pushedScopes.length).toBe(0);
	});

	it('pops the scope and drops the document listener when the bar is destroyed', () => {
		const h = mount();
		const wrap = button(h.bar, '.sift-filters__date');
		button(h.bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.pushedScopes.length).toBe(1);

		h.bar.destroy();
		expect(h.pushedScopes.length).toBe(0);
		expect(wrap.hasClass('sift-filters__date--open')).toBe(false);

		// A document click after destroy must not reach a detached bar.
		expect(() => document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
	});
});

/* -------------------------------------------------------------------------- */
/* Calendar                                                                   */
/* -------------------------------------------------------------------------- */

describe('calendar arithmetic', () => {
	it('puts the day boundaries where the filter needs them', () => {
		const noon = new Date(2026, 8, 14, 12, 30, 15, 250).getTime();
		expect(startOfDay(noon)).toBe(local(2026, 9, 14));
		expect(endOfDay(noon)).toBe(new Date(2026, 8, 14, 23, 59, 59, 999).getTime());
		// The end is inclusive, so the last moment of the day is inside the range
		// and the first moment of the next one is not.
		expect(new Date(2026, 8, 14, 23, 59, 0, 0).getTime()).toBeLessThanOrEqual(endOfDay(noon));
		expect(local(2026, 9, 15)).toBeGreaterThan(endOfDay(noon));
	});

	it('steps days and months across a DST switch and a short month', () => {
		// Central European summer time ends on 25 October 2026; a plain +86400000
		// lands an hour earlier and, after a startOfDay, on the previous date.
		expect(addDays(local(2026, 10, 25), 1)).toBe(local(2026, 10, 26));
		expect(addDays(local(2026, 3, 29), -1)).toBe(local(2026, 3, 28));
		expect(addDays(local(2026, 3, 1), -1)).toBe(local(2026, 2, 28));
		expect(addMonths(local(2026, 1, 31), 1)).toBe(local(2026, 2, 28));
		expect(addMonths(local(2026, 8, 31), 1)).toBe(local(2026, 9, 30));
		expect(addMonths(local(2026, 1, 15), -1)).toBe(local(2025, 12, 15));
	});

	it('takes the first weekday from the locale rather than from a list', () => {
		expect(firstWeekday('de')).toBe(1);
		expect(firstWeekday('de-CH')).toBe(1);
		expect(firstWeekday('en')).toBe(7);
		// Same language, different week: this is why the value is asked for and
		// not tabulated by language.
		expect(firstWeekday('en-GB')).toBe(1);
		// A tag the runtime cannot parse still has to produce a calendar.
		expect(firstWeekday('not a locale')).toBe(1);
	});

	it('counts the leading blanks of a month against the locale week start', () => {
		// 1 November 2026 is a Sunday: six blanks in a Monday-first week, none in
		// a Sunday-first one.
		expect(leadingBlanks(local(2026, 11, 1), 1)).toBe(6);
		expect(leadingBlanks(local(2026, 11, 1), 7)).toBe(0);
		expect(leadingBlanks(local(2026, 9, 1), 1)).toBe(1);
	});

	it('puts a reversed pair back in order and leaves an open one alone', () => {
		const early = local(2026, 9, 10);
		const late = local(2026, 9, 20);
		expect(normalizeRange(late, early)).toEqual({ from: early, to: late });
		expect(normalizeRange(early, late)).toEqual({ from: early, to: late });
		expect(normalizeRange(early, null)).toEqual({ from: early, to: null });
		expect(normalizeRange(null, late)).toEqual({ from: null, to: late });
	});
});

describe('calendar grid', () => {
	it('lays a month out with the leading blanks its locale asks for', () => {
		setLanguage('de');
		// November 2026 starts on a Sunday, and a German week starts on Monday.
		const h = mount(baseState({ filters: baseFilters({ createdFrom: local(2026, 11, 15) }) }));
		openDates(h);

		const cells = Array.from(h.bar.el.querySelectorAll('.sift-cal__grid .sift-cal__week:not(.sift-cal__week--head) > *'));
		const firstDay = cells.findIndex((cell) => cell.classList.contains('sift-cal__day'));
		expect(firstDay).toBe(6);
		expect(cells.slice(0, 6).every((cell) => cell.classList.contains('sift-cal__blank'))).toBe(true);
		expect(h.bar.el.querySelectorAll('.sift-cal__day').length).toBe(30);
		expect(button(h.bar, '.sift-cal__month').textContent).toBe('November 2026');

		// The column headings come from Intl, in the locale's own order.
		const weekdays = Array.from(h.bar.el.querySelectorAll('.sift-cal__weekday')).map((el) => el.textContent);
		expect(weekdays.length).toBe(7);
		expect(weekdays[0]).toBe(new Intl.DateTimeFormat('de', { weekday: 'short' }).format(new Date(2024, 0, 1)));
		expect(weekdays[6]).toBe(new Intl.DateTimeFormat('de', { weekday: 'short' }).format(new Date(2024, 0, 7)));
	});

	it('starts the week on Sunday in English, with no leading blank for that same month', () => {
		setLanguage('en');
		const h = mount(baseState({ filters: baseFilters({ createdFrom: local(2026, 11, 15) }) }));
		openDates(h);

		const cells = Array.from(h.bar.el.querySelectorAll('.sift-cal__grid .sift-cal__week:not(.sift-cal__week--head) > *'));
		expect(cells[0].classList.contains('sift-cal__day')).toBe(true);
		expect(cells[0].textContent).toBe('1');
	});

	it('names every day for a screen reader and marks the range with aria-selected', () => {
		const h = mount(baseState({ filters: baseFilters({ createdFrom: local(2026, 9, 10), createdTo: endOfDay(local(2026, 9, 12)) }) }));
		openDates(h);

		expect(day(h.bar, 10).getAttribute('aria-label')).toBe(
			new Intl.DateTimeFormat('en', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
				.format(new Date(2026, 8, 10)),
		);
		expect(day(h.bar, 10).getAttribute('role')).toBe('gridcell');
		expect(day(h.bar, 10).getAttribute('aria-selected')).toBe('true');
		expect(day(h.bar, 11).getAttribute('aria-selected')).toBe('true');
		expect(day(h.bar, 12).getAttribute('aria-selected')).toBe('true');
		expect(day(h.bar, 13).getAttribute('aria-selected')).toBe('false');
		expect(daysWith(h.bar, 'sift-cal__day--start')).toEqual(['10']);
		expect(daysWith(h.bar, 'sift-cal__day--inside')).toEqual(['11']);
		expect(daysWith(h.bar, 'sift-cal__day--end')).toEqual(['12']);
	});

	it('draws a reversed pair the right way round', () => {
		const h = mount(
			baseState({ filters: baseFilters({ createdFrom: local(2026, 9, 20), createdTo: endOfDay(local(2026, 9, 10)) }) }),
		);
		openDates(h);

		expect(daysWith(h.bar, 'sift-cal__day--start')).toEqual(['10']);
		expect(daysWith(h.bar, 'sift-cal__day--end')).toEqual(['20']);
	});
});

describe('picking a range', () => {
	it('sets the start on the first click and the end on the second', () => {
		const h = mount();
		openDates(h);

		clickDay(h.bar, 10);
		expect(h.filters.length).toBe(1);
		expect(h.filters[0].createdFrom).toBe(local(2026, 9, 10));
		expect(h.filters[0].createdTo).toBeNull();
		expect(daysWith(h.bar, 'sift-cal__day--start')).toEqual(['10']);
		expect(daysWith(h.bar, 'sift-cal__day--end')).toEqual([]);

		clickDay(h.bar, 14);
		expect(h.filters.length).toBe(2);
		expect(h.filters[1].createdFrom).toBe(local(2026, 9, 10));
		expect(h.filters[1].createdTo).toBe(new Date(2026, 8, 14, 23, 59, 59, 999).getTime());
		expect(daysWith(h.bar, 'sift-cal__day--inside')).toEqual(['11', '12', '13']);
	});

	it('includes a note written at 23:59 on the closing day', () => {
		const h = mount();
		openDates(h);
		clickDay(h.bar, 10);
		clickDay(h.bar, 14);

		const bound = h.filters[1].createdTo ?? 0;
		const lateOnTheDay = new Date(2026, 8, 14, 23, 59, 0, 0).getTime();
		const justAfter = new Date(2026, 8, 15, 0, 0, 0, 0).getTime();
		// The Searcher rejects on `createdAt > createdTo`, so these two comparisons
		// are the filter itself.
		expect(lateOnTheDay > bound).toBe(false);
		expect(justAfter > bound).toBe(true);
	});

	it('keeps the range open when the second click lands on the day that started it', () => {
		const h = mount();
		openDates(h);

		clickDay(h.bar, 10);
		clickDay(h.bar, 10);

		// One emission, not two: the repeated click changes nothing, so the
		// searcher is not asked to run again either. On a touch screen that second
		// click is often the same tap arriving twice, and closing the range on it
		// used to turn "from the 10th on" into "the 10th only".
		expect(h.filters.length).toBe(1);
		expect(h.filters[0].createdFrom).toBe(local(2026, 9, 10));
		expect(h.filters[0].createdTo).toBeNull();
		expect(daysWith(h.bar, 'sift-cal__day--start')).toEqual(['10']);
		expect(daysWith(h.bar, 'sift-cal__day--end')).toEqual([]);

		// The start is still pending, so a later day still closes the range.
		clickDay(h.bar, 14);
		expect(h.filters.length).toBe(2);
		expect(h.filters[1].createdFrom).toBe(local(2026, 9, 10));
		expect(h.filters[1].createdTo).toBe(new Date(2026, 8, 14, 23, 59, 59, 999).getTime());
	});

	it('restarts the range when the second click lands before the start', () => {
		const h = mount();
		openDates(h);

		clickDay(h.bar, 10);
		clickDay(h.bar, 5);
		expect(h.filters[1].createdFrom).toBe(local(2026, 9, 5));
		expect(h.filters[1].createdTo).toBeNull();
		expect(daysWith(h.bar, 'sift-cal__day--start')).toEqual(['5']);

		clickDay(h.bar, 8);
		expect(h.filters[2].createdFrom).toBe(local(2026, 9, 5));
		expect(h.filters[2].createdTo).toBe(new Date(2026, 8, 8, 23, 59, 59, 999).getTime());
	});

	it('previews the range under the pointer once a start is set', () => {
		const h = mount();
		openDates(h);

		// Nothing to preview before the first click.
		day(h.bar, 12).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		expect(daysWith(h.bar, 'sift-cal__day--preview')).toEqual([]);

		clickDay(h.bar, 10);
		day(h.bar, 13).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		expect(daysWith(h.bar, 'sift-cal__day--inside')).toEqual(['11', '12']);
		expect(daysWith(h.bar, 'sift-cal__day--end')).toEqual(['13']);
		expect(daysWith(h.bar, 'sift-cal__day--preview')).toEqual(['11', '12', '13']);
		// Hovering is not deciding.
		expect(h.filters.length).toBe(1);

		// A pointer before the start previews nothing rather than a backwards range.
		day(h.bar, 4).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		expect(daysWith(h.bar, 'sift-cal__day--preview')).toEqual([]);
	});

	it('writes the same two fields the quick picks write', () => {
		const h = mount();
		openDates(h);
		clickDay(h.bar, 1);
		clickDay(h.bar, 7);
		const picked = h.filters[1];

		button(h.bar, '.sift-date-menu__item').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		const quick = h.filters[2];

		expect(Object.keys(picked).sort()).toEqual(Object.keys(quick).sort());
		expect(typeof picked.createdFrom).toBe(typeof quick.createdFrom);
		expect(picked.createdTo).toBe(endOfDay(local(2026, 9, 7)));
		expect(quick.createdTo).toBe(endOfDay(NOW));
	});

	it('clears both bounds from the calendar', () => {
		const h = mount(baseState({ filters: baseFilters({ createdFrom: local(2026, 9, 10) }) }));
		openDates(h);
		button(h.bar, '.sift-cal__clear').dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(h.filters[0].createdFrom).toBeNull();
		expect(h.filters[0].createdTo).toBeNull();
		expect(daysWith(h.bar, 'sift-cal__day--start')).toEqual([]);
	});
});

describe('calendar keyboard', () => {
	/** The day the roving tab stop currently sits on. */
	function cursor(h: Harness): string {
		const cells = Array.from(h.bar.el.querySelectorAll<HTMLElement>('.sift-cal__day'));
		return cells.find((cell) => cell.getAttribute('tabindex') === '0')?.textContent ?? '';
	}

	it('moves by day and by week, and wraps into the neighbouring month', () => {
		const h = mount();
		openDates(h);
		expect(cursor(h)).toBe('7');

		press(h, 'ArrowRight');
		expect(cursor(h)).toBe('8');
		press(h, 'ArrowDown');
		expect(cursor(h)).toBe('15');
		press(h, 'ArrowUp');
		expect(cursor(h)).toBe('8');

		// Backwards off the first of the month: the grid has to follow.
		press(h, 'ArrowLeft');
		press(h, 'ArrowLeft');
		press(h, 'ArrowLeft');
		press(h, 'ArrowLeft');
		press(h, 'ArrowLeft');
		press(h, 'ArrowLeft');
		press(h, 'ArrowLeft');
		press(h, 'ArrowLeft');
		expect(button(h.bar, '.sift-cal__month').textContent).toContain('August');
		expect(cursor(h)).toBe('31');

		// And forwards off the last one.
		press(h, 'ArrowRight');
		expect(button(h.bar, '.sift-cal__month').textContent).toContain('September');
		expect(cursor(h)).toBe('1');
	});

	it('moves by month with PageUp and PageDown, clamping a day the month does not have', () => {
		const h = mount(baseState({ filters: baseFilters({ createdFrom: local(2026, 8, 31) }) }));
		openDates(h);
		expect(cursor(h)).toBe('31');

		press(h, 'PageDown');
		expect(button(h.bar, '.sift-cal__month').textContent).toContain('September');
		expect(cursor(h)).toBe('30');

		press(h, 'PageUp');
		expect(button(h.bar, '.sift-cal__month').textContent).toContain('August');
		expect(cursor(h)).toBe('30');
	});

	it('picks the day under the cursor with Enter', () => {
		const h = mount();
		openDates(h);

		press(h, 'ArrowRight');
		press(h, 'Enter');
		expect(h.filters.length).toBe(1);
		expect(h.filters[0].createdFrom).toBe(local(2026, 9, 8));

		press(h, 'ArrowRight');
		press(h, 'Enter');
		expect(h.filters[1].createdTo).toBe(endOfDay(local(2026, 9, 9)));
	});

	it('leaves the filter untouched on Escape', () => {
		const h = mount();
		openDates(h);
		const wrap = button(h.bar, '.sift-filters__date');

		press(h, 'Escape');
		expect(wrap.hasClass('sift-filters__date--open')).toBe(false);
		expect(h.filters.length).toBe(0);
		expect(h.pushedScopes.length).toBe(0);
	});

	it('hands every key it does not own back to Obsidian', () => {
		const h = mount();
		openDates(h);
		const scope = h.pushedScopes[0] as {
			keys: Array<{ key: string | null; handler: (evt: KeyboardEvent) => unknown }>;
		};
		const catchAll = scope.keys.filter((entry) => entry.key === null);
		expect(catchAll.length).toBe(1);

		// A letter, a modifier combination and a key the calendar has no use for
		// all come back unhandled, so the global hotkeys keep working.
		for (const key of ['k', 'F5', 'Home']) {
			expect(catchAll[0].handler(new KeyboardEvent('keydown', { key }))).toBe(true);
		}
		expect(h.filters.length).toBe(0);
	});

	it('ignores the calendar keys while the popover is closed', () => {
		const h = mount();
		openDates(h);
		const scope = h.pushedScopes[0] as {
			keys: Array<{ key: string | null; handler: (evt: KeyboardEvent) => unknown }>;
		};
		const catchAll = scope.keys.filter((entry) => entry.key === null)[0];
		h.bar.destroy();

		expect(catchAll.handler(new KeyboardEvent('keydown', { key: 'ArrowRight' }))).toBe(true);
	});
});

describe('toggles', () => {
	it('fires exactly one callback each and does not mutate the state it was given', () => {
		const state = baseState();
		const h = mount(state);

		const subfolders = input(h.bar, '.sift-toggle--subfolders .sift-toggle__input');
		subfolders.checked = false;
		subfolders.dispatchEvent(new Event('change'));
		expect(h.filters.length).toBe(1);
		expect(h.filters[0].includeSubfolders).toBe(false);

		const similar = input(h.bar, '.sift-toggle--similar .sift-toggle__input');
		similar.checked = true;
		similar.dispatchEvent(new Event('change'));
		expect(h.fuzzies).toEqual([true]);
		expect(h.filters.length).toBe(1);

		// The object handed to the constructor is untouched.
		expect(state.filters.includeSubfolders).toBe(true);
		expect(state.fuzzy).toBe(false);
		expect(state.filters).not.toBe(h.filters[0]);
	});

	it('promotes the label of a switched-on toggle', () => {
		const h = mount(baseState({ fuzzy: true }));
		expect(button(h.bar, '.sift-toggle--similar').hasClass('sift-toggle--on')).toBe(true);
		expect(button(h.bar, '.sift-toggle--subfolders').hasClass('sift-toggle--on')).toBe(true);

		h.bar.setState(baseState({ fuzzy: false, filters: baseFilters({ includeSubfolders: false }) }));
		expect(button(h.bar, '.sift-toggle--similar').hasClass('sift-toggle--on')).toBe(false);
		expect(button(h.bar, '.sift-toggle--subfolders').hasClass('sift-toggle--on')).toBe(false);
	});
});

describe('sort', () => {
	it('offers every sort key and reports the chosen one', () => {
		const h = mount();
		const select = h.bar.el.querySelector('.sift-sort__select');
		if (!(select instanceof HTMLSelectElement)) throw new Error('no sort select');
		expect(select.options.length).toBe(7);
		expect(select.value).toBe('relevance');

		select.value = 'created-desc';
		select.dispatchEvent(new Event('change'));
		expect(h.sorts).toEqual(['created-desc']);
	});
});

describe('setState', () => {
	it('performs no DOM write when the same state is applied again', async () => {
		const h = mount(baseState({ filters: baseFilters({ folder: 'Projekte' }), fuzzy: true, sort: 'title-asc' }));
		const records: MutationRecord[] = [];
		const observer = new MutationObserver((list) => records.push(...list));
		observer.observe(h.bar.el, { subtree: true, childList: true, attributes: true, characterData: true });

		h.bar.setState(baseState({ filters: baseFilters({ folder: 'Projekte' }), fuzzy: true, sort: 'title-asc' }));
		h.bar.setSummary(null);
		await Promise.resolve();
		observer.disconnect();

		expect(records.length).toBe(0);
	});

	it('writes once when something actually changed', async () => {
		const h = mount();
		const records: MutationRecord[] = [];
		const observer = new MutationObserver((list) => records.push(...list));
		observer.observe(h.bar.el, { subtree: true, childList: true, attributes: true, characterData: true });

		h.bar.setState(baseState({ sort: 'path-asc' }));
		await Promise.resolve();
		observer.disconnect();

		expect(records.length).toBeGreaterThan(0);
		const select = h.bar.el.querySelector('.sift-sort__select');
		if (!(select instanceof HTMLSelectElement)) throw new Error('no sort select');
		expect(select.value).toBe('path-asc');
	});

	it('announces the summary in the live region without touching the visible bar', () => {
		const h = mount();
		h.bar.setSummary({ count: 12, durationMs: 38.4, truncated: false });
		expect(button(h.bar, '.sift-filters__status').textContent).toBe(t('search.count', { n: 12, ms: 38 }));

		h.bar.setSummary({ count: 1, durationMs: 2, truncated: false });
		expect(button(h.bar, '.sift-filters__status').textContent).toBe(t('search.countOne', { ms: 2 }));

		h.bar.setSummary(null);
		expect(button(h.bar, '.sift-filters__status').textContent).toBe('');
	});
});

describe('labels', () => {
	it('takes every label from the translation bundle', () => {
		const h = mount();
		expect(button(h.bar, '.sift-toggle--subfolders .sift-toggle__label').textContent).toBe(
			t('filter.includeSubfolders'),
		);
		expect(button(h.bar, '.sift-toggle--similar .sift-toggle__label').textContent).toBe(t('filter.similar'));
		expect(button(h.bar, '.sift-chip--date .sift-chip__label').textContent).toBe(t('filter.created'));
		expect(input(h.bar, '.sift-chip__input').getAttribute('placeholder')).toBe(t('filter.pathAll'));
	});

	it('renders the German bundle without falling back to a key', () => {
		setLanguage('de');
		const h = mount();
		expect(button(h.bar, '.sift-toggle--subfolders .sift-toggle__label').textContent).toBe(
			t('filter.includeSubfolders'),
		);
		expect(button(h.bar, '.sift-toggle--subfolders .sift-toggle__label').textContent).not.toBe(
			'filter.includeSubfolders',
		);
	});

	it('names the created range with the today placeholder when only a lower bound is set', () => {
		const h = mount(baseState({ filters: baseFilters({ createdFrom: Date.UTC(2026, 0, 1, 12) }) }));
		const label = button(h.bar, '.sift-chip--date .sift-chip__label').textContent ?? '';
		expect(label).toContain(t('filter.dateToday'));
		expect(label).toContain('2026');
		expect(button(h.bar, '.sift-chip--date').hasClass('sift-chip--active')).toBe(true);
	});
});
