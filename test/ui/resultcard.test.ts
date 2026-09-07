/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installDomHelpers } from '../stubs/obsidian';
import { ResultCard } from '../../src/ui/ResultCard';
import { setLanguage, t } from '../../src/i18n/index';
import { item, snippet } from './factories';
import type { ResultCardCallbacks, ResultCardModel, ResultItem } from '../../src/types';

installDomHelpers();

function model(overrides: Partial<ResultCardModel> = {}): ResultCardModel {
	const source: ResultItem = overrides.item ?? item(1);
	return {
		item: source,
		index: 0,
		selected: false,
		dateLabel: '14.03.2026',
		folderLabel: 'Projekte / 2026',
		...overrides,
	};
}

function noopCallbacks(): ResultCardCallbacks {
	return { onSelect: () => undefined, onOpen: () => undefined };
}

let host: HTMLElement;

beforeEach(() => {
	setLanguage('en');
	document.body.empty();
	host = document.body.createDiv();
});

describe('snippet rendering', () => {
	it('splits a two-mark snippet into alternating plain and marked spans without losing a character', () => {
		const text = 'Der Anschluss für die Kaffeemaschine und die Kaffeemühle im Pausenraum.';
		const first = text.indexOf('Kaffeemaschine');
		const second = text.indexOf('Kaffeemühle');
		const card = new ResultCard(
			host,
			model({
				item: item(1, {
					snippets: [
						snippet({
							text,
							marks: [
								{ start: first, end: first + 'Kaffeemaschine'.length },
								{ start: second, end: second + 'Kaffeemühle'.length },
							],
							focus: { start: 0, end: text.length },
						}),
					],
				}),
			}),
			noopCallbacks(),
		);

		const body = card.el.querySelector('.sift-snippet__body');
		expect(body).not.toBeNull();
		expect(body?.textContent).toBe(text);

		const marks = card.el.querySelectorAll('mark.sift-mark');
		expect(marks.length).toBe(2);
		expect(marks[0].textContent).toBe('Kaffeemaschine');
		expect(marks[1].textContent).toBe('Kaffeemühle');

		// Nothing duplicated: the plain runs plus the marks tile the text exactly.
		const runs = Array.from(body?.querySelectorAll('.sift-snippet__text, mark.sift-mark') ?? []);
		expect(runs.map((run) => run.textContent).join('')).toBe(text);
	});

	it('renders a snippet with markup-looking content as literal text', () => {
		const text = '<script>alert(1)</script> &amp; <b>bold</b>';
		const card = new ResultCard(
			host,
			model({ item: item(1, { snippets: [snippet({ text, marks: [{ start: 0, end: 8 }] })] }) }),
			noopCallbacks(),
		);

		const body = card.el.querySelector('.sift-snippet__body');
		expect(body?.textContent).toBe(text);
		expect(card.el.querySelector('script')).toBeNull();
		expect(card.el.querySelector('b')).toBeNull();
	});

	it('lifts only the focus sentence out of the muted context colour', () => {
		const text = 'Vorher. Der Anschluss für die Kaffeemaschine. Nachher.';
		const focusStart = text.indexOf('Der');
		const focusEnd = text.indexOf('Nachher.');
		const markStart = text.indexOf('Kaffeemaschine');
		const card = new ResultCard(
			host,
			model({
				item: item(1, {
					snippets: [
						snippet({
							text,
							focus: { start: focusStart, end: focusEnd },
							marks: [{ start: markStart, end: markStart + 'Kaffeemaschine'.length }],
						}),
					],
				}),
			}),
			noopCallbacks(),
		);

		const sentence = card.el.querySelector('.sift-snippet__sentence');
		expect(sentence?.textContent).toBe(text.slice(focusStart, focusEnd));
		// The mark sits inside the sentence, so it inherits the normal colour.
		expect(sentence?.querySelector('mark.sift-mark')).not.toBeNull();
		const body = card.el.querySelector('.sift-snippet__body');
		expect(body?.textContent).toBe(text);
	});

	it('renders the ellipsis flags outside the body so the body stays equal to the snippet text', () => {
		const text = 'mitten im Satz';
		const card = new ResultCard(
			host,
			model({
				item: item(1, {
					snippets: [snippet({ text, leadingEllipsis: true, trailingEllipsis: true, marks: [] })],
				}),
			}),
			noopCallbacks(),
		);

		expect(card.el.querySelector('.sift-snippet__body')?.textContent).toBe(text);
		expect(card.el.querySelectorAll('.sift-snippet__ellipsis').length).toBe(2);
		expect(card.el.querySelector('.sift-card__snippet')?.textContent).toBe(`…${text}…`);
	});

	it('renders a five-line excerpt as five lines and keeps every character', () => {
		const lines = [
			'## Ausstattung Pausenraum',
			'',
			'- Kaffeemaschine mit Festwasseranschluss',
			'- Geschirrspüler, 60 cm',
			'- Kühlschrank, vom Bauherrn gestellt',
		];
		const text = lines.join('\n');
		const start = text.indexOf('Kaffeemaschine');
		const card = new ResultCard(
			host,
			model({
				item: item(1, {
					snippets: [
						snippet({
							text,
							marks: [{ start, end: start + 'Kaffeemaschine'.length }],
							focus: { start, end: start + 'Kaffeemaschine'.length },
						}),
					],
				}),
			}),
			noopCallbacks(),
		);

		const body = card.el.querySelector('.sift-snippet__body');
		expect(body).not.toBeNull();
		// Four breaks for five lines, and no line collapsed into its neighbour.
		expect(body?.querySelectorAll('br').length).toBe(4);
		expect(body?.textContent).toBe(lines.join(''));
		expect(card.el.querySelector('mark.sift-mark')?.textContent).toBe('Kaffeemaschine');
		// The excerpt is not preformatted: an unbroken line must wrap rather than
		// push the modal into horizontal scrolling.
		expect(card.el.getAttribute('style')).toBeNull();
	});

	it('treats CRLF and a lone CR as one break each, and marks survive them', () => {
		const text = 'Zeile eins\r\nKaffeemaschine\rZeile drei';
		const start = text.indexOf('Kaffeemaschine');
		const card = new ResultCard(
			host,
			model({
				item: item(1, {
					snippets: [snippet({ text, marks: [{ start, end: start + 'Kaffeemaschine'.length }] })],
				}),
			}),
			noopCallbacks(),
		);

		const body = card.el.querySelector('.sift-snippet__body');
		expect(body?.querySelectorAll('br').length).toBe(2);
		expect(body?.textContent).toBe('Zeile einsKaffeemaschineZeile drei');
		expect(card.el.querySelector('mark.sift-mark')?.textContent).toBe('Kaffeemaschine');
	});

	it('splits a focus sentence that spans a line break into one span per line', () => {
		const text = 'Der Anschluss für die\nKaffeemaschine ist fertig.';
		const card = new ResultCard(
			host,
			model({
				item: item(1, {
					snippets: [snippet({ text, focus: { start: 0, end: text.length }, marks: [] })],
				}),
			}),
			noopCallbacks(),
		);

		const sentences = Array.from(card.el.querySelectorAll('.sift-snippet__sentence'));
		expect(sentences.map((el) => el.textContent)).toEqual(['Der Anschluss für die', 'Kaffeemaschine ist fertig.']);
		// The break sits between them, at body level, not inside either span.
		expect(card.el.querySelector('.sift-snippet__sentence br')).toBeNull();
		expect(card.el.querySelector('.sift-snippet__body')?.querySelectorAll('br').length).toBe(1);
	});

	it('keeps an out-of-range or overlapping mark from dropping or duplicating text', () => {
		const text = 'Kaffeemaschine im Pausenraum';
		const card = new ResultCard(
			host,
			model({
				item: item(1, {
					snippets: [
						snippet({
							text,
							marks: [
								{ start: 0, end: 6 },
								{ start: 4, end: 14 },
								{ start: 900, end: 950 },
							],
						}),
					],
				}),
			}),
			noopCallbacks(),
		);

		expect(card.el.querySelector('.sift-snippet__body')?.textContent).toBe(text);
	});
});

describe('layout invariants', () => {
	it('keeps the snippet area present but blank when there are no snippets', () => {
		const card = new ResultCard(host, model(), noopCallbacks());
		const area = card.el.querySelector('.sift-card__snippets');
		expect(area).not.toBeNull();
		expect(area?.childElementCount).toBe(0);

		card.update(model({ item: item(1, { snippets: [snippet()] }) }));
		expect(card.el.querySelectorAll('.sift-card__snippet').length).toBe(1);

		card.update(model({ item: item(1, { snippets: [] }) }));
		expect(card.el.querySelector('.sift-card__snippets')?.childElementCount).toBe(0);
	});

	it('uses only sift- prefixed classes and sets no inline style', () => {
		const card = new ResultCard(
			host,
			model({
				selected: true,
				item: item(1, { snippets: [snippet({ marks: [{ start: 0, end: 3 }] })], similarTo: ['Kafeemaschine'] }),
			}),
			noopCallbacks(),
		);

		const elements = [card.el, ...Array.from(card.el.querySelectorAll('*'))];
		for (const el of elements) {
			expect(el.getAttribute('style')).toBeNull();
			for (const cls of Array.from(el.classList)) {
				expect(cls.startsWith('sift-')).toBe(true);
			}
		}
	});

	it('shows the similar label only when a fuzzy word brought the hit in', () => {
		const card = new ResultCard(host, model(), noopCallbacks());
		expect(card.el.querySelector('.sift-card__similar')?.textContent).toBe('');

		card.update(model({ item: item(1, { similarTo: ['Kafeemaschine'] }) }));
		expect(card.el.querySelector('.sift-card__similar')?.textContent).toBe(
			t('result.similar', { term: 'Kafeemaschine' }),
		);
	});
});

describe('selection', () => {
	it('marks the selected card without scaling it', () => {
		// The scale is gone from the card, not made conditional: a non-integer
		// transform resamples the glyphs of the one card the user is reading.
		{
			const card = new ResultCard(host, model({}), noopCallbacks());
			card.setSelected(true);
			expect(card.el.hasClass('sift-card--selected')).toBe(true);
			expect(card.el.hasClass('sift-card--zoomed')).toBe(false);
			expect(card.el.getAttribute('aria-selected')).toBe('true');

			card.setSelected(false);
			expect(card.el.hasClass('sift-card--selected')).toBe(false);
			expect(card.el.getAttribute('aria-selected')).toBe('false');
			card.destroy();
		}
	});

	it('reports a click as select plus open, with the modifier deciding the target', () => {
		const opened: string[] = [];
		const selected: number[] = [];
		const card = new ResultCard(
			host,
			model({ index: 3 }),
			{
				onSelect: (index) => selected.push(index),
				onOpen: (_result, target) => opened.push(target),
			},
		);

		card.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		card.el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
		card.el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));

		expect(selected).toEqual([3, 3, 3]);
		expect(opened).toEqual(['current', 'new-tab', 'split']);
	});

	it('removes the element and its listeners on destroy', () => {
		let selects = 0;
		const card = new ResultCard(host, model(), { onSelect: () => selects++, onOpen: () => undefined });
		const el = card.el;
		card.destroy();

		expect(el.parentElement).toBeNull();
		expect(host.querySelector('.sift-card')).toBeNull();
		el.dispatchEvent(new MouseEvent('click'));
		expect(selects).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* Scrolling the selection into view                                          */
/* -------------------------------------------------------------------------- */

/**
 * happy-dom computes no geometry, so the layout is modelled: a scrollport of a
 * fixed height, cards of the heights the test names, 14px of list padding above
 * the first one and the 18px flex gap between them — the same numbers styles.css
 * carries.
 */
describe('scrolling the selection into view', () => {
	const LIST_PADDING = 14;
	const CARD_GAP = 18;
	const VIEWPORT = 400;

	const geometry = new Map<HTMLElement, { top: number; height: number }>();
	let scroller: HTMLElement;
	let restore: () => void = () => undefined;

	function patchLayout(): () => void {
		const proto = HTMLElement.prototype;
		const before = {
			offsetTop: Object.getOwnPropertyDescriptor(proto, 'offsetTop'),
			offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
			clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
		};
		Object.defineProperty(proto, 'offsetTop', {
			configurable: true,
			get(this: HTMLElement): number {
				return geometry.get(this)?.top ?? 0;
			},
		});
		Object.defineProperty(proto, 'offsetHeight', {
			configurable: true,
			get(this: HTMLElement): number {
				return geometry.get(this)?.height ?? 0;
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

	/** Builds a list of cards with the given heights and returns them. */
	function mountCards(heights: readonly number[]): ResultCard[] {
		scroller = document.body.createDiv({ cls: 'sift-results' });
		const list = scroller.createDiv({ cls: 'sift-results__list' });
		const cards: ResultCard[] = [];
		let top = LIST_PADDING;
		for (let index = 0; index < heights.length; index++) {
			const card = new ResultCard(list, model({ index }), noopCallbacks());
			geometry.set(card.el, { top, height: heights[index] });
			top += heights[index] + CARD_GAP;
			cards.push(card);
		}
		return cards;
	}

	/** Where the card's border box sits inside the scrollport after the correction. */
	function frame(card: ResultCard): { top: number; bottom: number } {
		const box = geometry.get(card.el) ?? { top: 0, height: 0 };
		return { top: box.top - scroller.scrollTop, bottom: box.top + box.height - scroller.scrollTop };
	}

	beforeEach(() => {
		geometry.clear();
		restore = patchLayout();
	});

	afterEach(() => {
		restore();
		geometry.clear();
	});

	it('never cuts the border of a card it scrolls to, at either edge', () => {
		const cards = mountCards([124, 124, 124, 124, 124, 124]);

		// Walking down and back up again: after every correction the whole border
		// box, the 1px accent frame included, is inside the scrollport.
		for (const card of cards) {
			card.scrollIntoViewIfNeeded();
			const box = frame(card);
			expect(box.top).toBeGreaterThanOrEqual(1);
			expect(box.bottom).toBeLessThanOrEqual(VIEWPORT - 1);
		}
		for (const card of [...cards].reverse()) {
			card.scrollIntoViewIfNeeded();
			const box = frame(card);
			expect(box.top).toBeGreaterThanOrEqual(1);
			expect(box.bottom).toBeLessThanOrEqual(VIEWPORT - 1);
		}
	});

	it('leaves the first card where the list padding puts it and does not scroll above it', () => {
		const cards = mountCards([124, 124, 124]);
		cards[2].scrollIntoViewIfNeeded();
		expect(scroller.scrollTop).toBeGreaterThan(0);

		cards[0].scrollIntoViewIfNeeded();
		expect(scroller.scrollTop).toBe(0);
		expect(frame(cards[0]).top).toBe(LIST_PADDING);
	});

	it('brings the last card fully inside, bottom edge and all', () => {
		const cards = mountCards([124, 124, 124, 124, 124, 124, 124, 124]);
		const last = cards[cards.length - 1];
		last.scrollIntoViewIfNeeded();

		const box = frame(last);
		expect(box.bottom).toBe(VIEWPORT - LIST_PADDING);
		expect(box.top).toBeGreaterThanOrEqual(1);
	});

	it('top-aligns a card too tall to fit rather than cutting its top off', () => {
		// This is the reported defect. Bottom-aligning a card that is taller than
		// the scrollport puts its top ABOVE the client edge by exactly the overflow,
		// and `overflow-y: auto` then clips the accent border away — the frame the
		// owner saw open at the top. A card of exactly `viewport - padding` lands
		// flush with the edge, which rounds to the same thing.
		const cards = mountCards([124, VIEWPORT - LIST_PADDING, VIEWPORT + 20, 124]);

		cards[1].scrollIntoViewIfNeeded();
		expect(frame(cards[1]).top).toBeGreaterThanOrEqual(1);

		cards[2].scrollIntoViewIfNeeded();
		expect(frame(cards[2]).top).toBeGreaterThanOrEqual(1);
	});

	it('does nothing at all without a scrollport, so a detached card is safe', () => {
		const card = new ResultCard(host, model(), noopCallbacks());
		expect(() => {
			card.scrollIntoViewIfNeeded();
		}).not.toThrow();
	});
});

describe('formatters', () => {
	it('formats the created date per locale', () => {
		const value = Date.UTC(2026, 2, 14, 12);
		expect(ResultCard.formatDate(value, 'de')).toBe('14.03.2026');
		expect(ResultCard.formatDate(value, 'de-CH')).toBe('14.03.2026');
		expect(ResultCard.formatDate(value, 'en')).toBe('03/14/2026');
		expect(ResultCard.formatDate(Number.NaN, 'en')).toBe('');
	});

	it('spaces out the folder path and names the vault root', () => {
		expect(ResultCard.formatFolder('Projekte/2026/Büro-Umbau')).toBe('Projekte / 2026 / Büro-Umbau');
		expect(ResultCard.formatFolder('Projekte')).toBe('Projekte');
		expect(ResultCard.formatFolder('')).toBe(t('result.folderRoot'));
		expect(ResultCard.formatFolder('/')).toBe(t('result.folderRoot'));
	});
});
