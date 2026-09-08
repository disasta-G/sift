/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownView, Notice, TFile, installDomHelpers } from '../stubs/obsidian';
import type { App } from 'obsidian';
import { SearchModal, offsetToPosition } from '../../src/ui/SearchModal';
import type { SearchModalDeps } from '../../src/ui/SearchModal';
import { Ranker } from '../../src/search/Ranker';
import { setLanguage, t } from '../../src/i18n/index';
import type { OpenTarget, RawHit, SiftSettings } from '../../src/types';
import {
	TUNING,
	fakeIndexer,
	fakeSearcher,
	fakeSnippets,
	hit,
	realRanker,
	settings,
} from './factories';
import type { FakeSnippets } from './factories';

installDomHelpers();

const UI_FILES = ['SearchModal.ts', 'ResultCard.ts', 'FilterBar.ts'] as const;

function readRepoFile(relative: string): string {
	return readFileSync(join(process.cwd(), relative), 'utf8');
}

function readUiSource(name: string): string {
	return readRepoFile(join('src', 'ui', name));
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface FakeLeafRecord {
	target: boolean | string;
	opened: string[];
	view: MarkdownView;
}

interface Harness {
	app: App;
	leaves: FakeLeafRecord[];
	files: Map<string, string>;
	reads: string[];
}

function createApp(files: Record<string, string> = {}): Harness {
	const content = new Map<string, string>(Object.entries(files));
	const leaves: FakeLeafRecord[] = [];
	const reads: string[] = [];

	const app = {
		keymap: { pushScope: () => undefined, popScope: () => undefined },
		vault: {
			getAllFolders: () => [],
			getFileByPath: (path: string): TFile | null => (content.has(path) ? new TFile(path) : null),
			cachedRead: (file: TFile): Promise<string> => {
				reads.push(file.path);
				return Promise.resolve(content.get(file.path) ?? '');
			},
		},
		workspace: {
			getLeaf: (target: boolean | string) => {
				const view = new MarkdownView(null);
				const record: FakeLeafRecord = { target, opened: [], view };
				leaves.push(record);
				return {
					view,
					openFile: (file: TFile): Promise<void> => {
						record.opened.push(file.path);
						view.editor.setValue(content.get(file.path) ?? '');
						return Promise.resolve();
					},
				};
			},
		},
	} as unknown as App;

	return { app, leaves, files: content, reads };
}

interface ModalHarness extends Harness {
	modal: SearchModal;
	searcher: ReturnType<typeof fakeSearcher>;
	snippets: FakeSnippets;
	indexer: ReturnType<typeof fakeIndexer>;
	/** What `Indexer.lastError()` answers: the error name of a build that threw, or `null`. */
	setFailure(reason: string | null): void;
	input(): HTMLInputElement;
	results(): HTMLElement;
	cards(): HTMLElement[];
	titles(): string[];
	count(): string;
}

function open(options: {
	hits?: RawHit[];
	ready?: boolean;
	/** Error name of a build that threw. `Indexer.isReady()` stays true either way — that is the whole problem. */
	failure?: string | null;
	autoSnippets?: boolean;
	settings?: Partial<SiftSettings>;
	files?: Record<string, string>;
	query?: string;
} = {}): ModalHarness {
	const base = createApp(options.files);
	const searcher = fakeSearcher(options.hits ?? []);
	const snippets = fakeSnippets(options.autoSnippets ?? true);
	const indexer = fakeIndexer(options.ready ?? true);
	let failure: string | null = options.failure ?? null;
	(indexer.indexer as unknown as { lastError(): string | null }).lastError = (): string | null => failure;
	const deps: SearchModalDeps = {
		indexer: indexer.indexer,
		searcher: searcher.searcher,
		ranker: realRanker(),
		snippets: snippets.snippets,
		settings: settings(options.settings),
		tuning: TUNING,
	};
	const modal = new SearchModal(base.app, deps, options.query);
	modal.open();

	const harness: ModalHarness = {
		...base,
		modal,
		searcher,
		snippets,
		indexer,
		setFailure: (reason: string | null) => {
			failure = reason;
		},
		input: () => {
			const el = modal.contentEl.querySelector('.sift-input');
			if (!(el instanceof HTMLInputElement)) throw new Error('no search input');
			return el;
		},
		results: () => {
			const el = modal.contentEl.querySelector('.sift-results');
			if (!(el instanceof HTMLElement)) throw new Error('no results container');
			return el;
		},
		cards: () => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.sift-card')),
		titles: () =>
			Array.from(modal.contentEl.querySelectorAll('.sift-card__title')).map((el) => el.textContent ?? ''),
		count: () => modal.contentEl.querySelector('.sift-count')?.textContent ?? '',
	};
	return harness;
}

/** RawHits with distinguishable titles, so a stale render is visible in the DOM. */
function hits(count: number, prefix = 'Note'): RawHit[] {
	return Array.from({ length: count }, (_unused, index) =>
		hit(index, { title: `${prefix} ${index}`, path: `Projekte/${prefix} ${index}.md` }),
	);
}

/**
 * Drains the microtask queue.
 *
 * Snippets are built one small batch at a time and each batch costs a couple of
 * microtask turns, so a test that wants the whole window filled has to let the
 * queue run out instead of awaiting the search alone.
 */
async function settle(turns = 120): Promise<void> {
	for (let at = 0; at < turns; at++) await Promise.resolve();
}

interface ScopeEntry {
	modifiers: string[] | null;
	key: string | null;
	handler(evt: KeyboardEvent): unknown;
}

/** The unmodified binding for `key` on the modal's scope. */
function scopeHandler(h: ModalHarness, key: string): ScopeEntry {
	const keys = (h.modal.scope as unknown as { keys: ScopeEntry[] }).keys;
	const found = keys.find((entry) => entry.key === key && (entry.modifiers ?? []).length === 0);
	if (found === undefined) throw new Error(`no scope binding for ${key}`);
	return found;
}

beforeEach(() => {
	setLanguage('en');
	document.body.empty();
	Notice.reset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* 1. Source-level policy scan                                                */
/* -------------------------------------------------------------------------- */

describe('store policy, checked against the source', () => {
	it('never touches innerHTML, outerHTML or insertAdjacentHTML', () => {
		for (const name of UI_FILES) {
			expect(readUiSource(name), name).not.toMatch(/\.(inner|outer)HTML|insertAdjacentHTML|document\.write/);
		}
	});

	it('never reads a bare global app', () => {
		for (const name of UI_FILES) {
			const source = readUiSource(name);
			const hitsFound = source.match(/(^|[^\w.$])app\s*\./gm) ?? [];
			expect(hitsFound, name).toEqual([]);
			expect(source, name).not.toMatch(/window\.app|globalThis\.app/);
		}
	});

	it('attaches no listener outside registerDomEvent', () => {
		for (const name of UI_FILES) {
			expect(readUiSource(name), name).not.toMatch(/addEventListener\s*\(/);
			expect(readUiSource(name), name).not.toMatch(/setInterval\s*\(/);
		}
	});

	it('makes no network call and logs nothing', () => {
		for (const name of UI_FILES) {
			const source = readUiSource(name);
			expect(source, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|requestUrl|sendBeacon/);
			expect(source, name).not.toMatch(/console\.log|console\.debug/);
			expect(source, name).not.toMatch(/\beval\s*\(|new Function\s*\(/);
		}
	});

	it('carries no v1.1 vocabulary', () => {
		const forbidden = /\b(licen[cs]e|subscription|pricing|paywall|upsell|premium|polar|openai|anthropic|mistral)\b/i;
		for (const name of UI_FILES) {
			expect(readUiSource(name), name).not.toMatch(forbidden);
		}
		const css = readRepoFile('styles.css');
		expect(css).not.toMatch(/\.sift-(ai|term|upsell|quota)\b/);
	});
});

/* -------------------------------------------------------------------------- */
/* 2. Debounce and cancellation                                               */
/* -------------------------------------------------------------------------- */

describe('debounce and cancellation', () => {
	it('runs exactly one search for three keystrokes 40 ms apart', async () => {
		vi.useFakeTimers();
		const h = open({ hits: hits(2) });
		expect(h.searcher.calls.length).toBe(0);

		for (const value of ['ka', 'kaf', 'kaff']) {
			h.input().value = value;
			h.input().dispatchEvent(new Event('input'));
			await vi.advanceTimersByTimeAsync(40);
		}
		expect(h.searcher.calls.length).toBe(0);

		await vi.advanceTimersByTimeAsync(120);
		expect(h.searcher.calls.length).toBe(1);
		expect(h.searcher.calls[0].ast.raw).toBe('kaff');
	});

	it('aborts the in-flight search when a newer one starts', async () => {
		const h = open({ hits: hits(1) });
		h.modal.setQuery('erste');
		await h.modal.runSearch(true);
		const first = h.searcher.calls[0].options.signal;
		expect(first?.aborted).toBe(false);

		h.modal.setQuery('zweite');
		await h.modal.runSearch(true);
		expect(first?.aborted).toBe(true);
	});

	it('never lets a late snippet result overwrite a newer render', async () => {
		const h = open({ hits: hits(2, 'Alt'), autoSnippets: false });
		h.modal.setQuery('alt');
		await h.modal.runSearch(true);
		expect(h.titles()).toEqual(['Alt 0', 'Alt 1']);
		expect(h.snippets.pending.length).toBe(1);
		const stale = h.snippets.pending[0];

		h.searcher.results = hits(2, 'Neu');
		h.modal.setQuery('neu');
		await h.modal.runSearch(true);
		expect(h.titles()).toEqual(['Neu 0', 'Neu 1']);

		// The first search's snippets arrive last; the newer render must survive.
		stale.resolve(
			stale.hits.map((source) => ({
				...source,
				similarTo: [],
				snippets: [
					{
						text: 'VERALTET',
						offset: 0,
						marks: [],
						focus: { start: 0, end: 8 },
						leadingEllipsis: false,
						trailingEllipsis: false,
						jumpOffset: 0,
					},
				],
			})),
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(h.titles()).toEqual(['Neu 0', 'Neu 1']);
		expect(h.modal.contentEl.textContent).not.toContain('VERALTET');
	});
});

/* -------------------------------------------------------------------------- */
/* 3. Selection and keyboard                                                  */
/* -------------------------------------------------------------------------- */

describe('selection', () => {
	it('clamps at both ends and keeps aria-activedescendant in step', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		expect(h.cards()[0].hasClass('sift-card--selected')).toBe(true);
		expect(h.input().getAttribute('aria-activedescendant')).toBe('sift-result-0');

		h.modal.moveSelection(-1);
		expect(h.cards()[0].hasClass('sift-card--selected')).toBe(true);

		h.modal.moveSelection(1);
		expect(h.cards()[1].hasClass('sift-card--selected')).toBe(true);
		expect(h.cards()[0].hasClass('sift-card--selected')).toBe(false);
		expect(h.input().getAttribute('aria-activedescendant')).toBe('sift-result-1');

		h.modal.moveSelection(50);
		expect(h.cards()[2].hasClass('sift-card--selected')).toBe(true);
		h.modal.moveSelection(1);
		expect(h.cards()[2].hasClass('sift-card--selected')).toBe(true);
	});

	it('survives moveSelection with no results', () => {
		const h = open();
		expect(() => h.modal.moveSelection(1)).not.toThrow();
		expect(h.input().getAttribute('aria-activedescendant')).toBeNull();
	});

	it('binds the plan keyboard map on the modal scope, and no default hotkey elsewhere', () => {
		const h = open();
		const keys = (h.modal.scope as unknown as {
			keys: Array<{ modifiers: string[] | null; key: string | null }>;
		}).keys;
		const bound = keys.map((entry) => `${(entry.modifiers ?? []).join('+')}|${entry.key ?? ''}`);
		expect(bound).toContain('|ArrowDown');
		expect(bound).toContain('|ArrowUp');
		expect(bound).toContain('|Enter');
		expect(bound).toContain('Mod|Enter');
		// Escape is Obsidian's own binding; the modal must not shadow it.
		expect(bound.some((entry) => entry.endsWith('|Escape'))).toBe(false);
	});

	it('moves the selection through the registered arrow handlers', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		const keys = (h.modal.scope as unknown as {
			keys: Array<{ modifiers: string[] | null; key: string | null; handler: (evt: KeyboardEvent) => unknown }>;
		}).keys;
		const down = keys.find((entry) => entry.key === 'ArrowDown');
		down?.handler(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		expect(h.cards()[1].hasClass('sift-card--selected')).toBe(true);
	});

	it('hands focus to the filter bar on Tab', () => {
		const h = open();
		h.input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		const active = h.modal.contentEl.ownerDocument.activeElement;
		expect(active?.classList.contains('sift-chip__input')).toBe(true);
	});

	it('leaves the filter bar its own keys while a control there has the focus', async () => {
		const h = open({ hits: hits(3), files: { 'Projekte/Note 0.md': 'Kaffee' } });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		const select = h.modal.contentEl.querySelector('.sift-sort__select');
		if (!(select instanceof HTMLSelectElement)) throw new Error('no sort select');
		select.focus();

		// A Scope handler fires for EVERY keydown in the modal, so it has to step
		// aside itself: with the sort dropdown focused, ArrowDown belongs to the
		// dropdown, not to the result list.
		const down = scopeHandler(h, 'ArrowDown');
		const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
		expect(down.handler(arrow)).toBe(true);
		expect(arrow.defaultPrevented).toBe(false);
		expect(h.cards()[0].hasClass('sift-card--selected')).toBe(true);
		expect(h.cards()[1].hasClass('sift-card--selected')).toBe(false);

		// Same for Enter, which the folder box and the date quick picks need.
		const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
		expect(scopeHandler(h, 'Enter').handler(enter)).toBe(true);
		expect(enter.defaultPrevented).toBe(false);
		await settle();
		expect(h.leaves.length).toBe(0);

		// With the search field focused the same handlers do their job.
		h.input().focus();
		const again = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
		expect(down.handler(again)).toBe(false);
		expect(h.cards()[1].hasClass('sift-card--selected')).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* 4. Empty states                                                            */
/* -------------------------------------------------------------------------- */

describe('empty states', () => {
	it('shows the initial state before anything is typed', () => {
		const h = open();
		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('empty.initial.title'));
		expect(h.count()).toBe('');
	});

	it('shows the indexing state while the index is still building', async () => {
		const h = open({ ready: false });
		h.modal.setQuery('kaffee');
		await h.modal.runSearch(true);
		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('empty.indexing.title'));
		expect(h.searcher.calls.length).toBe(0);
	});

	it('shows the no-results state and names the query', async () => {
		const h = open({ hits: [] });
		h.modal.setQuery('kaffee');
		await h.modal.runSearch(true);
		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('empty.no-results.title'));
		expect(h.modal.contentEl.querySelector('.sift-empty__body')?.textContent).toContain('kaffee');
		expect(h.count()).toBe(t('search.countNone', { ms: 0 }));
	});

	it('shows the query-error state with the parser message', async () => {
		const h = open({ hits: [] });
		h.modal.setQuery('"unclosed');
		await h.modal.runSearch(true);
		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('empty.query-error.title'));
		expect(h.modal.contentEl.querySelector('.sift-empty__error')?.textContent).toBe(t('error.unclosed-quote'));
	});

	it('renders every empty-state kind through renderEmptyState', () => {
		const h = open();
		for (const kind of ['initial', 'indexing', 'no-results', 'query-error', 'index-error'] as const) {
			h.modal.renderEmptyState(kind);
			const title = h.modal.contentEl.querySelector('.sift-empty__title')?.textContent ?? '';
			expect(title.length).toBeGreaterThan(0);
			expect(title).not.toContain('empty.');
		}
	});

	/* ---------------------------------------------------------------------- */
	/* A build that threw                                                     */
	/* ---------------------------------------------------------------------- */

	// `Indexer.build()` catches everything and still reports ready, so the modal
	// went straight past its 'indexing' gate and answered every query with "No
	// note contains kaffee" — a claim about a vault that was never read.
	it('says the index could not be built instead of claiming the vault has no match', async () => {
		const h = open({ hits: [], failure: 'RangeError' });
		h.modal.setQuery('kaffee');
		await h.modal.runSearch(true);

		const title = h.modal.contentEl.querySelector('.sift-empty__title')?.textContent ?? '';
		expect(title).toBe(t('empty.index-error.title'));
		expect(title).not.toBe(t('empty.no-results.title'));
		expect(h.modal.contentEl.querySelector('.sift-empty__body')?.textContent).toBe(t('empty.index-error.body'));
		expect(h.modal.contentEl.querySelector('.sift-empty__hint')?.textContent).toBe(t('empty.index-error.hint'));
	});

	it('names the reported error, so a broken index is not just a mood', async () => {
		const h = open({ hits: [], failure: 'QuotaExceededError' });
		h.modal.setQuery('kaffee');
		await h.modal.runSearch(true);

		expect(h.modal.contentEl.querySelector('.sift-empty__error')?.textContent)
			.toBe(t('index.failureReason', { reason: 'QuotaExceededError' }));
	});

	it('keeps the no-results state for a healthy index', async () => {
		const h = open({ hits: [], failure: null });
		h.modal.setQuery('kaffee');
		await h.modal.runSearch(true);

		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('empty.no-results.title'));
		expect(h.modal.contentEl.querySelector('.sift-empty__error')).toBeNull();
	});

	it('still shows what a partial index can answer', async () => {
		// The build died halfway, so some notes are indexed and some are not. The
		// hits that exist are real and are worth showing; only the "nothing found"
		// claim is the one the index cannot back.
		const h = open({ hits: hits(3), failure: 'RangeError' });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		expect(h.cards().length).toBe(3);
		expect(h.modal.contentEl.querySelector('.sift-empty__title')).toBeNull();
	});

	it('reports a query error before the index failure, because that one is the user\'s to fix', async () => {
		const h = open({ hits: [], failure: 'RangeError' });
		h.modal.setQuery('"unclosed');
		await h.modal.runSearch(true);

		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('empty.query-error.title'));
	});
});

/* -------------------------------------------------------------------------- */
/* 5. Results, counter and virtualization                                     */
/* -------------------------------------------------------------------------- */

describe('result rendering', () => {
	it('renders a card per hit with the counter line', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		expect(h.cards().length).toBe(3);
		expect(h.count()).toMatch(/3 results/);
		expect(h.results().getAttribute('role')).toBe('listbox');
		expect(h.cards()[0].getAttribute('role')).toBe('option');
	});

	it('fills the snippets of the rendered cards', async () => {
		const h = open({ hits: hits(2) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(h.modal.contentEl.querySelectorAll('.sift-card__snippet').length).toBe(2);
	});

	it('keeps a bounded number of cards for 5000 hits and only asks for visible snippets', async () => {
		const h = open({ hits: hits(5000), settings: { maxResults: 5000 } });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		await settle();

		const rendered = h.cards().length;
		expect(rendered).toBeGreaterThan(0);
		expect(rendered).toBeLessThan(60);

		const firstBatch = h.snippets.log.flat().map((source) => source.title);
		expect(firstBatch.length).toBe(rendered);
		expect(firstBatch).toContain('Note 0');
		expect(firstBatch).not.toContain('Note 100');

		h.snippets.log.length = 0;
		h.results().scrollTop = 142 * 100;
		h.results().dispatchEvent(new Event('scroll'));
		await settle();

		const secondBatch = h.snippets.log.flat().map((source) => source.title);
		expect(secondBatch.length).toBeGreaterThan(0);
		expect(secondBatch).not.toContain('Note 0');
		expect(secondBatch.some((title) => title.startsWith('Note 1'))).toBe(true);
		expect(h.cards().length).toBeLessThan(60);
	});

	it('virtualizes at the DEFAULT settings, where maxResults is the 200 the list is capped to', async () => {
		// The window has to follow the viewport, not the cap: with both at 200 the
		// virtualized branch was unreachable for every default install, so 200 cards
		// and 200 file reads went into a viewport that shows four of them.
		const h = open({ hits: hits(400) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		await settle();

		expect(h.modal.contentEl.querySelectorAll('.sift-card').length).toBe(h.cards().length);
		expect(h.cards().length).toBeLessThan(60);
		expect(h.snippets.log.flat().length).toBe(h.cards().length);
		expect(h.count()).toMatch(/200 of 400 results/);
	});

	it('renders every card when the whole result list fits inside the window', async () => {
		const h = open({ hits: hits(12) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(h.cards().length).toBe(12);
	});

	it('fills the first cards before the last file of the window has been read', async () => {
		const h = open({ hits: hits(400), autoSnippets: false });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		// One batch is in flight, not the whole window: the cards it covers can
		// paint while the remaining rows are still being read.
		expect(h.snippets.log.length).toBe(1);
		const batch = h.snippets.log[0];
		expect(batch.length).toBeLessThan(h.cards().length);

		h.snippets.flush('ERSTE CHARGE');
		await settle();

		const filled = h.modal.contentEl.querySelectorAll('.sift-card__snippet').length;
		expect(filled).toBeGreaterThanOrEqual(batch.length);
		expect(h.modal.contentEl.textContent).toContain('ERSTE CHARGE');
	});

	it('cancels the snippet work of a window the list has scrolled away from', async () => {
		const h = open({ hits: hits(1000), settings: { maxResults: 1000 }, autoSnippets: false });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		expect(h.snippets.log.length).toBe(1);
		const first = h.snippets.signals[0];
		expect(first).toBeInstanceOf(AbortSignal);
		expect(first?.aborted).toBe(false);
		const firstRows = h.snippets.log[0].map((source) => source.title);

		h.results().scrollTop = 142 * 100;
		h.results().dispatchEvent(new Event('scroll'));

		// The reads of the window the user left are cancelled the moment the new
		// window asks for its own, instead of queueing ahead of it.
		expect(first?.aborted).toBe(true);
		const second = h.snippets.signals[1];
		expect(second).not.toBe(first);
		expect(second?.aborted).toBe(false);
		expect(h.snippets.log[1].map((source) => source.title)).not.toEqual(firstRows);

		// Rows whose batch never started are not left claimed: scrolling back asks
		// for them again, while the batch still in flight is not asked for twice.
		h.snippets.log.length = 0;
		h.results().scrollTop = 0;
		h.results().dispatchEvent(new Event('scroll'));
		await settle();

		const retried = h.snippets.log.flat().map((source) => source.title);
		expect(retried.length).toBeGreaterThan(0);
		expect(retried[0]).toBe(`Note ${firstRows.length}`);
		for (const title of firstRows) expect(retried).not.toContain(title);
	});

	it('reports truncation when more hits exist than maxResults allows', async () => {
		const h = open({ hits: hits(40), settings: { maxResults: 10 } });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(h.cards().length).toBe(10);
		expect(h.count()).toMatch(/10 of 40 results|10 results/);
	});
});

/* -------------------------------------------------------------------------- */
/* 5b. Sorting                                                                */
/* -------------------------------------------------------------------------- */

describe('sorting', () => {
	it('sorts the result set once', async () => {
		// `Ranker.rank` returns its hits already sorted by relevance (that is the
		// one call below), so the modal's own pass over the same comparator was a
		// second full walk of the result set — with a collated path compare on
		// every score tie, which is where the 12-23 ms went.
		const sort = vi.spyOn(Ranker, 'sort');
		const h = open({ hits: hits(50) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		expect(sort.mock.calls.map((call) => call[1])).toEqual(['relevance']);
		expect(h.titles().slice(0, 3)).toEqual(['Note 0', 'Note 1', 'Note 2']);
	});

	it('still sorts when the dropdown asks for another order', async () => {
		const sort = vi.spyOn(Ranker, 'sort');
		const h = open({ hits: hits(3), settings: { defaultSort: 'title-asc' } });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		expect(sort.mock.calls.map((call) => call[1])).toEqual(['relevance', 'title-asc']);
		expect(h.titles()).toEqual(['Note 0', 'Note 1', 'Note 2']);
	});
});

/* -------------------------------------------------------------------------- */
/* 6. Opening a hit                                                           */
/* -------------------------------------------------------------------------- */

describe('openFileAtOffset', () => {
	it('converts an offset in a CRLF file to the right line and column', async () => {
		const text = 'line one\r\nline two\r\nKaffee here';
		const h = createApp({ 'Notes/crlf.md': text });
		await SearchModal.openFileAtOffset(h.app, {
			path: 'Notes/crlf.md',
			target: 'current',
			offset: text.indexOf('Kaffee'),
			length: 6,
		});

		const leaf = h.leaves[0];
		expect(leaf.target).toBe(false);
		expect(leaf.opened).toEqual(['Notes/crlf.md']);
		expect(leaf.view.editor.lastCursor).toEqual({ line: 2, ch: 0 });
		expect(leaf.view.editor.scrolledTo.length).toBe(1);
	});

	it('counts a surrogate pair as two code units, like the editor does', async () => {
		const text = '😀😀 Kaffee\nzweite Zeile';
		const h = createApp({ 'Notes/emoji.md': text });
		await SearchModal.openFileAtOffset(h.app, {
			path: 'Notes/emoji.md',
			target: 'current',
			offset: text.indexOf('Kaffee'),
			length: 6,
		});
		expect(h.leaves[0].view.editor.lastCursor).toEqual({ line: 0, ch: 5 });
	});

	it('maps the open target onto the workspace argument', async () => {
		const cases: Array<[OpenTarget, boolean | string]> = [
			['current', false],
			['new-tab', 'tab'],
			['split', 'split'],
		];
		for (const [target, expected] of cases) {
			const h = createApp({ 'a.md': 'Kaffee' });
			await SearchModal.openFileAtOffset(h.app, { path: 'a.md', target, offset: 0, length: 6 });
			expect(h.leaves[0].target).toBe(expected);
		}
	});

	it('reports a vanished file instead of throwing', async () => {
		const h = createApp({});
		await SearchModal.openFileAtOffset(h.app, { path: 'weg.md', target: 'current', offset: 0, length: 3 });
		expect(h.leaves.length).toBe(0);
		expect(Notice.messages).toEqual([t('error.fileMissing')]);
	});

	it('opens the selected hit at its snippet jump offset', async () => {
		const text = 'Zeile eins\nDie Kaffeemaschine steht hier.';
		const jump = text.indexOf('Kaffeemaschine');
		const h = open({
			hits: [hit(0, { path: 'Notes/kaffee.md', title: 'Kaffee' })],
			files: { 'Notes/kaffee.md': text },
			autoSnippets: false,
		});
		h.modal.setQuery('kaffee');
		await h.modal.runSearch(true);
		h.snippets.pending[0].resolve([
			{
				...h.searcher.results[0],
				score: 1,
				relevance: 100,
				similarTo: [],
				snippets: [
					{
						text: text.slice(11),
						offset: 11,
						marks: [{ start: 4, end: 18 }],
						focus: { start: 0, end: 30 },
						leadingEllipsis: false,
						trailingEllipsis: false,
						jumpOffset: jump,
					},
				],
			},
		]);
		await Promise.resolve();
		await Promise.resolve();

		await h.modal.openSelected({ target: 'new-tab' });
		expect(h.leaves[0].target).toBe('tab');
		expect(h.leaves[0].view.editor.lastCursor).toEqual({ line: 1, ch: 4 });
	});

	it('converts offsets without an editor round trip', () => {
		expect(offsetToPosition('abc\ndef', 5)).toEqual({ line: 1, ch: 1 });
		expect(offsetToPosition('abc\r\ndef', 5)).toEqual({ line: 1, ch: 0 });
		expect(offsetToPosition('abc\rdef', 5)).toEqual({ line: 1, ch: 1 });
		expect(offsetToPosition('abc', 900)).toEqual({ line: 0, ch: 3 });
		expect(offsetToPosition('abc', -5)).toEqual({ line: 0, ch: 0 });
		// An offset inside a surrogate pair steps back to the pair's start.
		expect(offsetToPosition('😀x', 1)).toEqual({ line: 0, ch: 0 });
	});
});

/* -------------------------------------------------------------------------- */
/* 7. Lifecycle                                                               */
/* -------------------------------------------------------------------------- */

describe('filter bar folding', () => {
	/**
	 * The fold itself is a media query, so what is testable here is the state the
	 * stylesheet acts on: the class on the bar, the button's expanded state, and
	 * the dot that says a folded-away filter is narrowing the run.
	 */
	function toggle(h: ModalHarness): HTMLButtonElement {
		const el = h.modal.contentEl.querySelector('.sift-filter-toggle');
		if (!(el instanceof HTMLButtonElement)) throw new Error('no filter toggle');
		return el;
	}

	function bar(h: ModalHarness): HTMLElement {
		const el = h.modal.contentEl.querySelector('.sift-filters');
		if (!(el instanceof HTMLElement)) throw new Error('no filter bar');
		return el;
	}

	it('starts folded, unfolds on the button and points at the bar it controls', () => {
		const h = open();

		expect(bar(h).hasClass('sift-filters--collapsed')).toBe(true);
		expect(toggle(h).getAttribute('aria-expanded')).toBe('false');
		expect(toggle(h).getAttribute('aria-label')).toBe(t('filter.show'));
		expect(toggle(h).getAttribute('aria-controls')).toBe(bar(h).id);
		expect(bar(h).id.length).toBeGreaterThan(0);

		toggle(h).dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(bar(h).hasClass('sift-filters--collapsed')).toBe(false);
		expect(toggle(h).getAttribute('aria-expanded')).toBe('true');
		expect(toggle(h).getAttribute('aria-label')).toBe(t('filter.hide'));

		toggle(h).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(bar(h).hasClass('sift-filters--collapsed')).toBe(true);
	});

	it('marks the button while a filter narrows the run, against the user own defaults', () => {
		const h = open();
		expect(toggle(h).hasClass('sift-filter-toggle--active')).toBe(false);

		const folder = h.modal.contentEl.querySelector('.sift-chip__input');
		if (!(folder instanceof HTMLInputElement)) throw new Error('no folder box');
		folder.value = 'Projekte';
		folder.dispatchEvent(new Event('change'));

		expect(toggle(h).hasClass('sift-filter-toggle--active')).toBe(true);
	});

	it('reads a vault that always sorts by date as unfiltered', () => {
		// The dot compares against the settings, not against the plugin defaults:
		// otherwise a user who set their own default sort would see it lit on every
		// search and it would stop meaning anything.
		const h = open({ settings: { defaultSort: 'modified-desc' } });
		expect(toggle(h).hasClass('sift-filter-toggle--active')).toBe(false);
	});
});

describe('lifecycle', () => {
	it('leaves nothing behind after ten open/close cycles', async () => {
		const base = createApp();
		const searcher = fakeSearcher(hits(3));
		const snippets = fakeSnippets(true);
		const deps: SearchModalDeps = {
			indexer: fakeIndexer(true).indexer,
			searcher: searcher.searcher,
			ranker: realRanker(),
			snippets: snippets.snippets,
			settings: settings(),
			tuning: TUNING,
		};

		const orphans: HTMLInputElement[] = [];
		for (let cycle = 0; cycle < 10; cycle++) {
			const modal = new SearchModal(base.app, deps, 'note');
			modal.open();
			await Promise.resolve();
			await Promise.resolve();
			const el = modal.contentEl.querySelector('.sift-input');
			if (el instanceof HTMLInputElement) orphans.push(el);
			modal.close();
			expect(modal.contentEl.childElementCount).toBe(0);
			expect(modal.modalEl.hasClass('sift-modal')).toBe(false);
		}

		expect(document.body.querySelectorAll('.sift-card').length).toBe(0);

		// A listener that survived onClose would run a search on the orphaned input.
		const before = searcher.calls.length;
		for (const orphan of orphans) {
			orphan.value = 'zombie';
			orphan.dispatchEvent(new Event('input'));
		}
		expect(searcher.calls.length).toBe(before);
	});

	it('stops the debounce timer when the modal closes', async () => {
		vi.useFakeTimers();
		const h = open({ hits: hits(1) });
		h.input().value = 'kaffee';
		h.input().dispatchEvent(new Event('input'));
		h.modal.close();

		await vi.advanceTimersByTimeAsync(1000);
		expect(h.searcher.calls.length).toBe(0);
	});

	it('runs a full open-type-navigate-open-close cycle without a console error', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const h = open({
			hits: hits(3),
			files: { 'Projekte/Note 0.md': 'Kaffee hier', 'Projekte/Note 1.md': 'Kaffee dort' },
		});
		h.input().value = 'note';
		h.input().dispatchEvent(new Event('input'));
		await h.modal.runSearch(true);
		h.modal.moveSelection(1);
		await h.modal.openSelected({ target: 'current' });
		h.modal.close();

		expect(error).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});
