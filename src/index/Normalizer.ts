/**
 * Normalizer — turns raw Markdown into offset-parallel folded text.
 *
 * This is where the offset contract is created and enforced: every
 * transformation is a 1:1 code-unit substitution — a folded character, or
 * U+0020 for anything that must disappear (markdown syntax, link URLs,
 * code-fence markers, HTML tags). Also extracts frontmatter span, heading
 * spans, block breaks, tags, distinct-word list and both folds, and parses the
 * `created` frontmatter value. Pure functions, no Obsidian API, no I/O —
 * trivially unit-testable and reusable by the benchmark script.
 *
 * ---------------------------------------------------------------------------
 * Why this file is allowed to shorten text in exactly one case
 * ---------------------------------------------------------------------------
 * Folding one code unit always produces one code unit, and blanking replaces a
 * code unit with U+0020, so `text.length === raw.length` for every input that
 * carries no combining mark. Source text stored in NFD is the exception: the
 * mark is a code unit of its own and folding genuinely removes it (`u` + U+0308
 * must become `u`, not `u ` — a blank there would split the word in half).
 * `normalizeDocument` therefore scans for combining marks first; only when it
 * finds one does it drop them and allocate {@link NormalizedDoc.offsetMap}.
 *
 * types.ts describes that detection as `raw.normalize('NFC').length !== raw.length`.
 * The scan implemented here is the exact form of the same test: a dropped
 * combining mark is the only way this module can change a document's length, so
 * "a mark was dropped" is precisely "the map is needed" — with no full Unicode
 * normalization pass per file, and with no way for a decomposed sequence that
 * happens to keep its length under NFC (a base letter without a precomposed
 * form) to slip through into the null-map path and break the invariant.
 */

import type {
	FoldMode,
	HeadingSpan,
	NormalizedDoc,
	NormalizedOffset,
	OriginalOffset,
	PackedWords,
	Span,
	SiftSettings,
} from '../types';

/* ========================================================================== */
/* 1. Folding                                                                 */
/* ========================================================================== */

const SPACE = 0x20;

/** Code units below this are answered from the primary table (ASCII, Latin-1, Latin Extended-A/B, IPA, Greek, Cyrillic). */
const PRIMARY_TABLE_END = 0x0800;

/** Latin Extended Additional — Vietnamese and the dotted/underdotted Latin letters. */
const LATIN_ADDITIONAL_START = 0x1e00;
const LATIN_ADDITIONAL_END = 0x1f00;

/**
 * Letters whose canonical decomposition does not expose an ASCII base, so the
 * generic NFD rule below cannot fold them. Keys are the lower-cased source
 * characters; upper-case forms reach these entries through the lower-casing
 * step that runs first.
 *
 * Ligatures are the length trap: `ﬁ` is one code unit and "fi" is two, so a
 * faithful transliteration would break the offset contract. Every ligature is
 * therefore folded to its FIRST letter (`ﬁ` -> `f`, `ﬆ` -> `s`), which keeps
 * the substitution 1:1 and still lets a search for "f" or "s" reach the word.
 * The same rule covers `æ` -> `a`, `œ` -> `o` and `ß` -> `s`; the two-letter
 * German transliterations live in {@link aliasFold}, which never touches stored
 * text.
 */
const SPECIAL_FOLD_PAIRS: Readonly<Record<string, string>> = {
	a: 'æ',
	b: 'ƀƃɓ',
	c: 'ƈɕ',
	d: 'ðđƌǆȡɖɗ',
	f: 'ƒﬀﬁﬂﬃﬄ',
	g: 'ǥȝɠ',
	h: 'ħɦ',
	i: 'ıĳɨ',
	j: 'ȷɟ',
	k: 'ĸƙ',
	l: 'łƚǉȴɫ',
	n: 'ŋƞǌȵɲ',
	o: 'øœ',
	p: 'ƥ',
	s: 'ßſﬅﬆ',
	t: 'þŧƭȶ',
	u: 'ʉ',
	y: 'ƴ',
	z: 'ƶʐ',
};

/** Characters that carry no meaning for search and are folded to a plain space so they act as word boundaries. */
const BLANKED_CHARS: readonly number[] = [
	0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
	0x200b, 0x200c, 0x200d, 0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff,
];

function buildSpecialFoldMap(): Map<number, number> {
	const map = new Map<number, number>();
	for (const target of Object.keys(SPECIAL_FOLD_PAIRS)) {
		const targetCode = target.charCodeAt(0);
		const sources = SPECIAL_FOLD_PAIRS[target];
		for (let i = 0; i < sources.length; i++) {
			map.set(sources.charCodeAt(i), targetCode);
		}
	}
	return map;
}

const SPECIAL_FOLD = buildSpecialFoldMap();

/**
 * Strip fold of one code unit, computed once per code unit at module load.
 *
 * Three steps, in order:
 *   1. lower-case, but only when that stays 1:1 (`İ` U+0130 lower-cases to two
 *      code units, so the original character is kept and step 2 handles it);
 *   2. take the first code unit of the canonical decomposition — for every
 *      precomposed Latin, Greek or Cyrillic letter that is exactly the base
 *      letter, which is the diacritic strip we want, and for everything else it
 *      is the character itself;
 *   3. apply {@link SPECIAL_FOLD} for the letters that do not decompose.
 */
function computeFold(code: number): number {
	if (code < 0x20 || code === 0x7f) return SPACE;
	const char = String.fromCharCode(code);
	const lowered = char.toLowerCase();
	const single = lowered.length === 1 ? lowered : char;
	let base = single.normalize('NFD').charCodeAt(0);
	if (base >= 0x41 && base <= 0x5a) base += 0x20;
	const special = SPECIAL_FOLD.get(base);
	return special === undefined ? base : special;
}

function buildFoldTable(from: number, to: number): Uint16Array {
	const table = new Uint16Array(to - from);
	for (let code = from; code < to; code++) {
		table[code - from] = computeFold(code);
	}
	return table;
}

const PRIMARY_TABLE = buildFoldTable(0, PRIMARY_TABLE_END);
const LATIN_ADDITIONAL_TABLE = buildFoldTable(LATIN_ADDITIONAL_START, LATIN_ADDITIONAL_END);

const EXTRA_FOLD = buildExtraFoldMap();

function buildExtraFoldMap(): Map<number, number> {
	const map = new Map<number, number>();
	for (const [source, target] of SPECIAL_FOLD) {
		if (source >= PRIMARY_TABLE_END && (source < LATIN_ADDITIONAL_START || source >= LATIN_ADDITIONAL_END)) {
			map.set(source, target);
		}
	}
	for (const code of BLANKED_CHARS) {
		if (code >= PRIMARY_TABLE_END) map.set(code, SPACE);
		else PRIMARY_TABLE[code] = SPACE;
	}
	return map;
}

/** Fold one UTF-16 code unit to its strip-fold equivalent. Table-driven, never allocates. Returns the input unchanged when no rule applies. */
export function foldChar(codeUnit: number): number {
	if (codeUnit < PRIMARY_TABLE_END) return PRIMARY_TABLE[codeUnit];
	if (codeUnit >= LATIN_ADDITIONAL_START && codeUnit < LATIN_ADDITIONAL_END) {
		return LATIN_ADDITIONAL_TABLE[codeUnit - LATIN_ADDITIONAL_START];
	}
	const extra = EXTRA_FOLD.get(codeUnit);
	return extra === undefined ? codeUnit : extra;
}

/**
 * German ASCII transliterations. Keyed by the source code unit in both cases,
 * because the expansion replaces the character before any lower-casing runs.
 */
const ALIAS_EXPANSIONS = new Map<number, string>([
	[0x00c4, 'ae'],
	[0x00e4, 'ae'],
	[0x00d6, 'oe'],
	[0x00f6, 'oe'],
	[0x00dc, 'ue'],
	[0x00fc, 'ue'],
	[0x00df, 'ss'],
	[0x1e9e, 'ss'],
	[0x00c6, 'ae'],
	[0x00e6, 'ae'],
	[0x0152, 'oe'],
	[0x0153, 'oe'],
]);

/** Fold a string. `mode` 'strip' is length-preserving (ä->a, ß->s); 'alias' is not (ä->ae, ß->ss) and must never touch stored text. */
export function fold(text: string, mode: FoldMode = 'strip'): string {
	return mode === 'alias' ? aliasFold(text) : stripFold(text);
}

export function stripFold(text: string): string {
	const length = text.length;
	let first = -1;
	for (let i = 0; i < length; i++) {
		if (foldChar(text.charCodeAt(i)) !== text.charCodeAt(i)) {
			first = i;
			break;
		}
	}
	if (first < 0) return text;
	const units = new Uint16Array(length);
	for (let i = 0; i < length; i++) {
		units[i] = foldChar(text.charCodeAt(i));
	}
	return unitsToString(units, length);
}

export function aliasFold(text: string): string {
	let out = '';
	let plainFrom = 0;
	for (let i = 0; i < text.length; i++) {
		const expansion = ALIAS_EXPANSIONS.get(text.charCodeAt(i));
		if (expansion === undefined) continue;
		out += stripFold(text.slice(plainFrom, i)) + expansion;
		plainFrom = i + 1;
	}
	if (plainFrom === 0) return stripFold(text);
	return out + stripFold(text.slice(plainFrom));
}

/**
 * Fold for a stored value that carries no offsets: a tag, a title, a path.
 *
 * These three must fold like the document text, and `stripFold` alone cannot:
 * it is length-preserving by contract, so a combining mark survives it. A note
 * written decomposed therefore ended up with `text` reading `kuche` but its tag
 * reading `ku` + U+0308 + `che`, and since the query side always composes first
 * ({@link termVariants}), no query could ever produce that mark again — the tag,
 * the title and the path were unreachable, silently, for every decomposed note.
 * NFD is not exotic: macOS hands out decomposed file names, and any note synced
 * or exported from one carries decomposed content.
 *
 * Composing first fixes the ordinary case, and dropping whatever mark survives
 * NFC (a base letter with no precomposed form) covers the rest, which is exactly
 * what the document pass does. Nothing here needs the length to be preserved:
 * no offset ever indexes a tag, and title and path offsets index THESE strings,
 * so they stay consistent with themselves.
 */
export function foldFieldValue(text: string): string {
	return stripFold(dropCombiningMarks(text.normalize('NFC')));
}

function dropCombiningMarks(text: string): string {
	let out = '';
	let plainFrom = 0;
	for (let i = 0; i < text.length; i++) {
		if (!isCombiningMark(text.charCodeAt(i))) continue;
		out += text.slice(plainFrom, i);
		plainFrom = i + 1;
	}
	return plainFrom === 0 ? text : out + text.slice(plainFrom);
}

/** Chunked so a long document does not blow the argument limit of `String.fromCharCode`. */
const STRING_CHUNK = 4096;

function unitsToString(units: Uint16Array, length: number): string {
	if (length === 0) return '';
	if (length <= STRING_CHUNK) return String.fromCharCode(...units.subarray(0, length));
	let out = '';
	for (let i = 0; i < length; i += STRING_CHUNK) {
		out += String.fromCharCode(...units.subarray(i, Math.min(i + STRING_CHUNK, length)));
	}
	return out;
}

/**
 * Combining marks that a canonical decomposition of Latin, Greek or Cyrillic
 * text produces. Marks of scripts that are written with them (Hebrew, Arabic,
 * Indic) are deliberately not listed: dropping those would mangle the text
 * rather than fold it.
 */
function isCombiningMark(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x20d0 && code <= 0x20f0) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	);
}

/* ========================================================================== */
/* 2. Words, boundaries, trigrams                                             */
/* ========================================================================== */

function isWordCode(code: number): boolean {
	return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
}

export function extractWords(normalized: string): PackedWords {
	const seen = new Set<string>();
	const length = normalized.length;
	let i = 0;
	while (i < length) {
		if (!isWordCode(normalized.charCodeAt(i))) {
			i++;
			continue;
		}
		const start = i;
		while (i < length && isWordCode(normalized.charCodeAt(i))) i++;
		seen.add(normalized.slice(start, i));
	}
	const count = seen.size;
	const bounds = new Uint32Array(count + 1);
	if (count === 0) return { packed: '', bounds, count: 0 };
	const words = Array.from(seen);
	let offset = 0;
	for (let w = 0; w < count; w++) {
		bounds[w] = offset;
		offset += words[w].length + 1;
	}
	bounds[count] = offset;
	return { packed: words.join('\n'), bounds, count };
}

export function wordAt(words: PackedWords, index: number): string {
	if (index < 0 || index >= words.count) return '';
	return words.packed.slice(words.bounds[index], words.bounds[index + 1] - 1);
}

export function isWordBoundary(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return true;
	return !(isWordCode(text.charCodeAt(offset - 1)) && isWordCode(text.charCodeAt(offset)));
}

/**
 * Every 3-code-unit window of `normalized`, in order, duplicates included.
 * Deliberately unfiltered: the caller decides whether to index windows that
 * cross a word boundary. The Searcher needs those for phrase candidates.
 */
export function trigrams(normalized: string): string[] {
	const out: string[] = [];
	for (let i = 0; i + 3 <= normalized.length; i++) {
		out.push(normalized.slice(i, i + 3));
	}
	return out;
}

export function trigramSet(normalized: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + 3 <= normalized.length; i++) {
		out.add(normalized.slice(i, i + 3));
	}
	return out;
}

/* ========================================================================== */
/* 3. Query-term variants                                                     */
/* ========================================================================== */

/** The alias sequences a query may contain, and what they contract to in stored text. */
const CONTRACTIONS: readonly (readonly [string, string])[] = [
	['ae', 'a'],
	['oe', 'o'],
	['ue', 'u'],
	['ss', 's'],
];

/** Guard against combinatorial explosion on a term full of alias sequences. */
const MAX_CONTRACTION_SITES = 6;

/**
 * Shortest literal a contraction may produce.
 *
 * THE RULE: contracting must not shorten a term below the length at which a
 * term is still meaningful — the same floor the index uses, `minTrigramTermLength`
 * (3, see SiftTuning). Below it a term has no trigram, so it is both the least
 * specific and the most expensive thing Sift can look for: the whole vault has
 * to be scanned and every occurrence becomes a match object.
 *
 * Why it matters: without a floor the two-character query `ss` contracted to the
 * single letter `s` and searched for THAT. On a 10 000-note vault that one
 * variant produced 433 245 of 474 827 match objects (91 %), pushed the query
 * past the 100 ms budget, and returned 735 notes containing no `ss` at all.
 * `ae`, `oe` and `ue` behaved the same way — `ae` matched every note in the
 * vault although not one of them contains the letters.
 *
 * The floor is deliberately kept module-local rather than read from the tuning:
 * this module must stay free of settings imports (it is pure and reusable), and
 * the value follows from the alias rules, not from anything a user should tune.
 * It mirrors `DEFAULT_TUNING.minTrigramTermLength` and must be revisited with it.
 *
 * What survives: every real alias round trip, because those terms are long
 * enough — `strasse` -> `strase` finds `Straße`, `kueche` -> `kuche` finds
 * `Küche`, `gruesse` -> `gruse` finds `Grüße`. What is given up: a word whose
 * stripped form is shorter than three characters is no longer reachable through
 * its alias spelling, so `Öl` is found by `öl` and by `ol`, but no longer by
 * `oel`. That is the accepted cost of not turning a two-letter query into a
 * one-letter vault scan.
 */
const MIN_CONTRACTION_LENGTH = 3;

function contractionSites(text: string): number[] {
	const sites: number[] = [];
	let i = 0;
	while (i + 1 < text.length) {
		let matched = false;
		for (const [sequence] of CONTRACTIONS) {
			if (text.charCodeAt(i) === sequence.charCodeAt(0) && text.charCodeAt(i + 1) === sequence.charCodeAt(1)) {
				sites.push(i);
				matched = true;
				break;
			}
		}
		i += matched ? 2 : 1;
	}
	return sites;
}

function applyContractions(text: string, sites: readonly number[], mask: number): string {
	let out = '';
	let cursor = 0;
	for (let s = 0; s < sites.length; s++) {
		if ((mask & (1 << s)) === 0) continue;
		const at = sites[s];
		out += text.slice(cursor, at) + text.charAt(at);
		cursor = at + 2;
	}
	return out + text.slice(cursor);
}

/**
 * Literal alternatives for one query term: strip fold, alias fold, and
 * contractions of ae|oe|ue|ss that stay at least {@link MIN_CONTRACTION_LENGTH}
 * characters long. Deduplicated, capped.
 */
export function termVariants(raw: string, maxVariants: number): string[] {
	// A query typed on macOS can arrive decomposed; composing first keeps the
	// term comparable with the stored text, which never holds combining marks.
	const source = raw.normalize('NFC');
	const strip = stripFold(source);
	const alias = aliasFold(source);
	const seeds = alias === strip ? [strip] : [strip, alias];
	const cap = Math.max(1, maxVariants);
	const result: string[] = [];

	const add = (value: string): void => {
		if (value.length === 0) return;
		if (result.indexOf(value) < 0) result.push(value);
	};

	/** A seed is always kept; a contraction only above the floor. See {@link MIN_CONTRACTION_LENGTH}. */
	const addContraction = (value: string): void => {
		if (value.length < MIN_CONTRACTION_LENGTH) return;
		add(value);
	};

	// Order matters: the uncontracted and the fully contracted form come first,
	// so they are the two that survive when the cap cuts the list.
	for (const seed of seeds) add(seed);
	const siteMap = new Map<string, number[]>();
	for (const seed of seeds) {
		const sites = contractionSites(seed);
		siteMap.set(seed, sites);
		if (sites.length > 0) addContraction(applyContractions(seed, sites, (1 << sites.length) - 1));
	}
	for (const seed of seeds) {
		const sites = siteMap.get(seed) ?? [];
		if (sites.length === 0 || sites.length > MAX_CONTRACTION_SITES) continue;
		const combinations = 1 << sites.length;
		for (let mask = 1; mask < combinations - 1; mask++) {
			addContraction(applyContractions(seed, sites, mask));
			if (result.length >= cap) break;
		}
		if (result.length >= cap) break;
	}
	return result.slice(0, cap);
}

/* ========================================================================== */
/* 4. Dates                                                                   */
/* ========================================================================== */

const ISO_DATE =
	/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?[ ]?(z|[+-]\d{2}:?\d{2})?)?$/i;
const GERMAN_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const UNIX_SECONDS = /^\d{10}$/;
const UNIX_MILLIS = /^\d{13}$/;

function localMidnight(year: number, month: number, day: number): number | null {
	const date = new Date(year, month - 1, day);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
	return date.getTime();
}

function zoneOffsetMinutes(zone: string): number {
	if (zone.length === 1) return 0;
	const sign = zone.charCodeAt(0) === 0x2d ? -1 : 1;
	const digits = zone.slice(1).replace(':', '');
	return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/** ISO date, YYYY-MM-DD, DD.MM.YYYY or Unix seconds/millis -> epoch millis; null when unparseable. */
export function parseDateValue(value: string): number | null {
	const trimmed = unquote(value.trim());
	if (trimmed.length === 0) return null;

	if (UNIX_MILLIS.test(trimmed)) return Number(trimmed);
	if (UNIX_SECONDS.test(trimmed)) return Number(trimmed) * 1000;

	const german = GERMAN_DATE.exec(trimmed);
	if (german !== null) return localMidnight(Number(german[3]), Number(german[2]), Number(german[1]));

	const iso = ISO_DATE.exec(trimmed);
	if (iso === null) return null;
	const year = Number(iso[1]);
	const month = Number(iso[2]);
	const day = Number(iso[3]);
	if (iso[4] === undefined) return localMidnight(year, month, day);

	const hours = Number(iso[4]);
	const minutes = Number(iso[5]);
	const seconds = iso[6] === undefined ? 0 : Number(iso[6]);
	const millis = iso[7] === undefined ? 0 : Number(iso[7].padEnd(3, '0'));
	if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) return null;

	// No zone means local time; a zone means the instant is absolute.
	if (iso[8] === undefined) {
		const local = new Date(year, month - 1, day, hours, minutes, seconds, millis);
		if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day) return null;
		return local.getTime();
	}
	const utc = Date.UTC(year, month - 1, day, hours, minutes, seconds, millis);
	if (new Date(utc).getUTCDate() !== day) return null;
	return utc - zoneOffsetMinutes(iso[8]) * 60_000;
}

function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value.charCodeAt(0);
		const last = value.charCodeAt(value.length - 1);
		if ((first === 0x22 && last === 0x22) || (first === 0x27 && last === 0x27)) {
			return value.slice(1, -1).trim();
		}
		if (first === 0x5b && last === 0x5d) return value.slice(1, -1).trim();
	}
	return value;
}

/* ========================================================================== */
/* 5. Offset mapping                                                          */
/* ========================================================================== */

/** The ONLY sanctioned way to cross from normalized to original offsets. Identity when `offsetMap` is null. */
export function toOriginalOffset(
	doc: Pick<NormalizedDoc, 'offsetMap' | 'originalLength'>,
	offset: NormalizedOffset,
): OriginalOffset {
	if (offset <= 0) return 0;
	const map = doc.offsetMap;
	if (map === null) return offset > doc.originalLength ? doc.originalLength : offset;
	return offset >= map.length ? doc.originalLength : map[offset];
}

export function toOriginalSpan(doc: Pick<NormalizedDoc, 'offsetMap' | 'originalLength'>, span: Span): Span {
	return { start: toOriginalOffset(doc, span.start), end: toOriginalOffset(doc, span.end) };
}

/* ========================================================================== */
/* 6. Document scan                                                           */
/* ========================================================================== */

const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const CHAR_BANG = 0x21;
const CHAR_HASH = 0x23;
const CHAR_PERCENT = 0x25;
const CHAR_STAR = 0x2a;
const CHAR_PLUS = 0x2b;
const CHAR_DASH = 0x2d;
const CHAR_DOT = 0x2e;
const CHAR_SLASH = 0x2f;
const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;
const CHAR_COLON = 0x3a;
const CHAR_LT = 0x3c;
const CHAR_QUESTION = 0x3f;
const CHAR_EQUALS = 0x3d;
const CHAR_GT = 0x3e;
const CHAR_UPPER_A = 0x41;
const CHAR_UPPER_Z = 0x5a;
const CHAR_OPEN_BRACKET = 0x5b;
const CHAR_BACKSLASH = 0x5c;
const CHAR_CLOSE_BRACKET = 0x5d;
const CHAR_CARET = 0x5e;
const CHAR_UNDERSCORE = 0x5f;
const CHAR_BACKTICK = 0x60;
const CHAR_LOWER_A = 0x61;
const CHAR_LOWER_Z = 0x7a;
const CHAR_PIPE = 0x7c;
const CHAR_TILDE = 0x7e;
const CHAR_OPEN_PAREN = 0x28;
const CHAR_CLOSE_PAREN = 0x29;

const MAX_INLINE_DEPTH = 8;

interface RawHeading {
	level: number;
	span: Span;
	textSpan: Span;
}

interface ScanResult {
	/** 1 marks a code unit that must become U+0020. */
	blank: Uint8Array;
	frontmatter: Span | null;
	headings: RawHeading[];
	/** Start offset of every blank line, in ORIGINAL coordinates, ascending. See {@link NormalizedDoc.blockBreaks}. */
	blockBreaks: number[];
	tags: string[];
	fields: Map<string, string>;
	/** True as soon as one list item carries an unfinished task box. See {@link isOpenTaskMarker}. */
	hasOpenTask: boolean;
}

function isSpaceCode(code: number): boolean {
	return code === CHAR_SPACE || code === CHAR_TAB;
}

function isDigitCode(code: number): boolean {
	return code >= CHAR_ZERO && code <= CHAR_NINE;
}

function isAsciiLetter(code: number): boolean {
	return (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z) || (code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z);
}

/** Tag bodies accept letters, digits, `_`, `-`, `/` and any non-ASCII letter (`#Küche` is a tag). */
function isTagCode(code: number): boolean {
	return (
		isAsciiLetter(code) ||
		isDigitCode(code) ||
		code === CHAR_UNDERSCORE ||
		code === CHAR_DASH ||
		code === CHAR_SLASH ||
		code > 0x7f
	);
}

function computeLineStarts(raw: string): number[] {
	const starts: number[] = [0];
	for (let i = 0; i < raw.length; i++) {
		if (raw.charCodeAt(i) === CHAR_LF) starts.push(i + 1);
	}
	return starts;
}

function matchFence(raw: string, start: number, finish: number): { marker: number; length: number; closing: boolean } | null {
	let i = start;
	let indent = 0;
	while (i < finish && raw.charCodeAt(i) === CHAR_SPACE && indent < 3) {
		i++;
		indent++;
	}
	const marker = i < finish ? raw.charCodeAt(i) : 0;
	if (marker !== CHAR_BACKTICK && marker !== CHAR_TILDE) return null;
	let count = 0;
	while (i < finish && raw.charCodeAt(i) === marker) {
		i++;
		count++;
	}
	if (count < 3) return null;
	let closing = true;
	for (let j = i; j < finish; j++) {
		if (!isSpaceCode(raw.charCodeAt(j))) {
			closing = false;
			break;
		}
	}
	return { marker, length: count, closing };
}

function trimmedSpan(raw: string, start: number, finish: number): Span {
	let from = start;
	let to = finish;
	while (from < to && isSpaceCode(raw.charCodeAt(from))) from++;
	while (to > from && isSpaceCode(raw.charCodeAt(to - 1))) to--;
	return { start: from, end: to };
}

function isBlankRange(raw: string, start: number, finish: number): boolean {
	for (let i = start; i < finish; i++) {
		if (!isSpaceCode(raw.charCodeAt(i))) return false;
	}
	return true;
}

function equalsTrimmed(raw: string, start: number, finish: number, marker: string): boolean {
	const span = trimmedSpan(raw, start, finish);
	if (span.end - span.start !== marker.length) return false;
	for (let i = 0; i < marker.length; i++) {
		if (raw.charCodeAt(span.start + i) !== marker.charCodeAt(i)) return false;
	}
	return true;
}

interface AtxHeading {
	level: number;
	markerStart: number;
	markerEnd: number;
	textStart: number;
	textEnd: number;
	closingStart: number;
}

function matchAtxHeading(raw: string, start: number, finish: number): AtxHeading | null {
	let i = start;
	let indent = 0;
	while (i < finish && raw.charCodeAt(i) === CHAR_SPACE && indent < 3) {
		i++;
		indent++;
	}
	const markerStart = i;
	let level = 0;
	while (i < finish && raw.charCodeAt(i) === CHAR_HASH && level < 7) {
		i++;
		level++;
	}
	if (level === 0 || level > 6) return null;
	if (i < finish && !isSpaceCode(raw.charCodeAt(i))) return null;
	const markerEnd = i;
	const text = trimmedSpan(raw, markerEnd, finish);
	// A closing run of hashes (`## Titel ##`) is decoration, not caption.
	let closingStart = -1;
	let textEnd = text.end;
	let hashes = textEnd;
	while (hashes > text.start && raw.charCodeAt(hashes - 1) === CHAR_HASH) hashes--;
	if (hashes < textEnd && (hashes === text.start || isSpaceCode(raw.charCodeAt(hashes - 1)))) {
		closingStart = hashes;
		textEnd = hashes;
		while (textEnd > text.start && isSpaceCode(raw.charCodeAt(textEnd - 1))) textEnd--;
	}
	return { level, markerStart, markerEnd, textStart: text.start, textEnd, closingStart };
}

/** 1 for `===`, 2 for `---`, 0 when the line is not a setext underline. */
function matchSetext(raw: string, start: number, finish: number): number {
	const span = trimmedSpan(raw, start, finish);
	if (span.end === span.start) return 0;
	const marker = raw.charCodeAt(span.start);
	if (marker !== CHAR_EQUALS && marker !== CHAR_DASH) return 0;
	for (let i = span.start; i < span.end; i++) {
		if (raw.charCodeAt(i) !== marker) return 0;
	}
	return marker === CHAR_EQUALS ? 1 : 2;
}

function isHorizontalRule(raw: string, start: number, finish: number): boolean {
	const span = trimmedSpan(raw, start, finish);
	if (span.end - span.start < 3) return false;
	const marker = raw.charCodeAt(span.start);
	if (marker !== CHAR_DASH && marker !== CHAR_STAR && marker !== CHAR_UNDERSCORE) return false;
	let count = 0;
	for (let i = span.start; i < span.end; i++) {
		const code = raw.charCodeAt(i);
		if (code === marker) count++;
		else if (!isSpaceCode(code)) return false;
	}
	return count >= 3;
}

/** `|---|:--:|` — the row that turns the lines above and below into a table. */
function isTableDelimiter(raw: string, start: number, finish: number): boolean {
	const span = trimmedSpan(raw, start, finish);
	if (span.end === span.start) return false;
	let dashes = 0;
	let structure = 0;
	for (let i = span.start; i < span.end; i++) {
		const code = raw.charCodeAt(i);
		if (code === CHAR_DASH) dashes++;
		else if (code === CHAR_PIPE || code === CHAR_COLON) structure++;
		else if (!isSpaceCode(code)) return false;
	}
	return dashes >= 1 && structure >= 1;
}

/**
 * `[label]: https://x.example "Title"` — a link reference definition renders as
 * nothing at all, so the whole line is markup and the URL must not be
 * searchable. A footnote definition (`[^1]: text`) is deliberately excluded:
 * its text is content.
 */
function isLinkDefinition(raw: string, start: number, finish: number): boolean {
	if (start >= finish || raw.charCodeAt(start) !== CHAR_OPEN_BRACKET) return false;
	if (start + 1 < finish && raw.charCodeAt(start + 1) === CHAR_CARET) return false;
	let close = -1;
	for (let i = start + 1; i < finish; i++) {
		if (raw.charCodeAt(i) === CHAR_CLOSE_BRACKET) {
			close = i;
			break;
		}
	}
	if (close < 0 || close + 1 >= finish || raw.charCodeAt(close + 1) !== CHAR_COLON) return false;
	const rest = trimmedSpan(raw, close + 2, finish);
	if (rest.end === rest.start) return false;
	let i = rest.start;
	while (i < rest.end && !isSpaceCode(raw.charCodeAt(i))) i++;
	if (i >= rest.end) return true;
	// Anything after the destination has to be a title, otherwise this is prose.
	const title = trimmedSpan(raw, i, rest.end);
	const first = raw.charCodeAt(title.start);
	return first === 0x22 || first === 0x27 || first === CHAR_OPEN_PAREN;
}

/** End offset of a leading list marker (`- `, `* `, `+ `, `12. `), or `start` when there is none. */
function matchListMarker(raw: string, start: number, finish: number): number {
	let i = start;
	while (i < finish && isSpaceCode(raw.charCodeAt(i))) i++;
	const first = i < finish ? raw.charCodeAt(i) : 0;
	if (first === CHAR_DASH || first === CHAR_STAR || first === CHAR_PLUS) {
		i++;
	} else if (isDigitCode(first)) {
		let digits = 0;
		while (i < finish && isDigitCode(raw.charCodeAt(i)) && digits < 9) {
			i++;
			digits++;
		}
		const delimiter = i < finish ? raw.charCodeAt(i) : 0;
		if (delimiter !== CHAR_DOT && delimiter !== CHAR_CLOSE_PAREN) return start;
		i++;
	} else {
		return start;
	}
	if (i < finish && !isSpaceCode(raw.charCodeAt(i))) return start;
	while (i < finish && isSpaceCode(raw.charCodeAt(i))) i++;
	return i;
}

/**
 * Whether the list item starting at `start` — already past its `-`/`1.` marker —
 * opens with a task box that is still open.
 *
 * Open is `[ ]`, `[/]` and `[?]`: the empty box and the two in-between states
 * that themes and the Tasks plugin draw as "started" and "question". `[x]`,
 * `[X]` and `[-]` (cancelled) are done in the sense the filter asks about, and
 * so is every other single character — an unknown status is not evidence of
 * work left over, and reading it as open would make the filter answer yes for
 * any vault whose theme invents its own boxes.
 *
 * The box has to be followed by a space or end the line, so `[ ]x` and a wiki
 * link `[[note]]` are not task boxes. Nothing here is blanked: the box is
 * punctuation that the inline scanner already handles, and this pass only reads.
 */
function isOpenTaskMarker(raw: string, start: number, finish: number): boolean {
	if (start + 3 > finish) return false;
	if (raw.charCodeAt(start) !== CHAR_OPEN_BRACKET) return false;
	if (raw.charCodeAt(start + 2) !== CHAR_CLOSE_BRACKET) return false;
	const after = start + 3;
	if (after < finish && !isSpaceCode(raw.charCodeAt(after))) return false;
	const status = raw.charCodeAt(start + 1);
	return status === CHAR_SPACE || status === CHAR_SLASH || status === CHAR_QUESTION;
}

function scanDocument(raw: string, createdKey: string): ScanResult {
	const length = raw.length;
	const blank = new Uint8Array(length);
	const headings: RawHeading[] = [];
	const blockBreaks: number[] = [];
	let hasOpenTask = false;
	const tags: string[] = [];
	const fields = new Map<string, string>();

	const lineStarts = computeLineStarts(raw);
	const lineCount = lineStarts.length;

	const blankRange = (from: number, to: number): void => {
		for (let i = from; i < to; i++) blank[i] = 1;
	};

	const lineEndAt = (index: number): number => {
		let end = index + 1 < lineCount ? lineStarts[index + 1] - 1 : length;
		if (end > lineStarts[index] && raw.charCodeAt(end - 1) === CHAR_CR) end--;
		return end;
	};

	/**
	 * Records one block edge.
	 *
	 * The offset is the START of the blank line, which lands inside the
	 * whitespace run the break produces: the line before it ends with its own
	 * newline, the next block begins after this line. That is precisely the
	 * interval a phrase gap would have to step over, so the Searcher can reject
	 * such a gap with a range test and never has to look at the source again.
	 * The phantom line after a trailing newline starts at `length` and is not
	 * recorded — nothing can be found beyond the end of the text.
	 */
	const noteBlockBreak = (lineStart: number): void => {
		if (lineStart < length) blockBreaks.push(lineStart);
	};

	const addTag = (value: string): void => {
		let text = unquote(value.trim()).trim();
		while (text.length > 0 && text.charCodeAt(0) === CHAR_HASH) text = text.slice(1);
		if (text.length === 0) return;
		// Not `stripFold`: a tag has no offsets, and a decomposed one has to fold
		// the way the document text does. See {@link foldFieldValue}.
		const folded = foldFieldValue(text);
		if (folded.length > 0 && tags.indexOf(folded) < 0) tags.push(folded);
	};

	/* -- frontmatter ---------------------------------------------------- */
	// Only a `---` on line 1 opens frontmatter, and only a later `---` or `...`
	// closes it; without a closing fence the file has none and the dashes are an
	// ordinary rule. The span runs from the first dash of the opening fence to
	// the last character of the closing fence line, both fences included.

	let frontmatter: Span | null = null;
	let firstBodyLine = 0;
	if (lineCount > 1 && equalsTrimmed(raw, lineStarts[0], lineEndAt(0), '---')) {
		for (let i = 1; i < lineCount; i++) {
			const end = lineEndAt(i);
			if (equalsTrimmed(raw, lineStarts[i], end, '---') || equalsTrimmed(raw, lineStarts[i], end, '...')) {
				frontmatter = { start: lineStarts[0], end };
				blankRange(lineStarts[0], lineEndAt(0));
				blankRange(lineStarts[i], end);
				parseFrontmatter(raw, lineStarts, lineEndAt, 1, i, createdKey, fields, addTag);
				firstBodyLine = i + 1;
				break;
			}
		}
	}

	const bodyStart = firstBodyLine < lineCount ? lineStarts[firstBodyLine] : length;

	/* -- HTML comments -------------------------------------------------- */
	// Comments may span lines, so they are blanked before the line scan and the
	// inline scanner below skips anything that is already blank.
	let commentAt = raw.indexOf('<!--', bodyStart);
	while (commentAt >= 0) {
		const close = raw.indexOf('-->', commentAt + 4);
		const end = close < 0 ? length : close + 3;
		blankRange(commentAt, end);
		commentAt = end >= length ? -1 : raw.indexOf('<!--', end);
	}

	/* -- inline scanner -------------------------------------------------- */

	// A line with many openers and no closer would otherwise be scanned once per
	// opener. Both searches remember the range they proved empty, which makes
	// the pathological case linear again. Only a scan that saw no closer at all
	// is remembered, so a nested construct never gets a false negative.
	let noBracketFrom = 0;
	let noBracketTo = -1;
	let noAngleFrom = 0;
	let noAngleTo = -1;

	const findCloseBracket = (from: number, to: number): number => {
		if (to === noBracketTo && from >= noBracketFrom) return -1;
		for (let i = from; i < to; i++) {
			if (raw.charCodeAt(i) === CHAR_CLOSE_BRACKET) return i;
		}
		noBracketFrom = from;
		noBracketTo = to;
		return -1;
	};

	const matchHtmlTag = (at: number, to: number): number => {
		const next = at + 1 < to ? raw.charCodeAt(at + 1) : 0;
		if (!isAsciiLetter(next) && next !== CHAR_SLASH && next !== CHAR_BANG) return -1;
		if (to === noAngleTo && at >= noAngleFrom) return -1;
		for (let i = at + 1; i < to; i++) {
			const code = raw.charCodeAt(i);
			if (code === CHAR_LT) return -1;
			if (code === CHAR_GT) return i + 1;
		}
		noAngleFrom = at;
		noAngleTo = to;
		return -1;
	};

	const matchInlineTag = (at: number, to: number): number => {
		if (at > 0 && blank[at - 1] === 0) {
			const before = raw.charCodeAt(at - 1);
			if (!isSpaceCode(before) && before !== CHAR_LF && before !== CHAR_CR && before !== CHAR_OPEN_PAREN) return -1;
		}
		let i = at + 1;
		let hasLetter = false;
		while (i < to && isTagCode(raw.charCodeAt(i))) {
			if (!isDigitCode(raw.charCodeAt(i))) hasLetter = true;
			i++;
		}
		if (i === at + 1 || !hasLetter) return -1;
		return i;
	};

	const scanInline = (from: number, to: number, depth: number): void => {
		let i = from;
		while (i < to) {
			if (blank[i] === 1) {
				i++;
				continue;
			}
			const code = raw.charCodeAt(i);

			if (code === CHAR_BACKSLASH) {
				// An escape hides the next character's markdown meaning; both are
				// punctuation, so blanking the backslash is enough.
				blank[i] = 1;
				i += 2;
				continue;
			}

			if (code === CHAR_BACKTICK) {
				let run = 1;
				while (i + run < to && raw.charCodeAt(i + run) === CHAR_BACKTICK) run++;
				let close = -1;
				let j = i + run;
				while (j < to) {
					if (raw.charCodeAt(j) === CHAR_BACKTICK) {
						let inner = 1;
						while (j + inner < to && raw.charCodeAt(j + inner) === CHAR_BACKTICK) inner++;
						if (inner === run) {
							close = j;
							break;
						}
						j += inner;
					} else {
						j++;
					}
				}
				blankRange(i, i + run);
				if (close < 0) {
					i += run;
					continue;
				}
				// The code text itself stays searchable; only the ticks go.
				blankRange(close, close + run);
				i = close + run;
				continue;
			}

			if (code === CHAR_LT) {
				const end = matchHtmlTag(i, to);
				if (end > i) {
					blankRange(i, end);
					i = end;
					continue;
				}
				i++;
				continue;
			}

			if (code === CHAR_BANG && i + 1 < to && raw.charCodeAt(i + 1) === CHAR_OPEN_BRACKET) {
				blank[i] = 1;
				i++;
				continue;
			}

			if (code === CHAR_OPEN_BRACKET) {
				i = scanBracket(i, to, depth);
				continue;
			}

			if (
				code === CHAR_STAR ||
				code === CHAR_UNDERSCORE ||
				code === CHAR_TILDE ||
				code === CHAR_EQUALS ||
				code === CHAR_PIPE ||
				code === CHAR_CLOSE_BRACKET ||
				code === CHAR_PERCENT
			) {
				blank[i] = 1;
				i++;
				continue;
			}

			if (code === CHAR_HASH) {
				const end = matchInlineTag(i, to);
				if (end > i) {
					blank[i] = 1;
					addTag(raw.slice(i + 1, end));
					i = end;
					continue;
				}
				i++;
				continue;
			}

			i++;
		}
	};

	const scanBracket = (at: number, to: number, depth: number): number => {
		const next = at + 1 < to ? raw.charCodeAt(at + 1) : 0;
		if (findCloseBracket(at + 1, to) < 0) {
			blank[at] = 1;
			return at + 1;
		}

		// [[wikilink|alias]] and ![[embed]]
		if (next === CHAR_OPEN_BRACKET) {
			let close = -1;
			for (let i = at + 2; i + 1 < to; i++) {
				if (raw.charCodeAt(i) === CHAR_CLOSE_BRACKET && raw.charCodeAt(i + 1) === CHAR_CLOSE_BRACKET) {
					close = i;
					break;
				}
			}
			if (close < 0) {
				blankRange(at, at + 2);
				return at + 2;
			}
			let pipe = -1;
			for (let i = at + 2; i < close; i++) {
				if (raw.charCodeAt(i) === CHAR_PIPE) {
					pipe = i;
					break;
				}
			}
			blankRange(at, at + 2);
			blankRange(close, close + 2);
			// With an alias only the alias is visible; without one the target is.
			if (pipe >= 0) blankRange(at + 2, pipe + 1);
			return close + 2;
		}

		// [^1] footnote marker, and the `[^1]:` of a definition.
		if (next === CHAR_CARET) {
			for (let i = at + 2; i < to; i++) {
				if (raw.charCodeAt(i) === CHAR_CLOSE_BRACKET) {
					const after = i + 1 < to && raw.charCodeAt(i + 1) === CHAR_COLON ? i + 2 : i + 1;
					blankRange(at, after);
					return after;
				}
			}
			blank[at] = 1;
			return at + 1;
		}

		// [text](url), [text][ref], [text]
		let close = -1;
		let nesting = 0;
		for (let i = at + 1; i < to; i++) {
			const code = raw.charCodeAt(i);
			if (code === CHAR_OPEN_BRACKET) nesting++;
			else if (code === CHAR_CLOSE_BRACKET) {
				if (nesting === 0) {
					close = i;
					break;
				}
				nesting--;
			}
		}
		if (close < 0) {
			blank[at] = 1;
			return at + 1;
		}
		blank[at] = 1;
		blank[close] = 1;
		let after = close + 1;
		if (after < to && raw.charCodeAt(after) === CHAR_OPEN_PAREN) {
			let parens = 0;
			for (let i = after; i < to; i++) {
				const code = raw.charCodeAt(i);
				if (code === CHAR_OPEN_PAREN) parens++;
				else if (code === CHAR_CLOSE_PAREN) {
					parens--;
					if (parens === 0) {
						// The URL must not be searchable.
						blankRange(after, i + 1);
						after = i + 1;
						break;
					}
				}
			}
		} else if (after < to && raw.charCodeAt(after) === CHAR_OPEN_BRACKET) {
			for (let i = after + 1; i < to; i++) {
				if (raw.charCodeAt(i) === CHAR_CLOSE_BRACKET) {
					blankRange(after, i + 1);
					after = i + 1;
					break;
				}
			}
		}
		if (depth < MAX_INLINE_DEPTH) scanInline(at + 1, close, depth + 1);
		return after;
	};

	/* -- block scan ------------------------------------------------------ */

	let inFence = false;
	let fenceMarker = 0;
	let fenceLength = 0;
	let paragraphLineStart = -1;
	let paragraphTextSpan: Span | null = null;

	for (let i = firstBodyLine; i < lineCount; i++) {
		const lineStart = lineStarts[i];
		const lineFinish = lineEndAt(i);
		const fence = matchFence(raw, lineStart, lineFinish);

		if (inFence) {
			if (fence !== null && fence.marker === fenceMarker && fence.length >= fenceLength && fence.closing) {
				blankRange(lineStart, lineFinish);
				inFence = false;
			} else if (isBlankRange(raw, lineStart, lineFinish)) {
				// A blank line separates two blocks of code just as it separates
				// two paragraphs; the fence content is searchable, so the phrase
				// rule has to apply to it too.
				noteBlockBreak(lineStart);
			}
			// Code lines keep their text; only the fences are markup.
			paragraphTextSpan = null;
			continue;
		}
		if (fence !== null) {
			blankRange(lineStart, lineFinish);
			inFence = true;
			fenceMarker = fence.marker;
			fenceLength = fence.length;
			paragraphTextSpan = null;
			continue;
		}

		// Block quote markers.
		let contentStart = lineStart;
		for (;;) {
			let probe = contentStart;
			let spaces = 0;
			while (probe < lineFinish && raw.charCodeAt(probe) === CHAR_SPACE && spaces < 3) {
				probe++;
				spaces++;
			}
			if (probe < lineFinish && raw.charCodeAt(probe) === CHAR_GT) {
				blank[probe] = 1;
				contentStart = probe + 1;
				continue;
			}
			break;
		}

		if (isBlankRange(raw, contentStart, lineFinish)) {
			// `contentStart`, not `lineStart`: an empty block-quote line (`>`) ends
			// a paragraph the same way an empty line does.
			noteBlockBreak(lineStart);
			paragraphTextSpan = null;
			continue;
		}

		const atx = matchAtxHeading(raw, contentStart, lineFinish);
		if (atx !== null) {
			blankRange(atx.markerStart, atx.markerEnd);
			if (atx.closingStart >= 0) blankRange(atx.closingStart, lineFinish);
			scanInline(atx.textStart, atx.textEnd, 0);
			headings.push({
				level: atx.level,
				span: { start: lineStart, end: lineFinish },
				textSpan: { start: atx.textStart, end: atx.textEnd },
			});
			paragraphTextSpan = null;
			continue;
		}

		// A setext heading is two lines: the caption above and the underline here.
		// `span` therefore covers both, `textSpan` only the caption — which keeps
		// the "marker included, caption separate" shape of an ATX heading.
		if (paragraphTextSpan !== null) {
			const level = matchSetext(raw, contentStart, lineFinish);
			if (level > 0) {
				blankRange(contentStart, lineFinish);
				headings.push({
					level,
					span: { start: paragraphLineStart, end: lineFinish },
					textSpan: paragraphTextSpan,
				});
				paragraphTextSpan = null;
				continue;
			}
		}

		if (
			isHorizontalRule(raw, contentStart, lineFinish) ||
			isTableDelimiter(raw, contentStart, lineFinish) ||
			isLinkDefinition(raw, contentStart, lineFinish)
		) {
			blankRange(contentStart, lineFinish);
			paragraphTextSpan = null;
			continue;
		}

		const afterMarker = matchListMarker(raw, contentStart, lineFinish);
		const isListItem = afterMarker > contentStart;
		if (isListItem) {
			// Read the task box before the marker is blanked and before the inline
			// scanner runs: after that the brackets are gone from the folded text.
			if (!hasOpenTask && isOpenTaskMarker(raw, afterMarker, lineFinish)) hasOpenTask = true;
			blankRange(contentStart, afterMarker);
			contentStart = afterMarker;
		}

		scanInline(contentStart, lineFinish, 0);
		if (isListItem) {
			paragraphTextSpan = null;
		} else {
			paragraphLineStart = lineStart;
			paragraphTextSpan = trimmedSpan(raw, contentStart, lineFinish);
		}
	}

	return { blank, frontmatter, headings, blockBreaks, tags, fields, hasOpenTask };
}

/* ========================================================================== */
/* 7. Frontmatter                                                             */
/* ========================================================================== */

const TAG_KEYS: readonly string[] = ['tags', 'tag'];

function splitTagList(value: string): string[] {
	const parts: string[] = [];
	let current = '';
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 0x2c || isSpaceCode(code) || code === CHAR_OPEN_BRACKET || code === CHAR_CLOSE_BRACKET) {
			if (current.length > 0) parts.push(current);
			current = '';
			continue;
		}
		current += value.charAt(i);
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

/** Index of the `:` that separates an unindented `key: value` line, or -1. */
function findKeyColon(raw: string, start: number, finish: number): number {
	if (start >= finish) return -1;
	if (isSpaceCode(raw.charCodeAt(start)) || raw.charCodeAt(start) === CHAR_DASH) return -1;
	for (let i = start; i < finish; i++) {
		const code = raw.charCodeAt(i);
		if (code === CHAR_COLON) return i === start ? -1 : i;
		if (code === CHAR_HASH) return -1;
	}
	return -1;
}

function matchYamlListItem(raw: string, start: number, finish: number): number {
	let i = start;
	while (i < finish && isSpaceCode(raw.charCodeAt(i))) i++;
	if (i >= finish || raw.charCodeAt(i) !== CHAR_DASH) return -1;
	i++;
	if (i < finish && !isSpaceCode(raw.charCodeAt(i))) return -1;
	while (i < finish && isSpaceCode(raw.charCodeAt(i))) i++;
	return i;
}

function parseFrontmatter(
	raw: string,
	lineStarts: readonly number[],
	lineEndAt: (index: number) => number,
	fromLine: number,
	toLine: number,
	createdKey: string,
	fields: Map<string, string>,
	addTag: (value: string) => void,
): void {
	let pendingKey = '';
	let pendingItems: string[] = [];

	const store = (key: string, value: string): void => {
		const foldedKey = stripFold(key).trim();
		if (foldedKey.length === 0) return;
		// The created field keeps its original text so a timestamp such as
		// `2026-03-14T10:00:00Z` reaches parseDateValue unfolded.
		fields.set(foldedKey, foldedKey === createdKey ? unquote(value) : stripFold(unquote(value)));
		if (TAG_KEYS.indexOf(foldedKey) >= 0) {
			for (const part of splitTagList(value)) addTag(part);
		}
	};

	const flush = (): void => {
		if (pendingKey !== '' && pendingItems.length > 0) store(pendingKey, pendingItems.join(' '));
		pendingKey = '';
		pendingItems = [];
	};

	for (let i = fromLine; i < toLine; i++) {
		const start = lineStarts[i];
		const finish = lineEndAt(i);
		if (isBlankRange(raw, start, finish)) continue;

		const itemStart = matchYamlListItem(raw, start, finish);
		if (itemStart >= 0 && pendingKey !== '') {
			pendingItems.push(unquote(raw.slice(itemStart, finish).trim()));
			continue;
		}

		const colon = findKeyColon(raw, start, finish);
		if (colon < 0) continue;
		flush();
		const key = raw.slice(start, colon).trim();
		const value = raw.slice(colon + 1, finish).trim();
		if (value.length === 0) {
			pendingKey = key;
			continue;
		}
		store(key, value);
	}
	flush();
}

/* ========================================================================== */
/* 8. Document normalization                                                  */
/* ========================================================================== */

interface FoldedText {
	text: string;
	offsetMap: Uint32Array | null;
	/** Original offset -> normalized offset; `null` when the two are identical. */
	rawToNormalized: Uint32Array | null;
}

function applyFold(raw: string, blank: Uint8Array): FoldedText {
	const length = raw.length;
	let hasCombining = false;
	for (let i = 0; i < length; i++) {
		if (isCombiningMark(raw.charCodeAt(i))) {
			hasCombining = true;
			break;
		}
	}

	const units = new Uint16Array(length);
	if (!hasCombining) {
		for (let i = 0; i < length; i++) {
			units[i] = blank[i] === 1 ? SPACE : foldChar(raw.charCodeAt(i));
		}
		return { text: unitsToString(units, length), offsetMap: null, rawToNormalized: null };
	}

	const offsetMap = new Uint32Array(length + 1);
	const rawToNormalized = new Uint32Array(length + 1);
	let written = 0;
	for (let i = 0; i < length; i++) {
		rawToNormalized[i] = written;
		const code = raw.charCodeAt(i);
		if (isCombiningMark(code)) continue;
		offsetMap[written] = i;
		units[written] = blank[i] === 1 ? SPACE : foldChar(code);
		written++;
	}
	rawToNormalized[length] = written;
	offsetMap[written] = length;
	return {
		text: unitsToString(units, written),
		offsetMap: offsetMap.slice(0, written + 1),
		rawToNormalized,
	};
}

/** Shared empty list, so a note without a single blank line allocates nothing. Never mutated. */
const EMPTY_BLOCK_BREAKS = new Uint32Array(0);

/** Full document pass. Guarantees `result.offsetMap === null` implies `result.text.length === raw.length`. */
export function normalizeDocument(raw: string, settings: Pick<SiftSettings, 'createdField'>): NormalizedDoc {
	const createdField = typeof settings.createdField === 'string' ? settings.createdField : '';
	const createdKey = stripFold(createdField).trim();
	const scan = scanDocument(raw, createdKey);
	const folded = applyFold(raw, scan.blank);
	const map = folded.rawToNormalized;
	const toNormalized = (offset: number): number => (map === null ? offset : map[offset]);
	const mapSpan = (span: Span): Span => ({ start: toNormalized(span.start), end: toNormalized(span.end) });

	const headings: HeadingSpan[] = scan.headings.map((heading) => ({
		level: heading.level,
		span: mapSpan(heading.span),
		textSpan: mapSpan(heading.textSpan),
	}));

	// One shared instance for the common short note without a blank line: the
	// array is never written to, and an empty typed array per file would cost
	// more than the offsets it holds.
	let blockBreaks = EMPTY_BLOCK_BREAKS;
	if (scan.blockBreaks.length > 0) {
		blockBreaks = new Uint32Array(scan.blockBreaks.length);
		for (let i = 0; i < scan.blockBreaks.length; i++) blockBreaks[i] = toNormalized(scan.blockBreaks[i]);
	}

	return {
		text: folded.text,
		originalLength: raw.length,
		offsetMap: folded.offsetMap,
		frontmatterSpan: scan.frontmatter === null ? null : mapSpan(scan.frontmatter),
		headings,
		blockBreaks,
		words: extractWords(folded.text),
		tags: scan.tags,
		frontmatter: Object.fromEntries(scan.fields),
		hasOpenTask: scan.hasOpenTask,
	};
}
