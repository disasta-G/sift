import { describe, expect, it } from 'vitest';

import {
	addOrTerm,
	buildTerm,
	isFieldPrefix,
	parseQuery,
	splitPropertyTerm,
	stringifyQuery,
} from '../../src/search/QueryParser';
import type { QueryAst, QueryParseErrorCode, QueryTerm, SiftTuning, TermField } from '../../src/types';

/**
 * Mirrors DEFAULT_TUNING in src/settings.ts. It is duplicated rather than
 * imported because settings.ts pulls in the `obsidian` module, which does not
 * exist outside the app. The values that matter here are the contract from
 * types.ts: trigram size 3, minimum trigram term length 3, at most 8 variants
 * per term and a 512-character query limit.
 */
const TUNING: SiftTuning = Object.freeze({
	trigramSize: 3,
	minTrigramTermLength: 3,
	maxTermVariants: 8,
	maxQueryLength: 512,
	snippetLength: 160,
	snippetLines: 5,
	fuzzyMaxDistanceShort: 1,
	fuzzyMaxDistanceLong: 2,
	fuzzyShortTermMaxLength: 5,
	searchDebounceMs: 120,
	indexSliceMs: 12,
	storeBatchSize: 200,
	weights: Object.freeze({
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
	}),
} satisfies SiftTuning);

function parse(raw: string): QueryAst {
	return parseQuery(raw, TUNING);
}

/* ========================================================================== */
/* Shape helpers                                                              */
/* ========================================================================== */

/** The part of a term the grammar decides. Variants and trigrams are checked separately. */
interface TermShape {
	kind: QueryTerm['kind'];
	field: TermField;
	raw: string;
}

interface AstShape {
	must: TermShape[];
	mustNot: TermShape[];
	should: TermShape[][];
	isEmpty: boolean;
}

function w(raw: string, field: TermField = 'any'): TermShape {
	return { kind: 'word', field, raw };
}

function p(raw: string, field: TermField = 'any'): TermShape {
	return { kind: 'phrase', field, raw };
}

function shapeOf(term: QueryTerm): TermShape {
	return { kind: term.kind, field: term.field, raw: term.raw };
}

function shape(ast: QueryAst): AstShape {
	return {
		must: ast.must.map(shapeOf),
		mustNot: ast.mustNot.map(shapeOf),
		should: ast.should.map((group) => group.map(shapeOf)),
		isEmpty: ast.isEmpty,
	};
}

function codes(ast: QueryAst): QueryParseErrorCode[] {
	return ast.errors.map((error) => error.code);
}

/** Every term of the AST, in no particular order — for invariants that hold for all of them. */
function allTerms(ast: QueryAst): QueryTerm[] {
	const out: QueryTerm[] = [...ast.must, ...ast.mustNot];
	for (const group of ast.should) out.push(...group);
	return out;
}

/* ========================================================================== */
/* 1. Grammar table                                                           */
/* ========================================================================== */

interface GrammarCase {
	query: string;
	must?: TermShape[];
	mustNot?: TermShape[];
	should?: TermShape[][];
	isEmpty?: boolean;
}

const GRAMMAR: readonly GrammarCase[] = [
	{ query: 'a b', must: [w('a'), w('b')] },
	{ query: '"a b"', must: [p('a b')] },
	{ query: '-a', mustNot: [w('a')], isEmpty: true },
	{ query: 'a OR b', should: [[w('a'), w('b')]] },
	// OR binds tighter than the implicit AND.
	{ query: 'a b OR c', must: [w('a')], should: [[w('b'), w('c')]] },
	{ query: 'a OR b c', must: [w('c')], should: [[w('a'), w('b')]] },
	{ query: 'a OR b OR c', should: [[w('a'), w('b'), w('c')]] },
	{ query: 'a b OR c d', must: [w('a'), w('d')], should: [[w('b'), w('c')]] },
	{ query: '-"a b"', mustNot: [p('a b')], isEmpty: true },
	{ query: '"a b" c', must: [p('a b'), w('c')] },
	{ query: 'a -b', must: [w('a')], mustNot: [w('b')] },
	{ query: '-a -b', mustNot: [w('a'), w('b')], isEmpty: true },
	// Prefixes, alone and combined with negation and quotes.
	{ query: 'path:Projekte', must: [w('Projekte', 'path')] },
	{ query: 'tag:hlks', must: [w('hlks', 'tag')] },
	{ query: 'title:Küche', must: [w('Küche', 'title')] },
	{ query: 'prop:status', must: [w('status', 'property')] },
	{ query: 'prop:status=offen', must: [w('status=offen', 'property')] },
	{ query: '-prop:status=offen', mustNot: [w('status=offen', 'property')], isEmpty: true },
	{ query: 'path:"Alte Projekte"', must: [p('Alte Projekte', 'path')] },
	{ query: '-path:"Alte Projekte"', mustNot: [p('Alte Projekte', 'path')], isEmpty: true },
	{ query: '-tag:archiv', mustNot: [w('archiv', 'tag')], isEmpty: true },
	{ query: 'PATH:Projekte', must: [w('Projekte', 'path')] },
	// An unknown field stays literal text, prefix included.
	{ query: 'foo:bar', must: [w('foo:bar')] },
	{ query: 'https://x.example', must: [w('https://x.example')] },
	// `-` only negates at the start of a token.
	{ query: 'e-mail', must: [w('e-mail')] },
	{ query: 'a-b -c-d', must: [w('a-b')], mustNot: [w('c-d')] },
	// `OR` is an operator only as a bare upper-case token.
	{ query: 'a "OR" b', must: [w('a'), p('OR'), w('b')] },
	{ query: 'a or b', must: [w('a'), w('or'), w('b')] },
	{ query: 'a ORb', must: [w('a'), w('ORb')] },
	{ query: 'path:OR', must: [w('OR', 'path')] },
	{ query: '-OR', mustNot: [w('OR')], isEmpty: true },
	// An exclusion breaks the OR chain: the operator has no left operand left.
	{ query: 'a -b OR c', must: [w('a'), w('c')], mustNot: [w('b')] },
	// Whitespace runs, tabs and newlines are all just separators.
	{ query: '  a \t b \n c ', must: [w('a'), w('b'), w('c')] },
	{ query: '', isEmpty: true },
	{ query: '   ', isEmpty: true },
	{ query: '""', isEmpty: true },
	{ query: '-onlynegative', mustNot: [w('onlynegative')], isEmpty: true },
];

describe('parseQuery — grammar', () => {
	for (const testCase of GRAMMAR) {
		it(`parses ${JSON.stringify(testCase.query)}`, () => {
			const ast = parse(testCase.query);
			const must = testCase.must ?? [];
			const mustNot = testCase.mustNot ?? [];
			const should = testCase.should ?? [];
			expect(shape(ast)).toEqual({
				must,
				mustNot,
				should,
				isEmpty: testCase.isEmpty ?? false,
			});
			expect(ast.raw).toBe(testCase.query);
		});
	}
});

/* ========================================================================== */
/* 2. Recovery                                                                */
/* ========================================================================== */

describe('parseQuery — recovery', () => {
	it('closes an unclosed quote at the end of input', () => {
		const ast = parse('"unclosed');
		expect(shape(ast).must).toEqual([p('unclosed')]);
		expect(ast.errors).toEqual([
			{ code: 'unclosed-quote', span: { start: 0, end: 9 }, messageKey: 'error.unclosed-quote' },
		]);
	});

	it('closes an unclosed quote behind a prefix and keeps the field', () => {
		const ast = parse('kaffee path:"Alte Projekte');
		expect(shape(ast).must).toEqual([w('kaffee'), p('Alte Projekte', 'path')]);
		expect(codes(ast)).toEqual(['unclosed-quote']);
		expect(ast.errors[0].span).toEqual({ start: 12, end: 26 });
	});

	it('drops a trailing minus and records a dangling operator', () => {
		const ast = parse('a -');
		expect(shape(ast).must).toEqual([w('a')]);
		expect(ast.errors).toEqual([
			{ code: 'dangling-operator', span: { start: 2, end: 3 }, messageKey: 'error.dangling-operator' },
		]);
	});

	it('drops a minus that stands alone between terms', () => {
		const ast = parse('- a');
		expect(shape(ast).must).toEqual([w('a')]);
		expect(codes(ast)).toEqual(['dangling-operator']);
		expect(ast.errors[0].span).toEqual({ start: 0, end: 1 });
	});

	it('drops a leading OR', () => {
		const ast = parse('OR a');
		expect(shape(ast).must).toEqual([w('a')]);
		expect(codes(ast)).toEqual(['dangling-operator']);
		expect(ast.errors[0].span).toEqual({ start: 0, end: 2 });
	});

	it('drops a trailing OR', () => {
		const ast = parse('a OR');
		expect(shape(ast).must).toEqual([w('a')]);
		expect(codes(ast)).toEqual(['dangling-operator']);
		expect(ast.errors[0].span).toEqual({ start: 2, end: 4 });
	});

	it('drops the second OR of a doubled operator and still builds the group', () => {
		const ast = parse('a OR OR b');
		expect(shape(ast).should).toEqual([[w('a'), w('b')]]);
		expect(codes(ast)).toEqual(['dangling-operator']);
		expect(ast.errors[0].span).toEqual({ start: 5, end: 7 });
	});

	it('reports an OR whose left operand was an exclusion', () => {
		const ast = parse('a -b OR c');
		expect(codes(ast)).toEqual(['dangling-operator']);
		expect(ast.errors[0].span).toEqual({ start: 5, end: 7 });
	});

	it('reports an OR whose right operand is an exclusion', () => {
		const ast = parse('a OR -b');
		expect(shape(ast)).toEqual({ must: [w('a')], mustNot: [w('b')], should: [], isEmpty: false });
		expect(codes(ast)).toEqual(['dangling-operator']);
		expect(ast.errors[0].span).toEqual({ start: 2, end: 4 });
	});

	it('keeps an unknown field prefix as literal text and marks the prefix', () => {
		const ast = parse('foo:bar');
		expect(shape(ast).must).toEqual([w('foo:bar')]);
		expect(ast.errors).toEqual([
			{ code: 'unknown-field', span: { start: 0, end: 4 }, messageKey: 'error.unknown-field' },
		]);
		expect(ast.must[0].normalized).toBe('foo:bar');
	});

	it('marks the unknown prefix of a negated token without swallowing the minus', () => {
		const ast = parse('-foo:bar');
		expect(shape(ast).mustNot).toEqual([w('foo:bar')]);
		expect(ast.errors[0].span).toEqual({ start: 1, end: 5 });
	});

	it('drops a field prefix with nothing behind it', () => {
		const ast = parse('path: kaffee');
		expect(shape(ast).must).toEqual([w('kaffee')]);
		expect(codes(ast)).toEqual(['dangling-operator']);
		expect(ast.errors[0].span).toEqual({ start: 0, end: 5 });
	});

	it('truncates a query beyond maxQueryLength and records the cut', () => {
		const query = new Array(120).fill('kaffee').join(' ');
		expect(query.length).toBeGreaterThan(TUNING.maxQueryLength);
		const ast = parse(query);
		expect(ast.raw).toBe(query);
		expect(codes(ast)).toEqual(['query-too-long']);
		expect(ast.errors[0].span).toEqual({ start: TUNING.maxQueryLength, end: query.length });
		expect(ast.must.length).toBeLessThan(120);
		for (const term of ast.must) {
			expect(term.span.end).toBeLessThanOrEqual(TUNING.maxQueryLength);
		}
	});

	it('never throws, whatever it is handed', () => {
		const hostile = [
			'',
			' ',
			'-',
			'--',
			'---',
			'"',
			'""',
			'"""',
			'::::',
			':',
			'path:',
			'path::',
			'-path:',
			'OR',
			'OR OR OR',
			'- OR -',
			'a"b"c"',
			'\t\n\r ',
			'  ',
			'ü'.repeat(600),
			'"'.repeat(300),
			'path:"',
			'tag:#',
			'a'.repeat(513),
		];
		for (const query of hostile) {
			expect(() => parse(query)).not.toThrow();
			const ast = parse(query);
			expect(ast.raw).toBe(query);
			expect(ast.isEmpty).toBe(ast.terms.length === 0);
		}
	});
});

/* ========================================================================== */
/* 3. Spans                                                                   */
/* ========================================================================== */

const SPAN_QUERIES: readonly string[] = [
	'kaffee',
	'kaffee maschine',
	'"espresso maschine"',
	'-altbau',
	'kaffee OR tee',
	'path:Projekte -tag:archiv',
	'title:Küche "Alte Projekte"',
	'-path:"Alte Projekte" kaffee',
	'  Straße   OR   Strasse  ',
	'foo:bar e-mail',
	'"unclosed',
	'a "OR" b',
	'Küche\tOR\nKüchen',
	'a b"c d"e',
	'"say "hi" now"',
];

describe('parseQuery — spans', () => {
	for (const query of SPAN_QUERIES) {
		it(`spans back to the raw text of ${JSON.stringify(query)}`, () => {
			const ast = parse(query);
			expect(allTerms(ast).length).toBeGreaterThan(0);
			for (const term of allTerms(ast)) {
				expect(query.slice(term.span.start, term.span.end)).toBe(term.raw);
				expect(term.span.start).toBeGreaterThanOrEqual(0);
				expect(term.span.end).toBeLessThanOrEqual(query.length);
			}
			for (const error of ast.errors) {
				expect(error.span.start).toBeGreaterThanOrEqual(0);
				expect(error.span.end).toBeLessThanOrEqual(query.length);
				expect(error.span.end).toBeGreaterThanOrEqual(error.span.start);
			}
		});
	}

	it('keeps error spans inside the raw string when the query was truncated', () => {
		const query = `${new Array(200).fill('kaffee').join(' ')} "unclosed`;
		const ast = parse(query);
		for (const error of ast.errors) {
			expect(error.span.end).toBeLessThanOrEqual(query.length);
		}
		for (const term of allTerms(ast)) {
			expect(query.slice(term.span.start, term.span.end)).toBe(term.raw);
		}
	});
});

/* ========================================================================== */
/* 4. Term precomputation                                                     */
/* ========================================================================== */

describe('buildTerm — precomputation', () => {
	it('marks terms shorter than minTrigramTermLength and gives them no trigrams', () => {
		const short = parse('ab').must[0];
		expect(short.short).toBe(true);
		expect(short.trigrams).toEqual([]);

		const long = parse('abc').must[0];
		expect(long.short).toBe(false);
		expect(long.trigrams).toEqual(['abc']);
	});

	it('folds the term and keeps the raw text as typed', () => {
		const term = parse('title:Küche').must[0];
		expect(term.raw).toBe('Küche');
		expect(term.normalized).toBe('kuche');
		expect(term.field).toBe('title');
	});

	it('folds a decomposed query the same way as a composed one', () => {
		// A query typed on macOS arrives as a base letter plus a combining mark.
		const decomposedQuery = 'Küche';
		const composedQuery = 'Küche';
		expect(decomposedQuery).not.toBe(composedQuery);
		const composed = parse(composedQuery).must[0];
		const decomposed = parse(decomposedQuery).must[0];
		expect(composed.normalized).toBe('kuche');
		expect(decomposed.normalized).toBe('kuche');
		expect(decomposed.raw).toBe(decomposedQuery);
		expect(decomposed.variants[0]).toBe(decomposed.normalized);
		expect(decomposed.variants).toContain('kueche');
	});

	it('starts the variant list with the normalized form and carries the alias forms', () => {
		const umlaut = parse('Küche').must[0];
		expect(umlaut.variants[0]).toBe('kuche');
		expect(umlaut.variants).toContain('kueche');

		const alias = parse('Kueche').must[0];
		expect(alias.variants[0]).toBe('kueche');
		expect(alias.variants).toContain('kuche');

		const sharp = parse('Straße').must[0];
		expect(sharp.variants[0]).toBe('strase');
		expect(sharp.variants).toContain('strasse');
	});

	it('keeps variants[0] === normalized and respects the cap for every term', () => {
		for (const query of SPAN_QUERIES) {
			for (const term of allTerms(parse(query))) {
				expect(term.variants[0]).toBe(term.normalized);
				expect(term.variants.length).toBeLessThanOrEqual(TUNING.maxTermVariants);
				expect(new Set(term.variants).size).toBe(term.variants.length);
			}
		}
	});

	it('unions the trigrams of every variant', () => {
		const term = parse('Küche').must[0];
		expect(term.trigrams).toContain('kuc');
		expect(term.trigrams).toContain('kue');
		expect(new Set(term.trigrams).size).toBe(term.trigrams.length);
		for (const gram of term.trigrams) expect(gram.length).toBe(3);
	});

	it('builds trigrams for a phrase across its spaces', () => {
		const term = parse('"a b"').must[0];
		expect(term.normalized).toBe('a b');
		expect(term.short).toBe(false);
		expect(term.trigrams).toEqual(['a b']);
	});

	it('never marks a phrase term as fuzzy eligible', () => {
		for (const query of ['"kaffee maschine"', '-"kaffee maschine"', 'path:"Alte Projekte"', '"unclosed']) {
			for (const term of allTerms(parse(query))) {
				expect(term.kind).toBe('phrase');
				expect(term.fuzzyEligible).toBe(false);
			}
		}
	});

	it('never marks an excluded or a short term as fuzzy eligible', () => {
		expect(parse('kaffee').must[0].fuzzyEligible).toBe(true);
		expect(parse('-kaffee').mustNot[0].fuzzyEligible).toBe(false);
		expect(parse('ab').must[0].fuzzyEligible).toBe(false);
	});

	it('honours the span and the field it is given', () => {
		const term = buildTerm('Küche', 'word', 'title', false, { start: 6, end: 11 }, TUNING);
		expect(term).toMatchObject({
			kind: 'word',
			field: 'title',
			raw: 'Küche',
			normalized: 'kuche',
			short: false,
			fuzzyEligible: true,
			span: { start: 6, end: 11 },
		});
	});

	it('builds an empty term without variants or trigrams', () => {
		const term = buildTerm('', 'word', 'any', false, { start: 0, end: 0 }, TUNING);
		expect(term.normalized).toBe('');
		expect(term.variants).toEqual([]);
		expect(term.trigrams).toEqual([]);
		expect(term.short).toBe(true);
	});
});

/* ========================================================================== */
/* 5. terms ordering                                                          */
/* ========================================================================== */

describe('parseQuery — terms ordering', () => {
	it('lists must terms first, then each should group in order', () => {
		const ast = parse('a OR b c d OR e');
		expect(shape(ast)).toEqual({
			must: [w('c')],
			mustNot: [],
			should: [
				[w('a'), w('b')],
				[w('d'), w('e')],
			],
			isEmpty: false,
		});
		expect(ast.terms.map((term) => term.raw)).toEqual(['c', 'a', 'b', 'd', 'e']);
	});

	it('puts the very objects the groups hold into terms, so termIndex resolves', () => {
		const ast = parse('a OR b c');
		expect(ast.terms[0]).toBe(ast.must[0]);
		expect(ast.terms[1]).toBe(ast.should[0][0]);
		expect(ast.terms[2]).toBe(ast.should[0][1]);
	});

	it('excludes negated terms from terms and from isEmpty', () => {
		const ast = parse('-a -b');
		expect(ast.terms).toEqual([]);
		expect(ast.isEmpty).toBe(true);
		expect(ast.mustNot).toHaveLength(2);
	});

	it('is stable across repeated calls', () => {
		const first = parse('kaffee OR tee milch -zucker');
		const second = parse('kaffee OR tee milch -zucker');
		expect(shape(first)).toEqual(shape(second));
		expect(first.terms.map((term) => term.raw)).toEqual(second.terms.map((term) => term.raw));
	});
});

/* ========================================================================== */
/* 5b. splitPropertyTerm                                                      */
/* ========================================================================== */

describe('splitPropertyTerm', () => {
	it('reads a bare property as an existence check', () => {
		expect(splitPropertyTerm('status')).toEqual({ key: 'status', value: null });
	});

	it('splits key and value at the first equals sign', () => {
		expect(splitPropertyTerm('status=offen')).toEqual({ key: 'status', value: 'offen' });
		// A value may carry an equals sign of its own; a property name may not, so
		// the first one is the separator and every later one belongs to the value.
		expect(splitPropertyTerm('formel=a=b')).toEqual({ key: 'formel', value: 'a=b' });
	});

	it('treats an empty half as absent rather than as an empty match', () => {
		expect(splitPropertyTerm('status=')).toEqual({ key: 'status', value: null });
		expect(splitPropertyTerm('=offen')).toEqual({ key: '', value: 'offen' });
	});
});

/* ========================================================================== */
/* 6. isFieldPrefix                                                           */
/* ========================================================================== */

describe('isFieldPrefix', () => {
	const cases: readonly (readonly [string, TermField | null])[] = [
		['path:', 'path'],
		['prop:', 'property'],
		['prop:status', 'property'],
		['PROP:', 'property'],
		// The field is `prop`, spelled the way it is typed. `property:` is not it.
		['property:', null],
		['path', 'path'],
		['tag:', 'tag'],
		['title:', 'title'],
		['PATH:', 'path'],
		['Title:', 'title'],
		['path:Projekte', 'path'],
		['title:Küche', 'title'],
		['foo:', null],
		['foo:bar', null],
		['', null],
		[':', null],
		['any', null],
		['pathx:', null],
		['https://x.example', null],
	];

	for (const [token, expected] of cases) {
		it(`maps ${JSON.stringify(token)} to ${String(expected)}`, () => {
			expect(isFieldPrefix(token)).toBe(expected);
		});
	}
});

/* ========================================================================== */
/* 7. stringifyQuery round trip                                               */
/* ========================================================================== */

const ROUND_TRIP: readonly string[] = [
	'',
	'kaffee',
	'kaffee maschine',
	'"espresso maschine"',
	'-altbau',
	'kaffee -altbau',
	'kaffee OR tee',
	'kaffee tee OR milch',
	'kaffee OR tee OR milch',
	'-"alte projekte"',
	'path:Projekte tag:hlks',
	'title:Küche',
	'-path:"Alte Projekte" kaffee',
	'Küche OR Küchen',
	'Straße OR Strasse',
	'foo:bar',
	'e-mail',
	'"Wärmepumpe" -Altbau',
	'a "OR" b',
	'"a b" "c d"',
	'tag:küche -tag:archiv',
	'a b"c d"e',
	'"say "hi" now"',
	'path:Projekte2 OR path:Projekte',
	'"unclosed',
	'   ',
];

describe('stringifyQuery', () => {
	for (const query of ROUND_TRIP) {
		it(`round trips ${JSON.stringify(query)}`, () => {
			const first = parse(query);
			const rendered = stringifyQuery(first);
			const second = parse(rendered);
			expect(shape(second)).toEqual(shape(first));
			// Rendering is idempotent: the second pass produces the same text.
			expect(stringifyQuery(second)).toBe(rendered);
		});
	}

	it('renders the operators back in their canonical form', () => {
		expect(stringifyQuery(parse('kaffee tee OR milch -zucker'))).toBe('kaffee tee OR milch -zucker');
		expect(stringifyQuery(parse('-path:"Alte Projekte"'))).toBe('-path:"Alte Projekte"');
		expect(stringifyQuery(parse('  kaffee   OR   tee  '))).toBe('kaffee OR tee');
		expect(stringifyQuery(parse('"unclosed'))).toBe('"unclosed"');
	});

	it('renders an empty query as an empty string', () => {
		expect(stringifyQuery(parse('   '))).toBe('');
		expect(stringifyQuery(parse('""'))).toBe('');
	});
});

/* ========================================================================== */
/* 8. addOrTerm                                                               */
/* ========================================================================== */

describe('addOrTerm', () => {
	it('extends the last positive term', () => {
		expect(addOrTerm(parse('kaffee'), 'tee', TUNING)).toBe('kaffee OR tee');
	});

	it('extends an existing OR group instead of opening a new one', () => {
		expect(addOrTerm(parse('kaffee OR tee'), 'milch', TUNING)).toBe('kaffee OR tee OR milch');
	});

	it('keeps exclusions at the end', () => {
		expect(addOrTerm(parse('kaffee -altbau'), 'tee', TUNING)).toBe('kaffee OR tee -altbau');
	});

	it('extends the last group of a multi-group query', () => {
		expect(addOrTerm(parse('kaffee tee OR milch'), 'zucker', TUNING)).toBe('kaffee tee OR milch OR zucker');
	});

	it('starts a query when there is no positive term yet', () => {
		expect(addOrTerm(parse(''), 'tee', TUNING)).toBe('tee');
		expect(addOrTerm(parse('-altbau'), 'tee', TUNING)).toBe('tee -altbau');
	});

	it('quotes an addition that is more than one word', () => {
		expect(addOrTerm(parse('kaffee'), 'espresso maschine', TUNING)).toBe('kaffee OR "espresso maschine"');
	});

	it('keeps a field prefix that the addition carries', () => {
		expect(addOrTerm(parse('kaffee'), 'tag:hlks', TUNING)).toBe('kaffee OR tag:hlks');
	});

	it('ignores an addition without searchable text', () => {
		expect(addOrTerm(parse('kaffee'), '   ', TUNING)).toBe('kaffee');
		expect(addOrTerm(parse('kaffee'), '', TUNING)).toBe('kaffee');
	});

	it('produces a query that parses into the expected group', () => {
		const query = addOrTerm(parse('kaffee maschine -altbau'), 'Küche', TUNING);
		expect(query).toBe('kaffee maschine OR Küche -altbau');
		expect(shape(parse(query))).toEqual({
			must: [w('kaffee')],
			mustNot: [w('altbau')],
			should: [[w('maschine'), w('Küche')]],
			isEmpty: false,
		});
	});
});
