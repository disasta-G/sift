/**
 * The manifest helpers of `test/fixtures/loadVault.ts`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `expectedHits()` and `notesWhere()` are the authorities an assertion like
 * "the search finds as many notes as the generator wrote" is measured against.
 * Both used to answer `0` and `[]` for a vault whose manifest could not be read,
 * which turned that assertion into `0 === 0`: a green test that proves nothing,
 * on exactly the machine where the fixture was never generated. A missing
 * manifest is a broken setup, not an empty result, and the two have to be told
 * apart here rather than three test files deep.
 *
 * The cases below therefore drive the helpers with a hand-built `LoadedVault`
 * instead of the generated one, so they hold whether or not the vault on disk
 * exists.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import { describe, expect, it } from 'vitest';

import { MissingManifestError, expectedHits, notesWhere } from './loadVault';
import type { LoadedVault } from './loadVault';
import type { ManifestNote, VaultManifest } from './generate';

function note(path: string, ctime: number): ManifestNote {
	return { path, ctime, mtime: ctime + 1000, markers: [], words: 100 } as unknown as ManifestNote;
}

function manifest(notes: readonly ManifestNote[], markerCounts: Record<string, number>): VaultManifest {
	return {
		count: notes.length,
		notes: [...notes],
		markerCounts,
		markers: Object.keys(markerCounts),
	} as unknown as VaultManifest;
}

function vaultWith(source: VaultManifest | null): LoadedVault {
	const notes = source === null ? [] : source.notes;
	return {
		dir: 'C:/nowhere/vault',
		files: {},
		manifest: source,
		notesByPath: new Map(notes.map((entry) => [entry.path, entry])),
		totalLength: 0,
	};
}

const NOTES: ManifestNote[] = [note('a.md', 1_000), note('Projekte/b.md', 2_000), note('Projekte/c.md', 3_000)];

describe('expectedHits', () => {
	it('reads the count straight from the manifest', () => {
		const vault = vaultWith(manifest(NOTES, { Espressomaschine: 7 }));

		expect(expectedHits(vault, 'Espressomaschine')).toBe(7);
	});

	it('answers zero for a marker the manifest knows nothing about', () => {
		const vault = vaultWith(manifest(NOTES, { Espressomaschine: 7 }));

		expect(expectedHits(vault, 'Nichtvorhanden')).toBe(0);
	});

	it('throws instead of answering zero when the manifest is missing', () => {
		const vault = vaultWith(null);

		// The bug this pins: `expect(hits.length).toBe(expectedHits(vault, marker))`
		// used to degenerate to `0 === 0` and pass on a machine with no fixture.
		expect(() => expectedHits(vault, 'Espressomaschine')).toThrow(MissingManifestError);
		expect(() => expectedHits(vault, 'Espressomaschine')).toThrow(/npm run fixtures/);
	});
});

describe('notesWhere', () => {
	it('filters the manifest notes', () => {
		const vault = vaultWith(manifest(NOTES, {}));

		expect(notesWhere(vault, (candidate) => candidate.path.startsWith('Projekte/')).map((found) => found.path))
			.toEqual(['Projekte/b.md', 'Projekte/c.md']);
	});

	it('may legitimately match nothing', () => {
		const vault = vaultWith(manifest(NOTES, {}));

		expect(notesWhere(vault, () => false)).toEqual([]);
	});

	it('throws instead of answering an empty list when the manifest is missing', () => {
		const vault = vaultWith(null);

		expect(() => notesWhere(vault, () => true)).toThrow(MissingManifestError);
		expect(() => notesWhere(vault, () => true)).toThrow(/npm run fixtures/);
	});

	it('names the vault directory, so the message says which vault to generate', () => {
		const vault = vaultWith(null);

		expect(() => notesWhere(vault, () => true)).toThrow(/C:\/nowhere\/vault/);
	});
});
