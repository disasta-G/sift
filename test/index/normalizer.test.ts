import { describe, expect, it } from 'vitest';

import {
	aliasFold,
	extractWords,
	fold,
	foldChar,
	foldFieldValue,
	isWordBoundary,
	normalizeDocument,
	parseDateValue,
	stripFold,
	termVariants,
	toOriginalOffset,
	toOriginalSpan,
	trigramSet,
	trigrams,
	wordAt,
} from '../../src/index/Normalizer';
import type { NormalizedDoc } from '../../src/types';

const SETTINGS = { createdField: 'created' };

function normalize(raw: string): NormalizedDoc {
	return normalizeDocument(raw, SETTINGS);
}

function textOf(raw: string): string {
	return normalize(raw).text;
}

function isCombiningCode(code: number): boolean {
	return (
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x20d0 && code <= 0x20f0) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	);
}

/** Strip fold plus the combining-mark drop that only the document pass performs. */
function documentFold(text: string): string {
	const folded = stripFold(text);
	let out = '';
	for (let i = 0; i < folded.length; i++) {
		if (!isCombiningCode(folded.charCodeAt(i))) out += folded.charAt(i);
	}
	return out;
}

/* ========================================================================== */
/* Corpus                                                                     */
/* ========================================================================== */

const BASE_DOCUMENTS: readonly string[] = [
	'',
	'   ',
	'\n\n\n',
	'Kaffee',
	'Die Küche im Altbau ist zu klein.',
	'Straße, Fuß, Maß und Grüße aus Zürich.',
	'ESPRESSOMASCHINE',
	'Wärmepumpe im Neubau — Auslegung nach SIA 384/1.',
	'Der Wert beträgt 12,5 kW bei -8 °C.',
	'---\ntitle: Küche\ncreated: 2026-03-14\ntags: [hlks, küche]\n---\n\nText im Körper.',
	'---\ncreated: 14.03.2026\ntags:\n  - hlks\n  - lüftung\n---\n\n# Überschrift\n\nInhalt.',
	'---\nunclosed: true\n\nKein Frontmatter, weil der Abschluss fehlt.',
	'# Titel\n\nAbsatz mit **fettem** und *kursivem* Text.',
	'## Zweite Ebene ##\n\nText.',
	'###### Sechste Ebene\n\nText.',
	'Titel per Setext\n================\n\nAbsatz.',
	'Zweiter Setext\n--------------\n\nAbsatz.',
	'Absatz eins.\n\n---\n\nAbsatz zwei nach einer Trennlinie.',
	'***\n\nSternchen-Trennlinie.',
	'Ein [Kaffee](https://kaffee.example/pfad?x=1) im Text.',
	'Bild: ![Alt-Text](bilder/kaffee.png)',
	'Wikilink [[Küche 2026|Kochen]] und [[Direkt]].',
	'Einbettung ![[bild.png]] mitten im Satz.',
	'Inline `const kaffee = 1;` im Satz.',
	'```js\nconst wert = 42;\nlogbuch.push(wert);\n```\n\nDanach.',
	'~~~\nrohes Codefeld\n~~~',
	'```\nunbeendeter Block\nohne Abschluss',
	'> Zitat mit **Betonung**\n> Zweite Zeile\n\nDanach.',
	'- Erster Punkt\n- Zweiter Punkt\n* Dritter Punkt\n+ Vierter Punkt',
	'1. Erstens\n2. Zweitens\n10) Zehntens',
	'| Spalte A | Spalte B |\n|---|:--:|\n| Wert | 42 |',
	'Fussnote im Text[^1].\n\n[^1]: Die Erklärung.',
	'<div class="box"><b>Hallo</b> Welt</div>',
	'Text <!-- versteckter Kommentar --> weiter.',
	'Text <!-- Kommentar\nüber Zeilen --> weiter.',
	'Ein Tag #hlks und #kueche/altbau im Satz.',
	'#nichtueberschrift am Zeilenanfang.',
	'Emoji: ☕ und 👨‍👩‍👧 und 🇨🇭 im Text.',
	'Windows\r\nZeilen\r\nmit CRLF.',
	'NFD: Küche über März.',
	'NFD gemischt: Küche und Küche.',
	'Nichtumbrechendes\u00a0Leerzeichen und Null\u200bbreite.',
	'Русский текст и Ελληνικά κείμενα.',
	'日本語のテキストもあります。',
	'Ligaturen: ﬁnden, ﬀ, Œuvre, Æther, İstanbul.',
	'Sehr langes Kompositum: Fussbodenheizungsverteilerschrank.',
	'Escape \\*kein Fett\\* und \\[keine Klammer\\].',
	'Unvollständig: [offen (und `code',
	'Pfad C:\\tools\\SIFT im Text.',
	'Mathe: $x^2 + y^2$ und 50 % Anteil.',
];

function buildCorpus(): string[] {
	const corpus = BASE_DOCUMENTS.slice();
	// ~200 documents in total: every base document combined with a rotating
	// partner, which produces the mixed block structures a real vault has.
	for (let i = 0; i < BASE_DOCUMENTS.length; i++) {
		for (const step of [1, 7, 23]) {
			const partner = BASE_DOCUMENTS[(i + step) % BASE_DOCUMENTS.length];
			corpus.push(`${BASE_DOCUMENTS[i]}\n\n${partner}`);
		}
	}
	return corpus;
}

const CORPUS = buildCorpus();

/* ========================================================================== */
/* Folding                                                                    */
/* ========================================================================== */

describe('foldChar / stripFold', () => {
	it('folds the Latin letters Sift has to handle', () => {
		const cases: readonly (readonly [string, string])[] = [
			['ä', 'a'],
			['Ä', 'a'],
			['ö', 'o'],
			['Ö', 'o'],
			['ü', 'u'],
			['Ü', 'u'],
			['ß', 's'],
			['ẞ', 's'],
			['é', 'e'],
			['É', 'e'],
			['è', 'e'],
			['à', 'a'],
			['ø', 'o'],
			['Ø', 'o'],
			['å', 'a'],
			['æ', 'a'],
			['Æ', 'a'],
			['œ', 'o'],
			['Œ', 'o'],
			['ñ', 'n'],
			['ç', 'c'],
			['Ç', 'c'],
			['ź', 'z'],
			['Ź', 'z'],
			['ł', 'l'],
			['đ', 'd'],
			['þ', 't'],
			['ı', 'i'],
		];
		for (const [source, expected] of cases) {
			expect(stripFold(source), `strip fold of ${source}`).toBe(expected);
		}
	});

	it('never expands the length traps', () => {
		// `İ` lower-cases to two code units and `ﬁ` transliterates to two letters;
		// both have to collapse into exactly one unit or stay untouched.
		expect(stripFold('İ')).toBe('i');
		expect(stripFold('ﬁ')).toBe('f');
		expect(stripFold('ﬀ')).toBe('f');
		expect(stripFold('ﬂ')).toBe('f');
		expect(stripFold('ﬃ')).toBe('f');
		expect(stripFold('ﬅ')).toBe('s');
		expect(stripFold('ﬆ')).toBe('s');
		expect(stripFold('İstanbul')).toBe('istanbul');
		// A ligature folds to its first letter, so the word loses a letter rather
		// than the document losing its offset parity. Documented trade-off.
		expect(stripFold('ﬁnden')).toBe('fnden');
	});

	it('is length preserving for every code unit in the BMP', () => {
		for (let code = 0; code <= 0xffff; code++) {
			const folded = stripFold(String.fromCharCode(code));
			if (folded.length !== 1) {
				throw new Error(`code unit ${code.toString(16)} folded to ${folded.length} units`);
			}
		}
	});

	it('lower-cases without transliterating non-Latin scripts', () => {
		expect(stripFold('ГОРОД')).toBe('город');
		expect(stripFold('ΑΘΗΝΑ')).toBe('αθηνα');
		expect(stripFold('日本語')).toBe('日本語');
	});

	it('folds whitespace and invisible characters to a plain space', () => {
		expect(stripFold('a\tb\nc\r\nd')).toBe('a b c  d');
		expect(stripFold('a\u00a0b\u200bc')).toBe('a b c');
	});

	it('returns the input unchanged when no rule applies', () => {
		expect(foldChar(0x61)).toBe(0x61);
		expect(foldChar(0x4e2d)).toBe(0x4e2d);
		expect(foldChar(0x0308)).toBe(0x0308);
		expect(stripFold('kaffee 42')).toBe('kaffee 42');
	});
});

describe('aliasFold', () => {
	it('expands the German transliterations', () => {
		expect(aliasFold('Küche')).toBe('kueche');
		expect(aliasFold('Straße')).toBe('strasse');
		expect(aliasFold('Öl für Übung')).toBe('oel fuer uebung');
		expect(aliasFold('Æther')).toBe('aether');
	});

	it('leaves everything else at the strip fold', () => {
		expect(aliasFold('Espressomaschine')).toBe('espressomaschine');
		expect(fold('Küche')).toBe('kuche');
		expect(fold('Küche', 'strip')).toBe('kuche');
		expect(fold('Küche', 'alias')).toBe('kueche');
	});
});

/* ========================================================================== */
/* The invariant                                                              */
/* ========================================================================== */

describe('normalizeDocument — the offset contract', () => {
	it('keeps text and source the same length for every fixture without combining marks', () => {
		for (const raw of CORPUS) {
			const doc = normalize(raw);
			expect(doc.originalLength).toBe(raw.length);
			if (doc.offsetMap === null) {
				expect(doc.text.length, `length invariant for ${JSON.stringify(raw.slice(0, 40))}`).toBe(raw.length);
			}
		}
	});

	it('exercises both offset paths with this corpus', () => {
		expect(CORPUS.length).toBeGreaterThanOrEqual(200);
		const mapped = CORPUS.filter((raw) => normalize(raw).offsetMap !== null);
		expect(mapped.length).toBeGreaterThan(0);
		expect(mapped.length).toBeLessThan(CORPUS.length);
	});

	it('produces a well-formed offset map whenever it produces one at all', () => {
		for (const raw of CORPUS) {
			const doc = normalize(raw);
			const map = doc.offsetMap;
			if (map === null) continue;
			expect(map.length).toBe(doc.text.length + 1);
			expect(map[map.length - 1]).toBe(raw.length);
			for (let i = 1; i < map.length; i++) {
				expect(map[i]).toBeGreaterThan(map[i - 1] - 1);
			}
		}
	});

	it('round trips every extracted word back through the original text', () => {
		for (const raw of CORPUS) {
			const doc = normalize(raw);
			for (let w = 0; w < doc.words.count; w++) {
				const word = wordAt(doc.words, w);
				let at = doc.text.indexOf(word);
				while (at >= 0) {
					const span = toOriginalSpan(doc, { start: at, end: at + word.length });
					expect(documentFold(raw.slice(span.start, span.end)), `word ${word} at ${at}`).toBe(word);
					at = doc.text.indexOf(word, at + 1);
				}
			}
		}
	});

	it('keeps headings ordered and non-overlapping', () => {
		for (const raw of CORPUS) {
			const doc = normalize(raw);
			let previousEnd = -1;
			for (const heading of doc.headings) {
				expect(heading.span.start).toBeGreaterThanOrEqual(previousEnd);
				expect(heading.span.end).toBeGreaterThanOrEqual(heading.span.start);
				expect(heading.textSpan.start).toBeGreaterThanOrEqual(heading.span.start);
				expect(heading.textSpan.end).toBeLessThanOrEqual(heading.span.end);
				expect(heading.level).toBeGreaterThanOrEqual(1);
				expect(heading.level).toBeLessThanOrEqual(6);
				previousEnd = heading.span.end;
			}
		}
	});

	it('handles CRLF and surrogate pairs without shifting a single offset', () => {
		const raw = 'Kaffee\r\n\r\nEmoji ☕ und 👨‍👩‍👧 danach.';
		const doc = normalize(raw);
		expect(doc.offsetMap).toBeNull();
		expect(doc.text.length).toBe(raw.length);
		expect(doc.text.indexOf('danach')).toBe(raw.indexOf('danach'));
		expect(doc.text.indexOf('emoji')).toBe(raw.indexOf('Emoji'));
	});
});

/* ========================================================================== */
/* Markdown blanking                                                          */
/* ========================================================================== */

describe('normalizeDocument — markdown blanking', () => {
	it('blanks emphasis markers and keeps the caption in place', () => {
		expect(textOf('Der **fette** Text')).toBe('der   fette   text');
		expect(textOf('Der *kursive* Text')).toBe('der  kursive  text');
		expect(textOf('Der ~~gestrichene~~ Text')).toBe('der   gestrichene   text');
		expect(textOf('Der __fette__ Text')).toBe('der   fette   text');
		expect(textOf('Der ==markierte== Text')).toBe('der   markierte   text');
	});

	it('keeps link text and drops the URL', () => {
		const raw = 'Ein [Kaffee](https://kaffee.example) mehr';
		const doc = normalize(raw);
		expect(doc.text.length).toBe(raw.length);
		expect(doc.text.indexOf('kaffee')).toBe(raw.indexOf('Kaffee'));
		expect(doc.text).not.toContain('kaffee.example');
		expect(doc.text).not.toContain('https');
		expect(doc.text.trim().split(/\s+/)).toEqual(['ein', 'kaffee', 'mehr']);
	});

	it('keeps the alias of a wikilink and the target of a plain one', () => {
		const aliased = normalize('Siehe [[Küche 2026|Kochen]] hier.');
		expect(aliased.text).toContain('kochen');
		expect(aliased.text).not.toContain('kuche');
		expect(aliased.text.indexOf('kochen')).toBe('Siehe [[Küche 2026|'.length);

		const plain = normalize('Siehe [[Direkt]] hier.');
		expect(plain.text).toContain('direkt');
		expect(plain.text.indexOf('direkt')).toBe('Siehe [['.length);
	});

	it('blanks the brackets of an embed and keeps the target searchable', () => {
		expect(textOf('![[bild.png]]')).toBe('   bild.png  ');
	});

	it('keeps code text and blanks only the markers', () => {
		expect(textOf('Inline `code` hier')).toBe('inline  code  hier');
		const fenced = normalize('```js\nconst wert = 42;\n```');
		expect(fenced.text).toContain('const wert = 42;');
		expect(fenced.text).not.toContain('js');
		expect(fenced.text.indexOf('const')).toBe('```js\n'.length);
	});

	it('blanks block quote markers, list markers and rules', () => {
		expect(textOf('> Zitat')).toBe('  zitat');
		expect(textOf('- Punkt')).toBe('  punkt');
		expect(textOf('* Punkt')).toBe('  punkt');
		expect(textOf('12. Punkt')).toBe('    punkt');
		expect(textOf('Text\n\n---\n\nMehr').trim().split(/\s+/)).toEqual(['text', 'mehr']);
		expect(textOf('Text\n\n***\n\nMehr')).not.toContain('*');
	});

	it('blanks heading markers and keeps the caption', () => {
		expect(textOf('# Titel')).toBe('  titel');
		expect(textOf('### Titel')).toBe('    titel');
		expect(textOf('## Titel ##')).toBe('   titel   ');
	});

	it('blanks raw HTML and HTML comments', () => {
		const raw = '<div class="box">Text</div>';
		const doc = normalize(raw);
		expect(doc.text.indexOf('text')).toBe(raw.indexOf('Text'));
		expect(doc.text).not.toContain('div');
		expect(doc.text).not.toContain('box');

		const comment = normalize('Vor <!-- geheim --> nach');
		expect(comment.text).not.toContain('geheim');
		expect(comment.text.trim().split(/\s+/)).toEqual(['vor', 'nach']);

		const multiline = normalize('Vor <!-- geheim\nund mehr --> nach');
		expect(multiline.text).not.toContain('geheim');
		expect(multiline.text).not.toContain('mehr');
		expect(multiline.text).toContain('nach');
	});

	it('blanks table pipes and the delimiter row', () => {
		const doc = normalize('| Spalte | Wert |\n|---|---|\n| Küche | 42 |');
		expect(doc.text).not.toContain('|');
		expect(doc.text).not.toContain('-');
		expect(doc.text).toContain('spalte');
		expect(doc.text).toContain('kuche');
	});

	it('blanks footnote markers', () => {
		const raw = 'Hier[^1] weiter.';
		const doc = normalize(raw);
		expect(doc.text).not.toContain('^');
		expect(doc.text.indexOf('weiter')).toBe(raw.indexOf('weiter'));
	});

	it('blanks a link reference definition but keeps a footnote definition', () => {
		const link = normalize('Text [Verweis][ref].\n\n[ref]: https://x.example "Titel"');
		expect(link.text).toContain('verweis');
		expect(link.text).not.toContain('x.example');
		expect(link.text).not.toContain('titel');

		const footnote = normalize('Text[^1].\n\n[^1]: Die Erklärung.');
		expect(footnote.text).toContain('die erklarung');
		expect(footnote.text).not.toContain('^1');
	});

	it('does not read a tag out of code and does not treat a heading hash as one', () => {
		const doc = normalize('Ein `#keinTag` und #echterTag.\n\n# Kein Tag\n');
		expect(doc.tags).toEqual(['echtertag']);
	});

	it('stays linear on a line full of openers that never close', () => {
		// A quadratic scanner turns this into billions of steps; the memo in the
		// bracket and tag search keeps it in the millisecond range.
		const raw = '['.repeat(20000) + '<'.repeat(20000);
		const started = Date.now();
		const doc = normalize(raw);
		expect(doc.text.length).toBe(raw.length);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('keeps every blanked document offset-parallel', () => {
		const raw =
			'# Küche\n\n> Ein [Link](https://x.example) mit `code`, ![[bild.png]] und **fett**.\n\n| a | b |\n|---|---|\n';
		const doc = normalize(raw);
		expect(doc.offsetMap).toBeNull();
		expect(doc.text.length).toBe(raw.length);
		expect(doc.text.indexOf('code')).toBe(raw.indexOf('code'));
		expect(doc.text.indexOf('fett')).toBe(raw.indexOf('fett'));
	});
});

/* ========================================================================== */
/* NFD                                                                        */
/* ========================================================================== */

describe('normalizeDocument — NFD fallback', () => {
	it('keeps offsetMap null for composed input', () => {
		const doc = normalize('Küche über März');
		expect(doc.offsetMap).toBeNull();
		expect(doc.text).toBe('kuche uber marz');
	});

	it('drops combining marks and maps every offset back', () => {
		const raw = 'Küche über';
		const doc = normalize(raw);
		expect(doc.offsetMap).not.toBeNull();
		expect(doc.text).toBe('kuche uber');
		const expected = [0, 1, 3, 4, 5, 6, 7, 9, 10, 11, 12];
		for (let i = 0; i < expected.length; i++) {
			expect(toOriginalOffset(doc, i), `offset ${i}`).toBe(expected[i]);
		}
		const span = toOriginalSpan(doc, { start: 0, end: 5 });
		expect(raw.slice(span.start, span.end)).toBe('Küche');
	});

	it('clamps offsets outside the map', () => {
		const composed = normalize('Küche');
		expect(toOriginalOffset(composed, -3)).toBe(0);
		expect(toOriginalOffset(composed, 99)).toBe(5);
		const decomposed = normalize('Küche');
		expect(toOriginalOffset(decomposed, -1)).toBe(0);
		expect(toOriginalOffset(decomposed, 99)).toBe(6);
	});

	it('normalizes markdown the same way in both paths', () => {
		const composed = normalize('# Küche\n\n**fett**');
		const decomposed = normalize('# Küche\n\n**fett**');
		expect(decomposed.text).toBe(composed.text);
		expect(decomposed.headings).toHaveLength(1);
		expect(decomposed.headings[0].textSpan).toEqual(composed.headings[0].textSpan);
	});

	/**
	 * The document text drops combining marks, so `tags` has to as well: a tag is
	 * compared against a query literal, and the query side always composes first.
	 * A tag left decomposed was reachable by no query at all — not by the
	 * composed spelling, not by a decomposed one, not by the alias, not fuzzy.
	 */
	it('folds a decomposed tag the way it folds the document text', () => {
		const decomposed = normalize('---\ntags: [ku\u0308che, lu\u0308ftung]\n---\n\nText.\n');
		expect(decomposed.tags).toEqual(['kuche', 'luftung']);
		expect(decomposed.tags).toEqual(normalize('---\ntags: [küche, lüftung]\n---\n\nText.\n').tags);

		const inline = normalize('Ein #Ku\u0308che/Altbau Tag.\n');
		expect(inline.tags).toEqual(['kuche/altbau']);
		for (const tag of [...decomposed.tags, ...inline.tags]) {
			for (let i = 0; i < tag.length; i++) {
				expect(isCombiningCode(tag.charCodeAt(i)), tag).toBe(false);
			}
		}
	});

	it('folds a field value with no precomposed form by dropping the mark', () => {
		// `f` + combining diaeresis has no precomposed form, so composing alone
		// would leave the mark sitting in the value.
		expect(foldFieldValue('Kaf\u0308fee')).toBe('kaffee');
		expect(foldFieldValue('Ku\u0308che')).toBe('kuche');
		expect(foldFieldValue('Küche')).toBe('kuche');
		expect(foldFieldValue('Projekte/Ku\u0308che/Notiz.md')).toBe('projekte/kuche/notiz.md');
	});
});

/* ========================================================================== */
/* Frontmatter and headings                                                   */
/* ========================================================================== */

describe('normalizeDocument — frontmatter', () => {
	it('spans the block exactly and keeps keys and values as text', () => {
		const raw = '---\ntitle: Küche\ncreated: 2026-03-14\n---\n\nText.';
		const doc = normalize(raw);
		expect(doc.frontmatterSpan).toEqual({ start: 0, end: raw.indexOf('---\n\nText') + 3 });
		expect(doc.text.indexOf('title')).toBe(raw.indexOf('title'));
		expect(doc.text.indexOf('kuche')).toBe(raw.indexOf('Küche'));
		expect(doc.text).not.toContain('---');
		expect(doc.frontmatter).toEqual({ title: 'kuche', created: '2026-03-14' });
	});

	it('keeps the created value unfolded so a timestamp still parses', () => {
		const doc = normalize('---\ncreated: 2026-03-14T10:00:00Z\ntitle: Über\n---\n');
		expect(doc.frontmatter.created).toBe('2026-03-14T10:00:00Z');
		expect(doc.frontmatter.title).toBe('uber');
		expect(parseDateValue(doc.frontmatter.created)).toBe(Date.UTC(2026, 2, 14, 10, 0, 0));
	});

	it('reads tags from an inline list and from a block list', () => {
		expect(normalize('---\ntags: [hlks, küche]\n---\n').tags).toEqual(['hlks', 'kuche']);
		expect(normalize('---\ntags:\n  - hlks\n  - Lüftung\n---\n').tags).toEqual(['hlks', 'luftung']);
		expect(normalize('---\ntags: "#hlks"\n---\n').tags).toEqual(['hlks']);
	});

	it('honours a different createdField', () => {
		const doc = normalizeDocument('---\ndatum: 14.03.2026\ncreated: nein\n---\n', { createdField: 'Datum' });
		expect(doc.frontmatter.datum).toBe('14.03.2026');
		expect(parseDateValue(doc.frontmatter.datum)).toBe(new Date(2026, 2, 14).getTime());
	});

	it('is frontmatter only when the file starts with the fence', () => {
		const rule = normalize('Text\n\n---\n\nMehr');
		expect(rule.frontmatterSpan).toBeNull();
		expect(rule.frontmatter).toEqual({});

		const unterminated = normalize('---\ntitle: Küche\n\nKein Abschluss.');
		expect(unterminated.frontmatterSpan).toBeNull();
		expect(unterminated.text).toContain('title');

		const leadingBlank = normalize('\n---\ntitle: x\n---\n');
		expect(leadingBlank.frontmatterSpan).toBeNull();
	});

	it('collects inline tags from the body', () => {
		const raw = 'Ein #hlks Tag und #kueche/altbau, aber nicht x#kein und nicht #123.';
		const doc = normalize(raw);
		expect(doc.tags).toEqual(['hlks', 'kueche/altbau']);
		expect(doc.text.indexOf('hlks')).toBe(raw.indexOf('hlks'));
		expect(doc.text.charAt(raw.indexOf('#'))).toBe(' ');
	});
});

describe('normalizeDocument — headings', () => {
	it('measures ATX headings exactly', () => {
		const raw = '# Titel\n\nText\n\n### Drittens ###\n';
		const doc = normalize(raw);
		expect(doc.headings).toHaveLength(2);
		expect(doc.headings[0]).toEqual({ level: 1, span: { start: 0, end: 7 }, textSpan: { start: 2, end: 7 } });
		const third = doc.headings[1];
		expect(third.level).toBe(3);
		expect(third.span).toEqual({ start: raw.indexOf('###'), end: raw.length - 1 });
		expect(doc.text.slice(third.textSpan.start, third.textSpan.end)).toBe('drittens');
	});

	it('measures setext headings across both lines', () => {
		const raw = 'Titel\n=====\n\nText';
		const doc = normalize(raw);
		expect(doc.headings).toHaveLength(1);
		expect(doc.headings[0]).toEqual({ level: 1, span: { start: 0, end: 11 }, textSpan: { start: 0, end: 5 } });
		expect(doc.text.slice(0, 5)).toBe('titel');
		expect(doc.text.slice(6, 11)).toBe('     ');
	});

	it('treats a rule after a blank line as a rule, not as a setext heading', () => {
		const doc = normalize('Text\n\n---\n\nMehr');
		expect(doc.headings).toHaveLength(0);
		const dash = normalize('Titel\n---\n\nText');
		expect(dash.headings).toHaveLength(1);
		expect(dash.headings[0].level).toBe(2);
	});

	it('finds headings inside block quotes', () => {
		const doc = normalize('> # Zitat-Titel\n');
		expect(doc.headings).toHaveLength(1);
		expect(doc.headings[0].level).toBe(1);
		expect(doc.text.trim()).toBe('zitat-titel');
	});
});

/* ========================================================================== */
/* Block breaks                                                               */
/* ========================================================================== */

/**
 * The one piece of structure the fold destroys.
 *
 * `\n\n` folds to the same two U+0020 a blanked `**` leaves behind, so a
 * paragraph break is invisible in `text`. `blockBreaks` is the record of where
 * one was, and the Searcher rejects a phrase gap that steps over one. Every
 * assertion below therefore checks the OFFSET, not just the count: an offset
 * that misses the whitespace run between the two paragraphs would let the
 * phrase through.
 */
describe('normalizeDocument — block breaks', () => {
	/** True when every offset sits on whitespace of the normalized text and the list ascends. */
	function wellFormed(doc: NormalizedDoc): boolean {
		let previous = -1;
		for (const offset of doc.blockBreaks) {
			if (offset <= previous && previous >= 0) return false;
			if (offset < 0 || offset >= doc.text.length) return false;
			if (doc.text.charCodeAt(offset) !== 0x20) return false;
			previous = offset;
		}
		return true;
	}

	it('marks the blank line between two paragraphs', () => {
		const raw = 'Ende mit Wärme\n\nPumpe am Anfang.\n';
		const doc = normalize(raw);
		expect([...doc.blockBreaks]).toEqual([15]);
		// The offset lies strictly between the last word of the first paragraph
		// and the first word of the second — which is the interval a phrase gap
		// would have to cross.
		expect(doc.text.indexOf('warme') + 'warme'.length).toBeLessThanOrEqual(15);
		expect(doc.text.indexOf('pumpe')).toBeGreaterThan(15);
		expect(wellFormed(doc)).toBe(true);
	});

	it('has none for a single paragraph, whatever whitespace it holds', () => {
		for (const raw of ['Die  **Wärme**pumpe   steht\nim Keller.', 'Ein Satz.', '# Wärme Pumpe im Altbau']) {
			expect([...normalize(raw).blockBreaks], raw).toEqual([]);
		}
	});

	it('counts every blank line of a run and both CRLF spellings', () => {
		expect([...normalize('a\n\n\n\nb').blockBreaks]).toEqual([2, 3, 4]);
		expect([...normalize('a\r\n\r\nb').blockBreaks]).toEqual([3]);
		expect([...normalize('a\n   \nb').blockBreaks]).toEqual([2]);
	});

	it('does not invent one at the end of the file', () => {
		expect([...normalize('Nur ein Satz.\n').blockBreaks]).toEqual([]);
		// A real trailing blank line is still one; it just may not point past the text.
		const doc = normalize('Nur ein Satz.\n\n');
		expect([...doc.blockBreaks]).toEqual([14]);
		expect(wellFormed(doc)).toBe(true);
	});

	it('marks an empty block-quote line and a blank line inside a fence', () => {
		const quoted = normalize('> Erster Absatz\n>\n> Zweiter Absatz\n');
		expect(quoted.blockBreaks.length).toBe(1);
		expect(wellFormed(quoted)).toBe(true);

		const fenced = normalize('```\ncode eins\n\ncode zwei\n```\n');
		expect(fenced.blockBreaks.length).toBe(1);
		expect(wellFormed(fenced)).toBe(true);
	});

	it('skips the frontmatter, which is already a block edge of its own', () => {
		const doc = normalize('---\ntitel: Wärme\n\nautor: X\n---\n\nPumpe steht hier.\n');
		expect(doc.frontmatterSpan).not.toBeNull();
		// Only the blank line after the closing fence, none of the ones inside it.
		expect(doc.blockBreaks.length).toBe(1);
		expect(doc.blockBreaks[0]).toBeGreaterThan((doc.frontmatterSpan as { end: number }).end);
	});

	it('reports NORMALIZED offsets for a decomposed document', () => {
		const raw = 'Küche fertig.\n\nPumpe steht.\n'.normalize('NFD');
		const doc = normalize(raw);
		expect(doc.offsetMap).not.toBeNull();
		expect(wellFormed(doc)).toBe(true);
		// One combining mark was dropped ahead of the break, so the normalized offset
		// is one below the raw one — the raw offset would land on 'e' of 'Pumpe'.
		expect([...doc.blockBreaks]).toEqual([raw.indexOf('\n\n') + 1 - 1]);
		expect(doc.text.slice(0, 5)).toBe('kuche');
	});

	it('is well formed across the whole corpus', () => {
		for (const raw of BASE_DOCUMENTS) {
			expect(wellFormed(normalize(raw)), JSON.stringify(raw)).toBe(true);
		}
	});
});

/* ========================================================================== */
/* Words, boundaries, trigrams                                                */
/* ========================================================================== */

describe('extractWords / wordAt / isWordBoundary', () => {
	it('packs the distinct words in first-occurrence order', () => {
		const words = extractWords('die maschine und die 42 maschinen');
		expect(words.count).toBe(5);
		const list: string[] = [];
		for (let i = 0; i < words.count; i++) list.push(wordAt(words, i));
		expect(list).toEqual(['die', 'maschine', 'und', '42', 'maschinen']);
		expect(words.bounds.length).toBe(words.count + 1);
		expect(words.bounds[words.count]).toBe(words.packed.length + 1);
	});

	it('handles the empty document and out-of-range access', () => {
		const words = extractWords('   ');
		expect(words.count).toBe(0);
		expect(words.packed).toBe('');
		expect(wordAt(words, 0)).toBe('');
		expect(wordAt(words, -1)).toBe('');
	});

	it('treats everything outside [a-z0-9] as a boundary', () => {
		const text = 'die maschine';
		expect(isWordBoundary(text, 0)).toBe(true);
		expect(isWordBoundary(text, text.length)).toBe(true);
		expect(isWordBoundary(text, 3)).toBe(true);
		expect(isWordBoundary(text, 4)).toBe(true);
		expect(isWordBoundary(text, 6)).toBe(false);
	});

	it('produces sliding trigrams', () => {
		expect(trigrams('kaffee')).toEqual(['kaf', 'aff', 'ffe', 'fee']);
		expect(trigrams('ab')).toEqual([]);
		expect(trigrams('a b c')).toEqual(['a b', ' b ', 'b c']);
		expect(trigramSet('aaaa')).toEqual(new Set(['aaa']));
	});
});

/* ========================================================================== */
/* Term variants                                                              */
/* ========================================================================== */

describe('termVariants', () => {
	it('starts with the strip fold', () => {
		expect(termVariants('Küche', 8)[0]).toBe('kuche');
		expect(termVariants('Kueche', 8)[0]).toBe('kueche');
		expect(termVariants('MASCHINE', 8)[0]).toBe('maschine');
	});

	it('bridges alias and stored form in both directions', () => {
		expect(termVariants('Kueche', 8)).toContain('kuche');
		expect(termVariants('Küche', 8)).toContain('kueche');
		expect(termVariants('Strasse', 8)).toContain('strase');
		expect(termVariants('Straße', 8)).toContain('strasse');
		expect(termVariants('Straße', 8)).toContain('strase');
		expect(termVariants('Grüsse', 8)).toContain('gruesse');
	});

	it('accepts a decomposed query', () => {
		expect(termVariants('Küche', 8)).toContain('kuche');
		expect(termVariants('Küche', 8)).toContain('kueche');
	});

	it('never exceeds the cap and keeps the two extreme forms', () => {
		const many = termVariants('Baenkeloesungssaeule', 4);
		expect(many.length).toBeLessThanOrEqual(4);
		expect(many[0]).toBe('baenkeloesungssaeule');
		expect(many).toContain('bankelosungsaule');
		expect(termVariants('Küche', 1)).toEqual(['kuche']);
		expect(termVariants('Küche', 0)).toHaveLength(1);
	});

	it('deduplicates', () => {
		const variants = termVariants('maschine', 8);
		expect(variants).toEqual(['maschine']);
		expect(new Set(termVariants('Straßenkueche', 8)).size).toBe(termVariants('Straßenkueche', 8).length);
	});

	/**
	 * A contraction may not shorten a term below the length at which a term is
	 * still meaningful. Without the floor `ss` was searched as the single letter
	 * `s`, which matches nearly every note in a vault: 91 % of all match objects
	 * for that query came from that one variant, and it returned notes with no
	 * `ss` in them at all.
	 */
	it('never contracts a term down to one or two characters', () => {
		expect(termVariants('ss', 8)).toEqual(['ss']);
		expect(termVariants('ae', 8)).toEqual(['ae']);
		expect(termVariants('oe', 8)).toEqual(['oe']);
		expect(termVariants('ue', 8)).toEqual(['ue']);
		// Three characters minus one digraph is two, which is still under the floor.
		expect(termVariants('oel', 8)).toEqual(['oel']);
		expect(termVariants('ass', 8)).toEqual(['ass']);
		expect(termVariants('ueb', 8)).toEqual(['ueb']);
		// The seed — what the user actually typed — is never dropped, however
		// short it is; only contractions have to clear the floor.
		for (const term of ['ss', 'ae', 'oe', 'ue', 'oel', 'ass', 'ueb', 'kuess', 'straesse']) {
			const variants = termVariants(term, 8);
			expect(variants[0], term).toBe(term);
			for (const variant of variants.slice(1)) {
				expect(variant.length, `${term} -> ${variant}`).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it('still bridges the alias round trip for terms long enough to survive the floor', () => {
		// The floor must not cost the cases the alias fold exists for.
		expect(termVariants('strasse', 8)).toContain('strase');
		expect(termVariants('kueche', 8)).toContain('kuche');
		expect(termVariants('gruesse', 8)).toContain('gruse');
		expect(termVariants('fuss', 8)).toContain('fus');
		expect(termVariants('Grüße', 8)).toContain('gruse');
	});
});

/* ========================================================================== */
/* Dates                                                                      */
/* ========================================================================== */

describe('parseDateValue', () => {
	it('accepts the documented formats', () => {
		expect(parseDateValue('2026-03-14')).toBe(new Date(2026, 2, 14).getTime());
		expect(parseDateValue('2026-03-14T10:00:00Z')).toBe(Date.UTC(2026, 2, 14, 10, 0, 0));
		expect(parseDateValue('2026-03-14t10:00:00z')).toBe(Date.UTC(2026, 2, 14, 10, 0, 0));
		expect(parseDateValue('2026-03-14T10:00:00+01:00')).toBe(Date.UTC(2026, 2, 14, 9, 0, 0));
		expect(parseDateValue('2026-03-14 10:00')).toBe(new Date(2026, 2, 14, 10, 0).getTime());
		expect(parseDateValue('14.03.2026')).toBe(new Date(2026, 2, 14).getTime());
		expect(parseDateValue('4.3.2026')).toBe(new Date(2026, 2, 4).getTime());
		expect(parseDateValue('1773446400')).toBe(1773446400000);
		expect(parseDateValue('1773446400000')).toBe(1773446400000);
		expect(parseDateValue('  "2026-03-14"  ')).toBe(new Date(2026, 2, 14).getTime());
	});

	it('parses date-only values as local midnight', () => {
		const value = parseDateValue('2026-01-01');
		expect(value).not.toBeNull();
		expect(new Date(value as number).getHours()).toBe(0);
		expect(new Date(value as number).getDate()).toBe(1);
	});

	it('rejects everything else', () => {
		for (const value of ['yesterday', '', '   ', 'gestern', '2026', '2026-13-01', '2026-02-30', '32.01.2026', '177344640', 'x2026-03-14']) {
			expect(parseDateValue(value), value).toBeNull();
		}
	});
});
