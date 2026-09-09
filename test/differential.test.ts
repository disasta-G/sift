/**
 * Differential test — the real engine against an independent brute-force reference.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other suite in `test/` was written by the same hand as the module it
 * covers, so it can only find bugs its author thought of. This file breaks that
 * symmetry: the reference searcher below was written from the plain-language
 * specification (docs/plan.md section 3.1, the module brief and the offset
 * contract in src/types.ts) WITHOUT reading src/search/Searcher.ts,
 * src/search/QueryParser.ts or src/index/Normalizer.ts. It reads the fixture
 * notes off disk, folds them with its own inline routine and finds matches with
 * `indexOf`. It is slow, allocation-happy and obviously correct, which is the
 * whole point.
 *
 * Only the SET of matching paths is compared. Offsets, ordering and scoring are
 * other suites' business; a disagreement here means the two implementations
 * disagree about what a query MEANS.
 *
 * RESULT AS OF THIS WRITING
 * -------------------------
 * 117 unfiltered queries, 17 filtered ones, 3 created-date ranges and 10
 * ranking cases agree. The one disagreement this file found — text written in
 * decomposed form (NFD) being unreachable through `tag:`, `title:` and `path:` —
 * is fixed in all three: every one of those fields now folds through
 * `foldFieldValue`, which composes and drops the combining mark the way the
 * document pass does, in `Normalizer.addTag` and in the Indexer's `toRecord` and
 * `relocate`. Section 8 keeps both halves as regressions.
 *
 * THE VAULT
 * ---------
 * `loadVault(dir, 400)` takes the first 400 notes of the generated vault. The
 * generator emits notes deterministically, so those 400 are byte-for-byte the
 * ones `tsx test/fixtures/generate.ts --count 400` writes — verified by diffing
 * both vaults, content and stamped times included. That keeps a large vault
 * usable for the benchmark without regenerating it for this test.
 *
 * DOCUMENTED DECISIONS ENCODED IN THE REFERENCE
 * ---------------------------------------------
 *  1. Substring semantics: a term matches wherever its folded form occurs, word
 *     boundaries irrelevant (plan 3.1: "Teilwort exakt", trigram infix search).
 *  2. Fold table: strip fold, length-irrelevant here — ä→a, ö→o, ü→u, ß→s,
 *     é→e, æ→a; combining marks dropped, which is what the offset-map path in
 *     the Normalizer does for the NFD notes (src/types.ts, offset contract).
 *  3. Alias handling: a term is searched as its strip fold, its alias fold
 *     (ä→ae, ß→ss) and every contraction of ae|oe|ue|ss back to a|o|u|s
 *     (src/types.ts, QueryTerm.variants), except a contraction that would fall
 *     below `minTrigramTermLength` — `ss` is not searched as `s`.
 *  4. Markdown blanking: link URLs and markdown syntax are replaced by spaces,
 *     visible label text and wiki-link targets survive (module brief,
 *     Normalizer RESPONSIBILITY).
 *  5. An unrestricted term also matches the title and the path, which is what
 *     the title 3.0 / path 1.0 field weights imply.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import 'fake-indexeddb/auto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Indexer } from '../src/index/Indexer';
import { Store } from '../src/index/Store';
import { parseQuery } from '../src/search/QueryParser';
import { Ranker } from '../src/search/Ranker';
import { Searcher } from '../src/search/Searcher';
import { DEFAULT_SETTINGS, DEFAULT_TUNING } from '../src/settings';
import type { RawHit, SearchFilters, SearchOptions, SiftSettings } from '../src/types';
import { createFakeApp, type FakeFileSpec } from './helpers/fakeVault';
import { loadVault, type LoadedVault } from './fixtures/loadVault';

/* ========================================================================== */
/* 0. Harness                                                                 */
/* ========================================================================== */

/** The slice of `window` the Indexer's scheduler touches; node has none. */
interface SchedulerWindow {
	setTimeout(handler: () => void, timeout?: number): number;
	clearTimeout(handle: number): void;
}

const globalScope = globalThis as unknown as { window?: SchedulerWindow };
if (globalScope.window === undefined) {
	globalScope.window = {
		setTimeout: (handler: () => void, timeout?: number): number => setTimeout(handler, timeout) as unknown as number,
		clearTimeout: (handle: number): void => {
			clearTimeout(handle as unknown as Parameters<typeof clearTimeout>[0]);
		},
	};
}

const NOTE_COUNT = 400;

/* ========================================================================== */
/* 1. Reference folding                                                       */
/* ========================================================================== */

/**
 * Characters whose fold cannot be derived from Unicode decomposition.
 * `ß→s` and `æ→a` come straight from the FoldMode doc in src/types.ts; the
 * ligature `ﬁ→f` is the documented length-preserving compromise.
 */
const SPECIAL_FOLD: Readonly<Record<string, string>> = {
	ß: 's',
	æ: 'a',
	œ: 'o',
	ø: 'o',
	đ: 'd',
	ð: 'd',
	þ: 't',
	ł: 'l',
	'ﬁ': 'f',
	'ﬂ': 'f',
};

/** Strip fold: lower case, diacritics dropped, the specials above applied. */
function refStripFold(text: string): string {
	let out = '';
	for (const character of text.normalize('NFC').toLowerCase()) {
		const special = SPECIAL_FOLD[character];
		if (special !== undefined) {
			out += special;
			continue;
		}
		const bare = character.normalize('NFD').replace(/[̀-ͯ]/gu, '');
		out += bare;
	}
	return out;
}

/** Alias fold: the German transliteration first, then the strip fold for the rest. */
function refAliasFold(text: string): string {
	const transliterated = text
		.normalize('NFC')
		.replace(/Ä/gu, 'Ae')
		.replace(/Ö/gu, 'Oe')
		.replace(/Ü/gu, 'Ue')
		.replace(/ä/gu, 'ae')
		.replace(/ö/gu, 'oe')
		.replace(/ü/gu, 'ue')
		.replace(/ß/gu, 'ss');
	return refStripFold(transliterated);
}

/** Every way of contracting `ae|oe|ue|ss` back to `a|o|u|s`, uncontracted form first. */
function refContractions(word: string): string[] {
	const sites: number[] = [];
	for (let i = 0; i < word.length - 1; i++) {
		const pair = word.slice(i, i + 2);
		if (pair === 'ae' || pair === 'oe' || pair === 'ue' || pair === 'ss') sites.push(i);
	}
	if (sites.length === 0) return [word];
	const out: string[] = [];
	for (let mask = 0; mask < 1 << sites.length; mask++) {
		let built = '';
		let cursor = 0;
		for (let s = 0; s < sites.length; s++) {
			const at = sites[s];
			if (at < cursor) continue; // overlapping site already consumed
			built += word.slice(cursor, at);
			if ((mask & (1 << s)) === 0) {
				built += word.slice(at, at + 2);
			} else {
				built += word[at];
			}
			cursor = at + 2;
		}
		built += word.slice(cursor);
		out.push(built);
	}
	return out;
}

/**
 * Literal alternatives one query term is searched as.
 * Strip fold first (it is the primary literal), then the alias fold, then every
 * contraction of both. Deduplicated, capped like `SiftTuning.maxTermVariants`
 * with the fully contracted form kept, per src/types.ts.
 */
function refVariants(raw: string): string[] {
	const strip = refStripFold(raw);
	const alias = refAliasFold(raw);
	const ordered: string[] = [];
	const seen = new Set<string>();
	const push = (value: string): void => {
		if (value.length > 0 && !seen.has(value)) {
			seen.add(value);
			ordered.push(value);
		}
	};
	/**
	 * A contraction never shortens a term below `minTrigramTermLength`, the
	 * length at which a term stops being meaningful and starts costing a full
	 * vault scan (src/types.ts, SiftTuning; Normalizer.MIN_CONTRACTION_LENGTH).
	 * Without the floor `ss` was searched as the single letter `s`. The seeds
	 * themselves — what the user typed — are never subject to it.
	 */
	const pushContraction = (value: string): void => {
		if (value.length >= DEFAULT_TUNING.minTrigramTermLength) push(value);
	};
	push(strip);
	push(alias);
	for (const candidate of refContractions(strip)) pushContraction(candidate);
	for (const candidate of refContractions(alias)) pushContraction(candidate);
	if (ordered.length <= DEFAULT_TUNING.maxTermVariants) return ordered;
	const fullyContracted = ordered[ordered.length - 1];
	const capped = ordered.slice(0, DEFAULT_TUNING.maxTermVariants - 1);
	if (!capped.includes(fullyContracted)) capped.push(fullyContracted);
	return capped;
}

/* ========================================================================== */
/* 2. Reference document model                                                */
/* ========================================================================== */

/** Replaces `[start, end)` of `text` with spaces — blanking, never deleting. */
function blank(chars: string[], start: number, end: number): void {
	for (let i = start; i < end && i < chars.length; i++) chars[i] = ' ';
}

/**
 * Markdown blanking, straightforward and line-based.
 *
 * Kept: visible link labels, wiki-link targets, headings, list text, table
 * cells, code-fence CONTENT, frontmatter keys and values.
 * Blanked: link URLs, autolinks, HTML tags, fence marker lines, the syntax
 * characters themselves. Every removal is a same-length run of spaces, so a
 * phrase can never match across blanked-out markup.
 */
function refBlankMarkdown(raw: string): string {
	// `split('')`, not `[...raw]`: RegExp indices are UTF-16 code-unit offsets,
	// and the fixture contains emoji, so code-point iteration would drift.
	const chars = raw.split('');
	const text = raw;

	// `[label](url)` — keep the label, blank the brackets and the whole target.
	for (const match of text.matchAll(/\[([^\]\n]*)\]\(([^)\n]*)\)/gu)) {
		const at = match.index ?? 0;
		blank(chars, at, at + 1);
		const labelEnd = at + 1 + match[1].length;
		blank(chars, labelEnd, at + match[0].length);
	}
	// `<https://…>` autolinks and HTML tags.
	for (const match of text.matchAll(/<[^<>\n]*>/gu)) {
		const at = match.index ?? 0;
		blank(chars, at, at + match[0].length);
	}
	// `[[target]]`, `![[embed]]` — the target stays searchable, per the
	// Normalizer's documented decision; only the brackets go.
	for (const match of text.matchAll(/!?\[\[([^\]\n]*)\]\]/gu)) {
		const at = match.index ?? 0;
		const open = match[0].startsWith('!') ? 3 : 2;
		blank(chars, at, at + open);
		blank(chars, at + match[0].length - 2, at + match[0].length);
	}

	// Line-level syntax.
	let lineStart = 0;
	let inFence = false;
	while (lineStart <= text.length) {
		let lineEnd = text.indexOf('\n', lineStart);
		if (lineEnd === -1) lineEnd = text.length;
		const line = text.slice(lineStart, lineEnd);
		const fence = /^\s*(```|~~~)/u.exec(line);
		if (fence !== null) {
			blank(chars, lineStart, lineEnd); // the marker line, language tag included
			inFence = !inFence;
		} else if (!inFence) {
			const heading = /^(#{1,6})\s/u.exec(line);
			const bullet = /^\s*([-*+]|\d+\.)\s(\[[ xX]\]\s)?/u.exec(line);
			const quote = /^\s*>\s?/u.exec(line);
			const rule = /^\s*(---+|\*\*\*+|===+)\s*$/u.exec(line);
			if (rule !== null) {
				blank(chars, lineStart, lineEnd);
			} else if (heading !== null) {
				blank(chars, lineStart, lineStart + heading[1].length);
			} else if (quote !== null) {
				blank(chars, lineStart, lineStart + quote[0].length);
			} else if (bullet !== null) {
				blank(chars, lineStart, lineStart + bullet[0].length);
			}
			// Table pipes, emphasis markers and inline code ticks.
			for (let i = lineStart; i < lineEnd; i++) {
				const character = chars[i];
				if (character === '|' || character === '`' || character === '*' || character === '_') chars[i] = ' ';
			}
			// A `#tag` loses its hash, the tag text stays.
			for (const match of line.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
				const at = lineStart + (match.index ?? 0) + match[1].length;
				blank(chars, at, at + 1);
			}
		}
		lineStart = lineEnd + 1;
	}

	// Whitespace collapses to plain spaces, so a phrase matches across a line
	// break exactly the way the engine's normalized text allows.
	return chars.join('').replace(/\s/gu, ' ');
}

/** One fixture note, as the reference sees it. */
interface RefNote {
	path: string;
	folder: string;
	title: string;
	/** Folded, markdown-blanked body text. */
	text: string;
	titleFolded: string;
	pathFolded: string;
	tags: string[];
	createdAt: number;
	/** Second reading of `createdAt` when a bare date could be UTC or local midnight. */
	createdAtAlt: number;
	modifiedAt: number;
}

/** Frontmatter `tags:` plus inline `#tag`, folded and without the hash. */
function refTags(raw: string): string[] {
	const tags = new Set<string>();
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw);
	if (frontmatter !== null) {
		const line = /^tags:\s*\[([^\]]*)\]/mu.exec(frontmatter[1]);
		if (line !== null) {
			for (const entry of line[1].split(',')) {
				const trimmed = entry.trim();
				if (trimmed.length > 0) tags.add(refStripFold(trimmed));
			}
		}
	}
	for (const match of raw.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(refStripFold(match[2]));
	return [...tags];
}

/** `created:` per the four notations the fixture writes, plus the ctime fallback. */
function refCreated(raw: string, ctime: number): { primary: number; alternate: number } {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw);
	const line = frontmatter === null ? null : /^created:\s*(.+)$/mu.exec(frontmatter[1]);
	if (line === null) return { primary: ctime, alternate: ctime };
	const value = line[1].trim().replace(/^"|"$/gu, '');
	const iso = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(value);
	if (iso !== null) {
		const at = Date.parse(value);
		return { primary: at, alternate: at };
	}
	const bare = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (bare !== null) {
		const [, y, m, d] = bare;
		return {
			primary: Date.UTC(Number(y), Number(m) - 1, Number(d)),
			alternate: new Date(Number(y), Number(m) - 1, Number(d)).getTime(),
		};
	}
	const german = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value);
	if (german !== null) {
		const [, d, m, y] = german;
		return {
			primary: Date.UTC(Number(y), Number(m) - 1, Number(d)),
			alternate: new Date(Number(y), Number(m) - 1, Number(d)).getTime(),
		};
	}
	const numeric = /^\d+$/u.exec(value);
	if (numeric !== null) {
		const asNumber = Number(value);
		const at = value.length <= 11 ? asNumber * 1000 : asNumber;
		return { primary: at, alternate: at };
	}
	return { primary: ctime, alternate: ctime };
}

function buildRefNotes(vault: LoadedVault): RefNote[] {
	const notes: RefNote[] = [];
	for (const [path, spec] of Object.entries(vault.files)) {
		const slash = path.lastIndexOf('/');
		const folder = slash === -1 ? '' : path.slice(0, slash);
		const title = path.slice(slash + 1).replace(/\.md$/u, '');
		const created = refCreated(spec.content, spec.ctime ?? 0);
		notes.push({
			path,
			folder,
			title,
			text: refStripFold(refBlankMarkdown(spec.content)),
			titleFolded: refStripFold(title),
			pathFolded: refStripFold(path),
			tags: refTags(spec.content),
			createdAt: created.primary,
			createdAtAlt: created.alternate,
			modifiedAt: spec.mtime ?? spec.ctime ?? 0,
		});
	}
	return notes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/* ========================================================================== */
/* 3. Reference query language                                                */
/* ========================================================================== */

type RefField = 'any' | 'path' | 'tag' | 'title';

interface RefTerm {
	field: RefField;
	variants: string[];
}

interface RefQuery {
	must: RefTerm[];
	mustNot: RefTerm[];
	should: RefTerm[][];
}

const REF_FIELDS: ReadonlySet<string> = new Set(['path', 'tag', 'title']);

/** Splits a query into tokens, keeping a quoted phrase as one token. */
function refTokenize(raw: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let quoted = false;
	for (const character of raw) {
		if (character === '"') {
			quoted = !quoted;
			current += character;
			continue;
		}
		if (character === ' ' && !quoted) {
			if (current.length > 0) tokens.push(current);
			current = '';
			continue;
		}
		current += character;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

/** `-`, `field:` prefix and quotes stripped; the rest becomes the literal. */
function refBuildTerm(token: string): { term: RefTerm; negated: boolean } {
	let rest = token;
	let negated = false;
	if (rest.startsWith('-')) {
		negated = true;
		rest = rest.slice(1);
	}
	let field: RefField = 'any';
	const colon = rest.indexOf(':');
	if (colon > 0 && !rest.startsWith('"')) {
		const candidate = rest.slice(0, colon).toLowerCase();
		if (REF_FIELDS.has(candidate)) {
			field = candidate as RefField;
			rest = rest.slice(colon + 1);
		}
	}
	rest = rest.replace(/"/gu, '');
	return { term: { field, variants: refVariants(rest) }, negated };
}

/** Space = AND, `OR` binds tighter, `-` negates. Same grammar, written twice. */
function refParse(raw: string): RefQuery {
	const tokens = refTokenize(raw.trim());
	const query: RefQuery = { must: [], mustNot: [], should: [] };
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === 'OR') {
			index++;
			continue;
		}
		const { term, negated } = refBuildTerm(token);
		// Look ahead for `OR` chains.
		const group: RefTerm[] = [term];
		let cursor = index + 1;
		while (cursor + 1 < tokens.length && tokens[cursor] === 'OR') {
			group.push(refBuildTerm(tokens[cursor + 1]).term);
			cursor += 2;
		}
		if (group.length > 1) query.should.push(group);
		else if (negated) query.mustNot.push(term);
		else query.must.push(term);
		index = cursor;
	}
	return query;
}

/* ========================================================================== */
/* 4. Reference matching                                                      */
/* ========================================================================== */

function refTermMatches(note: RefNote, term: RefTerm): boolean {
	for (const variant of term.variants) {
		if (variant.length === 0) continue;
		switch (term.field) {
			case 'any':
				if (note.text.includes(variant) || note.titleFolded.includes(variant) || note.pathFolded.includes(variant)) {
					return true;
				}
				break;
			case 'title':
				if (note.titleFolded.includes(variant)) return true;
				break;
			case 'path':
				if (note.pathFolded.includes(variant)) return true;
				break;
			case 'tag':
				if (note.tags.some((tag) => tag.includes(variant))) return true;
				break;
		}
	}
	return false;
}

function refPassesFilters(note: RefNote, filters: SearchFilters): boolean {
	for (const excluded of filters.excludedFolders) {
		if (note.folder === excluded || note.folder.startsWith(`${excluded}/`)) return false;
	}
	if (filters.folder !== null) {
		const inside = filters.includeSubfolders
			? note.folder === filters.folder || note.folder.startsWith(`${filters.folder}/`)
			: note.folder === filters.folder;
		if (!inside) return false;
	}
	if (filters.createdFrom !== null && note.createdAt < filters.createdFrom) return false;
	if (filters.createdTo !== null && note.createdAt > filters.createdTo) return false;
	if (filters.modifiedFrom !== null && note.modifiedAt < filters.modifiedFrom) return false;
	if (filters.modifiedTo !== null && note.modifiedAt > filters.modifiedTo) return false;
	return true;
}

function refSearch(notes: readonly RefNote[], raw: string, filters: SearchFilters): string[] {
	const query = refParse(raw);
	if (query.must.length === 0 && query.should.length === 0) return [];
	const hits: string[] = [];
	for (const note of notes) {
		if (!refPassesFilters(note, filters)) continue;
		if (!query.must.every((term) => refTermMatches(note, term))) continue;
		if (query.mustNot.some((term) => refTermMatches(note, term))) continue;
		if (!query.should.every((group) => group.some((term) => refTermMatches(note, term)))) continue;
		hits.push(note.path);
	}
	return hits.sort();
}

/* ========================================================================== */
/* 5. Engine harness                                                          */
/* ========================================================================== */

function noFilters(): SearchFilters {
	return {
		folder: null,
		includeSubfolders: true,
		createdFrom: null,
		createdTo: null,
		modifiedFrom: null,
		modifiedTo: null,
		property: null,
		openTasks: false,
		note: null,
		excludedFolders: [],
	};
}

let searcher: Searcher;
let refNotes: RefNote[];
let loaded: LoadedVault;

function engineSearch(raw: string, filters: SearchFilters, fuzzy = false): RawHit[] {
	const options: SearchOptions = { filters, fuzzy, limit: 100_000 };
	return searcher.search(parseQuery(raw, DEFAULT_TUNING), options);
}

function enginePaths(raw: string, filters: SearchFilters = noFilters(), fuzzy = false): string[] {
	return engineSearch(raw, filters, fuzzy)
		.map((hit) => hit.path)
		.sort();
}

/** Symmetric difference, formatted small enough to read in a failure message. */
function describeDifference(query: string, engine: readonly string[], reference: readonly string[]): string {
	const engineSet = new Set(engine);
	const referenceSet = new Set(reference);
	const onlyEngine = engine.filter((path) => !referenceSet.has(path));
	const onlyReference = reference.filter((path) => !engineSet.has(path));
	return [
		`query: ${query}`,
		`  engine ${engine.length} hits, reference ${reference.length} hits`,
		`  only engine (${onlyEngine.length}): ${onlyEngine.slice(0, 5).join(' | ')}`,
		`  only reference (${onlyReference.length}): ${onlyReference.slice(0, 5).join(' | ')}`,
	].join('\n');
}

beforeAll(async () => {
	loaded = loadVault(undefined, NOTE_COUNT);
	refNotes = buildRefNotes(loaded);
	const app = createFakeApp(loaded.files);
	const settings: SiftSettings = { ...DEFAULT_SETTINGS };
	const store = new Store(`differential-${Date.now()}`);
	const indexer = new Indexer(app.asApp(), store, settings, DEFAULT_TUNING);
	await indexer.start();
	searcher = new Searcher(indexer, DEFAULT_TUNING);
}, 120_000);

/** A second engine over a hand-written mini vault, for the cases the fixture cannot express. */
async function buildEngine(files: Record<string, FakeFileSpec>): Promise<{ searcher: Searcher; indexer: Indexer }> {
	engineCounter += 1;
	const app = createFakeApp(files);
	const store = new Store(`differential-mini-${engineCounter}-${Date.now()}`);
	const indexer = new Indexer(app.asApp(), store, { ...DEFAULT_SETTINGS }, DEFAULT_TUNING);
	await indexer.start();
	return { searcher: new Searcher(indexer, DEFAULT_TUNING), indexer };
}

let engineCounter = 0;

/* ========================================================================== */
/* 6. The corpus                                                              */
/* ========================================================================== */

/** Queries run without filters. Grouped only so a failure names the family. */
const PLAIN_QUERIES: readonly (readonly [string, string])[] = [
	// Single terms and true infixes — the reason the index is trigram-based.
	['infix', 'maschine'],
	['infix', 'pumpe'],
	['infix', 'heizung'],
	['infix', 'anlage'],
	['infix', 'bereitung'],
	['word', 'espressomaschine'],
	['word', 'kaffeemaschine'],
	['word', 'kaffeevollautomat'],
	['word', 'fussbodenheizung'],
	['word', 'erdsondenfeld'],
	['word', 'warmwasseraufbereitung'],
	['word', 'protokoll'],
	['word', 'ingenieur'],
	['word', 'budget'],
	['english', 'underfloor'],
	['english', 'ventilation'],
	['english', 'envelope'],
	['english', 'borehole'],
	['english', 'grinder'],
	['english', 'retrofit'],
	// Umlauts, ß and their ASCII aliases, in both directions.
	['umlaut', 'wärmepumpe'],
	['umlaut', 'waermepumpe'],
	['umlaut', 'warmepumpe'],
	['umlaut', 'lüftungsanlage'],
	['umlaut', 'gebäudehülle'],
	['umlaut', 'gebaeudehuelle'],
	['umlaut', 'küchenplanung'],
	['umlaut', 'kuechenplanung'],
	['umlaut', 'küche'],
	['umlaut', 'kueche'],
	['umlaut', 'straße'],
	['umlaut', 'strasse'],
	['umlaut', 'grüße'],
	['umlaut', 'gruesse'],
	['umlaut', 'überprüfung'],
	['umlaut', 'ueberpruefung'],
	['umlaut', 'maßnahme'],
	['umlaut', 'massnahme'],
	['umlaut', 'größe'],
	['umlaut', 'groesse'],
	['umlaut', 'öffnung'],
	['umlaut', 'änderung'],
	['umlaut', 'weiß'],
	['accent', 'café'],
	['accent', 'cafe'],
	['accent', 'brûlée'],
	['accent', 'jalapeño'],
	['accent', 'curacao'],
	// Short terms take the linear-scan path.
	['short', 'ss'],
	['short', 'ku'],
	['short', 'üb'],
	['short', 'ae'],
	// Phrases, cut out of the fixture's own sentences.
	['phrase', '"wurde am montag geprüft"'],
	['phrase', '"im untergeschoss steht die"'],
	['phrase', '"heat pump"'],
	['phrase', '"domestic hot water"'],
	['phrase', '"the coffee grinder"'],
	['phrase', '"gegen die vorgabe"'],
	['phrase', '"kaffeemaschine wurde"'],
	// Exclusions.
	['not', 'maschine -kaffee'],
	['not', 'wärmepumpe -altbau'],
	['not', 'küche -offerte'],
	['not', 'heizung -fussbodenheizung'],
	['not', 'pumpe -maschine -küche'],
	['not', '"heat pump" -ventilation'],
	// OR groups.
	['or', 'kaffee OR tee'],
	['or', 'wärmepumpe OR erdsondenfeld'],
	['or', 'küche OR kueche'],
	['or', 'maschine pumpe OR heizung'],
	['or', 'espresso OR kaffee OR tee'],
	['or', 'kaffeemaschine OR espressomaschine -altbau'],
	// Field prefixes.
	['field', 'path:Projekte'],
	['field', 'path:Projekte2'],
	['field', 'path:Rezepte'],
	['field', 'title:Bericht'],
	['field', 'title:küche'],
	['field', 'title:maschine'],
	['field', 'tag:heizung'],
	['field', 'tag:norm'],
	['field', 'tag:küche'],
	['field', 'path:Projekte maschine'],
	['field', 'title:Bericht -pumpe'],
	['field', 'path:Süßes'],
	['field', 'path:Suesses'],
	['field', 'path:Büro-Umbau'],
	['field', 'path:Buero-Umbau'],
	['field', 'path:Täglich'],
	['field', 'tag:norm/sia'],
	['field', 'tag:lüftung'],
	['field', '-tag:heizung küche'],
	['field', '-path:Projekte maschine'],
	// Blanking probes: `beispiel.invalid` occurs ONLY inside link URLs, the
	// label text and the wiki-link target only outside them, and `messwerte`
	// only inside a fenced code block.
	['blanking', 'beispiel'],
	['blanking', 'invalid'],
	['blanking', 'datenblatt'],
	['blanking', 'datasheet'],
	['blanking', 'messwerte'],
	['blanking', 'png'],
	['blanking', 'leistung'],
	// Frontmatter keys and values are part of the searchable text.
	['frontmatter', 'aliases'],
	['frontmatter', 'projekt-nr'],
	['frontmatter', 'ruegg'],
	['frontmatter', 'erledigt'],
	// Casing, digits, punctuation and a non-BMP term.
	['misc', 'WÄRMEpumpe'],
	['misc', 'déjà-vu'],
	['misc', '2026'],
	['misc', '☕'],
	['misc', 'zur-fussbodenheizung'],
	['misc', 'küc'],
	['misc', 'ße'],
	['misc', 'ue'],
	['misc', '"crème brûlée"'],
	['misc', '"espressomaschine — der termin"'],
	// Parser recovery: the reference drops the same tokens the parser reports.
	['recovery', 'maschine -'],
	['recovery', 'OR maschine'],
	['recovery', '"unclosed maschine'],
	['recovery', '-kaffee'],
	['recovery', 'status:offen'],
];

/** Queries run with a filter set; the second element is the filter. */
const FILTERED_QUERIES: readonly (readonly [string, string, SearchFilters])[] = [
	['folder', 'maschine', { ...noFilters(), folder: 'Projekte' }],
	['folder', 'maschine', { ...noFilters(), folder: 'Projekte', includeSubfolders: false }],
	['folder', 'küche', { ...noFilters(), folder: 'Projekte/2024' }],
	['folder', 'heizung', { ...noFilters(), folder: 'Notizen', includeSubfolders: false }],
	['folder', 'pumpe', { ...noFilters(), folder: 'Rezepte/Süßes' }],
	['excluded', 'maschine', { ...noFilters(), excludedFolders: ['Projekte'] }],
	['excluded', 'küche', { ...noFilters(), excludedFolders: ['Projekte', 'Notizen'] }],
	['modified', 'maschine', { ...noFilters(), modifiedFrom: Date.UTC(2025, 0, 1) }],
	['modified', 'heizung', { ...noFilters(), modifiedFrom: Date.UTC(2024, 0, 1), modifiedTo: Date.UTC(2025, 6, 1) }],
	['modified', 'küche', { ...noFilters(), modifiedTo: Date.UTC(2023, 0, 1) }],
	['folder', 'kaffee OR tee', { ...noFilters(), folder: 'Projekte2' }],
	['folder', 'maschine', { ...noFilters(), folder: 'Inbox' }],
	['folder', 'path:Projekte', { ...noFilters(), folder: 'Projekte2' }],
	['folder', 'ss', { ...noFilters(), folder: 'Meetings/Kunden/Süd' }],
	['excluded', 'maschine', { ...noFilters(), excludedFolders: ['Projekte2'] }],
	['excluded', 'heizung', { ...noFilters(), excludedFolders: ['Notizen/Täglich'] }],
	[
		'combined',
		'maschine -kaffee',
		{ ...noFilters(), folder: 'Projekte', excludedFolders: ['Projekte/2024'], modifiedFrom: Date.UTC(2024, 0, 1) },
	],
];

/* ========================================================================== */
/* 7. The differential                                                        */
/* ========================================================================== */

describe('Differential — engine vs. brute-force reference', () => {
	it('runs a corpus of at least 60 queries', () => {
		expect(PLAIN_QUERIES.length + FILTERED_QUERIES.length).toBeGreaterThanOrEqual(60);
		expect(refNotes.length).toBe(NOTE_COUNT);
	});

	it('agrees on the set of matching paths for every unfiltered query', () => {
		const problems: string[] = [];
		for (const [, query] of PLAIN_QUERIES) {
			const engine = enginePaths(query);
			const reference = refSearch(refNotes, query, noFilters());
			if (engine.join('\n') !== reference.join('\n')) problems.push(describeDifference(query, engine, reference));
		}
		expect(problems.join('\n\n')).toBe('');
	});

	it('agrees on the set of matching paths for every filtered query', () => {
		const problems: string[] = [];
		for (const [, query, filters] of FILTERED_QUERIES) {
			const engine = enginePaths(query, filters);
			const reference = refSearch(refNotes, query, filters);
			if (engine.join('\n') !== reference.join('\n')) problems.push(describeDifference(query, engine, reference));
		}
		expect(problems.join('\n\n')).toBe('');
	});

	/**
	 * The created filter is asserted separately and with a guard band: the
	 * fixture generator resolves a bare `created:` date to UTC midnight while a
	 * date parser may reasonably resolve it to local midnight. Notes whose two
	 * readings straddle a boundary are therefore excluded from the comparison —
	 * everything else must still agree exactly.
	 */
	it('agrees on created-date filters outside the timezone guard band', () => {
		const cases: readonly SearchFilters[] = [
			{ ...noFilters(), createdFrom: Date.UTC(2023, 0, 1, 12) },
			{ ...noFilters(), createdFrom: Date.UTC(2021, 0, 1, 12), createdTo: Date.UTC(2024, 0, 1, 12) },
			{ ...noFilters(), createdTo: Date.UTC(2020, 6, 1, 12) },
		];
		const problems: string[] = [];
		for (const filters of cases) {
			const ambiguous = new Set(
				refNotes
					.filter((note) => {
						const bounds = [filters.createdFrom, filters.createdTo].filter((value): value is number => value !== null);
						return bounds.some(
							(bound) => Math.abs(note.createdAt - bound) < 36 * 3_600_000 || Math.abs(note.createdAtAlt - bound) < 36 * 3_600_000,
						);
					})
					.map((note) => note.path),
			);
			const engine = enginePaths('maschine', filters).filter((path) => !ambiguous.has(path));
			const reference = refSearch(refNotes, 'maschine', filters).filter((path) => !ambiguous.has(path));
			if (engine.join('\n') !== reference.join('\n')) {
				problems.push(describeDifference(`maschine + ${JSON.stringify(filters)}`, engine, reference));
			}
		}
		expect(problems.join('\n\n')).toBe('');
	});

	/**
	 * Fuzzy is not compared set-for-set — the "trigram similarity >= 0.6" gate
	 * admits several readings — but it must never LOSE a hit the exact path
	 * found, and it must find the fixture's planted misspellings.
	 */
	it('fuzzy search is a superset of exact search', () => {
		const problems: string[] = [];
		for (const query of ['kaffeemaschine', 'espressomaschine', 'wärmepumpe', 'küche', 'heat pump']) {
			const exact = new Set(enginePaths(query));
			const fuzzy = new Set(enginePaths(query, noFilters(), true));
			const lost = [...exact].filter((path) => !fuzzy.has(path));
			if (lost.length > 0) problems.push(`query: ${query}\n  lost with fuzzy on: ${lost.slice(0, 5).join(' | ')}`);
		}
		expect(problems.join('\n\n')).toBe('');
	});
});

/* ========================================================================== */
/* 7b. The offset contract, checked with the reference fold                   */
/* ========================================================================== */

/**
 * Independent re-check of the assertion the offset contract exists for: every
 * body-side match, sliced out of the ORIGINAL file text, has to fold to one of
 * the literals the term was searched as. The engine's own suite asserts this
 * with the engine's own fold; this one uses the reference fold instead, so a
 * fold table that is wrong in the same way on both sides cannot hide.
 */
describe('Differential — match offsets point at the matched text', () => {
	it('every body match folds back to one of the term variants', () => {
		const queries = [
			'maschine',
			'wärmepumpe',
			'kueche',
			'straße',
			'gruesse',
			'"heat pump"',
			'gebäudehülle',
			'weiß',
			'überprüfung',
			'café',
		];
		const problems: string[] = [];
		for (const query of queries) {
			const ast = parseQuery(query, DEFAULT_TUNING);
			for (const hit of engineSearch(query, noFilters())) {
				const raw = loaded.files[hit.path].content;
				for (const match of hit.matches) {
					if (match.field === 'title' || match.field === 'path') continue;
					const slice = refStripFold(raw.slice(match.start, match.end));
					const variants = ast.terms[match.termIndex]?.variants ?? [];
					if (!variants.includes(slice)) {
						problems.push(
							`query "${query}" ${hit.path} [${match.start},${match.end}) folded to "${slice}", expected one of ${variants.join('/')}`,
						);
					}
				}
			}
		}
		expect(problems.slice(0, 10).join('\n')).toBe('');
	});
});

/* ========================================================================== */
/* 8. Decomposed (NFD) source — where the two implementations part company    */
/* ========================================================================== */

/**
 * Where the two implementations used to part company, kept as a regression.
 *
 * `applyFold` drops combining marks, so a decomposed note's `text` reads
 * `kuche` and a plain `küche` finds it. `stripFold` is length-preserving and
 * therefore CANNOT drop them, and it used to be what `addTag` and the Indexer's
 * `titleNormalized` / `pathNormalized` were built from. Everything reached
 * through those three fields was unreachable for a decomposed source, because
 * the query side NFC-normalizes before folding and can never produce the mark
 * again.
 *
 * All three are fixed and pinned below: `addTag` folds through
 * `foldFieldValue`, and so do `titleNormalized` and `pathNormalized` in the
 * Indexer's `toRecord` and `relocate`. `foldFieldValue` composes first and drops
 * whatever mark survives, exactly as the document pass does; none of the three
 * fields carries a file offset, so none of them needs the length-preserving
 * fold that made the mark survive.
 *
 * NFD is not exotic: it is what macOS hands out for file names, and the fixture
 * generator writes 2 % of its notes decomposed for exactly this reason.
 */
describe('Differential — decomposed source', () => {
	const decomposed = (text: string): string => text.normalize('NFD');

	/** Name and frontmatter tag decomposed; a second note whose file name alone carries the word. */
	const NFD_FILES: Record<string, FakeFileSpec> = {
		[decomposed('Küche/Notiz Küche.md')]: {
			content: decomposed(['---', 'tags: [küche]', '---', '', '# Notiz', '', 'Die Küche ist fertig.', ''].join('\n')),
		},
		[decomposed('Ordner/Nur im Namen Küche.md')]: { content: '# Notiz\n\nHier steht nichts Besonderes.\n' },
		'Andere/Notiz.md': { content: 'Nichts hier.\n' },
	};

	function counts(mini: Searcher, queries: readonly string[]): string {
		return queries
			.map((query) => {
				const hits = mini
					.search(parseQuery(query, DEFAULT_TUNING), { filters: noFilters(), fuzzy: false, limit: 100 })
					.map((hit) => hit.path);
				return `${query}=${String(hits.length)}`;
			})
			.join(' ');
	}

	it('agrees with the reference on a decomposed tag', async () => {
		const { searcher: mini, indexer } = await buildEngine(NFD_FILES);
		const notes = buildRefNotes({
			dir: '',
			files: NFD_FILES,
			manifest: null,
			notesByPath: new Map(),
			totalLength: 0,
		});
		const path = decomposed('Küche/Notiz Küche.md');

		// `notiz` is the control: pure ASCII, so it finds all three notes.
		expect(counts(mini, ['notiz'])).toBe('notiz=3');
		for (const query of ['tag:küche', decomposed('tag:küche'), 'tag:kueche']) {
			const engine = mini
				.search(parseQuery(query, DEFAULT_TUNING), { filters: noFilters(), fuzzy: false, limit: 100 })
				.map((hit) => hit.path)
				.sort();
			expect(engine, query).toEqual([path]);
			expect(refSearch(notes, query, noFilters()).sort(), `reference: ${query}`).toEqual([path]);
		}
		expect(indexer.getFileByPath(path)?.tags).toEqual(['kuche']);
		indexer.stop();
	}, 60_000);

	/**
	 * The other half of the same defect. `küche=2` is the load-bearing count: the
	 * second note holds the word ONLY in its decomposed file name, so before the
	 * fix no query returned it at all — not `title:`, not `path:`, and not the
	 * plain word either.
	 */
	it('finds a decomposed title and path through their field prefixes', async () => {
		const { searcher: mini, indexer } = await buildEngine(NFD_FILES);
		const found = counts(mini, ['küche', 'title:küche', 'path:küche']);
		indexer.stop();

		expect(found).toBe('küche=2 title:küche=2 path:küche=2');
	}, 60_000);
});

/* ========================================================================== */
/* 9. Ranking — is the top hit the one the documented weights demand?         */
/* ========================================================================== */

/**
 * Ten hand-built two- or three-note vaults, each isolating one documented
 * ranking rule (plan section 3.1: title 3.0 / frontmatter 2.0 / heading 1.5 /
 * body 1.0 / path 1.0, whole-word 1.3, proximity, mild recency, fuzzy 0.7,
 * alias 0.95). `winner` is what a human reading those weights would pick.
 */
interface RankCase {
	name: string;
	query: string;
	files: Record<string, FakeFileSpec>;
	winner: string;
	fuzzy?: boolean;
}

const NOW = Date.UTC(2026, 8, 1);
const YEAR = 365 * 86_400_000;
const OLD = { ctime: NOW - 4 * YEAR, mtime: NOW - 4 * YEAR };

/** 2 000 characters of filler, so the proximity case has real distance in it. */
const FILLER = 'Der Termin steht noch nicht fest und die Unterlagen liegen im Ordner. '.repeat(30);

const RANK_CASES: readonly RankCase[] = [
	{
		name: 'title beats body',
		query: 'wärmepumpe',
		files: {
			'a/Wärmepumpe Notiz.md': { content: 'Eine ganz normale Notiz ohne weitere Angaben.\n', ...OLD },
			'a/Protokoll.md': { content: 'Die Wärmepumpe wurde geprüft.\n', ...OLD },
		},
		winner: 'a/Wärmepumpe Notiz.md',
	},
	{
		name: 'heading beats body',
		query: 'erdsondenfeld',
		files: {
			'a/Eins.md': { content: '# Notiz\n\n## Erdsondenfeld\n\nText ohne weitere Angaben.\n', ...OLD },
			'a/Zwei.md': { content: '# Notiz\n\nDas Erdsondenfeld wurde geprüft.\n', ...OLD },
		},
		winner: 'a/Eins.md',
	},
	{
		name: 'frontmatter beats body',
		query: 'lüftungsanlage',
		files: {
			'a/Eins.md': { content: '---\naliases: [Lüftungsanlage]\n---\n\n# Notiz\n\nText ohne Angaben.\n', ...OLD },
			'a/Zwei.md': { content: '# Notiz\n\nDie Lüftungsanlage wurde geprüft.\n', ...OLD },
		},
		winner: 'a/Eins.md',
	},
	{
		name: 'whole word beats infix',
		query: 'maschine',
		files: {
			'a/Eins.md': { content: '# Notiz\n\nDie Maschine wurde geprüft.\n', ...OLD },
			'a/Zwei.md': { content: '# Notiz\n\nDie Espressomaschine wurde geprüft.\n', ...OLD },
		},
		winner: 'a/Eins.md',
	},
	{
		name: 'a title match beats twenty body repetitions',
		query: 'erdsondenfeld',
		files: {
			'a/Erdsondenfeld.md': { content: 'Eine Notiz ohne weitere Angaben.\n', ...OLD },
			'a/Zwei.md': { content: `# Notiz\n\n${'Das Erdsondenfeld ist geprüft. '.repeat(20)}\n`, ...OLD },
		},
		winner: 'a/Erdsondenfeld.md',
	},
	{
		name: 'two terms close together beat the same two far apart',
		query: 'pumpe wasser',
		files: {
			'a/Nah.md': { content: `# Notiz\n\nDie Pumpe und das Wasser sind geprüft.\n\n${FILLER}\n`, ...OLD },
			'a/Fern.md': { content: `# Notiz\n\nDie Pumpe ist geprüft.\n\n${FILLER}\n\nDas Wasser ist geprüft.\n`, ...OLD },
		},
		winner: 'a/Nah.md',
	},
	{
		name: 'recency breaks a tie',
		query: 'gebäudehülle',
		files: {
			'a/Neu.md': { content: '# Notiz\n\nDie Gebäudehülle wurde geprüft.\n', ctime: NOW - 4 * YEAR, mtime: NOW },
			'a/Alt.md': { content: '# Notiz\n\nDie Gebäudehülle wurde geprüft.\n', ...OLD },
		},
		winner: 'a/Neu.md',
	},
	{
		name: 'an exact hit beats an alias hit',
		query: 'küche',
		files: {
			'a/Exakt.md': { content: '# Notiz\n\nDie Küche wurde geprüft.\n', ...OLD },
			'a/Alias.md': { content: '# Notiz\n\nDie Kueche wurde geprüft.\n', ...OLD },
		},
		winner: 'a/Exakt.md',
	},
	{
		name: 'an exact hit beats a fuzzy hit',
		query: 'kaffeemaschine',
		files: {
			'a/Exakt.md': { content: '# Notiz\n\nDie Kaffeemaschine wurde geprüft.\n', ...OLD },
			'a/Fuzzy.md': { content: '# Notiz\n\nDie Kafeemaschine wurde geprüft.\n', ...OLD },
		},
		winner: 'a/Exakt.md',
		fuzzy: true,
	},
	{
		name: 'a title match beats a folder-name match',
		query: 'küchenplanung',
		files: {
			'Notizen/Küchenplanung Konzept.md': { content: '# Konzept\n\nEine Notiz ohne weitere Angaben.\n', ...OLD },
			'Küchenplanung/Konzept.md': { content: '# Konzept\n\nEine Notiz ohne weitere Angaben.\n', ...OLD },
		},
		winner: 'Notizen/Küchenplanung Konzept.md',
	},
];

describe('Differential — ranking against the documented weights', () => {
	it('puts the expected note first in all ten cases', async () => {
		const problems: string[] = [];
		const ranker = new Ranker(DEFAULT_TUNING.weights);
		for (const rankCase of RANK_CASES) {
			const { searcher: mini } = await buildEngine(rankCase.files);
			const ast = parseQuery(rankCase.query, DEFAULT_TUNING);
			const hits = mini.search(ast, { filters: noFilters(), fuzzy: rankCase.fuzzy === true, limit: 100 });
			const ranked = ranker.rank(hits, ast, NOW);
			const order = ranked.map((hit) => `${hit.path} (${hit.score.toFixed(3)})`);
			if (ranked.length === 0 || ranked[0].path !== rankCase.winner) {
				problems.push(`${rankCase.name} — query "${rankCase.query}"\n  expected ${rankCase.winner}\n  got ${order.join(' | ')}`);
			}
		}
		expect(problems.join('\n\n')).toBe('');
	}, 120_000);
});
