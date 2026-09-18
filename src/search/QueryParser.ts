/**
 * QueryParser — single-pass tokenizer and AST builder for the query grammar:
 * space = AND, "quoted phrase", -exclusion, `-term*` wildcard, `a OR b`, and
 * the optional `path:` / `tag:` / `title:` prefixes.
 *
 * Never throws — every syntax problem degrades to a recorded QueryParseError
 * and the best available AST. Precomputes each term's variants and trigrams so
 * the Searcher does no string work per file.
 *
 * ---------------------------------------------------------------------------
 * THE GRAMMAR, in the order the scanner applies it
 * ---------------------------------------------------------------------------
 * A query is a run of tokens separated by whitespace.
 *
 *   1. `OR` is an operator only as a bare, upper-case token standing between
 *      two positive terms. Inside quotes, lower-cased, or glued to anything
 *      else (`path:OR`, `-OR`) it is ordinary text. OR binds TIGHTER than the
 *      implicit AND, so `a b OR c` is must [a] plus one should group [b, c].
 *   2. A leading `-` negates the whole token, quotes and field prefix included
 *      (`-path:"Alte Projekte"`). A `-` anywhere else is literal, which is what
 *      keeps `e-mail` a single term.
 *   3. `path:` / `tag:` / `title:` set the term's field. An unrecognised
 *      `foo:` is recorded as 'unknown-field' and left in place, so the token
 *      searches for the literal text `foo:bar`.
 *   4. A `"` at the start of the token body opens a phrase that runs to the
 *      next `"`, or to the end of the query — which is the 'unclosed-quote'
 *      recovery. Everything else runs to the next whitespace.
 *   5. A `*` at either EDGE of the token body — inside the quotes for a phrase
 *      — is the wildcard and is consumed; one in the middle is text. On an
 *      exclusion it opens that side of the match, `-altbau*` taking out every
 *      word that begins with `altbau` where bare `-altbau` takes out only the
 *      standalone word. On a positive term it is a no-op, because a positive
 *      term already matches anywhere inside a word. See {@link TermBoundary}.
 *
 * ---------------------------------------------------------------------------
 * SPANS
 * ---------------------------------------------------------------------------
 * {@link QueryTerm.span} covers exactly the characters the user typed for that
 * term — prefix and quotes excluded — so `raw.slice(span.start, span.end)`
 * always equals `term.raw`, and a caller can underline a term without
 * re-tokenizing. Error spans cover the offending operator instead: the `-`, the
 * `OR`, the `foo:` prefix, the opening quote through the end of input, or the
 * cut-off tail for 'query-too-long'. Every span indexes into the RAW query
 * string, including when the tail was truncated.
 */

import { stripFold, termVariants, trigramSet } from '../index/Normalizer';
import type {
	QueryAst,
	QueryParseError,
	QueryParseErrorCode,
	QueryTerm,
	SiftTuning,
	Span,
	TermBoundary,
	TermField,
	TranslationKey,
} from '../types';

/* ========================================================================== */
/* 1. Character helpers                                                       */
/* ========================================================================== */

const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_VT = 0x0b;
const CHAR_FF = 0x0c;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const CHAR_QUOTE = 0x22;
const CHAR_STAR = 0x2a;
const CHAR_DASH = 0x2d;
const CHAR_COLON = 0x3a;
const CHAR_UPPER_A = 0x41;
const CHAR_UPPER_O = 0x4f;
const CHAR_UPPER_R = 0x52;
const CHAR_UPPER_Z = 0x5a;
const CHAR_LOWER_A = 0x61;
const CHAR_LOWER_Z = 0x7a;
const CHAR_NBSP = 0xa0;

/** Token separators. A non-breaking space counts: it is what a paste from a web page delivers. */
function isQuerySpace(code: number): boolean {
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

function isAsciiLetter(code: number): boolean {
	return (code >= CHAR_LOWER_A && code <= CHAR_LOWER_Z) || (code >= CHAR_UPPER_A && code <= CHAR_UPPER_Z);
}

function containsSpace(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (isQuerySpace(text.charCodeAt(i))) return true;
	}
	return false;
}

/* ========================================================================== */
/* 2. Errors                                                                  */
/* ========================================================================== */

/**
 * The i18n keys the UI resolves. Spelled out rather than derived from the code
 * so that a rename of either side is a compile-time mismatch, not a message
 * that silently falls back to its own key.
 */
const ERROR_KEYS: Readonly<Record<QueryParseErrorCode, TranslationKey>> = {
	'unclosed-quote': 'error.unclosed-quote',
	'dangling-operator': 'error.dangling-operator',
	'unknown-field': 'error.unknown-field',
	'query-too-long': 'error.query-too-long',
};

function makeError(code: QueryParseErrorCode, span: Span): QueryParseError {
	return { code, span, messageKey: ERROR_KEYS[code] };
}

/* ========================================================================== */
/* 3. Terms                                                                   */
/* ========================================================================== */

/** The recognised `field:` prefix of a token, else null. */
export function isFieldPrefix(token: string): TermField | null {
	const colon = token.indexOf(':');
	const name = (colon < 0 ? token : token.slice(0, colon)).trim().toLowerCase();
	if (name === 'path') return 'path';
	if (name === 'prop') return 'property';
	if (name === 'tag') return 'tag';
	if (name === 'title') return 'title';
	return null;
}

/**
 * Splits the text of a `prop:` term into its two halves.
 *
 * `prop:status=offen` asks for a value, `prop:status` only for the property's
 * presence — the same two questions the filter bar's property chip asks, so a
 * query and a chip cannot mean different things. Everything after the FIRST `=`
 * is the value, because a value may well contain one and a property name may
 * not.
 */
export function splitPropertyTerm(text: string): { key: string; value: string | null } {
	const equals = text.indexOf(PROPERTY_EQUALS);
	if (equals < 0) return { key: text.trim(), value: null };
	const value = text.slice(equals + 1).trim();
	return { key: text.slice(0, equals).trim(), value: value.length === 0 ? null : value };
}

/**
 * `variants[0] === normalized` is a contract the Searcher relies on: the first
 * variant is the one whose match counts as `quality: 'exact'`. termVariants
 * already produces it first; the reordering here only exists so a future change
 * on either side cannot break the contract silently.
 */
function buildVariants(raw: string, normalized: string, maxVariants: number): string[] {
	if (normalized.length === 0) return [];
	const cap = Math.max(1, maxVariants);
	const produced = termVariants(raw, cap);
	if (produced.length > 0 && produced[0] === normalized) return produced;
	const out = [normalized];
	for (const variant of produced) {
		if (out.length >= cap) break;
		if (variant !== normalized) out.push(variant);
	}
	return out;
}

/** Separator between a property name and the value it has to carry. */
const PROPERTY_EQUALS = '=';

/** Union of every variant's trigrams, first occurrence wins the order. */
function collectTrigrams(variants: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const variant of variants) {
		for (const gram of trigramSet(variant)) seen.add(gram);
	}
	return Array.from(seen);
}

/** Builds one term including variants, trigrams, `short` and `fuzzyEligible`. Exported for targeted tests. */
export function buildTerm(
	raw: string,
	kind: QueryTerm['kind'],
	field: TermField,
	negated: boolean,
	boundary: TermBoundary,
	span: { start: number; end: number },
	tuning: SiftTuning,
): QueryTerm {
	// A query typed on macOS can arrive decomposed. Composing before folding is
	// what makes it comparable with stored text, which never holds combining
	// marks — see the offset contract in types.ts.
	const normalized = stripFold(raw.normalize('NFC'));
	const short = normalized.length < tuning.minTrigramTermLength;
	const variants = buildVariants(raw, normalized, tuning.maxTermVariants);
	return {
		kind,
		field,
		raw,
		normalized,
		variants,
		// A short term has no usable trigram; the Searcher linear-scans it.
		trigrams: short ? [] : collectTrigrams(variants),
		short,
		// Fuzzy matching is off inside a phrase (the user asked for those exact
		// words), off for an exclusion (a near miss must not remove a file the
		// user never typed), and off for a term too short to have a meaningful
		// edit distance — at two characters every word is within distance 1.
		// Fuzzy is off for a property term too: the name of a property is either
		// the one the vault uses or it is not, and a near miss there would answer
		// a question nobody asked.
		fuzzyEligible: kind === 'word' && !negated && !short && field !== 'property',
		boundary,
		span: { start: span.start, end: span.end },
	};
}

/* ========================================================================== */
/* 4. Tokenizer                                                               */
/* ========================================================================== */

/** One term token, before it is turned into a {@link QueryTerm}. */
interface TokenDraft {
	text: string;
	kind: QueryTerm['kind'];
	field: TermField;
	negated: boolean;
	/** A `*` stood at that edge of the token and was consumed. */
	openStart: boolean;
	openEnd: boolean;
	span: Span;
}

/**
 * Strips the `*` operators off the edges of a token body.
 *
 * Only the edges: a star in the middle is ordinary text, which is what keeps
 * `a*b` searchable. The returned span excludes the stars, so the span contract
 * on {@link QueryTerm.span} still holds — `raw.slice(start, end) === text`.
 * Several stars on one side are one star; a body of nothing but stars comes
 * back empty and the caller drops the token.
 */
function stripStars(
	raw: string,
	start: number,
	end: number,
): { text: string; span: Span; openStart: boolean; openEnd: boolean } {
	let from = start;
	let to = end;
	let openStart = false;
	let openEnd = false;
	while (from < to && raw.charCodeAt(from) === CHAR_STAR) {
		openStart = true;
		from++;
	}
	while (to > from && raw.charCodeAt(to - 1) === CHAR_STAR) {
		openEnd = true;
		to--;
	}
	return { text: raw.slice(from, to), span: { start: from, end: to }, openStart, openEnd };
}

/**
 * The boundary an exclusion asks for. A positive term is always `anywhere`:
 * substring matching is the plugin's whole point, so a star there says what is
 * already true and is simply consumed. See {@link TermBoundary}.
 */
function boundaryOf(negated: boolean, openStart: boolean, openEnd: boolean): TermBoundary {
	if (!negated) return 'anywhere';
	if (openStart && openEnd) return 'anywhere';
	if (openEnd) return 'prefix';
	if (openStart) return 'suffix';
	return 'whole';
}

interface TokenResult {
	/** Offset to resume scanning at; always greater than the token's start. */
	next: number;
	/** `null` when the token carried no searchable text and was dropped. */
	draft: TokenDraft | null;
}

/** Reads one non-`OR` token. `start` is known to point at a non-space character. */
function readToken(raw: string, start: number, end: number, errors: QueryParseError[]): TokenResult {
	let i = start;
	let negated = false;

	if (raw.charCodeAt(i) === CHAR_DASH) {
		if (i + 1 >= end || isQuerySpace(raw.charCodeAt(i + 1))) {
			errors.push(makeError('dangling-operator', { start: i, end: i + 1 }));
			return { next: i + 1, draft: null };
		}
		negated = true;
		i++;
	}

	let field: TermField = 'any';
	let letters = i;
	while (letters < end && isAsciiLetter(raw.charCodeAt(letters))) letters++;
	if (letters > i && letters < end && raw.charCodeAt(letters) === CHAR_COLON) {
		const recognised = isFieldPrefix(raw.slice(i, letters));
		if (recognised === null) {
			// The prefix is left in place on purpose: `foo:bar` searches for the
			// literal text, which is what a user typing a URL or a ratio expects.
			errors.push(makeError('unknown-field', { start: i, end: letters + 1 }));
		} else {
			field = recognised;
			i = letters + 1;
		}
	}

	// Only reachable once a prefix was consumed: `path:` on its own, or `-tag:`.
	if (i >= end || isQuerySpace(raw.charCodeAt(i))) {
		errors.push(makeError('dangling-operator', { start, end: i }));
		return { next: i, draft: null };
	}

	if (raw.charCodeAt(i) === CHAR_QUOTE) {
		const contentStart = i + 1;
		let close = -1;
		for (let j = contentStart; j < end; j++) {
			if (raw.charCodeAt(j) === CHAR_QUOTE) {
				close = j;
				break;
			}
		}
		if (close < 0) {
			errors.push(makeError('unclosed-quote', { start: i, end }));
		}
		const contentEnd = close < 0 ? end : close;
		// The stars sit INSIDE the quotes — `-"alter bau*"` — because the quote is
		// what delimits the token, so anything outside it belongs to the next one.
		const body = stripStars(raw, contentStart, contentEnd);
		return {
			next: close < 0 ? end : close + 1,
			draft:
				body.text.length === 0
					? null
					: {
							text: body.text,
							kind: 'phrase',
							field,
							negated,
							openStart: body.openStart,
							openEnd: body.openEnd,
							span: body.span,
						},
		};
	}

	let wordEnd = i;
	while (wordEnd < end && !isQuerySpace(raw.charCodeAt(wordEnd))) wordEnd++;
	const body = stripStars(raw, i, wordEnd);
	if (body.text.length === 0) {
		// Nothing but stars: an operator with no term to operate on.
		errors.push(makeError('dangling-operator', { start, end: wordEnd }));
		return { next: wordEnd, draft: null };
	}
	return {
		next: wordEnd,
		draft: {
			text: body.text,
			kind: 'word',
			field,
			negated,
			openStart: body.openStart,
			openEnd: body.openEnd,
			span: body.span,
		},
	};
}

/** True when `OR` stands at `i` as a bare token. */
function isOrOperator(raw: string, i: number, end: number): boolean {
	return (
		raw.charCodeAt(i) === CHAR_UPPER_O &&
		i + 1 < end &&
		raw.charCodeAt(i + 1) === CHAR_UPPER_R &&
		(i + 2 >= end || isQuerySpace(raw.charCodeAt(i + 2)))
	);
}

/* ========================================================================== */
/* 5. Parser                                                                  */
/* ========================================================================== */

/** Parses `raw` into an AST. Pure, allocation-light, safe to call on every keystroke. Never throws. */
export function parseQuery(raw: string, tuning: SiftTuning): QueryAst {
	const errors: QueryParseError[] = [];
	let end = raw.length;
	if (end > tuning.maxQueryLength) {
		end = Math.max(0, tuning.maxQueryLength);
		errors.push(makeError('query-too-long', { start: end, end: raw.length }));
	}

	/** Positive terms, grouped. A group of one is an AND term; longer groups are OR alternatives. */
	const groups: QueryTerm[][] = [];
	const mustNot: QueryTerm[] = [];
	/** Group an `OR` may extend, i.e. the one the immediately preceding token created or joined. */
	let orTarget = -1;
	/** Span of an `OR` that is still waiting for its right operand. */
	let pendingOr: Span | null = null;

	let i = 0;
	while (i < end) {
		if (isQuerySpace(raw.charCodeAt(i))) {
			i++;
			continue;
		}

		if (isOrOperator(raw, i, end)) {
			const span: Span = { start: i, end: i + 2 };
			// An OR needs a term on both sides. Without a left operand — at the
			// start of the query, after an exclusion, or directly after another
			// OR — the operator is dropped and the terms simply AND.
			if (orTarget < 0 || pendingOr !== null) errors.push(makeError('dangling-operator', span));
			else pendingOr = span;
			i += 2;
			continue;
		}

		const token = readToken(raw, i, end, errors);
		i = token.next;
		const draft = token.draft;
		if (draft === null) continue;

		const term = buildTerm(
			draft.text,
			draft.kind,
			draft.field,
			draft.negated,
			boundaryOf(draft.negated, draft.openStart, draft.openEnd),
			draft.span,
			tuning,
		);

		if (draft.negated) {
			if (pendingOr !== null) {
				errors.push(makeError('dangling-operator', pendingOr));
				pendingOr = null;
			}
			mustNot.push(term);
			orTarget = -1;
			continue;
		}

		if (pendingOr !== null && orTarget >= 0) {
			groups[orTarget].push(term);
			pendingOr = null;
		} else {
			groups.push([term]);
			orTarget = groups.length - 1;
		}
	}

	if (pendingOr !== null) errors.push(makeError('dangling-operator', pendingOr));

	const must: QueryTerm[] = [];
	const should: QueryTerm[][] = [];
	for (const group of groups) {
		if (group.length === 1) must.push(group[0]);
		else should.push(group);
	}

	// The flat order the Ranker indexes by: every must term, then each OR group
	// in the order it was typed. Match.termIndex points into this array.
	const terms: QueryTerm[] = must.slice();
	for (const group of should) {
		for (const term of group) terms.push(term);
	}

	return {
		must,
		mustNot,
		should,
		raw,
		errors,
		// "No positive term", and nothing more. Whether a search should RUN
		// depends on the filter bar as well, which the parser cannot see: the
		// caller combines this with `hasActiveFilters(filters)` — see the note on
		// QueryAst.isEmpty. A query of nothing but negations is therefore still
		// empty here, and it is the Searcher that decides what `-altbau` means
		// beside a date range.
		isEmpty: terms.length === 0,
		terms,
	};
}

/* ========================================================================== */
/* 6. Rendering                                                               */
/* ========================================================================== */

/**
 * A word has to be quoted when it would not survive re-tokenizing: whitespace
 * would split it, a bare `OR` would come back as an operator, and an empty word
 * would disappear. Behind a `-` or a field prefix, `OR` is already ordinary
 * text and stays unquoted. A word holding a quote character is deliberately NOT
 * quoted — wrapping it would end the phrase early, whereas leaving it alone
 * re-parses exactly. parseQuery never produces a word carrying both a quote and
 * whitespace.
 */
function needsQuotes(text: string, hasPrefix: boolean): boolean {
	if (text.length === 0) return true;
	if (containsSpace(text)) return true;
	return !hasPrefix && text === 'OR';
}

/**
 * The stars to write back around an exclusion's text. A positive term carries
 * no star: its boundary is `anywhere` by definition, so a star there would be
 * noise the parser only has to strip again.
 */
function boundaryStars(term: QueryTerm, negated: boolean): { open: string; close: string } {
	if (!negated) return { open: '', close: '' };
	switch (term.boundary) {
		case 'prefix':
			return { open: '', close: '*' };
		case 'suffix':
			return { open: '*', close: '' };
		case 'anywhere':
			return { open: '*', close: '*' };
		default:
			return { open: '', close: '' };
	}
}

function renderTerm(term: QueryTerm, negated: boolean): string {
	const prefix = (negated ? '-' : '') + (term.field === 'any' ? '' : `${term.field}:`);
	const stars = boundaryStars(term, negated);
	const body = stars.open + term.raw + stars.close;
	if (term.kind === 'phrase' || needsQuotes(term.raw, prefix.length > 0)) return `${prefix}"${body}"`;
	return prefix + body;
}

/** One string per positive group: a single term, or its OR alternatives joined. */
function positivePieces(ast: QueryAst): string[] {
	const pieces: string[] = [];
	for (const term of ast.must) pieces.push(renderTerm(term, false));
	for (const group of ast.should) {
		const rendered = group.map((term) => renderTerm(term, false)).join(' OR ');
		if (rendered.length > 0) pieces.push(rendered);
	}
	return pieces;
}

function negativePieces(ast: QueryAst): string[] {
	return ast.mustNot.map((term) => renderTerm(term, true));
}

function joinPieces(positives: readonly string[], negatives: readonly string[]): string {
	const parts: string[] = [];
	for (const piece of positives) {
		if (piece.length > 0) parts.push(piece);
	}
	for (const piece of negatives) {
		if (piece.length > 0) parts.push(piece);
	}
	return parts.join(' ');
}

/** Renders an AST back to query text. Round-trips: parseQuery(stringifyQuery(ast)) is structurally equal to ast. */
export function stringifyQuery(ast: QueryAst): string {
	return joinPieces(positivePieces(ast), negativePieces(ast));
}

/**
 * One OR alternative, rendered from free text. Running it through the parser
 * settles quoting and any field prefix the caller passed along; text that
 * parses to more than one term becomes a phrase, because the caller asked for
 * ONE alternative, not for several.
 */
function renderAddition(term: string, tuning: SiftTuning): string {
	const fragment = parseQuery(term, tuning);
	if (fragment.terms.length === 1) return renderTerm(fragment.terms[0], false);
	const flattened = term.trim().split('"').join('');
	return flattened.length === 0 ? '' : `"${flattened}"`;
}

/** Appends `term` as an OR alternative to the last positive group. Returns the new query string for the input field. */
export function addOrTerm(ast: QueryAst, term: string, tuning: SiftTuning): string {
	const positives = positivePieces(ast);
	const negatives = negativePieces(ast);
	const addition = renderAddition(term, tuning);
	if (addition.length === 0) return joinPieces(positives, negatives);
	if (positives.length === 0) return joinPieces([addition], negatives);
	positives[positives.length - 1] += ` OR ${addition}`;
	return joinPieces(positives, negatives);
}
