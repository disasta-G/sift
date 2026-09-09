/**
 * Searcher — candidate retrieval plus verification.
 *
 * Exact path: intersect the postings of a term's trigrams (rarest trigram
 * first), then confirm with a plain indexOf loop over the file's normalized
 * text for each variant. Terms under 3 characters skip trigrams and
 * linear-scan the candidate set. Fuzzy path (opt-in): candidates are files that
 * hold at least {@link Searcher.sharedTrigramFloor} of the term's trigrams,
 * then confirmed with a bounded Damerau-Levenshtein pass against the file's
 * packed word list. Applies folder, subfolder, created and modified filters.
 * Returns every match offset, already mapped to original-file coordinates.
 *
 * ---------------------------------------------------------------------------
 * INTERSECTION IS PER VARIANT, NOT PER TERM
 * ---------------------------------------------------------------------------
 * {@link QueryTerm.trigrams} is the UNION over every variant, so intersecting
 * all of it would ask for a file that contains both spellings at once: the
 * query `kueche` carries `kue|uec|ech|che` from its own spelling and
 * `kuc|uch|che` from the contraction, and a note holding `Küche` (stored
 * `kuche`) has only the second group. The candidate step therefore intersects
 * each variant's own trigrams and unions the results — which is exactly the
 * alias round trip the acceptance tests ask for. The term-level union is still
 * the right set for the fuzzy path, where trigrams are counted rather than
 * required.
 *
 * ---------------------------------------------------------------------------
 * WHITESPACE IN A PHRASE
 * ---------------------------------------------------------------------------
 * A phrase is matched segment by segment, with every gap accepting a RUN of
 * whitespace rather than the single space the user typed. Normalization blanks
 * markdown syntax to U+0020 (see the offset contract in types.ts), so a phrase
 * that sits across a line break, a `**` or a list marker in the source is one
 * whitespace run in the normalized text and has to match. Trigrams that contain
 * whitespace are dropped from the candidate step for the same reason: `e p`
 * would demand exactly one space where the file has a newline.
 *
 * The run may not leave the block it started in, though. A heading line, the
 * frontmatter and a paragraph break are block edges, and the words either side
 * of one are not the phrase the user typed — `"wärme pumpe"` must not match a
 * note whose heading ends on 'Wärme' and whose next paragraph opens with
 * 'Pumpe', nor one whose paragraph ends on 'Wärme' and whose next one opens with
 * 'Pumpe'. The edges come from `frontmatterSpan`, `headings` and `blockBreaks`;
 * see {@link blockBarriers}. The paragraph break is the one that cannot be seen
 * in the folded text at all — there `\n\n` is the same two spaces a blanked `**`
 * leaves — so the Normalizer records its offsets at index time.
 *
 * ---------------------------------------------------------------------------
 * OFFSET DOMAINS
 * ---------------------------------------------------------------------------
 * Body, heading, frontmatter and tag matches are found in `file.text` and
 * mapped to ORIGINAL file offsets through `Normalizer.toOriginalOffset`. Title
 * and path matches are found in `titleNormalized` / `pathNormalized` and stay
 * in those strings — there is no file position to jump to. This is the domain
 * split spelled out on {@link Match} and relied on by Snippets and Ranker.
 *
 * ---------------------------------------------------------------------------
 * A SEARCH WITHOUT A TERM
 * ---------------------------------------------------------------------------
 * A date, a date range or a folder is a question on its own — "what did I write
 * that week", "what is in this project" — so a query with no positive term but
 * an active filter is a valid search and returns every file the filters let
 * through, each with an EMPTY `matches` list. There is no term to look for, so
 * the pass does no trigram work and reads no text: it walks the file records,
 * applies {@link Searcher.passesFilters} and nothing else.
 *
 * Two rules keep that from turning into "dump the vault":
 *
 *  - an active filter is REQUIRED, see {@link hasActiveFilters}. Without one
 *    there is no question, and the caller shows its empty state instead.
 *  - a query of nothing but negations (`-altbau`) is NOT a search by itself. It
 *    carries no filter, and "every note except those" is not something anyone
 *    types on purpose — it would answer a stray `-` with the whole vault. With
 *    a filter beside it the negation does apply, so `-altbau` plus a date range
 *    is "that week, without the Altbau notes".
 *
 * Negations are verified against the file text exactly as on the normal path,
 * NOT pre-filtered through the trigram candidates: alias postings for body
 * words are incomplete for records restored from IndexedDB (see the Indexer
 * header), and a missed candidate there would let an excluded file back INTO
 * the result list rather than merely cost recall.
 *
 * ---------------------------------------------------------------------------
 * QUALITY
 * ---------------------------------------------------------------------------
 * A literal hit of `variants[0]` (the strip fold of what the user typed) is
 * `exact`; a hit of any other variant is `alias`; the fuzzy path produces
 * `fuzzy` and only runs when the literal pass found nothing at all, so an exact
 * occurrence is never downgraded by a near miss elsewhere in the same file.
 * {@link RawHit.quality} is the worst quality across the hit's matches.
 */

import { Indexer } from '../index/Indexer';
import { extractWords, isWordBoundary, toOriginalOffset, wordAt } from '../index/Normalizer';
import { splitPropertyTerm } from './QueryParser';
import type {
	FileId,
	IndexedFile,
	Match,
	MatchField,
	MatchQuality,
	NormalizedDoc,
	PackedWords,
	Postings,
	QueryAst,
	QueryTerm,
	RawHit,
	PropertyFilter,
	SearchFilters,
	SearchOptions,
	SiftTuning,
	Span,
} from '../types';

/* ========================================================================== */
/* 1. Constants and small helpers                                             */
/* ========================================================================== */

/**
 * Upper bound on occurrences kept per term and field in one file.
 *
 * A two-character term in a long note produces tens of thousands of hits, none
 * of which is worth an object: the Ranker's occurrence damping saturates around
 * fifty (`ln n / (ln n + 4)`), and Snippets renders at most three excerpts. The
 * cap therefore costs a fraction of a percent of the score and bounds the
 * memory a pathological query can claim.
 */
const MAX_MATCHES_PER_FIELD = 500;

/** Files scanned between two `AbortSignal` checks. A power of two, so the test is a mask. */
const ABORT_CHECK_INTERVAL = 256;

/**
 * Trigrams one edit can destroy: the three windows that overlap the edited
 * position. The bound the fuzzy pre-filter rests on — see
 * {@link Searcher.sharedTrigramFloor}.
 */
const TRIGRAMS_PER_EDIT = 3;

/** Badness order. `exact` is best, `fuzzy` worst; used for dedup preference and for {@link RawHit.quality}. */
const QUALITY_RANK: Readonly<Record<MatchQuality, number>> = { exact: 0, alias: 1, fuzzy: 2 };

/**
 * The `matches` list of a hit found without a term. One shared frozen array
 * rather than one per hit: a filter-only search over a large vault produces
 * thousands of hits and none of them has anything to put in it.
 */
const NO_MATCHES: readonly Match[] = Object.freeze([]);

/** Whitespace of the normalized text: real spaces, blanked markdown, and the line breaks that survive folding. */
function isSpaceCode(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c;
}

/** Tag-body characters as they appear in strip-folded text: `#Küche/Süd` is stored `kuche/sud`. */
function isTagCode(code: number): boolean {
	return (
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2d ||
		code === 0x5f ||
		code === 0x2f
	);
}

/** Splits a literal at whitespace runs. A word term yields exactly one segment. */
function splitSegments(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (isSpaceCode(text.charCodeAt(i))) {
			i++;
			continue;
		}
		const start = i;
		while (i < text.length && !isSpaceCode(text.charCodeAt(i))) i++;
		out.push(text.slice(start, i));
	}
	return out;
}

/** Distinct trigrams of `text` that contain no whitespace. See the phrase note in the header. */
function solidTrigrams(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i + 3 <= text.length; i++) {
		if (isSpaceCode(text.charCodeAt(i)) || isSpaceCode(text.charCodeAt(i + 1)) || isSpaceCode(text.charCodeAt(i + 2))) {
			continue;
		}
		const gram = text.slice(i, i + 3);
		if (seen.has(gram)) continue;
		seen.add(gram);
		out.push(gram);
	}
	return out;
}

/** Number of file ids in either postings representation. */
function postingsSize(postings: Postings): number {
	return postings instanceof Uint32Array ? postings.length : postings.size;
}

/** Membership in an ascending `Uint32Array`. */
function arrayHasId(sorted: Uint32Array, id: FileId): boolean {
	let low = 0;
	let high = sorted.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const value = sorted[mid];
		if (value === id) return true;
		if (value < id) low = mid + 1;
		else high = mid - 1;
	}
	return false;
}

/** In-place intersection: `working` keeps only the ids `other` also holds. */
function intersectInto(working: Set<FileId>, other: ReadonlySet<FileId>): Set<FileId> {
	for (const id of working) {
		if (!other.has(id)) working.delete(id);
	}
	return working;
}

/**
 * Do these filters ask a question of their own?
 *
 * This is the predicate that decides whether an empty query still runs a search
 * — the Searcher applies it (see the header) and the UI needs the same answer to
 * choose between its empty state and a result list, so it lives here rather than
 * being spelled out twice:
 *
 *   `!ast.isEmpty || hasActiveFilters(filters)`
 *
 * Two deliberate exclusions:
 *
 *  - `excludedFolders` never counts. It comes from the settings, not from the
 *    filter bar; treating it as a filter would turn every empty query into a
 *    listing of the whole vault for anyone who has ever excluded a folder.
 *  - the vault ROOT with subfolders on never counts either — `folder: ''` plus
 *    `includeSubfolders: true` selects everything, which is not a narrowing. The
 *    same root WITHOUT subfolders does count: "only the notes lying loose at the
 *    top" is a real question.
 */
export function hasActiveFilters(filters: SearchFilters): boolean {
	if (filters.createdFrom !== null || filters.createdTo !== null) return true;
	if (filters.modifiedFrom !== null || filters.modifiedTo !== null) return true;
	if (filters.property !== null) return true;
	if (filters.openTasks) return true;
	if (filters.note !== null) return true;
	if (filters.folder === null) return false;
	return trimSlashes(filters.folder.trim()).length > 0 || !filters.includeSubfolders;
}

/**
 * Whether `file` carries the property the filter asks for.
 *
 * Both sides are already folded — the record's keys and values by the Indexer,
 * the filter's by the filter bar — so this is a plain lookup and, when a value
 * is given, a substring test. Substring rather than equality for two reasons: a
 * list-valued property is stored as one joined string, where equality would
 * match nothing; and a value the user types by hand is a fragment far more
 * often than it is the whole entry.
 */
function hasProperty(file: IndexedFile, property: PropertyFilter): boolean {
	const value = file.properties[property.key];
	if (value === undefined) return false;
	if (property.value === null) return true;
	return value.includes(property.value);
}

/** `path` is `folder` itself or sits under it. Segment-aware, so `Projekte` never swallows `Projekte2`. */
function isInside(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}

/** Strips the leading and trailing slashes `normalizePath` leaves on a root-ish path. */
function trimSlashes(path: string): string {
	let start = 0;
	let end = path.length;
	while (start < end && path.charCodeAt(start) === 0x2f) start++;
	while (end > start && path.charCodeAt(end - 1) === 0x2f) end--;
	return path.slice(start, end);
}

/**
 * The two fields `toOriginalOffset` needs, derived from a stored record.
 *
 * {@link IndexedFile} has no `originalLength`, and it does not need one: with no
 * offset map the mapping is the identity and the clamp is `text.length`; with a
 * map the contract puts the original length in its last entry.
 */
function docView(file: IndexedFile): Pick<NormalizedDoc, 'offsetMap' | 'originalLength'> {
	const map = file.offsetMap;
	if (map === null) return { offsetMap: null, originalLength: file.text.length };
	return { offsetMap: map, originalLength: map.length > 0 ? map[map.length - 1] : file.text.length };
}

/** No block edges: the offset domain has none (a title, a path) or the file has no structure. */
const NO_BARRIERS: readonly number[] = [];

/**
 * Offsets a phrase gap may not cross, ascending.
 *
 * Folding turns every line break into U+0020 (the offset contract), so in
 * `file.text` a paragraph break, a heading marker and a blanked `**` are the
 * same run of spaces — which is why a phrase used to match across a heading,
 * across the frontmatter fence and across a blank line. Three sources of edges
 * fix that, and all three are real block boundaries: the frontmatter is not
 * prose, a heading line is a block of its own, and
 * {@link IndexedFile.blockBreaks} carries the blank lines, recorded by the
 * Normalizer while the source was still intact because the fold destroys them.
 *
 * A gap that steps over one of these offsets joins two blocks and is rejected;
 * a phrase INSIDE a heading, inside the frontmatter or inside one paragraph is
 * untouched, because then no edge lies between its segments. What is
 * deliberately NOT an edge is markdown blanked in place — a `**`, a list marker,
 * a single line break inside a paragraph — since the words either side of those
 * do stand next to each other on screen.
 *
 * `blockBreaks` is read defensively: a record restored from a store written
 * before the field existed has none, and the Indexer refuses such a record —
 * but the Searcher is not the place to depend on that.
 */
function blockBarriers(file: IndexedFile): readonly number[] {
	const frontmatter = file.frontmatterSpan;
	const breaks = file.blockBreaks;
	const breakCount = breaks === undefined ? 0 : breaks.length;
	if (frontmatter === null && file.headings.length === 0 && breakCount === 0) return NO_BARRIERS;
	const offsets: number[] = [];
	if (frontmatter !== null) offsets.push(frontmatter.start, frontmatter.end);
	for (const heading of file.headings) offsets.push(heading.span.start, heading.span.end);
	if (breaks !== undefined) {
		for (const offset of breaks) offsets.push(offset);
	}
	offsets.sort((a, b) => a - b);
	return offsets;
}

/** True when at least one barrier sits in the closed range `[from, to]`. Binary search over an ascending list. */
function crossesBarrier(barriers: readonly number[], from: number, to: number): boolean {
	let low = 0;
	let high = barriers.length - 1;
	let candidate = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (barriers[mid] >= from) {
			candidate = barriers[mid];
			high = mid - 1;
		} else {
			low = mid + 1;
		}
	}
	return candidate >= 0 && candidate <= to;
}

/** Worst quality across `matches`; `exact` for an empty list. */
function worstQuality(matches: readonly Match[]): MatchQuality {
	let worst: MatchQuality = 'exact';
	for (const match of matches) {
		if (QUALITY_RANK[match.quality] > QUALITY_RANK[worst]) worst = match.quality;
	}
	return worst;
}

/**
 * Orders matches for the caller and collapses overlaps within one term.
 *
 * Overlapping occurrences of the same term are RESOLVED, not widened: two
 * variants of one term can hit overlapping ranges, and a merged span would no
 * longer be an occurrence of anything — `original.slice(start, end)` has to fold
 * back to a variant, which is what makes "jump to hit" and the `<mark>` ranges
 * correct. The earlier, longer, better-quality occurrence wins; the one it
 * covers is dropped. Matches of DIFFERENT terms may overlap and are kept, since
 * the Ranker scores them per term.
 */
function finalizeMatches(matches: Match[]): Match[] {
	if (matches.length <= 1) return matches;
	matches.sort(
		(a, b) =>
			a.termIndex - b.termIndex ||
			compareText(a.field, b.field) ||
			a.start - b.start ||
			b.end - a.end ||
			QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality],
	);
	const kept: Match[] = [];
	let groupTerm = -1;
	let groupField = '';
	let groupEnd = -1;
	for (const match of matches) {
		if (match.termIndex !== groupTerm || match.field !== groupField) {
			groupTerm = match.termIndex;
			groupField = match.field;
			groupEnd = -1;
		}
		if (match.start < groupEnd) continue;
		kept.push(match);
		groupEnd = match.end;
	}
	kept.sort((a, b) => a.start - b.start || a.end - b.end || a.termIndex - b.termIndex);
	return kept;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/* ========================================================================== */
/* 2. Per-term plan                                                           */
/* ========================================================================== */

/** One literal to look for, prepared once per term instead of once per file. */
interface VariantPlan {
	/** The literal itself. */
	text: string;
	/** Quality a hit of this literal carries: `variants[0]` is the user's own spelling. */
	quality: MatchQuality;
	/** `text` split at whitespace runs. One entry for a word term. */
	segments: readonly string[];
	/** Whitespace-free trigrams, for the candidate step. Deduplicated, which is what lets the fuzzy path count them. */
	grams: readonly string[];
}

/** Everything the scan needs about a term, cached on the term object. */
interface TermPlan {
	variants: readonly VariantPlan[];
	/** True when any variant has more than one segment, i.e. the gap rule can fire. */
	phrase: boolean;
	/**
	 * Damerau-Levenshtein budget for this term's length.
	 *
	 * The distance pass compares against `term.normalized` only: the alias
	 * variants exist to bridge an EXACT spelling difference, and ä/ae is one
	 * edit anyway, so repeating the word scan for each of them would buy nothing.
	 */
	fuzzyBudget: number;
}

/* ========================================================================== */
/* 3. Searcher                                                                */
/* ========================================================================== */

export class Searcher {
	private readonly indexer: Indexer;
	private readonly tuning: SiftTuning;

	/** Prepared literals per term object. Weak, so a superseded AST is collectable. */
	private readonly plans = new WeakMap<QueryTerm, TermPlan>();

	/** Block edges per file record, built on the first phrase query that reaches the file. */
	private readonly barriers = new WeakMap<IndexedFile, readonly number[]>();

	constructor(indexer: Indexer, tuning: SiftTuning) {
		this.indexer = indexer;
		this.tuning = tuning;
	}

	/* ---------------------------------------------------------------------- */
	/* Entry point                                                            */
	/* ---------------------------------------------------------------------- */

	/** Synchronous by design so a search is one microtask; the caller debounces and passes an AbortSignal. */
	search(ast: QueryAst, options: SearchOptions): RawHit[] {
		const signal = options.signal;
		if (signal !== undefined && signal.aborted) return [];
		// No positive term: the filters are the query. The branch tests what this
		// method actually iterates rather than `ast.isEmpty`, which a hand-built
		// AST could contradict.
		if (ast.must.length === 0 && ast.should.length === 0) return this.searchByFilters(ast, options);

		const fuzzy = options.fuzzy;
		const termIndexOf = new Map<QueryTerm, number>();
		for (let i = 0; i < ast.terms.length; i++) termIndexOf.set(ast.terms[i], i);

		/** `null` means "nothing narrowed the set yet"; the scan then walks every file. */
		let working: Set<FileId> | null = null;

		for (const term of ast.must) {
			// A short term has no trigram to narrow with; it is verified by the
			// linear scan below, over whatever the other terms left over.
			if (term.trigrams.length === 0) continue;
			const found = this.candidates(term, fuzzy);
			working = working === null ? found : intersectInto(working, found);
			if (working.size === 0) return [];
			if (signal !== undefined && signal.aborted) return [];
		}

		for (const group of ast.should) {
			const union = new Set<FileId>();
			let unbounded = false;
			for (const term of group) {
				if (term.trigrams.length === 0) {
					// One unbounded alternative makes the whole OR group unbounded.
					unbounded = true;
					break;
				}
				for (const id of this.candidates(term, fuzzy)) union.add(id);
			}
			if (unbounded) continue;
			working = working === null ? union : intersectInto(working, union);
			if (working.size === 0) return [];
			if (signal !== undefined && signal.aborted) return [];
		}

		const source: Iterable<IndexedFile> =
			working === null ? this.indexer.allFiles() : this.filesById(working);

		const hits: RawHit[] = [];
		let seen = 0;
		for (const file of source) {
			seen++;
			if (signal !== undefined && (seen & (ABORT_CHECK_INTERVAL - 1)) === 0 && signal.aborted) return [];
			// Filters first: a query made only of short terms would otherwise
			// scan the text of files the user has filtered away.
			if (!this.passesFilters(file, options.filters)) continue;

			const matches: Match[] = [];
			let matched = true;

			for (const term of ast.must) {
				const found = this.verify(term, file, termIndexOf.get(term) ?? 0, fuzzy);
				if (found.length === 0) {
					matched = false;
					break;
				}
				for (const match of found) matches.push(match);
			}
			if (!matched) continue;

			for (const group of ast.should) {
				let any = false;
				for (const term of group) {
					const found = this.verify(term, file, termIndexOf.get(term) ?? 0, fuzzy);
					if (found.length === 0) continue;
					any = true;
					for (const match of found) matches.push(match);
				}
				if (!any) {
					matched = false;
					break;
				}
			}
			if (!matched) continue;

			for (const term of ast.mustNot) {
				// Never fuzzy: a near miss must not remove a file the user never typed.
				if (this.verify(term, file, -1, false).length > 0) {
					matched = false;
					break;
				}
			}
			if (!matched) continue;

			const finalized = finalizeMatches(matches);
			if (finalized.length === 0) continue;
			hits.push({
				fileId: file.id,
				path: file.path,
				title: file.title,
				folder: file.folder,
				createdAt: file.createdAt,
				modifiedAt: file.modifiedAt,
				matches: finalized,
				quality: worstQuality(finalized),
			});
		}
		return hits;
	}

	/**
	 * The term-less pass: every file the filters let through, with no matches.
	 *
	 * A scan over the file records and nothing else — no candidate step, no
	 * trigram intersection, no text read — because there is no literal to look
	 * for. That is what keeps a date-range-only search inside the search budget
	 * on a large vault: the per-file cost is {@link Searcher.passesFilters}, a
	 * handful of comparisons.
	 *
	 * `ast.mustNot` still applies, and it is verified against the file text the
	 * same way the normal path does it; see the header for why the trigram
	 * candidates must not be used to skip that check. Files the filters already
	 * rejected are never verified, so `-altbau` with a folder filter reads only
	 * the folder.
	 */
	private searchByFilters(ast: QueryAst, options: SearchOptions): RawHit[] {
		// Filters alone are a search; negations alone are not. See the header.
		if (!hasActiveFilters(options.filters)) return [];
		const signal = options.signal;
		const hits: RawHit[] = [];
		let seen = 0;
		for (const file of this.indexer.allFiles()) {
			seen++;
			if (signal !== undefined && (seen & (ABORT_CHECK_INTERVAL - 1)) === 0 && signal.aborted) return [];
			if (!this.passesFilters(file, options.filters)) continue;

			let excluded = false;
			for (const term of ast.mustNot) {
				// Never fuzzy: a near miss must not remove a file the user never typed.
				if (this.verify(term, file, -1, false).length > 0) {
					excluded = true;
					break;
				}
			}
			if (excluded) continue;

			hits.push({
				fileId: file.id,
				path: file.path,
				title: file.title,
				folder: file.folder,
				createdAt: file.createdAt,
				modifiedAt: file.modifiedAt,
				matches: NO_MATCHES,
				// Nothing was matched, so nothing was approximated either. `exact`
				// is what `worstQuality` reports for an empty list and it keeps the
				// hit out of the Ranker's fuzzy tier.
				quality: 'exact',
			});
		}
		return hits;
	}

	/* ---------------------------------------------------------------------- */
	/* Candidates                                                             */
	/* ---------------------------------------------------------------------- */

	/** Trigram intersection, or similarity-based expansion when `fuzzy`. Empty term.trigrams -> full candidate set (linear scan). */
	candidates(term: QueryTerm, fuzzy: boolean): Set<FileId> {
		// A property term is answered from the record's own property map, not from
		// the body text, and its trigrams describe `status=offen` — a string that
		// appears in no note, since the file spells it `status: offen`. Narrowing
		// by them would return nothing at all, so this one field linear-scans, the
		// way a term-less filter search already does.
		if (term.field === 'property') return this.allIds();
		if (term.trigrams.length === 0) return this.allIds();
		const plan = this.planFor(term);
		if (fuzzy && term.fuzzyEligible) return this.fuzzyCandidates(plan);

		const out = new Set<FileId>();
		for (const variant of plan.variants) {
			// A variant with no usable trigram (a contraction below three
			// characters, a phrase of very short words) cannot narrow anything.
			if (variant.grams.length === 0) return this.allIds();
			for (const id of this.intersectPostings(variant.grams)) out.add(id);
		}
		return out;
	}

	/** Every indexed file id. The linear-scan fallback. */
	private allIds(): Set<FileId> {
		const out = new Set<FileId>();
		for (const file of this.indexer.allFiles()) out.add(file.id);
		return out;
	}

	private *filesById(ids: Iterable<FileId>): IterableIterator<IndexedFile> {
		for (const id of ids) {
			const file = this.indexer.getFile(id);
			if (file !== undefined) yield file;
		}
	}

	/**
	 * Files holding every one of `grams`.
	 *
	 * The rarest posting list seeds the working set and the rest only shrink it,
	 * so the loop touches the smallest possible number of ids: a query whose
	 * rarest trigram occurs in four files never looks at the thousands of files
	 * behind its most common one.
	 */
	private intersectPostings(grams: readonly string[]): Set<FileId> {
		const lists: Postings[] = [];
		for (const gram of grams) {
			const postings = this.indexer.getPostings(gram);
			// A trigram nothing holds makes the intersection empty.
			if (postings === undefined) return new Set<FileId>();
			lists.push(postings);
		}
		if (lists.length === 0) return new Set<FileId>();
		lists.sort((a, b) => postingsSize(a) - postingsSize(b));

		const working = new Set<FileId>(lists[0] as Iterable<FileId>);
		for (let i = 1; i < lists.length && working.size > 0; i++) {
			const next = lists[i];
			if (next instanceof Uint32Array) {
				const sorted = Indexer.postingsToArray(next);
				for (const id of working) {
					if (!arrayHasId(sorted, id)) working.delete(id);
				}
			} else {
				for (const id of working) {
					if (!next.has(id)) working.delete(id);
				}
			}
		}
		return working;
	}

	/**
	 * Files that hold enough of the term's trigrams to be worth a distance pass.
	 *
	 * WHY A COUNT AND NOT A SHARE
	 * ---------------------------
	 * This used to be a Jaccard against `tuning.fuzzyTrigramSimilarity` (0.6).
	 * Because the file only ever contributes a SUBSET of the term's own trigrams,
	 * that Jaccard reduced to the share of the term a file supplies — and a
	 * constant share is the wrong shape for the filter, because one edit destroys
	 * up to three trigrams no matter how long the word is. The share that
	 * survives therefore depends on the term's length, and short terms lost:
	 * "kaffeemschine" kept 9 of 11 (0.82) and passed, while "heizng" kept 2 of 4
	 * and "pmpe" 1 of 2 (both 0.50) and were thrown away before the distance
	 * check ever ran. That is the reported bug — "Similar" finding nothing for a
	 * dropped letter — and tuning a RECALL pre-filter tight enough to lose true
	 * positives is backwards.
	 *
	 * The floor is now the bound the distance budget itself implies, see
	 * {@link Searcher.sharedTrigramFloor}. When that bound is not positive it
	 * excludes nothing, so the variant contributes every file and the
	 * Damerau-Levenshtein pass — the precision gate — decides alone.
	 */
	private fuzzyCandidates(plan: TermPlan): Set<FileId> {
		const out = new Set<FileId>();
		for (const variant of plan.variants) {
			const required = Searcher.sharedTrigramFloor(variant.grams.length, plan.fuzzyBudget);
			if (required <= 0) return this.allIds();
			// One posting per (trigram, file), and `grams` is deduplicated, so
			// counting visits is counting the distinct trigrams the file holds.
			const held = new Map<FileId, number>();
			for (const gram of variant.grams) {
				const postings = this.indexer.getPostings(gram);
				if (postings === undefined) continue;
				for (const id of postings as Iterable<FileId>) {
					const count = (held.get(id) ?? 0) + 1;
					held.set(id, count);
					if (count >= required) out.add(id);
				}
			}
		}
		return out;
	}

	/* ---------------------------------------------------------------------- */
	/* Verification                                                           */
	/* ---------------------------------------------------------------------- */

	/** All occurrences of `term` in `file`, offsets already mapped to the original text. Empty array = term did not match. */
	verify(term: QueryTerm, file: IndexedFile, termIndex: number, fuzzy: boolean): Match[] {
		const out: Match[] = [];
		if (term.normalized.length === 0) return out;
		const plan = this.planFor(term);

		switch (term.field) {
			case 'title':
				this.collectPlain(file.titleNormalized, 'title', plan, termIndex, out);
				break;
			case 'path':
				this.collectPlain(file.pathNormalized, 'path', plan, termIndex, out);
				break;
			case 'property':
				this.collectProperty(term, file, termIndex, out);
				break;
			case 'tag':
				this.collectTags(file, plan, termIndex, out);
				break;
			default:
				// An unrestricted term is looked for everywhere the file can be
				// addressed: its text, its name and its location.
				this.collectBody(file, plan, termIndex, out);
				this.collectPlain(file.titleNormalized, 'title', plan, termIndex, out);
				this.collectPlain(file.pathNormalized, 'path', plan, termIndex, out);
				break;
		}

		if (out.length === 0 && fuzzy && term.fuzzyEligible) {
			this.collectFuzzy(term, file, plan, termIndex, out);
		}
		return out;
	}

	/**
	 * A `prop:` term, answered from the record's property map.
	 *
	 * The match it reports is the property's own name inside the frontmatter, so
	 * the excerpt shows why the note is in the list and the Ranker weights the hit
	 * like any other frontmatter hit. A property whose name cannot be located in
	 * the text still matches — the map is the truth here — and reports the head of
	 * the file rather than a span that would send the excerpt somewhere arbitrary.
	 */
	private collectProperty(term: QueryTerm, file: IndexedFile, termIndex: number, out: Match[]): void {
		const { key, value } = splitPropertyTerm(term.normalized);
		if (key.length === 0) return;
		const stored = file.properties[key];
		if (stored === undefined) return;
		if (value !== null && !stored.includes(value)) return;

		const span = file.frontmatterSpan;
		const view = docView(file);
		let start = span === null ? -1 : file.text.indexOf(key, span.start);
		let end = start + key.length;
		if (start < 0 || span === null || end > span.end) {
			start = 0;
			end = Math.min(1, file.text.length);
		}
		if (end <= start) return;
		out.push({
			start: toOriginalOffset(view, start),
			end: toOriginalOffset(view, end),
			field: 'frontmatter',
			termIndex,
			// The whole property name was matched, never a fragment of a longer
			// word, and a map lookup is as exact as a match gets.
			wholeWord: true,
			quality: 'exact',
		});
	}

	/** Literal occurrences in `file.text`, field decided per hit, offsets mapped to the original file. */
	private collectBody(file: IndexedFile, plan: TermPlan, termIndex: number, out: Match[]): void {
		const text = file.text;
		if (text.length === 0) return;
		const view = docView(file);
		const barriers = plan.phrase ? this.barriersFor(file) : NO_BARRIERS;
		for (const variant of plan.variants) {
			scanVariant(
				text,
				variant,
				(start, end) => {
					out.push({
						start: toOriginalOffset(view, start),
						end: toOriginalOffset(view, end),
						field: Searcher.fieldAt(file, start),
						termIndex,
						wholeWord: isWordBoundary(text, start) && isWordBoundary(text, end),
						quality: variant.quality,
					});
				},
				barriers,
			);
		}
	}

	/** Block edges of one file, computed once and kept for as long as the record lives. */
	private barriersFor(file: IndexedFile): readonly number[] {
		const cached = this.barriers.get(file);
		if (cached !== undefined) return cached;
		const built = blockBarriers(file);
		this.barriers.set(file, built);
		return built;
	}

	/** Literal occurrences in a title or path string. Offsets stay in that string — see the domain note on {@link Match}. */
	private collectPlain(
		haystack: string,
		field: MatchField,
		plan: TermPlan,
		termIndex: number,
		out: Match[],
	): void {
		if (haystack.length === 0) return;
		for (const variant of plan.variants) {
			scanVariant(haystack, variant, (start, end) => {
				out.push({
					start,
					end,
					field,
					termIndex,
					wholeWord: isWordBoundary(haystack, start) && isWordBoundary(haystack, end),
					quality: variant.quality,
				});
			});
		}
	}

	/**
	 * Occurrences of a `tag:` term.
	 *
	 * `file.tags` decides WHETHER the file matches — it is the authority, and it
	 * already carries the frontmatter list and the inline `#tag`s in folded form.
	 * The offsets then come from the text, because a tag match has to be jumpable
	 * like any other body match. An occurrence counts when the run of tag
	 * characters around it is one of the file's tags, which is what keeps the
	 * word `protokoll` in a sentence from being reported as the tag `protokoll`.
	 * Should the tag be unfindable in the text — a spelling the scanner rewrote —
	 * the plain occurrences stand in, so a tag hit is never lost entirely.
	 */
	private collectTags(file: IndexedFile, plan: TermPlan, termIndex: number, out: Match[]): void {
		if (file.tags.length === 0) return;
		const hitting: VariantPlan[] = [];
		for (const variant of plan.variants) {
			for (const tag of file.tags) {
				if (tag.indexOf(variant.text) >= 0) {
					hitting.push(variant);
					break;
				}
			}
		}
		if (hitting.length === 0) return;

		const text = file.text;
		const view = docView(file);
		const barriers = plan.phrase ? this.barriersFor(file) : NO_BARRIERS;
		const anchored: Match[] = [];
		const loose: Match[] = [];
		for (const variant of hitting) {
			scanVariant(
				text,
				variant,
				(start, end) => {
					const match: Match = {
						start: toOriginalOffset(view, start),
						end: toOriginalOffset(view, end),
						field: 'tag',
						termIndex,
						wholeWord: isWordBoundary(text, start) && isWordBoundary(text, end),
						quality: variant.quality,
					};
					if (isTagOccurrence(text, start, end, file.tags)) anchored.push(match);
					else loose.push(match);
				},
				barriers,
			);
		}
		for (const match of anchored.length > 0 ? anchored : loose) out.push(match);
	}

	/* ---------------------------------------------------------------------- */
	/* Fuzzy                                                                  */
	/* ---------------------------------------------------------------------- */

	/** Words within the distance budget, confirmed against the file's own vocabulary. */
	private collectFuzzy(
		term: QueryTerm,
		file: IndexedFile,
		plan: TermPlan,
		termIndex: number,
		out: Match[],
	): void {
		switch (term.field) {
			case 'title':
				this.emitFuzzyIn(file.titleNormalized, 'title', term, plan, termIndex, out);
				break;
			case 'path':
				this.emitFuzzyIn(file.pathNormalized, 'path', term, plan, termIndex, out);
				break;
			case 'tag':
				this.emitFuzzyTags(file, term, plan, termIndex, out);
				break;
			default: {
				const words = this.fuzzyWords(file.words, term.normalized, plan);
				if (words.length > 0) {
					const text = file.text;
					const view = docView(file);
					for (const word of words) {
						emitWordOccurrences(text, word, (start, end) => {
							out.push({
								start: toOriginalOffset(view, start),
								end: toOriginalOffset(view, end),
								field: Searcher.fieldAt(file, start),
								termIndex,
								wholeWord: true,
								quality: 'fuzzy',
								matchedText: word,
							});
						});
					}
				}
				// A typo in the query should still find a file whose NAME carries
				// the word; the body word list does not contain the filename.
				if (out.length === 0) {
					this.emitFuzzyIn(file.titleNormalized, 'title', term, plan, termIndex, out);
				}
				break;
			}
		}
	}

	/** Fuzzy pass over a title or path string; offsets stay in that string. */
	private emitFuzzyIn(
		haystack: string,
		field: MatchField,
		term: QueryTerm,
		plan: TermPlan,
		termIndex: number,
		out: Match[],
	): void {
		if (haystack.length === 0) return;
		const words = this.fuzzyWords(extractWords(haystack), term.normalized, plan);
		for (const word of words) {
			emitWordOccurrences(haystack, word, (start, end) => {
				out.push({
					start,
					end,
					field,
					termIndex,
					wholeWord: true,
					quality: 'fuzzy',
					matchedText: word,
				});
			});
		}
	}

	/** Fuzzy pass over the file's tags, located in the text the same way {@link collectTags} does. */
	private emitFuzzyTags(
		file: IndexedFile,
		term: QueryTerm,
		plan: TermPlan,
		termIndex: number,
		out: Match[],
	): void {
		if (file.tags.length === 0) return;
		const text = file.text;
		const view = docView(file);
		for (const tag of file.tags) {
			if (!isWithinBudget(tag, term.normalized, plan.fuzzyBudget)) continue;
			emitWordOccurrences(text, tag, (start, end) => {
				if (!isTagOccurrence(text, start, end, file.tags)) return;
				out.push({
					start: toOriginalOffset(view, start),
					end: toOriginalOffset(view, end),
					field: 'tag',
					termIndex,
					wholeWord: true,
					quality: 'fuzzy',
					matchedText: tag,
				});
			});
		}
	}

	/** Distinct words of `words` within the distance budget of `needle`. */
	private fuzzyWords(words: PackedWords, needle: string, plan: TermPlan): string[] {
		const out: string[] = [];
		for (let i = 0; i < words.count; i++) {
			const word = wordAt(words, i);
			if (!isWithinBudget(word, needle, plan.fuzzyBudget)) continue;
			if (out.indexOf(word) < 0) out.push(word);
		}
		return out;
	}

	/* ---------------------------------------------------------------------- */
	/* Filters                                                                */
	/* ---------------------------------------------------------------------- */

	passesFilters(file: IndexedFile, filters: SearchFilters): boolean {
		// Excluded folders win over everything, including an explicit folder
		// filter that points straight into one of them.
		for (const raw of filters.excludedFolders) {
			if (typeof raw !== 'string') continue;
			const folder = trimSlashes(raw.trim());
			if (folder.length === 0) continue;
			if (isInside(file.path, folder)) return false;
		}

		if (filters.folder !== null) {
			const folder = trimSlashes(filters.folder.trim());
			if (folder.length === 0) {
				// The vault root: everything with subfolders, only the root's own
				// files without them.
				if (!filters.includeSubfolders && file.folder !== '') return false;
			} else if (filters.includeSubfolders) {
				if (!isInside(file.folder, folder)) return false;
			} else if (file.folder !== folder) {
				return false;
			}
		}

		if (filters.createdFrom !== null && file.createdAt < filters.createdFrom) return false;
		if (filters.createdTo !== null && file.createdAt > filters.createdTo) return false;
		if (filters.modifiedFrom !== null && file.modifiedAt < filters.modifiedFrom) return false;
		if (filters.modifiedTo !== null && file.modifiedAt > filters.modifiedTo) return false;
		if (filters.property !== null && !hasProperty(file, filters.property)) return false;
		if (filters.openTasks && !file.hasOpenTask) return false;
		// One note, by path: the narrowest filter there is, and the only one that
		// can make the whole vault irrelevant, so it is worth testing early.
		if (filters.note !== null && file.path !== filters.note) return false;
		return true;
	}

	/* ---------------------------------------------------------------------- */
	/* Plans                                                                  */
	/* ---------------------------------------------------------------------- */

	private planFor(term: QueryTerm): TermPlan {
		const cached = this.plans.get(term);
		if (cached !== undefined) return cached;

		const variants: VariantPlan[] = [];
		const seen = new Set<string>();
		for (const text of term.variants) {
			if (text.length === 0 || seen.has(text)) continue;
			seen.add(text);
			variants.push({
				text,
				// `variants[0] === normalized` is the parser's contract: the
				// user's own spelling is the one that counts as exact.
				quality: text === term.normalized ? 'exact' : 'alias',
				segments: splitSegments(text),
				grams: solidTrigrams(text),
			});
		}

		const plan: TermPlan = {
			variants,
			phrase: variants.some((variant) => variant.segments.length > 1),
			fuzzyBudget:
				term.normalized.length <= this.tuning.fuzzyShortTermMaxLength
					? this.tuning.fuzzyMaxDistanceShort
					: this.tuning.fuzzyMaxDistanceLong,
		};
		this.plans.set(term, plan);
		return plan;
	}

	/* ---------------------------------------------------------------------- */
	/* Static helpers                                                         */
	/* ---------------------------------------------------------------------- */

	/**
	 * How many of a term's `trigramCount` trigrams a file must hold before it is
	 * worth a distance pass, given the Damerau-Levenshtein budget `maxDistance`.
	 *
	 * One edit touches at most three trigrams — the ones that span the edited
	 * position — so a word within distance `d` of the term still shares at least
	 * `t - 3d` of the term's trigrams. That bound, and nothing tighter, is what
	 * the pre-filter may assume.
	 *
	 * A result of zero or less is not a floor of one: it means the bound excludes
	 * nothing, which is the honest answer for a short term. `heizng` has 4
	 * trigrams and a budget of 2, so `4 - 6` proves nothing, and `pupe` (`pup`,
	 * `upe`) shares NO trigram at all with the `pumpe` it is one deletion from —
	 * a floor of one would still lose it. The caller then skips the pre-filter
	 * for that variant rather than filtering on a bound it does not have.
	 */
	static sharedTrigramFloor(trigramCount: number, maxDistance: number): number {
		if (!Number.isFinite(trigramCount) || !Number.isFinite(maxDistance)) return 0;
		return trigramCount - TRIGRAMS_PER_EDIT * Math.max(0, maxDistance);
	}

	/**
	 * Banded Damerau-Levenshtein. Returns the distance, or maxDistance + 1 as
	 * soon as the band is exceeded.
	 *
	 * Optimal string alignment: an adjacent transposition costs 1, and a
	 * transposed pair is not edited again afterwards — the variant spell checkers
	 * use, and the one the plan's `form`/`from` = 1 example describes. Only the
	 * cells within `maxDistance` of the diagonal are computed, and a row whose
	 * best cell already exceeds the budget ends the whole comparison: no row
	 * below it can come back down, because every value is at least its
	 * predecessor's minimum.
	 */
	static damerauLevenshteinWithin(a: string, b: string, maxDistance: number): number {
		const over = maxDistance + 1;
		if (maxDistance < 0) return a === b ? 0 : over;
		const lengthA = a.length;
		const lengthB = b.length;
		if (Math.abs(lengthA - lengthB) > maxDistance) return over;
		if (lengthA === 0) return lengthB <= maxDistance ? lengthB : over;
		if (lengthB === 0) return lengthA <= maxDistance ? lengthA : over;

		// Three rolling rows: the transposition rule reads two rows back.
		let beforePrevious = new Array<number>(lengthB + 1).fill(over);
		let previous = new Array<number>(lengthB + 1).fill(over);
		let current = new Array<number>(lengthB + 1).fill(over);
		for (let j = 0; j <= Math.min(lengthB, maxDistance); j++) previous[j] = j;

		for (let i = 1; i <= lengthA; i++) {
			const from = Math.max(1, i - maxDistance);
			const to = Math.min(lengthB, i + maxDistance);
			current.fill(over);
			if (i <= maxDistance) current[0] = i;
			let best = over;
			const codeA = a.charCodeAt(i - 1);
			for (let j = from; j <= to; j++) {
				const cost = codeA === b.charCodeAt(j - 1) ? 0 : 1;
				let value = previous[j] + 1;
				const insertion = current[j - 1] + 1;
				if (insertion < value) value = insertion;
				const substitution = previous[j - 1] + cost;
				if (substitution < value) value = substitution;
				if (i > 1 && j > 1 && codeA === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
					const transposition = beforePrevious[j - 2] + cost;
					if (transposition < value) value = transposition;
				}
				if (value > over) value = over;
				current[j] = value;
				if (value < best) best = value;
			}
			if (best > maxDistance) return over;
			const spare = beforePrevious;
			beforePrevious = previous;
			previous = current;
			current = spare;
		}
		const distance = previous[lengthB];
		return distance <= maxDistance ? distance : over;
	}

	/** Which field an offset falls into, from frontmatterSpan and the heading spans. Binary search. */
	static fieldAt(file: IndexedFile, offset: number): MatchField {
		const frontmatter = file.frontmatterSpan;
		if (frontmatter !== null && offset >= frontmatter.start && offset < frontmatter.end) return 'frontmatter';
		const headings = file.headings;
		let low = 0;
		let high = headings.length - 1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			const span = headings[mid].span;
			if (offset < span.start) high = mid - 1;
			else if (offset >= span.end) low = mid + 1;
			else return 'heading';
		}
		return 'body';
	}
}

/* ========================================================================== */
/* 4. Scanning                                                                */
/* ========================================================================== */

/**
 * Every occurrence of one literal, left to right.
 *
 * The cursor advances past the end of a hit rather than by one character, so a
 * literal is never reported inside its own previous occurrence — `aa` in `aaaa`
 * is two hits, not three, and the two do not overlap.
 */
function scanVariant(
	haystack: string,
	variant: VariantPlan,
	onHit: (start: number, end: number) => void,
	barriers: readonly number[] = NO_BARRIERS,
): void {
	if (variant.segments.length === 0) return;
	let from = 0;
	let emitted = 0;
	while (from <= haystack.length) {
		const found = findOccurrence(haystack, variant, from, barriers);
		if (found === null) return;
		onHit(found.start, found.end);
		emitted++;
		if (emitted >= MAX_MATCHES_PER_FIELD) return;
		from = found.end > found.start ? found.end : found.start + 1;
	}
}

/**
 * One occurrence at or after `from`, with whitespace runs accepted between
 * phrase segments — but never a run that steps over a block edge in
 * `barriers`. See {@link blockBarriers}.
 */
function findOccurrence(
	haystack: string,
	variant: VariantPlan,
	from: number,
	barriers: readonly number[] = NO_BARRIERS,
): Span | null {
	const segments = variant.segments;
	const first = segments[0];
	if (segments.length === 1) {
		const at = haystack.indexOf(first, from);
		return at < 0 ? null : { start: at, end: at + first.length };
	}
	let search = from;
	for (;;) {
		const start = haystack.indexOf(first, search);
		if (start < 0) return null;
		let cursor = start + first.length;
		let complete = true;
		for (let s = 1; s < segments.length; s++) {
			let gap = cursor;
			while (gap < haystack.length && isSpaceCode(haystack.charCodeAt(gap))) gap++;
			// The gap has to exist: a phrase never matches two words run together.
			if (gap === cursor || !haystack.startsWith(segments[s], gap)) {
				complete = false;
				break;
			}
			// ... and it has to stay inside one block: the words either side of a
			// heading or a frontmatter fence are not the phrase the user typed.
			if (barriers.length > 0 && crossesBarrier(barriers, cursor, gap)) {
				complete = false;
				break;
			}
			cursor = gap + segments[s].length;
		}
		if (complete) return { start, end: cursor };
		search = start + 1;
	}
}

/** Every whole-word occurrence of `word`. The fuzzy path emits words, so a hit inside a longer word is not one. */
function emitWordOccurrences(haystack: string, word: string, onHit: (start: number, end: number) => void): void {
	if (word.length === 0) return;
	let from = 0;
	let emitted = 0;
	while (from <= haystack.length) {
		const at = haystack.indexOf(word, from);
		if (at < 0) return;
		const end = at + word.length;
		if (isWordBoundary(haystack, at) && isWordBoundary(haystack, end)) {
			onHit(at, end);
			emitted++;
			if (emitted >= MAX_MATCHES_PER_FIELD) return;
		}
		from = end;
	}
}

/**
 * Length gate, then the bounded distance itself.
 *
 * No trigram gate here: the similarity floor is the CANDIDATE filter and has
 * already been applied to the file. Repeating it per word would silently
 * override the distance budget — a single substitution in the middle of a
 * six-letter word leaves one shared trigram out of seven, far below the floor,
 * although it is one edit and well within budget.
 */
function isWithinBudget(word: string, needle: string, budget: number): boolean {
	if (word.length === 0) return false;
	if (Math.abs(word.length - needle.length) > budget) return false;
	return Searcher.damerauLevenshteinWithin(word, needle, budget) <= budget;
}

/** True when the run of tag characters around `[start, end)` is one of the file's tags. */
function isTagOccurrence(text: string, start: number, end: number, tags: readonly string[]): boolean {
	let runStart = start;
	while (runStart > 0 && isTagCode(text.charCodeAt(runStart - 1))) runStart--;
	let runEnd = end;
	while (runEnd < text.length && isTagCode(text.charCodeAt(runEnd))) runEnd++;
	return tags.indexOf(text.slice(runStart, runEnd)) >= 0;
}
