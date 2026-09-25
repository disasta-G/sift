/** @vitest-environment happy-dom */

/**
 * Bringing the previous search back.
 *
 * The memory is a plain object handed to each overlay, the way the plugin does
 * it, so these tests open and close several overlays against the same slot and
 * assert what the next one offers.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { TFile, installDomHelpers } from '../stubs/obsidian';
import type { App } from 'obsidian';
import { SearchModal } from '../../src/ui/SearchModal';
import type { SearchMemory, SearchModalDeps } from '../../src/ui/SearchModal';
import { setLanguage, t } from '../../src/i18n/index';
import type { RawHit } from '../../src/types';
import { TUNING, fakeIndexer, fakeSearcher, fakeSnippets, hit, realRanker, settings } from './factories';

installDomHelpers();

function hits(count: number): RawHit[] {
	return Array.from({ length: count }, (_unused, index) =>
		hit(index, { title: `Note ${index}`, path: `Projekte/Note ${index}.md` }),
	);
}

function open(memory: SearchMemory | undefined, activeNote: string | null = null): SearchModal {
	const app = {
		keymap: { pushScope: () => undefined, popScope: () => undefined },
		vault: {
			getAllFolders: () => [],
			getFileByPath: (path: string): TFile => new TFile(path),
		},
		workspace: {
			getActiveFile: (): TFile | null => (activeNote === null ? null : new TFile(activeNote)),
		},
	} as unknown as App;
	const indexer = fakeIndexer(true);
	(indexer.indexer as unknown as { lastError(): string | null }).lastError = (): string | null => null;
	const deps: SearchModalDeps = {
		indexer: indexer.indexer,
		searcher: fakeSearcher(hits(3)).searcher,
		ranker: realRanker(),
		snippets: fakeSnippets().snippets,
		settings: settings(),
		tuning: TUNING,
		memory,
	};
	const modal = new SearchModal(app, deps);
	modal.open();
	return modal;
}

function restoreButton(modal: SearchModal): HTMLElement | null {
	return modal.contentEl.querySelector<HTMLElement>('.sift-empty__restore');
}

function input(modal: SearchModal): HTMLInputElement {
	return modal.contentEl.querySelector('.sift-input') as HTMLInputElement;
}

function cards(modal: SearchModal): number {
	return modal.contentEl.querySelectorAll('.sift-card').length;
}

function pressArrowUp(modal: SearchModal): void {
	const keys = (modal.scope as unknown as {
		keys: Array<{ modifiers: string[] | null; key: string | null; handler(evt: KeyboardEvent): unknown }>;
	}).keys;
	const entry = keys.find((k) => k.key === 'ArrowUp' && (k.modifiers ?? []).length === 0);
	if (entry === undefined) throw new Error('no ArrowUp binding');
	entry.handler(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
}

async function settle(turns = 200): Promise<void> {
	for (let at = 0; at < turns; at++) await Promise.resolve();
}

async function searchAndClose(memory: SearchMemory, query: string): Promise<void> {
	const modal = open(memory);
	modal.setQuery(query);
	await modal.runSearch(true);
	modal.close();
}

beforeEach(() => {
	setLanguage('en');
	document.body.empty();
});

describe('restoring the last search', () => {
	it('offers nothing on the first opening', async () => {
		const modal = open({ last: null });
		await settle();
		expect(restoreButton(modal)).toBeNull();
	});

	it('offers nothing when the plugin hands no memory over', async () => {
		const modal = open(undefined);
		modal.setQuery('kaffee');
		await modal.runSearch(true);
		modal.close();
		const next = open(undefined);
		await settle();
		expect(restoreButton(next)).toBeNull();
	});

	it('names the previous query on the button and brings it back on click', async () => {
		const memory: SearchMemory = { last: null };
		await searchAndClose(memory, 'kaffee');

		const modal = open(memory);
		await settle();
		const button = restoreButton(modal);
		expect(button).not.toBeNull();
		expect(button?.tagName).toBe('BUTTON');
		expect(button?.textContent).toContain(t('search.restore'));
		expect(button?.querySelector('.sift-empty__restore-query')?.textContent).toBe('kaffee');

		button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		await settle();
		expect(input(modal).value).toBe('kaffee');
		expect(cards(modal)).toBe(3);
		expect(restoreButton(modal)).toBeNull();
	});

	it('brings the previous query back with ArrowUp on the untouched overlay', async () => {
		const memory: SearchMemory = { last: null };
		await searchAndClose(memory, 'kaffee');

		const modal = open(memory);
		await settle();
		pressArrowUp(modal);
		await settle();
		expect(input(modal).value).toBe('kaffee');
		expect(cards(modal)).toBe(3);
	});

	it('leaves ArrowUp to the list once something is typed', async () => {
		const memory: SearchMemory = { last: null };
		await searchAndClose(memory, 'kaffee');

		const modal = open(memory);
		modal.setQuery('tee');
		await modal.runSearch(true);
		pressArrowUp(modal);
		await settle();
		expect(input(modal).value).toBe('tee');
	});

	it('does not let an empty opening overwrite the search before it', async () => {
		const memory: SearchMemory = { last: null };
		await searchAndClose(memory, 'kaffee');
		open(memory).close();
		expect(memory.last?.query).toBe('kaffee');
	});

	it('restores filters, sort order and similar matching with the query', async () => {
		const memory: SearchMemory = { last: null };
		memory.last = {
			query: 'kaffee',
			filters: {
				folder: 'Projekte',
				includeSubfolders: false,
				createdFrom: null,
				createdTo: null,
				modifiedFrom: null,
				modifiedTo: null,
				property: null,
				openTasks: true,
				formats: null,
				note: null,
				excludedFolders: [],
			},
			sort: 'created-desc',
			fuzzy: true,
		};

		const modal = open(memory);
		await settle();
		await modal.restoreLastSearch();
		modal.close();
		expect(memory.last?.filters.folder).toBe('Projekte');
		expect(memory.last?.filters.openTasks).toBe(true);
		expect(memory.last?.sort).toBe('created-desc');
		expect(memory.last?.fuzzy).toBe(true);
	});

	it('drops "This note" when the overlay was called from another note', async () => {
		const memory: SearchMemory = { last: null };
		const first = open(memory, 'A.md');
		first.setQuery('kaffee');
		await first.runSearch(true);
		(first as unknown as { filters: { note: string | null } }).filters.note = 'A.md';
		first.close();
		expect(memory.last?.filters.note).toBe('A.md');

		const elsewhere = open(memory, 'B.md');
		await elsewhere.restoreLastSearch();
		elsewhere.close();
		expect(memory.last?.filters.note).toBeNull();

		memory.last = { ...memory.last!, filters: { ...memory.last!.filters, note: 'A.md' } };
		const same = open(memory, 'A.md');
		await same.restoreLastSearch();
		same.close();
		expect(memory.last?.filters.note).toBe('A.md');
	});
});
