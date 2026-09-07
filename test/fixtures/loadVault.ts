/**
 * Reads a generated fixture vault off disk into the shape `createFakeApp`
 * expects, so the Indexer tests, the Searcher tests and the benchmark all load
 * it exactly the same way.
 *
 * TIMES COME FROM THE MANIFEST, NOT FROM `fs.stat`
 * ------------------------------------------------
 * `utimesSync` can set mtime but not birth time, and what `fs.stat` reports for
 * `ctime` differs between Windows, macOS and Linux. Reading the manifest instead
 * makes a date-filter assertion mean the same thing everywhere. `fs.stat` is
 * only the fallback for a file the manifest does not mention.
 *
 * Node APIs are fine here: this file is test infrastructure and never ships.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeApp, type FakeApp, type FakeFileSpec } from '../helpers/fakeVault';
import { MANIFEST_NAME, type ManifestNote, type VaultManifest } from './generate';

/** Default location of the generated vault: `test/fixtures/vault`. */
export const DEFAULT_VAULT_DIR = fileURLToPath(new URL('./vault', import.meta.url));

/** A vault read off disk, ready to hand to {@link createFakeApp}. */
export interface LoadedVault {
	/** Absolute directory the vault was read from. */
	dir: string;
	/** Vault-relative path -> file spec, in the shape `createFakeApp` takes. */
	files: Record<string, FakeFileSpec>;
	/** The generator's manifest. `null` only when the vault was written by something else. */
	manifest: VaultManifest | null;
	/** Manifest entries keyed by path, for assertions that need a note's expected `created`. */
	notesByPath: Map<string, ManifestNote>;
	/** Total UTF-16 length of all note contents. Handy for a benchmark's throughput line. */
	totalLength: number;
}

/** The command that produces a usable vault, quoted in both errors below. */
function generateCommand(dir: string): string {
	return `npm run fixtures -- --count 2000 --out "${dir}"`;
}

/** Thrown when the vault has not been generated yet, with the command that fixes it. */
export class MissingVaultError extends Error {
	constructor(dir: string) {
		super(`No fixture vault at "${dir}". Generate one first:\n  ${generateCommand(dir)}`);
		this.name = 'MissingVaultError';
	}
}

/**
 * Thrown when an assertion asks the manifest a question and there is no
 * manifest to answer it.
 *
 * WHY THIS IS AN ERROR AND NOT A FALLBACK
 * ---------------------------------------
 * {@link expectedHits} and {@link notesWhere} are what a test compares its
 * result against. Answering `0` and `[]` for a vault with no manifest turns
 * `expect(hits.length).toBe(expectedHits(vault, marker))` into `0 === 0`, so the
 * assertion passes while proving nothing — precisely on the machine where the
 * fixture was never generated. A setup that cannot be checked has to be louder
 * than one that fails.
 */
export class MissingManifestError extends Error {
	constructor(dir: string, question: string) {
		super(
			`The fixture vault at "${dir}" has no readable ${MANIFEST_NAME}, so ${question} cannot be answered.`
			+ ` Any assertion derived from it would compare nothing against nothing. Generate the vault first:\n`
			+ `  ${generateCommand(dir)}`,
		);
		this.name = 'MissingManifestError';
	}
}

/** Reads the manifest, or `null` when there is none. */
export function readManifest(dir: string = DEFAULT_VAULT_DIR): VaultManifest | null {
	try {
		return JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8')) as VaultManifest;
	} catch {
		return null;
	}
}

/**
 * Loads every `.md` file under `dir`.
 *
 * `limit` truncates to the first N notes in manifest order — the generator emits
 * notes deterministically, so the first N of a large vault are the same notes a
 * small vault would contain. That lets one 10 000-note vault serve a benchmark
 * and a fast unit test without regenerating.
 */
export function loadVault(dir: string = DEFAULT_VAULT_DIR, limit?: number): LoadedVault {
	const absolute = resolve(dir);
	let paths: string[];
	try {
		paths = collectMarkdown(absolute, '');
	} catch {
		throw new MissingVaultError(absolute);
	}
	if (paths.length === 0) throw new MissingVaultError(absolute);

	const manifest = readManifest(absolute);
	const notesByPath = new Map<string, ManifestNote>();
	if (manifest !== null) {
		for (const note of manifest.notes) notesByPath.set(note.path, note);
	}

	// Manifest order when we have it, so `limit` takes the same prefix the
	// generator would have produced; alphabetical otherwise.
	const onDisk = new Set(paths);
	const ordered =
		manifest === null
			? paths.sort()
			: manifest.notes.map((note) => note.path).filter((path) => onDisk.has(path));
	const selected = limit === undefined ? ordered : ordered.slice(0, limit);

	const files: Record<string, FakeFileSpec> = {};
	let totalLength = 0;
	for (const path of selected) {
		const content = readFileSync(join(absolute, path), 'utf8');
		totalLength += content.length;
		const note = notesByPath.get(path);
		if (note !== undefined) {
			files[path] = { content, ctime: note.ctime, mtime: note.mtime };
		} else {
			const stat = statSync(join(absolute, path));
			files[path] = { content, ctime: Math.round(stat.birthtimeMs || stat.ctimeMs), mtime: Math.round(stat.mtimeMs) };
		}
	}

	return { dir: absolute, files, manifest, notesByPath, totalLength };
}

/** `loadVault` plus `createFakeApp` — the one call an Indexer or Searcher test needs. */
export function loadFakeApp(dir: string = DEFAULT_VAULT_DIR, limit?: number): { app: FakeApp; vault: LoadedVault } {
	const vault = loadVault(dir, limit);
	return { app: createFakeApp(vault.files), vault };
}

/**
 * How many notes of the loaded vault contain `marker`, straight from the
 * manifest. A marker the manifest does not list occurs in no note and is `0`;
 * a vault with no manifest cannot answer at all and throws
 * {@link MissingManifestError}.
 */
export function expectedHits(vault: LoadedVault, marker: string): number {
	const manifest = requireManifest(vault, `the expected hit count for "${marker}"`);
	return manifest.markerCounts[marker] ?? 0;
}

/**
 * Every manifest note matching `predicate`. Sugar for date- and folder-filter
 * assertions. An empty result means no note matched; a vault with no manifest
 * throws {@link MissingManifestError} rather than looking like one.
 */
export function notesWhere(vault: LoadedVault, predicate: (note: ManifestNote) => boolean): ManifestNote[] {
	return requireManifest(vault, 'which notes match').notes.filter(predicate);
}

function requireManifest(vault: LoadedVault, question: string): VaultManifest {
	if (vault.manifest === null) throw new MissingManifestError(vault.dir, question);
	return vault.manifest;
}

function collectMarkdown(root: string, relative: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
		const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) found.push(...collectMarkdown(root, childRelative));
		else if (entry.name.endsWith('.md')) found.push(childRelative);
	}
	return found;
}
