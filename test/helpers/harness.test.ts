// @vitest-environment happy-dom

/**
 * Proves the test harness itself.
 *
 * Every other suite trusts these three things without checking them: that
 * `normalizePath` normalizes, that the DOM helpers Obsidian bolts onto
 * `HTMLElement` behave the way UI code assumes, and that the fake vault fires
 * the right events in the right order. If the harness lies, the suites that use
 * it lie quietly — so it gets its own tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before vitest's alias applies: the compiler sees
// Obsidian's real `TFile`, the runtime sees the stub instance. Same object.
import type { TFile } from 'obsidian';

import {
	Component,
	Events,
	Modal,
	Notice,
	Setting,
	debounce,
	domHelpersInstalled,
	getLanguage,
	installDomHelpers,
	normalizePath,
	resetStubEnvironment,
	setIcon,
	setStubLanguage,
} from '../stubs/obsidian';
import { DEFAULT_CTIME, createFakeApp, type RecordedEvent } from './fakeVault';

beforeEach(() => {
	installDomHelpers();
	resetStubEnvironment();
	document.body.replaceChildren();
});

/* ========================================================================== */

describe('normalizePath', () => {
	it('turns backslashes into slashes and collapses runs', () => {
		expect(normalizePath('Projekte\\2024\\Küche')).toBe('Projekte/2024/Küche');
		expect(normalizePath('Projekte//2024///Küche')).toBe('Projekte/2024/Küche');
	});

	it('strips leading and trailing slashes', () => {
		expect(normalizePath('/Projekte/2024/')).toBe('Projekte/2024');
		expect(normalizePath('///Inbox///')).toBe('Inbox');
	});

	it('removes "." segments and resolves ".."', () => {
		expect(normalizePath('./Projekte/./2024')).toBe('Projekte/2024');
		expect(normalizePath('..\\Projekte\\')).toBe('Projekte');
		expect(normalizePath('Projekte/2024/../2025')).toBe('Projekte/2025');
	});

	it('maps an empty path to the vault root, as the app does', () => {
		expect(normalizePath('')).toBe('/');
		expect(normalizePath('/')).toBe('/');
		expect(normalizePath('.')).toBe('/');
	});

	it('normalizes to NFC and replaces non-breaking spaces', () => {
		const decomposed = 'Küche';
		expect(normalizePath(decomposed)).toBe('Küche');
		expect(decomposed.length).toBe(6);
		expect(normalizePath(decomposed).length).toBe(5);
		expect(normalizePath('Projekte 2024')).toBe('Projekte 2024');
	});
});

/* ========================================================================== */

describe('DOM helpers', () => {
	it('installs on import and is idempotent', () => {
		expect(domHelpersInstalled()).toBe(true);
		installDomHelpers();
		installDomHelpers();
		expect(typeof document.createElement('div').createDiv).toBe('function');
	});

	it('createDiv appends to the receiver and applies cls and text', () => {
		const root = document.createElement('div');
		const child = root.createDiv({ cls: 'sift-card', text: 'Espressomaschine' });
		expect(child.parentElement).toBe(root);
		expect(child.tagName).toBe('DIV');
		expect(child.classList.contains('sift-card')).toBe(true);
		expect(child.textContent).toBe('Espressomaschine');
	});

	it('accepts a bare string as the class shorthand', () => {
		const root = document.createElement('div');
		const child = root.createSpan('sift-mark');
		expect(child.tagName).toBe('SPAN');
		expect(child.classList.contains('sift-mark')).toBe(true);
	});

	it('createEl applies attr, href, type, placeholder, value and title', () => {
		const root = document.createElement('div');
		const input = root.createEl('input', {
			type: 'search',
			placeholder: 'Search notes',
			value: 'Kaffee',
			title: 'query',
			attr: { 'aria-label': 'Search', 'data-count': 3, 'aria-hidden': false, dropped: null },
		});
		expect(input.type).toBe('search');
		expect(input.placeholder).toBe('Search notes');
		expect(input.value).toBe('Kaffee');
		expect(input.title).toBe('query');
		expect(input.getAttribute('aria-label')).toBe('Search');
		expect(input.getAttribute('data-count')).toBe('3');
		expect(input.getAttribute('aria-hidden')).toBe('false');
		expect(input.hasAttribute('dropped')).toBe(false);

		const link = root.createEl('a', { href: 'obsidian://open', text: 'open' });
		expect(link.getAttribute('href')).toBe('obsidian://open');
	});

	it('runs the callback with the finished element and honours prepend', () => {
		const root = document.createElement('div');
		root.createDiv({ cls: 'second' });
		const seen: string[] = [];
		root.createDiv({ cls: 'first', prepend: true }, (el) => {
			seen.push(el.className);
		});
		expect(seen).toEqual(['first']);
		expect(Array.from(root.children).map((el) => el.className)).toEqual(['first', 'second']);
	});

	it('honours an explicit parent over the receiver', () => {
		const a = document.createElement('div');
		const b = document.createElement('div');
		const child = a.createDiv({ parent: b });
		expect(child.parentElement).toBe(b);
		expect(a.children.length).toBe(0);
	});

	it('setText writes text, never markup — the whole point of the no-innerHTML rule', () => {
		const el = document.createElement('div');
		el.setText('<script>alert(1)</script> & <b>bold</b>');
		expect(el.children.length).toBe(0);
		expect(el.textContent).toBe('<script>alert(1)</script> & <b>bold</b>');
		expect(el.getText()).toBe(el.textContent);
	});

	it('empty and detach remove children and the node itself', () => {
		const root = document.createElement('div');
		const child = root.createDiv({ text: 'a' });
		child.createSpan({ text: 'b' });
		child.empty();
		expect(child.childNodes.length).toBe(0);
		child.detach();
		expect(root.children.length).toBe(0);
	});

	it('addClass, addClasses, removeClass and toggleClass work on one or many', () => {
		const el = document.createElement('div');
		el.addClass('sift-a', 'sift-b');
		el.addClasses(['sift-c', 'sift-d']);
		expect(el.className.split(' ').sort()).toEqual(['sift-a', 'sift-b', 'sift-c', 'sift-d']);
		el.removeClass('sift-a');
		expect(el.hasClass('sift-a')).toBe(false);
		el.toggleClass(['sift-b', 'sift-c'], false);
		expect(el.hasClass('sift-b')).toBe(false);
		el.toggleClass('sift-e', true);
		expect(el.hasClass('sift-e')).toBe(true);
	});

	it('setAttr writes strings, booleans and removes on null', () => {
		const el = document.createElement('div');
		el.setAttr('aria-selected', true);
		expect(el.getAttribute('aria-selected')).toBe('true');
		el.setAttr('aria-selected', false);
		expect(el.getAttribute('aria-selected')).toBe('false');
		el.setAttr('tabindex', 0);
		expect(el.getAttr('tabindex')).toBe('0');
		el.setAttr('tabindex', null);
		expect(el.hasAttribute('tabindex')).toBe(false);
	});

	it('exposes createEl, createDiv and createFragment as globals', () => {
		const el = createDiv({ cls: 'sift-root' });
		expect(el.parentElement).toBeNull();
		expect(el.className).toBe('sift-root');
		const fragment = createFragment((frag) => {
			frag.createSpan({ text: 'x' });
		});
		expect(fragment.textContent).toBe('x');
	});
});

/* ========================================================================== */

describe('Modal', () => {
	class Probe extends Modal {
		opens = 0;
		closes = 0;

		override onOpen(): void {
			this.opens++;
			this.contentEl.createDiv({ cls: 'sift-probe', text: 'ready' });
		}

		override onClose(): void {
			this.closes++;
			this.contentEl.empty();
		}
	}

	it('builds the container/modal/title/content tree', () => {
		const modal = new Probe(null);
		expect(modal.containerEl.classList.contains('modal-container')).toBe(true);
		expect(modal.modalEl.parentElement).toBe(modal.containerEl);
		expect(modal.titleEl.parentElement).toBe(modal.modalEl);
		expect(modal.contentEl.parentElement).toBe(modal.modalEl);
	});

	it('really calls onOpen and onClose, and attaches then detaches the container', () => {
		const modal = new Probe(null);
		modal.open();
		expect(modal.opens).toBe(1);
		expect(document.body.contains(modal.containerEl)).toBe(true);
		expect(modal.contentEl.querySelector('.sift-probe')?.textContent).toBe('ready');

		modal.close();
		expect(modal.closes).toBe(1);
		expect(document.body.contains(modal.containerEl)).toBe(false);
		expect(modal.contentEl.childNodes.length).toBe(0);
	});

	it('ignores a redundant open or close', () => {
		const modal = new Probe(null);
		modal.open();
		modal.open();
		modal.close();
		modal.close();
		expect(modal.opens).toBe(1);
		expect(modal.closes).toBe(1);
	});
});

/* ========================================================================== */

describe('Setting', () => {
	it('appends a real setting-item tree to its container', () => {
		const container = document.createElement('div');
		new Setting(container).setName('Include subfolders').setDesc('Search nested folders too');

		const item = container.querySelector('.setting-item');
		expect(item).not.toBeNull();
		expect(item?.querySelector('.setting-item-name')?.textContent).toBe('Include subfolders');
		expect(item?.querySelector('.setting-item-description')?.textContent).toBe('Search nested folders too');
	});

	it('setHeading marks the item and addToggle reports clicks', () => {
		const container = document.createElement('div');
		const changes: boolean[] = [];
		new Setting(container).setName('Search').setHeading();
		new Setting(container).addToggle((toggle) => {
			toggle.setValue(false).onChange((value) => changes.push(value));
		});

		expect(container.querySelector('.setting-item-heading')).not.toBeNull();
		const toggleEl = container.querySelector('.checkbox-container');
		expect(toggleEl).not.toBeNull();
		(toggleEl as HTMLElement).click();
		(toggleEl as HTMLElement).click();
		expect(changes).toEqual([true, false]);
		expect(toggleEl?.getAttribute('aria-checked')).toBe('false');
	});

	it('addDropdown and addText round-trip values through real elements', () => {
		const container = document.createElement('div');
		const picked: string[] = [];
		const typed: string[] = [];
		new Setting(container)
			.addDropdown((dropdown) => {
				dropdown.addOptions({ relevance: 'Relevance', 'created-desc': 'Newest first' });
				dropdown.setValue('created-desc').onChange((value) => picked.push(value));
			})
			.addText((text) => {
				text.setValue('created').onChange((value) => typed.push(value));
			});

		const select = container.querySelector('select') as HTMLSelectElement;
		expect(select.value).toBe('created-desc');
		select.value = 'relevance';
		select.dispatchEvent(new Event('change'));
		expect(picked).toEqual(['relevance']);

		const input = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(input.value).toBe('created');
		input.value = 'date';
		input.dispatchEvent(new Event('input'));
		expect(typed).toEqual(['date']);
	});
});

/* ========================================================================== */

describe('setIcon, Notice, getLanguage', () => {
	it('setIcon replaces the content with a tagged svg', () => {
		const el = document.createElement('div');
		el.createSpan({ text: 'stale' });
		setIcon(el, 'search');
		expect(el.childNodes.length).toBe(1);
		const svg = el.firstElementChild;
		expect(svg?.getAttribute('data-icon')).toBe('search');
		expect(svg?.classList.contains('svg-icon')).toBe(true);
	});

	it('Notice records its message so a test can assert without a screen', () => {
		new Notice('Index rebuilt');
		new Notice('Nothing found');
		expect(Notice.messages).toEqual(['Index rebuilt', 'Nothing found']);
	});

	it('getLanguage is drivable', () => {
		expect(getLanguage()).toBe('en');
		setStubLanguage('de-CH');
		expect(getLanguage()).toBe('de-CH');
		resetStubEnvironment();
		expect(getLanguage()).toBe('en');
	});
});

/* ========================================================================== */

describe('debounce', () => {
	it('coalesces calls and passes the newest arguments', () => {
		vi.useFakeTimers();
		try {
			const seen: number[] = [];
			const run = debounce((value: number) => seen.push(value), 120);
			run(1);
			run(2);
			run(3);
			expect(seen).toEqual([]);
			vi.advanceTimersByTime(120);
			expect(seen).toEqual([3]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps the first deadline unless resetTimer is set', () => {
		vi.useFakeTimers();
		try {
			const steady: number[] = [];
			const resetting: number[] = [];
			const keep = debounce((value: number) => steady.push(value), 100, false);
			const reset = debounce((value: number) => resetting.push(value), 100, true);
			keep(1);
			reset(1);
			vi.advanceTimersByTime(60);
			keep(2);
			reset(2);
			vi.advanceTimersByTime(60);
			expect(steady).toEqual([2]);
			expect(resetting).toEqual([]);
			vi.advanceTimersByTime(60);
			expect(resetting).toEqual([2]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('cancel drops the pending call and run fires it at once', () => {
		vi.useFakeTimers();
		try {
			const seen: string[] = [];
			const run = debounce((value: string) => seen.push(value), 50);
			run('dropped').cancel();
			vi.advanceTimersByTime(100);
			expect(seen).toEqual([]);
			run('now');
			run.run();
			expect(seen).toEqual(['now']);
			vi.advanceTimersByTime(100);
			expect(seen).toEqual(['now']);
		} finally {
			vi.useRealTimers();
		}
	});
});

/* ========================================================================== */

describe('Component registration', () => {
	it('detaches DOM listeners and event refs on unload', () => {
		const component = new Component();
		const emitter = new Events();
		const button = document.createElement('button');
		let clicks = 0;
		let pings = 0;

		component.load();
		component.registerDomEvent(button, 'click', () => {
			clicks++;
		});
		component.registerEvent(
			emitter.on('ping', () => {
				pings++;
			}),
		);

		button.click();
		emitter.trigger('ping');
		expect(clicks).toBe(1);
		expect(pings).toBe(1);
		expect(emitter.listenerCount('ping')).toBe(1);

		component.unload();
		button.click();
		emitter.trigger('ping');
		expect(clicks).toBe(1);
		expect(pings).toBe(1);
		expect(emitter.listenerCount('ping')).toBe(0);
		expect(component.domEventCount()).toBe(0);
	});

	it('unloads children and runs register() disposers', () => {
		const parent = new Component();
		const child = new Component();
		const order: string[] = [];
		parent.load();
		parent.addChild(child);
		child.register(() => order.push('child'));
		parent.register(() => order.push('parent'));
		parent.unload();
		expect(order).toEqual(['child', 'parent']);
	});
});

/* ========================================================================== */

describe('fakeVault', () => {
	const seed = {
		'Projekte/2024/Küche.md': { content: '# Küchenplanung\nEspressomaschine', ctime: 1000, mtime: 2000 },
		'Projekte2/Archiv/Alt.md': { content: 'Wärmepumpe', ctime: 3000 },
		'Inbox/todo.md': { content: 'heat pump' },
	};

	it('lists markdown files sorted and resolves paths', () => {
		const fake = createFakeApp(seed);
		expect(fake.vault.getMarkdownFiles().map((file) => file.path)).toEqual([
			'Inbox/todo.md',
			'Projekte/2024/Küche.md',
			'Projekte2/Archiv/Alt.md',
		]);
		const file = fake.vault.getFileByPath('Projekte/2024/Küche.md');
		expect(file?.basename).toBe('Küche');
		expect(file?.extension).toBe('md');
		expect(file?.stat).toEqual({
			ctime: 1000,
			mtime: 2000,
			size: new TextEncoder().encode(seed['Projekte/2024/Küche.md'].content).length,
		});
		expect(fake.vault.getFileByPath('nope.md')).toBeNull();
		expect(fake.vault.getAbstractFileByPath('Projekte/2024')?.path).toBe('Projekte/2024');
		expect(fake.vault.getFileByPath('Projekte/2024/Küche.md')).toBe(file);
	});

	it('defaults mtime to ctime and ctime to the fixed epoch', () => {
		const fake = createFakeApp(seed);
		expect(fake.vault.getFileByPath('Projekte2/Archiv/Alt.md')?.stat.mtime).toBe(3000);
		expect(fake.vault.getFileByPath('Inbox/todo.md')?.stat.ctime).toBe(DEFAULT_CTIME);
	});

	it('counts cachedRead per path so "never re-read" is assertable', async () => {
		const fake = createFakeApp(seed);
		const file = fake.vault.getFileByPath('Inbox/todo.md');
		if (file === null) throw new Error('fixture file missing');
		expect(fake.readCount('Inbox/todo.md')).toBe(0);
		await fake.vault.cachedRead(file);
		await fake.vault.cachedRead(file);
		expect(fake.readCount('Inbox/todo.md')).toBe(2);
		expect(fake.readCount('Projekte/2024/Küche.md')).toBe(0);
		expect(fake.totalReadCount()).toBe(2);
		fake.resetReadCounts();
		expect(fake.totalReadCount()).toBe(0);
	});

	it('writeFile fires create then changed for a new path', () => {
		const fake = createFakeApp(seed);
		const heard: string[] = [];
		fake.vault.on('create', (file) => heard.push(`vault:create:${(file as TFile).path}`));
		fake.vault.on('modify', () => heard.push('vault:modify'));
		fake.metadataCache.on('changed', (file) => heard.push(`meta:changed:${(file as TFile).path}`));

		fake.writeFile('Inbox/neu.md', 'Lüftungsanlage');
		expect(heard).toEqual(['vault:create:Inbox/neu.md', 'meta:changed:Inbox/neu.md']);
		expect(fake.contentOf('Inbox/neu.md')).toBe('Lüftungsanlage');
	});

	it('writeFile fires modify then changed for an existing path and advances mtime', () => {
		const fake = createFakeApp(seed);
		const before = fake.vault.getFileByPath('Inbox/todo.md')?.stat.mtime ?? 0;
		fake.resetEvents();
		fake.writeFile('Inbox/todo.md', 'Wärmepumpe statt heat pump');

		expect(fake.events.map(shape)).toEqual(['vault:modify:Inbox/todo.md', 'metadataCache:changed:Inbox/todo.md']);
		expect(fake.vault.getFileByPath('Inbox/todo.md')?.stat.mtime).toBe(before + 1);
		expect(fake.contentOf('Inbox/todo.md')).toBe('Wärmepumpe statt heat pump');
	});

	it('deleteFile fires delete then deleted and drops the file', () => {
		const fake = createFakeApp(seed);
		fake.resetEvents();
		fake.deleteFile('Inbox/todo.md');
		expect(fake.events.map(shape)).toEqual(['vault:delete:Inbox/todo.md', 'metadataCache:deleted:Inbox/todo.md']);
		expect(fake.vault.getFileByPath('Inbox/todo.md')).toBeNull();
		expect(fake.paths()).toEqual(['Projekte/2024/Küche.md', 'Projekte2/Archiv/Alt.md']);
	});

	it('renameFile keeps the same TFile object and reports the old path', () => {
		const fake = createFakeApp(seed);
		const before = fake.vault.getFileByPath('Inbox/todo.md');
		const reportedOldPaths: string[] = [];
		fake.vault.on('rename', (_file, oldPath) => {
			reportedOldPaths.push(String(oldPath));
		});
		fake.resetEvents();

		const after = fake.renameFile('Inbox/todo.md', 'Projekte/2024/todo.md');
		expect(after).toBe(before);
		expect(after.path).toBe('Projekte/2024/todo.md');
		expect(after.basename).toBe('todo');
		expect(reportedOldPaths).toEqual(['Inbox/todo.md']);
		expect(fake.events.map(shape)).toEqual(['vault:rename:Projekte/2024/todo.md']);
		expect(fake.vault.getFileByPath('Inbox/todo.md')).toBeNull();
	});

	it('offref stops delivery, which is what registerEvent relies on', () => {
		const fake = createFakeApp(seed);
		let calls = 0;
		const ref = fake.vault.on('modify', () => {
			calls++;
		});
		fake.writeFile('Inbox/todo.md', 'a');
		expect(calls).toBe(1);
		expect(fake.vault.listenerCount('modify')).toBe(1);

		fake.vault.offref(ref);
		fake.writeFile('Inbox/todo.md', 'b');
		expect(calls).toBe(1);
		expect(fake.vault.listenerCount('modify')).toBe(0);
	});

	it('a Component-registered vault ref is detached by unload', () => {
		const fake = createFakeApp(seed);
		const component = new Component();
		let calls = 0;
		component.load();
		component.registerEvent(
			fake.vault.on('modify', () => {
				calls++;
			}),
		);
		fake.writeFile('Inbox/todo.md', 'a');
		expect(calls).toBe(1);

		component.unload();
		fake.writeFile('Inbox/todo.md', 'b');
		expect(calls).toBe(1);
		expect(fake.vault.listenerCount('modify')).toBe(0);
	});

	it('emit fires an event by hand for tests that drive the indexer directly', () => {
		const fake = createFakeApp(seed);
		const file = fake.vault.getFileByPath('Inbox/todo.md');
		const seen: string[] = [];
		fake.vault.on('delete', (arg) => {
			seen.push((arg as TFile).path);
		});
		fake.vault.emit('delete', file);
		expect(seen).toEqual(['Inbox/todo.md']);
	});

	it('exposes an adapter and an appId, and asApp() is the same object', () => {
		const fake = createFakeApp(seed);
		expect(fake.appId).toBe('fake-vault-id');
		expect(fake.vault.adapter.getName()).toBe('fake');
		expect(fake.asApp() as unknown).toBe(fake);
	});

	it('workspace.onLayoutReady defers until the layout is triggered', () => {
		const fake = createFakeApp(seed);
		let ran = false;
		fake.workspace.onLayoutReady(() => {
			ran = true;
		});
		expect(ran).toBe(false);
		fake.workspace.triggerLayoutReady();
		expect(ran).toBe(true);
	});
});

function shape(event: RecordedEvent): string {
	return `${event.source}:${event.name}:${event.path}`;
}
