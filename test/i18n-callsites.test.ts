/**
 * Every visible string has to come from `src/i18n/`. `test/i18n.test.ts` proves
 * the two bundles agree, but a bundle is only half of the promise: nothing
 * stopped an interface file from writing English straight into the DOM and
 * leaving the German key orphaned. Replacing `t('footer.close')` with
 * `'Close the search'` used to pass the whole suite, ESLint and the scope guard,
 * because the tests that pin those strings run under `setLanguage('en')` and so
 * compare English against English.
 *
 * This file closes that hole with two source scans over `src/ui/*.ts` and
 * `src/settings.ts`:
 *
 *   1. DISPLAY SINKS. Every argument reaching `setText`, `setName`, `setDesc`,
 *      `setPlaceholder`, `setButtonText`, `setTooltip`, `new Notice`, the second
 *      argument of `addOption`, and the `text:` / `placeholder:` / `aria-label:`
 *      options of `createEl` and friends has to be a `t(...)` call or something
 *      that is not a string literal at all. A literal longer than two characters
 *      in one of those positions fails.
 *
 *   2. PROSE ANYWHERE. A literal that reads like language - more than one word,
 *      or a single capitalised word - fails wherever it stands in those files,
 *      even outside a known sink. That is what catches text handed to a helper
 *      of the file's own making, such as `buildHint(footer, 'Esc', 'Close')`,
 *      which scan 1 cannot see.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It is a source scan, not a type check. A string built somewhere else and
 * passed in as a variable is invisible to it; so is a lower-case single word in
 * a helper, which is indistinguishable from an identifier. The two scans
 * together cover every route the interface currently uses to put characters on
 * the screen, and any new route has to pass scan 2 to stay unnoticed.
 *
 * Node APIs are fine here: this file reads the sources it checks and never ships.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The files that build the interface. Everything a user reads is written here. */
const INTERFACE_FILES = [
	'src/ui/FilterBar.ts',
	'src/ui/ResultCard.ts',
	'src/ui/SearchModal.ts',
	'src/settings.ts',
];

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Calls whose first argument is put on the screen verbatim. */
const DISPLAY_CALLS = new Set([
	'setText',
	'setName',
	'setDesc',
	'setPlaceholder',
	'setButtonText',
	'setTooltip',
	'Notice',
]);

/** Object properties that become visible text or an accessible name. */
const DISPLAY_PROPERTIES = new Set(['text', 'placeholder', 'aria-label', 'ariaLabel']);

/**
 * `title:` is a tooltip inside an `attr: { ... }` object and a translation-key
 * field everywhere else in this codebase, so it is only a display sink there.
 */
const ATTRIBUTE_ONLY_PROPERTIES = new Set(['title']);

/** A literal next to one of these is being compared, not displayed. */
const COMPARISONS = new Set(['===', '!==', '==', '!=']);

/**
 * The only literals a display sink may carry. Each one is punctuation rather
 * than language: it reads the same in English and in German, so translating it
 * would produce two identical bundle entries.
 */
const ALLOWED_IN_DISPLAY_SINK: ReadonlyArray<{ text: string; reason: string }> = [
	{ text: ' / ', reason: 'Path separator between folder names; identical in both languages.' },
	{ text: ' · ', reason: 'Separator between the parts of a result card meta line.' },
	{ text: ' — ', reason: 'Separator between a label and its value in a status line.' },
	{ text: '\u00d7', reason: 'The multiplication sign used as the "remove this chip" glyph.' },
	{ text: '\u2026', reason: 'Ellipsis marking a snippet that is cut off; punctuation, not a word.' },
];

/**
 * Literals that look like language but never reach the screen: DOM key names
 * from `KeyboardEvent.key` and Obsidian's own modifier spellings. They are
 * platform identifiers and are wrong when translated. Displayed key hints are a
 * different thing and go through `t('footer.key.*')`, which is why `Esc` (the
 * hint) is absent here while `Escape` (the event key) is present.
 */
const NON_DISPLAY_IDENTIFIERS: ReadonlyArray<{ text: string; reason: string }> = [
	{ text: 'Enter', reason: 'KeyboardEvent.key value.' },
	{ text: 'Escape', reason: 'KeyboardEvent.key value.' },
	{ text: 'Tab', reason: 'KeyboardEvent.key value.' },
	{ text: 'Home', reason: 'KeyboardEvent.key value.' },
	{ text: 'End', reason: 'KeyboardEvent.key value.' },
	{ text: 'ArrowUp', reason: 'KeyboardEvent.key value.' },
	{ text: 'ArrowDown', reason: 'KeyboardEvent.key value.' },
	{ text: 'PageUp', reason: 'KeyboardEvent.key value.' },
	{ text: 'PageDown', reason: 'KeyboardEvent.key value.' },
	{ text: 'Mod', reason: 'Obsidian modifier name for Ctrl on Windows and Cmd on macOS.' },
	{ text: 'Shift', reason: 'Obsidian modifier name.' },
	{ text: 'Alt', reason: 'Obsidian modifier name.' },
	{ text: 'Ctrl', reason: 'Obsidian modifier name.' },
	{ text: 'Meta', reason: 'Obsidian modifier name.' },
];

/** Longest an allowlist entry may be. An exception is a token or a glyph, never a sentence. */
const MAX_ALLOWLIST_LENGTH = 12;

const displaySinkAllowlist = new Set(ALLOWED_IN_DISPLAY_SINK.map((entry) => entry.text));
const proseAllowlist = new Set([
	...ALLOWED_IN_DISPLAY_SINK.map((entry) => entry.text),
	...NON_DISPLAY_IDENTIFIERS.map((entry) => entry.text),
]);

/* -------------------------------------------------------------------------- */
/* A very small TypeScript lexer                                              */
/* -------------------------------------------------------------------------- */

interface Token {
	/** `string` covers quoted strings and template literals; `punct` covers operators too. */
	kind: 'string' | 'name' | 'punct';
	value: string;
	line: number;
}

const NAME_CHAR = /[A-Za-z0-9_$]/;
const STRUCTURAL = '(){}[],;:';
/** After one of these a `/` divides; anywhere else it opens a regular expression. */
const DIVIDES_AFTER = new Set([')', ']']);
const NOT_A_VALUE = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void']);

/**
 * Produces the token stream the scans below walk. Strings and template literals
 * collapse to their text (the substitutions of a template are dropped, its
 * literal chunks are kept and joined), comments disappear, and runs of operator
 * characters become one token so that `===` can be recognised.
 */
export function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let line = 1;
	let i = 0;

	while (i < source.length) {
		const char = source[i];
		if (char === '\n') {
			line += 1;
			i += 1;
			continue;
		}
		if (char === ' ' || char === '\t' || char === '\r') {
			i += 1;
			continue;
		}
		if (char === '/' && source[i + 1] === '/') {
			while (i < source.length && source[i] !== '\n') i += 1;
			continue;
		}
		if (char === '/' && source[i + 1] === '*') {
			i += 2;
			while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
				if (source[i] === '\n') line += 1;
				i += 1;
			}
			i += 2;
			continue;
		}
		if (char === '"' || char === '\'') {
			const start = line;
			let value = '';
			i += 1;
			while (i < source.length && source[i] !== char) {
				if (source[i] === '\\') {
					value += source[i + 1] ?? '';
					i += 2;
					continue;
				}
				if (source[i] === '\n') line += 1;
				value += source[i];
				i += 1;
			}
			i += 1;
			tokens.push({ kind: 'string', value, line: start });
			continue;
		}
		if (char === '`') {
			const start = line;
			let value = '';
			let depth = 0;
			i += 1;
			while (i < source.length) {
				const inner = source[i];
				if (depth === 0 && inner === '`') {
					i += 1;
					break;
				}
				if (inner === '\\') {
					value += source[i + 1] ?? '';
					i += 2;
					continue;
				}
				if (inner === '$' && source[i + 1] === '{') {
					depth += 1;
					i += 2;
					continue;
				}
				if (depth > 0 && inner === '}') {
					depth -= 1;
					i += 1;
					continue;
				}
				if (inner === '\n') line += 1;
				if (depth === 0) value += inner;
				i += 1;
			}
			tokens.push({ kind: 'string', value, line: start });
			continue;
		}
		if (NAME_CHAR.test(char)) {
			let value = '';
			while (i < source.length && NAME_CHAR.test(source[i])) {
				value += source[i];
				i += 1;
			}
			tokens.push({ kind: 'name', value, line });
			continue;
		}
		if (STRUCTURAL.includes(char)) {
			tokens.push({ kind: 'punct', value: char, line });
			i += 1;
			continue;
		}
		if (char === '/' && !divides(tokens[tokens.length - 1])) {
			i = skipRegularExpression(source, i);
			tokens.push({ kind: 'punct', value: '/regexp/', line });
			continue;
		}
		let operator = '';
		while (
			i < source.length
			&& !NAME_CHAR.test(source[i])
			&& !STRUCTURAL.includes(source[i])
			&& !'`"\''.includes(source[i])
			&& !/\s/.test(source[i])
		) {
			operator += source[i];
			i += 1;
		}
		tokens.push({ kind: 'punct', value: operator, line });
	}
	return tokens;
}

function divides(previous: Token | undefined): boolean {
	if (previous === undefined) return false;
	if (previous.kind === 'string') return true;
	if (previous.kind === 'name') return !NOT_A_VALUE.has(previous.value);
	return DIVIDES_AFTER.has(previous.value);
}

function skipRegularExpression(source: string, start: number): number {
	let i = start + 1;
	let inClass = false;
	while (i < source.length) {
		const char = source[i];
		if (char === '\\') {
			i += 2;
			continue;
		}
		if (char === '[') inClass = true;
		else if (char === ']') inClass = false;
		else if (char === '\n') break;
		else if (char === '/' && !inClass) {
			i += 1;
			break;
		}
		i += 1;
	}
	while (i < source.length && /[a-z]/.test(source[i])) i += 1;
	return i;
}

/* -------------------------------------------------------------------------- */
/* Walking the token stream                                                   */
/* -------------------------------------------------------------------------- */

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' };

/** The tokens between `tokens[open]` and its matching closer, plus that closer's index. */
function balanced(tokens: readonly Token[], open: number): { end: number; body: Token[] } {
	const opener = tokens[open].value;
	const closer = CLOSERS[opener];
	let depth = 0;
	for (let i = open; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token.kind !== 'punct') continue;
		if (token.value === opener) depth += 1;
		else if (token.value === closer) {
			depth -= 1;
			if (depth === 0) return { end: i, body: tokens.slice(open + 1, i) };
		}
	}
	return { end: tokens.length - 1, body: tokens.slice(open + 1) };
}

/** Splits an argument list on the commas that sit at depth zero. */
function arguments_(tokens: readonly Token[]): Token[][] {
	const parts: Token[][] = [];
	let current: Token[] = [];
	let depth = 0;
	for (const token of tokens) {
		if (token.kind === 'punct') {
			if ('([{'.includes(token.value)) depth += 1;
			else if (')]}'.includes(token.value)) depth -= 1;
			else if (token.value === ',' && depth === 0) {
				parts.push(current);
				current = [];
				continue;
			}
		}
		current.push(token);
	}
	parts.push(current);
	return parts;
}

/** Module-level `const NAME = 'literal';`, so a constant used as text is still checked. */
function stringConstants(tokens: readonly Token[]): Map<string, string> {
	const constants = new Map<string, string>();
	for (let i = 0; i + 3 < tokens.length; i += 1) {
		const [keyword, name, equals, value] = [tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3]];
		if (keyword.kind !== 'name' || keyword.value !== 'const') continue;
		if (name.kind !== 'name') continue;
		if (equals.kind !== 'punct' || equals.value !== '=') continue;
		if (value.kind !== 'string') continue;
		constants.set(name.value, value.value);
	}
	return constants;
}

/**
 * The literals an expression would actually display: `t(...)` calls are removed,
 * comparison operands are ignored, and a lone identifier is resolved when it
 * names a module-level string constant.
 */
function displayedLiterals(expression: readonly Token[], constants: ReadonlyMap<string, string>): Token[] {
	const rest: Token[] = [];
	for (let i = 0; i < expression.length; i += 1) {
		const token = expression[i];
		const next = expression[i + 1];
		if (token.kind === 'name' && token.value === 't' && next?.kind === 'punct' && next.value === '(') {
			i = balanced(expression, i + 1).end;
			continue;
		}
		rest.push(token);
	}

	const literals: Token[] = [];
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (token.kind === 'string') {
			const before = rest[i - 1];
			const after = rest[i + 1];
			if (before?.kind === 'punct' && COMPARISONS.has(before.value)) continue;
			if (after?.kind === 'punct' && COMPARISONS.has(after.value)) continue;
			if (before?.kind === 'name' && before.value === 'case') continue;
			literals.push(token);
			continue;
		}
		if (token.kind === 'name' && rest.length === 1) {
			const resolved = constants.get(token.value);
			if (resolved !== undefined) literals.push({ kind: 'string', value: resolved, line: token.line });
		}
	}
	return literals;
}

/* -------------------------------------------------------------------------- */
/* The two scans                                                              */
/* -------------------------------------------------------------------------- */

export interface Violation {
	file: string;
	line: number;
	site: string;
	text: string;
}

/** Scan 1: string literals reaching a known display sink. */
export function scanDisplaySinks(file: string, source: string): Violation[] {
	const tokens = tokenize(source);
	const constants = stringConstants(tokens);
	const violations: Violation[] = [];
	const attributeObject: boolean[] = [];

	const record = (site: string, literals: readonly Token[]): void => {
		for (const literal of literals) {
			if (literal.value.length <= 2) continue;
			if (displaySinkAllowlist.has(literal.value)) continue;
			violations.push({ file, line: literal.line, site, text: literal.value });
		}
	};

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		const next = tokens[i + 1];

		if (token.kind === 'punct' && token.value === '{') {
			const colon = tokens[i - 1];
			const key = tokens[i - 2];
			attributeObject.push(
				colon?.kind === 'punct' && colon.value === ':' && key?.kind === 'name' && key.value === 'attr',
			);
			continue;
		}
		if (token.kind === 'punct' && token.value === '}') {
			attributeObject.pop();
			continue;
		}

		const opensCall = next?.kind === 'punct' && next.value === '(';
		if (token.kind === 'name' && opensCall && DISPLAY_CALLS.has(token.value)) {
			const args = arguments_(balanced(tokens, i + 1).body);
			record(`${token.value}()`, displayedLiterals(args[0] ?? [], constants));
			continue;
		}
		if (token.kind === 'name' && opensCall && token.value === 'addOption') {
			const args = arguments_(balanced(tokens, i + 1).body);
			record('addOption()', displayedLiterals(args[1] ?? [], constants));
			continue;
		}

		if (token.kind === 'punct') continue;
		const insideAttributes = attributeObject[attributeObject.length - 1] === true;
		const isSink = DISPLAY_PROPERTIES.has(token.value)
			|| (insideAttributes && ATTRIBUTE_ONLY_PROPERTIES.has(token.value));
		if (!isSink || next?.kind !== 'punct' || next.value !== ':') continue;

		let depth = 0;
		let end = i + 2;
		while (end < tokens.length) {
			const candidate = tokens[end];
			if (candidate.kind === 'punct') {
				if ('([{'.includes(candidate.value)) depth += 1;
				else if (')]}'.includes(candidate.value)) {
					if (depth === 0) break;
					depth -= 1;
				} else if (candidate.value === ',' && depth === 0) break;
			}
			end += 1;
		}
		record(`${token.value}:`, displayedLiterals(tokens.slice(i + 2, end), constants));
	}
	return violations;
}

/**
 * A CSS class list: every word is a lower-case, dashed or underscored token.
 *
 * The trailing `[-_]*` is for a template literal cut open by an interpolation,
 * as in `` `sift-card__action sift-card__action--${kind}` `` — its head ends
 * mid-token, and without this a class list would read as two words and be
 * reported as prose. It stays strict about what a word may contain.
 */
const CSS_WORD = /^[a-z][a-z0-9]*(?:[-_]+[a-z0-9]+)+[-_]*$/;

/** Reads like language rather than like an identifier. */
export function looksLikeProse(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length <= 2) return false;
	if (!/[A-Za-z\u00c0-\u024f]/.test(trimmed)) return false;
	const words = trimmed.split(/\s+/);
	if (words.every((word) => CSS_WORD.test(word))) return false;
	if (words.length > 1) return true;
	return /^[A-Z\u00c0-\u00de][a-z\u00df-\u00ff]/.test(trimmed) && !/[._/\\-]/.test(trimmed);
}

/** Scan 2: prose left anywhere in an interface file, sink or no sink. */
export function scanProse(file: string, source: string): Violation[] {
	const tokens = tokenize(source);
	const violations: Violation[] = [];
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		const next = tokens[i + 1];
		if (token.kind === 'name' && token.value === 't' && next?.kind === 'punct' && next.value === '(') {
			i = balanced(tokens, i + 1).end;
			continue;
		}
		if (token.kind !== 'string') continue;
		if (proseAllowlist.has(token.value)) continue;
		if (!looksLikeProse(token.value)) continue;
		violations.push({ file, line: token.line, site: 'literal', text: token.value });
	}
	return violations;
}

function readInterfaceFile(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf8');
}

function describeViolations(violations: readonly Violation[]): string {
	return violations
		.map((violation) => `${violation.file}:${violation.line}  ${violation.site}  ${JSON.stringify(violation.text)}`)
		.join('\n');
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                  */
/* -------------------------------------------------------------------------- */

describe('interface strings come from src/i18n', () => {
	it.each(INTERFACE_FILES)('%s hands no string literal to a display sink', (file) => {
		const violations = scanDisplaySinks(file, readInterfaceFile(file));

		expect(
			violations,
			`Wrap these in t(...) and add the key to en.json and de.json:\n${describeViolations(violations)}`,
		).toEqual([]);
	});

	it.each(INTERFACE_FILES)('%s contains no prose literal', (file) => {
		const violations = scanProse(file, readInterfaceFile(file));

		expect(
			violations,
			`These read as language and belong in src/i18n:\n${describeViolations(violations)}`,
		).toEqual([]);
	});

	it('covers every file under src/ui, so a new view cannot slip past the scan', () => {
		const onDisk = readdirSync(join(REPO_ROOT, 'src', 'ui'))
			.filter((name) => name.endsWith('.ts'))
			.map((name) => `src/ui/${name}`)
			.sort();

		expect(
			onDisk.filter((file) => !INTERFACE_FILES.includes(file)),
			'add these to INTERFACE_FILES; a view that is not listed is never scanned',
		).toEqual([]);
		expect(INTERFACE_FILES).toContain('src/settings.ts');
		for (const file of INTERFACE_FILES) {
			expect(readInterfaceFile(file).length, file).toBeGreaterThan(0);
		}
	});
});

describe('the scan itself', () => {
	const scanBoth = (source: string): Violation[] => [
		...scanDisplaySinks('probe.ts', source),
		...scanProse('probe.ts', source),
	];

	it('does not read a class list as prose, interpolated or not', () => {
		// Both are class lists, not language: the second is the head of a template
		// literal whose last token is cut open by `${kind}`.
		expect(scanBoth("el.addClass('sift-card sift-card--selected');")).toEqual([]);
		expect(scanBoth("el.createEl('button', { cls: `sift-card__action sift-card__action--${kind}` });")).toEqual([]);
		// A sentence that happens to contain a dash is still prose.
		expect(scanBoth("buildHint(el, 'Open the note');").length).toBeGreaterThan(0);
	});

	it('accepts a t() call in every checked position', () => {
		const source = [
			'el.setText(t(\'a.b\'));',
			'el.createDiv({ cls: \'sift-x\', text: t(\'a.c\') });',
			'input.setAttrs({ attr: { placeholder: t(\'a.d\'), \'aria-label\': t(\'a.e\'), title: t(\'a.f\') } });',
			'new Setting(x).setName(t(\'a.g\')).setDesc(t(\'a.h\'));',
			'new Notice(t(\'a.i\'));',
			'dropdown.addOption(key, t(\'a.j\'));',
		].join('\n');

		expect(scanBoth(source)).toEqual([]);
	});

	it('catches a literal handed to setText, a text option, a Notice and a Setting', () => {
		const source = [
			'el.setText(\'No results\');',
			'el.createDiv({ text: \'Still indexing\' });',
			'new Notice(\'The note has disappeared.\');',
			'new Setting(x).setName(\'Language\').setDesc(\'Interface language\');',
		].join('\n');

		expect(scanDisplaySinks('probe.ts', source).map((violation) => violation.text)).toEqual([
			'No results',
			'Still indexing',
			'The note has disappeared.',
			'Language',
			'Interface language',
		]);
	});

	it('catches a literal handed to a helper of the file\'s own making', () => {
		// The exact mutation that passed the whole suite before this file existed.
		const source = 'this.buildHint(footer, \'Esc\', \'Close the search\');';

		expect(scanProse('probe.ts', source).map((violation) => violation.text)).toEqual([
			'Esc',
			'Close the search',
		]);
	});

	it('catches a literal that hides in a module constant', () => {
		const source = ['const LABEL = \'Remove this filter\';', 'el.createSpan({ text: LABEL });'].join('\n');

		expect(scanDisplaySinks('probe.ts', source).map((violation) => violation.text)).toEqual([
			'Remove this filter',
		]);
	});

	it('catches a literal in one branch of a ternary but not the compared value', () => {
		const source = 'el.createDiv({ text: kind === \'no-results\' ? \'No matches\' : t(\'a.b\') });';

		expect(scanDisplaySinks('probe.ts', source).map((violation) => violation.text)).toEqual(['No matches']);
	});

	it('ignores class names, tag names, attribute names and translation keys', () => {
		const source = [
			'const row = el.createEl(\'div\', { cls: \'sift-chip sift-chip--path\' });',
			'row.setAttribute(\'role\', \'listbox\');',
			'const keys = { title: \'empty.initial.title\', body: \'empty.initial.body\' };',
			'if (event.key === \'ArrowDown\') select(1);',
			'return new Intl.DateTimeFormat(\'de-CH\', { month: \'2-digit\' });',
		].join('\n');

		expect(scanBoth(source)).toEqual([]);
	});

	it('ignores a comment and a regular expression that contain prose', () => {
		const source = [
			'// This comment says Close the search on purpose.',
			'/* And so does this block: Close the search. */',
			'const trailing = value.replace(/Close the search/u, \'\');',
		].join('\n');

		expect(scanBoth(source)).toEqual([]);
	});

	it('reports the line the literal sits on', () => {
		const source = ['const a = 1;', '', 'el.setText(\'No results\');'].join('\n');

		expect(scanDisplaySinks('probe.ts', source)).toEqual([
			{ file: 'probe.ts', line: 3, site: 'setText()', text: 'No results' },
		]);
	});
});

describe('the allowlists', () => {
	const entries = [...ALLOWED_IN_DISPLAY_SINK, ...NON_DISPLAY_IDENTIFIERS];

	it('gives every entry a reason', () => {
		for (const entry of entries) {
			expect(entry.reason.length, `no reason for ${JSON.stringify(entry.text)}`).toBeGreaterThan(15);
			expect(entry.reason.endsWith('.'), `reason for ${JSON.stringify(entry.text)}`).toBe(true);
		}
	});

	it('keeps every entry short enough that no sentence can be smuggled in', () => {
		for (const entry of entries) {
			expect(entry.text.length, `allowlist entry ${JSON.stringify(entry.text)}`)
				.toBeLessThanOrEqual(MAX_ALLOWLIST_LENGTH);
		}
	});

	it('lists no entry twice', () => {
		const texts = entries.map((entry) => entry.text);

		expect(new Set(texts).size).toBe(texts.length);
	});
});
