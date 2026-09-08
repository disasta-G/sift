/**
 * Hotkey strings for the two curation actions.
 *
 * The overlay binds "keep" and "dismiss" to a combination the user can change,
 * so the module has to turn what someone types in the settings into something
 * `Scope.register` accepts, and back into something a footer hint can show.
 *
 * ---------------------------------------------------------------------------
 * THE STORED FORM
 * ---------------------------------------------------------------------------
 * One string, modifiers first, joined by `+`, e.g. `Mod+Shift+K`. `Mod` is
 * Obsidian's own name for "Ctrl on Windows and Linux, Cmd on macOS" — the same
 * token its Scope takes — so a vault synced between the two platforms keeps one
 * setting instead of two. `Ctrl` is accepted and kept as written for anyone who
 * wants the literal Control key on a Mac as well.
 *
 * Input is read generously: case is ignored, `+`, `-` and spaces all separate,
 * and the usual aliases (`cmd`, `command`, `meta`, `option`, `opt`, `control`)
 * map onto the four names Obsidian knows. What is written back is always the
 * canonical spelling, so `ctrl k` in the box becomes `Mod+K` in `data.json`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REFUSED, AND WHY SO LITTLE
 * ---------------------------------------------------------------------------
 * The overlay's Scope sits above Obsidian's own, so almost any combination is
 * free while the overlay is open — including the ones the app uses elsewhere.
 * Two rules are left:
 *
 *   1. At least one modifier. The search field owns every unmodified key; a
 *      bare `K` would type a K instead of keeping a note.
 *   2. Not a window-level combination. `Mod+W`, `Mod+Q`, `Mod+N`, `Mod+T` and
 *      `Mod+R` are handled by the desktop app or the operating system before
 *      the page sees the event, so binding one would produce a hotkey that
 *      closes the window rather than a hotkey that does nothing — the worse of
 *      the two failures.
 *
 * `Mod+C`, `Mod+V`, `Mod+X`, `Mod+A` and `Mod+Z` are allowed but take the
 * editing gesture away from the query field while the overlay is open. The
 * settings description says so; refusing them would be a judgement the plugin
 * has no business making for a vault whose owner never copies out of the box.
 */

/** The combination "keep this hit" starts out on. */
export const DEFAULT_KEEP_HOTKEY = 'Mod+Shift+K';

/** The combination "dismiss this hit" starts out on. */
export const DEFAULT_DISMISS_HOTKEY = 'Mod+Shift+X';

/** Modifier names as Obsidian's `Scope.register` takes them. */
export type HotkeyModifier = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift';

/** The two settings that hold a combination. Named here, used by both callers. */
export type HotkeySetting = 'keepHotkey' | 'dismissHotkey';

export interface ParsedHotkey {
	/** In canonical order, so two spellings of one combination compare equal. */
	modifiers: HotkeyModifier[];
	/** A single upper-case letter or digit, or a named key such as `F5`. */
	key: string;
}

/** Canonical order of the modifiers in a stored string. */
const MODIFIER_ORDER: readonly HotkeyModifier[] = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];

/** Everything a user might type for each modifier, folded to lower case. */
const MODIFIER_ALIASES: Readonly<Record<string, HotkeyModifier>> = {
	mod: 'Mod',
	cmd: 'Mod',
	command: 'Mod',
	ctrl: 'Mod',
	control: 'Mod',
	strg: 'Mod',
	meta: 'Meta',
	win: 'Meta',
	super: 'Meta',
	alt: 'Alt',
	opt: 'Alt',
	option: 'Alt',
	shift: 'Shift',
	umschalt: 'Shift',
};

/**
 * Keys the desktop app or the platform takes before the page does. Refused with
 * `Mod`, allowed with anything else: `Alt+W` reaches the overlay unharmed.
 */
const WINDOW_LEVEL_KEYS: ReadonlySet<string> = new Set(['W', 'Q', 'N', 'T', 'R']);

/** Symbols shown instead of a modifier's name in a footer hint. */
const MAC_SYMBOLS: Readonly<Record<HotkeyModifier, string>> = {
	Mod: '⌘',
	Ctrl: '⌃',
	Meta: '⌘',
	Alt: '⌥',
	Shift: '⇧',
};

const OTHER_SYMBOLS: Readonly<Record<HotkeyModifier, string>> = {
	Mod: 'Ctrl',
	Ctrl: 'Ctrl',
	Meta: 'Win',
	Alt: 'Alt',
	Shift: '⇧',
};

/**
 * Reads a hotkey string. `null` when it names no usable combination.
 *
 * Rejects rather than repairs: a value that has to be guessed at is one the
 * caller should replace with its default, and silently binding something close
 * to what was typed is how a hotkey ends up doing the wrong thing.
 */
export function parseHotkey(value: unknown): ParsedHotkey | null {
	if (typeof value !== 'string') return null;
	const parts = value
		.split(/[+\-\s]+/u)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length < 2) return null;

	const modifiers = new Set<HotkeyModifier>();
	let key: string | null = null;
	for (const part of parts) {
		const modifier = MODIFIER_ALIASES[part.toLowerCase()];
		if (modifier !== undefined) {
			modifiers.add(modifier);
			continue;
		}
		// Two names for a key would be two keys; the last one does not win.
		if (key !== null) return null;
		key = normalizeKeyName(part);
		if (key === null) return null;
	}
	if (key === null || modifiers.size === 0) return null;

	const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
	if (isWindowLevel(ordered, key)) return null;
	return { modifiers: ordered, key };
}

/** The canonical spelling of `value`, or `null` when it is not a usable hotkey. */
export function canonicalHotkey(value: unknown): string | null {
	const parsed = parseHotkey(value);
	return parsed === null ? null : [...parsed.modifiers, parsed.key].join('+');
}

/**
 * What a footer hint shows: `⌘⇧K` on macOS, `Ctrl ⇧ K` elsewhere.
 *
 * An unreadable value formats as the empty string rather than throwing; the
 * caller has already fallen back to its default binding by then.
 */
export function formatHotkey(value: unknown, mac: boolean): string {
	const parsed = parseHotkey(value);
	if (parsed === null) return '';
	const symbols = mac ? MAC_SYMBOLS : OTHER_SYMBOLS;
	const parts = [...parsed.modifiers.map((modifier) => symbols[modifier]), parsed.key];
	return mac ? parts.join('') : parts.join(' ');
}

/** The parts of a `KeyboardEvent` a combination is read from. */
export interface HotkeyEvent {
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	/** `KeyboardEvent.code`: the physical key, independent of the layout. */
	code: string;
	/** `KeyboardEvent.key`: what the layout makes of it. Only read as a fallback. */
	key: string;
}

/**
 * The combination a key press stands for, or `null` when it is not one that can
 * be bound.
 *
 * `code` before `key`, and this is the whole reason the settings field records a
 * press instead of reading typed text: with Alt held down, macOS turns Option+D
 * into `∂` and a Windows layout can do the same, so `key` no longer names the
 * letter that was struck. `code` says `KeyD` either way.
 *
 * A press of a modifier on its own is not a combination and returns `null`
 * rather than an error - the field goes on waiting for the key that follows.
 */
export function hotkeyFromEvent(evt: HotkeyEvent): string | null {
	const modifiers: HotkeyModifier[] = [];
	// Ctrl and Cmd both become `Mod`, which is what makes one stored value right
	// on macOS and on Windows.
	if (evt.ctrlKey || evt.metaKey) modifiers.push('Mod');
	if (evt.altKey) modifiers.push('Alt');
	if (evt.shiftKey) modifiers.push('Shift');
	const key = keyFromEvent(evt);
	if (key === null || modifiers.length === 0) return null;
	// Through the parser, so a press is refused for exactly the reasons a typed
	// value is - the window-level combinations above.
	return canonicalHotkey([...modifiers, key].join('+'));
}

/** The key a press names, from its physical code where that is unambiguous. */
function keyFromEvent(evt: HotkeyEvent): string | null {
	const letter = /^Key([A-Z])$/u.exec(evt.code);
	if (letter !== null) return letter[1];
	const digit = /^(?:Digit|Numpad)([0-9])$/u.exec(evt.code);
	if (digit !== null) return digit[1];
	if (/^F[1-9]$|^F1[0-2]$/u.test(evt.code)) return evt.code;
	// Anything else - Enter, Home, the punctuation keys - is read from `key`,
	// where `normalizeKeyName` decides whether it is bindable at all.
	return normalizeKeyName(evt.key);
}

/** One key name, upper-cased for letters and digits, `null` when it names no single key. */
function normalizeKeyName(part: string): string | null {
	if (part.length === 1) {
		const upper = part.toUpperCase();
		return /^[A-Z0-9]$/u.test(upper) ? upper : null;
	}
	// A named key: F1-F12 and the handful of editing keys a Scope can bind.
	const named = /^(F[1-9]|F1[0-2]|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown)$/iu.exec(part);
	if (named === null) return null;
	const canonical = named[0];
	return canonical.length <= 3 ? canonical.toUpperCase() : canonical[0].toUpperCase() + canonical.slice(1);
}

/** Whether the combination is one the desktop app or the platform answers first. */
function isWindowLevel(modifiers: readonly HotkeyModifier[], key: string): boolean {
	const primary = modifiers.includes('Mod') || modifiers.includes('Meta') || modifiers.includes('Ctrl');
	return primary && !modifiers.includes('Alt') && WINDOW_LEVEL_KEYS.has(key);
}
