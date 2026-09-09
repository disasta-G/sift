/** @vitest-environment happy-dom */

/**
 * The created-date popover has to stay inside the modal.
 *
 * `.sift-modal` clips at `overflow: hidden`, so a popover that hangs off the
 * chip's own left edge is CUT when the chip sits near the right edge of the
 * panel — measured in the browser preview at 809px modal width: the chip at
 * x 714..805, a 379px popover, and 112px of calendar (the Saturday and Sunday
 * columns and the clear button) outside the panel.
 *
 * happy-dom computes no geometry, so the placement arithmetic is tested as a
 * pure function against the measured numbers, and the DOM half is driven with a
 * modelled `getBoundingClientRect`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TFolder, installDomHelpers } from '../stubs/obsidian';
import type { App } from 'obsidian';
import { FilterBar, placePopover } from '../../src/ui/FilterBar';
import { setLanguage } from '../../src/i18n/index';
import type { FilterBarCallbacks, FilterBarState, SearchFilters } from '../../src/types';

installDomHelpers();

/* -------------------------------------------------------------------------- */
/* The measured geometry                                                      */
/* -------------------------------------------------------------------------- */

/** The modal panel measured in the preview: 809px wide, at x 173..982. */
const MODAL = { left: 173, right: 982 };

/** The created-date popover measured in the preview, quick picks plus calendar. */
const POPOVER_WIDTH = 379;

/** Kept clear of the clipped edge, mirrored from FilterBar.POPOVER_GUTTER. */
const GUTTER = 8;

const BOUNDS = { boundsLeft: MODAL.left + GUTTER, boundsRight: MODAL.right - GUTTER };

/** Absolute span the popover would occupy for one placement. */
function span(anchorLeft: number, anchorRight: number, width = POPOVER_WIDTH) {
	const placement = placePopover({
		anchorLeft,
		anchorRight,
		popoverWidth: width,
		...BOUNDS,
	});
	const left = anchorLeft + placement.left;
	const painted = Math.min(width, placement.maxWidth);
	return { left, right: left + painted, placement };
}

describe('placePopover', () => {
	it('keeps a popover inside the modal for a chip at the left edge, the middle and the right edge', () => {
		const anchors: ReadonlyArray<readonly [string, number, number]> = [
			// Flush with the panel's inner left edge.
			['left', 181, 272],
			// Somewhere in the middle of the filter bar.
			['middle', 500, 591],
			// The measured failing case: the created chip at the far right.
			['right', 714, 805],
		];

		for (const [name, left, right] of anchors) {
			const box = span(left, right);
			expect(box.left, `${name} left edge`).toBeGreaterThanOrEqual(BOUNDS.boundsLeft);
			expect(box.right, `${name} right edge`).toBeLessThanOrEqual(BOUNDS.boundsRight);
			// Nothing is squeezed as long as the panel is wide enough for it.
			expect(box.right - box.left, `${name} width`).toBe(POPOVER_WIDTH);
		}
	});

	it('hangs off the chip left edge whenever that fits, so the popover reads as belonging to the chip', () => {
		expect(placePopover({ anchorLeft: 500, anchorRight: 591, popoverWidth: POPOVER_WIDTH, ...BOUNDS }).left).toBe(0);
	});

	it('flips to the chip right edge exactly when the left-aligned popover would overflow', () => {
		// 714 + 379 = 1093, which is 119px past the panel's inner right edge.
		const flipped = placePopover({ anchorLeft: 714, anchorRight: 805, popoverWidth: POPOVER_WIDTH, ...BOUNDS });
		expect(flipped.left).toBe(805 - POPOVER_WIDTH - 714);
		expect(714 + flipped.left + POPOVER_WIDTH).toBe(805);
	});

	it('clamps a right-anchored popover that would then run off the LEFT edge', () => {
		// The mirror case: a chip close to the left edge whose right edge is not
		// far enough in for a right-aligned popover of this width.
		const narrow = { boundsLeft: 173, boundsRight: 620 };
		const placement = placePopover({ anchorLeft: 560, anchorRight: 600, popoverWidth: POPOVER_WIDTH, ...narrow });
		const left = 560 + placement.left;
		expect(left).toBeGreaterThanOrEqual(narrow.boundsLeft);
		expect(left + POPOVER_WIDTH).toBeLessThanOrEqual(narrow.boundsRight);
	});

	it('clamps the width when even the whole panel is narrower than the popover', () => {
		const tiny = { boundsLeft: 20, boundsRight: 300 };
		const placement = placePopover({ anchorLeft: 250, anchorRight: 290, popoverWidth: POPOVER_WIDTH, ...tiny });
		expect(placement.maxWidth).toBe(280);
		expect(250 + placement.left).toBe(20);
	});

	it('places a chip on a wrapped second row by the same rule', () => {
		// A wrapped filter bar only moves the chip vertically; the horizontal
		// clamp is the one that decides whether the popover is cut.
		const box = span(880, 971);
		expect(box.left).toBeGreaterThanOrEqual(BOUNDS.boundsLeft);
		expect(box.right).toBeLessThanOrEqual(BOUNDS.boundsRight);
	});
});

/* -------------------------------------------------------------------------- */
/* The DOM half                                                               */
/* -------------------------------------------------------------------------- */

interface Box {
	left: number;
	right: number;
	width: number;
}

const boxes = new Map<Element, Box>();

function patchRects(): () => void {
	const proto = Element.prototype as unknown as Record<string, unknown>;
	const before = proto.getBoundingClientRect;
	proto.getBoundingClientRect = function (this: Element): DOMRect {
		const box = boxes.get(this) ?? { left: 0, right: 0, width: 0 };
		return {
			left: box.left,
			right: box.right,
			width: box.width,
			top: 0,
			bottom: 0,
			height: 0,
			x: box.left,
			y: 0,
			toJSON: () => box,
		};
	};
	return () => {
		proto.getBoundingClientRect = before;
	};
}

const restoreRects = patchRects();
afterAll(restoreRects);

function baseFilters(overrides: Partial<SearchFilters> = {}): SearchFilters {
	return {
		folder: null,
		includeSubfolders: true,
		createdFrom: null,
		createdTo: null,
		modifiedFrom: null,
		modifiedTo: null,
		property: null,
		openTasks: false,
		note: null,
		excludedFolders: [],
		...overrides,
	};
}

function baseState(): FilterBarState {
	return { filters: baseFilters(), sort: 'relevance', fuzzy: false, activeNote: null, summary: null };
}

function mountInModal(): { bar: FilterBar; modal: HTMLElement } {
	const modal = document.body.createDiv({ cls: 'sift-modal' });
	const app = {
		keymap: { pushScope: () => undefined, popScope: () => undefined },
		vault: { getAllFolders: (): TFolder[] => [] },
	} as unknown as App;
	const callbacks: FilterBarCallbacks = {
		onFiltersChange: () => undefined,
		onSortChange: () => undefined,
		onFuzzyChange: () => undefined,
		propertySuggestions: (): readonly string[] => [],
	};
	const bar = new FilterBar(app, modal, baseState(), callbacks, () => Date.now());
	return { bar, modal };
}

function element(bar: FilterBar, selector: string): HTMLElement {
	const el = bar.el.querySelector(selector);
	if (!(el instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
	return el;
}

beforeEach(() => {
	setLanguage('en');
	document.body.empty();
	boxes.clear();
});

describe('the popover in the DOM', () => {
	it('writes an offset that pulls the popover back inside the modal', () => {
		const { bar, modal } = mountInModal();
		const wrap = element(bar, '.sift-filters__date');
		const menu = element(bar, '.sift-date-menu');

		boxes.set(modal, { left: MODAL.left, right: MODAL.right, width: MODAL.right - MODAL.left });
		boxes.set(wrap, { left: 714, right: 805, width: 91 });
		boxes.set(menu, { left: 714, right: 714 + POPOVER_WIDTH, width: POPOVER_WIDTH });

		element(bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));

		const offset = Number(wrap.style.getPropertyValue('--sift-date-menu-left').replace('px', ''));
		expect(Number.isFinite(offset)).toBe(true);
		expect(714 + offset).toBeGreaterThanOrEqual(MODAL.left);
		expect(714 + offset + POPOVER_WIDTH).toBeLessThanOrEqual(MODAL.right);
		expect(wrap.style.getPropertyValue('--sift-date-menu-max-width')).toBe(
			`${MODAL.right - MODAL.left - 2 * GUTTER}px`,
		);

		bar.destroy();
	});

	it('leaves a chip that fits hanging off its own left edge', () => {
		const { bar, modal } = mountInModal();
		const wrap = element(bar, '.sift-filters__date');
		const menu = element(bar, '.sift-date-menu');

		boxes.set(modal, { left: MODAL.left, right: MODAL.right, width: MODAL.right - MODAL.left });
		boxes.set(wrap, { left: 300, right: 391, width: 91 });
		boxes.set(menu, { left: 300, right: 300 + POPOVER_WIDTH, width: POPOVER_WIDTH });

		element(bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(wrap.style.getPropertyValue('--sift-date-menu-left')).toBe('0px');

		bar.destroy();
	});

	it('does not write a placement when nothing has been laid out yet', () => {
		const { bar } = mountInModal();
		const wrap = element(bar, '.sift-filters__date');
		element(bar, '.sift-chip--date').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// Every rect is zero here, so a computed placement would be a guess.
		expect(wrap.style.getPropertyValue('--sift-date-menu-left')).toBe('0px');
		bar.destroy();
	});
});
