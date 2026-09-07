/**
 * The scope guard is only worth having if it actually fires. These tests drive
 * `scripts/scope-guard.mjs` end to end against throwaway git repositories in a
 * temporary directory: a forbidden pattern must be reported, an allowlisted one
 * must not, and the file list must come from the git index rather than from a
 * directory walk.
 *
 * Node APIs are used deliberately here - this is the test harness, not plugin
 * code, and it has to create real repositories for the guard to read.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const GUARD = join(process.cwd(), 'scripts', 'scope-guard.mjs');
const PRODUCTION_RULES = join(process.cwd(), 'guard', 'forbidden.json');

/**
 * The guard's own machinery, both files tracked and both read by anyone who
 * clones the repo. This test file is the awkward one: to test a rule it has to
 * contain the very string that rule forbids, so it is the first place where the
 * guard turns on itself. A rule that fires here is unfixable by the developer -
 * the fixture cannot be softened without dropping the coverage - and a gate that
 * can never go green gets switched off, which is the one outcome the guard must
 * not produce. The test at the bottom of this file pins that down: the
 * production rules must report nothing against these two files.
 */
const GUARD_OWN_FILES = ['scripts/scope-guard.mjs', 'test/guard.test.ts'];

interface Finding {
	rule: string;
	why: string;
	file: string;
	line: number;
	text: string;
}

interface GuardReport {
	ok: boolean;
	summary: string;
	warnings: string[];
	findings: Finding[];
}

interface GuardRun {
	status: number;
	stdout: string;
	stderr: string;
}

const hasGit = ((): boolean => {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

let base = '';

function git(cwd: string, args: string[]): void {
	execFileSync(
		'git',
		[
			'-c', 'user.name=Guard Test',
			'-c', 'user.email=guard@example.invalid',
			'-c', 'core.autocrlf=false',
			// Throwaway fixture repositories only: they must not depend on the
			// developer's signing setup. The project's own commits are unaffected.
			'-c', 'commit.gpgsign=false',
			...args,
		],
		{ cwd, stdio: 'ignore' },
	);
}

/** Creates a repository, writes `files`, and stages them unless `stage` is false. */
function makeRepo(name: string, files: Record<string, string>, stage = true): string {
	const root = join(base, name);
	mkdirSync(root, { recursive: true });
	git(root, ['init', '-q']);
	write(root, files);
	if (stage) git(root, ['add', '-A']);
	return root;
}

function write(root: string, files: Record<string, string>): void {
	for (const [relative, content] of Object.entries(files)) {
		const absolute = join(root, relative);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content, 'utf8');
	}
}

function runGuard(args: string[]): GuardRun {
	const result = spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8' });
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
	};
}

function report(root: string, extra: string[] = [], rules = ''): GuardReport {
	const rulesPath = rules === '' ? join(root, 'guard', 'forbidden.json') : rules;
	const run = runGuard(['--root', root, '--rules', rulesPath, '--json', ...extra]);
	expect(run.stderr, run.stderr).toBe('');
	const parsed: unknown = JSON.parse(run.stdout) as unknown;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error(`guard did not print a JSON object: ${run.stdout}`);
	}
	return parsed as GuardReport;
}

function rulesFile(rules: unknown[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...extra, rules }, null, '\t');
}

/** One content rule plus one path rule, with a single allow entry. */
const SAMPLE_RULES = rulesFile([
	{
		id: 'TEST-SECRET-NAME',
		why: 'A worker secret name proves a paid backend exists, even as a placeholder.',
		kind: 'content',
		pattern: 'JWT_SECRET',
		allow: [
			{ file: 'docs/allowed.md', note: 'Documented exception used by the guard test suite.' },
			{ file: 'src/scoped.ts', match: 'documented exception', note: 'Only the line carrying the marker is exempt.' },
		],
	},
	{
		id: 'TEST-TRIAL-MOCKUP',
		why: 'A rendered paywall screenshot cannot be grepped, so it needs a path rule.',
		kind: 'path',
		glob: ['docs/mockup-trial-expired.*'],
	},
]);

describe.skipIf(!hasGit)('scope guard', () => {
	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), 'sift-guard-'));
	});

	afterAll(() => {
		if (base !== '') rmSync(base, { recursive: true, force: true });
	});

	it('reports a forbidden pattern in a tracked file, with rule, location and matched text', () => {
		const root = makeRepo('fires', {
			'guard/forbidden.json': SAMPLE_RULES,
			'src/config.ts': 'const a = 1;\nexport const key = process.env.JWT_SECRET;\n',
		});

		const result = report(root);

		expect(result.ok).toBe(false);
		const hit = result.findings.find((finding) => finding.file === 'src/config.ts');
		expect(hit).toBeDefined();
		expect(hit?.rule).toBe('TEST-SECRET-NAME');
		expect(hit?.line).toBe(2);
		expect(hit?.text).toBe('JWT_SECRET');
		expect(hit?.why).toContain('paid backend');
	});

	it('exits 1 and prints "rule-id  file:line  matched text" in the human-readable output', () => {
		const root = makeRepo('output', {
			'guard/forbidden.json': SAMPLE_RULES,
			'src/config.ts': 'export const key = "JWT_SECRET";\n',
		});

		const run = runGuard(['--root', root, '--rules', join(root, 'guard', 'forbidden.json')]);

		expect(run.status).toBe(1);
		expect(run.stdout).toMatch(/TEST-SECRET-NAME\s+src\/config\.ts:1\s+JWT_SECRET/);
		expect(run.stdout).toContain('scope-guard: FAIL');
	});

	it('does not report an allowlisted file', () => {
		const root = makeRepo('allowed', {
			'guard/forbidden.json': SAMPLE_RULES,
			'docs/allowed.md': 'The worker reads JWT_SECRET from its environment.\n',
		});

		const result = report(root);

		expect(result.findings).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.summary).toContain('scope-guard: OK');
	});

	it('applies an allow entry with `match` only to the line that carries the reason', () => {
		const root = makeRepo('allow-match', {
			'guard/forbidden.json': SAMPLE_RULES,
			'src/scoped.ts':
				'// documented exception: JWT_SECRET is named here on purpose\n' +
				'const leak = "JWT_SECRET";\n',
		});

		const result = report(root);

		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.line).toBe(2);
	});

	it('catches a binary file that no content rule could read', () => {
		const root = makeRepo('binary', { 'guard/forbidden.json': SAMPLE_RULES });
		// A PNG header plus NUL bytes: binary, so content rules skip it entirely.
		mkdirSync(join(root, 'docs'), { recursive: true });
		writeFileSync(
			join(root, 'docs', 'mockup-trial-expired.png'),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
		);
		git(root, ['add', '-A']);

		const result = report(root);

		expect(result.findings.map((finding) => finding.rule)).toContain('TEST-TRIAL-MOCKUP');
		expect(result.findings[0]?.file).toBe('docs/mockup-trial-expired.png');
	});

	it('judges the git index, not the directory: an untracked file is invisible without --worktree', () => {
		const root = makeRepo('untracked', { 'guard/forbidden.json': SAMPLE_RULES });
		write(root, { 'src/scratch.ts': 'const k = "JWT_SECRET";\n' });

		expect(report(root).findings).toEqual([]);
		expect(report(root, ['--worktree']).findings.map((finding) => finding.file)).toContain('src/scratch.ts');
	});

	it('scans the built main.js even though it is ignored, because that is what ships', () => {
		const root = makeRepo('bundle', {
			'guard/forbidden.json': rulesFile(
				[
					{
						id: 'TEST-BUNDLE-STRING',
						why: 'A flagged-off branch still ends up in the bundle, which is the file that actually ships.',
						kind: 'content',
						pattern: 'JWT_SECRET',
						targets: ['src/**', 'main.js'],
					},
				],
				{ extraScanTargets: ['main.js'] },
			),
			'.gitignore': 'main.js\n',
			'src/main.ts': 'export const clean = true;\n',
		});
		write(root, { 'main.js': '// bundled\nconst k = "JWT_SECRET";\n' });

		const result = report(root);

		expect(result.findings.map((finding) => finding.file)).toEqual(['main.js']);
	});

	it('fails on history, because a public repository publishes deleted files too', () => {
		const root = makeRepo('history', {
			'guard/forbidden.json': rulesFile([], { historyPaths: ['src/ai', 'src/license', 'backend'] }),
			'src/ai/AiClient.ts': 'export const gone = true;\n',
		});
		git(root, ['commit', '-q', '-m', 'add the client']);
		rmSync(join(root, 'src', 'ai'), { recursive: true, force: true });
		git(root, ['add', '-A']);
		git(root, ['commit', '-q', '-m', 'remove it again']);

		const result = report(root);

		expect(result.findings.map((finding) => finding.rule)).toContain('HISTORY-PAID-CODE');
	});

	it('reports a missing .gitignore entry and a runtime dependency', () => {
		const root = makeRepo('hygiene', {
			'guard/forbidden.json': rulesFile([], {
				requiredGitignore: ['.env', 'data.json'],
				packageJsonNoRuntimeDeps: true,
			}),
			'.gitignore': '.env\n',
			'package.json': JSON.stringify({ name: 'x', dependencies: { hono: '^4.0.0' } }),
		});

		const result = report(root);
		const texts = result.findings.map((finding) => finding.text);

		expect(texts).toContain('missing entry: data.json');
		expect(texts).toContain('runtime dependency: hono');
		expect(texts).not.toContain('missing entry: .env');
	});

	it('rejects a rules file whose allow entry has no reason', () => {
		const root = makeRepo('badrules', {
			'guard/forbidden.json': rulesFile([
				{
					id: 'TEST-NO-NOTE',
					why: 'An exception without a reason is how a guard quietly stops guarding.',
					kind: 'content',
					pattern: 'JWT_SECRET',
					allow: [{ file: 'src/**' }],
				},
			]),
		});

		const run = runGuard(['--root', root, '--rules', join(root, 'guard', 'forbidden.json'), '--json']);

		expect(run.status).toBe(1);
		expect(run.stderr).toContain('needs a "note"');
	});

	it('reports nothing against its own two files under the production rules', () => {
		const config = JSON.parse(readFileSync(PRODUCTION_RULES, 'utf8')) as { requiredGitignore?: string[] };
		const files: Record<string, string> = {
			// The structural checks read this file directly; without it the run
			// would report missing ignore entries rather than the rule findings
			// this test is about.
			'.gitignore': `${(config.requiredGitignore ?? []).join('\n')}\n`,
		};
		for (const relative of GUARD_OWN_FILES) {
			files[relative] = readFileSync(join(process.cwd(), relative), 'utf8');
		}
		const root = makeRepo('self', files);

		const result = report(root, [], PRODUCTION_RULES);

		// A failure here means a fixture in this file, or a line in the guard
		// script, now trips a production rule. The fix is an allow entry naming
		// the file and the reason - never a weakened pattern and never a weakened
		// fixture, because both of those cost the coverage the rule was added for.
		expect(result.findings, JSON.stringify(result.findings, null, '\t')).toEqual([]);
		expect(result.ok).toBe(true);
	});

	describe('release checks', () => {
		const cleanFiles = (): Record<string, string> => ({
			'.gitignore': '.env\n.env.*\nnode_modules/\nmain.js\ndata.json\n',
			'README.md': '# Sift\n\nLocal search.\n',
			'LICENSE': 'MIT License\n\nCopyright (c) 2026 Dario Giovanoli\n',
			'styles.css': '.sift-modal {\n\tcolor: var(--text-normal);\n}\n',
			'package.json': JSON.stringify({ name: 'sift', version: '1.0.0', private: true }, null, '\t'),
			'manifest.json': JSON.stringify(
				{
					id: 'sift',
					name: 'Sift',
					version: '1.0.0',
					minAppVersion: '1.8.7',
					description: 'Search your notes with substring matching, operators and filters.',
					author: 'Dario Giovanoli',
					isDesktopOnly: false,
				},
				null,
				'\t',
			),
			'versions.json': JSON.stringify({ '1.0.0': '1.8.7' }, null, '\t'),
			'main.js': `${'// readable bundle line\n'.repeat(250)}`,
		});

		it('passes the production rule set and the release checks on a clean tree', () => {
			const root = makeRepo('release-ok', cleanFiles());

			const result = report(root, ['--release'], PRODUCTION_RULES);

			expect(result.findings, JSON.stringify(result.findings, null, '\t')).toEqual([]);
			expect(result.ok).toBe(true);
		});

		it('rejects a description that is not an action statement, and a minified bundle', () => {
			const files = cleanFiles();
			files['manifest.json'] = JSON.stringify({
				id: 'sift',
				name: 'Sift',
				version: '1.0.0',
				minAppVersion: '1.8.7',
				description: 'This is a plugin that finds notes 🔍',
				author: 'Dario Giovanoli',
				isDesktopOnly: false,
			});
			files['main.js'] = 'var a=1;var b=2;\n';
			const root = makeRepo('release-bad', files);

			const result = report(root, ['--release'], PRODUCTION_RULES);
			const texts = result.findings.filter((f) => f.rule.startsWith('RELEASE-')).map((f) => f.text);

			expect(texts).toContain('description does not end with a period');
			expect(texts).toContain('description contains an emoji');
			expect(texts).toContain('description contains "obsidian" or "plugin"');
			expect(texts.some((text) => text.includes('not one of the accepted action verbs'))).toBe(true);
			expect(texts.some((text) => text.includes('main.js has 2 lines'))).toBe(true);
		});

		it('rejects a manifest version that package.json and versions.json do not confirm', () => {
			const files = cleanFiles();
			files['package.json'] = JSON.stringify({ name: 'sift', version: '1.0.1', private: true });
			const root = makeRepo('release-version', files);

			const result = report(root, ['--release'], PRODUCTION_RULES);

			expect(result.findings.map((finding) => finding.text)).toContain(
				'package.json version 1.0.1 does not equal manifest version 1.0.0',
			);
		});
	});
});
