/**
 * Ranker — turns raw hits into an ordered result list.
 *
 * Score is a sum of per-match field weights (title 3.0, frontmatter 2.0, tag
 * 2.0, heading 1.5, body 1.0, path 1.0), damped logarithmically by occurrence
 * count, multiplied by the whole-word bonus, a proximity bonus over distinct
 * terms, a mild recency bonus, and a quality penalty (fuzzy 0.7, alias 0.95).
 * Normalizes to 0-100 within the result set and applies the chosen sort. Pure
 * and deterministic given `now`.
 *
 * ---------------------------------------------------------------------------
 * THE SCORE, WRITTEN OUT
 * ---------------------------------------------------------------------------
 *   fieldContribution[f] = weights.field[f] × occurrenceFactor(count[f])
 *   base                 = Σ fieldContribution[f]
 *   total                = base × wholeWordFactor × proximityFactor
 *                               × recencyFactor × qualityFactor
 *
 * `frequencyFactor` in the breakdown is a diagnostic only: it reports how much
 * the occurrence damping lifted `base` above a one-occurrence-per-field score.
 * It is already contained in `base` and must NOT be multiplied in again — the
 * identity above is asserted by a unit test.
 *
 * OCCURRENCE DAMPING
 *   occurrenceFactor(n) = 1 + (MAX_FREQUENCY_FACTOR − 1) × ln n / (ln n + K)
 *
 * A saturating curve rather than a plain logarithm, for two reasons. It is
 * strictly increasing, so 100 occurrences always outscore 10 (by 1.14×, not by
 * 10×). And it is bounded by MAX_FREQUENCY_FACTOR, which is picked so that
 * repetition alone can never overtake a better field: even an unrealistic
 * whole-word body flood tops out at 1.0 × 2.2 × 1.3 = 2.86, below the 3.0 of a
 * single title match. Half of the span above 1.0 is reached at n = e^K ≈ 55.
 *
 * PROXIMITY
 * Offsets are only comparable inside one offset domain — 'title' and 'path'
 * matches index into `titleNormalized` / `pathNormalized`, everything else
 * indexes into the original file text (see the offset contract in types.ts).
 * The covering window is therefore computed per domain and the smallest one
 * wins; a hit whose distinct terms never meet inside a single domain gets the
 * neutral 1.0. The bonus decays LINEARLY from `maxProximityBonus` at distance 0
 * to 1.0 at `proximityWindow` characters, and stays at 1.0 beyond it.
 *
 * QUALITY IS A TIER, NOT JUST A FACTOR
 * The relevance order compares the match quality FIRST and the score only
 * within one quality class, because plan section 3.1 makes it an absolute rule
 * that exact hits stay on top. As a mere multiplier the fuzzy penalty could be
 * outvoted: a fuzzy hit is always a whole word (1.3) while an exact hit may be
 * an infix (1.0), so 1.3 × 0.7 = 0.91 and two occurrences were enough to push
 * a typo above the note that really contains the term. The penalty is still
 * applied to the score — it separates hits inside a class and it is what the
 * relevance percentage reports — but it no longer decides the class. One
 * consequence to expect: the percentages need not decrease down the list, since
 * a fuzzy hit below an exact one can carry the higher raw score.
 *
 * RECENCY
 * Linear as well: `maxRecencyBonus` for a file modified right now, decaying to
 * 1.0 at `recencyHalfLifeDays` and flat afterwards. A file with a timestamp in
 * the future is treated as age 0 rather than as a bonus multiplier > max.
 */

import type {
	Match,
	MatchField,
	MatchQuality,
	QueryAst,
	RankedHit,
	RankingWeights,
	RawHit,
	ScoreBreakdown,
	SortKey,
} from '../types';

/** Every match field, in the order the breakdown reports them. */
const MATCH_FIELDS: readonly MatchField[] = ['title', 'path', 'frontmatter', 'tag', 'heading', 'body'];

/** Upper bound of {@link occurrenceFactor}. See the header comment for why it is below 3.0 / 1.3. */
const MAX_FREQUENCY_FACTOR = 2.2;

/** Curvature of the occurrence damping: half the span above 1.0 is reached at e^4 ≈ 55 occurrences. */
const FREQUENCY_CURVATURE = 4;

const MS_PER_DAY = 86_400_000;

/** Locale-aware, case- and accent-insensitive, digit-aware: 'Ä' sorts next to 'A', 'note10' after 'note9'. */
const COLLATION: Intl.CollatorOptions = { sensitivity: 'base', numeric: true };

/**
 * The one collator this module uses, built on first comparison.
 *
 * `a.localeCompare(b, undefined, COLLATION)` constructs a fresh collator on
 * every call — the engine's cached fast path only applies when both the locale
 * and the options are `undefined`. A large result set falls through to the path
 * tiebreaker tens of thousands of times per keystroke, which made sorting the
 * most expensive frame of a search. One shared collator is 15-25x faster and
 * orders identically. Lazy, so loading the plugin does not pay for it.
 */
let pathCollator: Intl.Collator | null = null;

function compareStrings(a: string, b: string): number {
	if (pathCollator === null) pathCollator = new Intl.Collator(undefined, COLLATION);
	return pathCollator.compare(a, b);
}

/**
 * Sort rank of a match quality. Primary key of the relevance order, so an exact
 * hit always stays above an alias hit and an alias hit above a fuzzy one, per
 * plan section 3.1 ("Exakte Treffer bleiben immer zuoberst"). The quality
 * PENALTY still shapes the score inside a class; it just no longer decides the
 * class, which a strong text match used to be able to overturn (1.3 whole-word
 * × 0.7 fuzzy = 0.91, recovered by two occurrences).
 */
const QUALITY_ORDER: Readonly<Record<MatchQuality, number>> = { exact: 0, alias: 1, fuzzy: 2 };

/**
 * Which string a match's offsets index into. Only matches from the same domain
 * may be compared by distance.
 */
type OffsetDomain = 'file' | 'title' | 'path';

const OFFSET_DOMAINS: readonly OffsetDomain[] = ['file', 'title', 'path'];

function offsetDomain(field: MatchField): OffsetDomain {
	if (field === 'title') return 'title';
	if (field === 'path') return 'path';
	return 'file';
}

/** Saturating logarithmic damping of an occurrence count. `0` occurrences contribute nothing. */
function occurrenceFactor(count: number): number {
	if (count <= 0) return 0;
	if (count <= 1) return 1;
	const logarithm = Math.log(count);
	return 1 + (MAX_FREQUENCY_FACTOR - 1) * (logarithm / (logarithm + FREQUENCY_CURVATURE));
}

/** A zeroed per-field accumulator. */
function emptyFieldRecord(): Record<MatchField, number> {
	return { title: 0, path: 0, frontmatter: 0, tag: 0, heading: 0, body: 0 };
}

/**
 * Width of the smallest window that contains one occurrence of each of
 * `requiredTerms` distinct term indices, or `null` when the list does not carry
 * them all. Classic two-pointer sweep, O(n log n) for the sort.
 */
function smallestCoveringWindow(matches: readonly Match[], requiredTerms: number): number | null {
	if (requiredTerms <= 0 || matches.length < requiredTerms) return null;
	const ordered = matches.slice().sort((a, b) => a.start - b.start || a.end - b.end);
	const seen = new Map<number, number>();
	let covered = 0;
	let left = 0;
	let best: number | null = null;
	for (let right = 0; right < ordered.length; right++) {
		const entering = ordered[right].termIndex;
		const nextCount = (seen.get(entering) ?? 0) + 1;
		seen.set(entering, nextCount);
		if (nextCount === 1) covered++;
		while (covered === requiredTerms && left <= right) {
			const width = Math.max(0, ordered[right].end - ordered[left].start);
			if (best === null || width < best) best = width;
			const leaving = ordered[left].termIndex;
			const remaining = (seen.get(leaving) ?? 0) - 1;
			seen.set(leaving, remaining);
			if (remaining === 0) covered--;
			left++;
		}
	}
	return best;
}

/**
 * Final tiebreaker for every sort key, so the list never reorders itself
 * between two identical searches. Locale order first (that is what the user
 * sees), then a plain code-unit comparison so paths differing only in case stay
 * apart, then the file id so the order is a genuine total order.
 */
function comparePaths(a: RankedHit, b: RankedHit): number {
	const byLocale = compareStrings(a.path, b.path);
	if (byLocale !== 0) return byLocale < 0 ? -1 : 1;
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.fileId !== b.fileId) return a.fileId < b.fileId ? -1 : 1;
	return 0;
}

export class Ranker {
	private readonly weights: RankingWeights;

	constructor(weights: RankingWeights) {
		this.weights = weights;
	}

	/** Scores, normalizes to 0-100 and returns hits sorted by relevance. `now` is injected so tests are deterministic. */
	rank(hits: readonly RawHit[], ast: QueryAst, now: number): RankedHit[] {
		const ranked: RankedHit[] = hits.map((hit) => ({
			...hit,
			// The breakdown is the score: there is exactly one code path, so a
			// diagnostic readout can never drift from the value that sorts.
			score: this.scoreHit(hit, ast, now).total,
			relevance: 0,
		}));
		Ranker.sort(ranked, 'relevance');
		Ranker.normalize(ranked);
		return ranked;
	}

	/** Full breakdown for one hit. Exists so a ranking change shows up as a diff in a test, not as a vibe. */
	scoreHit(hit: RawHit, ast: QueryAst, now: number): ScoreBreakdown {
		const weights = this.weights;
		const counts = emptyFieldRecord();
		// Whole-word aggregation: the weighted mean of the per-match multiplier,
		// so that a whole-word title match counts for more than a whole-word
		// body match, and an all-whole-word hit lands on exactly wholeWordBonus.
		let weightedWithBonus = 0;
		let weightedPlain = 0;
		for (const match of hit.matches) {
			const fieldWeight = weights.field[match.field];
			counts[match.field] += 1;
			weightedPlain += fieldWeight;
			weightedWithBonus += match.wholeWord ? fieldWeight * weights.wholeWordBonus : fieldWeight;
		}

		const fieldContribution = emptyFieldRecord();
		let base = 0;
		let singleOccurrenceBase = 0;
		for (const field of MATCH_FIELDS) {
			const count = counts[field];
			if (count === 0) continue;
			const fieldWeight = weights.field[field];
			const contribution = fieldWeight * occurrenceFactor(count);
			fieldContribution[field] = contribution;
			base += contribution;
			singleOccurrenceBase += fieldWeight;
		}

		const frequencyFactor = singleOccurrenceBase > 0 ? base / singleOccurrenceBase : 1;
		const wholeWordFactor = weightedPlain > 0 ? weightedWithBonus / weightedPlain : 1;
		const proximityFactor = this.proximityFactor(hit, ast);
		const recencyFactor = this.recencyFactor(hit.modifiedAt, now);
		const qualityFactor = this.qualityFactor(hit);

		return {
			base,
			fieldContribution,
			frequencyFactor,
			wholeWordFactor,
			proximityFactor,
			recencyFactor,
			qualityFactor,
			total: base * wholeWordFactor * proximityFactor * recencyFactor * qualityFactor,
		};
	}

	/** Maps `score` to `relevance` 0-100 against the maximum in the set. Mutates in place. */
	static normalize(hits: RankedHit[]): void {
		if (hits.length === 0) return;
		let best = 0;
		for (const hit of hits) {
			if (hit.score > best) best = hit.score;
		}
		if (!(best > 0)) {
			// Every hit scored zero (or worse). There is no "best" to scale
			// against, so nothing is 100 and nothing divides by zero either.
			for (const hit of hits) hit.relevance = 0;
			return;
		}
		for (const hit of hits) {
			const scaled = Math.round((hit.score / best) * 100);
			hit.relevance = Math.min(100, Math.max(0, scaled));
		}
	}

	/** Applies a SortKey. 'relevance' keeps the scored order; every other key is a stable sort with path as tiebreaker. */
	static sort(hits: RankedHit[], sort: SortKey): RankedHit[] {
		hits.sort((a, b) => Ranker.compare(a, b, sort));
		return hits;
	}

	static compare(a: RankedHit, b: RankedHit, sort: SortKey): number {
		let primary = 0;
		switch (sort) {
			case 'relevance':
				// Quality first, score second: see QUALITY_ORDER.
				primary = QUALITY_ORDER[a.quality] - QUALITY_ORDER[b.quality];
				if (primary === 0) primary = b.score - a.score;
				break;
			case 'created-desc':
				primary = b.createdAt - a.createdAt;
				break;
			case 'created-asc':
				primary = a.createdAt - b.createdAt;
				break;
			case 'modified-desc':
				primary = b.modifiedAt - a.modifiedAt;
				break;
			case 'modified-asc':
				primary = a.modifiedAt - b.modifiedAt;
				break;
			case 'title-asc':
				primary = compareStrings(a.title, b.title);
				break;
			case 'path-asc':
				primary = compareStrings(a.path, b.path);
				break;
		}
		// A NaN primary (a malformed timestamp) would break the sort's
		// transitivity, so it falls through to the path order instead.
		if (primary !== 0 && Number.isFinite(primary)) return primary < 0 ? -1 : 1;
		return comparePaths(a, b);
	}

	/**
	 * Bonus for distinct query terms sitting close together. Neutral for a
	 * single-term query, for a hit that only matched one term, and for a hit
	 * whose terms never share an offset domain.
	 */
	private proximityFactor(hit: RawHit, ast: QueryAst): number {
		if (ast.terms.length < 2) return 1;
		const distinctTerms = new Set<number>();
		for (const match of hit.matches) distinctTerms.add(match.termIndex);
		if (distinctTerms.size < 2) return 1;

		const window = this.weights.proximityWindow;
		if (!(window > 0)) return 1;

		let bestWidth: number | null = null;
		for (const domain of OFFSET_DOMAINS) {
			const inDomain = hit.matches.filter((match) => offsetDomain(match.field) === domain);
			const width = smallestCoveringWindow(inDomain, distinctTerms.size);
			if (width !== null && (bestWidth === null || width < bestWidth)) bestWidth = width;
		}
		if (bestWidth === null) return 1;

		const closeness = Math.max(0, 1 - bestWidth / window);
		return 1 + (this.weights.maxProximityBonus - 1) * closeness;
	}

	/** Mild freshness bonus, linear in age and flat once the file is older than the half-life. */
	private recencyFactor(modifiedAt: number, now: number): number {
		const halfLife = this.weights.recencyHalfLifeDays;
		if (!(halfLife > 0)) return 1;
		const ageDays = Math.max(0, (now - modifiedAt) / MS_PER_DAY);
		const freshness = Math.max(0, 1 - ageDays / halfLife);
		return 1 + (this.weights.maxRecencyBonus - 1) * freshness;
	}

	/** Applied once per hit, from the hit's worst match quality — never once per match. */
	private qualityFactor(hit: RawHit): number {
		switch (hit.quality) {
			case 'fuzzy':
				return this.weights.fuzzyPenalty;
			case 'alias':
				return this.weights.aliasPenalty;
			case 'exact':
				return 1;
		}
	}
}
