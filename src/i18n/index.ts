/**
 * i18n — translation lookup.
 *
 * Bundles en.json and de.json at build time (no runtime fetch), resolves 'auto'
 * against Obsidian's locale with an en fallback, substitutes {placeholder}
 * tokens, and returns the key itself if a translation is missing so a gap is
 * visible rather than blank. The TranslationKey type is derived from en.json,
 * which makes a typo a compile error.
 *
 * This module deliberately does NOT import 'obsidian'. The caller (main.ts)
 * passes Obsidian's `getLanguage()` result into {@link setLanguage}, which keeps
 * the lookup a pure function of its inputs and keeps the unit test free of the
 * app runtime.
 */

import en from './en.json';
import de from './de.json';
import type { LanguageSetting, LocaleCode, TranslationBundle, TranslationParams } from '../types';

/** Compile-time proof that en.json is a flat `key -> string` bundle. */
type FlatBundle<T extends TranslationBundle> = T;

/** The English bundle is the source of truth for the key set. */
type EnglishBundle = FlatBundle<typeof en>;

/** Narrowed from en.json: a mistyped key fails to compile. */
export type TranslationKey = keyof EnglishBundle;

/** The English bundle, widened to a plain lookup table. */
const ENGLISH: TranslationBundle = en;

/** Every shipped bundle, keyed by locale code. */
const BUNDLES: Readonly<Record<LocaleCode, TranslationBundle>> = {
	en: ENGLISH,
	de,
};

/** `{name}` — the only substitution syntax; a lone brace is left untouched. */
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/** Locale in effect. English until {@link setLanguage} says otherwise. */
let currentLocale: LocaleCode = 'en';

/** BCP-47 tag in effect, at most as specific as the locale that was resolved. */
let currentTag = 'en';

/**
 * Applies the language setting.
 *
 * `'en'` and `'de'` are taken literally. Anything else — `'auto'` included, and
 * any garbage that survived a hand-edited data.json — is resolved from
 * `obsidianLocale`, which the caller reads with Obsidian's `getLanguage()`.
 * Without a locale, and for every language Sift does not ship, the result is
 * English.
 */
export function setLanguage(setting: LanguageSetting, obsidianLocale?: string): void {
	const locale: LocaleCode = setting === 'en' || setting === 'de' ? setting : resolveLocale(obsidianLocale);
	currentLocale = locale;
	currentTag = preferredTag(locale, obsidianLocale);
}

export function getLocale(): LocaleCode {
	return currentLocale;
}

/** Returns the translation, or the English string, or the key itself. Never throws, never returns undefined. */
export function t(key: TranslationKey, params?: TranslationParams): string {
	const template = lookup(key);
	return params === undefined ? template : substitute(template, params);
}

export function hasKey(key: string): key is TranslationKey {
	return typeof ENGLISH[key] === 'string';
}

/** BCP-47 tag for Intl formatting, e.g. 'de-CH' or 'en'. */
export function dateFormatLocale(): string {
	return currentTag;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Active bundle, then English, then the key itself. An empty value counts as missing. */
function lookup(key: TranslationKey): string {
	const active = BUNDLES[currentLocale][key];
	if (typeof active === 'string' && active.length > 0) {
		return active;
	}
	const fallback = ENGLISH[key];
	if (typeof fallback === 'string' && fallback.length > 0) {
		return fallback;
	}
	return key;
}

/** Replaces every `{name}` for which a value was passed; leaves the rest visible. */
function substitute(template: string, params: TranslationParams): string {
	return template.replace(PLACEHOLDER, (token: string, name: string): string => {
		const value = params[name];
		return value === undefined ? token : String(value);
	});
}

/** German for `de` and every regional variant of it, English for everything else. */
function resolveLocale(tag: string | undefined): LocaleCode {
	return primarySubtag(tag) === 'de' ? 'de' : 'en';
}

/**
 * Keeps the region when it belongs to the resolved language, so a Swiss user
 * gets `de-CH` date formats while a user who forced English gets plain `en`.
 */
function preferredTag(locale: LocaleCode, obsidianLocale: string | undefined): string {
	const normalized = normalizeTag(obsidianLocale);
	if (normalized.length > 0 && primarySubtag(normalized) === locale) {
		return normalized;
	}
	return locale;
}

/** Lowercased language subtag of a BCP-47 tag; `''` when there is none. */
function primarySubtag(tag: string | undefined): string {
	if (typeof tag !== 'string') {
		return '';
	}
	return tag.trim().toLowerCase().split(/[-_]/)[0];
}

/** `de_ch` / `DE-ch` -> `de-CH`. Returns `''` for anything unusable. */
function normalizeTag(tag: string | undefined): string {
	if (typeof tag !== 'string') {
		return '';
	}
	const parts = tag.trim().split(/[-_]/).filter((part) => part.length > 0);
	if (parts.length === 0) {
		return '';
	}
	const canonical = [parts[0].toLowerCase()];
	for (const part of parts.slice(1)) {
		if (part.length === 2) {
			canonical.push(part.toUpperCase());
		} else if (part.length === 4) {
			canonical.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
		} else {
			canonical.push(part.toLowerCase());
		}
	}
	return canonical.join('-');
}
