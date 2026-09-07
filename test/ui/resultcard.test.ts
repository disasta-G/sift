/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from 'vitest';
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
		animateSelection: true,
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
	it('adds the scale class only when animateSelection is on', () => {
		const zooming = new ResultCard(host, model({ animateSelection: true }), noopCallbacks());
		zooming.setSelected(true);
		expect(zooming.el.hasClass('sift-card--selected')).toBe(true);
		expect(zooming.el.hasClass('sift-card--zoomed')).toBe(true);
		expect(zooming.el.getAttribute('aria-selected')).toBe('true');

		const plain = new ResultCard(host, model({ animateSelection: false }), noopCallbacks());
		plain.setSelected(true);
		expect(plain.el.hasClass('sift-card--selected')).toBe(true);
		expect(plain.el.hasClass('sift-card--zoomed')).toBe(false);

		zooming.setSelected(false);
		expect(zooming.el.hasClass('sift-card--selected')).toBe(false);
		expect(zooming.el.hasClass('sift-card--zoomed')).toBe(false);
		expect(zooming.el.getAttribute('aria-selected')).toBe('false');
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
