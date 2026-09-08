import { describe, expect, it } from 'vitest';

import { Snippets } from '../../src/search/Snippets';
import { stripFold } from '../../src/index/Normalizer';
import { createFakeApp } from '../helpers/fakeVault';
import type { FakeApp } from '../helpers/fakeVault';
import type { TFile } from 'obsidian';
import type { Indexer } from '../../src/index/Indexer';
import type {
	IndexedFile,
	Match,
	MatchField,
	MatchQuality,
	RankedHit,
	SiftTuning,
	Snippet,
	Span,
} from '../../src/types';

/**
 * Mirrors DEFAULT_TUNING in src/settings.ts. Duplicated rather than imported
 * because settings.ts drags in the settings tab and the whole `obsidian`
 * surface; the only value this suite actually cares about is snippetLength 160.
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
		field: Object.freeze({ title: 3.0, path: 1.0, frontmatter: 2.0, tag: 2.0, heading: 1.5, body: 1.0 }),
		wholeWordBonus: 1.3,
		maxProximityBonus: 1.4,
		proximityWindow: 400,
		maxRecencyBonus: 1.15,
		recencyHalfLifeDays: 365,
		fuzzyPenalty: 0.7,
		aliasPenalty: 0.95,
	}),
} satisfies SiftTuning);

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

const CTIME = Date.UTC(2026, 0, 1);

/**
 * An index record for `original`.
 *
 * Snippets reads exactly two things from a record: `offsetMap` and the LENGTH
 * of `text` — the check that the file has not changed since it was indexed. The
 * text is produced with the real strip fold, so the fixture carries the same
 * offset-parallel relationship the Indexer stores.
 */
function makeRecord(original: string, path = 'Notizen/Kueche.md', id = 1): IndexedFile {
	const folded = stripFold(original);
	// The invariant the whole module rests on; if it ever breaks, every other
	// assertion here would be meaningless.
	expect(folded).toHaveLength(original.length);
	const slash = path.lastIndexOf('/');
	const name = slash < 0 ? path : path.slice(slash + 1);
	const title = name.endsWith('.md') ? name.slice(0, -3) : name;
	return {
		id,
		path,
		title,
		titleNormalized: stripFold(title),
		blockBreaks: new Uint32Array(0),
		folder: slash < 0 ? '' : path.slice(0, slash),
		pathNormalized: stripFold(path),
		text: folded,
		offsetMap: null,
		frontmatterSpan: null,
		headings: [],
		tags: [],
		words: { packed: '', bounds: new Uint32Array(1), count: 0 },
		createdAt: CTIME,
		modifiedAt: CTIME,
		createdSource: 'ctime',
		properties: {},
		size: original.length,
		indexedMtime: CTIME,
	};
}

interface MatchSpec {
	start: number;
	length: number;
	field?: MatchField;
	termIndex?: number;
	quality?: MatchQuality;
	matchedText?: string;
}

function makeMatch(spec: MatchSpec): Match {
	const match: Match = {
		start: spec.start,
		end: spec.start + spec.length,
		field: spec.field ?? 'body',
		termIndex: spec.termIndex ?? 0,
		wholeWord: false,
		quality: spec.quality ?? 'exact',
	};
	return spec.matchedText === undefined ? match : { ...match, matchedText: spec.matchedText };
}

/**
 * Matches for every occurrence of `folded` in the FOLDED text, which is how the
 * Searcher finds them: it never sees the original spelling. The offsets are
 * usable against the original text because folding is length-preserving.
 */
function matchesOf(original: string, folded: string, termIndex = 0): Match[] {
	const haystack = stripFold(original);
	const matches: Match[] = [];
	let at = haystack.indexOf(folded);
	while (at >= 0) {
		matches.push(makeMatch({ start: at, length: folded.length, termIndex }));
		at = haystack.indexOf(folded, at + 1);
	}
	expect(matches.length).toBeGreaterThan(0);
	return matches;
}

/** Filler of exactly `length` characters, made of short words so every cut finds a boundary nearby. */
function filler(length: number): string {
	const unit = 'lorem ipsum dolor sit amet ';
	let out = '';
	while (out.length < length) out += unit;
	return out.slice(0, length);
}

/** Filler of `total` characters with `word` written at each given offset, surrounded by spaces. Length is preserved. */
function place(total: number, entries: ReadonlyArray<readonly [number, string]>): string {
	let text = filler(total);
	for (const [at, word] of entries) {
		const from = Math.max(0, at - 1);
		const padded = `${at > 0 ? ' ' : ''}${word} `;
		text = text.slice(0, from) + padded + text.slice(from + padded.length);
	}
	expect(text).toHaveLength(total);
	return text;
}

function makeHit(spec: {
	fileId?: number;
	path?: string;
	matches: readonly Match[];
	quality?: MatchQuality;
}): RankedHit {
	const path = spec.path ?? 'Notizen/Kueche.md';
	return {
		fileId: spec.fileId ?? 1,
		path,
		title: 'Kueche',
		folder: 'Notizen',
		createdAt: CTIME,
		modifiedAt: CTIME,
		matches: spec.matches,
		quality: spec.quality ?? 'exact',
		score: 1,
		relevance: 100,
	};
}

/** The two Indexer methods Snippets calls, and nothing else. */
function fakeIndexer(records: readonly IndexedFile[]): Indexer {
	const byId = new Map<number, IndexedFile>();
	const byPath = new Map<string, IndexedFile>();
	for (const record of records) {
		byId.set(record.id, record);
		byPath.set(record.path, record);
	}
	return {
		getFile: (id: number) => byId.get(id),
		getFileByPath: (path: string) => byPath.get(path),
	} as unknown as Indexer;
}

/** A Snippets whose app and index are empty; enough for the synchronous core and the statics. */
function offlineSnippets(): Snippets {
	return new Snippets(createFakeApp({}).asApp(), fakeIndexer([]), TUNING);
}

/** The same, with a few tuning values changed. */
function snippetsWith(overrides: Partial<SiftTuning>): Snippets {
	return new Snippets(createFakeApp({}).asApp(), fakeIndexer([]), { ...TUNING, ...overrides });
}

/**
 * `count` numbered lines with no blank line between them, so the whole thing is
 * ONE block and the only thing that limits an excerpt is the line budget. Line
 * `marked` carries `word`; every line is about 45 characters, so five of them
 * stay well inside the character ceiling.
 */
function paragraph(count: number, marked: number, word: string): string {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		const number = String(i).padStart(2, '0');
		lines.push(
			i === marked
				? `Zeile ${number} nennt die ${word} und hoert dann auf.`
				: `Zeile ${number} ist Fuelltext ganz ohne einen Treffer.`,
		);
	}
	return lines.join('\n');
}

/** The excerpt's lines. The fixtures use `\n`, so a plain split is enough. */
function linesOf(snippet: Snippet): string[] {
	return snippet.text.split('\n');
}

/** The one excerpt `word` produces in `original`, with the given tuning. */
function onlySnippet(snippets: Snippets, original: string, folded: string): Snippet {
	const built = snippets.buildForFile(makeRecord(original), original, matchesOf(original, folded), 1);
	expect(built).toHaveLength(1);
	return built[0];
}

/* -------------------------------------------------------------------------- */
/* Assertions used by more than one test                                      */
/* -------------------------------------------------------------------------- */

/** Everything that must hold for every snippet, whatever produced it. */
function expectWellFormed(snippet: Snippet, original: string): void {
	expect(snippet.offset).toBeGreaterThanOrEqual(0);
	expect(snippet.offset + snippet.text.length).toBeLessThanOrEqual(original.length);
	// The excerpt is a verbatim slice of the file — never folded, never trimmed
	// into something the file does not contain.
	expect(original.slice(snippet.offset, snippet.offset + snippet.text.length)).toBe(snippet.text);
	expect(snippet.marks.length).toBeGreaterThan(0);

	let previousEnd = 0;
	for (const mark of snippet.marks) {
		expect(mark.start).toBeGreaterThanOrEqual(previousEnd);
		expect(mark.end).toBeGreaterThan(mark.start);
		expect(mark.end).toBeLessThanOrEqual(snippet.text.length);
		previousEnd = mark.end;
	}

	expect(snippet.focus.start).toBeGreaterThanOrEqual(0);
	expect(snippet.focus.end).toBeLessThanOrEqual(snippet.text.length);
	expect(snippet.focus.start).toBeLessThanOrEqual(snippet.marks[0].start);
	expect(snippet.focus.end).toBeGreaterThanOrEqual(snippet.marks[0].end);
	expect(snippet.jumpOffset).toBe(snippet.offset + snippet.marks[0].start);
	// An excerpt that starts at the first character of the file, or ends at its
	// last one, has nothing to put an ellipsis on.
	if (snippet.offset === 0) expect(snippet.leadingEllipsis).toBe(false);
	if (snippet.offset + snippet.text.length === original.length) expect(snippet.trailingEllipsis).toBe(false);
}

/* ========================================================================== */
/* buildForFile                                                               */
/* ========================================================================== */

describe('Snippets.buildForFile', () => {
	const NOTE = [
		'---',
		'created: 2026-03-14',
		'---',
		'',
		'# Küche und Lüftung',
		'',
		'Die Küche im Erdgeschoss braucht eine eigene Abluft.',
		'Die Lüftung der Küche läuft über Dach und wird separat geregelt.',
		'',
		'Später folgt die Auslegung der Küchenlüftung nach SWKI VA102-01.',
	].join('\n');

	it('marks the original spelling, never the folded text', () => {
		const record = makeRecord(NOTE);
		const matches = matchesOf(NOTE, 'kuche');
		const snippets = offlineSnippets().buildForFile(record, NOTE, matches, 3);

		expect(snippets.length).toBeGreaterThan(0);
		let marked = 0;
		for (const snippet of snippets) {
			expectWellFormed(snippet, NOTE);
			for (const mark of snippet.marks) {
				// THE test: what the card highlights is what the file says.
				expect(snippet.text.slice(mark.start, mark.end)).toBe('Küche');
				expect(snippet.text.slice(mark.start, mark.end)).not.toBe('kuche');
				marked++;
			}
		}
		expect(marked).toBeGreaterThanOrEqual(3);
	});

	it('marks every occurrence at its absolute position in the file', () => {
		const record = makeRecord(NOTE);
		const matches = matchesOf(NOTE, 'kuche');
		const snippets = offlineSnippets().buildForFile(record, NOTE, matches, 3);

		for (const snippet of snippets) {
			for (const mark of snippet.marks) {
				const absolute = snippet.offset + mark.start;
				expect(NOTE.slice(absolute, absolute + (mark.end - mark.start))).toBe(
					snippet.text.slice(mark.start, mark.end),
				);
			}
		}
	});

	it('keeps the excerpt within snippetLength plus about one word', () => {
		const original = place(1200, [[600, 'Wärmepumpe']]);
		const record = makeRecord(original);
		const snippets = offlineSnippets().buildForFile(record, original, matchesOf(original, 'warmepumpe'), 1);

		expect(snippets).toHaveLength(1);
		expect(snippets[0].text.length).toBeGreaterThan(TUNING.snippetLength - 16);
		expect(snippets[0].text.length).toBeLessThan(TUNING.snippetLength + 16);
		expect(snippets[0].leadingEllipsis).toBe(true);
		expect(snippets[0].trailingEllipsis).toBe(true);
	});

	it('never starts or ends inside a word', () => {
		const original = place(1200, [[600, 'Wärmepumpe']]);
		const snippet = offlineSnippets().buildForFile(makeRecord(original), original, matchesOf(original, 'warmepumpe'), 1)[0];

		const before = original.charAt(snippet.offset - 1);
		const first = snippet.text.charAt(0);
		expect(/[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(first)).toBe(false);
		const last = snippet.text.charAt(snippet.text.length - 1);
		const after = original.charAt(snippet.offset + snippet.text.length);
		expect(/[\p{L}\p{N}]/u.test(last) && /[\p{L}\p{N}]/u.test(after)).toBe(false);
	});

	it('handles a match at offset 0 without an out-of-range slice', () => {
		const original = `Küche und Bad. ${filler(400)}`;
		const snippets = offlineSnippets().buildForFile(makeRecord(original), original, [makeMatch({ start: 0, length: 5 })], 1);

		expect(snippets).toHaveLength(1);
		expectWellFormed(snippets[0], original);
		expect(snippets[0].offset).toBe(0);
		expect(snippets[0].leadingEllipsis).toBe(false);
		expect(snippets[0].trailingEllipsis).toBe(true);
		expect(snippets[0].text.slice(snippets[0].marks[0].start, snippets[0].marks[0].end)).toBe('Küche');
		expect(snippets[0].jumpOffset).toBe(0);
	});

	it('handles a match at the end of the file without an out-of-range slice', () => {
		const original = `${filler(400)}Ende der Küche`;
		const start = original.length - 5;
		const snippets = offlineSnippets().buildForFile(makeRecord(original), original, [makeMatch({ start, length: 5 })], 1);

		expect(snippets).toHaveLength(1);
		expectWellFormed(snippets[0], original);
		expect(snippets[0].offset + snippets[0].text.length).toBe(original.length);
		expect(snippets[0].trailingEllipsis).toBe(false);
		expect(snippets[0].jumpOffset).toBe(start);
		expect(original.slice(snippets[0].jumpOffset)).toBe('Küche');
	});

	it('clusters neighbouring matches into one excerpt instead of three', () => {
		const original = place(600, [
			[200, 'Kueche'],
			[212, 'Kueche'],
			[224, 'Kueche'],
		]);
		const snippets = offlineSnippets().buildForFile(makeRecord(original), original, matchesOf(original, 'kueche'), 3);

		expect(snippets).toHaveLength(1);
		expect(snippets[0].marks).toHaveLength(3);
		expectWellFormed(snippets[0], original);
	});

	it('prefers a cluster with two terms over three repeats of one term', () => {
		const original = place(1400, [
			[100, 'Kueche'],
			[112, 'Kueche'],
			[124, 'Kueche'],
			[900, 'Kueche'],
			[915, 'Abluft'],
		]);
		const matches = [
			...matchesOf(original, 'kueche', 0).filter((match) => match.start < 800),
			makeMatch({ start: 900, length: 6, termIndex: 0 }),
			makeMatch({ start: 915, length: 6, termIndex: 1 }),
		];
		const snippets = offlineSnippets().buildForFile(makeRecord(original), original, matches, 1);

		expect(snippets).toHaveLength(1);
		expect(snippets[0].offset).toBeGreaterThan(500);
		expect(snippets[0].marks).toHaveLength(2);
	});

	it('returns the surviving clusters in document order', () => {
		const original = place(1400, [
			[100, 'Kueche'],
			[900, 'Kueche'],
			[915, 'Abluft'],
		]);
		const matches = [
			makeMatch({ start: 100, length: 6, termIndex: 0 }),
			makeMatch({ start: 900, length: 6, termIndex: 0 }),
			makeMatch({ start: 915, length: 6, termIndex: 1 }),
		];
		const snippets = offlineSnippets().buildForFile(makeRecord(original), original, matches, 2);

		expect(snippets).toHaveLength(2);
		expect(snippets[0].offset).toBeLessThan(snippets[1].offset);
		expect(snippets[0].jumpOffset).toBe(100);
		expect(snippets[1].jumpOffset).toBe(900);
	});

	it('caps the number of excerpts at maxPerHit and yields none for maxPerHit 0', () => {
		const original = place(2000, [
			[100, 'Kueche'],
			[600, 'Kueche'],
			[1100, 'Kueche'],
			[1600, 'Kueche'],
		]);
		const matches = matchesOf(original, 'kueche');
		const snippets = offlineSnippets();

		expect(snippets.buildForFile(makeRecord(original), original, matches, 2)).toHaveLength(2);
		expect(snippets.buildForFile(makeRecord(original), original, matches, 4)).toHaveLength(4);
		expect(snippets.buildForFile(makeRecord(original), original, matches, 0)).toHaveLength(0);
	});

	it('focuses exactly the sentence around the first mark', () => {
		const original = 'Erster Satz ohne Treffer. Die Küche ist neu. Dritter Satz folgt.';
		const snippets = offlineSnippets().buildForFile(makeRecord(original), original, matchesOf(original, 'kuche'), 1);

		expect(snippets).toHaveLength(1);
		const snippet = snippets[0];
		expect(snippet.text).toBe(original);
		expect(snippet.text.slice(snippet.focus.start, snippet.focus.end)).toBe('Die Küche ist neu.');
		expectWellFormed(snippet, original);
	});

	it('jumpOffset points at the first mark in the original file', () => {
		const original = place(800, [[400, 'Lüftungsanlage']]);
		const snippet = offlineSnippets().buildForFile(makeRecord(original), original, matchesOf(original, 'luftungsanlage'), 1)[0];

		expect(snippet.jumpOffset).toBe(400);
		expect(original.slice(snippet.jumpOffset, snippet.jumpOffset + 'Lüftungsanlage'.length)).toBe('Lüftungsanlage');
	});

	it('skips title and path matches, whose offsets are not file offsets', () => {
		const original = place(600, [[300, 'Kueche']]);
		const record = makeRecord(original);
		const snippets = offlineSnippets();

		// A title match at offset 2 would slice the middle of the filler if it were
		// taken for a file position.
		const mixed = [makeMatch({ start: 2, length: 4, field: 'title' }), makeMatch({ start: 300, length: 6 })];
		const built = snippets.buildForFile(record, original, mixed, 3);
		expect(built).toHaveLength(1);
		expect(built[0].marks).toHaveLength(1);
		expect(built[0].jumpOffset).toBe(300);

		const onlyTitleAndPath = [
			makeMatch({ start: 0, length: 4, field: 'title' }),
			makeMatch({ start: 1, length: 4, field: 'path' }),
		];
		expect(snippets.buildForFile(record, original, onlyTitleAndPath, 3)).toHaveLength(0);
	});

	it('ignores matches that do not describe a range of this text', () => {
		const original = place(400, [[200, 'Kueche']]);
		const record = makeRecord(original);
		const broken = [
			makeMatch({ start: -5, length: 4 }),
			makeMatch({ start: 398, length: 40 }),
			makeMatch({ start: 100, length: 0 }),
		];

		expect(offlineSnippets().buildForFile(record, original, broken, 3)).toHaveLength(0);
		const mixed = [...broken, makeMatch({ start: 200, length: 6 })];
		const built = offlineSnippets().buildForFile(record, original, mixed, 3);
		expect(built).toHaveLength(1);
		expectWellFormed(built[0], original);
	});

	it('merges overlapping matches of different terms into one mark', () => {
		const original = place(400, [[200, 'Kuechenlueftung']]);
		const matches = [
			makeMatch({ start: 200, length: 6, termIndex: 0 }),
			makeMatch({ start: 204, length: 11, termIndex: 1 }),
		];
		const snippet = offlineSnippets().buildForFile(makeRecord(original), original, matches, 3)[0];

		expect(snippet.marks).toHaveLength(1);
		expect(snippet.text.slice(snippet.marks[0].start, snippet.marks[0].end)).toBe('Kuechenlueftung');
	});

	it('builds nothing when the file changed between indexing and the read', () => {
		const indexed = place(600, [[300, 'Kueche']]);
		const record = makeRecord(indexed);
		const edited = `Ein neuer Absatz.\n${indexed}`;

		// Same matches, longer file: every offset is stale, so no mark is trustworthy.
		expect(offlineSnippets().buildForFile(record, edited, matchesOf(indexed, 'kueche'), 3)).toHaveLength(0);
	});

	it('accepts a record whose file needed an offset map', () => {
		// 'e' + U+0301: the fold drops the combining mark, so the stored text is one
		// code unit shorter than the file and the Indexer keeps an offset map. The
		// match offsets are already mapped when they arrive here. The combining mark
		// stays an escape so no editor can normalize the fixture away.
		const original = `Cafe\u0301 und Küche im Erdgeschoss. ${filler(200)}`;
		const nfc = original.normalize('NFC');
		expect(nfc).toHaveLength(original.length - 1);
		const map = new Uint32Array(nfc.length + 1);
		for (let i = 0; i < nfc.length; i++) map[i] = i <= 3 ? i : i + 1;
		map[nfc.length] = original.length;
		const record: IndexedFile = { ...makeRecord(nfc), offsetMap: map };

		const start = original.indexOf('Küche');
		const snippets = offlineSnippets().buildForFile(record, original, [makeMatch({ start, length: 5 })], 1);

		expect(snippets).toHaveLength(1);
		expectWellFormed(snippets[0], original);
		expect(snippets[0].text.slice(snippets[0].marks[0].start, snippets[0].marks[0].end)).toBe('Küche');
		expect(snippets[0].jumpOffset).toBe(start);
	});

	it('builds nothing for an empty file or an empty match list', () => {
		const original = place(400, [[200, 'Kueche']]);
		const snippets = offlineSnippets();

		expect(snippets.buildForFile(makeRecord(original), original, [], 3)).toHaveLength(0);
		expect(snippets.buildForFile(makeRecord(''), '', [makeMatch({ start: 0, length: 1 })], 3)).toHaveLength(0);
	});

	/* ---------------------------------------------------------------------- */
	/* One block per excerpt                                                  */
	/* ---------------------------------------------------------------------- */

	/**
	 * Observed in the running plugin, and the reason this clamp exists: the
	 * excerpt for a body match started inside the frontmatter and read
	 * '…2026-01-21 --- # Ausstattung Pausenraum Wunschliste Mitarbeitende: eine
	 * Espressomaschine…'. The window is centred on the match and was free to run
	 * backwards through the closing fence and the heading.
	 */
	it('starts at the sentence, not in the frontmatter or the heading above it', () => {
		const original = [
			'---',
			'created: 2026-01-21',
			'---',
			'# Ausstattung Pausenraum',
			'Wunschliste Mitarbeitende: eine Espressomaschine für die Küche.',
			'',
		].join('\n');
		const snippet = offlineSnippets().buildForFile(
			makeRecord(original),
			original,
			matchesOf(original, 'espressomaschine'),
			1,
		)[0];

		expectWellFormed(snippet, original);
		expect(snippet.offset).toBe(original.indexOf('Wunschliste'));
		expect(snippet.text.startsWith('Wunschliste Mitarbeitende')).toBe(true);
		expect(snippet.text).not.toContain('---');
		expect(snippet.text).not.toContain('#');
		expect(snippet.text).not.toContain('2026-01-21');
	});

	it('does not reach back over a heading for a match in the line below it', () => {
		const original = ['# Küche zuhause', 'Die alte Kaffeemaschine entkalken.', ''].join('\n');
		const snippet = offlineSnippets().buildForFile(
			makeRecord(original),
			original,
			matchesOf(original, 'kaffeemaschine'),
			1,
		)[0];

		expectWellFormed(snippet, original);
		expect(snippet.text).toBe('Die alte Kaffeemaschine entkalken.');
	});

	it('keeps a heading match inside its heading and a frontmatter match inside the frontmatter', () => {
		const original = [
			'---',
			'projekt: Küche Malans',
			'---',
			'',
			'## Küche im Erdgeschoss',
			'',
			`Die Küche wird neu geplant. ${filler(300)}`,
			'',
		].join('\n');
		const record = makeRecord(original);
		const snippets = offlineSnippets();

		const inFrontmatter = snippets.buildForFile(
			record,
			original,
			[makeMatch({ start: original.indexOf('Küche'), length: 5, field: 'frontmatter' })],
			1,
		)[0];
		expect(inFrontmatter.text).toBe('projekt: Küche Malans');

		const inHeading = snippets.buildForFile(
			record,
			original,
			[makeMatch({ start: original.indexOf('## Küche') + 3, length: 5, field: 'heading' })],
			1,
		)[0];
		// The whole heading line, marker included — that line IS the block, and
		// the excerpt is a verbatim slice of the file.
		expect(inHeading.text).toBe('## Küche im Erdgeschoss');

		// A body match still gets a full-length excerpt: its block is long enough.
		const inBody = snippets.buildForFile(
			record,
			original,
			[makeMatch({ start: original.lastIndexOf('Küche'), length: 5 })],
			1,
		)[0];
		expect(inBody.text.length).toBeGreaterThan(TUNING.snippetLength - 16);
		expect(inBody.text).not.toContain('##');
	});

	it('never clips the match itself, even when it spans a block edge', () => {
		const original = ['# Wärme', '', 'Pumpe im Keller.', ''].join('\n');
		// A phrase match that crosses the heading edge — the excerpt has to
		// contain all of it, block clamp or not.
		const start = original.indexOf('Wärme');
		const end = original.indexOf('Pumpe') + 5;
		const snippet = offlineSnippets().buildForFile(
			makeRecord(original),
			original,
			[makeMatch({ start, length: end - start })],
			1,
		)[0];

		expectWellFormed(snippet, original);
		expect(snippet.text).toContain('Wärme');
		expect(snippet.text).toContain('Pumpe');
	});

	it('cuts around a match inside a heading and a frontmatter value too', () => {
		const original = ['---', 'projekt: Küche Malans', '---', '', '## Küche', '', filler(300)].join('\n');
		const matches = [
			makeMatch({ start: original.indexOf('Küche'), length: 5, field: 'frontmatter' }),
			makeMatch({ start: original.lastIndexOf('Küche'), length: 5, field: 'heading' }),
		];
		const snippets = offlineSnippets().buildForFile(makeRecord(original), original, matches, 2);

		expect(snippets.length).toBeGreaterThan(0);
		for (const snippet of snippets) {
			expectWellFormed(snippet, original);
			for (const mark of snippet.marks) {
				expect(snippet.text.slice(mark.start, mark.end)).toBe('Küche');
			}
		}
	});

	/* ---------------------------------------------------------------------- */
	/* Five lines of context                                                  */
	/* ---------------------------------------------------------------------- */

	/**
	 * The owner asked to see the hit IN CONTEXT rather than inside a 160-character
	 * window, so an excerpt is whole lines now: the matched line plus its
	 * neighbours, at most `snippetLines`, still clamped to the block.
	 */
	it('shows five lines centred on a match in the middle of a long paragraph', () => {
		const original = paragraph(20, 6, 'Kueche');
		const snippet = onlySnippet(offlineSnippets(), original, 'kueche');

		expectWellFormed(snippet, original);
		const lines = linesOf(snippet);
		expect(lines).toHaveLength(5);
		// Four spare lines split evenly: two above the hit and two below it.
		expect(lines[0].startsWith('Zeile 04')).toBe(true);
		expect(lines[2]).toContain('Kueche');
		expect(lines[4].startsWith('Zeile 08')).toBe(true);
		expect(snippet.text).toBe(original.split('\n').slice(4, 9).join('\n'));
	});

	it('shows the line plus the four after it when the match is on the first line', () => {
		const original = paragraph(20, 0, 'Kueche');
		const snippet = onlySnippet(offlineSnippets(), original, 'kueche');

		expectWellFormed(snippet, original);
		const lines = linesOf(snippet);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain('Kueche');
		expect(lines[4].startsWith('Zeile 04')).toBe(true);
		expect(snippet.offset).toBe(0);
		expect(snippet.leadingEllipsis).toBe(false);
	});

	it('hands the lines it cannot take above the match to the lines below it', () => {
		const original = paragraph(20, 1, 'Kueche');
		const snippet = onlySnippet(offlineSnippets(), original, 'kueche');

		// Only one line exists above the hit, so the other goes below: 1 up, 3 down.
		const lines = linesOf(snippet);
		expect(lines).toHaveLength(5);
		expect(lines[0].startsWith('Zeile 00')).toBe(true);
		expect(lines[1]).toContain('Kueche');
		expect(lines[4].startsWith('Zeile 04')).toBe(true);
	});

	it('yields the two lines a two-line block has, not five', () => {
		const original = [
			'# Kueche',
			'',
			'Die Kaffeemaschine ist neu.',
			'Sie steht direkt am Fenster.',
			'',
			'Ein ganz anderer Absatz folgt hier.',
		].join('\n');
		const snippet = onlySnippet(offlineSnippets(), original, 'kaffeemaschine');

		expectWellFormed(snippet, original);
		expect(linesOf(snippet)).toEqual(['Die Kaffeemaschine ist neu.', 'Sie steht direkt am Fenster.']);
	});

	/**
	 * A note written one paragraph per line is a single very long line, and five
	 * of those would be the whole note. The per-line ceiling is `snippetLength`,
	 * and it is the one case an excerpt does not begin and end on a line boundary.
	 */
	it('trims a 4 000-character line instead of showing all of it', () => {
		const original = ['Eine kurze Zeile davor.', place(4000, [[2000, 'Waermepumpe']]), 'Eine kurze Zeile danach.'].join(
			'\n',
		);
		const snippet = onlySnippet(offlineSnippets(), original, 'waermepumpe');

		expectWellFormed(snippet, original);
		expect(snippet.text).toContain('Waermepumpe');
		expect(snippet.text).not.toContain('\n');
		expect(snippet.text.length).toBeLessThan(TUNING.snippetLength + 16);
		expect(snippet.leadingEllipsis).toBe(true);
		expect(snippet.trailingEllipsis).toBe(true);
	});

	it('keeps every mark on the original spelling when the excerpt spans lines', () => {
		const original = [
			'Die Lüftung der Küche ist neu.',
			'Die Küche im Erdgeschoss wird geplant.',
			'Später folgt mehr über die Küche.',
		].join('\n');
		const snippet = onlySnippet(offlineSnippets(), original, 'kuche');

		expectWellFormed(snippet, original);
		expect(linesOf(snippet)).toHaveLength(3);
		expect(snippet.marks).toHaveLength(3);
		for (const mark of snippet.marks) {
			expect(snippet.text.slice(mark.start, mark.end)).toBe('Küche');
			const absolute = snippet.offset + mark.start;
			expect(original.slice(absolute, absolute + 'Küche'.length)).toBe('Küche');
		}
	});

	it('honours the configured line budget and puts an odd spare line below the hit', () => {
		const original = paragraph(20, 6, 'Kueche');

		expect(linesOf(onlySnippet(snippetsWith({ snippetLines: 1 }), original, 'kueche'))).toHaveLength(1);
		expect(linesOf(onlySnippet(snippetsWith({ snippetLines: 3 }), original, 'kueche'))).toHaveLength(3);

		const four = linesOf(onlySnippet(snippetsWith({ snippetLines: 4 }), original, 'kueche'));
		expect(four).toHaveLength(4);
		// One line above, two below — a hit introduces what follows it.
		expect(four[1]).toContain('Kueche');
	});

	it('falls back to a sane budget when the tuning object carries nonsense', () => {
		const original = paragraph(20, 6, 'Kueche');

		expect(linesOf(onlySnippet(snippetsWith({ snippetLines: Number.NaN }), original, 'kueche'))).toHaveLength(5);
		// Never less than the line the match sits on.
		expect(linesOf(onlySnippet(snippetsWith({ snippetLines: 0 }), original, 'kueche'))).toHaveLength(1);
		expect(linesOf(onlySnippet(snippetsWith({ snippetLines: -3 }), original, 'kueche'))).toHaveLength(1);
	});

	it('still never reaches out of the block, however much line budget is left', () => {
		const original = [
			'---',
			'created: 2026-01-21',
			'---',
			'# Ausstattung Pausenraum',
			'Wunschliste Mitarbeitende: eine Espressomaschine für die Küche.',
			'',
			'Ein zweiter Absatz, der nicht dazugehoert.',
		].join('\n');
		const snippet = onlySnippet(offlineSnippets(), original, 'espressomaschine');

		expectWellFormed(snippet, original);
		expect(linesOf(snippet)).toEqual(['Wunschliste Mitarbeitende: eine Espressomaschine für die Küche.']);
	});
});

/* ========================================================================== */
/* selectMatches                                                              */
/* ========================================================================== */

describe('Snippets.selectMatches', () => {
	it('groups matches that sit within one snippet length', () => {
		const clusters = Snippets.selectMatches(
			[
				makeMatch({ start: 10, length: 5 }),
				makeMatch({ start: 15, length: 5 }),
				makeMatch({ start: 20, length: 5 }),
			],
			3,
		);

		expect(clusters).toHaveLength(1);
		expect(clusters[0]).toHaveLength(3);
	});

	it('starts a new cluster once the span would exceed one snippet length', () => {
		const clusters = Snippets.selectMatches(
			[makeMatch({ start: 0, length: 5 }), makeMatch({ start: 400, length: 5 })],
			3,
		);

		expect(clusters).toHaveLength(2);
		expect(clusters[0][0].start).toBe(0);
		expect(clusters[1][0].start).toBe(400);
	});

	it('drops title and path matches before clustering', () => {
		const clusters = Snippets.selectMatches(
			[
				makeMatch({ start: 0, length: 4, field: 'title' }),
				makeMatch({ start: 2, length: 4, field: 'path' }),
				makeMatch({ start: 500, length: 4, field: 'body' }),
			],
			3,
		);

		expect(clusters).toHaveLength(1);
		expect(clusters[0][0].field).toBe('body');
	});

	it('prefers distinct terms over repeats when it has to choose', () => {
		const repeats = [
			makeMatch({ start: 0, length: 5, termIndex: 0 }),
			makeMatch({ start: 20, length: 5, termIndex: 0 }),
			makeMatch({ start: 40, length: 5, termIndex: 0 }),
		];
		const spread = [makeMatch({ start: 900, length: 5, termIndex: 0 }), makeMatch({ start: 920, length: 5, termIndex: 1 })];

		const clusters = Snippets.selectMatches([...repeats, ...spread], 1);
		expect(clusters).toHaveLength(1);
		expect(clusters[0][0].start).toBe(900);
	});

	it('covers as many distinct terms as the cap allows, earliest first on a tie', () => {
		const matches = [
			makeMatch({ start: 0, length: 5, termIndex: 0 }),
			makeMatch({ start: 500, length: 5, termIndex: 0 }),
			makeMatch({ start: 1000, length: 5, termIndex: 1 }),
		];

		const clusters = Snippets.selectMatches(matches, 2);
		expect(clusters).toHaveLength(2);
		expect(clusters[0][0].start).toBe(0);
		expect(clusters[1][0].termIndex).toBe(1);
	});

	it('returns nothing for an empty input or a non-positive cap', () => {
		expect(Snippets.selectMatches([], 3)).toHaveLength(0);
		expect(Snippets.selectMatches([makeMatch({ start: 0, length: 5 })], 0)).toHaveLength(0);
		expect(Snippets.selectMatches([makeMatch({ start: 0, length: 4, field: 'title' })], 3)).toHaveLength(0);
	});

	it('accepts matches in any order and clusters them by position', () => {
		const clusters = Snippets.selectMatches(
			[makeMatch({ start: 40, length: 5 }), makeMatch({ start: 0, length: 5 }), makeMatch({ start: 20, length: 5 })],
			3,
		);

		expect(clusters).toHaveLength(1);
		expect(clusters[0].map((match) => match.start)).toEqual([0, 20, 40]);
	});
});

/* ========================================================================== */
/* sentenceAround                                                             */
/* ========================================================================== */

describe('Snippets.sentenceAround', () => {
	const sliceOf = (text: string, span: Span): string => text.slice(span.start, span.end);

	it('bounds a sentence by the periods around it', () => {
		const text = 'Erster Satz. Die Küche ist neu. Dritter Satz.';
		const span = { start: text.indexOf('Küche'), end: text.indexOf('Küche') + 5 };

		expect(sliceOf(text, Snippets.sentenceAround(text, span))).toBe('Die Küche ist neu.');
	});

	it('treats a newline as a sentence boundary', () => {
		const text = 'Titelzeile\nDie Küche ist neu\nNoch eine Zeile';
		const span = { start: text.indexOf('Küche'), end: text.indexOf('Küche') + 5 };

		expect(sliceOf(text, Snippets.sentenceAround(text, span))).toBe('Die Küche ist neu');
	});

	it('uses the text edges when there is no delimiter', () => {
		const text = 'Nur ein Fragment ohne Satzzeichen';
		const span = { start: 8, end: 16 };

		expect(Snippets.sentenceAround(text, span)).toEqual({ start: 0, end: text.length });
	});

	it('does not end a sentence on a period inside a number', () => {
		const text = 'Um 13.30 Uhr wird die Küche geliefert. Danach folgt die Montage.';
		const span = { start: text.indexOf('Küche'), end: text.indexOf('Küche') + 5 };

		expect(sliceOf(text, Snippets.sentenceAround(text, span))).toBe('Um 13.30 Uhr wird die Küche geliefert.');
	});

	it('keeps the closing punctuation for ! and ?', () => {
		const text = 'Erste Zeile. Wo steht die Küche? Danach mehr.';
		const span = { start: text.indexOf('Küche'), end: text.indexOf('Küche') + 5 };

		expect(sliceOf(text, Snippets.sentenceAround(text, span))).toBe('Wo steht die Küche?');
	});

	it('always contains the span and stays inside the text', () => {
		const text = 'Ein Satz. Noch einer.';
		for (const span of [
			{ start: 0, end: 0 },
			{ start: 5, end: 8 },
			{ start: 18, end: 21 },
			{ start: -10, end: 4 },
			{ start: 15, end: 900 },
		]) {
			const focus = Snippets.sentenceAround(text, span);
			expect(focus.start).toBeGreaterThanOrEqual(0);
			expect(focus.end).toBeLessThanOrEqual(text.length);
			expect(focus.start).toBeLessThanOrEqual(focus.end);
		}
	});
});

/* ========================================================================== */
/* clampToWordBoundaries                                                      */
/* ========================================================================== */

describe('Snippets.clampToWordBoundaries', () => {
	it('leaves a span that already sits on boundaries alone', () => {
		const text = 'Die Küche ist neu';
		expect(Snippets.clampToWordBoundaries(text, { start: 4, end: 9 })).toEqual({ start: 4, end: 9 });
	});

	it('widens outward when an edge sits inside a word', () => {
		const text = 'Die Kuechenlueftung ist neu';
		const span = Snippets.clampToWordBoundaries(text, { start: 6, end: 12 });

		expect(span.start).toBe(4);
		expect(span.end).toBe(19);
		expect(text.slice(span.start, span.end)).toBe('Kuechenlueftung');
	});

	it('treats an umlaut as part of the word', () => {
		const text = 'Die Küche ist neu';
		// Offset 6 is between 'ü' and 'c' — a boundary only if umlauts are not letters.
		const span = Snippets.clampToWordBoundaries(text, { start: 6, end: 7 });

		expect(span.start).toBe(4);
		expect(span.end).toBe(9);
		expect(text.slice(span.start, span.end)).toBe('Küche');
	});

	it('gives up rather than walking across a very long token', () => {
		const token = 'a'.repeat(400);
		const text = `x ${token} y`;
		const span = Snippets.clampToWordBoundaries(text, { start: 150, end: 200 });

		// No boundary within the snap budget in either direction, so the edges stay.
		expect(span).toEqual({ start: 150, end: 200 });
	});

	it('clamps a span that reaches outside the text', () => {
		const text = 'Kurzer Text';
		expect(Snippets.clampToWordBoundaries(text, { start: -20, end: 900 })).toEqual({ start: 0, end: text.length });
		const empty = Snippets.clampToWordBoundaries('', { start: 3, end: 9 });
		expect(empty).toEqual({ start: 0, end: 0 });
	});

	it('never cuts a surrogate pair in half', () => {
		const text = 'Ein 😀 Zeichen';
		const span = Snippets.clampToWordBoundaries(text, { start: 5, end: 6 });

		expect(text.slice(span.start, span.end)).not.toContain('🟿');
		expect(span.start).not.toBe(5);
	});
});

/* ========================================================================== */
/* build                                                                      */
/* ========================================================================== */

describe('Snippets.build', () => {
	const NOTE = `Die Küche wird neu geplant. ${filler(400)}`;
	const OTHER = `Die Lüftung wird neu geplant. ${filler(400)}`;

	function setUp(): { app: FakeApp; snippets: Snippets } {
		const app = createFakeApp({
			'Notizen/Kueche.md': { content: NOTE },
			'Notizen/Lueftung.md': { content: OTHER },
		});
		const records = [makeRecord(NOTE, 'Notizen/Kueche.md', 1), makeRecord(OTHER, 'Notizen/Lueftung.md', 2)];
		return { app, snippets: new Snippets(app.asApp(), fakeIndexer(records), TUNING) };
	}

	it('attaches snippets to every hit, in the order they came in', async () => {
		const { snippets } = setUp();
		const items = await snippets.build(
			[
				makeHit({ fileId: 1, path: 'Notizen/Kueche.md', matches: matchesOf(NOTE, 'kuche') }),
				makeHit({ fileId: 2, path: 'Notizen/Lueftung.md', matches: matchesOf(OTHER, 'luftung') }),
			],
			2,
		);

		expect(items).toHaveLength(2);
		expect(items[0].path).toBe('Notizen/Kueche.md');
		expect(items[0].snippets[0].text.slice(items[0].snippets[0].marks[0].start, items[0].snippets[0].marks[0].end)).toBe(
			'Küche',
		);
		expect(items[1].snippets[0].text).toContain('Lüftung');
		expect(items[0].similarTo).toHaveLength(0);
		// Everything the RankedHit carried survives.
		expect(items[0].score).toBe(1);
		expect(items[0].relevance).toBe(100);
	});

	it('resolves a file that was deleted between search and render to no snippets', async () => {
		const { app, snippets } = setUp();
		app.deleteFile('Notizen/Kueche.md');

		const items = await snippets.build(
			[makeHit({ fileId: 1, path: 'Notizen/Kueche.md', matches: matchesOf(NOTE, 'kuche') })],
			2,
		);

		expect(items).toHaveLength(1);
		expect(items[0].snippets).toHaveLength(0);
	});

	it('resolves a hit whose record is gone to no snippets', async () => {
		const app = createFakeApp({ 'Notizen/Kueche.md': { content: NOTE } });
		const snippets = new Snippets(app.asApp(), fakeIndexer([]), TUNING);

		const items = await snippets.build(
			[makeHit({ fileId: 9, path: 'Notizen/Weg.md', matches: matchesOf(NOTE, 'kuche') })],
			2,
		);

		expect(items[0].snippets).toHaveLength(0);
		expect(app.totalReadCount()).toBe(0);
	});

	it('stops reading files once the signal is aborted', async () => {
		const { app, snippets } = setUp();
		const controller = new AbortController();
		const read = app.vault.cachedRead.bind(app.vault);
		app.vault.cachedRead = async (file: TFile): Promise<string> => {
			// Aborting inside the first read is the realistic case: a newer
			// keystroke lands while the window is being filled in.
			controller.abort();
			return read(file);
		};

		const items = await snippets.build(
			[
				makeHit({ fileId: 1, path: 'Notizen/Kueche.md', matches: matchesOf(NOTE, 'kuche') }),
				makeHit({ fileId: 2, path: 'Notizen/Lueftung.md', matches: matchesOf(OTHER, 'luftung') }),
			],
			2,
			controller.signal,
		);

		expect(app.totalReadCount()).toBe(1);
		expect(items).toHaveLength(2);
		expect(items[0].snippets.length).toBeGreaterThan(0);
		expect(items[1].snippets).toHaveLength(0);
	});

	it('reads nothing at all when the signal was already aborted', async () => {
		const { app, snippets } = setUp();
		const controller = new AbortController();
		controller.abort();

		const items = await snippets.build(
			[makeHit({ fileId: 1, path: 'Notizen/Kueche.md', matches: matchesOf(NOTE, 'kuche') })],
			2,
			controller.signal,
		);

		expect(app.totalReadCount()).toBe(0);
		expect(items[0].snippets).toHaveLength(0);
	});

	it('does not read a file for a hit that only matched on title or path', async () => {
		const { app, snippets } = setUp();

		const items = await snippets.build(
			[
				makeHit({
					fileId: 1,
					path: 'Notizen/Kueche.md',
					matches: [makeMatch({ start: 0, length: 5, field: 'title' })],
				}),
			],
			2,
		);

		expect(app.totalReadCount()).toBe(0);
		expect(items[0].snippets).toHaveLength(0);
	});

	it('invents no excerpt and reads no file for a hit found by filters alone', async () => {
		// A date range or a folder with no query term matches the whole note, not
		// a position in it: the card renders title, path and date, and the first
		// lines of the file would be an excerpt answering no question.
		const { app, snippets } = setUp();

		const items = await snippets.build([makeHit({ fileId: 1, path: 'Notizen/Kueche.md', matches: [] })], 2);

		expect(app.totalReadCount()).toBe(0);
		expect(items).toHaveLength(1);
		expect(items[0].snippets).toEqual([]);
		expect(items[0].similarTo).toEqual([]);
		expect(items[0].path).toBe('Notizen/Kueche.md');
	});

	it('collects the distinct fuzzy words a hit was reached by', async () => {
		const { snippets } = setUp();
		const matches = [
			makeMatch({ start: 4, length: 5, quality: 'fuzzy', matchedText: 'Kueche' }),
			makeMatch({ start: 4, length: 5, quality: 'fuzzy', matchedText: 'Kueche' }),
			makeMatch({ start: 14, length: 3, quality: 'fuzzy', matchedText: 'neue' }),
			makeMatch({ start: 19, length: 7, quality: 'exact' }),
		];

		const items = await snippets.build(
			[makeHit({ fileId: 1, path: 'Notizen/Kueche.md', matches, quality: 'fuzzy' })],
			2,
		);

		expect(items[0].similarTo).toEqual(['Kueche', 'neue']);
	});

	it('survives a read that throws', async () => {
		const { app, snippets } = setUp();
		app.vault.cachedRead = async (): Promise<string> => {
			throw new Error('unreadable');
		};

		const items = await snippets.build(
			[makeHit({ fileId: 1, path: 'Notizen/Kueche.md', matches: matchesOf(NOTE, 'kuche') })],
			2,
		);

		expect(items[0].snippets).toHaveLength(0);
	});
});
