/** @vitest-environment happy-dom */

/**
 * Settings: defaults, migration and the settings tab.
 *
 * Three things are load-bearing here and are tested as such:
 *
 *  1. `migrateSettings` is TOTAL. `data.json` sits in the vault where anyone can
 *     hand-edit it, and a plugin that throws in `onload` is a plugin that cannot
 *     be uninstalled from the UI. Every shape below has to come back as a
 *     complete, valid, MUTABLE settings object.
 *  2. The exported defaults are deeply frozen, so a stray write anywhere in the
 *     codebase throws at the scene instead of poisoning every later migration.
 *  3. The tab renders through Obsidian's own components — no HTML sink, no bare
 *     heading element, every label from i18n.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { Notice, installDomHelpers, resetStubEnvironment } from './stubs/obsidian';
import { createFakeApp } from './helpers/fakeVault';
import { DEFAULT_SETTINGS, DEFAULT_TUNING, SiftSettingTab, migrateSettings } from '../src/settings';
import { setLanguage, t } from '../src/i18n/index';
import type { IndexStats, SiftSettings } from '../src/types';
import type SiftPlugin from '../src/main';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** The slice of the plugin the tab actually touches. */
interface FakePlugin {
	settings: SiftSettings;
	indexer: { stats(): IndexStats; lastError(): string | null };
	saveSettings(): Promise<void>;
	rebuildIndex(): Promise<void>;
}

interface Harness {
	tab: SiftSettingTab;
	plugin: FakePlugin;
	container: HTMLElement;
	/** One snapshot per `saveSettings()` call, in order. */
	saves: SiftSettings[];
	rebuilds: number;
	/** Swap in a different stats source; `null` makes `stats()` throw, as it does before the first build. */
	setStats(stats: IndexStats | null): void;
	/** What `Indexer.lastError()` answers: the error name of a build that threw, or `null`. */
	setFailure(reason: string | null): void;
	/** Make the next `rebuildIndex()` reject. */
	failRebuild(): void;
}

const SAMPLE_STATS: IndexStats = {
	fileCount: 1234,
	trigramCount: 48_000,
	postingCount: 920_000,
	totalTextLength: 5_400_000,
	approximateBytes: 42 * 1024 * 1024,
	builtAt: Date.UTC(2026, 2, 14, 9, 30),
	compacted: true,
};

function createHarness(overrides: Partial<SiftSettings> = {}): Harness {
	const settings: SiftSettings = { ...migrateSettings({}), ...overrides };
	const saves: SiftSettings[] = [];
	let stats: IndexStats | null = SAMPLE_STATS;
	let failure: string | null = null;
	let rebuildFails = false;

	const harness: Harness = {
		tab: undefined as unknown as SiftSettingTab,
		plugin: {
			settings,
			indexer: {
				stats(): IndexStats {
					if (stats === null) throw new Error('index not ready');
					return stats;
				},
				lastError(): string | null {
					return failure;
				},
			},
			saveSettings(): Promise<void> {
				saves.push({ ...harness.plugin.settings, excludedFolders: [...harness.plugin.settings.excludedFolders] });
				return Promise.resolve();
			},
			rebuildIndex(): Promise<void> {
				harness.rebuilds += 1;
				return rebuildFails ? Promise.reject(new Error('disk full')) : Promise.resolve();
			},
		},
		container: undefined as unknown as HTMLElement,
		saves,
		rebuilds: 0,
		setStats(next: IndexStats | null): void {
			stats = next;
		},
		setFailure(reason: string | null): void {
			failure = reason;
		},
		failRebuild(): void {
			rebuildFails = true;
		},
	};

	const app = createFakeApp({}).asApp();
	harness.tab = new SiftSettingTab(app, harness.plugin as unknown as SiftPlugin);
	harness.container = harness.tab.containerEl;
	document.body.appendChild(harness.container);
	return harness;
}

/** What the Indexer hashes: a change here, and only here, costs a rebuild. */
function indexFingerprint(settings: SiftSettings): string {
	return JSON.stringify([settings.createdField, [...settings.excludedFolders].sort()]);
}

function settingByClass(harness: Harness, cls: string): HTMLElement {
	const el = harness.container.querySelector(`.${cls}`);
	if (el === null) throw new Error(`no setting with class ${cls}`);
	return el as HTMLElement;
}

function selects(harness: Harness): HTMLSelectElement[] {
	return Array.from(harness.container.querySelectorAll('select'));
}

function sliders(harness: Harness): HTMLInputElement[] {
	return Array.from(harness.container.querySelectorAll('input[type="range"]'));
}

function toggles(harness: Harness): HTMLElement[] {
	return Array.from(harness.container.querySelectorAll('.checkbox-container'));
}

function setSelect(el: HTMLSelectElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('change'));
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input'));
}

function setSlider(el: HTMLInputElement, value: number): void {
	el.value = String(value);
	el.dispatchEvent(new Event('input'));
}

/** Lets the fire-and-forget promises inside the tab settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

beforeEach(() => {
	installDomHelpers();
	resetStubEnvironment();
	Notice.reset();
	setLanguage('en');
	document.body.replaceChildren();
});

afterEach(() => {
	vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

describe('DEFAULT_SETTINGS', () => {
	it('carries the documented values', () => {
		expect(DEFAULT_SETTINGS).toEqual({
			version: 1,
			defaultSort: 'relevance',
			snippetCount: 2,
			createdField: 'created',
			excludedFolders: [],
			language: 'auto',
			fuzzyByDefault: false,
			includeSubfoldersByDefault: true,
			maxResults: 200,
			forceRebuild: false,
		});
	});

	it('is frozen at the top level', () => {
		expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
		expect(() => {
			(DEFAULT_SETTINGS as unknown as { snippetCount: number }).snippetCount = 9;
		}).toThrow();
	});

	it('is frozen down to the folder list', () => {
		expect(Object.isFrozen(DEFAULT_SETTINGS.excludedFolders)).toBe(true);
		expect(() => {
			(DEFAULT_SETTINGS.excludedFolders as string[]).push('Archive');
		}).toThrow();
	});
});

describe('DEFAULT_TUNING', () => {
	it('carries the documented constants', () => {
		expect(DEFAULT_TUNING.trigramSize).toBe(3);
		expect(DEFAULT_TUNING.minTrigramTermLength).toBe(3);
		expect(DEFAULT_TUNING.maxTermVariants).toBe(8);
		expect(DEFAULT_TUNING.maxQueryLength).toBe(512);
		expect(DEFAULT_TUNING.snippetLength).toBe(160);
		expect(DEFAULT_TUNING.snippetLines).toBe(5);
		expect(DEFAULT_TUNING.fuzzyMaxDistanceShort).toBe(1);
		expect(DEFAULT_TUNING.fuzzyMaxDistanceLong).toBe(2);
		expect(DEFAULT_TUNING.fuzzyShortTermMaxLength).toBe(5);
		expect(DEFAULT_TUNING.searchDebounceMs).toBe(120);
		expect(DEFAULT_TUNING.indexSliceMs).toBe(12);
		expect(DEFAULT_TUNING.storeBatchSize).toBe(200);
	});

	/**
	 * The candidate filter is derived from the distance budget now, not from a
	 * constant share of the term's trigrams. A share rejected a short term's true
	 * matches before the distance pass ever saw them, so restoring the knob would
	 * restore the bug — see the note on `SiftTuning.fuzzyMaxDistanceShort`.
	 */
	it('carries no trigram-similarity floor any more', () => {
		expect(Object.prototype.hasOwnProperty.call(DEFAULT_TUNING, 'fuzzyTrigramSimilarity')).toBe(false);
	});

	it('carries the documented ranking weights', () => {
		expect(DEFAULT_TUNING.weights.field).toEqual({
			title: 3.0,
			path: 1.0,
			frontmatter: 2.0,
			tag: 2.0,
			heading: 1.5,
			body: 1.0,
		});
		expect(DEFAULT_TUNING.weights.wholeWordBonus).toBe(1.3);
		expect(DEFAULT_TUNING.weights.maxProximityBonus).toBe(1.4);
		expect(DEFAULT_TUNING.weights.proximityWindow).toBe(400);
		expect(DEFAULT_TUNING.weights.maxRecencyBonus).toBe(1.15);
		expect(DEFAULT_TUNING.weights.recencyHalfLifeDays).toBe(365);
		expect(DEFAULT_TUNING.weights.fuzzyPenalty).toBe(0.7);
		expect(DEFAULT_TUNING.weights.aliasPenalty).toBe(0.95);
	});

	it('is frozen all the way down', () => {
		expect(Object.isFrozen(DEFAULT_TUNING)).toBe(true);
		expect(Object.isFrozen(DEFAULT_TUNING.weights)).toBe(true);
		expect(Object.isFrozen(DEFAULT_TUNING.weights.field)).toBe(true);
		expect(() => {
			(DEFAULT_TUNING as unknown as { snippetLength: number }).snippetLength = 999;
		}).toThrow();
		expect(() => {
			(DEFAULT_TUNING.weights.field as unknown as { title: number }).title = 99;
		}).toThrow();
	});
});

/* -------------------------------------------------------------------------- */
/* migrateSettings                                                            */
/* -------------------------------------------------------------------------- */

describe('migrateSettings', () => {
	const KNOWN_KEYS = Object.keys(DEFAULT_SETTINGS).sort();

	it.each([
		['null', null],
		['undefined', undefined],
		['a string', 'garbage'],
		['a number', 42],
		['a boolean', true],
		['an array', ['Archive', 'Templates']],
		['an empty object', {}],
		['a function', (): void => undefined],
	])('returns the complete defaults for %s', (_label, raw) => {
		const settings = migrateSettings(raw);
		expect(settings).toEqual({ ...DEFAULT_SETTINGS, excludedFolders: [] });
		expect(Object.keys(settings).sort()).toEqual(KNOWN_KEYS);
	});

	it('returns a mutable object that shares nothing with the frozen default', () => {
		const settings = migrateSettings(null);
		expect(settings).not.toBe(DEFAULT_SETTINGS);
		expect(Object.isFrozen(settings)).toBe(false);
		expect(settings.excludedFolders).not.toBe(DEFAULT_SETTINGS.excludedFolders);
		expect(() => {
			settings.snippetCount = 3;
			(settings.excludedFolders as string[]).push('Archive');
		}).not.toThrow();
		// The default is untouched by that write.
		expect(DEFAULT_SETTINGS.snippetCount).toBe(2);
		expect(DEFAULT_SETTINGS.excludedFolders).toEqual([]);
	});

	it('drops unknown keys instead of carrying them forward', () => {
		const settings = migrateSettings({
			snippetCount: 3,
			aiEnabled: true,
			apiKey: 'nope',
			nested: { deep: [1, 2, 3] },
		});
		expect(Object.keys(settings).sort()).toEqual(KNOWN_KEYS);
		expect(settings.snippetCount).toBe(3);
	});

	it('keeps a fully valid object as it is', () => {
		const stored: SiftSettings = {
			version: 1,
			defaultSort: 'modified-desc',
			snippetCount: 3,
			createdField: 'date',
			excludedFolders: ['Archive', 'Templates/Daily'],
			language: 'de',
			fuzzyByDefault: true,
			includeSubfoldersByDefault: false,
			maxResults: 500,
			forceRebuild: true,
		};
		expect(migrateSettings(stored)).toEqual(stored);
	});

	it('always writes the current schema version', () => {
		expect(migrateSettings({ version: 7 }).version).toBe(1);
		expect(migrateSettings({ version: 'one' }).version).toBe(1);
	});

	it('falls back when an enum value is not in its union', () => {
		expect(migrateSettings({ defaultSort: 'chaos' }).defaultSort).toBe('relevance');
		expect(migrateSettings({ defaultSort: 7 }).defaultSort).toBe('relevance');
		expect(migrateSettings({ defaultSort: 'toString' }).defaultSort).toBe('relevance');
		expect(migrateSettings({ language: 'fr' }).language).toBe('auto');
		expect(migrateSettings({ language: null }).language).toBe('auto');
		expect(migrateSettings({ defaultSort: 'path-asc' }).defaultSort).toBe('path-asc');
		expect(migrateSettings({ language: 'de' }).language).toBe('de');
	});

	it('clamps snippetCount into 1..3', () => {
		expect(migrateSettings({ snippetCount: 0 }).snippetCount).toBe(1);
		expect(migrateSettings({ snippetCount: 1 }).snippetCount).toBe(1);
		expect(migrateSettings({ snippetCount: 5 }).snippetCount).toBe(3);
		expect(migrateSettings({ snippetCount: 2.4 }).snippetCount).toBe(2);
		expect(migrateSettings({ snippetCount: 2.6 }).snippetCount).toBe(3);
	});

	it('clamps maxResults into 20..1000', () => {
		expect(migrateSettings({ maxResults: 5 }).maxResults).toBe(20);
		expect(migrateSettings({ maxResults: 20 }).maxResults).toBe(20);
		expect(migrateSettings({ maxResults: 250 }).maxResults).toBe(250);
		expect(migrateSettings({ maxResults: 33.6 }).maxResults).toBe(34);
		expect(migrateSettings({ maxResults: 99_999 }).maxResults).toBe(1000);
	});

	it('falls back to the default for a number that is not one', () => {
		const bad: ReadonlyArray<readonly [string, unknown]> = [
			['NaN', Number.NaN],
			['Infinity', Number.POSITIVE_INFINITY],
			['negative', -1],
			['numeric string', '3'],
			['null', null],
			['object', {}],
			['array', []],
		];
		for (const [label, value] of bad) {
			expect(migrateSettings({ snippetCount: value }).snippetCount, label).toBe(2);
			expect(migrateSettings({ maxResults: value }).maxResults, label).toBe(200);
		}
	});

	it('trims createdField and falls back when it is empty or not a string', () => {
		expect(migrateSettings({ createdField: '  date  ' }).createdField).toBe('date');
		expect(migrateSettings({ createdField: '' }).createdField).toBe('created');
		expect(migrateSettings({ createdField: '   ' }).createdField).toBe('created');
		expect(migrateSettings({ createdField: 42 }).createdField).toBe('created');
		expect(migrateSettings({ createdField: ['created'] }).createdField).toBe('created');
	});

	it('normalizes, deduplicates and cleans the excluded folders', () => {
		const settings = migrateSettings({
			excludedFolders: [
				'\\Archive\\',
				'Archive',
				'  Templates/Daily  ',
				'Templates//Daily',
				'',
				'   ',
				'/',
				7,
				null,
				['Projekte'],
			],
		});
		expect(settings.excludedFolders).toEqual(['Archive', 'Templates/Daily']);
	});

	it('treats a non-array folder list as no folders', () => {
		expect(migrateSettings({ excludedFolders: 'Archive' }).excludedFolders).toEqual([]);
		expect(migrateSettings({ excludedFolders: null }).excludedFolders).toEqual([]);
		expect(migrateSettings({ excludedFolders: { 0: 'Archive' } }).excludedFolders).toEqual([]);
	});

	it('accepts only real booleans', () => {
		expect(migrateSettings({ fuzzyByDefault: true }).fuzzyByDefault).toBe(true);
		expect(migrateSettings({ fuzzyByDefault: 'yes' }).fuzzyByDefault).toBe(false);
		expect(migrateSettings({ includeSubfoldersByDefault: false }).includeSubfoldersByDefault).toBe(false);
		expect(migrateSettings({ includeSubfoldersByDefault: 0 }).includeSubfoldersByDefault).toBe(true);
		expect(migrateSettings({ forceRebuild: true }).forceRebuild).toBe(true);
		expect(migrateSettings({ forceRebuild: 1 }).forceRebuild).toBe(false);
	});

	it('survives a hostile object instead of throwing', () => {
		const hostile = {
			get snippetCount(): number {
				throw new Error('boom');
			},
		};
		expect(() => migrateSettings(hostile)).not.toThrow();
		expect(migrateSettings(hostile)).toEqual({ ...DEFAULT_SETTINGS, excludedFolders: [] });

		const nullProto = Object.assign(Object.create(null), { snippetCount: 3 }) as unknown;
		expect(migrateSettings(nullProto).snippetCount).toBe(3);
	});

	it('is idempotent', () => {
		const once = migrateSettings({ snippetCount: 9, excludedFolders: ['\\Archive\\'], language: 'de' });
		expect(migrateSettings(once)).toEqual(once);
	});
});

/* -------------------------------------------------------------------------- */
/* The tab: rendering                                                         */
/* -------------------------------------------------------------------------- */

/** A string that still looks like `settings.foo.name` never made it through `t()`. */
const KEY_LIKE = /^[a-z][A-Za-z0-9]*(\.[a-zA-Z0-9-]+)+$/;

/** Walks up from `HTMLElement.prototype` to whichever prototype really owns `prop`. */
function ownerOf(prop: string): object | null {
	let proto: object | null = HTMLElement.prototype;
	while (proto !== null) {
		if (Object.getOwnPropertyDescriptor(proto, prop) !== undefined) return proto;
		proto = Object.getPrototypeOf(proto) as object | null;
	}
	return null;
}

/** The sinks the store review bot greps for, and how each one is trapped. */
const HTML_SINKS: ReadonlyArray<{ readonly prop: string; readonly kind: 'accessor' | 'method' }> = [
	{ prop: 'innerHTML', kind: 'accessor' },
	{ prop: 'outerHTML', kind: 'accessor' },
	{ prop: 'insertAdjacentHTML', kind: 'method' },
];

/** Runs `body` with every HTML sink armed to throw, then puts the DOM back. */
function withHtmlSinksForbidden(body: () => void): void {
	const restore: Array<() => void> = [];
	let armed = 0;
	for (const { prop, kind } of HTML_SINKS) {
		const owner = ownerOf(prop);
		if (owner === null) continue;
		const descriptor = Object.getOwnPropertyDescriptor(owner, prop);
		if (descriptor === undefined || descriptor.configurable !== true) continue;
		const trap = (): never => {
			throw new Error(`${prop} was used`);
		};
		Object.defineProperty(
			owner,
			prop,
			kind === 'accessor' ? { ...descriptor, set: trap } : { ...descriptor, value: trap },
		);
		restore.push(() => {
			Object.defineProperty(owner, prop, descriptor);
		});
		armed += 1;
	}
	expect(armed, 'no HTML sink could be trapped').toBe(HTML_SINKS.length);

	try {
		body();
	} finally {
		for (const undo of restore.reverse()) undo();
	}
}

describe('SiftSettingTab.display', () => {
	it('renders without touching an HTML sink', () => {
		const harness = createHarness();
		withHtmlSinksForbidden(() => {
			// Proves the trap fires, so the assertion below means something. The
			// property is reached through a computed key: writing it out would be
			// the very thing the linter forbids in this repo.
			const probe = document.createElement('div') as unknown as Record<string, string>;
			expect(() => {
				probe['innerHTML'] = '<b>x</b>';
			}).toThrow();
			expect(() => harness.tab.display()).not.toThrow();
		});
		expect(harness.container.querySelectorAll('.setting-item').length).toBeGreaterThan(8);
	});

	it('gives every rendered label a non-empty, translated text', () => {
		const harness = createHarness();
		harness.tab.display();

		const names = Array.from(harness.container.querySelectorAll('.setting-item-name'));
		// Eight general rows, the index heading and its two rows.
		expect(names.length).toBe(11);
		for (const name of names) {
			const text = (name.textContent ?? '').trim();
			expect(text.length, name.className).toBeGreaterThan(0);
			expect(text, 'untranslated key rendered').not.toMatch(KEY_LIKE);
		}

		for (const desc of Array.from(harness.container.querySelectorAll('.setting-item-description'))) {
			const text = (desc.textContent ?? '').trim();
			if (text.length === 0) continue;
			expect(text).not.toMatch(KEY_LIKE);
		}
	});

	it('builds the one section heading with setHeading, not with an HTML heading', () => {
		const harness = createHarness();
		harness.tab.display();

		expect(harness.container.querySelectorAll('h1, h2, h3, h4, h5, h6').length).toBe(0);

		const headings = Array.from(harness.container.querySelectorAll('.setting-item-heading'));
		expect(headings.length).toBe(1);
		const label = (headings[0].querySelector('.setting-item-name')?.textContent ?? '').trim();
		expect(label).toBe(t('settings.heading.index'));
		expect(label.toLowerCase()).not.toContain('setting');
		expect(label.toLowerCase()).not.toContain('sift');
	});

	it('puts no heading above the general block', () => {
		const harness = createHarness();
		harness.tab.display();
		const items = Array.from(harness.container.querySelectorAll('.setting-item'));
		const firstHeading = items.findIndex((item) => item.classList.contains('setting-item-heading'));
		// The eight general rows come first; the index heading opens the second block.
		expect(firstHeading).toBe(8);
	});

	it('shows the current values in the controls', () => {
		const harness = createHarness({
			defaultSort: 'title-asc',
			snippetCount: 3,
			createdField: 'date',
			excludedFolders: ['Archive', 'Templates/Daily'],
			language: 'de',
			maxResults: 400,
		});
		harness.tab.display();

		const [sortSelect, languageSelect] = selects(harness);
		expect(sortSelect.value).toBe('title-asc');
		expect(Array.from(sortSelect.options).map((option) => option.value)).toEqual([
			'relevance',
			'created-desc',
			'created-asc',
			'modified-desc',
			'modified-asc',
			'title-asc',
			'path-asc',
		]);
		expect(languageSelect.value).toBe('de');
		expect(Array.from(languageSelect.options).map((option) => option.value)).toEqual(['auto', 'en', 'de']);

		const [snippetSlider, maxResultsSlider] = sliders(harness);
		expect(snippetSlider.value).toBe('3');
		expect(snippetSlider.min).toBe('1');
		expect(snippetSlider.max).toBe('3');
		expect(maxResultsSlider.value).toBe('400');
		expect(maxResultsSlider.min).toBe('20');
		expect(maxResultsSlider.max).toBe('1000');

		const createdInput = settingByClass(harness, 'sift-setting-created-field').querySelector('input');
		expect(createdInput?.value).toBe('date');
		const folderArea = settingByClass(harness, 'sift-setting-excluded-folders').querySelector('textarea');
		expect(folderArea?.value).toBe('Archive\nTemplates/Daily');
	});

	it('replaces its content instead of appending on a second render', () => {
		const harness = createHarness();
		harness.tab.display();
		const first = harness.container.querySelectorAll('.setting-item').length;
		harness.tab.display();
		expect(harness.container.querySelectorAll('.setting-item').length).toBe(first);
	});
});

/* -------------------------------------------------------------------------- */
/* The tab: index section                                                     */
/* -------------------------------------------------------------------------- */

describe('index section', () => {
	it('reports the counters from the indexer', () => {
		const harness = createHarness();
		harness.tab.display();

		const status = settingByClass(harness, 'sift-index-status');
		const expectedSize = new Intl.NumberFormat('en', {
			style: 'unit',
			unit: 'megabyte',
			unitDisplay: 'short',
			maximumFractionDigits: 1,
		}).format(42);
		const expected = t('index.status', { count: new Intl.NumberFormat('en').format(1234), size: expectedSize });

		expect((status.querySelector('.setting-item-name')?.textContent ?? '').trim()).toBe(expected);
		expect((status.querySelector('.setting-item-description')?.textContent ?? '').trim().length).toBeGreaterThan(0);
	});

	it('uses the singular line for a one-note vault', () => {
		const harness = createHarness();
		harness.setStats({ ...SAMPLE_STATS, fileCount: 1 });
		harness.tab.display();
		const status = settingByClass(harness, 'sift-index-status');
		expect((status.querySelector('.setting-item-name')?.textContent ?? '').trim()).toContain('1 note indexed');
	});

	it('falls back to the empty line while the index is not up', () => {
		const harness = createHarness();
		harness.setStats(null);
		expect(() => harness.tab.display()).not.toThrow();
		const status = settingByClass(harness, 'sift-index-status');
		expect((status.querySelector('.setting-item-name')?.textContent ?? '').trim()).toBe(t('index.statusEmpty'));
		expect((status.querySelector('.setting-item-description')?.textContent ?? '').trim()).toBe('');
	});

	/* ---------------------------------------------------------------------- */
	/* A build that threw                                                     */
	/* ---------------------------------------------------------------------- */

	// `Indexer.build()` catches everything, keeps whatever it had indexed and
	// reports ready, so the status line used to read "No notes indexed yet" — the
	// same sentence an untouched empty vault produces. The user had no way to tell
	// a broken index from an empty one, and no reason to press rebuild.
	it('tells a failed build apart from an empty vault, and names the reason', () => {
		const harness = createHarness();
		harness.setStats(null);
		harness.setFailure('RangeError');
		harness.tab.display();

		const status = settingByClass(harness, 'sift-index-status');
		expect((status.querySelector('.setting-item-name')?.textContent ?? '').trim()).toBe(t('index.statusFailed'));
		expect((status.querySelector('.setting-item-name')?.textContent ?? '').trim())
			.not.toBe(t('index.statusEmpty'));
		expect((status.querySelector('.setting-item-description')?.textContent ?? '').trim())
			.toBe(t('index.failureReason', { reason: 'RangeError' }));
	});

	it('reports the failure even when a partial index answers with counters', () => {
		const harness = createHarness();
		harness.setStats({ ...SAMPLE_STATS, fileCount: 12 });
		harness.setFailure('QuotaExceededError');
		harness.tab.display();

		const status = settingByClass(harness, 'sift-index-status');
		const name = (status.querySelector('.setting-item-name')?.textContent ?? '').trim();
		expect(name).toBe(t('index.statusFailed'));
		expect(name).not.toContain('12');
	});

	it('offers a rebuild on the failed status line itself', async () => {
		const harness = createHarness();
		harness.setStats(null);
		harness.setFailure('RangeError');
		harness.tab.display();

		const status = settingByClass(harness, 'sift-index-status');
		const button = status.querySelector('button');
		expect(button, 'the failed status line offers no way out').not.toBeNull();
		expect(button?.textContent).toBe(t('index.rebuild.button'));

		button?.click();
		await settle();
		expect(harness.rebuilds).toBe(1);
		expect(harness.saves[0].forceRebuild).toBe(true);
	});

	it('keeps the status line free of a button while the index is healthy', () => {
		const harness = createHarness();
		harness.tab.display();

		expect(settingByClass(harness, 'sift-index-status').querySelector('button')).toBeNull();
	});

	it('rebuilds through the plugin, flagging the rebuild before it starts', async () => {
		const harness = createHarness();
		harness.tab.display();

		const button = harness.container.querySelector('button');
		expect(button).not.toBeNull();
		button?.click();
		await settle();

		expect(harness.rebuilds).toBe(1);
		// The flag is persisted before the work and cleared after it, so an
		// interrupted rebuild is picked up on the next start.
		expect(harness.saves[0].forceRebuild).toBe(true);
		expect(harness.plugin.settings.forceRebuild).toBe(false);
		expect(Notice.messages).toEqual([t('index.rebuild.started'), expect.stringContaining('1,234')]);
	});

	it('reports a failed rebuild without leaking anything into the message', async () => {
		const harness = createHarness();
		harness.failRebuild();
		harness.tab.display();

		harness.container.querySelector('button')?.click();
		await settle();

		expect(Notice.messages).toEqual([t('index.rebuild.started'), t('error.indexFailed')]);
		// Still usable afterwards.
		expect(harness.container.querySelector('button')?.disabled).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */
/* The tab: changes                                                           */
/* -------------------------------------------------------------------------- */

describe('changing a display-only setting', () => {
	it('saves the new sort order without changing what the index depends on', () => {
		const harness = createHarness();
		const before = indexFingerprint(harness.plugin.settings);
		harness.tab.display();

		setSelect(selects(harness)[0], 'created-asc');

		expect(harness.plugin.settings.defaultSort).toBe('created-asc');
		expect(harness.saves.length).toBe(1);
		expect(indexFingerprint(harness.plugin.settings)).toBe(before);
	});

	it('ignores a sort value that is not a SortKey', () => {
		const harness = createHarness();
		harness.tab.display();
		const select = selects(harness)[0];
		select.value = 'title-asc';
		// Bypasses the option list the way a corrupted DOM or an extension would.
		Object.defineProperty(select, 'value', { value: 'nonsense', configurable: true });
		select.dispatchEvent(new Event('change'));
		expect(harness.plugin.settings.defaultSort).toBe('relevance');
	});

	it('saves the clamped slider values', () => {
		const harness = createHarness();
		harness.tab.display();

		setSlider(sliders(harness)[0], 3);
		expect(harness.plugin.settings.snippetCount).toBe(3);

		setSlider(sliders(harness)[1], 640);
		expect(harness.plugin.settings.maxResults).toBe(640);

		setSlider(sliders(harness)[1], 99_999);
		expect(harness.plugin.settings.maxResults).toBe(1000);

		expect(harness.saves.length).toBe(3);
	});

	it('saves both toggles', () => {
		const harness = createHarness();
		harness.tab.display();
		const [fuzzy, subfolders] = toggles(harness);

		fuzzy.dispatchEvent(new Event('click'));
		subfolders.dispatchEvent(new Event('click'));

		expect(harness.plugin.settings.fuzzyByDefault).toBe(true);
		expect(harness.plugin.settings.includeSubfoldersByDefault).toBe(false);
		expect(harness.saves.length).toBe(2);
	});

	it('re-renders in the chosen language', () => {
		const harness = createHarness();
		harness.tab.display();
		const englishFirstLabel = harness.container.querySelector('.setting-item-name')?.textContent;

		setSelect(selects(harness)[1], 'de');

		expect(harness.plugin.settings.language).toBe('de');
		expect(harness.saves.length).toBe(1);
		const germanFirstLabel = harness.container.querySelector('.setting-item-name')?.textContent;
		expect(germanFirstLabel).not.toBe(englishFirstLabel);
		expect(germanFirstLabel).toBe(t('settings.defaultSort.name'));
	});
});

describe('changing a setting the index depends on', () => {
	it('normalizes every folder line and commits once the typing stops', () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const before = indexFingerprint(harness.plugin.settings);
		harness.tab.display();
		const area = settingByClass(harness, 'sift-setting-excluded-folders').querySelector('textarea');
		expect(area).not.toBeNull();
		if (area === null) return;

		type(area, 'Archiv');
		type(area, 'Archiv\n');
		type(area, 'Archiv\n\\Templates\\Daily\\');

		// Nothing written yet: one rebuild per keystroke is exactly what the
		// debounce exists to prevent.
		expect(harness.saves.length).toBe(0);
		expect(harness.plugin.settings.excludedFolders).toEqual(['Archiv', 'Templates/Daily']);

		vi.advanceTimersByTime(1000);
		expect(harness.saves.length).toBe(1);
		expect(harness.saves[0].excludedFolders).toEqual(['Archiv', 'Templates/Daily']);
		expect(indexFingerprint(harness.plugin.settings)).not.toBe(before);
	});

	it('commits the created field once the typing stops', () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const before = indexFingerprint(harness.plugin.settings);
		harness.tab.display();
		const input = settingByClass(harness, 'sift-setting-created-field').querySelector('input');
		if (input === null) throw new Error('no created-field input');

		for (const value of ['d', 'da', 'dat', 'date']) type(input, value);
		expect(harness.saves.length).toBe(0);

		vi.advanceTimersByTime(1000);
		expect(harness.saves.length).toBe(1);
		expect(harness.plugin.settings.createdField).toBe('date');
		expect(indexFingerprint(harness.plugin.settings)).not.toBe(before);
	});

	it('falls back to the default field when the box is cleared', () => {
		vi.useFakeTimers();
		const harness = createHarness({ createdField: 'date' });
		harness.tab.display();
		const input = settingByClass(harness, 'sift-setting-created-field').querySelector('input');
		if (input === null) throw new Error('no created-field input');

		type(input, '   ');
		vi.advanceTimersByTime(1000);
		expect(harness.plugin.settings.createdField).toBe('created');
	});

	it('flushes a pending edit when the tab closes', () => {
		vi.useFakeTimers();
		const harness = createHarness();
		harness.tab.display();
		const input = settingByClass(harness, 'sift-setting-created-field').querySelector('input');
		if (input === null) throw new Error('no created-field input');

		type(input, 'erstellt');
		expect(harness.saves.length).toBe(0);

		harness.tab.hide();

		expect(harness.saves.length).toBe(1);
		expect(harness.saves[0].createdField).toBe('erstellt');
		// And the timer that was pending does not fire a second save.
		vi.advanceTimersByTime(2000);
		expect(harness.saves.length).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */
/* Store policy                                                               */
/* -------------------------------------------------------------------------- */

describe('store policy', () => {
	// happy-dom leaves `import.meta.url` on a non-file scheme, so the path is
	// resolved from the vitest working directory, which is the repo root.
	const source = readFileSync(join(process.cwd(), 'src', 'settings.ts'), 'utf8');

	it('mentions nothing that belongs to the paid part', () => {
		expect(source).not.toMatch(
			/\b(licen[cs]e|lizenz|subscription|abo|abonnement|trial|premium|upgrade|price|pricing|preis|polar|openai|anthropic|mistral)\b/i,
		);
	});

	it('contains no URL and no network call', () => {
		expect(source).not.toMatch(/https?:\/\//);
		expect(source).not.toMatch(/\b(fetch|requestUrl|XMLHttpRequest|WebSocket|sendBeacon)\b/);
	});

	it('uses no HTML sink, no console and no global app', () => {
		expect(source).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
		expect(source).not.toMatch(/\bconsole\./);
		expect(source).not.toMatch(/(^|[^.\w])app\./);
	});

	it('prefixes every own CSS class with sift-', () => {
		for (const match of source.matchAll(/setClass\('([^']+)'\)|addClass\('([^']+)'\)/g)) {
			expect(match[1] ?? match[2]).toMatch(/^sift-/);
		}
	});
});
