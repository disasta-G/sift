/**
 * Sift — shared type contract.
 *
 * Phase 1 scope: local search only. No AI, no license, no backend, no network.
 * Every other module is written against this file; nothing here has a runtime
 * representation (types and interfaces only), so importing it costs nothing in
 * the bundle.
 *
 * ---------------------------------------------------------------------------
 * THE OFFSET CONTRACT (read this before touching Normalizer, Searcher or Snippets)
 * ---------------------------------------------------------------------------
 * Search runs on normalized text; snippets and "jump to hit" need offsets into
 * the ORIGINAL file text. Sift keeps those two in sync by normalizing through
 * SUBSTITUTION ONLY, never deletion:
 *
 *   - every source UTF-16 code unit produces exactly one normalized code unit;
 *   - a character that folds (Ä -> a, É -> e, ß -> s) becomes its folded form;
 *   - a character that must disappear (markdown syntax, a link URL, a combining
 *     mark that was already stripped from its base letter) becomes U+0020.
 *
 * Consequences:
 *   1. `normalized.length === original.length`, and normalized offset N is
 *      original offset N. No offset map, no per-file allocation, no drift.
 *   2. Blanking instead of deleting also inserts a word boundary exactly where
 *      markup was, which is what the whole-word bonus and the trigram builder
 *      want anyway.
 *   3. Nothing that changes length may live in the normalized text. That rules
 *      out the ae/oe/ue/ss aliases (ä -> "ae" is 1 -> 2), so those are handled
 *      on the query side and by supplementary trigrams — see
 *      {@link QueryTerm.variants} and {@link IndexedFile.text}.
 *   4. The fold keeps every offset and loses every STRUCTURE: a paragraph break,
 *      a heading marker and a blanked `**` all end up as the same run of
 *      U+0020. Anything that has to tell them apart must be recorded while the
 *      source is still intact — see {@link NormalizedDoc.blockBreaks}.
 *
 * The one case substitution cannot cover is source text stored in NFD (base
 * letter + separate combining mark), where folding genuinely removes a code
 * unit. Normalizer detects it (`raw.normalize('NFC').length !== raw.length`)
 * and only then allocates {@link IndexedFile.offsetMap}. In a Markdown vault
 * that is a rounding error; every other file carries `offsetMap === null`.
 * All consumers go through a single mapping helper so the two paths can never
 * diverge — see `Normalizer.toOriginalOffset`.
 */

import type { TFile } from 'obsidian';

/* ========================================================================== */
/* 1. Primitives                                                              */
/* ========================================================================== */

/** Dense, stable handle for an indexed file. Assigned by the Indexer, reused across sessions. */
export type FileId = number;

/** Vault-relative path with forward slashes, always passed through `normalizePath()` first. */
export type VaultPath = string;

/** Milliseconds since the Unix epoch. */
export type Millis = number;

/** Offset into the ORIGINAL file text, in UTF-16 code units. */
export type OriginalOffset = number;

/** Offset into normalized text, in UTF-16 code units. Equal to the original offset unless the file carries an offset map. */
export type NormalizedOffset = number;

/** Half-open range `[start, end)`. */
export interface Span {
	/** Inclusive start. */
	start: number;
	/** Exclusive end. */
	end: number;
}

/**
 * Persisted-schema generation. Bumping it discards the IndexedDB content and
 * forces a full rebuild.
 *
 * Generation 2 added {@link IndexedFile.blockBreaks}, generation 3
 * {@link IndexedFile.properties}, generation 4 {@link IndexedFile.hasOpenTask}.
 * The value that guards the store is
 * `SIFT_SCHEMA_VERSION` in `src/index/Store.ts`; it and this type move
 * together, and `Store.toIndexedFile` rejects a row that does not match. An
 * older store is therefore discarded on load rather than served with a field
 * missing — the cost is one rebuild after the update, which the settings tab
 * reports while it runs.
 */
export type SchemaVersion = 4;

/* ========================================================================== */
/* 2. Normalization                                                           */
/* ========================================================================== */

/**
 * Result of normalizing one document.
 *
 * Invariant enforced by unit test: `offsetMap === null` implies
 * `text.length === originalLength`.
 */
export interface NormalizedDoc {
	/** Folded text. ASCII-only for Latin input, which lets the engine store it as a one-byte string. */
	text: string;
	/** Length of the source text in UTF-16 code units. */
	originalLength: number;
	/**
	 * `null` (the normal case) means normalized offset N is original offset N.
	 * Otherwise `offsetMap[n]` is the original offset of normalized offset `n`;
	 * length is `text.length + 1`, the last entry being `originalLength`.
	 */
	offsetMap: Uint32Array | null;
	/** Span of the YAML frontmatter block inside `text`, `null` when the file has none. */
	frontmatterSpan: Span | null;
	/** ATX/setext headings, ordered by `span.start`, non-overlapping. */
	headings: readonly HeadingSpan[];
	/**
	 * Where the document's blocks end: one ascending normalized offset per blank
	 * line of the ORIGINAL text, pointing at the first code unit of that line.
	 *
	 * It exists because the fold destroys the distinction. Every whitespace run
	 * becomes U+0020 (the offset contract above), so in `text` a paragraph break
	 * and a blanked `**` are the same two spaces — and a quoted phrase, which is
	 * allowed to span the second, must not span the first. The offsets are the
	 * only record of which run was which, and the Searcher treats them as barriers
	 * a phrase gap may not step over.
	 */
	blockBreaks: Uint32Array;
	/** Distinct words of the document, packed for the fuzzy path. */
	words: PackedWords;
	/** Tags found in frontmatter and inline (`#tag`), folded, without the leading `#`. */
	tags: readonly string[];
	/** Frontmatter keys and their scalar values, folded. Used for `created` parsing and field weighting. */
	frontmatter: Readonly<Record<string, string>>;
	/** True when at least one list item carries an open task box. See {@link IndexedFile.hasOpenTask}. */
	hasOpenTask: boolean;
}

/** One heading, located inside {@link NormalizedDoc.text}. */
export interface HeadingSpan {
	/** 1-6 for `#`..`######`; setext headings map to 1 or 2. */
	level: number;
	/** The whole heading line, marker included (the marker itself is blanked in `text`). */
	span: Span;
	/** Just the heading caption, used for the 1.5 weight. */
	textSpan: Span;
}

/**
 * Distinct words of one file, stored as one string plus boundaries instead of
 * ~500 separate JS strings. That is the difference between roughly 6 MB and
 * roughly 40 MB of overhead across a 10 000-note vault.
 */
export interface PackedWords {
	/** All distinct words joined by `\n`, each already strip-folded. */
	packed: string;
	/** `count + 1` entries; word `i` is `packed.slice(bounds[i], bounds[i + 1] - 1)`. */
	bounds: Uint32Array;
	/** Number of distinct words. */
	count: number;
}

/**
 * The two folds Sift uses. They are deliberately different:
 *
 * - `strip` is length-preserving and is what the index and all offsets are
 *   built on: `ä -> a`, `ö -> o`, `ü -> u`, `ß -> s`, `é -> e`, `Æ -> a`.
 * - `alias` is the German ASCII transliteration and is NOT length-preserving:
 *   `ä -> ae`, `ö -> oe`, `ü -> ue`, `ß -> ss`. It never appears in stored
 *   text; it only produces extra trigrams at index time and extra literal
 *   variants at query time.
 */
export type FoldMode = 'strip' | 'alias';

/* ========================================================================== */
/* 3. Index records                                                           */
/* ========================================================================== */

/**
 * One indexed file, in memory and — byte for byte the same object — in
 * IndexedDB. Every field is structured-cloneable, so the record is written
 * without a serialization step.
 */
export interface IndexedFile {
	id: FileId;
	path: VaultPath;
	/** File basename without extension, original casing, for display. */
	title: string;
	/**
	 * Folded title, searched with weight 3.0. Folded like the document text
	 * (`Normalizer.foldFieldValue`: compose, then strip fold and drop combining
	 * marks), NOT with the length-preserving `stripFold` — no offset indexes into
	 * a file through this string, and a decomposed file name folded the
	 * length-preserving way keeps a mark no query can ever produce.
	 */
	titleNormalized: string;
	/** Parent folder path, `''` for vault root. */
	folder: VaultPath;
	/** Folded full path, searched by `path:` terms. Same fold as {@link IndexedFile.titleNormalized}. */
	pathNormalized: string;
	/**
	 * Strip-folded body text, offset-parallel to the file on disk.
	 * Contains frontmatter and headings in place; their regions are marked by
	 * `frontmatterSpan` / `headings` so the Ranker can weight them.
	 */
	text: string;
	/** See the offset contract at the top of this file. `null` for essentially every file. */
	offsetMap: Uint32Array | null;
	frontmatterSpan: Span | null;
	headings: readonly HeadingSpan[];
	/**
	 * {@link NormalizedDoc.blockBreaks}, carried into the record and persisted —
	 * a `Uint32Array` is structured-cloneable, so the Store stores it as is.
	 *
	 * Required: `Store.toIndexedFile` rejects a row without it and the schema
	 * generation that introduced it is 2, so a row from an older store is
	 * discarded rather than adopted. The Indexer also refuses a seeded record
	 * that lacks the field, which keeps the invariant true even if a future
	 * store path forgets to validate.
	 */
	blockBreaks: Uint32Array;
	tags: readonly string[];
	words: PackedWords;
	/** Frontmatter date field if parseable, else `file.stat.ctime`. */
	createdAt: Millis;
	/** Always `file.stat.mtime`. */
	modifiedAt: Millis;
	/** How `createdAt` was obtained; surfaced in the UI so a wrong frontmatter date is explainable. */
	createdSource: CreatedSource;
	/**
	 * Frontmatter keys and their scalar values, both strip-folded — what
	 * Obsidian's own interface calls the note's properties.
	 *
	 * Persisted since generation 3, because a property filter has to answer for
	 * a file the current session has never opened. Values are folded so that a
	 * chip reading `status = Offen` matches a note that spells it `offen`; the
	 * key is folded for the same reason. A list-valued property is stored as its
	 * items joined by `, `, which is what the fold of the source line already
	 * produces.
	 */
	properties: Readonly<Record<string, string>>;
	/**
	 * True when the note holds at least one list item with an open task box —
	 * `- [ ]`, `- [/]` or `- [?]`. `[x]`, `[X]`, `[-]` and any other status count
	 * as not open; `Normalizer.isOpenTaskMarker` is the single definition.
	 *
	 * Stored rather than derived, because the folded {@link IndexedFile.text} no
	 * longer contains the brackets: the list marker and the inline scanner blank
	 * them, so by the time a filter could look, the evidence is gone. Persisted
	 * since generation 4, for the same reason `properties` is — the filter has to
	 * answer for a file this session never opened.
	 */
	hasOpenTask: boolean;
	/** `file.stat.size` in bytes. */
	size: number;
	/** `file.stat.mtime` at index time. Staleness check on startup compares against this. */
	indexedMtime: Millis;
}

/** Where {@link IndexedFile.createdAt} came from. */
export type CreatedSource = 'frontmatter' | 'ctime';

/**
 * Inverted index. Two representations, one type, because the working set and
 * the steady state have opposite requirements:
 *
 * - while indexing, postings are `Set<FileId>` (cheap incremental add/remove);
 * - once a build settles, `Indexer.compact()` converts them to sorted
 *   `Uint32Array` postings. With ~9 M postings across 10 000 notes, `Set`
 *   costs roughly 300 MB and the typed array roughly 36 MB — the difference
 *   between missing and meeting the < 100 MB budget.
 */
export type Postings = Set<FileId> | Uint32Array;

/** `Map<trigram, Postings>`; keys are exactly 3 UTF-16 code units of strip-folded text. */
export type TrigramIndex = Map<string, Postings>;

/** Counters shown in the settings tab and asserted by the benchmark script. */
export interface IndexStats {
	fileCount: number;
	/** Distinct trigram keys. */
	trigramCount: number;
	/** Sum of all postings-list lengths. */
	postingCount: number;
	/** Sum of `text.length` over all files, in UTF-16 code units. */
	totalTextLength: number;
	/** Rough heap estimate in bytes; approximate by design, never reported anywhere but the UI. */
	approximateBytes: number;
	/** When the current in-memory index finished building. */
	builtAt: Millis;
	/** Postings representation currently in effect. */
	compacted: boolean;
}

/** Coarse phase of an index build, for the progress line in the modal footer. */
export type IndexPhase = 'idle' | 'loading' | 'scanning' | 'reading' | 'building' | 'compacting' | 'ready' | 'error';

/** Progress callback payload. Emitted at most once per idle slice. */
export interface IndexProgress {
	phase: IndexPhase;
	/** Files completed in the current phase. */
	done: number;
	/** Files expected in the current phase; `0` when unknown. */
	total: number;
	/** Only set when `phase === 'error'`. Never contains file content. */
	error?: string;
}

/** A vault mutation the Indexer has to react to. */
export interface FileChange {
	kind: 'created' | 'modified' | 'deleted' | 'renamed';
	/** `null` for `deleted`. */
	file: TFile | null;
	path: VaultPath;
	/** Only for `renamed`. */
	oldPath?: VaultPath;
}

/* ========================================================================== */
/* 4. Query AST                                                               */
/* ========================================================================== */

/** `word` matches as a substring; `phrase` matches the quoted literal including its spaces. */
export type TermKind = 'word' | 'phrase';

/** Optional field restriction from a `path:` / `tag:` / `title:` prefix. */
export type TermField = 'any' | 'path' | 'property' | 'tag' | 'title';

/** One leaf of the query. */
export interface QueryTerm {
	kind: TermKind;
	field: TermField;
	/** Exactly what the user typed, quotes and prefix removed. Used for the "similar: …" label. */
	raw: string;
	/** Strip fold of `raw`; the primary literal to search for. */
	normalized: string;
	/**
	 * Literal alternatives that all count as a match for this term, in priority
	 * order, `normalized` first. Built from the strip fold, the alias fold, and
	 * the contractions of `ae|oe|ue|ss` back to `a|o|u|s` — the last of these is
	 * what lets a query "Kueche" hit a note containing "Küche", whose stored
	 * text reads "kuche". Capped at {@link SiftTuning.maxTermVariants}; beyond
	 * the cap only the uncontracted and the fully contracted form survive.
	 */
	variants: readonly string[];
	/** Union of the trigrams of all `variants`; empty when {@link short} is true. */
	trigrams: readonly string[];
	/** `normalized.length < 3`, so this term needs the linear-scan path. */
	short: boolean;
	/** Fuzzy matching may be applied to this term. Always false inside phrases. */
	fuzzyEligible: boolean;
	/** Where the term sits in the raw query string, for inline error marking. */
	span: Span;
}

/**
 * Parsed query.
 *
 * Semantics: a file matches when every term in `must` matches, no term in
 * `mustNot` matches, and for every group in `should` at least one member
 * matches. `a OR b` produces `should: [[a, b]]` and leaves `must` empty for
 * those two terms.
 */
export interface QueryAst {
	must: readonly QueryTerm[];
	mustNot: readonly QueryTerm[];
	/** Each inner array is one OR group; groups are ANDed with each other and with `must`. */
	should: readonly (readonly QueryTerm[])[];
	/** The query string as typed. */
	raw: string;
	/** Recoverable syntax problems. The parser never throws; it degrades. */
	errors: readonly QueryParseError[];
	/**
	 * No positive term at all: `terms.length === 0`. `-altbau` is empty by this
	 * definition, an unclosed quote around real text is not.
	 *
	 * It is NOT the same as "do not search". Filters alone are a valid search —
	 * a date, a date range or a folder is a question in itself — and the parser
	 * cannot see the filter bar, so it cannot answer that question. The caller
	 * combines the two:
	 *
	 *   `!ast.isEmpty || hasActiveFilters(filters)`   (`src/search/Searcher.ts`)
	 *
	 * and only shows the empty state when both are false.
	 */
	isEmpty: boolean;
	/** Flat list of every positive term (`must` plus all `should` members), in the order the Ranker indexes them. */
	terms: readonly QueryTerm[];
}

/** A syntax problem that the parser recovered from. */
export interface QueryParseError {
	code: QueryParseErrorCode;
	/** Where in the raw query, for underlining. */
	span: Span;
	/** i18n key; the message itself is resolved by the UI, never stored here. */
	messageKey: TranslationKey;
}

export type QueryParseErrorCode =
	/** A `"` was opened and never closed; the parser closed it at end of input. */
	| 'unclosed-quote'
	/** `-` or `OR` with nothing to operate on; the token was dropped. */
	| 'dangling-operator'
	/** `foo:` with an unknown field name; treated as literal text. */
	| 'unknown-field'
	/** Query longer than {@link SiftTuning.maxQueryLength}; the tail was cut. */
	| 'query-too-long';

/* ========================================================================== */
/* 5. Search                                                                  */
/* ========================================================================== */

/** Which part of a file a match landed in. Drives the Ranker's field weight. */
export type MatchField = 'title' | 'path' | 'frontmatter' | 'tag' | 'heading' | 'body';

/**
 * How good a match is.
 * `exact` — the term's strip fold occurs literally.
 * `alias` — an alias or contraction variant occurred (ä/ae, ß/ss).
 * `fuzzy` — only reached within Damerau-Levenshtein distance, and only when the user turned "Similar" on.
 */
export type MatchQuality = 'exact' | 'alias' | 'fuzzy';

/**
 * One occurrence.
 *
 * OFFSET DOMAIN — this trips people up, so it is spelled out:
 * for `field` `'body' | 'heading' | 'frontmatter' | 'tag'` the offsets are
 * offsets into the ORIGINAL file text, already mapped, and are safe to hand to
 * Snippets and to "jump to hit". For `field` `'title'` and `'path'` they index
 * into {@link IndexedFile.titleNormalized} / {@link IndexedFile.pathNormalized}
 * instead — there is no file position to jump to. `Snippets` skips those two
 * fields; the Ranker still scores them.
 */
export interface Match {
	start: OriginalOffset;
	end: OriginalOffset;
	field: MatchField;
	/** Index into {@link QueryAst.terms}. */
	termIndex: number;
	/** Both edges sit on a non-word boundary. Worth the 1.3 bonus. */
	wholeWord: boolean;
	quality: MatchQuality;
	/**
	 * The vault word that was actually hit, only when `quality === 'fuzzy'`.
	 * Feeds the "similar: Kafeemaschine" label on the result card.
	 */
	matchedText?: string;
}

/**
 * Filters from the filter bar. `null` means "no constraint".
 *
 * A set filter is a search in its own right: with no query term the Searcher
 * returns everything that passes these. `hasActiveFilters` in
 * `src/search/Searcher.ts` says which of the fields below count as "set" —
 * `excludedFolders` deliberately does not, and neither does the vault root with
 * subfolders on.
 */
export interface SearchFilters {
	/** Folder restriction, already `normalizePath()`ed. `null` = whole vault. */
	folder: VaultPath | null;
	/** When false, only direct children of `folder` match. */
	includeSubfolders: boolean;
	createdFrom: Millis | null;
	createdTo: Millis | null;
	modifiedFrom: Millis | null;
	modifiedTo: Millis | null;
	/** One frontmatter property the note has to carry. `null` = no constraint. */
	property: PropertyFilter | null;
	/**
	 * When true, only notes with at least one open task box pass. `false` is "no
	 * constraint", never "notes without open tasks" — the switch has two
	 * positions, and the second one is the absence of the filter, the way
	 * `folder: null` is.
	 */
	openTasks: boolean;
	/**
	 * A single note the search is confined to, or `null` for the whole vault.
	 *
	 * Set by the "This note" switch, which the modal fills with the file that was
	 * open when the overlay was called. It is a path rather than a flag so the
	 * Searcher stays free of any notion of what is on screen, and so the run is
	 * pinned to the note it started on even if the workspace moves underneath it.
	 */
	note: VaultPath | null;
	/** From settings, not from the filter bar. Applied on top of everything else. */
	excludedFolders: readonly VaultPath[];
}

/**
 * A property constraint: the note has to carry `key`, and — when `value` is set
 * — that key's value has to contain it.
 *
 * `value: null` is "the property exists at all", which is the question a
 * property-driven vault asks most often ("everything that has a `due`"). The
 * value match is a substring of the folded value rather than an equality, so
 * `status = off` finds `Offen` and a list-valued `tags: [a, b]` is matched item
 * by item without the filter having to know it was a list.
 */
export interface PropertyFilter {
	/** Folded property name, without the trailing colon. Never empty. */
	key: string;
	/** Folded value fragment, or `null` for an existence check. Never empty when set. */
	value: string | null;
}

/**
 * Sort order of the result list.
 *
 * `relevance` needs a query to be an order at all. Over a term-less search —
 * filters alone — every hit scores the same, so it falls back to
 * `created-desc`; `Ranker.effectiveSort` is the one place that decides it and
 * the one place to change if that is ever revisited.
 */
export type SortKey =
	| 'relevance'
	| 'created-desc'
	| 'created-asc'
	| 'modified-desc'
	| 'modified-asc'
	| 'title-asc'
	| 'path-asc';

/** Everything the Searcher needs beyond the AST. */
export interface SearchOptions {
	filters: SearchFilters;
	/** "Similar" toggle. Default comes from {@link SiftSettings.fuzzyByDefault}. */
	fuzzy: boolean;
	/** Hard cap on hits returned; the Ranker sorts before the cap is applied. */
	limit: number;
	/** Aborts a search superseded by a newer keystroke. */
	signal?: AbortSignal;
}

/** Searcher output: which files matched and where, unranked. */
export interface RawHit {
	fileId: FileId;
	path: VaultPath;
	title: string;
	folder: VaultPath;
	createdAt: Millis;
	modifiedAt: Millis;
	/**
	 * Ordered by `start`, deduplicated, overlaps merged per term.
	 *
	 * EMPTY for a hit found by filters alone — a date range or a folder with no
	 * search term matches the whole file, not a position in it. Everything
	 * downstream has to survive that: Snippets returns no excerpt and reads no
	 * file, the Ranker scores 0, and the card renders title, path and date.
	 */
	matches: readonly Match[];
	/** Worst quality among `matches` — a hit is only "exact" if every term matched exactly. `exact` when there are none. */
	quality: MatchQuality;
}

/** Ranker output. */
export interface RankedHit extends RawHit {
	/** Raw weighted score, unbounded, comparable only within one result set. `0` when the query has no terms. */
	score: number;
	/**
	 * `score` mapped to 0-100, shown as "Passgenauigkeit".
	 *
	 * `0` for every hit of a term-less search, where relevance is not low but
	 * UNDEFINED: nothing was matched, so nothing distinguishes one hit from
	 * another. The UI shows no relevance figure in that case rather than a row of
	 * zeroes — or a row of 100s, which is the lie this field refuses to tell.
	 */
	relevance: number;
}

/** What the UI renders. */
export interface ResultItem extends RankedHit {
	/**
	 * Excerpts around the best matches.
	 *
	 * Empty until the card enters the viewport: building a snippet needs the
	 * original file text, which is not held in memory, so `Snippets.build()`
	 * runs `vault.cachedRead()` for the visible window only and the modal
	 * re-renders the card when it resolves. A card with an empty array renders
	 * its title and path and leaves the snippet area blank rather than
	 * collapsing, so the list does not jump.
	 */
	snippets: readonly Snippet[];
	/** Distinct fuzzy words that brought this file in, for the "similar: …" chips. Empty unless fuzzy matched. */
	similarTo: readonly string[];
}

/** One completed search, everything the modal needs for a render pass. */
export interface SearchResult {
	items: readonly ResultItem[];
	/** Hits before {@link SearchOptions.limit} was applied. */
	totalCount: number;
	/** Wall-clock duration in ms, shown as "12 Treffer · 38 ms". */
	durationMs: number;
	/** True when `totalCount > items.length`. */
	truncated: boolean;
	/** Echoed so the UI can render error markers next to the field. */
	ast: QueryAst;
	sort: SortKey;
}

/* ========================================================================== */
/* 6. Ranking                                                                 */
/* ========================================================================== */

/** Field multipliers. Defaults: title 3.0, frontmatter 2.0, tag 2.0, heading 1.5, body 1.0, path 1.0. */
export type FieldWeights = Readonly<Record<MatchField, number>>;

/** Everything the Ranker is allowed to tune. Kept out of user settings; lives in {@link SiftTuning}. */
export interface RankingWeights {
	field: FieldWeights;
	/** Multiplier when both edges of a match are word boundaries. Default 1.3. */
	wholeWordBonus: number;
	/** Maximum multiplier when several distinct terms sit close together. Default 1.4. */
	maxProximityBonus: number;
	/** Character distance at which the proximity bonus has decayed to 1.0. Default 400. */
	proximityWindow: number;
	/** Maximum multiplier for a file modified right now. Default 1.15. */
	maxRecencyBonus: number;
	/** Age in days at which the recency bonus has decayed to 1.0. Default 365. */
	recencyHalfLifeDays: number;
	/** Multiplier applied to a hit whose quality is `fuzzy`. Default 0.7, per plan section 3.1. */
	fuzzyPenalty: number;
	/** Multiplier applied to a hit whose quality is `alias`. Default 0.95. */
	aliasPenalty: number;
}

/** Per-hit score breakdown. Not shown in the UI; exists so ranking regressions are testable. */
export interface ScoreBreakdown {
	base: number;
	fieldContribution: Readonly<Record<MatchField, number>>;
	frequencyFactor: number;
	wholeWordFactor: number;
	proximityFactor: number;
	recencyFactor: number;
	qualityFactor: number;
	total: number;
}

/* ========================================================================== */
/* 7. Snippets                                                                */
/* ========================================================================== */

/**
 * One excerpt around a match.
 *
 * `text` is cut from the ORIGINAL file text, never from the normalized form —
 * that is the whole reason the offset contract exists. Umlauts, casing and
 * markdown appear as the user wrote them.
 *
 * ---------------------------------------------------------------------------
 * AN EXCERPT IS WHOLE LINES, AND STILL ONE CONTIGUOUS SLICE
 * ---------------------------------------------------------------------------
 * The cut runs on LINE boundaries: the line the match sits on plus its
 * neighbours, at most {@link SiftTuning.snippetLines} lines and never leaving
 * the block the match is in. So `text` normally CONTAINS LINE BREAKS — `\n` or
 * `\r\n`, exactly as the file spells them — and the card renders each as a
 * break rather than collapsing it to a space.
 *
 * There is deliberately no separate line list. `text` stays
 * `original.slice(offset, offset + text.length)`: one contiguous range, not a
 * stitched-together set of lines. That is what keeps every offset in this object
 * trivially true — `marks[i]` is relative to `text`, `offset + marks[0].start`
 * is the position in the file, and {@link Snippet.jumpOffset} is exactly that —
 * and it makes the breaks findable in `text` itself, so a second, redundant
 * description of them cannot drift out of step with it. A line too long for the
 * character ceiling is therefore narrowed at its ends rather than folded, so the
 * contiguity holds for a 4 000-character line too.
 */
export interface Snippet {
	/**
	 * The excerpt itself: up to {@link SiftTuning.snippetLines} whole lines,
	 * each at most about {@link SiftTuning.snippetLength} characters.
	 */
	text: string;
	/** Offset of `text[0]` in the original file. */
	offset: OriginalOffset;
	/** Ranges to wrap in `<mark>`, relative to `text`, ordered and non-overlapping. */
	marks: readonly Span[];
	/**
	 * The sentence containing the primary match, relative to `text`. Rendered in
	 * `--text-normal`; everything outside it in `--text-muted`, per the mockup.
	 */
	focus: Span;
	/** Render a leading "…". */
	leadingEllipsis: boolean;
	/** Render a trailing "…". */
	trailingEllipsis: boolean;
	/** Offset in the original file to jump to when this card is opened. Equals the first mark's absolute start. */
	jumpOffset: OriginalOffset;
}

/* ========================================================================== */
/* 8. Settings                                                                */
/* ========================================================================== */

/** UI language. `auto` follows Obsidian's own locale, falling back to `en`. */
export type LanguageSetting = 'auto' | 'en' | 'de';

/** User-facing settings, persisted through `Plugin.saveData()` in `data.json`. Phase 1 only — no AI, no license fields. */
export interface SiftSettings {
	/** Schema of this object, so migrations are possible. */
	version: 1;
	/** Sort order a freshly opened modal starts with. */
	defaultSort: SortKey;
	/** Snippets rendered per result card, 1-3. */
	snippetCount: number;
	/** Frontmatter key read for `createdAt`. Default `'created'`. */
	createdField: string;
	/** Folders never indexed and never searched. */
	excludedFolders: readonly VaultPath[];
	language: LanguageSetting;
	/** Initial state of the "Similar" toggle. Default `false`, per plan section 3.1. */
	fuzzyByDefault: boolean;
	/** Initial state of the "Include subfolders" toggle. Default `true`. */
	includeSubfoldersByDefault: boolean;
	/** Hard cap on rendered hits. Default 200 — the point at which the list virtualizes. */
	maxResults: number;
	/**
	 * Combination that keeps the selected hit, e.g. `Mod+Shift+K`.
	 *
	 * Stored as one string in Obsidian's own modifier spelling, so a vault synced
	 * between macOS and Windows carries one value rather than two. Parsed by
	 * `src/ui/hotkey.ts`, which also decides what is refusable.
	 */
	keepHotkey: string;
	/** Combination that dismisses the selected hit, e.g. `Mod+Shift+X`. */
	dismissHotkey: string;
	/** Rebuild the index from scratch on next load; set by the "Rebuild index" button, cleared by the Indexer. */
	forceRebuild: boolean;
}

/**
 * Constants that are not user-facing but must not be scattered as magic
 * numbers. `settings.ts` exports the frozen default; tests may pass a variant.
 */
export interface SiftTuning {
	/** Trigram size. 3, and the code assumes it. */
	trigramSize: 3;
	/** Terms shorter than this skip the trigram path and use a linear scan. Default 3. */
	minTrigramTermLength: number;
	/** Cap on {@link QueryTerm.variants}. Default 8. */
	maxTermVariants: number;
	/** Longest accepted query string. Default 512. */
	maxQueryLength: number;
	/** Character ceiling for ONE LINE of a snippet. Default 160. A longer line is narrowed around the match. */
	snippetLength: number;
	/** Lines one excerpt may span, the matched line included. Default 5. */
	snippetLines: number;
	/**
	 * Damerau-Levenshtein budget for terms up to `fuzzyShortTermMaxLength`.
	 * Default 1.
	 *
	 * THERE IS NO TRIGRAM-SIMILARITY FLOOR HERE, AND THERE MUST NOT BE ONE AGAIN
	 * -------------------------------------------------------------------------
	 * A `fuzzyTrigramSimilarity` of 0.6 used to sit next to these three. It
	 * measured the SHARE of the term's trigrams a file supplies, and a share is
	 * the wrong shape for this filter: one edit destroys up to three trigrams
	 * whatever the term's length, so the surviving share shrinks as the term gets
	 * shorter. "kaffeemschine" kept 9 of 11 (0.82) and passed; "heizng" kept 2 of
	 * 4 (0.50) and "pmpe" 1 of 2 (0.50), and both were rejected before the
	 * distance check ever ran — which is exactly the bug the owner reported, a
	 * dropped letter finding nothing.
	 *
	 * The trigram pass is a cheap RECALL pre-filter and the distance pass below
	 * is the precision gate, so the pre-filter is now derived from these budgets
	 * instead of from a constant: a word within distance `d` of a term with `t`
	 * trigrams still shares at least `t - 3d` of them. See
	 * `Searcher.sharedTrigramFloor`.
	 */
	fuzzyMaxDistanceShort: number;
	/** Damerau-Levenshtein budget above that length. Default 2. */
	fuzzyMaxDistanceLong: number;
	/** Term length up to which the short budget applies. Default 5. */
	fuzzyShortTermMaxLength: number;
	/** Debounce before a keystroke triggers a search, in ms. Default 120. */
	searchDebounceMs: number;
	/** Time budget per idle slice while indexing, in ms. Default 12. */
	indexSliceMs: number;
	/** Files written to IndexedDB per transaction. Default 200. */
	storeBatchSize: number;
	weights: RankingWeights;
}

/* ========================================================================== */
/* 9. i18n                                                                    */
/* ========================================================================== */

export type LocaleCode = 'en' | 'de';

/**
 * A translation key such as `'search.placeholder'`.
 * `src/i18n/index.ts` narrows this to `keyof typeof en` so a typo is a compile
 * error; the alias exists here only so `types.ts` stays free of imports from
 * JSON.
 */
export type TranslationKey = string;

/** Flat key/value bundle. Nested JSON is flattened at load time. */
export type TranslationBundle = Readonly<Record<string, string>>;

/** Substitution values for `{placeholder}` tokens in a translation. */
export type TranslationParams = Readonly<Record<string, string | number>>;

/* ========================================================================== */
/* 10. Persistence                                                            */
/* ========================================================================== */

/** The single `meta` record in IndexedDB. Decides whether a stored index is usable at all. */
export interface StoreMeta {
	schemaVersion: SchemaVersion;
	/** `this.app.appId`, so two vaults on one machine never share an index. */
	vaultId: string;
	/**
	 * Hash over the settings that change the index content — `createdField` and
	 * `excludedFolders`. A change forces a full rebuild.
	 */
	settingsFingerprint: string;
	/** When the stored index was last fully consistent. */
	builtAt: Millis;
	/** Highest {@link FileId} handed out so far. */
	nextFileId: FileId;
}

/** Minimal staleness record, read without pulling the full text of a file. */
export interface StoredFileStat {
	id: FileId;
	path: VaultPath;
	indexedMtime: Millis;
	size: number;
}

/** Why a stored index was rejected on startup. Reported once, at info level, never with paths. */
export type StoreRejectReason = 'missing' | 'schema-mismatch' | 'vault-mismatch' | 'settings-changed' | 'corrupt' | 'forced';

/** Outcome of loading the persisted index. */
export interface StoreLoadResult {
	/** `null` when the store was rejected; the Indexer then does a cold build. */
	files: IndexedFile[] | null;
	meta: StoreMeta | null;
	reject: StoreRejectReason | null;
}

/* ========================================================================== */
/* 11. UI view models                                                         */
/* ========================================================================== */

/** Live state of the filter bar. Mirrors the chips in `docs/mockup-dark.html`. */
export interface FilterBarState {
	filters: SearchFilters;
	sort: SortKey;
	fuzzy: boolean;
	/**
	 * The note that was open when the overlay was called, `null` when none was.
	 * The "This note" switch reads it, and is not offered without one.
	 */
	activeNote: VaultPath | null;
	/** Rendered as "12 Treffer · 38 ms"; `null` before the first search. */
	summary: SearchSummary | null;
}

/** The counter line in the search header. */
export interface SearchSummary {
	count: number;
	durationMs: number;
	truncated: boolean;
}

/** What the filter bar reports upward. The modal owns the state; the bar is dumb. */
export interface FilterBarCallbacks {
	onFiltersChange(filters: SearchFilters): void;
	onSortChange(sort: SortKey): void;
	onFuzzyChange(fuzzy: boolean): void;
	/**
	 * Completions for the property chip, read from the index: the property names
	 * the vault actually uses when `key` is `null`, and the values recorded under
	 * that key otherwise. Folded, distinct and already filtered by `query`.
	 *
	 * A callback rather than an index handle, so the filter bar keeps knowing
	 * nothing about the Indexer and the suggestions stay testable without one.
	 */
	propertySuggestions(key: string | null, query: string): readonly string[];
}

/** Everything a result card needs. No card ever reaches back into the index. */
export interface ResultCardModel {
	item: ResultItem;
	/** Zero-based position, for `aria-posinset` and the keyboard cursor. */
	index: number;
	selected: boolean;
	/** Localized short date shown top right, e.g. "14.03.2026". */
	dateLabel: string;
	/** Folder path shown under the title, e.g. "Projekte / 2026 / Büro-Umbau". */
	folderLabel: string;
}

/** What a card reports upward. */
export interface ResultCardCallbacks {
	onSelect(index: number): void;
	onOpen(item: ResultItem, target: OpenTarget): void;
}

/** Where `Enter` / `Cmd+Enter` should open a hit. */
export type OpenTarget = 'current' | 'new-tab' | 'split';

/** A request to open a file and put the cursor on a hit. */
export interface OpenRequest {
	path: VaultPath;
	target: OpenTarget;
	/** Offset in the original file text; the modal converts it to a line/ch pair. */
	offset: OriginalOffset;
	/** Length of the match, so the opened file can flash a temporary highlight. */
	length: number;
}

/** Which non-result state the modal shows instead of the list. */
export type EmptyStateKind = 'initial' | 'indexing' | 'no-results' | 'query-error' | 'index-error';
