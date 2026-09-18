/**
 * The release body is cut out of CHANGELOG.md by `scripts/release-notes.mjs`,
 * and the release workflow runs it BEFORE it builds anything: a version whose
 * changelog entry was forgotten has to stop the release rather than publish an
 * empty page. These tests drive the script the way the workflow does — as a
 * process, against a changelog written to a temporary directory — and the last
 * one runs it against the repository's own file, so the shipping changelog and
 * the extractor cannot drift apart unnoticed.
 *
 * Node APIs are used deliberately: this is build machinery, not plugin code.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'release-notes.mjs');
const REPOSITORY = 'disasta-G/sift';

const CHANGELOG = [
	'# Changelog',
	'',
	'Preamble that belongs to no version.',
	'',
	'## [Unreleased]',
	'',
	'## [1.5.0] — 2026-09-18',
	'',
	'### Changed',
	'',
	'- An exclusion matches whole words now.',
	'',
	'## [1.4.1] — 2026-09-14',
	'',
	'### Fixed',
	'',
	'- The cursor no longer flickers.',
	'',
	'## [1.0.0] — 2026-09-08',
	'',
	'The first release.',
	'',
	'[Unreleased]: https://github.com/disasta-G/sift/compare/1.5.0...HEAD',
	'[1.5.0]: https://github.com/disasta-G/sift/compare/1.4.1...1.5.0',
	'[1.0.0]: https://github.com/disasta-G/sift/releases/tag/1.0.0',
	'',
].join('\n');

let directory: string;

function run(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'sift-release-notes-'));
	writeFileSync(join(directory, 'CHANGELOG.md'), CHANGELOG, 'utf8');
});

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('release-notes — extraction', () => {
	it('prints the section of the version it was asked for', () => {
		const result = run(['1.5.0'], directory);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('### Changed\n\n- An exclusion matches whole words now.\n');
	});

	it('stops at the next version heading', () => {
		expect(run(['1.4.1'], directory).stdout).toBe('### Fixed\n\n- The cursor no longer flickers.\n');
	});

	it('leaves the link definitions out of the oldest section', () => {
		expect(run(['1.0.0'], directory).stdout).toBe('The first release.\n');
	});

	it('appends the compare link when a previous tag and a repository are given', () => {
		const result = run(['1.5.0', '1.4.1', REPOSITORY], directory);
		expect(result.stdout.trimEnd().split('\n').pop()).toBe(
			`**Full Changelog**: https://github.com/${REPOSITORY}/compare/1.4.1...1.5.0`,
		);
	});

	it('leaves the link out when there is no previous tag, as on a first release', () => {
		expect(run(['1.0.0', '', REPOSITORY], directory).stdout).toBe('The first release.\n');
	});
});

describe('release-notes — refusal', () => {
	it('fails on a version the changelog does not carry', () => {
		const result = run(['9.9.9'], directory);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no section for 9.9.9');
		expect(result.stdout).toBe('');
	});

	it('fails on a heading with nothing under it, the way Unreleased usually stands', () => {
		const result = run(['Unreleased'], directory);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('is empty');
	});

	it('fails when no version was given at all', () => {
		expect(run([], directory).status).toBe(1);
	});
});

describe('release-notes — against the shipping changelog', () => {
	it('finds a non-empty section for the version in manifest.json', () => {
		const version = (JSON.parse(readFileSync('manifest.json', 'utf8')) as { version: string }).version;
		const result = run([version, '', REPOSITORY], process.cwd());
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim().length).toBeGreaterThan(0);
	});

	it('finds a non-empty section for every released version in versions.json', () => {
		const versions = Object.keys(JSON.parse(readFileSync('versions.json', 'utf8')) as Record<string, string>);
		expect(versions.length).toBeGreaterThan(0);
		for (const version of versions) {
			const result = run([version], process.cwd());
			expect(result.status, `${version}: ${result.stderr}`).toBe(0);
		}
	});
});
