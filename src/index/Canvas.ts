/**
 * Canvas — text extraction from Obsidian's JSON canvas format.
 *
 * A `.canvas` file is JSON: an array of nodes and an array of edges, where the
 * words a person would search for sit in a handful of string values and
 * everything else is geometry, colours and ids. This module finds those values
 * in the RAW text — not in a parsed object — and hands their spans to
 * {@link buildCompactDocument}, which is what keeps every offset traceable back
 * to a position in the file on disk.
 *
 * ---------------------------------------------------------------------------
 * WHY A LEXER AND NOT `JSON.parse`
 * ---------------------------------------------------------------------------
 * `JSON.parse` gives the values and throws the positions away, and a parsed
 * string cannot be found again in the source by searching for it: the same
 * words occur in several nodes, and the source spells escapes and non-ASCII
 * differently from the parsed result. Without positions there is no offset
 * contract, and without that there are no snippets and no jump-to-hit — the
 * canvas would be findable but the hit would not be locatable inside it.
 *
 * So the scan below walks the raw text once, tracking which key each string
 * value belongs to. It is deliberately tolerant rather than validating: a
 * canvas Obsidian itself wrote is well-formed, and a damaged one should still
 * yield whatever text can be read out of it rather than nothing at all.
 *
 * ---------------------------------------------------------------------------
 * ESCAPES END A SEGMENT
 * ---------------------------------------------------------------------------
 * A node's text is one JSON string with `\n` for every line break, and the two
 * code units `\` and `n` are NOT the letter they stand for. Folding them in
 * place would glue the escape letter onto the next word — `Zeile1\nZeile2`
 * would yield the word `nzeile2`. Each escape therefore ends the current
 * segment and the next literal run starts a new one, so the builder's seam (one
 * space, one block break) lands exactly where the line break was.
 *
 * The cost is that `\uXXXX` is dropped rather than decoded. Obsidian escapes
 * only quotes, backslashes and control characters, never letters, so no word
 * loses a character in a file the app wrote; a hand-edited canvas that spells a
 * letter as `ä` loses that one letter from the index and nothing else.
 */

import { buildCompactDocument } from './Normalizer';
import type { TextSegment } from './Normalizer';
import type { NormalizedDoc } from '../types';

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;

/**
 * Object keys whose string value is text a person would search for.
 *
 * `text` is a text node's body and `label` a group's or an edge's caption.
 * `file` and `url` are what a file node and a link node point at: a canvas that
 * embeds `Projekte/Heizung.md` should be findable by typing `heizung`, which is
 * the same reason the path of a note is searchable.
 *
 * Everything else in the format is deliberately absent. `id` and `color` carry
 * no words, and `type` carries the same four values in every canvas ever
 * written — indexing those would put `text` and `group` into the postings of
 * every single canvas file.
 */
const TEXT_KEYS: ReadonlySet<string> = new Set(['text', 'label', 'file', 'url']);

function isJsonSpace(code: number): boolean {
	return code === SPACE || code === TAB || code === LF || code === CR;
}

/** Result of reading one JSON string literal, starting at its opening quote. */
interface StringToken {
	/** Index just past the closing quote, or the input length for an unterminated string. */
	next: number;
	/** Literal runs of the string's content, escapes excluded. */
	runs: TextSegment[];
}

/**
 * Reads the string literal that starts at `from`, which must be its quote.
 *
 * Returns the literal runs rather than the decoded value: the caller needs
 * positions, and a run is the largest stretch that folds one code unit to one
 * code unit. `collect` is false for keys, where only the end position matters
 * and allocating runs would be waste on every `"id"` in the file.
 */
function readString(raw: string, from: number, collect: boolean): StringToken {
	const length = raw.length;
	const runs: TextSegment[] = [];
	let runStart = from + 1;
	let i = runStart;
	while (i < length) {
		const code = raw.charCodeAt(i);
		if (code === QUOTE) {
			if (collect && i > runStart) runs.push({ start: runStart, end: i });
			return { next: i + 1, runs };
		}
		if (code === BACKSLASH) {
			if (collect && i > runStart) runs.push({ start: runStart, end: i });
			// `\uXXXX` is six code units, every other escape is two. Overshooting
			// the end of the input is impossible because the loop bounds hold.
			i += raw.charCodeAt(i + 1) === 0x75 ? 6 : 2;
			runStart = i;
			continue;
		}
		i++;
	}
	// Unterminated: take what is there. A truncated canvas is still searchable.
	if (collect && length > runStart) runs.push({ start: runStart, end: length });
	return { next: length, runs };
}

/** Index of the next non-whitespace code unit at or after `from`. */
function skipSpace(raw: string, from: number): number {
	let i = from;
	while (i < raw.length && isJsonSpace(raw.charCodeAt(i))) i++;
	return i;
}

/**
 * Extracts the searchable text of a canvas file.
 *
 * The scan holds one piece of state, `pendingKey`: the last string that was
 * followed by a colon. A string that is NOT followed by a colon is a value, and
 * it belongs to that key. Array elements have no key, which is exactly right —
 * a canvas has no bare string arrays whose contents are worth indexing.
 */
export function extractCanvasDocument(raw: string): NormalizedDoc {
	const segments: TextSegment[] = [];
	let pendingKey = '';
	let i = 0;

	while (i < raw.length) {
		const code = raw.charCodeAt(i);
		if (code !== QUOTE) {
			// Whitespace never ends anything: it is what sits between a key's
			// colon and the value that answers it in a pretty-printed canvas.
			// Anything else out here does — a brace, a bracket, a comma or a
			// number means the value that belonged to `pendingKey` is over.
			if (!isJsonSpace(code) && code !== COLON) pendingKey = '';
			i++;
			continue;
		}

		const wanted = TEXT_KEYS.has(pendingKey);
		const token = readString(raw, i, wanted);
		const after = skipSpace(raw, token.next);
		if (after < raw.length && raw.charCodeAt(after) === COLON) {
			pendingKey = raw.slice(i + 1, token.next - 1);
			i = after + 1;
			continue;
		}
		if (wanted) {
			for (const run of token.runs) segments.push(run);
		}
		pendingKey = '';
		i = token.next;
	}

	return buildCompactDocument(raw, segments);
}
