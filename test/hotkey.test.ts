import { describe, expect, it } from 'vitest';

import {
	DEFAULT_DISMISS_HOTKEY,
	DEFAULT_KEEP_HOTKEY,
	canonicalHotkey,
	formatHotkey,
	parseHotkey,
} from '../src/hotkey';

/**
 * The two curation combinations are user-editable, so what someone types in the
 * settings has to survive the trip into `Scope.register` and back into a footer
 * hint. This suite pins the three questions that matters for: what is accepted,
 * what one value looks like once stored, and what a hint shows.
 */

describe('parseHotkey', () => {
	it('reads the defaults this plugin ships', () => {
		expect(parseHotkey(DEFAULT_KEEP_HOTKEY)).toEqual({ modifiers: ['Mod', 'Shift'], key: 'K' });
		expect(parseHotkey(DEFAULT_DISMISS_HOTKEY)).toEqual({ modifiers: ['Mod', 'Shift'], key: 'X' });
	});

	it('reads what a user is likely to type', () => {
		// Case, separator and modifier name are all read generously; what comes
		// back is one canonical shape, so two spellings compare equal.
		for (const typed of ['ctrl+k', 'Ctrl K', 'STRG-k', 'cmd+K', 'command + k']) {
			expect(parseHotkey(typed), typed).toEqual({ modifiers: ['Mod'], key: 'K' });
		}
		expect(parseHotkey('alt+shift+7')).toEqual({ modifiers: ['Alt', 'Shift'], key: '7' });
		expect(parseHotkey('ctrl+F5')).toEqual({ modifiers: ['Mod'], key: 'F5' });
		expect(parseHotkey('alt+PageDown')).toEqual({ modifiers: ['Alt'], key: 'PageDown' });
	});

	it('orders the modifiers, however they were typed', () => {
		expect(canonicalHotkey('shift+alt+ctrl+p')).toBe('Mod+Alt+Shift+P');
	});

	it('refuses a combination without a modifier', () => {
		// The query field owns every unmodified key: a bare K would type a K.
		expect(parseHotkey('K')).toBeNull();
		expect(parseHotkey('Enter')).toBeNull();
	});

	it('refuses what the desktop app answers before the page does', () => {
		// Binding one of these would close the window rather than do nothing,
		// which is the worse of the two failures.
		for (const typed of ['Mod+W', 'ctrl+q', 'cmd+n', 'Mod+Shift+T', 'ctrl+r']) {
			expect(parseHotkey(typed), typed).toBeNull();
		}
		// With Alt in front they never reach the window manager.
		expect(parseHotkey('Mod+Alt+W')).toEqual({ modifiers: ['Mod', 'Alt'], key: 'W' });
	});

	it('refuses nonsense rather than repairing it', () => {
		expect(parseHotkey('')).toBeNull();
		expect(parseHotkey('Mod+')).toBeNull();
		expect(parseHotkey('Mod+K+L')).toBeNull();
		expect(parseHotkey('Mod+ä')).toBeNull();
		expect(parseHotkey(null)).toBeNull();
		expect(parseHotkey(42)).toBeNull();
		expect(canonicalHotkey('Mod+Shift+')).toBeNull();
	});
});

describe('formatHotkey', () => {
	it('writes the spelling of the platform it runs on', () => {
		expect(formatHotkey('Mod+Shift+K', false)).toBe('Ctrl ⇧ K');
		expect(formatHotkey('Mod+Shift+K', true)).toBe('⌘⇧K');
		expect(formatHotkey('Alt+P', false)).toBe('Alt P');
	});

	it('formats an unusable value as nothing, rather than throwing', () => {
		// The caller has already fallen back to its default binding by then; a
		// hint that says nothing beats a hint that says "undefined".
		expect(formatHotkey('nonsense', false)).toBe('');
	});
});
