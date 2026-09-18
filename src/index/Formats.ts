/**
 * Formats — which file kinds Sift indexes, and which extractor reads each one.
 *
 * This is the single place a file kind is added. Everything else in the plugin
 * asks here: the Indexer for the set of files to enumerate, main.ts for whether
 * a vault event is worth forwarding, the settings tab for the switches it
 * draws, and the Store for the fingerprint that decides whether a persisted
 * index still matches the settings.
 *
 * ---------------------------------------------------------------------------
 * THE SET IS CLOSED, AND STAYS CLOSED
 * ---------------------------------------------------------------------------
 * There is no setting that takes an extension. A free-text list would be
 * pointed at `.pdf` or `.png` within a week, and since every extractor holds
 * the file's text in memory (see {@link IndexedFile.text}), a vault of PDFs
 * would blow the memory budget with bytes that are not words. A new kind
 * therefore means a new extractor here, reviewed with the format in hand.
 *
 * Markdown is not removable. A Sift that indexes no notes is not a search
 * plugin, and a settings state that produces an empty index is not worth being
 * able to reach.
 */

import { buildCompactDocument, normalizeDocument } from './Normalizer';
import type { TextSegment } from './Normalizer';
import { extractCanvasDocument } from './Canvas';
import type { FileFormat, NormalizedDoc, SiftSettings } from '../types';

/** Extension of every kind Sift knows, without the dot. */
const EXTENSIONS: Readonly<Record<FileFormat, string>> = {
	markdown: 'md',
	canvas: 'canvas',
	base: 'base',
};

/** The kind that is always indexed, whatever the settings say. */
export const REQUIRED_FORMAT: FileFormat = 'markdown';

/**
 * Every kind, in the order the settings tab and the filter bar present them.
 * Markdown first because it is the default and the one that cannot be switched
 * off.
 */
export const ALL_FORMATS: readonly FileFormat[] = ['markdown', 'canvas', 'base'];

/** Kinds the user may switch off — {@link ALL_FORMATS} without {@link REQUIRED_FORMAT}. */
export const OPTIONAL_FORMATS: readonly FileFormat[] = ALL_FORMATS.filter((format) => format !== REQUIRED_FORMAT);

/** Extension to kind. Case-insensitive, because a vault synced from Windows can carry `.MD`. */
const BY_EXTENSION: ReadonlyMap<string, FileFormat> = new Map(
	ALL_FORMATS.map((format) => [EXTENSIONS[format], format] as const),
);

/** The kind of `extension`, or `null` when Sift has no extractor for it. */
export function formatOfExtension(extension: string): FileFormat | null {
	return BY_EXTENSION.get(extension.toLowerCase()) ?? null;
}

/**
 * Normalizes a settings value into a canonical, deduplicated list.
 *
 * Canonical means: {@link ALL_FORMATS} order, `markdown` always present,
 * unknown entries dropped. The order matters because the list is hashed into
 * the settings fingerprint, and a reordered list must not force a rebuild.
 * Untrusted input, since it comes from `data.json`, which a user may edit.
 */
export function canonicalFormats(value: unknown): readonly FileFormat[] {
	const requested = new Set<string>(Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);
	return ALL_FORMATS.filter((format) => format === REQUIRED_FORMAT || requested.has(format));
}

/**
 * Whether `format` is indexed under `settings`.
 *
 * Reads the setting through {@link canonicalFormats} rather than trusting it,
 * so a hand-edited `data.json` cannot switch Markdown off through the back
 * door.
 */
export function indexesFormat(settings: Pick<SiftSettings, 'indexedFormats'>, format: FileFormat): boolean {
	if (format === REQUIRED_FORMAT) return true;
	return canonicalFormats(settings.indexedFormats).includes(format);
}

/**
 * Line-by-line extraction, used for `.base`.
 *
 * A Base file is a small YAML document: view names, filter expressions, formula
 * names and the property keys they mention. All of it is text worth finding and
 * none of it is Markdown, so there is nothing to blank — but there is also no
 * reason for a phrase to run from one YAML line into the next, which is why the
 * lines become separate segments and the builder puts a block break between
 * them. Leading indentation falls away with the segment boundaries.
 */
function extractLineDocument(raw: string): NormalizedDoc {
	const segments: TextSegment[] = [];
	let start = 0;
	for (let i = 0; i <= raw.length; i++) {
		if (i < raw.length && raw.charCodeAt(i) !== 0x0a) continue;
		let from = start;
		let to = i;
		// `\r` on a CRLF vault, and indentation, carry nothing.
		while (from < to && isBlank(raw.charCodeAt(from))) from++;
		while (to > from && isBlank(raw.charCodeAt(to - 1))) to--;
		if (to > from) segments.push({ start: from, end: to });
		start = i + 1;
	}
	return buildCompactDocument(raw, segments);
}

function isBlank(code: number): boolean {
	return code === 0x20 || code === 0x09 || code === 0x0d;
}

/**
 * Turns one file's raw text into the document the Indexer stores.
 *
 * Markdown keeps the full pass — frontmatter, headings, tags, open tasks, the
 * `created` field — because those are Markdown concepts. The other kinds have
 * none of them and say so explicitly; see {@link buildCompactDocument}.
 */
export function extractDocument(
	format: FileFormat,
	raw: string,
	settings: Pick<SiftSettings, 'createdField'>,
): NormalizedDoc {
	switch (format) {
		case 'canvas':
			return extractCanvasDocument(raw);
		case 'base':
			return extractLineDocument(raw);
		default:
			return normalizeDocument(raw, settings);
	}
}
