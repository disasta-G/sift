/**
 * settings — default settings, default tuning constants, forward-compatible
 * migration of data.json, and the settings tab.
 *
 * Phase 1 fields only: everything here is local search, so nothing beyond it
 * exists in the repo for the review bot to find. Also hosts the index
 * statistics readout and the 'Rebuild index' button.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEFAULTS ARE DEEPLY FROZEN
 * ---------------------------------------------------------------------------
 * `DEFAULT_SETTINGS` is read by every module and by the benchmark script. A
 * single `settings.excludedFolders.push(...)` somewhere would leak into every
 * later `migrateSettings()` result and, through the settings fingerprint, into
 * the persisted index. Freezing turns that class of bug into a throw at the
 * scene of the crime instead of a stale index three sessions later. Every value
 * handed out is therefore a fresh, mutable copy — see {@link freshDefaults}.
 *
 * ---------------------------------------------------------------------------
 * WHICH CHANGES COST A REBUILD
 * ---------------------------------------------------------------------------
 * Only `createdField` and `excludedFolders` decide what ends up in the index;
 * everything else on this tab is presentation. Both of those are edited in a
 * free-text control, so committing on every keystroke would queue a full vault
 * rebuild per character. They are debounced by {@link COMMIT_DELAY_MS} and
 * flushed in {@link SiftSettingTab.hide}; the display-only settings save
 * immediately. `Plugin.saveSettings()` compares the fingerprint and rebuilds
 * only when it actually changed.
 */

import { Notice, PluginSettingTab, Setting, debounce, getLanguage, normalizePath } from 'obsidian';
import type { App, ButtonComponent, Debouncer, SettingDefinitionItem } from 'obsidian';
import { dateFormatLocale, setLanguage, t } from './i18n/index';
import type { TranslationKey } from './i18n/index';
import type { IndexStats, LanguageSetting, SiftSettings, SiftTuning, SortKey, VaultPath } from './types';
import { DEFAULT_DISMISS_HOTKEY, DEFAULT_KEEP_HOTKEY, canonicalHotkey } from './hotkey';
import type { HotkeySetting } from './hotkey';
import type SiftPlugin from './main';

/* ========================================================================== */
/* 1. Defaults                                                                */
/* ========================================================================== */

/**
 * Recursively freezes a plain object graph.
 *
 * Freezing happens before the recursion, which makes an already-frozen node the
 * termination condition and so tolerates a cycle. It assumes plain literals:
 * a shallow-frozen input would be left as it is.
 */
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	Object.freeze(value);
	for (const key of Object.getOwnPropertyNames(value)) {
		deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}

/** Frozen. Never mutate; clone before changing. */
export const DEFAULT_SETTINGS: SiftSettings = deepFreeze({
	version: 1,
	defaultSort: 'relevance',
	snippetCount: 2,
	createdField: 'created',
	excludedFolders: [],
	language: 'auto',
	fuzzyByDefault: false,
	includeSubfoldersByDefault: true,
	maxResults: 200,
	keepHotkey: DEFAULT_KEEP_HOTKEY,
	dismissHotkey: DEFAULT_DISMISS_HOTKEY,
	forceRebuild: false,
} satisfies SiftSettings);

/** Frozen tuning constants: trigramSize 3, minTrigramTermLength 3, maxTermVariants 8, snippetLength 160,
 *  snippetLines 5, distance 1 up to 5 chars / 2 from 6, searchDebounceMs 120, indexSliceMs 12,
 *  weights { title 3.0, frontmatter 2.0, tag 2.0, heading 1.5, body 1.0, path 1.0, wholeWord 1.3, fuzzy 0.7 }.
 *
 *  There is deliberately no `fuzzyTrigramSimilarity` here any more: a constant
 *  share of the term's trigrams rejected a short term's true matches before the
 *  distance pass could see them. The floor is derived from the distance budget
 *  instead — see the note on `SiftTuning.fuzzyMaxDistanceShort`. */
export const DEFAULT_TUNING: SiftTuning = deepFreeze({
	trigramSize: 3,
	minTrigramTermLength: 3,
	maxTermVariants: 8,
	maxQueryLength: 512,
	snippetLength: 160,
	snippetLines: 5,
	fuzzyMaxDistanceShort: 1,
	fuzzyMaxDistanceLong: 2,
	fuzzyShortTermMaxLength: 5,
	searchDebounceMs: 120,
	indexSliceMs: 12,
	storeBatchSize: 200,
	weights: {
		field: {
			title: 3.0,
			path: 1.0,
			frontmatter: 2.0,
			tag: 2.0,
			heading: 1.5,
			body: 1.0,
		},
		wholeWordBonus: 1.3,
		maxProximityBonus: 1.4,
		proximityWindow: 400,
		maxRecencyBonus: 1.15,
		recencyHalfLifeDays: 365,
		fuzzyPenalty: 0.7,
		aliasPenalty: 0.95,
	},
} satisfies SiftTuning);

/** Accepted range of {@link SiftSettings.snippetCount}. */
const SNIPPET_COUNT_MIN = 1;
const SNIPPET_COUNT_MAX = 3;

/** Accepted range of {@link SiftSettings.maxResults}. Below 20 the list stops being useful, above 1000 it stops being fast. */
const MAX_RESULTS_MIN = 20;
const MAX_RESULTS_MAX = 1000;
const MAX_RESULTS_STEP = 20;

/** How long a free-text control that invalidates the index waits before it commits. */
const COMMIT_DELAY_MS = 700;

/**
 * Sort orders in the order the dropdown lists them, each with its label key.
 * Typed as a total record, so adding a {@link SortKey} is a compile error until
 * it has a label here — and the same table doubles as the validator in
 * {@link migrateSettings}.
 */
const SORT_LABEL_KEYS: Readonly<Record<SortKey, TranslationKey>> = {
	relevance: 'sort.relevance',
	'created-desc': 'sort.created-desc',
	'created-asc': 'sort.created-asc',
	'modified-desc': 'sort.modified-desc',
	'modified-asc': 'sort.modified-asc',
	'title-asc': 'sort.title-asc',
	'path-asc': 'sort.path-asc',
};

/** Same idea for the language setting. */
const LANGUAGE_LABEL_KEYS: Readonly<Record<LanguageSetting, TranslationKey>> = {
	auto: 'settings.language.auto',
	en: 'settings.language.en',
	de: 'settings.language.de',
};

/* ========================================================================== */
/* 2. Migration                                                               */
/* ========================================================================== */

/** A fresh, mutable copy of the defaults. The frozen original never leaves this module. */
function freshDefaults(): SiftSettings {
	return {
		version: 1,
		defaultSort: DEFAULT_SETTINGS.defaultSort,
		snippetCount: DEFAULT_SETTINGS.snippetCount,
		createdField: DEFAULT_SETTINGS.createdField,
		excludedFolders: [],
		language: DEFAULT_SETTINGS.language,
		fuzzyByDefault: DEFAULT_SETTINGS.fuzzyByDefault,
		includeSubfoldersByDefault: DEFAULT_SETTINGS.includeSubfoldersByDefault,
		maxResults: DEFAULT_SETTINGS.maxResults,
		keepHotkey: DEFAULT_SETTINGS.keepHotkey,
		dismissHotkey: DEFAULT_SETTINGS.dismissHotkey,
		forceRebuild: DEFAULT_SETTINGS.forceRebuild,
	};
}

/** Fills in missing keys and drops unknown ones. Accepts null, undefined and any malformed data.json without throwing. */
export function migrateSettings(raw: unknown): SiftSettings {
	try {
		return migrateRecord(asRecord(raw));
	} catch {
		// data.json is user-editable and is not always the JSON we wrote — a hostile
		// or exotic value must never keep the plugin from loading.
		return freshDefaults();
	}
}

function migrateRecord(source: Record<string, unknown>): SiftSettings {
	return {
		// Only one schema exists so far; the field is written, never read back.
		version: 1,
		defaultSort: isSortKey(source.defaultSort) ? source.defaultSort : DEFAULT_SETTINGS.defaultSort,
		snippetCount: migrateNumber(
			source.snippetCount,
			DEFAULT_SETTINGS.snippetCount,
			SNIPPET_COUNT_MIN,
			SNIPPET_COUNT_MAX,
		),
		createdField: migrateCreatedField(source.createdField),
		excludedFolders: migrateFolders(source.excludedFolders),
		language: isLanguage(source.language) ? source.language : DEFAULT_SETTINGS.language,
		fuzzyByDefault: migrateBoolean(source.fuzzyByDefault, DEFAULT_SETTINGS.fuzzyByDefault),
		includeSubfoldersByDefault: migrateBoolean(
			source.includeSubfoldersByDefault,
			DEFAULT_SETTINGS.includeSubfoldersByDefault,
		),
		maxResults: migrateNumber(source.maxResults, DEFAULT_SETTINGS.maxResults, MAX_RESULTS_MIN, MAX_RESULTS_MAX),
		// An unreadable combination falls back to the default rather than leaving
		// the action unbound: a hotkey nobody can press is indistinguishable from
		// a broken plugin.
		keepHotkey: canonicalHotkey(source.keepHotkey) ?? DEFAULT_SETTINGS.keepHotkey,
		dismissHotkey: canonicalHotkey(source.dismissHotkey) ?? DEFAULT_SETTINGS.dismissHotkey,
		forceRebuild: migrateBoolean(source.forceRebuild, DEFAULT_SETTINGS.forceRebuild),
	};
}

/** Anything that is not a plain object — null, a string, a number, an array — carries no settings. */
function asRecord(raw: unknown): Record<string, unknown> {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}
	return raw as Record<string, unknown>;
}

function isSortKey(value: unknown): value is SortKey {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SORT_LABEL_KEYS, value);
}

function isLanguage(value: unknown): value is LanguageSetting {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGE_LABEL_KEYS, value);
}

function migrateBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/**
 * A number outside the type, NaN, an infinity or a negative value is treated as
 * corruption and falls back to the default; a finite value inside the sign is
 * merely out of range and gets clamped, because that keeps the user's intent
 * ("as many as possible") rather than discarding it.
 */
function migrateNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.round(value)));
}

function migrateCreatedField(value: unknown): string {
	if (typeof value !== 'string') {
		return DEFAULT_SETTINGS.createdField;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? DEFAULT_SETTINGS.createdField : trimmed;
}

function migrateFolders(value: unknown): VaultPath[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const strings: string[] = [];
	for (const entry of value) {
		if (typeof entry === 'string') {
			strings.push(entry);
		}
	}
	return sanitizeFolders(strings);
}

/**
 * Normalizes, deduplicates and drops the unusable entries of a folder list.
 *
 * `normalizePath('')` is the vault root, and excluding the root would exclude
 * the whole vault — always by accident, since the user can just switch the
 * plugin off. Blank lines are therefore dropped before normalization and the
 * root is dropped after it.
 */
function sanitizeFolders(lines: readonly string[]): VaultPath[] {
	const folders: VaultPath[] = [];
	const seen = new Set<VaultPath>();
	for (const line of lines) {
		if (line.trim().length === 0) {
			continue;
		}
		const folder = normalizePath(line.trim());
		if (folder.length === 0 || folder === '/' || seen.has(folder)) {
			continue;
		}
		seen.add(folder);
		folders.push(folder);
	}
	return folders;
}

/* ========================================================================== */
/* 3. Settings tab                                                            */
/* ========================================================================== */

export class SiftSettingTab extends PluginSettingTab {
	private readonly siftPlugin: SiftPlugin;

	/**
	 * Deferred commit for the two controls that invalidate the index. One
	 * debouncer for both: they always save the same object, and a folder edit
	 * that lands during a `createdField` edit should not start a second rebuild.
	 */
	private readonly commitLater: Debouncer<[], void>;

	constructor(app: App, plugin: SiftPlugin) {
		super(app, plugin);
		this.siftPlugin = plugin;
		this.commitLater = debounce(
			(): void => {
				void this.persist();
			},
			COMMIT_DELAY_MS,
			true,
		);
	}

	/**
	 * The pre-1.13.0 tab. Obsidian marks this deprecated because the declarative
	 * definitions replace it, and from 1.13.0 on it is never called - but
	 * manifest.json admits 1.8.7, where it is the only way the tab exists at
	 * all. It is a one-line adapter so that nothing inside the plugin has to
	 * call a deprecated method to redraw; {@link refresh} calls {@link paint}.
	 */
	override display(): void {
		this.paint();
	}

	/** Builds the tab imperatively. The body of the old `display()`. */
	private paint(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('sift-settings');

		// No heading above this first block: the community guidelines reserve the
		// top of a settings tab for the general options and want a heading only
		// where a second section starts.
		this.renderDefaultSort(containerEl);
		this.renderSnippetCount(containerEl);
		this.renderCreatedField(containerEl);
		this.renderExcludedFolders(containerEl);
		this.renderLanguage(containerEl);
		this.renderFuzzyByDefault(containerEl);
		this.renderIncludeSubfolders(containerEl);
		this.renderMaxResults(containerEl);
		this.renderHotkey(containerEl, 'keepHotkey');
		this.renderHotkey(containerEl, 'dismissHotkey');

		new Setting(containerEl).setName(t('settings.heading.index')).setHeading();
		this.renderIndexStatus(containerEl);
		this.renderRebuild(containerEl);
	}

	/** Flushes a pending folder or field edit, so closing the tab is a commit. */
	override hide(): void {
		this.commitLater.run();
		super.hide();
	}

	/* ---------------------------------------------------------------------- */
	/* Declarative definitions - Obsidian 1.13.0 and newer                    */
	/* ---------------------------------------------------------------------- */

	/**
	 * The same settings as {@link display}, declared instead of built.
	 *
	 * From 1.13.0 on Obsidian renders the tab from this array and does not call
	 * `display()` at all. `display()` stays because `manifest.json` still admits
	 * 1.8.7, so both have to describe the same tab. They agree by construction:
	 * the labels come from the same i18n keys, and every write goes through
	 * {@link setControlValue}, which applies the same guards the imperative
	 * handlers do.
	 *
	 * The reason for declaring them at all is Obsidian's settings search. A
	 * setting the app cannot enumerate is one the user cannot find by typing
	 * its name, and the imperative tab is opaque to it.
	 */
	override getSettingDefinitions(): SettingDefinitionItem[] {
		// No group around the first block: the guidelines reserve the top of a
		// tab for the general options and want a heading only where a second
		// section starts. Same reasoning as in display().
		return [
			{
				name: t('settings.defaultSort.name'),
				desc: t('settings.defaultSort.desc'),
				control: { type: 'dropdown', key: 'defaultSort', options: labelled(sortOptions()) },
			},
			{
				name: t('settings.snippetCount.name'),
				desc: t('settings.snippetCount.desc'),
				control: {
					type: 'slider',
					key: 'snippetCount',
					min: SNIPPET_COUNT_MIN,
					max: SNIPPET_COUNT_MAX,
					step: 1,
				},
			},
			{
				name: t('settings.createdField.name'),
				desc: t('settings.createdField.desc'),
				control: {
					type: 'text',
					key: 'createdField',
					placeholder: t('settings.createdField.placeholder'),
				},
			},
			{
				name: t('settings.excludedFolders.name'),
				desc: t('settings.excludedFolders.desc'),
				control: {
					type: 'textarea',
					key: 'excludedFolders',
					placeholder: t('settings.excludedFolders.placeholder'),
					rows: 4,
				},
			},
			{
				name: t('settings.language.name'),
				desc: t('settings.language.desc'),
				control: { type: 'dropdown', key: 'language', options: labelled(languageOptions()) },
			},
			{
				name: t('settings.fuzzyByDefault.name'),
				desc: t('settings.fuzzyByDefault.desc'),
				control: { type: 'toggle', key: 'fuzzyByDefault' },
			},
			{
				name: t('settings.includeSubfolders.name'),
				desc: t('settings.includeSubfolders.desc'),
				control: { type: 'toggle', key: 'includeSubfoldersByDefault' },
			},
			{
				name: t('settings.maxResults.name'),
				desc: t('settings.maxResults.desc'),
				control: {
					type: 'slider',
					key: 'maxResults',
					min: MAX_RESULTS_MIN,
					max: MAX_RESULTS_MAX,
					step: MAX_RESULTS_STEP,
				},
			},
			{
				name: t('settings.keepHotkey.name'),
				desc: t('settings.keepHotkey.desc'),
				control: { type: 'text', key: 'keepHotkey', placeholder: DEFAULT_KEEP_HOTKEY },
			},
			{
				name: t('settings.dismissHotkey.name'),
				desc: t('settings.dismissHotkey.desc'),
				control: { type: 'text', key: 'dismissHotkey', placeholder: DEFAULT_DISMISS_HOTKEY },
			},
			{
				type: 'group',
				heading: t('settings.heading.index'),
				// Rendered rather than declared: the status line is a reading of
				// live index state, and the buttons act instead of holding a
				// value. Both reuse the imperative builders, so there is one
				// implementation of each, not two.
				items: [
					{
						name: statusLine(this.readStats(), this.readFailure()),
						searchable: false,
						render: (setting) => {
							this.fillIndexStatus(setting);
						},
					},
					{
						name: t('index.rebuild'),
						desc: t('index.rebuild.desc'),
						render: (setting) => {
							this.fillRebuild(setting);
						},
					},
				],
			},
		];
	}

	/**
	 * Reads a value for the declarative renderer. The two free-text controls
	 * hold a different shape than the setting does, so they convert here and in
	 * {@link setControlValue} rather than anywhere else.
	 */
	override getControlValue(key: string): unknown {
		if (key === 'excludedFolders') return this.settings.excludedFolders.join('\n');
		return this.settings[key as keyof SiftSettings];
	}

	/**
	 * Writes a value from the declarative renderer, through the same guards the
	 * imperative handlers use: an out-of-range number falls back to its default,
	 * a folder list is sanitized, and the two settings that invalidate the index
	 * are committed late instead of on every keystroke.
	 */
	override setControlValue(key: string, value: unknown): void {
		switch (key) {
			case 'defaultSort':
				this.settings.defaultSort = isSortKey(value) ? value : DEFAULT_SETTINGS.defaultSort;
				void this.persist();
				return;
			case 'snippetCount':
				this.settings.snippetCount = migrateNumber(
					value,
					DEFAULT_SETTINGS.snippetCount,
					SNIPPET_COUNT_MIN,
					SNIPPET_COUNT_MAX,
				);
				void this.persist();
				return;
			case 'maxResults':
				this.settings.maxResults = migrateNumber(
					value,
					DEFAULT_SETTINGS.maxResults,
					MAX_RESULTS_MIN,
					MAX_RESULTS_MAX,
				);
				void this.persist();
				return;
			case 'createdField':
				this.settings.createdField = migrateCreatedField(value);
				this.commitLater();
				return;
			case 'excludedFolders':
				this.settings.excludedFolders = sanitizeFolders(
					(typeof value === 'string' ? value : '').split('\n'),
				);
				this.commitLater();
				return;
			case 'language': {
				const language = isLanguage(value) ? value : DEFAULT_SETTINGS.language;
				this.settings.language = language;
				void this.persist();
				// Applied here as well as on load, so the tab answers in the new
				// language immediately instead of after a restart.
				setLanguage(language, getLanguage());
				this.refresh();
				return;
			}
			case 'keepHotkey':
			case 'dismissHotkey': {
				const canonical = canonicalHotkey(value);
				if (canonical === null) return;
				this.settings[key] = canonical;
				void this.persist();
				return;
			}
			case 'fuzzyByDefault':
				this.settings.fuzzyByDefault = value === true;
				void this.persist();
				return;
			case 'includeSubfoldersByDefault':
				this.settings.includeSubfoldersByDefault = value === true;
				void this.persist();
				return;
			default:
				return;
		}
	}

	/**
	 * Redraws the tab whichever way it was drawn.
	 *
	 * `update()` arrived with the declarative API in 1.13.0 and is the only
	 * correct redraw there: calling `display()` under it would empty the
	 * container and paint an imperative tab over the declarative one. On 1.8.7
	 * the method does not exist, so the check is a runtime one, not a version
	 * comparison against a string in the manifest.
	 */
	private refresh(): void {
		// Typed as optional on purpose, which is what it actually is here:
		// `update()` exists from 1.13.0, and manifest.json admits 1.8.7. The
		// runtime check is the only place that question can be answered, and
		// this shape says so without claiming an API the minimum version lacks.
		const update = (this as { update?: () => void }).update;
		if (typeof update === 'function') {
			update.call(this);
			return;
		}
		this.paint();
	}

	/* ---------------------------------------------------------------------- */
	/* General                                                                */
	/* ---------------------------------------------------------------------- */

	private renderDefaultSort(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.defaultSort.name'))
			.setDesc(t('settings.defaultSort.desc'))
			.addDropdown((dropdown) => {
				for (const [key, labelKey] of sortOptions()) {
					dropdown.addOption(key, t(labelKey));
				}
				dropdown.setValue(this.settings.defaultSort).onChange((value) => {
					this.settings.defaultSort = isSortKey(value) ? value : DEFAULT_SETTINGS.defaultSort;
					void this.persist();
				});
			});
	}

	private renderSnippetCount(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.snippetCount.name'))
			.setDesc(t('settings.snippetCount.desc'))
			.addSlider((slider) =>
				slider
					.setLimits(SNIPPET_COUNT_MIN, SNIPPET_COUNT_MAX, 1)
					.setValue(this.settings.snippetCount)
					.setDynamicTooltip()
					.onChange((value) => {
						this.settings.snippetCount = migrateNumber(
							value,
							DEFAULT_SETTINGS.snippetCount,
							SNIPPET_COUNT_MIN,
							SNIPPET_COUNT_MAX,
						);
						void this.persist();
					}),
			);
	}

	/**
	 * One of the two curation combinations.
	 *
	 * A text box rather than a recorder that captures the next key press: the
	 * tab exists twice, once built by hand for Obsidian 1.8.7 and once declared
	 * for 1.13.0 and newer, and the declarative form has no control that reads a
	 * key press. A box both forms can render is worth more than a nicer widget on
	 * one of them. What is typed is read generously and written back canonical;
	 * something unreadable falls back to the default rather than unbinding the
	 * action.
	 */
	private renderHotkey(containerEl: HTMLElement, key: HotkeySetting): void {
		new Setting(containerEl)
			.setName(t(`settings.${key}.name` as TranslationKey))
			.setDesc(t(`settings.${key}.desc` as TranslationKey))
			.setClass(key === 'keepHotkey' ? 'sift-setting-keep-hotkey' : 'sift-setting-dismiss-hotkey')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS[key])
					.setValue(this.settings[key])
					.onChange((value) => {
						this.commitHotkey(key, value, text.inputEl);
					}),
			);
	}

	/**
	 * Applies a typed combination.
	 *
	 * The box is only rewritten when the value it holds actually names a
	 * different combination than what was typed, and never while the user is
	 * still typing a valid prefix - rewriting `Mod+` into `Mod+Shift+K` under the
	 * cursor would make the field impossible to edit.
	 */
	private commitHotkey(key: HotkeySetting, value: string, input: HTMLInputElement): void {
		const canonical = canonicalHotkey(value);
		if (canonical === null) return;
		this.settings[key] = canonical;
		void this.persist();
		if (input.value.trim().toLowerCase() === canonical.toLowerCase()) input.value = canonical;
	}

	private renderCreatedField(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.createdField.name'))
			.setDesc(t('settings.createdField.desc'))
			.setClass('sift-setting-created-field')
			.addText((text) =>
				text
					.setPlaceholder(t('settings.createdField.placeholder'))
					.setValue(this.settings.createdField)
					.onChange((value) => {
						this.settings.createdField = migrateCreatedField(value);
						this.commitLater();
					}),
			);
	}

	private renderExcludedFolders(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.excludedFolders.name'))
			.setDesc(t('settings.excludedFolders.desc'))
			.setClass('sift-setting-excluded-folders')
			.addTextArea((area) => {
				area.inputEl.rows = 4;
				area
					.setPlaceholder(t('settings.excludedFolders.placeholder'))
					.setValue(this.settings.excludedFolders.join('\n'))
					.onChange((value) => {
						this.settings.excludedFolders = sanitizeFolders(value.split('\n'));
						this.commitLater();
					});
			});
	}

	private renderLanguage(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.language.name'))
			.setDesc(t('settings.language.desc'))
			.addDropdown((dropdown) => {
				for (const [key, labelKey] of languageOptions()) {
					dropdown.addOption(key, t(labelKey));
				}
				dropdown.setValue(this.settings.language).onChange((value) => {
					const language = isLanguage(value) ? value : DEFAULT_SETTINGS.language;
					this.settings.language = language;
					void this.persist();
					// Applied here as well as on load, so the tab answers in the new
					// language immediately instead of after a restart.
					setLanguage(language, getLanguage());
					this.refresh();
				});
			});
	}

	private renderFuzzyByDefault(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.fuzzyByDefault.name'))
			.setDesc(t('settings.fuzzyByDefault.desc'))
			.addToggle((toggle) =>
				toggle.setValue(this.settings.fuzzyByDefault).onChange((value) => {
					this.settings.fuzzyByDefault = value;
					void this.persist();
				}),
			);
	}

	private renderIncludeSubfolders(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.includeSubfolders.name'))
			.setDesc(t('settings.includeSubfolders.desc'))
			.addToggle((toggle) =>
				toggle.setValue(this.settings.includeSubfoldersByDefault).onChange((value) => {
					this.settings.includeSubfoldersByDefault = value;
					void this.persist();
				}),
			);
	}


	private renderMaxResults(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t('settings.maxResults.name'))
			.setDesc(t('settings.maxResults.desc'))
			.addSlider((slider) =>
				slider
					.setLimits(MAX_RESULTS_MIN, MAX_RESULTS_MAX, MAX_RESULTS_STEP)
					.setValue(this.settings.maxResults)
					.setDynamicTooltip()
					.onChange((value) => {
						this.settings.maxResults = migrateNumber(
							value,
							DEFAULT_SETTINGS.maxResults,
							MAX_RESULTS_MIN,
							MAX_RESULTS_MAX,
						);
						void this.persist();
					}),
			);
	}

	/* ---------------------------------------------------------------------- */
	/* Index                                                                  */
	/* ---------------------------------------------------------------------- */

	/**
	 * How much is indexed and when it was last complete — or, after a build that
	 * threw, that it did.
	 *
	 * WHY THE FAILURE OUTRANKS THE COUNTERS
	 * -------------------------------------
	 * `Indexer.build()` catches everything, keeps whatever it had managed to
	 * index and still reports ready. Read through `stats()` alone, a build that
	 * died on the first note is indistinguishable from a vault with no notes in
	 * it: both produce `index.statusEmpty`, and a partial index produces a count
	 * that looks perfectly healthy. `lastError()` is the only thing that tells
	 * the two apart, so it decides the line, and the reason and a rebuild button
	 * go right next to it rather than in a notice the user has already dismissed.
	 */
	private renderIndexStatus(containerEl: HTMLElement): void {
		this.fillIndexStatus(new Setting(containerEl));
	}

	/**
	 * Fills a row with the status, wherever the row came from: `new Setting()`
	 * under {@link display}, or the one the declarative renderer hands to the
	 * definition's `render`. Setting the name here as well as in the definition
	 * is deliberate - it keeps this the single place the line is composed.
	 */
	private fillIndexStatus(setting: Setting): void {
		const stats = this.readStats();
		const failure = this.readFailure();
		setting.setClass('sift-index-status').setName(statusLine(stats, failure));
		if (failure !== null) {
			setting.setDesc(t('index.failureReason', { reason: failure }));
			setting.addButton((button) =>
				button
					.setButtonText(t('index.rebuild.button'))
					.setCta()
					.onClick(() => {
						void this.rebuild(button);
					}),
			);
			return;
		}
		if (stats !== null && stats.builtAt > 0) {
			setting.setDesc(t('index.lastBuilt', { date: formatDateTime(stats.builtAt) }));
		}
	}

	private renderRebuild(containerEl: HTMLElement): void {
		this.fillRebuild(new Setting(containerEl));
	}

	private fillRebuild(setting: Setting): void {
		setting
			.setName(t('index.rebuild'))
			.setDesc(t('index.rebuild.desc'))
			.addButton((button) =>
				button
					.setButtonText(t('index.rebuild.button'))
					.setCta()
					.onClick(() => {
						void this.rebuild(button);
					}),
			);
	}

	/**
	 * Sets the persisted rebuild flag before the work starts, so a crash or a
	 * closed window in the middle leaves the next start with a rebuild to do
	 * rather than half an index. The Indexer clears the flag; the fallback below
	 * covers an implementation that does not.
	 */
	private async rebuild(button: ButtonComponent): Promise<void> {
		button.setDisabled(true);
		new Notice(t('index.rebuild.started'));
		try {
			this.settings.forceRebuild = true;
			await this.siftPlugin.saveSettings();
			await this.siftPlugin.rebuildIndex();
			if (this.settings.forceRebuild) {
				this.settings.forceRebuild = false;
				await this.siftPlugin.saveSettings();
			}
			new Notice(t('index.rebuild.done', { count: formatCount(this.readStats()?.fileCount ?? 0) }));
		} catch {
			new Notice(t('error.indexFailed'));
		}
		button.setDisabled(false);
		this.refresh();
	}

	/* ---------------------------------------------------------------------- */
	/* Internals                                                              */
	/* ---------------------------------------------------------------------- */

	private get settings(): SiftSettings {
		return this.siftPlugin.settings;
	}

	/**
	 * Counters for the status line, or `null` while the index is not up yet —
	 * the settings tab can be opened before the first build has finished.
	 */
	private readStats(): IndexStats | null {
		try {
			return this.siftPlugin.indexer.stats();
		} catch {
			return null;
		}
	}

	/**
	 * Error name of the last build that threw, or `null` when it finished. Only
	 * the name — the Indexer never hands out a message, a path or note content,
	 * and this tab must not become the place where one appears.
	 */
	private readFailure(): string | null {
		try {
			return this.siftPlugin.indexer.lastError();
		} catch {
			return null;
		}
	}

	/**
	 * Saves without letting a rejected write escape as an unhandled rejection.
	 * A failed save leaves the value in memory and the old one on disk; there is
	 * nothing this tab could do about it that the user has not already seen.
	 */
	private async persist(): Promise<void> {
		try {
			await this.siftPlugin.saveSettings();
		} catch {
			// Deliberately silent: no logging of settings content.
		}
	}
}

/* ========================================================================== */
/* 4. Formatting helpers                                                      */
/* ========================================================================== */

/** Option pairs as the declarative dropdown wants them: value -> visible label. */
function labelled(options: ReadonlyArray<readonly [string, TranslationKey]>): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [value, labelKey] of options) record[value] = t(labelKey);
	return record;
}

function sortOptions(): ReadonlyArray<readonly [SortKey, TranslationKey]> {
	return Object.entries(SORT_LABEL_KEYS).map(([key, labelKey]) => [key as SortKey, labelKey] as const);
}

function languageOptions(): ReadonlyArray<readonly [LanguageSetting, TranslationKey]> {
	return Object.entries(LANGUAGE_LABEL_KEYS).map(([key, labelKey]) => [key as LanguageSetting, labelKey] as const);
}

/**
 * The one line at the top of the index section.
 *
 * `failure` wins over the counters: a partial index reports a file count that
 * looks perfectly healthy, and an index that never got off the ground reports
 * the same emptiness a fresh vault does. Neither may read as healthy.
 */
function statusLine(stats: IndexStats | null, failure: string | null): string {
	if (failure !== null) {
		return t('index.statusFailed');
	}
	if (stats === null || stats.fileCount <= 0) {
		return t('index.statusEmpty');
	}
	const size = formatBytes(stats.approximateBytes);
	if (stats.fileCount === 1) {
		return t('index.statusOne', { size });
	}
	return t('index.status', { count: formatCount(stats.fileCount), size });
}

function formatCount(value: number): string {
	try {
		return new Intl.NumberFormat(dateFormatLocale()).format(value);
	} catch {
		return String(value);
	}
}

const BYTE_UNITS: readonly string[] = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];

/** Locale-aware size, so the unit needs no translation key of its own. */
function formatBytes(bytes: number): string {
	const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	let step = 0;
	let value = safe;
	while (value >= 1024 && step < BYTE_UNITS.length - 1) {
		value /= 1024;
		step += 1;
	}
	const unit = BYTE_UNITS[step];
	const digits = step === 0 || value >= 100 ? 0 : 1;
	try {
		return new Intl.NumberFormat(dateFormatLocale(), {
			style: 'unit',
			unit,
			unitDisplay: 'short',
			maximumFractionDigits: digits,
		}).format(value);
	} catch {
		return `${value.toFixed(digits)} ${unit}`;
	}
}

function formatDateTime(millis: number): string {
	try {
		return new Intl.DateTimeFormat(dateFormatLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(millis),
		);
	} catch {
		return new Date(millis).toISOString();
	}
}
