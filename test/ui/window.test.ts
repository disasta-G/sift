/** @vitest-environment happy-dom */

/**
 * The rendered window, measured against a layout.
 *
 * happy-dom computes no geometry, so every metric the virtualization depends on
 * — the scroller's height, a card's height, a card's offset inside the list —
 * is modelled here by the same arithmetic a real browser would produce for the
 * mockup's card: 124px tall, 18px apart, in a 700px viewport. The modal is then
 * driven through the real event sequence a mouse produces (mousedown, the
 * browser's own scroll event, click), and the snippets are built by the REAL
 * `Snippets` over a fake vault that counts `cachedRead`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Notice, TFile, installDomHelpers } from '../stubs/obsidian';
import type { App } from 'obsidian';
import { SearchModal } from '../../src/ui/SearchModal';
import type { SearchModalDeps } from '../../src/ui/SearchModal';
import { Snippets } from '../../src/search/Snippets';
import { setLanguage } from '../../src/i18n/index';
import type { IndexedFile, RawHit, SiftSettings } from '../../src/types';
import type { Indexer } from '../../src/index/Indexer';
import { TUNING, fakeIndexer, fakeSearcher, hit, match, realRanker, settings } from './factories';

installDomHelpers();

/* -------------------------------------------------------------------------- */
/* The modelled layout                                                        */
/* -------------------------------------------------------------------------- */

/** Card height from the mockup: 12 + 16*1.5 + … rounded to the value the plugin assumes. */
const CARD_HEIGHT = 124;

/** The 18px flex gap between cards, mirrored from styles.css. */
const CARD_GAP = 18;

const ROW_HEIGHT = CARD_HEIGHT + CARD_GAP;

/** `.sift-results` padding-top, so a card's offsetTop is not flush with the scroller. */
const LIST_PADDING = 14;

/** Scroller height. 700 / 142 -> six rows visible at a time. */
const VIEWPORT = 700;

/** Mirrored from SearchModal: rows kept above and below the viewport, and the block the window snaps to. */
const OVERSCAN = 8;
const WINDOW_BLOCK = 20;

/**
 * What `computeWindow` derives from a row height: what fits, the overscan on
 * both sides, and one block of slack. It is a function of the row height because
 * the row height is a MEASUREMENT — a card carrying five-line excerpts is twice
 * the height of the same card while its excerpts are still being read.
 */
function windowSizeFor(rowHeight: number): number {
	return Math.ceil(VIEWPORT / rowHeight) + 1 + 2 * OVERSCAN + WINDOW_BLOCK;
}

const WINDOW_SIZE = windowSizeFor(ROW_HEIGHT);

type Descriptors = Record<string, PropertyDescriptor | undefined>;

function cardIndexOf(el: HTMLElement): number | null {
	const id = el.getAttribute('id');
	if (id === null || !id.startsWith('sift-result-')) return null;
	const index = Number(id.slice('sift-result-'.length));
	return Number.isFinite(index) ? index : null;
}

/** Installs the modelled geometry on HTMLElement, and hands back the undo. */
function patchLayout(): () => void {
	const proto = HTMLElement.prototype;
	const before: Descriptors = {
		offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
		offsetTop: Object.getOwnPropertyDescriptor(proto, 'offsetTop'),
		clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
	};

	Object.defineProperty(proto, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement): number {
			return this.classList.contains('sift-card') ? CARD_HEIGHT : 0;
		},
	});
	Object.defineProperty(proto, 'offsetTop', {
		configurable: true,
		get(this: HTMLElement): number {
			const index = cardIndexOf(this);
			return index === null ? 0 : LIST_PADDING + index * ROW_HEIGHT;
		},
	});
	Object.defineProperty(proto, 'clientHeight', {
		configurable: true,
		get(this: HTMLElement): number {
			return this.classList.contains('sift-results') ? VIEWPORT : 0;
		},
	});

	return () => {
		for (const [name, descriptor] of Object.entries(before)) {
			if (descriptor === undefined) delete (proto as unknown as Record<string, unknown>)[name];
			else Object.defineProperty(proto, name, descriptor);
		}
	};
}

const restoreLayout = patchLayout();
afterAll(restoreLayout);

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const BODY_TEXT =
	'Der Anschluss für die Kaffeemaschine wird als separate Gruppe ausgeführt, damit ein Vollautomat ' +
	'betrieben werden kann. Der Geschirrspüler bekommt eine eigene Gruppe, der Boiler ebenfalls.';
const MATCH_START = BODY_TEXT.indexOf('Kaffeemaschine');
const MATCH_END = MATCH_START + 'Kaffeemaschine'.length;

interface Harness {
	modal: SearchModal;
	/** Paths handed to `vault.cachedRead`, in call order. */
	reads: string[];
	opened: string[];
	cards(): HTMLElement[];
	card(index: number): HTMLElement;
	results(): HTMLElement;
}

/** Hits that all carry a body match, so every one of them is worth a file read. */
function hits(count: number): RawHit[] {
	return Array.from({ length: count }, (_unused, index) =>
		hit(index, {
			title: `Note ${index}`,
			path: `Projekte/Note ${index}.md`,
			matches: [match({ start: MATCH_START, end: MATCH_END, field: 'body' })],
		}),
	);
}

/** An indexer that answers `isReady` and hands back a record of the right length. */
function recordIndexer(count: number): Indexer {
	const base = fakeIndexer(true).indexer as unknown as Record<string, unknown>;
	// A build that finished: the modal asks before it may claim "no matches".
	base.lastError = (): string | null => null;
	const record = (id: number): IndexedFile | undefined =>
		id >= 0 && id < count
			? ({ id, path: `Projekte/Note ${id}.md`, text: BODY_TEXT, offsetMap: null } as unknown as IndexedFile)
			: undefined;
	base.getFile = (id: number): IndexedFile | undefined => record(id);
	base.getFileByPath = (path: string): IndexedFile | undefined => {
		const found = /Note (\d+)\.md$/.exec(path);
		return found === null ? undefined : record(Number(found[1]));
	};
	return base as unknown as Indexer;
}

function open(count: number, overrides: Partial<SiftSettings> = {}): Harness {
	const reads: string[] = [];
	const opened: string[] = [];
	const app = {
		keymap: { pushScope: () => undefined, popScope: () => undefined },
		vault: {
			getAllFolders: () => [],
			getFileByPath: (path: string): TFile | null => (/^Projekte\/Note \d+\.md$/.test(path) ? new TFile(path) : null),
			cachedRead: (file: TFile): Promise<string> => {
				reads.push(file.path);
				return Promise.resolve(BODY_TEXT);
			},
		},
		workspace: {
			getActiveFile: (): TFile | null => null,
			getLeaf: () => ({
				view: {},
				openFile: (file: TFile): Promise<void> => {
					opened.push(file.path);
					return Promise.resolve();
				},
			}),
		},
	} as unknown as App;

	const indexer = recordIndexer(count);
	const deps: SearchModalDeps = {
		indexer,
		searcher: fakeSearcher(hits(count)).searcher,
		ranker: realRanker(),
		snippets: new Snippets(app, indexer, TUNING),
		settings: settings(overrides),
		tuning: TUNING,
	};

	const modal = new SearchModal(app, deps);
	modal.open();
	modal.setQuery('kaffeemaschine');

	const results = (): HTMLElement => {
		const el = modal.contentEl.querySelector('.sift-results');
		if (!(el instanceof HTMLElement)) throw new Error('no results container');
		return el;
	};
	const cards = (): HTMLElement[] => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.sift-card'));

	return {
		modal,
		reads,
		opened,
		results,
		cards,
		card: (index: number): HTMLElement => {
			const el = modal.contentEl.querySelector(`#sift-result-${index}`);
			if (!(el instanceof HTMLElement)) throw new Error(`card ${index} is not rendered`);
			return el;
		},
	};
}

/** Drains the microtask queue, so every snippet batch of the window has run. */
async function settle(turns = 200): Promise<void> {
	for (let at = 0; at < turns; at++) await Promise.resolve();
}

function scrollTo(h: Harness, top: number): void {
	const scroller = h.results();
	scroller.scrollTop = top;
	scroller.dispatchEvent(new Event('scroll'));
}

beforeEach(() => {
	setLanguage('en');
	document.body.empty();
	Notice.reset();
});

afterEach(() => {
	document.body.empty();
});

/* -------------------------------------------------------------------------- */
/* 1. The window is bounded by the viewport, not by maxResults                */
/* -------------------------------------------------------------------------- */

describe('rendered window', () => {
	it('renders a viewport-sized window of 5000 hits and reads only those files, at the shipped defaults', async () => {
		const h = open(5000);
		await h.modal.runSearch(true);
		await settle();

		// maxResults defaults to 200 — which used to be the virtualization
		// threshold too, so the whole capped list went into the DOM and every one
		// of its files was read before a single excerpt appeared.
		expect(h.cards().length).toBe(WINDOW_SIZE);
		expect(h.reads.length).toBe(WINDOW_SIZE);
		expect(new Set(h.reads).size).toBe(WINDOW_SIZE);
		expect(h.reads).toContain('Projekte/Note 0.md');
		expect(h.reads).not.toContain(`Projekte/Note ${WINDOW_SIZE}.md`);

		// The excerpts really were built from the files that were read.
		expect(h.modal.contentEl.querySelectorAll('.sift-card__snippet').length).toBeGreaterThan(0);
		expect(h.modal.contentEl.textContent).toContain('Kaffeemaschine');
	});

	it('keeps the same window when maxResults is raised to 5000', async () => {
		const h = open(5000, { maxResults: 5000 });
		await h.modal.runSearch(true);
		await settle();

		expect(h.cards().length).toBe(WINDOW_SIZE);
		expect(h.reads.length).toBe(WINDOW_SIZE);
	});

	it('reads one file per newly exposed card when the list scrolls', async () => {
		const h = open(5000, { maxResults: 5000 });
		await h.modal.runSearch(true);
		await settle();
		const before = h.reads.length;

		scrollTo(h, ROW_HEIGHT * 40);
		await settle();

		// The new window overlaps the old one; only the rows that were not read
		// before cost a read, and nothing is read twice.
		expect(h.reads.length).toBeGreaterThan(before);
		expect(h.reads.length).toBeLessThanOrEqual(before + WINDOW_SIZE);
		expect(new Set(h.reads).size).toBe(h.reads.length);
		expect(h.cards().length).toBe(WINDOW_SIZE);
	});
});

/* -------------------------------------------------------------------------- */
/* 2. The window survives a pointer press                                     */
/* -------------------------------------------------------------------------- */

describe('pointer interaction', () => {
	it('does not rebuild the window when the list scrolls by a single row', async () => {
		const h = open(1000, { maxResults: 1000 });
		await h.modal.runSearch(true);
		await settle();

		const first = h.card(0);
		scrollTo(h, ROW_HEIGHT);
		// `end` used to be derived from the unsnapped first visible row, so one row
		// of scroll destroyed and recreated every card in the window.
		expect(h.card(0)).toBe(first);
		expect(first.isConnected).toBe(true);
	});

	it('opens the note when a partially visible card is pressed and released', async () => {
		const h = open(1000, { maxResults: 1000 });
		await h.modal.runSearch(true);
		await settle();

		// Scrolled so that card 24 hangs 16px below the fold: pressing it used to
		// correct the scroll position by a row, which rebuilt the window between
		// mousedown and mouseup and detached the node the button was pressed on.
		scrollTo(h, 2830);
		await settle();
		const card = h.card(24);
		const top = LIST_PADDING + 24 * ROW_HEIGHT;
		expect(top).toBeLessThan(2830 + VIEWPORT);
		expect(top + CARD_HEIGHT).toBeGreaterThan(2830 + VIEWPORT);

		card.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		// Whatever the press did to the scroll position, the browser reports it here.
		h.results().dispatchEvent(new Event('scroll'));

		expect(card.isConnected).toBe(true);
		expect(card.hasClass('sift-card--selected')).toBe(true);

		card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(h.opened).toEqual(['Projekte/Note 24.md']);
	});

	it('keeps the whole selected card inside the scrollport, border included', async () => {
		const h = open(1000, { maxResults: 1000 });
		await h.modal.runSearch(true);
		await settle();

		for (let step = 0; step < 12; step++) {
			h.modal.moveSelection(1);
			const selected = h.cards().find((card) => card.hasClass('sift-card--selected'));
			if (selected === undefined) continue;
			const top = selected.offsetTop - h.results().scrollTop;
			const bottom = top + selected.offsetHeight;
			// `overflow-y: auto` clips whatever lies outside; a card resting exactly
			// on the client edge loses the outer row of its accent border, which is
			// the frame the owner saw open at the top.
			expect(top).toBeGreaterThanOrEqual(1);
			expect(bottom).toBeLessThanOrEqual(VIEWPORT - 1);
		}
	});

	it('still scrolls a keyboard selection into view', async () => {
		const h = open(1000, { maxResults: 1000 });
		await h.modal.runSearch(true);
		await settle();
		expect(h.results().scrollTop).toBe(0);

		for (let step = 0; step < 8; step++) h.modal.moveSelection(1);

		// Card 8 ends at 14 + 8*142 + 124 = 1274, below the 700px fold.
		expect(h.results().scrollTop).toBeGreaterThan(0);
		expect(h.card(8).hasClass('sift-card--selected')).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */
/* 3. Cards that grow when their excerpts arrive                              */
/* -------------------------------------------------------------------------- */

/**
 * The modelled layout above gives every card the same height whatever it holds.
 * A real one does not: a card is the height of its blank snippet area until the
 * excerpts are read, and a five-line excerpt then roughly doubles it. That gap
 * is what the spacers get wrong if the row height is measured once, on the first
 * paint, and never again.
 */
describe('cards that grow when their excerpts arrive', () => {
	/** A card whose excerpts have not been read yet. */
	const BLANK_CARD = 100;
	/** The same card once it carries a five-line excerpt. */
	const FILLED_CARD = 300;

	let restoreHeights: () => void = () => undefined;

	beforeEach(() => {
		const proto = HTMLElement.prototype;
		const before = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
		Object.defineProperty(proto, 'offsetHeight', {
			configurable: true,
			get(this: HTMLElement): number {
				if (!this.classList.contains('sift-card')) return 0;
				return this.querySelector('.sift-card__snippet') === null ? BLANK_CARD : FILLED_CARD;
			},
		});
		restoreHeights = () => {
			if (before !== undefined) Object.defineProperty(proto, 'offsetHeight', before);
		};
	});

	afterEach(() => {
		restoreHeights();
	});

	/** The bottom spacer, which stands in for every row below the rendered window. */
	function bottomSpacer(h: Harness): HTMLElement {
		const spacers = h.modal.contentEl.querySelectorAll<HTMLElement>('.sift-results__spacer');
		const last = spacers[spacers.length - 1];
		if (last === undefined) throw new Error('no bottom spacer');
		return last;
	}

	it('rebuilds the spacers from the height the cards actually reached', async () => {
		const h = open(5000, { maxResults: 5000 });
		await h.modal.runSearch(true);
		await settle();

		// The window is still bounded by the viewport, not by the 5000 hits: what
		// changes with a taller card is how many of them fit, never whether the
		// list virtualizes at all.
		const rendered = h.cards().length;
		expect(rendered).toBe(windowSizeFor(BLANK_CARD + CARD_GAP));
		expect(h.reads.length).toBe(rendered);

		// Every rendered card carries an excerpt now, so the row height behind the
		// spacers has to be the FILLED one. Measured only on the first paint, it
		// would still be the blank height and the scrollbar would describe a list
		// two thirds the length of the real one.
		expect(bottomSpacer(h).style.height).toBe(`${(5000 - rendered) * (FILLED_CARD + CARD_GAP)}px`);
	});

	it('stays bounded after a scroll into a region that has never been read', async () => {
		const h = open(5000, { maxResults: 5000 });
		await h.modal.runSearch(true);
		await settle();
		const before = h.reads.length;

		scrollTo(h, (FILLED_CARD + CARD_GAP) * 60);
		await settle();

		expect(h.cards().length).toBeLessThanOrEqual(windowSizeFor(BLANK_CARD + CARD_GAP));
		expect(h.reads.length).toBeGreaterThan(before);
		expect(new Set(h.reads).size).toBe(h.reads.length);
	});
});
