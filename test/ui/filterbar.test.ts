/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from 'vitest';
import { TFolder, installDomHelpers } from '../stubs/obsidian';
import type { App } from 'obsidian';
import { FilterBar, quickPickFrom } from '../../src/ui/FilterBar';
import { setLanguage, t } from '../../src/i18n/index';
import type { FilterBarCallbacks, FilterBarState, SearchFilters, SortKey } from '../../src/types';

installDomHelpers();

const DAY = 86_400_000;
/** A fixed clock, so a quick pick is a plain subtraction and not "roughly now". */
const NOW = Date.UTC(2026, 8, 7, 10, 0, 0);

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
		excludedFolders: [],
		...overrides,
	};
}

function baseState(overrides: Partial<FilterBarState> = {}): FilterBarState {
	return { filters: baseFilters(), sort: 'relevance', fuzzy: false, summary: null, ...overrides };
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
	};

	const bar = new FilterBar(app, host, state, callbacks, () => NOW);
	return { bar, host, state, filters, sorts, fuzzies, folderCalls: () => folderCalls, pushedScopes: scopes };
}

/** Every handler the bar registered for `key` on the scope it pushes while the menu is open. */
function menuHandlers(h: Harness, key: string): Array<(evt: KeyboardEvent) => unknown> {
	const scope = h.pushedScopes[0] as { keys?: Array<{ key: string | null; handler: (evt: KeyboardEvent) => unknown }> };
	return (scope?.keys ?? []).filter((entry) => entry.key === key).map((entry) => entry.handler);
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

describe('quick picks', () => {
	it('computes the lower bound against the injected clock', () => {
		expect(quickPickFrom('week', NOW)).toBe(NOW - 7 * DAY);
		expect(quickPickFrom('month', NOW)).toBe(NOW - 30 * DAY);
		expect(quickPickFrom('year', NOW)).toBe(NOW - 365 * DAY);
		expect(quickPickFrom('any', NOW)).toBeNull();
	});

	it('applies each quick pick and clears both bounds from the chip remove button', () => {
		const h = mount();
		const items = h.bar.el.querySelectorAll('.sift-date-menu__item');
		expect(items.length).toBe(4);

		items[0].dispatchEvent(new MouseEvent('click'));
		expect(h.filters[0].createdFrom).toBe(NOW - 7 * DAY);
		expect(h.filters[0].createdTo).toBeNull();

		items[1].dispatchEvent(new MouseEvent('click'));
		expect(h.filters[1].createdFrom).toBe(NOW - 30 * DAY);

		items[2].dispatchEvent(new MouseEvent('click'));
		expect(h.filters[2].createdFrom).toBe(NOW - 365 * DAY);

		button(h.bar, '.sift-chip__remove--date').dispatchEvent(new MouseEvent('click'));
		expect(h.filters[3].createdFrom).toBeNull();
		expect(h.filters[3].createdTo).toBeNull();
	});

	it('opens and closes the quick-pick menu without losing filter values', () => {
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

	it('closes the open menu on a click outside it', () => {
		const h = mount();
		const wrap = button(h.bar, '.sift-filters__date');
		const outside = document.body.createDiv();

		button(h.bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(wrap.hasClass('sift-filters__date--open')).toBe(true);

		// A click inside the menu is not "outside": the quick pick has to survive
		// long enough to run its own handler.
		button(h.bar, '.sift-date-menu__item').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(h.filters.length).toBe(1);
		expect(wrap.hasClass('sift-filters__date--open')).toBe(false);

		button(h.bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
