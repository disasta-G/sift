/** @vitest-environment happy-dom */

/**
 * main: composition and lifecycle.
 *
 * This module owns no behaviour, so the tests are about wiring and about the
 * four ways a plugin entry point can be wrong in a way nothing else catches:
 *
 *  1. A default hotkey. It would collide with the user's own bindings and with
 *     core search, and the review bot rejects it. Asserted on the object handed
 *     to `addCommand`, not on the source text.
 *  2. A subscription that bypasses `registerEvent`. It survives `onunload` and
 *     keeps a dead Indexer alive for the rest of the session, so the count of
 *     `vault.on` plus `metadataCache.on` calls has to equal the count of
 *     `registerEvent` calls exactly.
 *  3. Indexing awaited inside `onload`. That blocks Obsidian's startup for as
 *     long as the vault takes to read. The build must not even have begun when
 *     `onload` resolves.
 *  4. A `data.json` anyone can hand-edit. A throw in `onload` leaves a plugin
 *     that cannot be switched off from the UI, so every malformed shape has to
 *     come back as a fully wired plugin on default settings.
 *
 * happy-dom because the settings tab, the ribbon icon and the modal need a
 * document; fake-indexeddb because the Store opens a real connection. Node APIs
 * are allowed here — this file never ships.
 */

import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	DEFAULT_STUB_MANIFEST,
	Notice,
	installDomHelpers,
	resetStubEnvironment,
	type StubCommand,
} from './stubs/obsidian';
import { createFakeApp, type FakeApp, type FakeFileSpec } from './helpers/fakeVault';
import SiftPlugin from '../src/main';
import { Indexer } from '../src/index/Indexer';
import { SearchModal } from '../src/ui/SearchModal';
import { SiftSettingTab } from '../src/settings';
import { getLocale, setLanguage, t } from '../src/i18n/index';
import type { FileChange } from '../src/types';

installDomHelpers();

/* ========================================================================== */
/* Harness                                                                    */
/* ========================================================================== */

/** The stub's test affordances, which the published `Plugin` typings know nothing about. */
interface PluginAffordances {
	storedData: unknown;
	readonly commands: StubCommand[];
	readonly ribbonIcons: ReadonlyArray<{ icon: string; title: string; callback: (evt: MouseEvent) => unknown }>;
	readonly settingTabs: unknown[];
	eventRefCount(): number;
}

function affordances(plugin: SiftPlugin): PluginAffordances {
	return plugin as unknown as PluginAffordances;
}

/** One vault change as it reached the Indexer, flattened so it can be compared literally. */
interface SeenChange {
	kind: FileChange['kind'];
	path: string;
	file: string | null;
	oldPath?: string;
}

interface Harness {
	app: FakeApp;
	plugin: SiftPlugin;
}

let vaultCounter = 0;
const live: SiftPlugin[] = [];
const openedModals: SearchModal[] = [];

function createHarness(files: Record<string, FakeFileSpec> = {}, storedData: unknown = null): Harness {
	const app = createFakeApp(files);
	// One database per test: the Store keys on `appId`, and fake-indexeddb keeps
	// a single set of databases for the whole file.
	app.appId = `main-test-${++vaultCounter}`;
	// The filter bar's folder picker asks the vault for its folders; the fake
	// models files only, and an empty list is all this suite needs.
	(app.vault as unknown as { getAllFolders: () => unknown[] }).getAllFolders = (): unknown[] => [];

	const plugin = new SiftPlugin(app.asApp(), DEFAULT_STUB_MANIFEST);
	affordances(plugin).storedData = storedData;
	live.push(plugin);
	return { app, plugin };
}

/**
 * Runs the real lifecycle. `Component.load()` sets the loaded flag that
 * `unload()` insists on, but it throws away the promise `onload()` returns, so
 * the wait has to be observational.
 */
async function loadPlugin(plugin: SiftPlugin): Promise<void> {
	plugin.load();
	await vi.waitFor(() => {
		expect(affordances(plugin).commands).toHaveLength(1);
	});
}

/** Replaces `applyChange` with a recorder, so no test does real index work. */
function recordChanges(plugin: SiftPlugin): SeenChange[] {
	const seen: SeenChange[] = [];
	vi.spyOn(plugin.indexer, 'applyChange').mockImplementation((change: FileChange): void => {
		const entry: SeenChange = {
			kind: change.kind,
			path: change.path,
			file: change.file === null ? null : change.file.path,
		};
		if (change.oldPath !== undefined) entry.oldPath = change.oldPath;
		seen.push(entry);
	});
	return seen;
}

/**
 * Captures every modal `openSearch` puts on screen, so each test can close its
 * own — a modal left open keeps polling for the index for the rest of the file.
 * The prototype is read through a property type so the extracted function keeps
 * an explicit `this` instead of looking like an unbound method.
 */
function captureModals(): void {
	const proto = SearchModal.prototype as unknown as { onOpen: (this: SearchModal) => void };
	const original = proto.onOpen;
	vi.spyOn(SearchModal.prototype, 'onOpen').mockImplementation(function (this: SearchModal): void {
		openedModals.push(this);
		original.call(this);
	});
}

const SOURCE = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');

beforeEach(() => {
	resetStubEnvironment();
	installDomHelpers();
	setLanguage('en');
});

afterEach(() => {
	for (const modal of openedModals.splice(0, openedModals.length)) modal.close();
	for (const plugin of live.splice(0, live.length)) plugin.unload();
	vi.restoreAllMocks();
	document.body.replaceChildren();
	setLanguage('en');
});

/* ========================================================================== */
/* 1. Command and ribbon                                                      */
/* ========================================================================== */

describe('command registration', () => {
	it('registers one command and gives it no default hotkey', async () => {
		const { plugin } = createHarness();
		await loadPlugin(plugin);

		const commands = affordances(plugin).commands;
		expect(commands).toHaveLength(1);
		const command = commands[0];
		expect(command.id).toBe('open-search');
		expect(command.name).toBe(t('command.openSearch'));
		// Both halves matter: an explicit `undefined` would still serialize.
		expect('hotkeys' in command).toBe(false);
		expect(command.hotkeys).toBeUndefined();
	});

	it('keeps the plugin id and name out of the command', async () => {
		const { plugin } = createHarness();
		await loadPlugin(plugin);

		const command = affordances(plugin).commands[0];
		// Obsidian prefixes both itself; repeating them reads as "Sift: Sift …".
		expect(command.id).not.toContain('sift');
		expect(command.id).not.toContain('command');
		expect(command.name.toLowerCase()).not.toContain('sift');
		expect(command.name.toLowerCase()).not.toContain('command');
	});

	it('adds the ribbon entry and the settings tab', async () => {
		const { plugin } = createHarness();
		await loadPlugin(plugin);

		const { ribbonIcons, settingTabs } = affordances(plugin);
		expect(ribbonIcons).toHaveLength(1);
		expect(ribbonIcons[0].icon).toBe('search');
		expect(ribbonIcons[0].title).toBe(t('command.ribbonTooltip'));
		expect(settingTabs).toHaveLength(1);
		expect(settingTabs[0]).toBeInstanceOf(SiftSettingTab);
	});

	it('applies the language from settings before it labels anything', async () => {
		const { plugin } = createHarness({}, { language: 'de' });
		await loadPlugin(plugin);

		expect(getLocale()).toBe('de');
		const command = affordances(plugin).commands[0];
		expect(command.name).toBe(t('command.openSearch'));
		expect(command.name).not.toBe('Open search');
		expect(affordances(plugin).ribbonIcons[0].title).not.toBe('Search your vault');
	});

	it('opens the overlay from the command and from the ribbon', async () => {
		const { plugin } = createHarness();
		captureModals();
		await loadPlugin(plugin);

		affordances(plugin).commands[0].callback?.();
		expect(openedModals).toHaveLength(1);

		affordances(plugin).ribbonIcons[0].callback(new MouseEvent('click'));
		expect(openedModals).toHaveLength(2);
	});
});

/* ========================================================================== */
/* 2. Event wiring                                                            */
/* ========================================================================== */

describe('event wiring', () => {
	it('routes every subscription through registerEvent', async () => {
		const { app, plugin } = createHarness({ 'Notes/a.md': { content: 'alpha' } });
		const registerEvent = vi.spyOn(plugin, 'registerEvent');
		const vaultOn = vi.spyOn(app.vault, 'on');
		const cacheOn = vi.spyOn(app.metadataCache, 'on');

		await loadPlugin(plugin);

		expect(vaultOn.mock.calls.map((call) => call[0]).sort()).toEqual(['create', 'rename']);
		expect(cacheOn.mock.calls.map((call) => call[0]).sort()).toEqual(['changed', 'deleted']);
		// The point of the test: nothing subscribed behind registerEvent's back.
		expect(registerEvent).toHaveBeenCalledTimes(vaultOn.mock.calls.length + cacheOn.mock.calls.length);
		expect(affordances(plugin).eventRefCount()).toBe(4);
	});

	it('translates each event into the change the Indexer expects', async () => {
		const { app, plugin } = createHarness({ 'Notes/a.md': { content: 'alpha' } });
		await loadPlugin(plugin);
		const seen = recordChanges(plugin);

		// A new file: vault create, then the cache event once it is parsed.
		app.writeFile('Notes/b.md', 'beta');
		expect(seen).toEqual([
			{ kind: 'created', path: 'Notes/b.md', file: 'Notes/b.md' },
			{ kind: 'modified', path: 'Notes/b.md', file: 'Notes/b.md' },
		]);

		seen.length = 0;
		app.writeFile('Notes/b.md', 'beta, revised');
		expect(seen).toEqual([{ kind: 'modified', path: 'Notes/b.md', file: 'Notes/b.md' }]);

		seen.length = 0;
		app.deleteFile('Notes/b.md');
		expect(seen).toEqual([{ kind: 'deleted', path: 'Notes/b.md', file: null }]);

		seen.length = 0;
		app.renameFile('Notes/a.md', 'Archive/a.md');
		expect(seen).toEqual([
			{ kind: 'renamed', path: 'Archive/a.md', file: 'Archive/a.md', oldPath: 'Notes/a.md' },
		]);
	});

	it('ignores files that are not Markdown', async () => {
		const { app, plugin } = createHarness({ 'Notes/a.md': { content: 'alpha' } });
		await loadPlugin(plugin);
		const seen = recordChanges(plugin);

		app.writeFile('Assets/photo.png', 'binary-ish');
		app.writeFile('Assets/photo.png', 'binary-ish, revised');
		app.deleteFile('Assets/photo.png');
		expect(seen).toEqual([]);
	});

	it('drops a note that is renamed out of Markdown', async () => {
		const { app, plugin } = createHarness({ 'Notes/a.md': { content: 'alpha' } });
		await loadPlugin(plugin);
		const seen = recordChanges(plugin);

		app.renameFile('Notes/a.md', 'Notes/a.txt');
		expect(seen).toEqual([{ kind: 'deleted', path: 'Notes/a.md', file: null }]);
	});

	it('applies nothing once the plugin is unloaded', async () => {
		const { app, plugin } = createHarness({ 'Notes/a.md': { content: 'alpha' } });
		await loadPlugin(plugin);
		const seen = recordChanges(plugin);

		app.writeFile('Notes/b.md', 'beta');
		expect(seen.length).toBeGreaterThan(0);

		seen.length = 0;
		plugin.unload();
		live.length = 0;

		app.writeFile('Notes/c.md', 'gamma');
		app.writeFile('Notes/b.md', 'beta, revised');
		app.deleteFile('Notes/b.md');
		app.renameFile('Notes/a.md', 'Notes/z.md');
		expect(seen).toEqual([]);
		expect(app.vault.listenerCount('create')).toBe(0);
		expect(app.vault.listenerCount('rename')).toBe(0);
		expect(app.metadataCache.listenerCount('changed')).toBe(0);
		expect(app.metadataCache.listenerCount('deleted')).toBe(0);
	});
});

/* ========================================================================== */
/* 3. Startup                                                                 */
/* ========================================================================== */

describe('startup', () => {
	it('does not start the index build inside onload', async () => {
		const start = vi.spyOn(Indexer.prototype, 'start');
		const { app, plugin } = createHarness({
			'a.md': { content: 'alpha' },
			'b.md': { content: 'beta' },
		});

		await loadPlugin(plugin);

		// Fully wired, nothing read, no build begun.
		expect(start).not.toHaveBeenCalled();
		expect(app.totalReadCount()).toBe(0);
		expect(plugin.indexer.isReady()).toBe(false);

		app.workspace.triggerLayoutReady();
		expect(start).toHaveBeenCalledTimes(1);

		await vi.waitFor(() => {
			expect(plugin.indexer.isReady()).toBe(true);
		});
		expect(plugin.indexer.fileCount()).toBe(2);
		expect(app.totalReadCount()).toBeGreaterThan(0);
	});

	it('resolves onload even when the build never finishes', async () => {
		const start = vi
			.spyOn(Indexer.prototype, 'start')
			.mockReturnValue(new Promise<void>(() => undefined));
		const { app, plugin } = createHarness({ 'a.md': { content: 'alpha' } });

		await loadPlugin(plugin);
		app.workspace.triggerLayoutReady();

		expect(start).toHaveBeenCalledTimes(1);
		// onload had already resolved above; a build that never settles cannot
		// have been awaited.
		expect(affordances(plugin).commands).toHaveLength(1);
		expect(affordances(plugin).ribbonIcons).toHaveLength(1);
	});

	it('reports a failed build as a notice and stays loaded', async () => {
		vi.spyOn(Indexer.prototype, 'start').mockRejectedValue(new Error('index unavailable'));
		const { app, plugin } = createHarness({ 'a.md': { content: 'alpha' } });

		await loadPlugin(plugin);
		app.workspace.triggerLayoutReady();

		await vi.waitFor(() => {
			expect(Notice.messages).toContain(t('error.indexFailed'));
		});
		expect(affordances(plugin).commands).toHaveLength(1);
	});

	it('reports a build that throws inside the Indexer', async () => {
		// `start()` resolves even when the build fails — the Indexer keeps its
		// partial index and reports it through the progress sink instead. Without
		// a sink attached here, a broken index is indistinguishable from an empty
		// vault: no notice, no status, every query answering "no results".
		const { app, plugin } = createHarness({ 'a.md': { content: 'alpha' } });
		vi.spyOn(app.vault, 'getMarkdownFiles').mockImplementation((): never => {
			throw new Error('vault unavailable');
		});

		await loadPlugin(plugin);
		app.workspace.triggerLayoutReady();

		await vi.waitFor(() => {
			expect(Notice.messages).toContain(t('error.indexFailed'));
		});
		// What the settings tab and the modal read to say the same thing.
		expect(plugin.indexer.lastError()).not.toBeNull();
		expect(affordances(plugin).commands).toHaveLength(1);
	});

	it('says nothing about a failure when the build succeeds', async () => {
		const { app, plugin } = createHarness({ 'a.md': { content: 'alpha' } });
		await loadPlugin(plugin);
		app.workspace.triggerLayoutReady();

		await vi.waitFor(() => {
			expect(plugin.indexer.isReady()).toBe(true);
		});
		expect(Notice.messages).not.toContain(t('error.indexFailed'));
		expect(plugin.indexer.lastError()).toBeNull();
	});

	it('opens the overlay before the index is ready', async () => {
		const { plugin } = createHarness({ 'a.md': { content: 'alpha' } });
		captureModals();
		await loadPlugin(plugin);

		expect(plugin.indexer.isReady()).toBe(false);
		plugin.openSearch();

		expect(openedModals).toHaveLength(1);
		const container = document.querySelector('.sift-modal-container');
		expect(container).not.toBeNull();
		expect(container?.textContent ?? '').toContain(t('empty.indexing.title'));
	});

	it('carries an initial query into the overlay', async () => {
		const { plugin } = createHarness({ 'a.md': { content: 'alpha' } });
		captureModals();
		await loadPlugin(plugin);

		plugin.openSearch('kaffee');

		const input = document.querySelector('input');
		expect(input?.value).toBe('kaffee');
	});
});

/* ========================================================================== */
/* 4. Settings                                                                */
/* ========================================================================== */

describe('settings', () => {
	const CORRUPT: Array<[string, unknown]> = [
		['a bare string', 'not json at all'],
		['an array', [1, 2, 3]],
		['nothing', null],
		['a number', 42],
		['a boolean', true],
		['half an object', { version: 7, snippetCount: 'three', excludedFolders: 'Archive', maxResults: Number.NaN }],
		['unknown keys only', { colour: 'blue', nested: { deep: true } }],
	];

	it.each(CORRUPT)('loads fully when data.json holds %s', async (_label, stored) => {
		const { plugin } = createHarness({}, stored);

		await loadPlugin(plugin);

		expect(plugin.settings.version).toBe(1);
		expect(plugin.settings.snippetCount).toBeGreaterThanOrEqual(1);
		expect(plugin.settings.snippetCount).toBeLessThanOrEqual(3);
		expect(Number.isFinite(plugin.settings.maxResults)).toBe(true);
		expect(Array.isArray(plugin.settings.excludedFolders)).toBe(true);
		// Wiring survived the bad file, which is the whole point.
		expect(affordances(plugin).commands).toHaveLength(1);
		expect(affordances(plugin).eventRefCount()).toBe(4);
	});

	it('loads when reading data.json throws', async () => {
		const { plugin } = createHarness();
		vi.spyOn(plugin, 'loadData').mockRejectedValue(new Error('unreadable'));

		await loadPlugin(plugin);

		expect(plugin.settings.version).toBe(1);
		expect(affordances(plugin).eventRefCount()).toBe(4);
	});

	it('persists settings and hands them to the Indexer', async () => {
		const { plugin } = createHarness();
		await loadPlugin(plugin);
		const update = vi.spyOn(plugin.indexer, 'updateSettings').mockResolvedValue(undefined);

		plugin.settings.snippetCount = 2;
		await plugin.saveSettings();

		expect(affordances(plugin).storedData).toMatchObject({ snippetCount: 2 });
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith(plugin.settings);
	});

	it('clears the rebuild flag once a rebuild has finished', async () => {
		const { plugin } = createHarness({}, { forceRebuild: true });
		await loadPlugin(plugin);
		const rebuild = vi.spyOn(plugin.indexer, 'rebuild').mockResolvedValue(undefined);
		vi.spyOn(plugin.indexer, 'updateSettings').mockResolvedValue(undefined);

		expect(plugin.settings.forceRebuild).toBe(true);
		await plugin.rebuildIndex();

		expect(rebuild).toHaveBeenCalledTimes(1);
		expect(plugin.settings.forceRebuild).toBe(false);
		expect(affordances(plugin).storedData).toMatchObject({ forceRebuild: false });
	});

	it('clears the rebuild flag after the deferred start', async () => {
		const { app, plugin } = createHarness({ 'a.md': { content: 'alpha' } }, { forceRebuild: true });
		await loadPlugin(plugin);

		app.workspace.triggerLayoutReady();
		await vi.waitFor(() => {
			expect(plugin.settings.forceRebuild).toBe(false);
		});
		expect(affordances(plugin).storedData).toMatchObject({ forceRebuild: false });
	});
});

/* ========================================================================== */
/* 5. Unload                                                                  */
/* ========================================================================== */

describe('unload', () => {
	it('stops the Indexer and closes the Store', async () => {
		const { plugin } = createHarness();
		await loadPlugin(plugin);
		const stop = vi.spyOn(plugin.indexer, 'stop');
		const close = vi.spyOn(plugin.store, 'close');

		plugin.unload();
		live.length = 0;

		expect(stop).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(affordances(plugin).eventRefCount()).toBe(0);
	});

	it('unloads cleanly when loading never got as far as composing', () => {
		const { plugin } = createHarness();
		// A plugin disabled while `data.json` is still being read has no Indexer
		// and no Store, and must not throw on the way out.
		vi.spyOn(plugin, 'loadData').mockReturnValue(new Promise<unknown>(() => undefined));

		plugin.load();
		expect(() => {
			plugin.unload();
		}).not.toThrow();
		live.length = 0;
	});
});

/* ========================================================================== */
/* 6. Source policy                                                           */
/* ========================================================================== */

describe('source policy', () => {
	it('makes no network call', () => {
		expect(SOURCE).not.toMatch(/\bfetch\s*\(/);
		expect(SOURCE).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon|requestUrl|https?:\/\//);
	});

	it('touches no Node or Electron API', () => {
		expect(SOURCE).not.toMatch(/\brequire\s*\(/);
		expect(SOURCE).not.toMatch(/from\s+'node:/);
		expect(SOURCE).not.toMatch(/from\s+'(fs|path|os|crypto|child_process|electron)'/);
		expect(SOURCE).not.toMatch(/\bprocess\.(env|platform|cwd)\b/);
	});

	it('logs nothing at all', () => {
		expect(SOURCE).not.toMatch(/console\s*\./);
	});

	it('builds no HTML and evaluates nothing', () => {
		expect(SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
	});

	it('never reaches for the global app', () => {
		expect(SOURCE).not.toMatch(/(^|[^.\w])app\.(vault|workspace|metadataCache)/m);
		expect(SOURCE).not.toMatch(/window\.app|globalThis\.app/);
	});

	it('sets no hotkey and names no paid feature', () => {
		expect(SOURCE).not.toMatch(/hotkeys\s*:/);
		expect(SOURCE.toLowerCase()).not.toMatch(/licen[cs]e|subscription|pricing|\btrial\b|polar|openai|anthropic|mistral/);
	});
});

/* ========================================================================== */
/* 7. Bundle audit                                                            */
/* ========================================================================== */

/**
 * The source scan above only covers this one file; what ships is the bundle
 * rooted at it. `scripts/scope-guard.mjs` audits the released `main.js` the
 * same way — this runs the check on every `npm test`, before a build exists.
 */
describe('bundle audit', () => {
	it('ships no require, no Node builtin, no URL and no network call', async () => {
		const result = await build({
			entryPoints: [join(process.cwd(), 'src', 'main.ts')],
			bundle: true,
			format: 'cjs',
			target: 'es2022',
			platform: 'browser',
			write: false,
			logLevel: 'silent',
			external: ['obsidian', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
		});

		const bundle = result.outputFiles[0].text;
		expect(bundle.length).toBeGreaterThan(0);

		// A CJS bundle necessarily requires the host API; anything else in that
		// list would be a Node builtin or a runtime dependency that slipped in.
		const required = [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
		expect([...new Set(required)]).toEqual(['obsidian']);
		// No computed require either, which is how a builtin usually hides.
		expect(bundle).not.toMatch(/\brequire\s*\(\s*[^"')]/);
		expect(bundle).not.toMatch(/["']node:[a-z_]+["']/);
		expect(bundle).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|requestUrl/);
		expect(bundle).not.toMatch(/https?:\/\//);
		expect(bundle).not.toMatch(/console\.log/);
		expect(bundle).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
	});
});
