import { describe, expect, it } from 'vitest';

import { Ranker } from '../../src/search/Ranker';
import type {
	Match,
	MatchField,
	MatchQuality,
	QueryAst,
	QueryTerm,
	RankedHit,
	RankingWeights,
	RawHit,
	SortKey,
} from '../../src/types';

/**
 * Mirrors DEFAULT_TUNING.weights in src/settings.ts. It is duplicated rather
 * than imported because settings.ts pulls in the `obsidian` module, which does
 * not exist outside the app; the ranking numbers below are the contract from
 * types.ts (title 3.0, frontmatter 2.0, tag 2.0, heading 1.5, body 1.0,
 * path 1.0, whole word 1.3, proximity 1.4 over 400 chars, recency 1.15 over
 * 365 days, fuzzy 0.7, alias 0.95) and must be kept in sync with it.
 */
const WEIGHTS: RankingWeights = Object.freeze({
	field: Object.freeze({
		title: 3.0,
		path: 1.0,
		frontmatter: 2.0,
		tag: 2.0,
		heading: 1.5,
		body: 1.0,
	}),
	wholeWordBonus: 1.3,
	maxProximityBonus: 1.4,
	proximityWindow: 400,
	maxRecencyBonus: 1.15,
	recencyHalfLifeDays: 365,
	fuzzyPenalty: 0.7,
	aliasPenalty: 0.95,
} satisfies RankingWeights);

const DAY = 86_400_000;
/** Fixed clock, so nothing in this file depends on the wall clock. */
const NOW = Date.UTC(2026, 2, 14, 12, 0, 0);

const SORT_KEYS: readonly SortKey[] = [
	'relevance',
	'created-desc',
	'created-asc',
	'modified-desc',
	'modified-asc',
	'title-asc',
	'path-asc',
];

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

interface MatchSpec {
	field?: MatchField;
	termIndex?: number;
	start?: number;
	length?: number;
	wholeWord?: boolean;
	quality?: MatchQuality;
}

function makeMatch(spec: MatchSpec = {}): Match {
	const start = spec.start ?? 0;
	const length = spec.length ?? 7;
	return {
		start,
		end: start + length,
		field: spec.field ?? 'body',
		termIndex: spec.termIndex ?? 0,
		wholeWord: spec.wholeWord ?? false,
		quality: spec.quality ?? 'exact',
	};
}

/** `count` occurrences of the same term, 50 characters apart. */
function makeMatches(count: number, spec: MatchSpec = {}): Match[] {
	const matches: Match[] = [];
	for (let i = 0; i < count; i++) {
		matches.push(makeMatch({ ...spec, start: (spec.start ?? 0) + i * 50 }));
	}
	return matches;
}

interface HitSpec {
	fileId?: number;
	path?: string;
	title?: string;
	folder?: string;
	createdAt?: number;
	modifiedAt?: number;
	quality?: MatchQuality;
	matches?: readonly Match[];
}

let nextFileId = 1;

function makeHit(spec: HitSpec = {}): RawHit {
	const fileId = spec.fileId ?? nextFileId++;
	const path = spec.path ?? `notes/file-${fileId}.md`;
	const slash = path.lastIndexOf('/');
	return {
		fileId,
		path,
		title: spec.title ?? path.slice(slash + 1).replace(/\.md$/, ''),
		folder: spec.folder ?? (slash < 0 ? '' : path.slice(0, slash)),
		createdAt: spec.createdAt ?? NOW - 30 * DAY,
		modifiedAt: spec.modifiedAt ?? NOW - 10 * DAY,
		matches: spec.matches ?? [makeMatch()],
		quality: spec.quality ?? 'exact',
	};
}

function makeTerm(index: number): QueryTerm {
	const raw = `term${index}`;
	return {
		kind: 'word',
		field: 'any',
		raw,
		normalized: raw,
		variants: [raw],
		trigrams: [raw.slice(0, 3)],
		short: false,
		fuzzyEligible: true,
		span: { start: index * 6, end: index * 6 + raw.length },
	};
}

function makeAst(termCount: number): QueryAst {
	const terms: QueryTerm[] = [];
	for (let i = 0; i < termCount; i++) terms.push(makeTerm(i));
	return {
		must: terms,
		mustNot: [],
		should: [],
		raw: terms.map((term) => term.raw).join(' '),
		errors: [],
		isEmpty: terms.length === 0,
		terms,
	};
}

const ONE_TERM = makeAst(1);
const TWO_TERMS = makeAst(2);

function ranker(): Ranker {
	return new Ranker(WEIGHTS);
}

function scoreOf(hit: RawHit, ast: QueryAst = ONE_TERM, now: number = NOW): number {
	return ranker().scoreHit(hit, ast, now).total;
}

function toRanked(hit: RawHit, score: number): RankedHit {
	return { ...hit, score, relevance: 0 };
}

/* -------------------------------------------------------------------------- */
/* Field weighting                                                            */
/* -------------------------------------------------------------------------- */

describe('field weighting', () => {
	it('orders title above heading above body when everything else is equal', () => {
		const title = makeHit({ path: 'a.md', matches: [makeMatch({ field: 'title' })] });
		const heading = makeHit({ path: 'b.md', matches: [makeMatch({ field: 'heading' })] });
		const body = makeHit({ path: 'c.md', matches: [makeMatch({ field: 'body' })] });

		const ranked = ranker().rank([body, heading, title], ONE_TERM, NOW);

		expect(ranked.map((hit) => hit.path)).toEqual(['a.md', 'b.md', 'c.md']);
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
		expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
	});

	it('reports the field weights unchanged for a single occurrence each', () => {
		const hit = makeHit({
			matches: [
				makeMatch({ field: 'title' }),
				makeMatch({ field: 'frontmatter', start: 10 }),
				makeMatch({ field: 'tag', start: 20 }),
				makeMatch({ field: 'heading', start: 30 }),
				makeMatch({ field: 'body', start: 40 }),
				makeMatch({ field: 'path' }),
			],
		});

		const breakdown = ranker().scoreHit(hit, ONE_TERM, NOW);

		expect(breakdown.fieldContribution).toEqual({
			title: 3.0,
			path: 1.0,
			frontmatter: 2.0,
			tag: 2.0,
			heading: 1.5,
			body: 1.0,
		});
		expect(breakdown.base).toBeCloseTo(10.5, 10);
	});

	it('leaves fields without a match at zero', () => {
		const breakdown = ranker().scoreHit(makeHit(), ONE_TERM, NOW);

		expect(breakdown.fieldContribution.title).toBe(0);
		expect(breakdown.fieldContribution.tag).toBe(0);
		expect(breakdown.fieldContribution.body).toBe(1.0);
	});
});

/* -------------------------------------------------------------------------- */
/* Logarithmic damping                                                        */
/* -------------------------------------------------------------------------- */

describe('occurrence damping', () => {
	it('rewards 100 occurrences over 10, but by well under ten times', () => {
		const ten = makeHit({ matches: makeMatches(10) });
		const hundred = makeHit({ matches: makeMatches(100) });

		const scoreTen = scoreOf(ten);
		const scoreHundred = scoreOf(hundred);

		expect(scoreHundred).toBeGreaterThan(scoreTen);
		expect(scoreHundred / scoreTen).toBeLessThan(2);
	});

	it('stays strictly increasing so more occurrences never score less', () => {
		let previous = 0;
		for (const count of [1, 2, 5, 10, 100, 1_000, 10_000]) {
			const score = scoreOf(makeHit({ matches: makeMatches(count) }));
			expect(score).toBeGreaterThan(previous);
			previous = score;
		}
	});

	it('never lets repetition alone beat a single title match', () => {
		const title = makeHit({ path: 'title.md', matches: [makeMatch({ field: 'title' })] });
		for (const count of [10, 100, 1_000, 100_000]) {
			const flood = makeHit({
				path: 'flood.md',
				matches: makeMatches(count, { wholeWord: true }),
			});
			expect(scoreOf(title)).toBeGreaterThan(scoreOf(flood));
		}
	});

	it('reports the damping as frequencyFactor without double-counting it', () => {
		const breakdown = ranker().scoreHit(makeHit({ matches: makeMatches(100) }), ONE_TERM, NOW);

		expect(breakdown.frequencyFactor).toBeGreaterThan(1);
		expect(breakdown.frequencyFactor).toBeLessThan(2.2);
		// base already contains it; total must not multiply it in again.
		expect(breakdown.base).toBeCloseTo(WEIGHTS.field.body * breakdown.frequencyFactor, 10);
	});
});

/* -------------------------------------------------------------------------- */
/* Whole word                                                                 */
/* -------------------------------------------------------------------------- */

describe('whole-word bonus', () => {
	it('applies to "maschine" in "die Maschine" but not inside "Espressomaschine"', () => {
		const standalone = makeHit({ path: 'a.md', matches: [makeMatch({ wholeWord: true, length: 8 })] });
		const compound = makeHit({ path: 'b.md', matches: [makeMatch({ wholeWord: false, length: 8 })] });

		expect(scoreOf(standalone) / scoreOf(compound)).toBeCloseTo(WEIGHTS.wholeWordBonus, 10);
	});

	it('reports the weighted mean of the per-match multiplier', () => {
		const all = ranker().scoreHit(makeHit({ matches: makeMatches(4, { wholeWord: true }) }), ONE_TERM, NOW);
		const none = ranker().scoreHit(makeHit({ matches: makeMatches(4) }), ONE_TERM, NOW);
		const mixed = ranker().scoreHit(
			makeHit({
				matches: [
					makeMatch({ wholeWord: true }),
					makeMatch({ start: 50, wholeWord: false }),
				],
			}),
			ONE_TERM,
			NOW,
		);

		expect(all.wholeWordFactor).toBeCloseTo(1.3, 10);
		expect(none.wholeWordFactor).toBe(1);
		expect(mixed.wholeWordFactor).toBeCloseTo(1.15, 10);
	});
});

/* -------------------------------------------------------------------------- */
/* Proximity                                                                  */
/* -------------------------------------------------------------------------- */

describe('proximity bonus', () => {
	it('prefers two terms 10 characters apart over the same two 2000 apart', () => {
		const near = makeHit({
			path: 'near.md',
			matches: [
				makeMatch({ termIndex: 0, start: 100, length: 4 }),
				makeMatch({ termIndex: 1, start: 114, length: 4 }),
			],
		});
		const far = makeHit({
			path: 'far.md',
			matches: [
				makeMatch({ termIndex: 0, start: 100, length: 4 }),
				makeMatch({ termIndex: 1, start: 2_100, length: 4 }),
			],
		});

		const nearBreakdown = ranker().scoreHit(near, TWO_TERMS, NOW);
		const farBreakdown = ranker().scoreHit(far, TWO_TERMS, NOW);

		expect(nearBreakdown.proximityFactor).toBeGreaterThan(1);
		expect(nearBreakdown.proximityFactor).toBeLessThanOrEqual(WEIGHTS.maxProximityBonus);
		expect(farBreakdown.proximityFactor).toBe(1);
		expect(nearBreakdown.total).toBeGreaterThan(farBreakdown.total);
	});

	it('is exactly 1.0 for a single-term query, however often the term repeats', () => {
		const hit = makeHit({ matches: makeMatches(5, { start: 0 }) });

		expect(ranker().scoreHit(hit, ONE_TERM, NOW).proximityFactor).toBe(1);
	});

	it('is exactly 1.0 when only one of two terms matched', () => {
		const hit = makeHit({ matches: makeMatches(3, { termIndex: 1 }) });

		expect(ranker().scoreHit(hit, TWO_TERMS, NOW).proximityFactor).toBe(1);
	});

	it('picks the tightest window across repeated occurrences', () => {
		const spread = makeHit({
			matches: [
				makeMatch({ termIndex: 0, start: 0, length: 4 }),
				makeMatch({ termIndex: 1, start: 900, length: 4 }),
				makeMatch({ termIndex: 0, start: 902, length: 4 }),
			],
		});

		// The tight pair at 900/902 wins over the 0/900 pair.
		expect(ranker().scoreHit(spread, TWO_TERMS, NOW).proximityFactor).toBeCloseTo(
			1 + (WEIGHTS.maxProximityBonus - 1) * (1 - 6 / WEIGHTS.proximityWindow),
			10,
		);
	});

	it('never compares offsets across offset domains', () => {
		// A title offset and a body offset index into different strings, so the
		// numeric distance between them is meaningless and earns no bonus.
		const crossDomain = makeHit({
			matches: [
				makeMatch({ termIndex: 0, field: 'title', start: 2, length: 4 }),
				makeMatch({ termIndex: 1, field: 'body', start: 6, length: 4 }),
			],
		});

		expect(ranker().scoreHit(crossDomain, TWO_TERMS, NOW).proximityFactor).toBe(1);
	});

	it('treats body, heading, frontmatter and tag as one domain', () => {
		const sameDomain = makeHit({
			matches: [
				makeMatch({ termIndex: 0, field: 'heading', start: 40, length: 4 }),
				makeMatch({ termIndex: 1, field: 'body', start: 48, length: 4 }),
			],
		});

		expect(ranker().scoreHit(sameDomain, TWO_TERMS, NOW).proximityFactor).toBeGreaterThan(1);
	});
});

/* -------------------------------------------------------------------------- */
/* Recency                                                                    */
/* -------------------------------------------------------------------------- */

describe('recency bonus', () => {
	it('orders two otherwise identical hits by modifiedAt', () => {
		const fresh = makeHit({ path: 'fresh.md', modifiedAt: NOW - DAY });
		const stale = makeHit({ path: 'stale.md', modifiedAt: NOW - 300 * DAY });

		const ranked = ranker().rank([stale, fresh], ONE_TERM, NOW);

		expect(ranked.map((hit) => hit.path)).toEqual(['fresh.md', 'stale.md']);
	});

	it('is small enough that a strictly better text match still wins', () => {
		const oldTitle = makeHit({
			path: 'old.md',
			modifiedAt: NOW - 10 * 365 * DAY,
			matches: [makeMatch({ field: 'title' })],
		});
		const freshBody = makeHit({ path: 'fresh.md', modifiedAt: NOW });

		expect(scoreOf(oldTitle)).toBeGreaterThan(scoreOf(freshBody));
	});

	it('decays to exactly 1.0 at the half-life and stays there', () => {
		const atHalfLife = ranker().scoreHit(makeHit({ modifiedAt: NOW - 365 * DAY }), ONE_TERM, NOW);
		const older = ranker().scoreHit(makeHit({ modifiedAt: NOW - 4_000 * DAY }), ONE_TERM, NOW);

		expect(atHalfLife.recencyFactor).toBeCloseTo(1, 10);
		expect(older.recencyFactor).toBe(1);
	});

	it('caps a future timestamp at the age-zero bonus', () => {
		const future = ranker().scoreHit(makeHit({ modifiedAt: NOW + 90 * DAY }), ONE_TERM, NOW);

		expect(future.recencyFactor).toBeCloseTo(WEIGHTS.maxRecencyBonus, 10);
	});
});

/* -------------------------------------------------------------------------- */
/* Quality                                                                    */
/* -------------------------------------------------------------------------- */

describe('quality penalty', () => {
	it('keeps an exact hit above the fuzzy version of the same file', () => {
		const exact = makeHit({ fileId: 7, path: 'kaffee.md', quality: 'exact' });
		const fuzzy = makeHit({ fileId: 7, path: 'kaffee.md', quality: 'fuzzy' });

		expect(scoreOf(exact)).toBeGreaterThan(scoreOf(fuzzy));
	});

	it('applies fuzzyPenalty and aliasPenalty exactly once per hit, not per match', () => {
		const matches = makeMatches(3, { wholeWord: true });
		const exact = ranker().scoreHit(makeHit({ matches, quality: 'exact' }), ONE_TERM, NOW);
		const alias = ranker().scoreHit(makeHit({ matches, quality: 'alias' }), ONE_TERM, NOW);
		const fuzzy = ranker().scoreHit(makeHit({ matches, quality: 'fuzzy' }), ONE_TERM, NOW);

		expect(exact.qualityFactor).toBe(1);
		expect(alias.qualityFactor).toBe(WEIGHTS.aliasPenalty);
		expect(fuzzy.qualityFactor).toBe(WEIGHTS.fuzzyPenalty);
		expect(alias.total).toBeCloseTo(exact.total * WEIGHTS.aliasPenalty, 10);
		expect(fuzzy.total).toBeCloseTo(exact.total * WEIGHTS.fuzzyPenalty, 10);
	});

	/**
	 * plan.md section 3.1: "Exakte Treffer bleiben immer zuoberst". The penalty
	 * alone cannot deliver that. A fuzzy match is always a whole word (1.3) while
	 * an exact match may be an infix (1.0) — 1.3 × 0.7 = 0.91 — so a repeated
	 * typo used to outscore, and outrank, the note that really contains the term.
	 */
	it('keeps an exact hit above a fuzzy hit from another file that scores far higher', () => {
		const typo = makeHit({
			fileId: 1,
			path: 'Tippfehler.md',
			quality: 'fuzzy',
			matches: makeMatches(3, { field: 'body', wholeWord: true }),
		});
		const exact = makeHit({
			fileId: 2,
			path: 'Exakt.md',
			quality: 'exact',
			matches: [makeMatch({ field: 'body' })],
		});
		const instance = ranker();

		// The premise: on raw score the fuzzy hit really is the stronger one.
		expect(instance.scoreHit(typo, ONE_TERM, NOW).total).toBeGreaterThan(
			instance.scoreHit(exact, ONE_TERM, NOW).total,
		);

		const ranked = instance.rank([typo, exact], ONE_TERM, NOW);
		expect(ranked.map((hit) => hit.path)).toEqual(['Exakt.md', 'Tippfehler.md']);
	});

	it('orders exact before alias before fuzzy however the scores fall', () => {
		const fuzzy = makeHit({ fileId: 1, path: 'f.md', quality: 'fuzzy', matches: makeMatches(6, { field: 'title', wholeWord: true }) });
		const alias = makeHit({ fileId: 2, path: 'a.md', quality: 'alias', matches: makeMatches(2, { field: 'body', wholeWord: true }) });
		const exact = makeHit({ fileId: 3, path: 'e.md', quality: 'exact', matches: [makeMatch({ field: 'body' })] });
		const instance = ranker();

		expect(instance.scoreHit(fuzzy, ONE_TERM, NOW).total).toBeGreaterThan(instance.scoreHit(alias, ONE_TERM, NOW).total);
		expect(instance.scoreHit(alias, ONE_TERM, NOW).total).toBeGreaterThan(instance.scoreHit(exact, ONE_TERM, NOW).total);

		expect(instance.rank([fuzzy, alias, exact], ONE_TERM, NOW).map((hit) => hit.path)).toEqual([
			'e.md',
			'a.md',
			'f.md',
		]);
	});

	it('still sorts by score inside one quality class', () => {
		const weak = makeHit({ fileId: 1, path: 'weak.md', quality: 'fuzzy', matches: [makeMatch({ field: 'body' })] });
		const strong = makeHit({ fileId: 2, path: 'strong.md', quality: 'fuzzy', matches: [makeMatch({ field: 'title' })] });

		expect(ranker().rank([weak, strong], ONE_TERM, NOW).map((hit) => hit.path)).toEqual(['strong.md', 'weak.md']);
	});
});

/* -------------------------------------------------------------------------- */
/* Breakdown identity                                                         */
/* -------------------------------------------------------------------------- */

describe('score breakdown', () => {
	it('multiplies out to the total for every factor combination', () => {
		const hit = makeHit({
			modifiedAt: NOW - 40 * DAY,
			quality: 'alias',
			matches: [
				makeMatch({ termIndex: 0, field: 'title', wholeWord: true, length: 5 }),
				makeMatch({ termIndex: 0, field: 'body', start: 300, length: 5 }),
				makeMatch({ termIndex: 1, field: 'body', start: 340, wholeWord: true, length: 5 }),
				makeMatch({ termIndex: 1, field: 'heading', start: 700, length: 5 }),
			],
		});

		const breakdown = ranker().scoreHit(hit, TWO_TERMS, NOW);
		const sumOfFields = Object.values(breakdown.fieldContribution).reduce((a, b) => a + b, 0);

		expect(breakdown.base).toBeCloseTo(sumOfFields, 10);
		expect(breakdown.total).toBeCloseTo(
			breakdown.base *
				breakdown.wholeWordFactor *
				breakdown.proximityFactor *
				breakdown.recencyFactor *
				breakdown.qualityFactor,
			10,
		);
	});

	it('is the same number rank() sorts on', () => {
		const hits = [
			makeHit({ path: 'a.md', matches: [makeMatch({ field: 'title' })] }),
			makeHit({ path: 'b.md', matches: makeMatches(4, { wholeWord: true }) }),
			makeHit({ path: 'c.md', quality: 'fuzzy' }),
		];
		const instance = ranker();

		for (const ranked of instance.rank(hits, ONE_TERM, NOW)) {
			const source = hits.find((hit) => hit.path === ranked.path);
			expect(source).toBeDefined();
			if (!source) continue;
			expect(ranked.score).toBe(instance.scoreHit(source, ONE_TERM, NOW).total);
		}
	});

	it('scores a hit without matches as zero without producing NaN', () => {
		const breakdown = ranker().scoreHit(makeHit({ matches: [] }), TWO_TERMS, NOW);

		expect(breakdown.base).toBe(0);
		expect(breakdown.wholeWordFactor).toBe(1);
		expect(breakdown.frequencyFactor).toBe(1);
		expect(breakdown.proximityFactor).toBe(1);
		expect(breakdown.total).toBe(0);
	});

	it('does not mutate the hits handed to rank()', () => {
		const hit = makeHit();
		const before = JSON.stringify(hit);

		ranker().rank([hit], ONE_TERM, NOW);

		expect(JSON.stringify(hit)).toBe(before);
	});
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

describe('normalize', () => {
	it('gives the best hit 100 and scales the rest proportionally', () => {
		const hits = [
			toRanked(makeHit({ path: 'a.md' }), 8),
			toRanked(makeHit({ path: 'b.md' }), 4),
			toRanked(makeHit({ path: 'c.md' }), 2),
		];

		Ranker.normalize(hits);

		expect(hits.map((hit) => hit.relevance)).toEqual([100, 50, 25]);
	});

	it('gives a single-hit set 100', () => {
		const hits = [toRanked(makeHit(), 0.0001)];

		Ranker.normalize(hits);

		expect(hits[0].relevance).toBe(100);
	});

	it('does not divide by zero on an empty set', () => {
		const hits: RankedHit[] = [];

		expect(() => Ranker.normalize(hits)).not.toThrow();
		expect(hits).toHaveLength(0);
	});

	it('does not divide by zero when every score is zero', () => {
		const hits = [toRanked(makeHit({ path: 'a.md' }), 0), toRanked(makeHit({ path: 'b.md' }), 0)];

		Ranker.normalize(hits);

		expect(hits.map((hit) => hit.relevance)).toEqual([0, 0]);
		expect(hits.every((hit) => Number.isFinite(hit.relevance))).toBe(true);
	});

	it('is applied by rank(), best hit first', () => {
		const ranked = ranker().rank(
			[makeHit({ path: 'b.md' }), makeHit({ path: 'a.md', matches: [makeMatch({ field: 'title' })] })],
			ONE_TERM,
			NOW,
		);

		expect(ranked[0].relevance).toBe(100);
		expect(ranked[1].relevance).toBeLessThan(100);
		expect(ranked[1].relevance).toBeGreaterThan(0);
	});
});

/* -------------------------------------------------------------------------- */
/* Sorting                                                                    */
/* -------------------------------------------------------------------------- */

function sortFixture(): RankedHit[] {
	return [
		toRanked(makeHit({ fileId: 1, path: 'b/Apfel.md', title: 'Apfel', createdAt: NOW - 5 * DAY, modifiedAt: NOW - 2 * DAY }), 5),
		toRanked(makeHit({ fileId: 2, path: 'a/Ähnlich.md', title: 'Ähnlich', createdAt: NOW - 9 * DAY, modifiedAt: NOW - 1 * DAY }), 3),
		toRanked(makeHit({ fileId: 3, path: 'c/Banane.md', title: 'Banane', createdAt: NOW - 1 * DAY, modifiedAt: NOW - 8 * DAY }), 9),
		toRanked(makeHit({ fileId: 4, path: 'a/note2.md', title: 'note2', createdAt: NOW - 3 * DAY, modifiedAt: NOW - 3 * DAY }), 5),
		toRanked(makeHit({ fileId: 5, path: 'a/note10.md', title: 'note10', createdAt: NOW - 3 * DAY, modifiedAt: NOW - 3 * DAY }), 5),
		toRanked(makeHit({ fileId: 6, path: 'a/Zebra.md', title: 'Zebra', createdAt: NOW - 3 * DAY, modifiedAt: NOW - 3 * DAY }), 1),
	];
}

describe('sort', () => {
	it('is a total order for every sort key', () => {
		for (const key of SORT_KEYS) {
			const hits = sortFixture();
			for (const a of hits) {
				expect(Ranker.compare(a, a, key)).toBe(0);
				for (const b of hits) {
					if (a === b) continue;
					const forward = Ranker.compare(a, b, key);
					const backward = Ranker.compare(b, a, key);
					// Antisymmetric, and never 0 for two distinct files.
					expect(forward).toBe(-backward);
					expect(forward).not.toBe(0);
					for (const c of hits) {
						if (c === a || c === b) continue;
						if (forward < 0 && Ranker.compare(b, c, key) < 0) {
							expect(Ranker.compare(a, c, key)).toBeLessThan(0);
						}
					}
				}
			}
		}
	});

	it('is stable across repeated calls', () => {
		for (const key of SORT_KEYS) {
			const once = Ranker.sort(sortFixture(), key).map((hit) => hit.fileId);
			const twice = Ranker.sort(Ranker.sort(sortFixture(), key), key).map((hit) => hit.fileId);
			const fromOtherStart = Ranker.sort(sortFixture().reverse(), key).map((hit) => hit.fileId);

			expect(twice).toEqual(once);
			expect(fromOtherStart).toEqual(once);
		}
	});

	it('sorts by relevance score descending', () => {
		const sorted = Ranker.sort(sortFixture(), 'relevance');

		expect(sorted.map((hit) => hit.score)).toEqual([9, 5, 5, 5, 3, 1]);
	});

	it('uses locale-aware comparison for title-asc, so "Ä" sorts next to "A"', () => {
		const titles = Ranker.sort(sortFixture(), 'title-asc').map((hit) => hit.title);

		expect(titles).toEqual(['Ähnlich', 'Apfel', 'Banane', 'note2', 'note10', 'Zebra']);
	});

	it('sorts created and modified in both directions', () => {
		expect(Ranker.sort(sortFixture(), 'created-desc').map((hit) => hit.fileId)).toEqual([3, 4, 5, 6, 1, 2]);
		expect(Ranker.sort(sortFixture(), 'created-asc').map((hit) => hit.fileId)).toEqual([2, 1, 4, 5, 6, 3]);
		expect(Ranker.sort(sortFixture(), 'modified-desc').map((hit) => hit.fileId)).toEqual([2, 1, 4, 5, 6, 3]);
		expect(Ranker.sort(sortFixture(), 'modified-asc').map((hit) => hit.fileId)).toEqual([3, 4, 5, 6, 1, 2]);
	});

	it('sorts by path and keeps path as the tiebreaker everywhere else', () => {
		expect(Ranker.sort(sortFixture(), 'path-asc').map((hit) => hit.path)).toEqual([
			'a/Ähnlich.md',
			'a/note2.md',
			'a/note10.md',
			'a/Zebra.md',
			'b/Apfel.md',
			'c/Banane.md',
		]);
	});

	it('separates paths that differ only in case', () => {
		const lower = toRanked(makeHit({ fileId: 10, path: 'a/note.md', title: 'note' }), 1);
		const upper = toRanked(makeHit({ fileId: 11, path: 'a/Note.md', title: 'Note' }), 1);

		expect(Ranker.compare(lower, upper, 'path-asc')).not.toBe(0);
		expect(Ranker.compare(lower, upper, 'path-asc')).toBe(-Ranker.compare(upper, lower, 'path-asc'));
	});

	it('sorts in place and returns the same array', () => {
		const hits = sortFixture();

		expect(Ranker.sort(hits, 'title-asc')).toBe(hits);
	});

	/**
	 * Guards the collator, not the sort algorithm.
	 *
	 * `path.localeCompare(other, undefined, options)` builds a fresh
	 * `Intl.Collator` per call, and every hit here ties on score, so the path
	 * tiebreaker runs for all ~100 000 comparisons. Measured on this fixture:
	 * 232 ms with a per-call collator against 14 ms with one shared collator, so
	 * a 100 ms budget separates the two by a factor of seven in both directions.
	 * The order is asserted as well — a faster comparator that sorted
	 * differently would be no fix at all.
	 */
	it('sorts a large tie-heavy result set with one collator, not one per comparison', () => {
		const folders = ['Projekte/2024', 'Notizen/Täglich', 'Archiv/Alt', 'Inbox', 'Küche/Rezepte'];
		const hits: RankedHit[] = [];
		for (let i = 0; i < 8000; i++) {
			const path = `${folders[i % folders.length]}/Notiz Wärmepumpe ${String(i)}.md`;
			hits.push(toRanked(makeHit({ fileId: 1000 + i, path }), 1));
		}

		const started = performance.now();
		const sorted = Ranker.sort(hits, 'relevance');
		const elapsed = performance.now() - started;

		expect(elapsed).toBeLessThan(100);
		for (let i = 1; i < sorted.length; i++) {
			expect(Ranker.compare(sorted[i - 1], sorted[i], 'relevance')).toBeLessThan(0);
		}
	});
});

/* -------------------------------------------------------------------------- */
/* A result set with no terms                                                 */
/* -------------------------------------------------------------------------- */

const NO_TERMS = makeAst(0);

/** What a filter-only search hands the Ranker: hits with an empty match list. */
function filterHit(spec: { path: string; createdAt: number; modifiedAt?: number }): RawHit {
	return makeHit({
		path: spec.path,
		matches: [],
		createdAt: spec.createdAt,
		modifiedAt: spec.modifiedAt ?? spec.createdAt,
	});
}

describe('a query with no terms', () => {
	it('resolves the relevance key to created-desc and leaves every other key alone', () => {
		expect(Ranker.effectiveSort('relevance', NO_TERMS)).toBe('created-desc');
		expect(Ranker.effectiveSort('relevance', ONE_TERM)).toBe('relevance');
		for (const key of SORT_KEYS) {
			if (key === 'relevance') continue;
			expect(Ranker.effectiveSort(key, NO_TERMS)).toBe(key);
			expect(Ranker.effectiveSort(key, TWO_TERMS)).toBe(key);
		}
	});

	it('orders by created descending, newest first', () => {
		const hits = [
			filterHit({ path: 'a/Alt.md', createdAt: NOW - 30 * DAY }),
			filterHit({ path: 'b/Neu.md', createdAt: NOW - 1 * DAY }),
			filterHit({ path: 'c/Mitte.md', createdAt: NOW - 10 * DAY }),
		];

		const ranked = ranker().rank(hits, NO_TERMS, NOW);

		expect(ranked.map((hit) => hit.path)).toEqual(['b/Neu.md', 'c/Mitte.md', 'a/Alt.md']);
	});

	it('breaks a tie on the creation date by path, so the order never wobbles', () => {
		const hits = [
			filterHit({ path: 'b/Zweite.md', createdAt: NOW - 5 * DAY }),
			filterHit({ path: 'a/Erste.md', createdAt: NOW - 5 * DAY }),
		];

		expect(ranker().rank(hits, NO_TERMS, NOW).map((hit) => hit.path)).toEqual(['a/Erste.md', 'b/Zweite.md']);
	});

	it('reports no relevance at all instead of a fake 100 for everything', () => {
		const hits = [
			filterHit({ path: 'a/Eins.md', createdAt: NOW - 2 * DAY }),
			filterHit({ path: 'b/Zwei.md', createdAt: NOW - 3 * DAY, modifiedAt: NOW }),
		];

		const ranked = ranker().rank(hits, NO_TERMS, NOW);

		for (const hit of ranked) {
			expect(hit.score).toBe(0);
			expect(hit.relevance).toBe(0);
		}
	});

	it('does not let the recency bonus creep into a term-less score', () => {
		// Every hit stays at 0: a note modified today must not outrank one
		// modified last year when nothing was searched for.
		const fresh = filterHit({ path: 'a/Frisch.md', createdAt: NOW - 2 * DAY, modifiedAt: NOW });
		const stale = filterHit({ path: 'b/Alt.md', createdAt: NOW - 1 * DAY, modifiedAt: NOW - 400 * DAY });

		const ranked = ranker().rank([fresh, stale], NO_TERMS, NOW);

		expect(ranked.map((hit) => hit.score)).toEqual([0, 0]);
		// created-desc decides, not freshness.
		expect(ranked.map((hit) => hit.path)).toEqual(['b/Alt.md', 'a/Frisch.md']);
	});

	it('still obeys a sort key the user picked', () => {
		const hits = [
			filterHit({ path: 'a/Alt.md', createdAt: NOW - 30 * DAY, modifiedAt: NOW - 1 * DAY }),
			filterHit({ path: 'b/Neu.md', createdAt: NOW - 1 * DAY, modifiedAt: NOW - 30 * DAY }),
		];

		// What the modal does: rank, then re-sort for any key but 'relevance'.
		const ranked = ranker().rank(hits, NO_TERMS, NOW);
		expect(Ranker.sort(ranked, 'modified-desc').map((hit) => hit.path)).toEqual(['a/Alt.md', 'b/Neu.md']);
		expect(Ranker.sort(ranked, 'title-asc').map((hit) => hit.title)).toEqual(['Alt', 'Neu']);
	});

	it('scores a hit that does carry matches the usual way, so only the term-less case changes', () => {
		const hits = [makeHit({ path: 'a.md', matches: [makeMatch({ field: 'title' })] })];

		const ranked = ranker().rank(hits, ONE_TERM, NOW);

		expect(ranked[0].score).toBeGreaterThan(0);
		expect(ranked[0].relevance).toBe(100);
	});
});

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

describe('ranking snapshot', () => {
	/** Fixed 20-hit fixture: any weight change has to be acknowledged in this diff. */
	function snapshotFixture(): RawHit[] {
		const specs: { path: string; title: string; matches: Match[]; quality: MatchQuality; ageDays: number }[] = [
			{ path: 'inbox/Kaffee.md', title: 'Kaffee', matches: [makeMatch({ field: 'title', wholeWord: true, length: 6 })], quality: 'exact', ageDays: 1 },
			{ path: 'inbox/Kaffeemaschine.md', title: 'Kaffeemaschine', matches: [makeMatch({ field: 'title', length: 6 })], quality: 'exact', ageDays: 40 },
			{ path: 'projekte/Espresso.md', title: 'Espresso', matches: makeMatches(3, { field: 'body', wholeWord: true }), quality: 'exact', ageDays: 5 },
			{ path: 'projekte/Barista.md', title: 'Barista', matches: makeMatches(12, { field: 'body' }), quality: 'exact', ageDays: 200 },
			{ path: 'projekte/Roesterei.md', title: 'Rösterei', matches: makeMatches(60, { field: 'body' }), quality: 'exact', ageDays: 700 },
			{ path: 'notizen/Milch.md', title: 'Milch', matches: [makeMatch({ field: 'heading', wholeWord: true })], quality: 'exact', ageDays: 12 },
			{ path: 'notizen/Zucker.md', title: 'Zucker', matches: [makeMatch({ field: 'frontmatter' })], quality: 'exact', ageDays: 90 },
			{ path: 'notizen/Tasse.md', title: 'Tasse', matches: [makeMatch({ field: 'tag', wholeWord: true })], quality: 'exact', ageDays: 3 },
			{ path: 'archiv/2024/Muehle.md', title: 'Mühle', matches: [makeMatch({ field: 'path' })], quality: 'alias', ageDays: 900 },
			{ path: 'archiv/2024/Filter.md', title: 'Filter', matches: makeMatches(2, { field: 'body', wholeWord: true }), quality: 'alias', ageDays: 365 },
			{
				path: 'küche/Rezepte.md',
				title: 'Rezepte',
				matches: [
					makeMatch({ termIndex: 0, field: 'body', start: 100, wholeWord: true }),
					makeMatch({ termIndex: 1, field: 'body', start: 112, wholeWord: true }),
				],
				quality: 'exact',
				ageDays: 20,
			},
			{
				path: 'küche/Einkauf.md',
				title: 'Einkauf',
				matches: [
					makeMatch({ termIndex: 0, field: 'body', start: 100 }),
					makeMatch({ termIndex: 1, field: 'body', start: 2_400 }),
				],
				quality: 'exact',
				ageDays: 20,
			},
			{
				path: 'küche/Vorrat.md',
				title: 'Vorrat',
				matches: [
					makeMatch({ termIndex: 0, field: 'title', wholeWord: true }),
					makeMatch({ termIndex: 1, field: 'body', start: 60 }),
				],
				quality: 'exact',
				ageDays: 60,
			},
			{ path: 'daily/2026-03-01.md', title: '2026-03-01', matches: [makeMatch({ field: 'body' })], quality: 'fuzzy', ageDays: 13 },
			{ path: 'daily/2026-03-02.md', title: '2026-03-02', matches: makeMatches(4, { field: 'body' }), quality: 'fuzzy', ageDays: 12 },
			{ path: 'daily/2026-03-03.md', title: '2026-03-03', matches: [makeMatch({ field: 'title' })], quality: 'fuzzy', ageDays: 11 },
			{ path: 'referenz/Norm SIA 384.md', title: 'Norm SIA 384', matches: [makeMatch({ field: 'heading' }), makeMatch({ field: 'body', start: 500 })], quality: 'exact', ageDays: 150 },
			{ path: 'referenz/Norm SIA 385.md', title: 'Norm SIA 385', matches: [makeMatch({ field: 'heading' }), makeMatch({ field: 'body', start: 500 })], quality: 'exact', ageDays: 151 },
			{ path: 'referenz/Anhang.md', title: 'Anhang', matches: [], quality: 'exact', ageDays: 400 },
			{ path: 'Übersicht.md', title: 'Übersicht', matches: [makeMatch({ field: 'title', wholeWord: true }), makeMatch({ field: 'tag', start: 4 })], quality: 'exact', ageDays: 0 },
		];

		return specs.map((spec, index) =>
			makeHit({
				fileId: 100 + index,
				path: spec.path,
				title: spec.title,
				matches: spec.matches,
				quality: spec.quality,
				createdAt: NOW - (spec.ageDays + 30) * DAY,
				modifiedAt: NOW - spec.ageDays * DAY,
			}),
		);
	}

	/**
	 * Reading the snapshot: the list is exact hits (01-15), then alias (16-17),
	 * then fuzzy (18-20), because quality is the primary key of the relevance
	 * order. The percentages therefore do not fall monotonically — 18 scores
	 * higher than 16 and still ranks below it. That is the plan's rule, not a
	 * rounding artefact.
	 */
	it('produces a stable order and relevance for a fixed 20-hit set', () => {
		const ranked = ranker().rank(snapshotFixture(), TWO_TERMS, NOW);
		const lines = ranked.map(
			(hit, index) => `${String(index + 1).padStart(2, '0')} ${hit.relevance.toString().padStart(3, ' ')} ${hit.score.toFixed(4)} ${hit.path}`,
		);

		expect(lines).toMatchInlineSnapshot(`
			[
			  "01 100 6.7850 Übersicht.md",
			  "02  81 5.5142 küche/Vorrat.md",
			  "03  66 4.4834 inbox/Kaffee.md",
			  "04  50 3.4007 inbox/Kaffeemaschine.md",
			  "05  44 2.9868 notizen/Tasse.md",
			  "06  40 2.7209 referenz/Norm SIA 384.md",
			  "07  40 2.7199 referenz/Norm SIA 385.md",
			  "08  36 2.4131 küche/Rezepte.md",
			  "09  33 2.2329 notizen/Milch.md",
			  "10  33 2.2260 notizen/Zucker.md",
			  "11  28 1.8782 projekte/Espresso.md",
			  "12  24 1.6070 projekte/Roesterei.md",
			  "13  23 1.5588 projekte/Barista.md",
			  "14  20 1.3441 küche/Einkauf.md",
			  "15   0 0.0000 referenz/Anhang.md",
			  "16  21 1.4539 archiv/2024/Filter.md",
			  "17  14 0.9500 archiv/2024/Muehle.md",
			  "18  35 2.4055 daily/2026-03-03.md",
			  "19  15 1.0491 daily/2026-03-02.md",
			  "20  12 0.8013 daily/2026-03-01.md",
			]
		`);
	});
});
