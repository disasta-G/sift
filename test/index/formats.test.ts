import { describe, expect, it } from 'vitest';

import { buildCompactDocument, toOriginalOffset } from '../../src/index/Normalizer';
import { extractCanvasDocument } from '../../src/index/Canvas';
import {
	ALL_FORMATS,
	OPTIONAL_FORMATS,
	canonicalFormats,
	extractDocument,
	formatOfExtension,
	indexesFormat,
} from '../../src/index/Formats';
import type { NormalizedDoc } from '../../src/types';

const SETTINGS = { createdField: 'created' };

/**
 * The invariant every extractor owes the rest of the plugin: a normalized
 * offset maps back to a position in the raw file, and the text that sits there
 * is the text that was indexed.
 */
function expectOffsetsResolve(doc: NormalizedDoc, raw: string, needle: string): void {
	const at = doc.text.indexOf(needle);
	expect(at, `"${needle}" not in normalized text`).toBeGreaterThanOrEqual(0);
	const original = toOriginalOffset(doc, at);
	expect(raw.slice(original, original + needle.length).toLowerCase()).toBe(needle);
}

describe('buildCompactDocument', () => {
	it('keeps only the selected stretches and joins them with one space', () => {
		const raw = 'xxxHalloyyyWeltzzz';
		const doc = buildCompactDocument(raw, [
			{ start: 3, end: 8 },
			{ start: 11, end: 15 },
		]);
		expect(doc.text).toBe('hallo welt');
		expect(doc.originalLength).toBe(raw.length);
	});

	it('maps every normalized offset back to the original file', () => {
		const raw = 'xxxHalloyyyWeltzzz';
		const doc = buildCompactDocument(raw, [
			{ start: 3, end: 8 },
			{ start: 11, end: 15 },
		]);
		expect(toOriginalOffset(doc, 0)).toBe(3);
		expect(toOriginalOffset(doc, doc.text.indexOf('welt'))).toBe(11);
	});

	it('records a block break on every seam, so a phrase cannot span two segments', () => {
		const doc = buildCompactDocument('HalloWelt', [
			{ start: 0, end: 5 },
			{ start: 5, end: 9 },
		]);
		expect([...doc.blockBreaks]).toEqual([5]);
	});

	it('honours the offset-map contract for an empty result', () => {
		const doc = buildCompactDocument('nothing here', []);
		expect(doc.text).toBe('');
		expect(doc.offsetMap).not.toBeNull();
		expect(doc.offsetMap?.[doc.text.length]).toBe(doc.originalLength);
	});

	it('claims none of the Markdown structure it does not have', () => {
		const doc = buildCompactDocument('Hallo', [{ start: 0, end: 5 }]);
		expect(doc.frontmatterSpan).toBeNull();
		expect(doc.headings).toEqual([]);
		expect(doc.tags).toEqual([]);
		expect(doc.frontmatter).toEqual({});
		expect(doc.hasOpenTask).toBe(false);
	});

	it('skips inverted, overlapping and out-of-range segments instead of trusting them', () => {
		const raw = 'Hallo Welt';
		const doc = buildCompactDocument(raw, [
			{ start: 6, end: 3 },
			{ start: 0, end: 5 },
			{ start: 2, end: 4 },
			{ start: 6, end: 99 },
		]);
		expect(doc.text).toBe('hallo welt');
	});
});

describe('canvas extraction', () => {
	const canvas = JSON.stringify({
		nodes: [
			{ id: 'a1', type: 'text', x: 0, y: -240, width: 400, color: '4', text: 'Wärmepumpe planen' },
			{ id: 'b2', type: 'file', x: 20, y: 40, file: 'Projekte/Heizung.md' },
			{ id: 'c3', type: 'group', x: 0, y: 0, label: 'Altbau' },
			{ id: 'd4', type: 'link', x: 0, y: 0, url: 'https://example.invalid/pumpe' },
		],
		edges: [{ id: 'e5', fromNode: 'a1', toNode: 'b2', label: 'betrifft' }],
	});

	it('finds the text of a text node', () => {
		const doc = extractCanvasDocument(canvas);
		expect(doc.text).toContain('warmepumpe planen');
	});

	it('finds group labels, edge labels, file references and link targets', () => {
		const doc = extractCanvasDocument(canvas);
		expect(doc.text).toContain('altbau');
		expect(doc.text).toContain('betrifft');
		expect(doc.text).toContain('heizung');
		expect(doc.text).toContain('example.invalid');
	});

	it('indexes none of the geometry, ids, colours or type names', () => {
		const doc = extractCanvasDocument(canvas);
		// `text`, `file`, `group` and `link` are the values of `type`, which is
		// the same in every canvas ever written.
		expect(doc.text).not.toContain('group');
		expect(doc.text).not.toContain('fromnode');
		expect(doc.text).not.toContain('240');
	});

	it('costs a fraction of the file, rather than one space per skipped byte', () => {
		const doc = extractCanvasDocument(canvas);
		expect(doc.text.length).toBeLessThan(canvas.length / 2);
	});

	it('maps a hit back to the position of the word inside the file', () => {
		expectOffsetsResolve(extractCanvasDocument(canvas), canvas, 'altbau');
	});

	it('does not glue an escaped line break onto the next word', () => {
		const raw = JSON.stringify({ nodes: [{ type: 'text', text: 'Zeile1\nZeile2' }] });
		const doc = extractCanvasDocument(raw);
		expect(doc.text).toContain('zeile1 zeile2');
	});

	it('keeps a phrase from running across two nodes', () => {
		const raw = JSON.stringify({
			nodes: [
				{ type: 'text', text: 'Wärme' },
				{ type: 'text', text: 'Pumpe' },
			],
		});
		const doc = extractCanvasDocument(raw);
		const seam = doc.text.indexOf('warme') + 'warme'.length;
		expect([...doc.blockBreaks]).toContain(seam);
	});

	it('reads what it can out of a truncated file rather than nothing', () => {
		const doc = extractCanvasDocument('{"nodes":[{"type":"text","text":"Heizung');
		expect(doc.text).toContain('heizung');
	});

	it('returns an empty document for a canvas with no text at all', () => {
		const doc = extractCanvasDocument('{"nodes":[],"edges":[]}');
		expect(doc.text).toBe('');
	});
});

describe('base extraction', () => {
	const base = 'filters:\n  and:\n    - status != "erledigt"\n\nviews:\n  - type: table\n    name: Offene Projekte\n';

	it('indexes the view names and filter expressions', () => {
		const doc = extractDocument('base', base, SETTINGS);
		expect(doc.text).toContain('offene projekte');
		expect(doc.text).toContain('erledigt');
	});

	it('maps a hit back into the file', () => {
		expectOffsetsResolve(extractDocument('base', base, SETTINGS), base, 'erledigt');
	});

	it('keeps a phrase from running across two YAML lines', () => {
		const doc = extractDocument('base', 'name: Offene\nsort: Projekte\n', SETTINGS);
		const seam = doc.text.indexOf('offene') + 'offene'.length;
		expect([...doc.blockBreaks]).toContain(seam);
	});
});

describe('the format registry', () => {
	it('maps the three extensions, case-insensitively', () => {
		expect(formatOfExtension('md')).toBe('markdown');
		expect(formatOfExtension('MD')).toBe('markdown');
		expect(formatOfExtension('canvas')).toBe('canvas');
		expect(formatOfExtension('base')).toBe('base');
	});

	it('knows nothing about every other extension', () => {
		expect(formatOfExtension('pdf')).toBeNull();
		expect(formatOfExtension('png')).toBeNull();
		expect(formatOfExtension('')).toBeNull();
	});

	it('offers every kind but Markdown as switchable', () => {
		expect(ALL_FORMATS).toEqual(['markdown', 'canvas', 'base']);
		expect(OPTIONAL_FORMATS).toEqual(['canvas', 'base']);
	});

	it('canonicalizes a settings value into the declared order', () => {
		expect(canonicalFormats(['base', 'canvas'])).toEqual(['markdown', 'canvas', 'base']);
	});

	it('keeps Markdown whatever a hand-edited data.json says', () => {
		expect(canonicalFormats([])).toEqual(['markdown']);
		expect(canonicalFormats(['canvas'])).toEqual(['markdown', 'canvas']);
		expect(canonicalFormats('nonsense')).toEqual(['markdown']);
		expect(canonicalFormats(undefined)).toEqual(['markdown']);
		expect(indexesFormat({ indexedFormats: [] }, 'markdown')).toBe(true);
	});

	it('drops entries it has no extractor for', () => {
		expect(canonicalFormats(['canvas', 'pdf'])).toEqual(['markdown', 'canvas']);
	});

	it('answers whether a kind is indexed', () => {
		const settings = { indexedFormats: ['markdown', 'canvas'] as const };
		expect(indexesFormat(settings, 'canvas')).toBe(true);
		expect(indexesFormat(settings, 'base')).toBe(false);
	});

	it('sends Markdown down the full pass, with its headings and frontmatter intact', () => {
		const doc = extractDocument('markdown', '---\ncreated: 2024-01-01\n---\n\n# Heizung\n\nText.\n', SETTINGS);
		expect(doc.frontmatterSpan).not.toBeNull();
		expect(doc.headings).toHaveLength(1);
		expect(doc.offsetMap).toBeNull();
	});
});
