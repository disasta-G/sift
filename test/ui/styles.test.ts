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

	it('scales the selected card and animates it for 120 ms', () => {
		expect(BODY).toMatch(/\.sift-card\b[^{]*\{[^}]*transition:\s*transform 120ms ease-out/);
		expect(BODY).toMatch(/\.sift-card--zoomed\s*\{[^}]*transform:\s*scale\(1\.02\)/);
		expect(BODY).toMatch(/\.sift-card--zoomed\s*\{[^}]*will-change:\s*transform/);
	});

	it('drops the transition under reduced motion but keeps the scale', () => {
		const block = BODY.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
		expect(block).not.toBeNull();
		const body = block?.[1] ?? '';
		expect(body).toMatch(/\.sift-card\s*\{[^}]*transition:\s*none/);
		expect(body).not.toMatch(/transform:/);
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

	it('carries no v1.1 class', () => {
		expect(BODY).not.toMatch(/\.sift-(ai|term|upsell|quota|trial)\b/);
	});
});
