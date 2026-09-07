/** @vitest-environment happy-dom */

/**
 * Curating one search run, and searching with filters but no term.
 *
 * Both are properties of the modal's own state machine, so they are driven
 * through the public surface — `runSearch`, the card buttons, the scope
 * bindings, the footer controls — and asserted against the rendered DOM.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Notice, TFile, installDomHelpers } from '../stubs/obsidian';
import type { App } from 'obsidian';
import { SearchModal } from '../../src/ui/SearchModal';
import type { SearchModalDeps } from '../../src/ui/SearchModal';
import { Ranker } from '../../src/search/Ranker';
import { setLanguage, t } from '../../src/i18n/index';
import type { RankedHit, RawHit, ResultItem, SiftSettings } from '../../src/types';
import type { Snippets } from '../../src/search/Snippets';
import { TUNING, fakeIndexer, fakeSearcher, hit, realRanker, settings, snippet } from './factories';

/**
 * A snippet builder that honours the contract a filter-only run relies on: an
 * excerpt is cut AROUND a match, so a hit that carries none gets none back.
 */
function matchBoundSnippets(): Snippets {
	return {
		build: (built: readonly RankedHit[]): Promise<ResultItem[]> =>
			Promise.resolve(
				built.map((source) => ({
					...source,
					similarTo: [],
					snippets: source.matches.length === 0 ? [] : [snippet()],
				})),
			),
	} as unknown as Snippets;
}

installDomHelpers();

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface LeafRecord {
	target: boolean | string;
	opened: string[];
}

interface Harness {
	modal: SearchModal;
	searcher: ReturnType<typeof fakeSearcher>;
	leaves: LeafRecord[];
	input(): HTMLInputElement;
	folderInput(): HTMLInputElement;
	sortSelect(): HTMLSelectElement;
	results(): HTMLElement;
	cards(): HTMLElement[];
	titles(): string[];
	count(): string;
	keepButtons(): HTMLElement[];
	dismissButtons(): HTMLElement[];
	openAll(): HTMLElement;
	undo(): HTMLElement;
	cancel(): HTMLElement;
	curateStatus(): string;
}

function hits(count: number, prefix = 'Note'): RawHit[] {
	return Array.from({ length: count }, (_unused, index) =>
		hit(index, { title: `${prefix} ${index}`, path: `Projekte/${prefix} ${index}.md` }),
	);
}

function open(options: { hits?: RawHit[]; settings?: Partial<SiftSettings>; query?: string } = {}): Harness {
	const leaves: LeafRecord[] = [];
	const app = {
		keymap: { pushScope: () => undefined, popScope: () => undefined },
		vault: {
			getAllFolders: () => [],
			getFileByPath: (path: string): TFile => new TFile(path),
			cachedRead: (): Promise<string> => Promise.resolve('Kaffee'),
		},
		workspace: {
			getLeaf: (target: boolean | string) => {
				const record: LeafRecord = { target, opened: [] };
				leaves.push(record);
				return {
					// Not a MarkdownView, so `openAtOffset` stops after the file is
					// opened: these tests are about WHICH files reach a tab.
					view: null,
					openFile: (file: TFile): Promise<void> => {
						record.opened.push(file.path);
						return Promise.resolve();
					},
				};
			},
		},
	} as unknown as App;

	const searcher = fakeSearcher(options.hits ?? []);
	const indexer = fakeIndexer(true);
	(indexer.indexer as unknown as { lastError(): string | null }).lastError = (): string | null => null;
	const deps: SearchModalDeps = {
		indexer: indexer.indexer,
		searcher: searcher.searcher,
		ranker: realRanker(),
		snippets: matchBoundSnippets(),
		settings: settings(options.settings),
		tuning: TUNING,
	};
	const modal = new SearchModal(app, deps, options.query);
	modal.open();

	const pick = (selector: string): HTMLElement => {
		const el = modal.contentEl.querySelector(selector);
		if (!(el instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
		return el;
	};

	return {
		modal,
		searcher,
		leaves,
		input: () => pick('.sift-input') as HTMLInputElement,
		folderInput: () => pick('.sift-chip__input') as HTMLInputElement,
		sortSelect: () => pick('.sift-sort__select') as HTMLSelectElement,
		results: () => pick('.sift-results'),
		cards: () => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.sift-card')),
		titles: () =>
			Array.from(modal.contentEl.querySelectorAll('.sift-card__title')).map((el) => el.textContent ?? ''),
		count: () => modal.contentEl.querySelector('.sift-count')?.textContent ?? '',
		keepButtons: () => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.sift-card__action--keep')),
		dismissButtons: () =>
			Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.sift-card__action--dismiss')),
		openAll: () => pick('.sift-curate__open'),
		undo: () => pick('.sift-curate__undo'),
		cancel: () => pick('.sift-curate__cancel'),
		curateStatus: () => modal.contentEl.querySelector('.sift-curate__status')?.textContent ?? '',
	};
}

function click(el: HTMLElement): void {
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

interface ScopeEntry {
	modifiers: string[] | null;
	key: string | null;
	handler(evt: KeyboardEvent): unknown;
}

function scopeKeys(h: Harness): ScopeEntry[] {
	return (h.modal.scope as unknown as { keys: ScopeEntry[] }).keys;
}

/** The binding registered for `modifiers + key` on the modal's scope. */
function binding(h: Harness, modifiers: readonly string[], key: string): ScopeEntry {
	const found = scopeKeys(h).find(
		(entry) =>
			entry.key === key &&
			(entry.modifiers ?? []).length === modifiers.length &&
			modifiers.every((modifier) => (entry.modifiers ?? []).includes(modifier)),
	);
	if (found === undefined) throw new Error(`no binding for ${modifiers.join('+')}+${key}`);
	return found;
}

function press(h: Harness, modifiers: readonly string[], key: string): unknown {
	return binding(h, modifiers, key).handler(new KeyboardEvent('keydown', { key, cancelable: true }));
}

async function settle(turns = 400): Promise<void> {
	for (let at = 0; at < turns; at++) await Promise.resolve();
}

beforeEach(() => {
	setLanguage('en');
	document.body.empty();
	Notice.reset();
});

/* -------------------------------------------------------------------------- */
/* 1. The two controls on a card                                              */
/* -------------------------------------------------------------------------- */

describe('the keep and dismiss controls', () => {
	it('gives every card two real buttons with accessible names', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		expect(h.keepButtons().length).toBe(3);
		expect(h.dismissButtons().length).toBe(3);
		for (const button of [...h.keepButtons(), ...h.dismissButtons()]) {
			// A real button, so it is in the tab order without a tabindex of its own.
			expect(button.tagName).toBe('BUTTON');
			expect(button.getAttribute('type')).toBe('button');
			expect((button.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
		}
		expect(h.keepButtons()[0].getAttribute('aria-label')).toBe(t('curate.keep'));
		expect(h.dismissButtons()[0].getAttribute('aria-label')).toBe(t('curate.dismiss'));
	});

	it('marks a kept card and does not open the note when the button is clicked', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		click(h.keepButtons()[1]);
		await settle();

		expect(h.cards()[1].hasClass('sift-card--kept')).toBe(true);
		expect(h.keepButtons()[1].getAttribute('aria-pressed')).toBe('true');
		// The card's own click handler must not have fired underneath the button.
		expect(h.leaves.length).toBe(0);
		expect(h.titles()).toEqual(['Note 0', 'Note 1', 'Note 2']);
	});

	it('un-keeps on a second click', async () => {
		const h = open({ hits: hits(2) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		click(h.keepButtons()[0]);
		click(h.keepButtons()[0]);
		expect(h.cards()[0].hasClass('sift-card--kept')).toBe(false);
		expect(h.keepButtons()[0].getAttribute('aria-pressed')).toBe('false');
	});

	it('hands the focus back to the search field when the clicked button is destroyed', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		const button = h.dismissButtons()[0];
		button.focus();
		click(button);
		await settle();

		// The button the user pressed is gone with its card; without this the next
		// keystroke would land on the document body.
		expect(h.modal.contentEl.ownerDocument.activeElement).toBe(h.input());
	});

	it('leaves the focus alone when the keep button survives the click', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		const button = h.keepButtons()[1];
		button.focus();
		click(button);
		expect(h.modal.contentEl.ownerDocument.activeElement).toBe(button);
	});

	it('takes a dismissed result out of the list without opening it', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		click(h.dismissButtons()[1]);
		await settle();

		expect(h.titles()).toEqual(['Note 0', 'Note 2']);
		expect(h.leaves.length).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* 2. The keyboard                                                            */
/* -------------------------------------------------------------------------- */

describe('curation from the keyboard', () => {
	it('binds keep, dismiss and undo on modifiers, never on a bare key the search field would eat', () => {
		const h = open({ hits: hits(3) });
		for (const [modifiers, key] of [
			[['Mod', 'Shift'], 'K'],
			[['Mod', 'Shift'], 'X'],
			[['Mod', 'Shift'], 'Z'],
		] as const) {
			const entry = binding(h, modifiers, key);
			expect((entry.modifiers ?? []).length).toBeGreaterThan(0);
		}

		// No unmodified letter binding anywhere: the search input owns those.
		const bare = scopeKeys(h).filter((entry) => (entry.modifiers ?? []).length === 0);
		for (const entry of bare) {
			expect(entry.key === null || (entry.key ?? '').length > 1, `bare key ${String(entry.key)}`).toBe(true);
		}
	});

	it('dismisses the selected result and leaves the cursor on the one that moved up', async () => {
		const h = open({ hits: hits(4) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		h.modal.moveSelection(1);

		press(h, ['Mod', 'Shift'], 'X');
		await settle();

		expect(h.titles()).toEqual(['Note 0', 'Note 2', 'Note 3']);
		expect(h.cards()[1].hasClass('sift-card--selected')).toBe(true);
	});

	it('keeps the selected result and moves on to the next one', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		press(h, ['Mod', 'Shift'], 'K');
		await settle();

		expect(h.cards()[0].hasClass('sift-card--kept')).toBe(true);
		expect(h.cards()[1].hasClass('sift-card--selected')).toBe(true);
	});

	it('steps aside while a filter control has the focus', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		h.sortSelect().focus();

		expect(press(h, ['Mod', 'Shift'], 'X')).toBe(true);
		expect(h.titles().length).toBe(3);
	});

	it('leaves the search field its own undo while nothing has been dismissed', async () => {
		const h = open({ hits: hits(2) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(press(h, ['Mod', 'Shift'], 'Z')).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* 3. Undo                                                                    */
/* -------------------------------------------------------------------------- */

describe('undoing a dismissal', () => {
	it('offers a visible undo control as soon as something is dismissed', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(h.undo().hasClass('sift-curate__button--hidden')).toBe(true);

		click(h.dismissButtons()[0]);
		await settle();
		expect(h.undo().hasClass('sift-curate__button--hidden')).toBe(false);
		expect(h.undo().textContent).toBe(t('curate.undo'));
	});

	it('puts the result back where it was, in reverse order', async () => {
		const h = open({ hits: hits(4) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		click(h.dismissButtons()[1]); // Note 1
		await settle();
		click(h.dismissButtons()[0]); // Note 0
		await settle();
		expect(h.titles()).toEqual(['Note 2', 'Note 3']);

		click(h.undo());
		await settle();
		expect(h.titles()).toEqual(['Note 0', 'Note 2', 'Note 3']);

		click(h.undo());
		await settle();
		expect(h.titles()).toEqual(['Note 0', 'Note 1', 'Note 2', 'Note 3']);
		expect(h.undo().hasClass('sift-curate__button--hidden')).toBe(true);
	});

	it('answers the keyboard undo once there is something to undo', async () => {
		const h = open({ hits: hits(2) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		click(h.dismissButtons()[0]);
		await settle();

		expect(press(h, ['Mod', 'Shift'], 'Z')).toBe(false);
		expect(h.titles()).toEqual(['Note 0', 'Note 1']);
	});
});

/* -------------------------------------------------------------------------- */
/* 4. An honest counter                                                       */
/* -------------------------------------------------------------------------- */

describe('the header counter while a run is curated', () => {
	it('reports what is left and what was dismissed instead of silently shrinking', async () => {
		const h = open({ hits: hits(5) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(h.count()).toMatch(/5 results/);

		click(h.dismissButtons()[0]);
		await settle();
		click(h.dismissButtons()[0]);
		await settle();

		expect(h.count()).toBe(t('curate.left', { n: 3, dismissed: 2 }));
		expect(h.count()).toContain('3');
		expect(h.count()).toContain('2');
	});

	it('counts kept results in the curation status', async () => {
		const h = open({ hits: hits(4) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(h.curateStatus()).toBe('');

		click(h.keepButtons()[0]);
		expect(h.curateStatus()).toBe(t('curate.keptOne'));
		click(h.keepButtons()[2]);
		expect(h.curateStatus()).toBe(t('curate.keptCount', { n: 2 }));
	});
});

/* -------------------------------------------------------------------------- */
/* 5. Scope of a run                                                          */
/* -------------------------------------------------------------------------- */

describe('a run owns its curation', () => {
	it('forgets everything when the query changes', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		click(h.dismissButtons()[0]);
		click(h.keepButtons()[0]);
		await settle();
		expect(h.titles()).toEqual(['Note 1', 'Note 2']);

		h.modal.setQuery('andere');
		await h.modal.runSearch(true);
		await settle();

		expect(h.titles()).toEqual(['Note 0', 'Note 1', 'Note 2']);
		expect(h.cards().some((card) => card.hasClass('sift-card--kept'))).toBe(false);
		expect(h.undo().hasClass('sift-curate__button--hidden')).toBe(true);
		expect(h.count()).toMatch(/3 results/);
	});

	it('does not bring a dismissed card back when it scrolls out of the window and in again', async () => {
		const h = open({ hits: hits(400) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		await settle();

		expect(h.titles()[0]).toBe('Note 0');
		click(h.dismissButtons()[0]);
		await settle();
		expect(h.titles()[0]).toBe('Note 1');

		h.results().scrollTop = 142 * 100;
		h.results().dispatchEvent(new Event('scroll'));
		await settle();
		expect(h.titles()).not.toContain('Note 0');

		h.results().scrollTop = 0;
		h.results().dispatchEvent(new Event('scroll'));
		await settle();
		expect(h.titles()).not.toContain('Note 0');
		expect(h.titles()[0]).toBe('Note 1');
	});

	it('says so when every result of the run has been dismissed', async () => {
		const h = open({ hits: hits(2) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		click(h.dismissButtons()[0]);
		await settle();
		click(h.dismissButtons()[0]);
		await settle();

		expect(h.cards().length).toBe(0);
		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('curate.emptyTitle'));
		// The way back is still on screen.
		expect(h.undo().hasClass('sift-curate__button--hidden')).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */
/* 6. Open all                                                                */
/* -------------------------------------------------------------------------- */

describe('opening what is left', () => {
	it('says which set it will open before it is pressed', async () => {
		const h = open({ hits: hits(4) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		expect(h.openAll().textContent).toBe(t('curate.openAll', { n: 4 }));

		click(h.keepButtons()[1]);
		expect(h.openAll().textContent).toBe(t('curate.openKeptOne'));
		click(h.keepButtons()[2]);
		expect(h.openAll().textContent).toBe(t('curate.openKept', { n: 2 }));
	});

	it('opens every remaining note in its own tab', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		click(h.dismissButtons()[0]);
		await settle();

		click(h.openAll());
		await settle();

		expect(h.leaves.map((leaf) => leaf.target)).toEqual(['tab', 'tab']);
		expect(h.leaves.flatMap((leaf) => leaf.opened)).toEqual(['Projekte/Note 1.md', 'Projekte/Note 2.md']);
	});

	it('opens the kept ones when anything is kept', async () => {
		const h = open({ hits: hits(4) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		click(h.keepButtons()[2]);
		await settle();

		click(h.openAll());
		await settle();
		expect(h.leaves.flatMap((leaf) => leaf.opened)).toEqual(['Projekte/Note 2.md']);
	});

	it('asks first above a small number, and opens nothing until the answer comes', async () => {
		const h = open({ hits: hits(9) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);

		click(h.openAll());
		await settle();
		expect(h.leaves.length).toBe(0);
		expect(h.curateStatus()).toBe(t('curate.confirmQuestion', { n: 9 }));
		expect(h.openAll().textContent).toBe(t('curate.confirmAccept'));
		expect(h.cancel().hasClass('sift-curate__button--hidden')).toBe(false);

		click(h.cancel());
		expect(h.leaves.length).toBe(0);
		expect(h.curateStatus()).toBe('');

		click(h.openAll());
		click(h.openAll());
		await settle();
		expect(h.leaves.length).toBe(9);
	});

	it('opens a small set straight away', async () => {
		const h = open({ hits: hits(3) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		click(h.openAll());
		await settle();
		expect(h.leaves.length).toBe(3);
	});

	it('caps a huge result set instead of wedging the workspace', async () => {
		const h = open({ hits: hits(200) });
		h.modal.setQuery('note');
		await h.modal.runSearch(true);
		await settle();

		expect(h.openAll().textContent).toBe(t('curate.openCapped', { n: 20, total: 200 }));
		click(h.openAll());
		expect(h.curateStatus()).toBe(t('curate.confirmCapped', { n: 20, total: 200 }));
		click(h.openAll());
		await settle();
		expect(h.leaves.length).toBe(20);
	});
});

/* -------------------------------------------------------------------------- */
/* 7. Searching with filters and no term                                      */
/* -------------------------------------------------------------------------- */

describe('a search with no query term', () => {
	it('stays in the initial state for an empty query with no filter', async () => {
		const h = open({ hits: hits(3) });
		await h.modal.runSearch(true);
		expect(h.searcher.calls.length).toBe(0);
		expect(h.modal.contentEl.querySelector('.sift-empty__title')?.textContent).toBe(t('empty.initial.title'));
	});

	it('searches on a folder filter alone', async () => {
		const h = open({ hits: hits(3) });
		h.folderInput().value = 'Projekte';
		h.folderInput().dispatchEvent(new Event('change'));
		await settle();

		expect(h.searcher.calls.length).toBe(1);
		expect(h.searcher.calls[0].ast.isEmpty).toBe(true);
		expect(h.searcher.calls[0].options.filters.folder).toBe('Projekte');
		expect(h.cards().length).toBe(3);
	});

	it('counts notes rather than results, and makes no claim about how fast it was', async () => {
		const h = open({ hits: hits(3) });
		h.folderInput().value = 'Projekte';
		h.folderInput().dispatchEvent(new Event('change'));
		await settle();

		expect(h.count()).toBe(t('search.notes', { n: 3 }));
		expect(h.count()).not.toMatch(/ms/);
	});

	it('drops out of relevance order, because there is no relevance without a term', async () => {
		const sort = vi.spyOn(Ranker, 'sort');
		const h = open({ hits: hits(3) });
		expect(h.sortSelect().value).toBe('relevance');

		h.folderInput().value = 'Projekte';
		h.folderInput().dispatchEvent(new Event('change'));
		await settle();

		expect(h.sortSelect().value).toBe('created-desc');
		expect(sort.mock.calls.map((call) => call[1])).toContain('created-desc');
		sort.mockRestore();
	});

	it('renders a match-less card without an excerpt strip and without a stray ellipsis', async () => {
		const h = open({ hits: hits(2).map((source) => ({ ...source, matches: [] })) });
		h.folderInput().value = 'Projekte';
		h.folderInput().dispatchEvent(new Event('change'));
		await settle();

		const card = h.cards()[0];
		expect(card.querySelector('.sift-card__title')?.textContent).toBe('Note 0');
		expect(card.querySelector('.sift-card__path')?.textContent).toBe('Projekte / 2026');
		expect(card.querySelector('.sift-card__date')?.textContent?.length).toBeGreaterThan(0);
		expect(card.textContent).not.toContain('…');
		const snippets = card.querySelector('.sift-card__snippets');
		expect(snippets?.classList.contains('sift-card__snippets--blank')).toBe(true);
	});

	it('names the filters, not the query, when nothing passes them', async () => {
		const h = open({ hits: [] });
		h.folderInput().value = 'Projekte';
		h.folderInput().dispatchEvent(new Event('change'));
		await settle();

		expect(h.modal.contentEl.querySelector('.sift-empty__body')?.textContent).toBe(t('empty.no-results.filters'));
		expect(h.count()).toBe(t('search.notesNone'));
		// Nothing to curate, so the controls are not offered.
		expect(h.modal.contentEl.querySelector('.sift-curate')?.classList.contains('sift-curate--visible')).toBe(false);
	});
});
