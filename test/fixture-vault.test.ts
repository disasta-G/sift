/**
 * The generated fixture vault is a build input, not a checked-in file: it is
 * git-ignored, and `npm run fixtures` writes it. Three test files and two cases
 * in the indexer suite load it, and the benchmark measures against it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A missing vault used to be discovered three test files deep, and a vault that
 * was present but incomplete was not discovered at all: `expectedHits()` and
 * `notesWhere()` in `test/fixtures/loadVault.ts` used to fall back to `0` and
 * `[]` when the manifest could not be read, so an assertion written as "the
 * search finds as many notes as the manifest says" quietly became `0 === 0` and
 * passed. Those two helpers now throw instead, and this file is the second
 * half of the same fix: it fails FIRST, before any suite gets that far, and it
 * names the command that repairs the situation. A run that proves nothing has
 * to be louder than a run that fails.
 *
 * So this file is the gate in front of every other vault-dependent test: it
 * fails first, and it fails with the command that fixes it. `npm run fixtures`
 * is what CI executes before the test step, at the same note count.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SEED, type VaultManifest } from './fixtures/generate';
import { DEFAULT_VAULT_DIR, loadVault, readManifest } from './fixtures/loadVault';

/**
 * The note count the suite is written for. It is the generator's own default,
 * the count `MissingVaultError` tells you to use and the count CI generates.
 * Notes are emitted deterministically, so a bigger vault is a superset and is
 * fine - a smaller one is not, because the rare markers ("Espresomaschine"
 * occurs in a handful of notes out of ten thousand) thin out to nothing and the
 * fuzzy assertions then compare zero against zero.
 */
const EXPECTED_NOTE_COUNT = 2000;

const FIX_IT = 'Run `npm run fixtures -- --count 2000` and try again.';

describe('the generated fixture vault', () => {
	it('has been generated', () => {
		expect(
			existsSync(DEFAULT_VAULT_DIR),
			`No fixture vault at ${DEFAULT_VAULT_DIR}. Every Searcher, fuzzy and filter test reads it. ${FIX_IT}`,
		).toBe(true);
	});

	it('carries the manifest the assertions are derived from', () => {
		const manifest = readManifest();

		expect(
			manifest,
			`The vault at ${DEFAULT_VAULT_DIR} has no readable _manifest.json, so every`
			+ ` expectedHits() and notesWhere() call throws and no vault-dependent test can run. ${FIX_IT}`,
		).not.toBeNull();
		expect((manifest as VaultManifest).seed).toBe(SEED);
	});

	it('holds at least the note count the suite is written for', () => {
		const manifest = readManifest() as VaultManifest;

		expect(
			manifest.count,
			`The vault holds ${manifest.count} notes; the suite is written for ${EXPECTED_NOTE_COUNT}. ${FIX_IT}`,
		).toBeGreaterThanOrEqual(EXPECTED_NOTE_COUNT);
		expect(manifest.notes).toHaveLength(manifest.count);
	});

	it('contains every marker the search assertions look for, at least once', () => {
		const manifest = readManifest() as VaultManifest;

		const missing = manifest.markers.filter((marker) => (manifest.markerCounts[marker] ?? 0) === 0);

		expect(
			missing,
			`These markers occur in no note, so any assertion counting them compares 0 against 0: ${missing.join(', ')}.`
			+ ` ${FIX_IT}`,
		).toEqual([]);
	});

	it('loads off disk with the note contents and times the date filters need', () => {
		const vault = loadVault(undefined, 25);
		const paths = Object.keys(vault.files);

		expect(paths).toHaveLength(25);
		for (const path of paths) {
			const file = vault.files[path];
			expect(file.content.length, path).toBeGreaterThan(0);
			expect(Number.isFinite(file.ctime), path).toBe(true);
			expect(Number.isFinite(file.mtime), path).toBe(true);
			// The manifest, not fs.stat, is the authority on the times - that is
			// what makes a date-filter assertion mean the same on every platform.
			expect(vault.notesByPath.get(path)?.ctime, path).toBe(file.ctime);
		}
	});
});
