/**
 * Test stand-in for the `obsidian` module.
 *
 * `vitest.config.mts` aliases the bare specifier `obsidian` to this file, so a
 * unit test can import the real API surface without the app being present.
 *
 * TWO TYPE WORLDS, ONE RUNTIME
 * ----------------------------
 * `tsc` resolves `obsidian` to `node_modules/obsidian/obsidian.d.ts`; only
 * vitest applies the alias. A test that writes `import { Modal } from 'obsidian'`
 * is therefore type-checked against the REAL declarations and executed against
 * the stubs below. That is deliberate: it means a signature the stub gets wrong
 * still fails to compile, and it keeps the stub free of any obligation to
 * reproduce Obsidian's type gymnastics. The stub only has to be right at
 * runtime.
 *
 * Consequence for this file: constructor parameters that would be `App` are
 * typed `unknown`. Nothing in here inspects the app, and a test that needs the
 * real type hands over `createFakeApp(...).asApp()`.
 *
 * WHAT IS AND IS NOT REAL
 * -----------------------
 * `normalizePath`, the DOM helpers, `debounce`, `Component`'s registration
 * bookkeeping, `Events` and `Modal`'s element tree behave like the originals —
 * tests assert against them. Everything else is the smallest thing that keeps a
 * module loadable and observable.
 *
 * Node APIs are allowed in this file; it never ships.
 */

/* ========================================================================== */
/* 1. Paths                                                                   */
/* ========================================================================== */

/**
 * Normalizes a vault path.
 *
 * Backslashes become slashes, runs of slashes collapse, leading and trailing
 * slashes are stripped, non-breaking spaces become ordinary ones and the result
 * is NFC. `''` normalizes to `'/'`, exactly as in the app.
 *
 * DIVERGENCE, ON PURPOSE: this stub also resolves `.` and `..` segments
 * (`'..\\Projekte\\'` -> `'Projekte'`), which the shipped `normalizePath` does
 * not do. The plugin's own path handling is specified against the resolving
 * behaviour, so the stub matches the specification rather than the app. Anything
 * relying on `..` surviving normalization would pass here and fail in Obsidian.
 */
export function normalizePath(path: string): string {
	const flattened = path
		.replace(/([\\/])+/g, '/')
		.replace(/(^\/+|\/+$)/g, '')
		.replace(/[\u00A0\u202F]/g, ' ')
		.normalize('NFC');
	const resolved: string[] = [];
	for (const segment of flattened.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			resolved.pop();
			continue;
		}
		resolved.push(segment);
	}
	const joined = resolved.join('/');
	return joined === '' ? '/' : joined;
}

/* ========================================================================== */
/* 2. DOM helpers                                                             */
/* ========================================================================== */

/** Mirror of Obsidian's global `DomElementInfo`. */
export interface StubDomElementInfo {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	parent?: Node | null;
	value?: string;
	type?: string;
	prepend?: boolean;
	placeholder?: string;
	href?: string;
}

/** Mirror of Obsidian's global `SvgElementInfo`. */
export interface StubSvgElementInfo {
	cls?: string | string[];
	attr?: Record<string, string | number | boolean | null>;
	parent?: Node | null;
	prepend?: boolean;
}

/** Marker so a repeated `installDomHelpers()` is a no-op instead of a re-patch. */
const HELPERS_INSTALLED = '__siftDomHelpersInstalled';

/** Prototypes are patched through this shape so no `any` is needed. */
type PrototypeBag = Record<string, unknown>;

function toClassList(cls: string | string[] | undefined): string[] {
	if (cls === undefined) return [];
	const parts = Array.isArray(cls) ? cls : cls.split(' ');
	return parts.filter((part) => part.length > 0);
}

function setTextOn(el: Node, value: string | DocumentFragment): void {
	if (typeof value === 'string') {
		el.textContent = value;
		return;
	}
	while (el.firstChild !== null) el.removeChild(el.firstChild);
	el.appendChild(value);
}

function setAttrOn(el: Element, name: string, value: string | number | boolean | null): void {
	if (value === null) {
		el.removeAttribute(name);
		return;
	}
	if (value === true) {
		el.setAttribute(name, 'true');
		return;
	}
	if (value === false) {
		el.setAttribute(name, 'false');
		return;
	}
	el.setAttribute(name, String(value));
}

/** Prefers the DOM property when the element has one, so `value`/`href`/`type` behave as expected. */
function assignFieldOn(el: Element, key: string, value: string): void {
	const bag = el as unknown as PrototypeBag;
	if (key in bag) {
		bag[key] = value;
		return;
	}
	el.setAttribute(key, value);
}

function applyElementInfo(el: Element, info: StubDomElementInfo | string | undefined): StubDomElementInfo {
	if (info === undefined) return {};
	const resolved: StubDomElementInfo = typeof info === 'string' ? { cls: info } : info;
	const classes = toClassList(resolved.cls);
	if (classes.length > 0) el.classList.add(...classes);
	if (resolved.text !== undefined) setTextOn(el, resolved.text);
	if (resolved.attr !== undefined) {
		for (const [name, value] of Object.entries(resolved.attr)) setAttrOn(el, name, value);
	}
	if (resolved.title !== undefined) assignFieldOn(el, 'title', resolved.title);
	// `type` before `value`: switching an input's type can clear its value.
	if (resolved.type !== undefined) assignFieldOn(el, 'type', resolved.type);
	if (resolved.value !== undefined) assignFieldOn(el, 'value', resolved.value);
	if (resolved.placeholder !== undefined) assignFieldOn(el, 'placeholder', resolved.placeholder);
	if (resolved.href !== undefined) assignFieldOn(el, 'href', resolved.href);
	return resolved;
}

function attachTo(el: Element, defaultParent: Node | null, info: StubDomElementInfo): void {
	const parent = info.parent !== undefined ? info.parent : defaultParent;
	if (parent === null || parent === undefined) return;
	if (info.prepend === true) parent.insertBefore(el, parent.firstChild);
	else parent.appendChild(el);
}

function ownerDocumentOf(node: Node | null): Document {
	if (node !== null) {
		const doc = node.nodeType === 9 ? (node as Document) : node.ownerDocument;
		if (doc !== null && doc !== undefined) return doc;
	}
	return document;
}

function createElementOn(
	defaultParent: Node | null,
	tag: string,
	info: StubDomElementInfo | string | undefined,
	callback: ((el: Element) => void) | undefined,
): Element {
	const el = ownerDocumentOf(defaultParent).createElement(tag);
	const resolved = applyElementInfo(el, info);
	attachTo(el, defaultParent, resolved);
	if (callback !== undefined) callback(el);
	return el;
}

function createSvgOn(
	defaultParent: Node | null,
	tag: string,
	info: StubSvgElementInfo | string | undefined,
	callback: ((el: Element) => void) | undefined,
): Element {
	const el = ownerDocumentOf(defaultParent).createElementNS('http://www.w3.org/2000/svg', tag);
	const resolved: StubSvgElementInfo = typeof info === 'string' ? { cls: info } : (info ?? {});
	const classes = toClassList(resolved.cls);
	if (classes.length > 0) el.classList.add(...classes);
	if (resolved.attr !== undefined) {
		for (const [name, value] of Object.entries(resolved.attr)) setAttrOn(el, name, value);
	}
	attachTo(el, defaultParent, { parent: resolved.parent, prepend: resolved.prepend });
	if (callback !== undefined) callback(el);
	return el;
}

/**
 * Installs the helpers Obsidian adds to `Node`, `Element` and `HTMLElement`.
 *
 * These are what make the no-`innerHTML` rule liveable, so every UI test needs
 * them. Called automatically when this module is imported into an environment
 * that already has a DOM (`// @vitest-environment happy-dom`); a test that sets
 * a DOM up later calls it by hand. Idempotent, and a no-op without a DOM.
 */
export function installDomHelpers(): void {
	if (typeof globalThis === 'undefined') return;
	const global = globalThis as unknown as PrototypeBag;
	if (global.HTMLElement === undefined || global.Node === undefined || global.Element === undefined) return;

	const nodeProto = Node.prototype as unknown as PrototypeBag;
	if (nodeProto[HELPERS_INSTALLED] === true) return;
	nodeProto[HELPERS_INSTALLED] = true;

	const elementProto = Element.prototype as unknown as PrototypeBag;
	const htmlProto = HTMLElement.prototype as unknown as PrototypeBag;

	/* --- Node --- */

	/**
	 * Obsidian's cross-window-capable stand-in for `instanceof`. Inside a popped
	 * out window the element belongs to a different realm, where the bare
	 * operator compares against the wrong constructor; `instanceOf` compares
	 * against the constructor of the node's OWN window. Plugin code is expected
	 * to use it, so the stub has to have it or every such call throws here.
	 */
	nodeProto.instanceOf = function <T>(this: Node, type: new () => T): boolean {
		const view = (this.ownerDocument ?? (this as unknown as Document)).defaultView;
		const ctor = view === null || view === undefined ? type : ((view as unknown as Record<string, unknown>)[type.name] ?? type);
		return this instanceof (ctor as new () => T);
	};

	nodeProto.createEl = function (
		this: Node,
		tag: string,
		info?: StubDomElementInfo | string,
		callback?: (el: Element) => void,
	): Element {
		return createElementOn(this, tag, info, callback);
	};
	nodeProto.createDiv = function (
		this: Node,
		info?: StubDomElementInfo | string,
		callback?: (el: Element) => void,
	): Element {
		return createElementOn(this, 'div', info, callback);
	};
	nodeProto.createSpan = function (
		this: Node,
		info?: StubDomElementInfo | string,
		callback?: (el: Element) => void,
	): Element {
		return createElementOn(this, 'span', info, callback);
	};
	nodeProto.createSvg = function (
		this: Node,
		tag: string,
		info?: StubSvgElementInfo | string,
		callback?: (el: Element) => void,
	): Element {
		return createSvgOn(this, tag, info, callback);
	};
	nodeProto.detach = function (this: Node): void {
		this.parentNode?.removeChild(this);
	};
	nodeProto.empty = function (this: Node): void {
		while (this.firstChild !== null) this.removeChild(this.firstChild);
	};
	nodeProto.appendText = function (this: Node, value: string): void {
		this.appendChild(ownerDocumentOf(this).createTextNode(value));
	};
	nodeProto.insertAfter = function (this: Node, node: Node, child: Node | null): Node {
		this.insertBefore(node, child === null ? null : child.nextSibling);
		return node;
	};
	nodeProto.indexOf = function (this: Node, other: Node): number {
		return Array.prototype.indexOf.call(this.childNodes, other);
	};

	/* --- Element --- */

	elementProto.setText = function (this: Element, value: string | DocumentFragment): void {
		setTextOn(this, value);
	};
	elementProto.getText = function (this: Element): string {
		return this.textContent ?? '';
	};
	elementProto.addClass = function (this: Element, ...classes: string[]): void {
		const list = classes.filter((cls) => cls.length > 0);
		if (list.length > 0) this.classList.add(...list);
	};
	elementProto.addClasses = function (this: Element, classes: string[]): void {
		const list = classes.filter((cls) => cls.length > 0);
		if (list.length > 0) this.classList.add(...list);
	};
	elementProto.removeClass = function (this: Element, ...classes: string[]): void {
		const list = classes.filter((cls) => cls.length > 0);
		if (list.length > 0) this.classList.remove(...list);
	};
	elementProto.removeClasses = function (this: Element, classes: string[]): void {
		const list = classes.filter((cls) => cls.length > 0);
		if (list.length > 0) this.classList.remove(...list);
	};
	elementProto.toggleClass = function (this: Element, classes: string | string[], value: boolean): void {
		for (const cls of toClassList(classes)) this.classList.toggle(cls, value);
	};
	elementProto.hasClass = function (this: Element, cls: string): boolean {
		return this.classList.contains(cls);
	};
	elementProto.setAttr = function (this: Element, name: string, value: string | number | boolean | null): void {
		setAttrOn(this, name, value);
	};
	elementProto.setAttrs = function (this: Element, attrs: Record<string, string | number | boolean | null>): void {
		for (const [name, value] of Object.entries(attrs)) setAttrOn(this, name, value);
	};
	elementProto.getAttr = function (this: Element, name: string): string | null {
		return this.getAttribute(name);
	};
	elementProto.find = function (this: Element, selector: string): Element | null {
		return this.querySelector(selector);
	};
	elementProto.findAll = function (this: Element, selector: string): Element[] {
		return Array.from(this.querySelectorAll(selector));
	};
	elementProto.findAllSelf = function (this: Element, selector: string): Element[] {
		const found = Array.from(this.querySelectorAll(selector));
		return this.matches(selector) ? [this, ...found] : found;
	};

	/* --- HTMLElement --- */

	// These two ARE Obsidian's own show/hide helpers, which set `display`
	// directly. The lint rule against inline styles is aimed at plugin code
	// reaching for them instead of a class; reproducing the API is the job here.
	htmlProto.show = function (this: HTMLElement): void {
		this.style.display = '';
	};
	htmlProto.hide = function (this: HTMLElement): void {
		this.style.display = 'none';
	};
	htmlProto.toggle = function (this: HTMLElement, show: boolean): void {
		this.style.display = show ? '' : 'none';
	};
	htmlProto.toggleVisibility = function (this: HTMLElement, visible: boolean): void {
		this.style.visibility = visible ? '' : 'hidden';
	};
	htmlProto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>): void {
		for (const [name, value] of Object.entries(styles)) {
			(this.style as unknown as PrototypeBag)[name] = value;
		}
	};
	htmlProto.setCssProps = function (this: HTMLElement, props: Record<string, string>): void {
		for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
	};

	/* --- free functions --- */

	global.createEl = (tag: string, info?: StubDomElementInfo | string, callback?: (el: Element) => void): Element =>
		createElementOn(null, tag, info, callback);
	global.createDiv = (info?: StubDomElementInfo | string, callback?: (el: Element) => void): Element =>
		createElementOn(null, 'div', info, callback);
	global.createSpan = (info?: StubDomElementInfo | string, callback?: (el: Element) => void): Element =>
		createElementOn(null, 'span', info, callback);
	global.createSvg = (tag: string, info?: StubSvgElementInfo | string, callback?: (el: Element) => void): Element =>
		createSvgOn(null, tag, info, callback);
	global.createFragment = (callback?: (el: DocumentFragment) => void): DocumentFragment => {
		const fragment = document.createDocumentFragment();
		if (callback !== undefined) callback(fragment);
		return fragment;
	};
}

/** True once `installDomHelpers()` has patched the prototypes of the current DOM. */
export function domHelpersInstalled(): boolean {
	if (typeof globalThis === 'undefined') return false;
	const global = globalThis as unknown as PrototypeBag;
	if (global.Node === undefined) return false;
	return (Node.prototype as unknown as PrototypeBag)[HELPERS_INSTALLED] === true;
}

/** Requires a DOM; every stub that builds elements calls this first so the failure is legible. */
function requireDom(what: string): void {
	if (typeof globalThis === 'undefined' || (globalThis as unknown as PrototypeBag).document === undefined) {
		throw new Error(`${what} needs a DOM. Add "// @vitest-environment happy-dom" to the top of the test file.`);
	}
	installDomHelpers();
}

/* ========================================================================== */
/* 3. Events                                                                  */
/* ========================================================================== */

/** Opaque handle returned by every `on(...)`. */
export interface EventRef {
	/** Present on the stub so a test can see which event a ref belongs to. */
	readonly name?: string;
}

type EventCallback = (...data: unknown[]) => unknown;

interface Subscription extends EventRef {
	readonly name: string;
	readonly callback: EventCallback;
	readonly ctx: unknown;
	detached: boolean;
	/** Removes this one subscription. `Component.unload` calls it through `detachEventRef`. */
	detach(): void;
}

export class Events {
	private readonly subscriptions = new Map<string, Subscription[]>();

	on(name: string, callback: EventCallback, ctx?: unknown): EventRef {
		const subscription: Subscription = {
			name,
			callback,
			ctx,
			detached: false,
			detach: () => {
				this.remove(subscription);
			},
		};
		const list = this.subscriptions.get(name);
		if (list === undefined) this.subscriptions.set(name, [subscription]);
		else list.push(subscription);
		return subscription;
	}

	off(name: string, callback: EventCallback): void {
		const list = this.subscriptions.get(name);
		if (list === undefined) return;
		for (const entry of list.slice()) {
			if (entry.callback === callback) this.remove(entry);
		}
	}

	offref(ref: EventRef): void {
		const subscription = ref as Subscription;
		if (typeof subscription.detach === 'function') subscription.detach();
	}

	trigger(name: string, ...data: unknown[]): void {
		const list = this.subscriptions.get(name);
		if (list === undefined) return;
		// Copied so a handler that unsubscribes during dispatch cannot skip a sibling.
		for (const subscription of list.slice()) {
			if (subscription.detached) continue;
			subscription.callback.apply(subscription.ctx, data);
		}
	}

	tryTrigger(evt: EventRef, args: unknown[]): void {
		const subscription = evt as Subscription;
		if (subscription.detached === true) return;
		subscription.callback.apply(subscription.ctx, args);
	}

	/** Test affordance: how many live handlers a name has. Not part of the real API. */
	listenerCount(name: string): number {
		return this.subscriptions.get(name)?.length ?? 0;
	}

	private remove(subscription: Subscription): void {
		subscription.detached = true;
		const list = this.subscriptions.get(subscription.name);
		if (list === undefined) return;
		const at = list.indexOf(subscription);
		if (at >= 0) list.splice(at, 1);
	}
}

/* ========================================================================== */
/* 4. Component lifecycle                                                     */
/* ========================================================================== */

interface DomRegistration {
	target: EventTarget;
	type: string;
	listener: EventListener;
	options?: boolean | AddEventListenerOptions;
}

/**
 * Real bookkeeping, because "after `onunload` no handler fires" is an assertion
 * several test suites make.
 */
export class Component {
	private readonly children: Component[] = [];
	private readonly disposers: Array<() => unknown> = [];
	private readonly eventRefs: EventRef[] = [];
	private readonly domRegistrations: DomRegistration[] = [];
	private readonly intervals: number[] = [];
	private loaded = false;

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
		for (const child of this.children) child.load();
	}

	onload(): void {
		/* overridden by subclasses */
	}

	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		for (const child of this.children.slice()) child.unload();
		this.children.length = 0;
		for (const registration of this.domRegistrations) {
			registration.target.removeEventListener(registration.type, registration.listener, registration.options);
		}
		this.domRegistrations.length = 0;
		for (const ref of this.eventRefs) detachEventRef(ref);
		this.eventRefs.length = 0;
		for (const id of this.intervals) clearInterval(id);
		this.intervals.length = 0;
		for (const dispose of this.disposers.slice().reverse()) dispose();
		this.disposers.length = 0;
		this.onunload();
	}

	onunload(): void {
		/* overridden by subclasses */
	}

	addChild<T extends Component>(component: T): T {
		this.children.push(component);
		if (this.loaded) component.load();
		return component;
	}

	removeChild<T extends Component>(component: T): T {
		const at = this.children.indexOf(component);
		if (at >= 0) this.children.splice(at, 1);
		component.unload();
		return component;
	}

	register(cb: () => unknown): void {
		this.disposers.push(cb);
	}

	registerEvent(eventRef: EventRef): void {
		this.eventRefs.push(eventRef);
	}

	registerDomEvent(
		el: EventTarget,
		type: string,
		callback: EventListener,
		options?: boolean | AddEventListenerOptions,
	): void {
		el.addEventListener(type, callback, options);
		this.domRegistrations.push({ target: el, type, listener: callback, options });
	}

	registerInterval(id: number): number {
		this.intervals.push(id);
		return id;
	}

	/** Test affordance: how many DOM listeners are still attached. Not part of the real API. */
	domEventCount(): number {
		return this.domRegistrations.length;
	}

	/** Test affordance: how many `registerEvent` refs are still held. Not part of the real API. */
	eventRefCount(): number {
		return this.eventRefs.length;
	}
}

/**
 * A ref only knows how to detach itself if its emitter recorded one. `Events`
 * subscriptions and the fake vault both produce refs carrying a `detach`.
 */
interface DetachableRef extends EventRef {
	detach?: () => void;
	owner?: Events;
}

function detachEventRef(ref: EventRef): void {
	const detachable = ref as DetachableRef;
	if (typeof detachable.detach === 'function') {
		detachable.detach();
		return;
	}
	if (detachable.owner instanceof Events) {
		detachable.owner.offref(ref);
		return;
	}
	(ref as Subscription).detached = true;
}

/* ========================================================================== */
/* 5. Vault files                                                             */
/* ========================================================================== */

export interface FileStats {
	ctime: number;
	mtime: number;
	size: number;
}

export class TAbstractFile {
	/** The owning vault. The stub never reads it; `createFakeApp` fills it in. */
	vault: unknown = null;
	path = '';
	name = '';
	parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
	stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
	basename = '';
	extension = '';

	/** Stub-only convenience: the real class is constructed by the app, never by plugin code. */
	constructor(path?: string, stat?: FileStats) {
		super();
		if (path !== undefined) this.setPath(path);
		if (stat !== undefined) this.stat = stat;
	}

	/** Stub-only: recomputes `name`, `basename` and `extension` from `path`. Used by rename. */
	setPath(path: string): void {
		this.path = path;
		const slash = path.lastIndexOf('/');
		this.name = slash < 0 ? path : path.slice(slash + 1);
		const dot = this.name.lastIndexOf('.');
		if (dot > 0) {
			this.basename = this.name.slice(0, dot);
			this.extension = this.name.slice(dot + 1);
		} else {
			this.basename = this.name;
			this.extension = '';
		}
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	/** Stub-only convenience, see {@link TFile}. */
	constructor(path?: string) {
		super();
		if (path !== undefined) {
			this.path = path;
			const slash = path.lastIndexOf('/');
			this.name = slash < 0 ? path : path.slice(slash + 1);
		}
	}

	isRoot(): boolean {
		return this.path === '' || this.path === '/';
	}
}

/* ========================================================================== */
/* 6. Plugin lifecycle                                                        */
/* ========================================================================== */

export interface StubCommand {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
	/** Present in the real type; the plugin must never set it. Tests assert that. */
	hotkeys?: unknown;
	[key: string]: unknown;
}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	author: string;
	description: string;
	isDesktopOnly: boolean;
}

export const DEFAULT_STUB_MANIFEST: PluginManifest = {
	id: 'sift',
	name: 'Sift',
	version: '0.1.0',
	minAppVersion: '1.5.0',
	author: 'test',
	description: 'test manifest',
	isDesktopOnly: false,
};

export class Plugin extends Component {
	/** The fake app the test constructed the plugin with. Typed loosely; see the file header. */
	app: unknown;
	manifest: PluginManifest;

	/** Every command handed to `addCommand`, in registration order. Test affordance. */
	readonly commands: StubCommand[] = [];
	/** Every `addRibbonIcon` call, in order. Test affordance. */
	readonly ribbonIcons: Array<{ icon: string; title: string; callback: (evt: MouseEvent) => unknown }> = [];
	/** Every settings tab handed to `addSettingTab`. Test affordance. */
	readonly settingTabs: unknown[] = [];
	/** Stand-in for `data.json`. Seed it before `onload()` to test migration. */
	storedData: unknown = null;

	constructor(app: unknown, manifest?: PluginManifest) {
		super();
		this.app = app;
		this.manifest = manifest ?? DEFAULT_STUB_MANIFEST;
	}

	addCommand(command: StubCommand): StubCommand {
		this.commands.push(command);
		return command;
	}

	removeCommand(commandId: string): void {
		const at = this.commands.findIndex((command) => command.id === commandId);
		if (at >= 0) this.commands.splice(at, 1);
	}

	addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
		requireDom('Plugin.addRibbonIcon');
		this.ribbonIcons.push({ icon, title, callback });
		const el = document.createElement('div');
		el.classList.add('side-dock-ribbon-action');
		setAttrOn(el, 'aria-label', title);
		setIcon(el, icon);
		el.addEventListener('click', (evt) => {
			callback(evt);
		});
		return el;
	}

	addStatusBarItem(): HTMLElement {
		requireDom('Plugin.addStatusBarItem');
		return document.createElement('div');
	}

	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}

	async loadData(): Promise<unknown> {
		return this.storedData;
	}

	async saveData(data: unknown): Promise<void> {
		this.storedData = data;
	}
}

export class SettingTab {
	app: unknown;
	containerEl: HTMLElement;

	constructor(app: unknown) {
		requireDom('SettingTab');
		this.app = app;
		this.containerEl = document.createElement('div');
	}

	display(): void {
		/* overridden by subclasses */
	}

	hide(): void {
		while (this.containerEl.firstChild !== null) this.containerEl.removeChild(this.containerEl.firstChild);
	}
}

export class PluginSettingTab extends SettingTab {
	plugin: unknown;

	constructor(app: unknown, plugin: unknown) {
		super(app);
		this.plugin = plugin;
	}
}

/* ========================================================================== */
/* 7. Modal, Notice, Scope, Keymap                                            */
/* ========================================================================== */

/** One `Scope.register` binding. */
export interface KeymapEventHandler {
	modifiers: string[] | null;
	key: string | null;
	handler: (evt: KeyboardEvent) => unknown;
}

export class Scope {
	/** Every `register` call, so a test can assert the modal's key bindings. */
	readonly keys: KeymapEventHandler[] = [];
	readonly parent: Scope | null;

	constructor(parent?: Scope) {
		this.parent = parent ?? null;
	}

	register(modifiers: string[] | null, key: string | null, func: (evt: KeyboardEvent) => unknown): KeymapEventHandler {
		const handle: KeymapEventHandler = { modifiers, key, handler: func };
		this.keys.push(handle);
		return handle;
	}

	unregister(handler: KeymapEventHandler): void {
		const at = this.keys.indexOf(handler);
		if (at >= 0) this.keys.splice(at, 1);
	}
}

export const Keymap = {
	/** `'tab'` for a modifier click, `false` otherwise — matching the shape the app returns. */
	isModEvent(evt?: { ctrlKey?: boolean; metaKey?: boolean; button?: number } | null): 'tab' | false {
		if (evt === null || evt === undefined) return false;
		if (evt.ctrlKey === true || evt.metaKey === true || evt.button === 1) return 'tab';
		return false;
	},
	isModifier(evt: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }, modifier: string): boolean {
		switch (modifier) {
			case 'Mod':
				return evt.ctrlKey === true || evt.metaKey === true;
			case 'Ctrl':
				return evt.ctrlKey === true;
			case 'Meta':
				return evt.metaKey === true;
			case 'Shift':
				return evt.shiftKey === true;
			case 'Alt':
				return evt.altKey === true;
			default:
				return false;
		}
	},
};

/**
 * Builds the same element tree the app does — `.modal-container > .modal >
 * (.modal-close-button, .modal-title, .modal-content)` — and really calls
 * `onOpen` / `onClose`, because open/close cycles are what the leak tests count.
 */
export class Modal {
	app: unknown;
	scope: Scope;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	shouldRestoreSelection = true;
	/** Test affordance: true between `open()` and `close()`. */
	isOpen = false;

	constructor(app: unknown) {
		requireDom('Modal');
		this.app = app;
		this.scope = new Scope();
		this.containerEl = document.createElement('div');
		this.containerEl.classList.add('modal-container', 'mod-dim');
		this.modalEl = document.createElement('div');
		this.modalEl.classList.add('modal');
		this.containerEl.appendChild(this.modalEl);
		const closeButton = document.createElement('div');
		closeButton.classList.add('modal-close-button');
		this.modalEl.appendChild(closeButton);
		this.titleEl = document.createElement('div');
		this.titleEl.classList.add('modal-title');
		this.modalEl.appendChild(this.titleEl);
		this.contentEl = document.createElement('div');
		this.contentEl.classList.add('modal-content');
		this.modalEl.appendChild(this.contentEl);
	}

	open(): void {
		if (this.isOpen) return;
		this.isOpen = true;
		document.body.appendChild(this.containerEl);
		this.onOpen();
	}

	close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.onClose();
		this.containerEl.parentNode?.removeChild(this.containerEl);
	}

	onOpen(): void {
		/* overridden by subclasses */
	}

	onClose(): void {
		/* overridden by subclasses */
	}

	setTitle(title: string): this {
		this.titleEl.textContent = title;
		return this;
	}

	setContent(content: string | DocumentFragment): this {
		setTextOn(this.contentEl, content);
		return this;
	}
}

export class Notice {
	/** Every notice raised since the last `Notice.reset()`. Test affordance. */
	static readonly messages: string[] = [];

	noticeEl: HTMLElement | null = null;
	containerEl: HTMLElement | null = null;
	messageEl: HTMLElement | null = null;
	readonly message: string;
	readonly duration: number;

	constructor(message: string | DocumentFragment, duration = 5000) {
		this.message = typeof message === 'string' ? message : (message.textContent ?? '');
		this.duration = duration;
		Notice.messages.push(this.message);
		if (typeof globalThis !== 'undefined' && (globalThis as unknown as PrototypeBag).document !== undefined) {
			this.containerEl = document.createElement('div');
			this.containerEl.classList.add('notice-container');
			this.noticeEl = document.createElement('div');
			this.noticeEl.classList.add('notice');
			this.messageEl = document.createElement('div');
			this.messageEl.classList.add('notice-message');
			setTextOn(this.messageEl, message);
			this.noticeEl.appendChild(this.messageEl);
			this.containerEl.appendChild(this.noticeEl);
		}
	}

	setMessage(message: string | DocumentFragment): this {
		if (this.messageEl !== null) setTextOn(this.messageEl, message);
		return this;
	}

	hide(): void {
		this.containerEl?.parentNode?.removeChild(this.containerEl);
	}

	/** Test affordance: clears the recorded messages. */
	static reset(): void {
		Notice.messages.length = 0;
	}
}

/* ========================================================================== */
/* 8. Icons, debounce, locale, platform                                       */
/* ========================================================================== */

/** Appends the same `svg.svg-icon` marker the app does, plus `data-icon` so tests can assert. */
export function setIcon(parent: HTMLElement, iconId: string): void {
	requireDom('setIcon');
	while (parent.firstChild !== null) parent.removeChild(parent.firstChild);
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.classList.add('svg-icon', `lucide-${iconId}`);
	svg.setAttribute('data-icon', iconId);
	parent.appendChild(svg);
}

export interface Debouncer<T extends unknown[], V> {
	(...args: T): Debouncer<T, V>;
	cancel(): Debouncer<T, V>;
	run(): V | void;
}

/**
 * Trailing-edge debounce with Obsidian's semantics: with `resetTimer` false the
 * timer keeps the deadline of the FIRST call while later calls only replace the
 * arguments; with `resetTimer` true every call restarts the clock.
 */
export function debounce<T extends unknown[], V>(
	cb: (...args: T) => V,
	timeout = 0,
	resetTimer = false,
): Debouncer<T, V> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: T | null = null;

	const fire = (): void => {
		timer = null;
		const args = pending;
		pending = null;
		if (args !== null) cb(...args);
	};

	const debounced = ((...args: T): Debouncer<T, V> => {
		pending = args;
		if (timer !== null) {
			if (!resetTimer) return debounced;
			clearTimeout(timer);
		}
		timer = setTimeout(fire, timeout);
		return debounced;
	}) as Debouncer<T, V>;

	debounced.cancel = (): Debouncer<T, V> => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pending = null;
		return debounced;
	};

	debounced.run = (): V | void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		const args = pending;
		pending = null;
		if (args === null) return undefined;
		return cb(...args);
	};

	return debounced;
}

let stubLanguage = 'en';

/** Obsidian's UI locale. Defaults to `'en'`; tests drive it with {@link setStubLanguage}. */
export function getLanguage(): string {
	return stubLanguage;
}

/** Test affordance: sets what {@link getLanguage} reports. */
export function setStubLanguage(language: string): void {
	stubLanguage = language;
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: false,
	isWin: true,
	isLinux: false,
	isSafari: false,
	resourcePathPrefix: 'app://stub/',
};

/** Test affordance: puts {@link Platform} and {@link getLanguage} back to their defaults. */
export function resetStubEnvironment(): void {
	stubLanguage = 'en';
	Platform.isDesktop = true;
	Platform.isMobile = false;
	Platform.isDesktopApp = true;
	Platform.isMobileApp = false;
	Platform.isIosApp = false;
	Platform.isAndroidApp = false;
	Platform.isPhone = false;
	Platform.isTablet = false;
	Platform.isMacOS = false;
	Platform.isWin = true;
	Platform.isLinux = false;
	Platform.isSafari = false;
	Notice.reset();
}

/* ========================================================================== */
/* 9. Setting and its components                                              */
/* ========================================================================== */

export class BaseComponent {
	disabled = false;

	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}

	then(cb: (component: this) => unknown): this {
		cb(this);
		return this;
	}
}

export class ValueComponent<T> extends BaseComponent {
	protected changeHandlers: Array<(value: T) => unknown> = [];

	onChange(cb: (value: T) => unknown): this {
		this.changeHandlers.push(cb);
		return this;
	}

	protected emitChange(value: T): void {
		for (const handler of this.changeHandlers.slice()) handler(value);
	}
}

export class ToggleComponent extends ValueComponent<boolean> {
	readonly toggleEl: HTMLElement;
	private value = false;

	constructor(containerEl: HTMLElement) {
		super();
		requireDom('ToggleComponent');
		this.toggleEl = document.createElement('div');
		this.toggleEl.classList.add('checkbox-container');
		setAttrOn(this.toggleEl, 'role', 'checkbox');
		setAttrOn(this.toggleEl, 'tabindex', '0');
		setAttrOn(this.toggleEl, 'aria-checked', 'false');
		this.toggleEl.addEventListener('click', () => {
			if (this.disabled) return;
			this.setValue(!this.value);
			this.emitChange(this.value);
		});
		containerEl.appendChild(this.toggleEl);
	}

	getValue(): boolean {
		return this.value;
	}

	setValue(value: boolean): this {
		this.value = value;
		this.toggleEl.classList.toggle('is-enabled', value);
		setAttrOn(this.toggleEl, 'aria-checked', value ? 'true' : 'false');
		return this;
	}

	setTooltip(tooltip: string): this {
		setAttrOn(this.toggleEl, 'aria-label', tooltip);
		return this;
	}
}

export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
	readonly inputEl: T;

	constructor(inputEl: T) {
		super();
		this.inputEl = inputEl;
		this.inputEl.addEventListener('input', () => {
			this.emitChange(this.inputEl.value);
		});
	}

	getValue(): string {
		return this.inputEl.value;
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(placeholder: string): this {
		this.inputEl.placeholder = placeholder;
		return this;
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.inputEl.disabled = disabled;
		return this;
	}
}

/**
 * Built outside the constructor so `super(...)` stays the first statement —
 * class fields are defined right after `super()` returns, and TypeScript refuses
 * anything before it once a subclass declares one.
 */
function appendInput(containerEl: HTMLElement, type: string, wrapperCls?: string): HTMLInputElement {
	requireDom('a Setting input');
	const doc = containerEl.ownerDocument ?? document;
	const input = doc.createElement('input');
	input.type = type;
	if (wrapperCls === undefined) {
		containerEl.appendChild(input);
		return input;
	}
	const wrapper = doc.createElement('div');
	wrapper.classList.add(wrapperCls);
	wrapper.appendChild(input);
	containerEl.appendChild(wrapper);
	return input;
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
	constructor(containerEl: HTMLElement) {
		super(appendInput(containerEl, 'text'));
	}
}

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
	readonly clearButtonEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super(appendInput(containerEl, 'search', 'search-input-container'));
		const wrapper = this.inputEl.parentElement ?? this.inputEl;
		this.clearButtonEl = (wrapper.ownerDocument ?? document).createElement('div');
		this.clearButtonEl.classList.add('search-input-clear-button');
		wrapper.appendChild(this.clearButtonEl);
	}
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
	constructor(containerEl: HTMLElement) {
		super(appendTextArea(containerEl));
	}
}

function appendTextArea(containerEl: HTMLElement): HTMLTextAreaElement {
	requireDom('TextAreaComponent');
	const input = (containerEl.ownerDocument ?? document).createElement('textarea');
	containerEl.appendChild(input);
	return input;
}

export class DropdownComponent extends ValueComponent<string> {
	readonly selectEl: HTMLSelectElement;

	constructor(containerEl: HTMLElement) {
		super();
		requireDom('DropdownComponent');
		this.selectEl = document.createElement('select');
		this.selectEl.addEventListener('change', () => {
			this.emitChange(this.selectEl.value);
		});
		containerEl.appendChild(this.selectEl);
	}

	addOption(value: string, display: string): this {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = display;
		this.selectEl.appendChild(option);
		return this;
	}

	addOptions(options: Record<string, string>): this {
		for (const [value, display] of Object.entries(options)) this.addOption(value, display);
		return this;
	}

	getValue(): string {
		return this.selectEl.value;
	}

	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}
}

export class SliderComponent extends ValueComponent<number> {
	readonly sliderEl: HTMLInputElement;

	constructor(containerEl: HTMLElement) {
		super();
		requireDom('SliderComponent');
		this.sliderEl = document.createElement('input');
		this.sliderEl.type = 'range';
		this.sliderEl.addEventListener('input', () => {
			this.emitChange(this.getValue());
		});
		containerEl.appendChild(this.sliderEl);
	}

	setLimits(min: number, max: number, step: number | 'any'): this {
		this.sliderEl.min = String(min);
		this.sliderEl.max = String(max);
		this.sliderEl.step = String(step);
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}

	showTooltip(): void {
		/* no-op */
	}

	getValue(): number {
		return Number(this.sliderEl.value);
	}

	setValue(value: number): this {
		this.sliderEl.value = String(value);
		return this;
	}
}

export class ButtonComponent extends BaseComponent {
	readonly buttonEl: HTMLButtonElement;

	constructor(containerEl: HTMLElement) {
		super();
		requireDom('ButtonComponent');
		this.buttonEl = document.createElement('button');
		containerEl.appendChild(this.buttonEl);
	}

	setButtonText(name: string): this {
		this.buttonEl.textContent = name;
		return this;
	}

	setCta(): this {
		this.buttonEl.classList.add('mod-cta');
		return this;
	}

	removeCta(): this {
		this.buttonEl.classList.remove('mod-cta');
		return this;
	}

	setWarning(): this {
		this.buttonEl.classList.add('mod-warning');
		return this;
	}

	setIcon(icon: string): this {
		setIcon(this.buttonEl, icon);
		return this;
	}

	setTooltip(tooltip: string): this {
		setAttrOn(this.buttonEl, 'aria-label', tooltip);
		return this;
	}

	onClick(callback: (evt: MouseEvent) => unknown): this {
		this.buttonEl.addEventListener('click', (evt) => {
			callback(evt);
		});
		return this;
	}

	override setDisabled(disabled: boolean): this {
		super.setDisabled(disabled);
		this.buttonEl.disabled = disabled;
		return this;
	}
}

export class ExtraButtonComponent extends BaseComponent {
	readonly extraSettingsEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super();
		requireDom('ExtraButtonComponent');
		this.extraSettingsEl = document.createElement('div');
		this.extraSettingsEl.classList.add('clickable-icon', 'extra-setting-button');
		containerEl.appendChild(this.extraSettingsEl);
	}

	setIcon(icon: string): this {
		setIcon(this.extraSettingsEl, icon);
		return this;
	}

	setTooltip(tooltip: string): this {
		setAttrOn(this.extraSettingsEl, 'aria-label', tooltip);
		return this;
	}

	onClick(callback: () => unknown): this {
		this.extraSettingsEl.addEventListener('click', () => {
			callback();
		});
		return this;
	}
}

/** Builds the real `.setting-item` tree so a settings-tab test can walk it. */
export class Setting {
	readonly settingEl: HTMLElement;
	readonly infoEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	readonly components: BaseComponent[] = [];

	constructor(containerEl: HTMLElement) {
		requireDom('Setting');
		const doc = containerEl.ownerDocument ?? document;
		this.settingEl = doc.createElement('div');
		this.settingEl.classList.add('setting-item');
		this.infoEl = doc.createElement('div');
		this.infoEl.classList.add('setting-item-info');
		this.nameEl = doc.createElement('div');
		this.nameEl.classList.add('setting-item-name');
		this.descEl = doc.createElement('div');
		this.descEl.classList.add('setting-item-description');
		this.controlEl = doc.createElement('div');
		this.controlEl.classList.add('setting-item-control');
		this.infoEl.appendChild(this.nameEl);
		this.infoEl.appendChild(this.descEl);
		this.settingEl.appendChild(this.infoEl);
		this.settingEl.appendChild(this.controlEl);
		containerEl.appendChild(this.settingEl);
	}

	setName(name: string | DocumentFragment): this {
		setTextOn(this.nameEl, name);
		return this;
	}

	setDesc(desc: string | DocumentFragment): this {
		setTextOn(this.descEl, desc);
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.classList.add(cls);
		return this;
	}

	setTooltip(tooltip: string): this {
		setAttrOn(this.settingEl, 'aria-label', tooltip);
		return this;
	}

	setHeading(): this {
		this.settingEl.classList.add('setting-item-heading');
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.settingEl.classList.toggle('is-disabled', disabled);
		return this;
	}

	addButton(cb: (component: ButtonComponent) => unknown): this {
		const component = new ButtonComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
		const component = new ExtraButtonComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addToggle(cb: (component: ToggleComponent) => unknown): this {
		const component = new ToggleComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addText(cb: (component: TextComponent) => unknown): this {
		const component = new TextComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addSearch(cb: (component: SearchComponent) => unknown): this {
		const component = new SearchComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addTextArea(cb: (component: TextAreaComponent) => unknown): this {
		const component = new TextAreaComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addDropdown(cb: (component: DropdownComponent) => unknown): this {
		const component = new DropdownComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	addSlider(cb: (component: SliderComponent) => unknown): this {
		const component = new SliderComponent(this.controlEl);
		this.components.push(component);
		cb(component);
		return this;
	}

	then(cb: (setting: this) => unknown): this {
		cb(this);
		return this;
	}

	clear(): this {
		while (this.controlEl.firstChild !== null) this.controlEl.removeChild(this.controlEl.firstChild);
		this.components.length = 0;
		return this;
	}
}

/* ========================================================================== */
/* 10. Suggesters and views                                                   */
/* ========================================================================== */

/**
 * Enough of `AbstractInputSuggest` for the folder picker: it holds the input,
 * exposes `open`/`close` so a `destroy()` test can observe detachment, and runs
 * `getSuggestions` when the input fires `input`.
 */
export abstract class AbstractInputSuggest<T> {
	limit = 100;
	/** Test affordance: whether the popover is currently shown. */
	isOpen = false;
	/** Test affordance: the suggestions produced by the last input event. */
	lastSuggestions: T[] = [];

	protected readonly app: unknown;
	protected readonly textInputEl: HTMLInputElement | HTMLDivElement;
	private selectHandler: ((value: T, evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
	private readonly inputListener: EventListener;

	constructor(app: unknown, textInputEl: HTMLInputElement | HTMLDivElement) {
		this.app = app;
		this.textInputEl = textInputEl;
		this.inputListener = () => {
			void this.refreshSuggestions();
		};
		textInputEl.addEventListener('input', this.inputListener);
	}

	setValue(value: string): void {
		if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
		else this.textInputEl.textContent = value;
	}

	getValue(): string {
		if (this.textInputEl instanceof HTMLInputElement) return this.textInputEl.value;
		return this.textInputEl.textContent ?? '';
	}

	protected abstract getSuggestions(query: string): T[] | Promise<T[]>;

	abstract renderSuggestion(value: T, el: HTMLElement): void;

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
		this.selectHandler?.(value, evt);
		this.close();
	}

	onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this {
		this.selectHandler = callback;
		return this;
	}

	open(): void {
		this.isOpen = true;
	}

	close(): void {
		this.isOpen = false;
	}

	/** The real class detaches its listeners here; tests assert it was called. */
	destroy(): void {
		this.close();
		this.textInputEl.removeEventListener('input', this.inputListener);
	}

	/** Test affordance: runs the suggestion pipeline for the current input value. */
	async refreshSuggestions(): Promise<T[]> {
		this.lastSuggestions = await this.getSuggestions(this.getValue());
		return this.lastSuggestions;
	}
}

/** A cursor position in an editor. */
export interface EditorPosition {
	line: number;
	ch: number;
}

/**
 * Just enough editor for "open the file and put the cursor on the hit". Backed
 * by a real string, so `offsetToPos` is genuinely computed and a test can assert
 * the CRLF and surrogate-pair cases the modal has to get right.
 */
export class Editor {
	private value = '';
	/** Test affordance: the last position handed to `setCursor`. */
	lastCursor: EditorPosition | null = null;
	/** Test affordance: every range handed to `setSelection`. */
	readonly selections: Array<{ from: EditorPosition; to: EditorPosition }> = [];
	/** Test affordance: every range handed to `scrollIntoView`. */
	readonly scrolledTo: Array<{ from: EditorPosition; to: EditorPosition }> = [];

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
	}

	offsetToPos(offset: number): EditorPosition {
		const clamped = Math.max(0, Math.min(offset, this.value.length));
		let line = 0;
		let lineStart = 0;
		for (let i = 0; i < clamped; i++) {
			if (this.value.charCodeAt(i) === 10) {
				line++;
				lineStart = i + 1;
			}
		}
		return { line, ch: clamped - lineStart };
	}

	posToOffset(pos: EditorPosition): number {
		let offset = 0;
		for (let line = 0; line < pos.line; line++) {
			const next = this.value.indexOf('\n', offset);
			if (next < 0) return this.value.length;
			offset = next + 1;
		}
		return Math.min(offset + pos.ch, this.value.length);
	}

	setCursor(pos: EditorPosition): void {
		this.lastCursor = pos;
	}

	setSelection(from: EditorPosition, to: EditorPosition): void {
		this.selections.push({ from, to });
		this.lastCursor = from;
	}

	scrollIntoView(range: { from: EditorPosition; to: EditorPosition }): void {
		this.scrolledTo.push(range);
	}
}

export class View extends Component {
	readonly leaf: unknown;
	app: unknown = null;
	containerEl: HTMLElement;

	constructor(leaf: unknown) {
		super();
		requireDom('View');
		this.leaf = leaf;
		this.containerEl = document.createElement('div');
	}
}

export class ItemView extends View {}

export class MarkdownView extends ItemView {
	readonly editor = new Editor();
	/** The open file, set by the fake workspace when `openFile` runs. */
	file: TFile | null = null;
}

/* ========================================================================== */
/* 11. Install on import                                                      */
/* ========================================================================== */

// Auto-install so a test that only sets `// @vitest-environment happy-dom` gets
// working DOM helpers without an extra call. Silently skipped under the default
// `node` environment, where there is nothing to patch.
installDomHelpers();
