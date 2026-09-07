/**
 * ResultCard — one result card, rendered exactly as the mockup: title (16px,
 * 600) with the created date right-aligned in --text-muted, the folder path in
 * --text-faint below, then the snippets with matches wrapped in a marked span.
 *
 * Selection applies the 1.02 scale and accent border when enabled. Text runs
 * are appended as alternating spans, never as HTML, which is how marks survive
 * the no-innerHTML rule. Dumb component — it reads its model and calls back, it
 * never touches the index.
 *
 * LISTENER OWNERSHIP
 * ------------------
 * A card is not created by a Plugin, so there is no `registerDomEvent` to
 * inherit. It owns a private `Component` instead: every listener goes through
 * `Component.registerDomEvent`, and `destroy()` unloads it. The modal registers
 * each card's `destroy` with its own lifecycle component, so closing the modal
 * tears the whole tree down in one step.
 */

import { Component, Keymap } from 'obsidian';
import { t } from '../i18n/index';
import type {
	Millis,
	OpenTarget,
	ResultCardCallbacks,
	ResultCardModel,
	Snippet,
	Span,
	VaultPath,
} from '../types';

/** U+2026 HORIZONTAL ELLIPSIS, per the mockup, with no space to the adjacent text. */
const ELLIPSIS = '…';

/** The separator the mockup renders around every path segment. */
const PATH_SEPARATOR = ' / ';

/** Prefix of the DOM id of a card, referenced by the input's `aria-activedescendant`. */
export const CARD_ID_PREFIX = 'sift-result-';

/** One run of snippet text, already classified. */
interface TextRun {
	start: number;
	end: number;
	/** Inside {@link Snippet.focus} — the sentence carrying the hit. */
	focused: boolean;
	/** Inside one of {@link Snippet.marks}. */
	marked: boolean;
}

export class ResultCard {
	readonly el: HTMLElement;

	private model: ResultCardModel;
	private readonly callbacks: ResultCardCallbacks;
	private readonly lifecycle = new Component();

	private readonly titleEl: HTMLElement;
	private readonly similarEl: HTMLElement;
	private readonly dateEl: HTMLElement;
	private readonly pathEl: HTMLElement;
	private readonly snippetsEl: HTMLElement;

	constructor(parent: HTMLElement, model: ResultCardModel, callbacks: ResultCardCallbacks) {
		this.model = model;
		this.callbacks = callbacks;

		this.el = parent.createDiv({
			cls: 'sift-card',
			attr: {
				id: `${CARD_ID_PREFIX}${model.index}`,
				role: 'option',
				'aria-selected': model.selected ? 'true' : 'false',
			},
		});

		const head = this.el.createDiv({ cls: 'sift-card__head' });
		this.titleEl = head.createDiv({ cls: 'sift-card__title' });
		this.similarEl = head.createDiv({ cls: 'sift-card__similar' });
		this.dateEl = head.createDiv({ cls: 'sift-card__date' });
		this.pathEl = this.el.createDiv({ cls: 'sift-card__path' });
		this.snippetsEl = this.el.createDiv({ cls: 'sift-card__snippets' });

		this.lifecycle.load();
		this.lifecycle.registerDomEvent(this.el, 'click', (evt: MouseEvent) => {
			this.callbacks.onSelect(this.model.index);
			this.callbacks.onOpen(this.model.item, targetFromEvent(evt));
		});
		this.lifecycle.registerDomEvent(this.el, 'mousedown', () => {
			this.callbacks.onSelect(this.model.index);
		});

		this.render();
	}

	/** Re-renders in place. Used when snippets arrive after the card was first drawn. */
	update(model: ResultCardModel): void {
		this.model = model;
		this.el.setAttr('id', `${CARD_ID_PREFIX}${model.index}`);
		this.render();
	}

	setSelected(selected: boolean): void {
		this.model = { ...this.model, selected };
		this.applySelection();
	}

	/**
	 * Scrolls the card into the results viewport when it sits outside it. Reads
	 * layout only — under a test DOM every metric is 0 and the method is a no-op.
	 */
	scrollIntoViewIfNeeded(): void {
		const scroller = this.el.closest('.sift-results');
		if (!(scroller instanceof HTMLElement)) return;
		const viewport = scroller.clientHeight;
		if (viewport <= 0) return;

		const cardTop = this.el.offsetTop;
		const cardBottom = cardTop + this.el.offsetHeight;
		const viewTop = scroller.scrollTop;
		const viewBottom = viewTop + viewport;

		if (cardTop < viewTop) {
			scroller.scrollTop = Math.max(0, cardTop - SCROLL_PADDING);
		} else if (cardBottom > viewBottom) {
			scroller.scrollTop = cardBottom - viewport + SCROLL_PADDING;
		}
	}

	destroy(): void {
		this.lifecycle.unload();
		this.el.detach();
	}

	/**
	 * Locale-aware short date.
	 *
	 * Two-digit day and month, four-digit year: '14.03.2026' for de (the value
	 * the mockup shows), '03/14/2026' for en. The order and the separators come
	 * from `Intl`, so a locale Sift does not translate still reads correctly.
	 */
	static formatDate(value: Millis, locale: string): string {
		if (!Number.isFinite(value)) return '';
		try {
			return new Intl.DateTimeFormat(locale, {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
			}).format(new Date(value));
		} catch {
			return new Intl.DateTimeFormat('en', {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
			}).format(new Date(value));
		}
	}

	/** 'Projekte/2026/Büro-Umbau' -> 'Projekte / 2026 / Büro-Umbau'. Vault root gets its own label. */
	static formatFolder(folder: VaultPath): string {
		const segments = folder.split('/').filter((segment) => segment.length > 0);
		if (segments.length === 0) return t('result.folderRoot');
		return segments.join(PATH_SEPARATOR);
	}

	/* ---------------------------------------------------------------------- */
	/* Rendering                                                              */
	/* ---------------------------------------------------------------------- */

	private render(): void {
		const { item, dateLabel, folderLabel } = this.model;
		this.titleEl.setText(item.title);
		this.dateEl.setText(dateLabel);
		this.pathEl.setText(folderLabel);
		this.renderSimilar();
		this.renderSnippets();
		this.applySelection();
	}

	/** The "similar: …" label the plan asks for on fuzzy hits. Empty otherwise. */
	private renderSimilar(): void {
		const terms = this.model.item.similarTo;
		if (terms.length === 0) {
			this.similarEl.setText('');
			this.similarEl.removeClass('sift-card__similar--visible');
			return;
		}
		this.similarEl.setText(t('result.similar', { term: terms.join(', ') }));
		this.similarEl.addClass('sift-card__similar--visible');
	}

	/**
	 * The snippet area always exists, even with no snippets, so a card does not
	 * change height when snippets arrive after the first paint.
	 */
	private renderSnippets(): void {
		this.snippetsEl.empty();
		for (const snippet of this.model.item.snippets) {
			this.renderSnippet(snippet);
		}
	}

	private renderSnippet(snippet: Snippet): void {
		const row = this.snippetsEl.createDiv({ cls: 'sift-card__snippet' });
		if (snippet.leadingEllipsis) {
			row.createSpan({ cls: 'sift-snippet__ellipsis', text: ELLIPSIS });
		}

		// The body's concatenated textContent is exactly `snippet.text`; the
		// ellipses live outside it so that invariant stays checkable.
		const body = row.createSpan({ cls: 'sift-snippet__body' });
		let sentence: HTMLElement | null = null;
		for (const run of splitRuns(snippet)) {
			const text = snippet.text.slice(run.start, run.end);
			if (text.length === 0) continue;
			if (!run.focused) sentence = null;
			else if (sentence === null) sentence = body.createSpan({ cls: 'sift-snippet__sentence' });
			const host = sentence ?? body;
			if (run.marked) host.createEl('mark', { cls: 'sift-mark', text });
			else host.createSpan({ cls: 'sift-snippet__text', text });
		}

		if (snippet.trailingEllipsis) {
			row.createSpan({ cls: 'sift-snippet__ellipsis', text: ELLIPSIS });
		}
	}

	private applySelection(): void {
		const { selected, animateSelection } = this.model;
		this.el.toggleClass('sift-card--selected', selected);
		this.el.toggleClass('sift-card--zoomed', selected && animateSelection);
		this.el.setAttr('aria-selected', selected ? 'true' : 'false');
	}
}

/** Distance kept between a scrolled-to card and the viewport edge, in pixels. */
const SCROLL_PADDING = 14;

/** Modifier click opens in a new tab, shift-click in a split, per the plan's keyboard map. */
function targetFromEvent(evt: MouseEvent): OpenTarget {
	if (evt.shiftKey) return 'split';
	return Keymap.isModEvent(evt) === false ? 'current' : 'new-tab';
}

/**
 * Cuts `snippet.text` into runs at every mark and focus boundary.
 *
 * Defensive on purpose: marks are sorted, clamped to the text and merged, and
 * the focus span is clamped too, so a malformed snippet can never drop or
 * duplicate a character. The runs always tile `[0, text.length)` exactly.
 */
function splitRuns(snippet: Snippet): TextRun[] {
	const length = snippet.text.length;
	if (length === 0) return [];

	const marks = normalizeMarks(snippet.marks, length);
	const focus = clampSpan(snippet.focus, length);

	const cuts = new Set<number>([0, length]);
	if (focus !== null) {
		cuts.add(focus.start);
		cuts.add(focus.end);
	}
	for (const mark of marks) {
		cuts.add(mark.start);
		cuts.add(mark.end);
	}

	const boundaries = [...cuts].sort((a, b) => a - b);
	const runs: TextRun[] = [];
	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i];
		const end = boundaries[i + 1];
		runs.push({
			start,
			end,
			focused: focus !== null && start >= focus.start && end <= focus.end,
			marked: marks.some((mark) => start >= mark.start && end <= mark.end),
		});
	}
	return runs;
}

/** Sorted, clamped, non-overlapping copy of the mark list. */
function normalizeMarks(marks: readonly Span[], length: number): Span[] {
	const clamped: Span[] = [];
	for (const mark of marks) {
		const span = clampSpan(mark, length);
		if (span !== null) clamped.push(span);
	}
	clamped.sort((a, b) => a.start - b.start || a.end - b.end);

	const merged: Span[] = [];
	for (const span of clamped) {
		const last = merged[merged.length - 1];
		if (last !== undefined && span.start <= last.end) {
			last.end = Math.max(last.end, span.end);
		} else {
			merged.push({ start: span.start, end: span.end });
		}
	}
	return merged;
}

/** `null` when the span is empty or entirely outside the text. */
function clampSpan(span: Span | null | undefined, length: number): Span | null {
	if (span === null || span === undefined) return null;
	const start = Math.max(0, Math.min(span.start, length));
	const end = Math.max(0, Math.min(span.end, length));
	return end > start ? { start, end } : null;
}
