/**
 * ResultCard — one result card, rendered exactly as the mockup: title (16px,
 * 600) with the created date right-aligned in --text-muted, the folder path in
 * --text-faint below, then the snippets with matches wrapped in a marked span.
 *
 * Selection is an accent border plus a slightly lifted fill; it carries no
 * transform. Text runs are appended as alternating spans, never as HTML, which
 * is how marks survive the no-innerHTML rule. Dumb component — it reads its
 * model and calls back, it never touches the index.
 *
 * CURATION CONTROLS
 * -----------------
 * With a {@link CardCuration} the head grows two buttons, "keep" and "dismiss".
 * They are real `<button>` elements with `aria-label`s rather than a hover-only
 * affordance, so they are reachable and named for the keyboard and for assistive
 * tech, and they stop their own events so the card underneath neither selects
 * nor opens. The card holds no curation state of its own: the modal owns it for
 * the duration of one search run and pushes it in through the constructor and
 * {@link ResultCard.setKept}.
 *
 * MULTI-LINE EXCERPTS
 * -------------------
 * A {@link Snippet} covers up to five LINES of the note, so `snippet.text` may
 * contain line breaks. They are rendered as `<br>` between the runs of a line,
 * not as `white-space: pre`: the excerpt is note text the card does not control,
 * and preserved whitespace would let one long unbroken line push the whole modal
 * into horizontal scrolling. The runs themselves are unchanged, so a mark that
 * sits on one line still covers exactly the characters it covered before, and
 * `body.textContent` is still `snippet.text` minus the break characters.
 *
 * LISTENER OWNERSHIP
 * ------------------
 * A card is not created by a Plugin, so there is no `registerDomEvent` to
 * inherit. It owns a private `Component` instead: every listener goes through
 * `Component.registerDomEvent`, and `destroy()` unloads it. The modal registers
 * each card's `destroy` with its own lifecycle component, so closing the modal
 * tears the whole tree down in one step.
 */

import { Component, Keymap, setIcon } from 'obsidian';
import { t } from '../i18n/index';
import type { TranslationKey } from '../i18n/index';
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

/** The "keep" button's icon, unkept and kept. Two shapes, not one shape in two colours. */
const KEEP_ICON_OFF = 'bookmark';
const KEEP_ICON_ON = 'bookmark-check';

/** Prefix of the DOM id of a card, referenced by the input's `aria-activedescendant`. */
export const CARD_ID_PREFIX = 'sift-result-';

/** U+000A LINE FEED and U+000D CARRIAGE RETURN, the two break characters an excerpt can carry. */
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;

/**
 * The two curation controls a card carries, and the state of the first of them.
 *
 * Optional: a card built without this object has no buttons at all, which is
 * what keeps `ResultCard` usable outside a curated run. The state lives with the
 * modal — one search run owns it, nothing is persisted — so the card only
 * renders what it is told and reports the two gestures back by row index.
 */
export interface CardCuration {
	/** True when the user has marked this result as one to keep. */
	kept: boolean;
	onKeep(index: number): void;
	onDismiss(index: number): void;
}

/** One run of snippet text, already classified. */
interface TextRun {
	start: number;
	end: number;
	/** Inside {@link Snippet.focus} — the sentence carrying the hit. */
	focused: boolean;
	/** Inside one of {@link Snippet.marks}. */
	marked: boolean;
	/** The run IS a line break (`\n`, `\r` or `\r\n`) and renders as `<br>` rather than as text. */
	lineBreak: boolean;
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
	private readonly keepEl: HTMLButtonElement | null = null;

	constructor(
		parent: HTMLElement,
		model: ResultCardModel,
		callbacks: ResultCardCallbacks,
		curation?: CardCuration,
	) {
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

		this.lifecycle.load();
		if (curation !== undefined) {
			const actions = head.createDiv({ cls: 'sift-card__actions' });
			this.keepEl = this.buildAction(actions, 'keep', KEEP_ICON_OFF, 'curate.keep', () => {
				curation.onKeep(this.model.index);
			});
			this.buildAction(actions, 'dismiss', 'x', 'curate.dismiss', () => {
				curation.onDismiss(this.model.index);
			});
		}

		this.pathEl = this.el.createDiv({ cls: 'sift-card__path' });
		this.snippetsEl = this.el.createDiv({ cls: 'sift-card__snippets' });

		this.lifecycle.registerDomEvent(this.el, 'click', (evt: MouseEvent) => {
			this.callbacks.onSelect(this.model.index);
			this.callbacks.onOpen(this.model.item, targetFromEvent(evt));
		});
		this.lifecycle.registerDomEvent(this.el, 'mousedown', () => {
			this.callbacks.onSelect(this.model.index);
		});

		this.render();
		this.setKept(curation?.kept === true);
	}

	/**
	 * One curation button.
	 *
	 * A real `<button>` with an `aria-label`, so the control is in the tab order
	 * and has a name — a hover-only affordance would be neither. Both the click
	 * and the mousedown stop at the button: the card's own handlers sit on the
	 * ancestor and would otherwise select the row and open the note underneath
	 * the very gesture that was meant to sort it.
	 */
	private buildAction(
		actions: HTMLElement,
		kind: 'keep' | 'dismiss',
		icon: string,
		label: TranslationKey,
		run: () => void,
	): HTMLButtonElement {
		const button = actions.createEl('button', {
			cls: `sift-card__action sift-card__action--${kind}`,
			attr: { type: 'button', 'aria-label': t(label) },
		});
		setIcon(button, icon);
		this.lifecycle.registerDomEvent(button, 'click', (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			run();
		});
		this.lifecycle.registerDomEvent(button, 'mousedown', (evt: MouseEvent) => {
			evt.stopPropagation();
		});
		return button;
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
	 * Paints the "kept" mark. A no-op on a card built without curation, which is
	 * why the modal may call it unconditionally.
	 */
	setKept(kept: boolean): void {
		this.el.toggleClass('sift-card--kept', kept);
		this.keepEl?.setAttr('aria-pressed', kept ? 'true' : 'false');
		const keepEl = this.keepEl;
		if (keepEl === null) return;
		keepEl.toggleClass('sift-card__action--on', kept);
		// The icon itself changes, not only its colour: an accent-coloured outline
		// and a muted one are the same shape, and on the row the eye scans that is
		// the difference between "kept" and "not kept". A filled bookmark with a
		// check reads as done at a glance and does not depend on the theme's
		// accent being distinguishable from its muted text.
		setIcon(keepEl, kept ? KEEP_ICON_ON : KEEP_ICON_OFF);
	}

	/**
	 * Scrolls the card into the results viewport when it sits outside it, keeping
	 * {@link SCROLL_MARGIN} clear at whichever edge it came to rest against. Reads
	 * layout only — under a test DOM every metric is 0 and the method is a no-op.
	 *
	 * WHY THE MARGIN IS NOT OPTIONAL
	 * ------------------------------
	 * `.sift-results` clips at `overflow-y: auto`, so a card that lands flush with
	 * the scrollport edge loses the outer row of its own border — the selected
	 * card's frame then reads as open at the top, which is what the owner saw.
	 * Bottom-aligning a card that is TALLER than the scrollport does exactly that:
	 * `bottom - viewport` puts its top above the edge by however much it does not
	 * fit. A card that cannot fit is therefore top-aligned instead, the way
	 * `scroll-margin-block` plus `scrollIntoView({ block: 'nearest' })` would
	 * resolve it. (The native pair is not used: the card is scrolled by explicit
	 * `scrollTop` arithmetic, deliberately, so that the correction cannot rebuild
	 * the rendered window under a mouse button that is still down — and
	 * `scroll-margin` has no effect on an assignment to `scrollTop`.)
	 */
	scrollIntoViewIfNeeded(): void {
		const scroller = this.el.closest('.sift-results');
		// Cross-window safe; see the note in FilterBar.popoverBounds().
		if (scroller === null || !scroller.instanceOf(HTMLElement)) return;
		const viewport = scroller.clientHeight;
		if (viewport <= 0) return;

		const cardTop = this.el.offsetTop;
		const cardHeight = this.el.offsetHeight;
		const cardBottom = cardTop + cardHeight;
		const viewTop = scroller.scrollTop;
		const viewBottom = viewTop + viewport;
		const fits = cardHeight + 2 * SCROLL_MARGIN <= viewport;

		if (!fits || cardTop - SCROLL_MARGIN < viewTop) {
			scroller.scrollTop = Math.max(0, cardTop - SCROLL_MARGIN);
		} else if (cardBottom + SCROLL_MARGIN > viewBottom) {
			scroller.scrollTop = cardBottom + SCROLL_MARGIN - viewport;
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
	 *
	 * THE ONE EXCEPTION IS A HIT WITH NO MATCH
	 * ----------------------------------------
	 * A filter-only run — a date range or a folder and no search term — produces
	 * hits whose `matches` list is empty, and an excerpt is built AROUND a match,
	 * so those cards can never grow one. Reserving a blank line for an excerpt
	 * that is not coming is not stability, it is a gap under the path that reads
	 * as a rendering fault, so that one case drops the reservation. Everything
	 * else keeps it: a card that HAS matches is only waiting for its file to be
	 * read, and must not jump when the read lands.
	 */
	private renderSnippets(): void {
		this.snippetsEl.empty();
		for (const snippet of this.model.item.snippets) {
			this.renderSnippet(snippet);
		}
		const unreachable = this.model.item.snippets.length === 0 && this.model.item.matches.length === 0;
		this.snippetsEl.toggleClass('sift-card__snippets--blank', unreachable);
	}

	private renderSnippet(snippet: Snippet): void {
		const row = this.snippetsEl.createDiv({ cls: 'sift-card__snippet' });
		if (snippet.leadingEllipsis) {
			row.createSpan({ cls: 'sift-snippet__ellipsis', text: ELLIPSIS });
		}

		// The body's concatenated textContent is exactly `snippet.text` minus its
		// line breaks, which became `<br>` elements; the ellipses live outside it so
		// that invariant stays checkable.
		const body = row.createSpan({ cls: 'sift-snippet__body' });
		let sentence: HTMLElement | null = null;
		for (const run of splitRuns(snippet)) {
			if (run.lineBreak) {
				// A sentence span never straddles a break: one span per line keeps the
				// focus colouring a property of the text and not of the line box.
				sentence = null;
				body.createEl('br');
				continue;
			}
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

	/**
	 * The selected card carries the accent border, the shadow and the lifted fill
	 * from `.sift-card--selected` — and nothing else.
	 *
	 * It used to also carry `transform: scale(1.02)`. A non-integer scale
	 * resamples the glyphs, which is the soft text the owner reported, and a
	 * default that blurs the one card the user is reading is not worth keeping;
	 * it is gone rather than made optional. The flag that once switched it
	 * is gone with it.
	 */
	private applySelection(): void {
		const selected = this.model.selected;
		this.el.toggleClass('sift-card--selected', selected);
		this.el.setAttr('aria-selected', selected ? 'true' : 'false');
	}
}

/**
 * Distance kept between a scrolled-to card and the viewport edge, in pixels.
 *
 * It is the padding of `.sift-results`, so a card scrolled to either end comes
 * to rest exactly where the list's own padding puts it, with the whole 1px
 * accent border and its shadow inside the scrollport.
 */
const SCROLL_MARGIN = 14;

/** Modifier click opens in a new tab, shift-click in a split, per the plan's keyboard map. */
function targetFromEvent(evt: MouseEvent): OpenTarget {
	if (evt.shiftKey) return 'split';
	return Keymap.isModEvent(evt) === false ? 'current' : 'new-tab';
}

/**
 * Cuts `snippet.text` into runs at every mark, focus and line boundary.
 *
 * Defensive on purpose: marks are sorted, clamped to the text and merged, and
 * the focus span is clamped too, so a malformed snippet can never drop or
 * duplicate a character. The runs always tile `[0, text.length)` exactly — the
 * break characters included, as runs of their own that the renderer turns into
 * `<br>`.
 */
function splitRuns(snippet: Snippet): TextRun[] {
	const length = snippet.text.length;
	if (length === 0) return [];

	const marks = normalizeMarks(snippet.marks, length);
	const focus = clampSpan(snippet.focus, length);
	const breaks = lineBreakSpans(snippet.text);

	const cuts = new Set<number>([0, length]);
	if (focus !== null) {
		cuts.add(focus.start);
		cuts.add(focus.end);
	}
	for (const mark of marks) {
		cuts.add(mark.start);
		cuts.add(mark.end);
	}
	for (const span of breaks) {
		cuts.add(span.start);
		cuts.add(span.end);
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
			lineBreak: breaks.some((span) => start >= span.start && end <= span.end),
		});
	}
	return runs;
}

/**
 * The line breaks of an excerpt, as spans of the text: `\r\n` first, so a
 * Windows file does not produce two blank-looking breaks where it has one.
 *
 * Exported shape stays internal; the offsets are relative to `snippet.text`, in
 * the same domain as its marks.
 */
function lineBreakSpans(text: string): Span[] {
	const spans: Span[] = [];
	for (let at = 0; at < text.length; at++) {
		const code = text.charCodeAt(at);
		if (code !== CHAR_LF && code !== CHAR_CR) continue;
		const end = code === CHAR_CR && text.charCodeAt(at + 1) === CHAR_LF ? at + 2 : at + 1;
		spans.push({ start: at, end });
		at = end - 1;
	}
	return spans;
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
