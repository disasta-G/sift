/**
 * Snippets — builds the 1-3 excerpts per card.
 *
 * Reads the ORIGINAL text through vault.cachedRead (the normalized text is
 * never shown to the user), cuts up to five whole LINES around the best-spread
 * matches, snaps the edges to word boundaries, marks the match ranges and
 * identifies the sentence around the primary match so the card can render it
 * in --text-normal while the rest stays --text-muted. Runs for the visible
 * window only, which is why it is async.
 *
 * ---------------------------------------------------------------------------
 * WHY LINES AND NOT A CHARACTER WINDOW
 * ---------------------------------------------------------------------------
 * The excerpt used to be a `snippetLength`-wide window centred on the match,
 * which shows the hit but not what it is part of: a list item without its list,
 * half a sentence, a value without the line that names it. The owner asked to
 * see the hit IN CONTEXT, so the cut now runs on line boundaries — the line the
 * match sits on plus its neighbours, at most {@link SiftTuning.snippetLines}
 * lines, and still clamped to the block the match is in.
 *
 * Three rules keep that from swallowing the list:
 *
 *  - LINES AFTER BEAT LINES BEFORE. A hit usually introduces what follows, so
 *    the spare budget is split with the remainder going downward, and whatever
 *    one side cannot use (the match is on the block's first line, say) goes to
 *    the other.
 *  - A CHARACTER CEILING OF `snippetLength` PER LINE SHOWN. A note written one
 *    paragraph per line is a single 4 000-character line, and five of those
 *    would be the whole note. Context lines are dropped from the far end first;
 *    a single line that is still too long is narrowed around the match, which is
 *    the one case an excerpt does not begin and end on a line boundary.
 *  - `snippetCount` STILL APPLIES. Five lines is the size of ONE excerpt, not a
 *    replacement for the 1-3 excerpts a card shows.
 *
 * The excerpt stays ONE CONTIGUOUS SLICE of the file — see the note on
 * {@link Snippet} — so every offset in the result keeps meaning what it did.
 * The line structure is therefore carried by `text` itself, which now holds the
 * file's own `\n` (or `\r\n`) where the breaks are; the card renders those as
 * breaks instead of collapsing them to a space. No second, redundant list of
 * line spans exists that could drift out of step with the text.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORIGINAL TEXT AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 * A {@link Match} for a body, heading, frontmatter or tag field carries offsets
 * into the file as it sits on disk — that is the whole point of the offset
 * contract in `types.ts`. So every slice taken here comes from the string
 * `cachedRead` returned, and nothing in this module folds, lower-cases or
 * otherwise touches it: 'Küche' is rendered as 'Küche', never as 'kuche'.
 *
 * Two consequences:
 *
 *  - `'title'` and `'path'` matches are dropped. Their offsets index
 *    `titleNormalized` / `pathNormalized`, so slicing the file with them would
 *    highlight an arbitrary substring. The Ranker still scores them.
 *  - If the file changed between indexing and the read, the offsets no longer
 *    describe this text. The record's normalized text is offset-parallel to the
 *    file, so a differing length is proof of exactly that, and the hit renders
 *    without snippets instead of with marks over the wrong words. The next
 *    `modify` event re-indexes the file and the following render is correct.
 *
 * ---------------------------------------------------------------------------
 * WORD CHARACTERS
 * ---------------------------------------------------------------------------
 * `Normalizer.isWordBoundary` is deliberately NOT reused: it is defined over
 * folded text, where a word character is `[a-z0-9]`. Against the original text
 * that would call every capital and every umlaut a boundary and let a snippet
 * start in the middle of 'Küche'. This module therefore carries its own
 * Unicode-aware predicate.
 *
 * ---------------------------------------------------------------------------
 * ONE BLOCK PER EXCERPT
 * ---------------------------------------------------------------------------
 * The window is cut around the match, so on its own it would happily run
 * backwards out of the paragraph and into whatever precedes it. Real output
 * before this was clamped: '…2026-01-21 --- # Ausstattung Pausenraum
 * Wunschliste Mitarbeitende: eine Espressomaschine…' — a date from the
 * frontmatter, the closing fence and a heading, glued in front of the sentence
 * that actually matched. So the window is clamped to the BLOCK the match sits
 * in: the frontmatter, a single heading line, or a run of lines between blank
 * lines. A match inside the frontmatter or inside a heading is perfectly
 * legitimate and gets an excerpt of that block; what stops is the spill-over
 * from one block into the next. The cluster itself is never clipped — if a
 * match spans an edge, the excerpt still contains all of it.
 */

import type { App } from 'obsidian';
import type { IndexedFile, Match, RankedHit, ResultItem, SiftTuning, Snippet, Span } from '../types';
import type { Indexer } from '../index/Indexer';

/* ========================================================================== */
/* 1. Constants                                                               */
/* ========================================================================== */

/**
 * How far apart two matches may sit and still share one snippet, measured from
 * the start of the cluster. It equals the default `snippetLength`, so a cluster
 * always fits inside one excerpt.
 *
 * It is a module constant rather than a tuning value because
 * {@link Snippets.selectMatches} is static — grouping only has to be roughly
 * right, while the cut itself does use `tuning.snippetLength`.
 */
const CLUSTER_WINDOW = 160;

/** Shortest excerpt worth cutting, whatever the tuning says. */
const MIN_SNIPPET_LENGTH = 24;

/** Fallback for {@link SiftTuning.snippetLines} when the tuning object carries nonsense. */
const DEFAULT_SNIPPET_LINES = 5;

/** How far an edge may travel to reach a word boundary before it gives up and cuts where it stood. */
const MAX_WORD_SNAP = 32;

/** Word characters for edge snapping: letters, digits and the underscore, in any script. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_VT = 0x0b;
const CHAR_FF = 0x0c;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const CHAR_NBSP = 0xa0;
const CHAR_EXCLAMATION = 0x21;
const CHAR_PERIOD = 0x2e;
const CHAR_QUESTION = 0x3f;
const CHAR_HASH = 0x23;
const CHAR_ASTERISK = 0x2a;
const CHAR_HYPHEN = 0x2d;
const CHAR_EQUALS = 0x3d;
const CHAR_UNDERSCORE = 0x5f;

/** `---`, `***`, `===`, `___`: a thematic break, a setext underline, or a YAML fence. */
const RULE_CHARACTERS: readonly number[] = [CHAR_HYPHEN, CHAR_ASTERISK, CHAR_EQUALS, CHAR_UNDERSCORE];

/** Shortest run of {@link RULE_CHARACTERS} that makes a line a rule rather than prose. */
const MIN_RULE_RUN = 3;

/** Deepest ATX heading, `######`. */
const MAX_HEADING_LEVEL = 6;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdc00;
const LOW_SURROGATE_END = 0xe000;

/* ========================================================================== */
/* 2. Snippets                                                                */
/* ========================================================================== */

export class Snippets {
	private readonly app: App;
	private readonly indexer: Indexer;
	private readonly tuning: SiftTuning;

	constructor(app: App, indexer: Indexer, tuning: SiftTuning) {
		this.app = app;
		this.indexer = indexer;
		this.tuning = tuning;
	}

	/**
	 * Reads each hit's file and attaches snippets. Call with the visible slice, not the whole result set.
	 *
	 * Every hit comes back as a {@link ResultItem}, in the order it went in, so
	 * the caller can render the window it asked for even when a file vanished or
	 * the search was superseded — those items simply carry no snippets. Once
	 * `signal` is aborted no further file is read.
	 */
	async build(hits: readonly RankedHit[], maxPerHit: number, signal?: AbortSignal): Promise<ResultItem[]> {
		const items: ResultItem[] = [];
		for (const hit of hits) {
			const snippets = signal?.aborted === true ? [] : await this.readAndBuild(hit, maxPerHit);
			items.push(toResultItem(hit, snippets));
		}
		return items;
	}

	/** Synchronous core, given text already read. This is what the unit tests drive. */
	buildForFile(file: IndexedFile, original: string, matches: readonly Match[], maxPerHit: number): Snippet[] {
		if (maxPerHit <= 0 || original.length === 0 || matches.length === 0) return [];
		// The record is only consulted for this one thing: does it still describe
		// the text we just read? See the header.
		if (expectedOriginalLength(file) !== original.length) return [];

		const usable = usableMatches(matches, original.length);
		if (usable.length === 0) return [];

		const snippets: Snippet[] = [];
		for (const cluster of Snippets.selectMatches(usable, maxPerHit)) {
			const snippet = this.cut(original, cluster, usable);
			if (snippet !== null) snippets.push(snippet);
		}
		return snippets;
	}

	/**
	 * Groups matches into up to `maxPerHit` clusters, preferring distinct terms and spread positions over adjacent duplicates.
	 *
	 * Grouping runs in document order and closes a cluster as soon as it would
	 * grow past {@link CLUSTER_WINDOW}, so three hits five characters apart are
	 * one excerpt rather than three copies of the same sentence.
	 *
	 * The cap then picks greedily by how many terms a cluster adds that no
	 * already-picked cluster covers, falling back to the total number of distinct
	 * terms and finally to the earliest position. The survivors are returned in
	 * DOCUMENT order: which clusters win is a ranking question, the order they
	 * are read in is not.
	 */
	static selectMatches(matches: readonly Match[], maxPerHit: number): Match[][] {
		if (maxPerHit <= 0) return [];
		const ordered = sortByPosition(matches.filter(isSnippetable));
		if (ordered.length === 0) return [];

		const clusters = groupIntoClusters(ordered);
		if (clusters.length <= maxPerHit) return clusters;

		const chosen: number[] = [];
		const covered = new Set<number>();
		while (chosen.length < maxPerHit) {
			let bestIndex = -1;
			let bestFresh = -1;
			let bestDistinct = -1;
			for (let i = 0; i < clusters.length; i++) {
				if (chosen.includes(i)) continue;
				const terms = distinctTerms(clusters[i]);
				let fresh = 0;
				for (const term of terms) {
					if (!covered.has(term)) fresh++;
				}
				// Strict comparisons only, and clusters are in document order, so an
				// equally good later cluster never displaces an earlier one.
				if (fresh > bestFresh || (fresh === bestFresh && terms.size > bestDistinct)) {
					bestIndex = i;
					bestFresh = fresh;
					bestDistinct = terms.size;
				}
			}
			if (bestIndex < 0) break;
			chosen.push(bestIndex);
			for (const term of distinctTerms(clusters[bestIndex])) covered.add(term);
		}

		chosen.sort((a, b) => a - b);
		return chosen.map((index) => clusters[index]);
	}

	/**
	 * Sentence bounds around `span`, delimited by . ! ? newline, clamped to the snippet.
	 *
	 * A period only ends a sentence when whitespace or the text edge follows it,
	 * which keeps '13.30 Uhr' and 'z.B.' in one piece. The result always contains
	 * `span`, so the caller can render it as a range without checking.
	 */
	static sentenceAround(text: string, span: Span): Span {
		const length = text.length;
		const from = clamp(span.start, 0, length);
		const to = clamp(span.end, from, length);

		let start = 0;
		for (let i = from - 1; i >= 0; i--) {
			const code = text.charCodeAt(i);
			if (code === CHAR_LF || code === CHAR_CR) {
				start = i + 1;
				break;
			}
			if (isSentenceEnd(code) && i + 1 < length && isWhitespaceCode(text.charCodeAt(i + 1))) {
				start = i + 1;
				break;
			}
		}
		while (start < from && isWhitespaceCode(text.charCodeAt(start))) start++;

		let end = length;
		for (let i = to; i < length; i++) {
			const code = text.charCodeAt(i);
			if (code === CHAR_LF || code === CHAR_CR) {
				end = i;
				break;
			}
			if (isSentenceEnd(code) && (i + 1 >= length || isWhitespaceCode(text.charCodeAt(i + 1)))) {
				end = i + 1;
				break;
			}
		}
		while (end > to && isWhitespaceCode(text.charCodeAt(end - 1))) end--;

		return { start: Math.min(start, from), end: Math.max(end, to) };
	}

	/**
	 * Widens or narrows a span to the nearest word boundaries so a snippet never starts mid-word.
	 *
	 * Outward first, because a snippet that shows one word too much reads better
	 * than one that shows half a word. Only when no boundary sits within
	 * {@link MAX_WORD_SNAP} — a hash, a base64 blob — does the edge move inward
	 * instead, and if that fails too it stays where it was.
	 */
	static clampToWordBoundaries(text: string, span: Span): Span {
		const length = text.length;
		const from = clamp(span.start, 0, length);
		const to = clamp(span.end, from, length);
		const start = snapOutwardThenInward(text, from, -1, 0, length);
		const end = Math.max(start, snapOutwardThenInward(text, to, 1, start, length));
		return { start, end };
	}

	/* ---------------------------------------------------------------------- */
	/* Internals                                                              */
	/* ---------------------------------------------------------------------- */

	/**
	 * Resolves the hit to a file, reads it and builds its snippets. Every failure
	 * — record gone, file deleted between search and render, unreadable file —
	 * ends in an empty array, because a missing excerpt must never take down the
	 * render of a whole result window.
	 */
	private async readAndBuild(hit: RankedHit, maxPerHit: number): Promise<Snippet[]> {
		if (maxPerHit <= 0) return [];
		// A hit that matched on title or path alone has nothing to excerpt, so it
		// does not deserve a file read either.
		if (!hit.matches.some(isSnippetable)) return [];

		const record = this.indexer.getFile(hit.fileId) ?? this.indexer.getFileByPath(hit.path);
		if (record === undefined) return [];

		// The path comes from the index, which normalized it when the record was
		// built; getFileByPath returns null once the file is gone.
		const file = this.app.vault.getFileByPath(record.path);
		if (file === null) return [];

		let original: string;
		try {
			original = await this.app.vault.cachedRead(file);
		} catch {
			return [];
		}
		return this.buildForFile(record, original, hit.matches, maxPerHit);
	}

	/**
	 * Cuts one excerpt around `cluster`.
	 *
	 * `all` is the full set of usable matches: anything that happens to fall
	 * inside the window gets marked too, so a match the clustering assigned
	 * elsewhere is not rendered as unhighlighted text in the middle of a
	 * highlighted sentence. Partial overlaps are dropped rather than clipped —
	 * half a highlighted word is worse than none.
	 */
	private cut(original: string, cluster: readonly Match[], all: readonly Match[]): Snippet | null {
		const length = original.length;
		const clusterStart = cluster[0].start;
		let clusterEnd = clusterStart;
		for (const match of cluster) {
			if (match.end > clusterEnd) clusterEnd = match.end;
		}

		const maxLines = this.lineBudget();
		const perLine = this.targetLength();

		// One block per excerpt: the excerpt may not reach back into the
		// frontmatter or across a heading. The scan is bounded by the widest
		// excerpt this cut could produce — a full line budget in each direction —
		// so it costs the excerpt's length and not the file's.
		const block = blockAround(
			original,
			clusterStart,
			clusterEnd,
			lineStartBefore(original, lineStartAt(original, clusterStart), maxLines),
			lineEndAfter(original, lineEndAt(original, lastOffsetOf(clusterStart, clusterEnd)), maxLines),
		);

		const chosen = fitToCeiling(
			original,
			lineWindow(original, block, clusterStart, clusterEnd, maxLines),
			clusterStart,
			clusterEnd,
			maxLines,
			perLine,
		);

		const snapped = Snippets.clampToWordBoundaries(original, chosen);
		// The cluster is what this excerpt exists for; neither snapping nor the
		// block clamp may cut into it.
		let start = Math.min(Math.max(snapped.start, block.start), clusterStart);
		let end = Math.max(Math.min(snapped.end, block.end), clusterEnd);

		// Whether text was cut away is decided before the cosmetic trim below, so
		// dropping a leading newline does not earn the snippet a "…".
		const leadingEllipsis = start > 0;
		const trailingEllipsis = end < length;
		while (start < clusterStart && isWhitespaceCode(original.charCodeAt(start))) start++;
		while (end > clusterEnd && isWhitespaceCode(original.charCodeAt(end - 1))) end--;

		const marks = collectMarks(all, start, end);
		if (marks.length === 0) return null;

		const text = original.slice(start, end);
		return {
			text,
			offset: start,
			marks,
			focus: Snippets.sentenceAround(text, marks[0]),
			leadingEllipsis,
			trailingEllipsis,
			jumpOffset: start + marks[0].start,
		};
	}

	/** Configured per-line character ceiling, hardened against a hand-edited tuning object. */
	private targetLength(): number {
		const configured = this.tuning.snippetLength;
		if (!Number.isFinite(configured)) return CLUSTER_WINDOW;
		return Math.max(MIN_SNIPPET_LENGTH, Math.round(configured));
	}

	/** Configured line budget, hardened the same way. At least one line: the one the match sits on. */
	private lineBudget(): number {
		const configured = this.tuning.snippetLines;
		if (!Number.isFinite(configured)) return DEFAULT_SNIPPET_LINES;
		return Math.max(1, Math.round(configured));
	}
}

/* ========================================================================== */
/* 3. Matches                                                                 */
/* ========================================================================== */

/**
 * True for a match whose offsets address the file itself.
 *
 * `title` and `path` matches index the record's normalized title and path, so
 * they are not positions in any text this module ever slices.
 */
function isSnippetable(match: Match): boolean {
	return match.field !== 'title' && match.field !== 'path';
}

/** Snippetable matches that describe a real, in-range range of `length` characters, in document order. */
function usableMatches(matches: readonly Match[], length: number): Match[] {
	const usable: Match[] = [];
	for (const match of matches) {
		if (!isSnippetable(match)) continue;
		if (!Number.isInteger(match.start) || !Number.isInteger(match.end)) continue;
		if (match.start < 0 || match.end <= match.start || match.end > length) continue;
		usable.push(match);
	}
	return sortByPosition(usable);
}

/** Document order. The Searcher already delivers this; sorting a copy keeps the module independent of that promise. */
function sortByPosition(matches: readonly Match[]): Match[] {
	return matches.slice().sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
}

/** Consecutive matches, grouped so that no group spans more than {@link CLUSTER_WINDOW} characters. */
function groupIntoClusters(ordered: readonly Match[]): Match[][] {
	const clusters: Match[][] = [];
	let current: Match[] = [];
	let start = 0;
	let end = 0;
	for (const match of ordered) {
		if (current.length === 0) {
			current = [match];
			start = match.start;
			end = match.end;
			continue;
		}
		const grown = Math.max(end, match.end);
		if (grown - start <= CLUSTER_WINDOW) {
			current.push(match);
			end = grown;
			continue;
		}
		clusters.push(current);
		current = [match];
		start = match.start;
		end = match.end;
	}
	if (current.length > 0) clusters.push(current);
	return clusters;
}

function distinctTerms(cluster: readonly Match[]): Set<number> {
	const terms = new Set<number>();
	for (const match of cluster) terms.add(match.termIndex);
	return terms;
}

/**
 * Marks for every match fully inside `[start, end)`, relative to the excerpt,
 * ordered and non-overlapping. Overlapping and touching ranges are merged, so
 * two terms that share a character render as one highlight instead of two
 * fighting over the same span.
 */
function collectMarks(all: readonly Match[], start: number, end: number): Span[] {
	const marks: Span[] = [];
	for (const match of all) {
		if (match.start < start || match.end > end) continue;
		const span = { start: match.start - start, end: match.end - start };
		const last = marks.length === 0 ? null : marks[marks.length - 1];
		if (last !== null && span.start <= last.end) {
			if (span.end > last.end) last.end = span.end;
			continue;
		}
		marks.push(span);
	}
	return marks;
}

/* ========================================================================== */
/* 4. Text helpers                                                            */
/* ========================================================================== */

/**
 * Length the record says the file has.
 *
 * `text` is offset-parallel to the original, so its length is the original
 * length — unless the file needed an offset map, in which case the map's last
 * entry carries it.
 */
function expectedOriginalLength(file: IndexedFile): number {
	const map = file.offsetMap;
	if (map === null || map.length === 0) return file.text.length;
	return map[map.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bounds of the block that contains `[from, to)`, in ORIGINAL coordinates.
 *
 * A block is what a reader sees as one piece: the frontmatter between its
 * fences, a single heading line, or a run of lines between blank lines. The
 * scan never leaves `[low, high]` — the window the caller is about to cut — so
 * it costs the window's length, and an edge further away than that could not
 * clamp anything anyway.
 *
 * This works off the text rather than off `IndexedFile.frontmatterSpan` and
 * `headings` on purpose: those spans are in NORMALIZED coordinates, which drift
 * from the original in a decomposed file, and everything in this module is
 * measured against the string `cachedRead` returned. The fence line that opens
 * and closes frontmatter and the heading line are both edges by the rule below,
 * so the two agree on what a block is.
 */
function blockAround(text: string, from: number, to: number, low: number, high: number): Span {
	const anchor = clamp(from, 0, Math.max(0, text.length - 1));
	let start = lineStartAt(text, anchor);
	const firstLineEnd = lineEndAt(text, anchor);
	// A match on a heading line or a fence: that single line is the whole block.
	if (isBlockEdgeLine(text, start, firstLineEnd)) return { start, end: firstLineEnd };

	while (start > low) {
		const previousEnd = previousLineEnd(text, start);
		const previousStart = lineStartAt(text, previousEnd);
		if (isBlockEdgeLine(text, previousStart, previousEnd)) break;
		start = previousStart;
	}

	let end = lineEndAt(text, clamp(to > from ? to - 1 : from, 0, text.length));
	while (end < high) {
		const nextStart = nextLineStart(text, end);
		if (nextStart >= text.length) break;
		const nextEnd = lineEndAt(text, nextStart);
		if (isBlockEdgeLine(text, nextStart, nextEnd)) break;
		end = nextEnd;
	}

	return { start, end };
}

/**
 * The line window one excerpt shows, in ORIGINAL coordinates.
 *
 * It always contains every line the cluster touches. The rest of the budget is
 * split so a line AFTER the match beats a line before it, and whatever one side
 * cannot use — the match sits on the block's first line, the block ends two
 * lines down — is handed to the other. Nothing ever leaves `block`.
 */
function lineWindow(text: string, block: Span, from: number, to: number, maxLines: number): Span {
	const start = Math.max(block.start, lineStartAt(text, from));
	const end = Math.max(start, Math.min(block.end, lineEndAt(text, lastOffsetOf(from, to))));

	const spare = Math.max(0, maxLines - countLines(text, start, end));
	// The remainder goes downward: `ceil` here, so a budget of 5 around a
	// single matched line reads two lines up and two down, and a budget of 4
	// reads one up and two down.
	const after = growForward(text, end, block.end, Math.ceil(spare / 2));
	const before = growBackward(text, start, block.start, spare - after.grown);
	const rest = growForward(text, after.at, block.end, spare - after.grown - before.grown);
	return { start: before.at, end: rest.at };
}

/**
 * Applies the character ceiling — {@link SiftTuning.snippetLength} per line the
 * excerpt shows — to a line window.
 *
 * Context lines go first, and a line before the match goes before a line after
 * it, because the lines after are the ones the reader wants. What is left when
 * only the matched line(s) remain is the one case an excerpt is not whole
 * lines: it is narrowed around the match, which is what a 4 000-character
 * paragraph-per-line note needs and what the character window did before.
 */
function fitToCeiling(
	text: string,
	window: Span,
	from: number,
	to: number,
	maxLines: number,
	perLine: number,
): Span {
	let start = window.start;
	let end = window.end;
	const matchStart = Math.max(start, lineStartAt(text, from));
	const matchEnd = Math.min(end, lineEndAt(text, lastOffsetOf(from, to)));

	for (;;) {
		const ceiling = perLine * Math.min(maxLines, countLines(text, start, end));
		if (end - start <= ceiling) return { start, end };
		if (start < matchStart) {
			start = Math.min(matchStart, nextLineStart(text, lineEndAt(text, start)));
			continue;
		}
		if (end > matchEnd) {
			end = Math.max(matchEnd, previousLineEnd(text, lineStartAt(text, end)));
			continue;
		}
		break;
	}

	// Only the matched line(s) left, and still too long.
	const target = Math.max(MIN_SNIPPET_LENGTH, perLine * Math.min(maxLines, countLines(text, start, end)), to - from);
	const centre = Math.round((from + to) / 2);
	let cutStart = centre - Math.floor(target / 2);
	let cutEnd = cutStart + target;
	if (cutStart < start) {
		cutEnd += start - cutStart;
		cutStart = start;
	}
	if (cutEnd > end) {
		cutStart = Math.max(start, cutStart - (cutEnd - end));
		cutEnd = end;
	}
	return { start: cutStart, end: cutEnd };
}

/** How far a growth step got, and how many lines it managed. */
interface Growth {
	at: number;
	grown: number;
}

/** Adds up to `lines` whole lines below `end`, never past `limit`. */
function growForward(text: string, end: number, limit: number, lines: number): Growth {
	let at = end;
	let grown = 0;
	while (grown < lines && at < limit) {
		const nextStart = nextLineStart(text, at);
		if (nextStart >= limit || nextStart >= text.length) break;
		const nextEnd = Math.min(limit, lineEndAt(text, nextStart));
		if (nextEnd <= at) break;
		at = nextEnd;
		grown++;
	}
	return { at, grown };
}

/** Adds up to `lines` whole lines above `start`, never before `limit`. */
function growBackward(text: string, start: number, limit: number, lines: number): Growth {
	let at = start;
	let grown = 0;
	while (grown < lines && at > limit) {
		const previousStart = lineStartAt(text, previousLineEnd(text, at));
		if (previousStart < limit || previousStart >= at) break;
		at = previousStart;
		grown++;
	}
	return { at, grown };
}

/** Start of the line `count` lines above the one starting at `start`. */
function lineStartBefore(text: string, start: number, count: number): number {
	return growBackward(text, start, 0, count).at;
}

/** End of the line `count` lines below the one ending at `end`. */
function lineEndAfter(text: string, end: number, count: number): number {
	return growForward(text, end, text.length, count).at;
}

/** Number of lines the half-open range `[start, end)` covers. At least one. */
function countLines(text: string, start: number, end: number): number {
	let lines = 1;
	for (let i = start; i < end; i++) {
		const code = text.charCodeAt(i);
		if (code !== CHAR_LF && code !== CHAR_CR) continue;
		lines++;
		if (code === CHAR_CR && i + 1 < end && text.charCodeAt(i + 1) === CHAR_LF) i++;
	}
	return lines;
}

/** Last offset a `[from, to)` range actually covers; `from` itself for an empty range. */
function lastOffsetOf(from: number, to: number): number {
	return to > from ? to - 1 : from;
}

/** Start of the line containing `at`. */
function lineStartAt(text: string, at: number): number {
	for (let i = clamp(at, 0, text.length); i > 0; i--) {
		const code = text.charCodeAt(i - 1);
		if (code === CHAR_LF || code === CHAR_CR) return i;
	}
	return 0;
}

/** End of the line containing `at`, exclusive, the break itself not included. */
function lineEndAt(text: string, at: number): number {
	for (let i = clamp(at, 0, text.length); i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === CHAR_LF || code === CHAR_CR) return i;
	}
	return text.length;
}

/** Exclusive end of the line before the one starting at `start`. */
function previousLineEnd(text: string, start: number): number {
	let end = start - 1;
	if (end > 0 && text.charCodeAt(end) === CHAR_LF && text.charCodeAt(end - 1) === CHAR_CR) end--;
	return Math.max(0, end);
}

/** Start of the line after the one ending at `end`. `text.length` when there is none. */
function nextLineStart(text: string, end: number): number {
	let at = end;
	if (at < text.length && text.charCodeAt(at) === CHAR_CR) at++;
	if (at < text.length && text.charCodeAt(at) === CHAR_LF) at++;
	return at > end ? at : text.length;
}

/**
 * True for a line that separates blocks and is a block of its own: a blank
 * line, an ATX heading (`## Küche`), or a rule line (`---`, `===`, `***`) —
 * which is also how YAML frontmatter opens and closes.
 */
function isBlockEdgeLine(text: string, start: number, end: number): boolean {
	let i = start;
	while (i < end && isWhitespaceCode(text.charCodeAt(i))) i++;
	if (i >= end) return true;

	const first = text.charCodeAt(i);
	if (first === CHAR_HASH) {
		let level = 0;
		while (i < end && text.charCodeAt(i) === CHAR_HASH) {
			level++;
			i++;
		}
		if (level > MAX_HEADING_LEVEL) return false;
		return i >= end || isWhitespaceCode(text.charCodeAt(i));
	}

	if (!RULE_CHARACTERS.includes(first)) return false;
	let run = 0;
	while (i < end && text.charCodeAt(i) === first) {
		run++;
		i++;
	}
	if (run < MIN_RULE_RUN) return false;
	while (i < end && isWhitespaceCode(text.charCodeAt(i))) i++;
	return i >= end;
}

function clamp(value: number, low: number, high: number): number {
	if (!Number.isFinite(value)) return low;
	if (value < low) return low;
	return value > high ? high : value;
}

function isWordCharacter(text: string, offset: number): boolean {
	return WORD_CHARACTER.test(text.charAt(offset));
}

function isWhitespaceCode(code: number): boolean {
	return (
		code === CHAR_SPACE ||
		code === CHAR_TAB ||
		code === CHAR_LF ||
		code === CHAR_CR ||
		code === CHAR_VT ||
		code === CHAR_FF ||
		code === CHAR_NBSP
	);
}

function isSentenceEnd(code: number): boolean {
	return code === CHAR_PERIOD || code === CHAR_EXCLAMATION || code === CHAR_QUESTION;
}

/** True when cutting at `offset` would split a surrogate pair, which would leave half a character in the excerpt. */
function splitsSurrogatePair(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return false;
	const before = text.charCodeAt(offset - 1);
	const after = text.charCodeAt(offset);
	return (
		before >= HIGH_SURROGATE_START &&
		before < HIGH_SURROGATE_END &&
		after >= HIGH_SURROGATE_END &&
		after < LOW_SURROGATE_END
	);
}

/** A position where an excerpt may begin or end: outside the text, or between two characters that are not both word characters. */
function isCutBoundary(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return true;
	if (splitsSurrogatePair(text, offset)) return false;
	return !(isWordCharacter(text, offset - 1) && isWordCharacter(text, offset));
}

/**
 * Moves `offset` to a cut boundary: first `direction` (outward), then the other
 * way, each at most {@link MAX_WORD_SNAP} characters, staying inside
 * `[low, high]`. Returns `offset` unchanged when neither search succeeds.
 */
function snapOutwardThenInward(text: string, offset: number, direction: -1 | 1, low: number, high: number): number {
	if (isCutBoundary(text, offset)) return offset;
	const outward = findCutBoundary(text, offset, direction, low, high);
	if (outward >= 0) return outward;
	const inward = findCutBoundary(text, offset, direction === 1 ? -1 : 1, low, high);
	return inward >= 0 ? inward : offset;
}

/** First cut boundary from `offset` in `step` direction, within the snap budget and the given bounds. `-1` when there is none. */
function findCutBoundary(text: string, offset: number, step: -1 | 1, low: number, high: number): number {
	for (let distance = 1; distance <= MAX_WORD_SNAP; distance++) {
		const at = offset + step * distance;
		if (at < low || at > high) return -1;
		if (isCutBoundary(text, at)) return at;
	}
	return -1;
}

/* ========================================================================== */
/* 5. Result items                                                            */
/* ========================================================================== */

/** Adds the two fields a {@link ResultItem} has over a {@link RankedHit}. */
function toResultItem(hit: RankedHit, snippets: Snippet[]): ResultItem {
	return { ...hit, snippets, similarTo: similarWords(hit.matches) };
}

/** The distinct vault words that only a fuzzy match reached, in the order they occur. Empty unless the hit is fuzzy. */
function similarWords(matches: readonly Match[]): string[] {
	const words: string[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		if (match.quality !== 'fuzzy') continue;
		const word = match.matchedText;
		if (word === undefined || word.length === 0 || seen.has(word)) continue;
		seen.add(word);
		words.push(word);
	}
	return words;
}
