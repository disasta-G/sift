import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The mechanical half of AC-24: no hardcoded colour, every selector namespaced.
 * The appearance half is a manual pass through the themes and cannot be scripted.
 */

const CSS = readFileSync(join(process.cwd(), 'styles.css'), 'utf8');

/** Comment-free copy; a hex value inside a comment is documentation, not a colour. */
const BODY = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
	prelude: string;
	/** True when the rule sits inside a `@keyframes` block, where `from`/`to` are not selectors. */
	inKeyframes: boolean;
}

/** Every `prelude {` in the file, with its nesting context. */
function rules(css: string): Rule[] {
	const found: Rule[] = [];
	const stack: boolean[] = [];
	let prelude = '';
	for (const char of css) {
		if (char === '{') {
			const trimmed = prelude.trim();
			const inKeyframes = stack.some((flag) => flag);
			found.push({ prelude: trimmed, inKeyframes });
			stack.push(inKeyframes || /^@keyframes\b/.test(trimmed));
			prelude = '';
		} else if (char === '}') {
			stack.pop();
			prelude = '';
		} else {
			prelude += char;
		}
	}
	return found;
}

describe('styles.css', () => {
	it('exists and uses Obsidian variables', () => {
		expect(CSS.length).toBeGreaterThan(0);
		expect(CSS.match(/var\(--/g)?.length ?? 0).toBeGreaterThan(30);
	});

	it('contains no hardcoded colour', () => {
		expect(BODY).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(BODY).not.toMatch(/\brgba?\(/);
		expect(BODY).not.toMatch(/\bhsla?\(/);
		// The only literal colour keywords allowed are these two.
		const keywords = BODY.match(/:\s*(white|black|red|blue|green|gray|grey|yellow|orange)\b/g) ?? [];
		expect(keywords).toEqual([]);
	});

	it('namespaces every selector with the sift- prefix', () => {
		for (const rule of rules(BODY)) {
			if (rule.inKeyframes) continue;
			if (rule.prelude.startsWith('@')) continue;
			for (const part of rule.prelude.split(',')) {
				const selector = part.trim();
				if (selector.length === 0) continue;
				expect(selector, `selector "${selector}"`).toContain('sift-');
			}
		}
	});

	it('starts every top-level class selector with .sift-', () => {
		const classSelectors = BODY.match(/^\s*\.[A-Za-z][\w-]*/gm) ?? [];
		expect(classSelectors.length).toBeGreaterThan(20);
		for (const selector of classSelectors) {
			expect(selector.trim().startsWith('.sift-'), selector).toBe(true);
		}
	});

	it('uses !important nowhere', () => {
		expect(BODY).not.toContain('!important');
	});

	it('marks the selected card with a border, a shadow and a lifted fill, and no transform', () => {
		const rule = BODY.match(/\.sift-card--selected\s*\{([^}]*)\}/)?.[1] ?? '';
		expect(rule).toContain('border-color: var(--interactive-accent)');
		expect(rule).toContain('box-shadow: var(--shadow-l2)');
		// A translucent overlay laid OVER the card's own fill, so it lifts a dark
		// card and tints a white one. As a background-color it would composite
		// against the modal instead and invert in themes whose primary is lighter
		// than their secondary.
		expect(rule).toMatch(
			/background-image:\s*linear-gradient\(var\(--background-modifier-hover\), var\(--background-modifier-hover\)\)/,
		);
		// The 1.02 scale is gone for good: a non-integer transform resamples the
		// text of the one card the user is reading.
		expect(BODY).not.toMatch(/transform:\s*scale/);
		expect(BODY).not.toContain('sift-card--zoomed');
		expect(BODY).not.toMatch(/\.sift-card\b[^{]*\{[^}]*transition:/);
	});

	it('leaves no reduced-motion rule that switches nothing off', () => {
		const block = BODY.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
		expect(block).not.toBeNull();
		const body = block?.[1] ?? '';
		// The card has no transition left to disable, so it is not listed; what is
		// listed really does move.
		expect(body).not.toMatch(/\.sift-card\s*\{/);
		expect(body).toMatch(/\.sift-toggle__thumb\s*\{[^}]*transition:\s*none/);
		expect(body).toMatch(/\.sift-flash\s*\{[^}]*animation:\s*none/);
	});

	it('paints the calendar range from Obsidian variables, ends apart from the days between', () => {
		const ends = BODY.match(/\.sift-cal__day--start,\s*\.sift-cal__day--end\s*\{([^}]*)\}/)?.[1] ?? '';
		expect(ends).toContain('background-color: var(--interactive-accent)');
		expect(ends).toContain('color: var(--text-on-accent)');

		const inside = BODY.match(/\.sift-cal__day--inside\s*\{([^}]*)\}/)?.[1] ?? '';
		expect(inside).toContain('background-color: var(--background-modifier-hover)');

		// The popover is absolutely positioned, so the calendar cannot make the
		// filter bar taller.
		expect(BODY).toMatch(/\.sift-date-menu\s*\{[^}]*position:\s*absolute/);
	});

	it('lets the measured placement move the date popover, and keeps the mockup default as the fallback', () => {
		// `.sift-modal` clips at overflow: hidden, so a chip near the right edge
		// used to have the last calendar columns and the clear button cut off. The
		// placement is measured in JS because it depends on where the chip lands
		// after the bar has wrapped; CSS only has to consume it — and to fall back
		// to the mockup's own left-aligned popover when nothing was measured.
		const rule = BODY.match(/\.sift-date-menu\s*\{([^}]*)\}/)?.[1] ?? '';
		expect(rule).toContain('left: var(--sift-date-menu-left, 0px)');
		expect(rule).toContain('max-width: var(--sift-date-menu-max-width, none)');
	});

	it('keeps the modal geometry the plan asks for', () => {
		expect(BODY).toMatch(/\.sift-modal\s*\{[\s\S]*?width:\s*min\(70vw, 1100px\)/);
		expect(BODY).toMatch(/\.sift-modal\s*\{[\s\S]*?height:\s*80vh/);
	});

	it('lets the filter bar wrap and the result list scroll', () => {
		expect(BODY).toMatch(/\.sift-filters\s*\{[^}]*flex-wrap:\s*wrap/);
		expect(BODY).toMatch(/\.sift-results\s*\{[^}]*overflow-y:\s*auto/);
		expect(BODY).toMatch(/\.sift-results\s*\{[^}]*min-height:\s*0/);
	});

	it('gives every filter control a resting outline, so an empty chip still reads as a control', () => {
		// The mockup only ever draws a chip that HAS a value. Rendered strictly to
		// that spec, "All folders", "Created" and the sort label came out as bare
		// text with no affordance at all.
		expect(BODY).toMatch(/\.sift-chip\s*\{[^}]*border:\s*1px solid var\(--background-modifier-border\)/);
		expect(BODY).toMatch(/\.sift-sort\s*\{[^}]*border:\s*1px solid var\(--background-modifier-border\)/);
		// The filled state stays exactly as the mockup has it.
		expect(BODY).toMatch(/\.sift-chip--active\s*\{[^}]*background-color:\s*var\(--background-secondary\)/);
	});

	it('keeps the curation controls visible rather than hover-only, and marks a kept card without moving it', () => {
		// A control revealed on hover is reachable by neither the keyboard nor a
		// screen reader, so the two buttons are always in the layout.
		const actions = BODY.match(/\.sift-card__actions\s*\{([^}]*)\}/)?.[1] ?? '';
		expect(actions).toMatch(/display:\s*flex/);
		expect(BODY).not.toMatch(/\.sift-card:hover\s+\.sift-card__actions/);
		expect(BODY).toMatch(/\.sift-card__action:focus-visible\s*\{[^}]*outline:/);

		// An inset edge, not a border: the border belongs to the selection, and a
		// kept card can be the selected one at the same time.
		expect(BODY).toMatch(/\.sift-card--kept\s*\{[^}]*box-shadow:\s*inset 3px 0 0 0 var\(--interactive-accent\)/);
		expect(BODY).toMatch(
			/\.sift-card--selected\.sift-card--kept\s*\{[^}]*box-shadow:\s*var\(--shadow-l2\), inset 3px/,
		);
	});

	it('wraps the hints, not the footer, so the curation controls stay on the right', () => {
		expect(BODY).toMatch(/\.sift-footer__hints\s*\{[^}]*flex-wrap:\s*wrap/);
		expect(BODY).not.toMatch(/\.sift-footer\s*\{[^}]*flex-wrap:/);
		expect(BODY).toMatch(/\.sift-curate--visible\s*\{[^}]*display:\s*flex/);
		expect(BODY).toMatch(/\.sift-curate__button--hidden\s*\{[^}]*display:\s*none/);
	});

	it('drops the reserved excerpt line only where an excerpt can never arrive', () => {
		expect(BODY).toMatch(/\.sift-card__snippets\s*\{[^}]*min-height:\s*21px/);
		expect(BODY).toMatch(/\.sift-card__snippets--blank\s*\{[^}]*min-height:\s*0/);
	});

	it('carries no v1.1 class', () => {
		expect(BODY).not.toMatch(/\.sift-(ai|term|upsell|quota|trial)\b/);
	});
});
