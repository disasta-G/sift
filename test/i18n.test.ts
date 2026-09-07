import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '../src/i18n/en.json';
import de from '../src/i18n/de.json';
import { dateFormatLocale, getLocale, hasKey, setLanguage, t } from '../src/i18n/index';
import type { TranslationKey } from '../src/i18n/index';
import type { EmptyStateKind, IndexPhase, QueryParseErrorCode, SortKey } from '../src/types';

type Bundle = Record<string, string>;

const enBundle: Bundle = en;
const deBundle: Bundle = de;

const enKeys = Object.keys(enBundle);
const deKeys = Object.keys(deBundle);

/** Cast for keys that deliberately do not exist in the bundle. */
function unknownKey(key: string): TranslationKey {
	return key as TranslationKey;
}

/* -------------------------------------------------------------------------- */
/* Bundle shape                                                               */
/* -------------------------------------------------------------------------- */

describe('bundle shape', () => {
	it('gives de exactly the key set of en', () => {
		const missing = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(deBundle, key));
		const extra = deKeys.filter((key) => !Object.prototype.hasOwnProperty.call(enBundle, key));
		expect(missing).toEqual([]);
		expect(extra).toEqual([]);
	});

	it('keeps both bundles in the same order, so a review diff stays readable', () => {
		expect(deKeys).toEqual(enKeys);
	});

	it('has no empty or padded value in either bundle', () => {
		for (const key of enKeys) {
			for (const [locale, bundle] of [
				['en', enBundle],
				['de', deBundle],
			] as const) {
				const value = bundle[key];
				expect(typeof value, `${locale}:${key}`).toBe('string');
				expect(value.length, `${locale}:${key}`).toBeGreaterThan(0);
				expect(value.trim(), `${locale}:${key}`).toBe(value);
			}
		}
	});

	it('groups every key under a known area', () => {
		const areas = [
			'search.',
			'filter.',
			'sort.',
			'result.',
			'empty.',
			'error.',
			'settings.',
			'command.',
			'footer.',
			'index.',
		];
		for (const key of enKeys) {
			expect(areas.some((area) => key.startsWith(area)), key).toBe(true);
			expect(key, key).toMatch(/^[a-z][A-Za-z0-9]*(\.[a-zA-Z0-9-]+)+$/);
		}
	});

	it('uses the same placeholder set in both languages', () => {
		for (const key of enKeys) {
			expect(placeholders(enBundle[key]), key).toEqual(placeholders(deBundle[key]));
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Coverage of the type contract                                              */
/* -------------------------------------------------------------------------- */

describe('coverage of the shared unions', () => {
	// Each map is exhaustive by construction: adding a union member to types.ts
	// breaks the compile until the bundle gains the matching key.
	it('has one message per QueryParseErrorCode', () => {
		const messages: Record<QueryParseErrorCode, TranslationKey> = {
			'unclosed-quote': 'error.unclosed-quote',
			'dangling-operator': 'error.dangling-operator',
			'unknown-field': 'error.unknown-field',
			'query-too-long': 'error.query-too-long',
		};
		for (const key of Object.values(messages)) {
			expect(hasKey(key), key).toBe(true);
		}
	});

	it('has a title and a body per EmptyStateKind', () => {
		const states: Record<EmptyStateKind, { title: TranslationKey; body: TranslationKey }> = {
			initial: { title: 'empty.initial.title', body: 'empty.initial.body' },
			indexing: { title: 'empty.indexing.title', body: 'empty.indexing.body' },
			'no-results': { title: 'empty.no-results.title', body: 'empty.no-results.body' },
			'query-error': { title: 'empty.query-error.title', body: 'empty.query-error.body' },
			'index-error': { title: 'empty.index-error.title', body: 'empty.index-error.body' },
		};
		for (const state of Object.values(states)) {
			expect(hasKey(state.title), state.title).toBe(true);
			expect(hasKey(state.body), state.body).toBe(true);
		}
	});

	it('has one label per SortKey', () => {
		const labels: Record<SortKey, TranslationKey> = {
			relevance: 'sort.relevance',
			'created-desc': 'sort.created-desc',
			'created-asc': 'sort.created-asc',
			'modified-desc': 'sort.modified-desc',
			'modified-asc': 'sort.modified-asc',
			'title-asc': 'sort.title-asc',
			'path-asc': 'sort.path-asc',
		};
		for (const key of Object.values(labels)) {
			expect(hasKey(key), key).toBe(true);
		}
	});

	it('has one label per IndexPhase', () => {
		const labels: Record<IndexPhase, TranslationKey> = {
			idle: 'index.phase.idle',
			loading: 'index.phase.loading',
			scanning: 'index.phase.scanning',
			reading: 'index.phase.reading',
			building: 'index.phase.building',
			compacting: 'index.phase.compacting',
			ready: 'index.phase.ready',
			error: 'index.phase.error',
		};
		for (const key of Object.values(labels)) {
			expect(hasKey(key), key).toBe(true);
		}
	});

	it('names the command without repeating the plugin name', () => {
		expect(t('command.openSearch')).toBe('Open search');
		expect(enBundle['command.openSearch'].toLowerCase()).not.toContain('sift');
	});
});

/* -------------------------------------------------------------------------- */
/* Store policy                                                               */
/* -------------------------------------------------------------------------- */

describe('store policy', () => {
	it('mentions nothing that belongs to the paid part', () => {
		const forbidden =
			/\b(ai|ki|licen[cs]e|lizenz|subscription|abo|abonnement|trial|testphase|upgrade|premium|price|pricing|preis|polar|openai|anthropic|mistral)\b/i;
		for (const key of enKeys) {
			expect(key, key).not.toMatch(forbidden);
			expect(enBundle[key], key).not.toMatch(forbidden);
			expect(deBundle[key], key).not.toMatch(forbidden);
		}
	});

	it('writes German in Swiss orthography', () => {
		for (const key of enKeys) {
			expect(deBundle[key], key).not.toContain('ß');
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Sentence case                                                              */
/* -------------------------------------------------------------------------- */

/** Proper nouns that stay capitalized inside a sentence. */
const PROPER_NOUNS = new Set(['Sift']);

/**
 * German function words. Title case capitalizes them, sentence case does not —
 * German nouns are capitalized either way, so they cannot serve as the signal.
 */
const GERMAN_FUNCTION_WORDS = new Set([
	'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
	'und', 'oder', 'aber', 'von', 'vom', 'mit', 'für', 'im', 'in', 'zu', 'zum', 'zur', 'bei',
	'beim', 'auf', 'aus', 'nach', 'ohne', 'als', 'am', 'an', 'über', 'unter', 'nur', 'auch',
	'wie', 'wenn', 'ist', 'sind', 'wird', 'werden', 'pro', 'je', 'sowie', 'bis', 'ab',
]);

/** Tokens after these characters may start a new sentence. */
const SENTENCE_END = /[.!?:·–—]$/;

interface Word {
	text: string;
	startsSentence: boolean;
}

function words(value: string): Word[] {
	const tokens = value.split(/\s+/).filter((token) => token.length > 0);
	const result: Word[] = [];
	let startsSentence = true;
	for (const token of tokens) {
		const text = token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
		if (text.length > 0) {
			result.push({ text, startsSentence });
		}
		startsSentence = SENTENCE_END.test(token);
	}
	return result;
}

/** A word that reads as Title Case: capital letter followed by a lowercase one. */
function isCapitalized(word: string): boolean {
	return /^\p{Lu}\p{Ll}/u.test(word);
}

/** Reports the words that break sentence case, so both bundles and the detector itself can be checked. */
function titleCaseOffenders(value: string, locale: 'en' | 'de'): string[] {
	return words(value)
		.filter((word) => !word.startsSentence)
		.filter((word) => isCapitalized(word.text))
		.filter((word) =>
			locale === 'en' ? !PROPER_NOUNS.has(word.text) : GERMAN_FUNCTION_WORDS.has(word.text.toLowerCase()),
		)
		.map((word) => word.text);
}

describe('sentence case', () => {
	it('detects title case, so the bundle checks below are not vacuous', () => {
		expect(titleCaseOffenders('Include Subfolders', 'en')).toEqual(['Subfolders']);
		expect(titleCaseOffenders('Search Your Vault Now', 'en')).toEqual(['Your', 'Vault', 'Now']);
		expect(titleCaseOffenders('Include subfolders', 'en')).toEqual([]);
		expect(titleCaseOffenders('Sift searches your vault. Sift is fast.', 'en')).toEqual([]);
		expect(titleCaseOffenders('Filter Für Ordner Und Pfade', 'de')).toEqual(['Für', 'Und']);
		expect(titleCaseOffenders('Filter für Ordner und Pfade', 'de')).toEqual([]);
	});

	it('keeps every English value in sentence case', () => {
		for (const key of enKeys) {
			expect(titleCaseOffenders(enBundle[key], 'en'), key).toEqual([]);
		}
	});

	it('keeps every German value in sentence case', () => {
		for (const key of enKeys) {
			expect(titleCaseOffenders(deBundle[key], 'de'), key).toEqual([]);
		}
	});

	it('shouts in neither language', () => {
		for (const key of enKeys) {
			for (const bundle of [enBundle, deBundle]) {
				const shouted = words(bundle[key])
					.map((word) => word.text)
					.filter((word) => word.length > 3 && word === word.toUpperCase() && /\p{Lu}/u.test(word));
				expect(shouted, key).toEqual([]);
			}
		}
	});
});

/* -------------------------------------------------------------------------- */
/* Lookup                                                                     */
/* -------------------------------------------------------------------------- */

describe('lookup', () => {
	afterEach(() => {
		setLanguage('en');
	});

	it('starts in English', () => {
		expect(getLocale()).toBe('en');
		expect(t('filter.includeSubfolders')).toBe('Include subfolders');
	});

	it('returns the German value once German is set', () => {
		setLanguage('de');
		expect(getLocale()).toBe('de');
		expect(t('filter.includeSubfolders')).toBe('Unterordner einbeziehen');
	});

	it('returns the key itself when the key is unknown', () => {
		expect(t(unknownKey('nope.not.a.key'))).toBe('nope.not.a.key');
		setLanguage('de');
		expect(t(unknownKey('nope.not.a.key'), { n: 1 })).toBe('nope.not.a.key');
	});

	it('reports whether a key exists', () => {
		expect(hasKey('search.placeholder')).toBe(true);
		expect(hasKey('search.placeholder.missing')).toBe(false);
		expect(hasKey('toString')).toBe(false);
	});

	it('substitutes numbers and strings', () => {
		expect(t('search.count', { n: 12, ms: 38 })).toBe('12 results · 38 ms');
		setLanguage('de');
		expect(t('search.count', { n: 12, ms: 38 })).toBe('12 Treffer · 38 ms');
		expect(t('filter.createdRange', { from: '01.01.2026', to: 'heute' })).toBe('Erstellt 01.01.2026 – heute');
	});

	it('leaves a placeholder in place when no value was passed', () => {
		expect(t('search.count', { n: 3 })).toBe('3 results · {ms} ms');
		expect(t('search.count')).toBe('{n} results · {ms} ms');
	});
});

/* -------------------------------------------------------------------------- */
/* Locale resolution                                                          */
/* -------------------------------------------------------------------------- */

describe('locale resolution', () => {
	afterEach(() => {
		setLanguage('en');
	});

	const table: ReadonlyArray<readonly [string | undefined, string]> = [
		['de', 'de'],
		['de-CH', 'de'],
		['de-AT', 'de'],
		['de_DE', 'de'],
		['DE', 'de'],
		['en', 'en'],
		['en-GB', 'en'],
		['fr', 'en'],
		['zh-TW', 'en'],
		['', 'en'],
		[undefined, 'en'],
	];

	for (const [locale, expected] of table) {
		it(`resolves 'auto' with ${String(locale)} to ${expected}`, () => {
			setLanguage('auto', locale);
			expect(getLocale()).toBe(expected);
		});
	}

	it('lets an explicit language win over the app locale', () => {
		setLanguage('en', 'de-CH');
		expect(getLocale()).toBe('en');
		setLanguage('de', 'en-GB');
		expect(getLocale()).toBe('de');
	});

	it('falls back to English for a malformed setting', () => {
		setLanguage('nonsense' as never, 'fr');
		expect(getLocale()).toBe('en');
	});

	it('keeps the region in the date format locale when it matches the language', () => {
		setLanguage('auto', 'de-CH');
		expect(dateFormatLocale()).toBe('de-CH');
		setLanguage('auto', 'de_ch');
		expect(dateFormatLocale()).toBe('de-CH');
		setLanguage('de', 'de-AT');
		expect(dateFormatLocale()).toBe('de-AT');
	});

	it('drops a region that belongs to another language', () => {
		setLanguage('en', 'de-CH');
		expect(dateFormatLocale()).toBe('en');
		setLanguage('auto', 'fr-CH');
		expect(dateFormatLocale()).toBe('en');
		setLanguage('de');
		expect(dateFormatLocale()).toBe('de');
	});
});

/* -------------------------------------------------------------------------- */
/* Fallback chain and substitution edge cases, on synthetic bundles           */
/* -------------------------------------------------------------------------- */

describe('fallback chain', () => {
	afterEach(() => {
		vi.doUnmock('../src/i18n/en.json');
		vi.doUnmock('../src/i18n/de.json');
		vi.resetModules();
	});

	async function loadWith(english: Bundle, german: Bundle) {
		vi.resetModules();
		vi.doMock('../src/i18n/en.json', () => ({ default: english }));
		vi.doMock('../src/i18n/de.json', () => ({ default: german }));
		return import('../src/i18n/index');
	}

	it('falls back en -> key', async () => {
		const i18n = await loadWith(
			{ 'search.placeholder': 'Search your vault', 'search.label': 'Search query' },
			{ 'search.placeholder': 'Vault durchsuchen' },
		);
		i18n.setLanguage('de');
		// Present in de.
		expect(i18n.t(unknownKey('search.placeholder'))).toBe('Vault durchsuchen');
		// Missing in de, present in en.
		expect(i18n.t(unknownKey('search.label'))).toBe('Search query');
		// Missing in both.
		expect(i18n.t(unknownKey('search.missing'))).toBe('search.missing');
	});

	it('treats an empty translation as missing', async () => {
		const i18n = await loadWith({ 'search.label': 'Search query' }, { 'search.label': '' });
		i18n.setLanguage('de');
		expect(i18n.t(unknownKey('search.label'))).toBe('Search query');
	});

	it('substitutes a repeated placeholder everywhere', async () => {
		const i18n = await loadWith({ 'index.progress': '{n} of {n} ({n})' }, { 'index.progress': '{n} of {n} ({n})' });
		expect(i18n.t(unknownKey('index.progress'), { n: 7 })).toBe('7 of 7 (7)');
	});

	it('leaves a literal brace alone', async () => {
		const bundle = { 'empty.initial.hint': 'A { is literal, {name} is not, } neither' };
		const i18n = await loadWith(bundle, bundle);
		expect(i18n.t(unknownKey('empty.initial.hint'), { name: 'this' })).toBe(
			'A { is literal, this is not, } neither',
		);
	});

	it('never returns undefined, whatever the bundle looks like', async () => {
		const i18n = await loadWith({}, {});
		expect(i18n.t(unknownKey('anything.at.all'))).toBe('anything.at.all');
		expect(i18n.t(unknownKey('anything.at.all'), { a: 1 })).toBe('anything.at.all');
	});
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function placeholders(value: string): string[] {
	const found = value.match(/\{[A-Za-z0-9_]+\}/g) ?? [];
	return [...new Set(found)].sort();
}
