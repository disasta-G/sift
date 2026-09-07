#!/usr/bin/env node
/**
 * Sift scope guard.
 *
 * Keeps the v1.0 branch free of everything that belongs to the unreleased paid
 * part, and enforces the permanent store rules that stay true afterwards.
 *
 * Design notes, because they are the whole point of the script:
 *
 *  - It judges what is PUBLISHED. The file list comes from `git ls-files`, not
 *    from a directory walk, so an untracked scratch file is not a finding and a
 *    tracked one always is.
 *  - It scans the built `main.js` as well when it exists. Source can look clean
 *    while the bundle still carries an imported-but-unused translation block or
 *    a flagged-off branch, and the bundle is what actually ships.
 *  - It looks at history. A public repo publishes its history, so a file that
 *    was committed once and deleted later is still there for anyone to read.
 *  - Every rule carries an allow list. The unavoidable legitimate hits - the
 *    LICENSE file, `"license": "MIT"` in package.json, the word "trial" inside
 *    a generated fixture note - are recorded once with a reason instead of
 *    weakening the pattern. A guard that cries wolf gets switched off; that is
 *    the failure mode this design defends against.
 *
 * Zero dependencies on purpose: a guard that enforces "no runtime dependencies"
 * must not need any itself. Node builtins only.
 *
 * Usage:
 *   node scripts/scope-guard.mjs                 scan the tracked tree
 *   node scripts/scope-guard.mjs --release       plus the pre-submission checks
 *   node scripts/scope-guard.mjs --worktree      also scan untracked, unignored files
 *   node scripts/scope-guard.mjs --json          machine-readable output
 *   node scripts/scope-guard.mjs --rules <file>  use a different rules file
 *   node scripts/scope-guard.mjs --root <dir>    scan another checkout
 *   GUARD_RULES=v11 node scripts/scope-guard.mjs uses guard/forbidden-v11.json
 *
 * Exit code 0 when nothing was found, 1 on any finding or configuration error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const MAX_HITS_PER_RULE_AND_FILE = 5;
const MAX_MATCH_TEXT = 100;
const BINARY_SNIFF_BYTES = 8000;

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

const HELP = `sift scope guard

  node scripts/scope-guard.mjs [options]

  --release       run the pre-submission manifest/version/bundle checks as well
  --worktree      also scan untracked but unignored files (pre-commit view)
  --json          print findings as JSON
  --rules <file>  path to a rules file (default: guard/forbidden.json)
  --root <dir>    repository to scan (default: the repo this script lives in)
  -h, --help      this text
`;

function parseArgs(argv) {
	const options = {
		root: DEFAULT_ROOT,
		rules: null,
		json: false,
		release: false,
		worktree: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--json') options.json = true;
		else if (arg === '--release') options.release = true;
		else if (arg === '--worktree') options.worktree = true;
		else if (arg === '-h' || arg === '--help') options.help = true;
		else if (arg === '--root' || arg === '--rules') {
			const value = argv[i + 1];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			i += 1;
			if (arg === '--root') options.root = resolve(value);
			else options.rules = isAbsolute(value) ? value : resolve(value);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

/* -------------------------------------------------------------------------- */
/* Glob matching (a small subset: **, *, ?, and literal characters)            */
/* -------------------------------------------------------------------------- */

const globCache = new Map();

function globToRegExp(glob) {
	let source = '^';
	for (let i = 0; i < glob.length; i += 1) {
		const char = glob[i];
		if (char === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					source += '(?:[^/]+/)*';
					i += 2;
				} else {
					source += '.*';
					i += 1;
				}
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else if ('\\^$.|+()[]{}'.includes(char)) {
			source += `\\${char}`;
		} else {
			source += char;
		}
	}
	return new RegExp(`${source}$`);
}

function matchesGlob(path, glob) {
	let regex = globCache.get(glob);
	if (regex === undefined) {
		regex = globToRegExp(glob);
		globCache.set(glob, regex);
	}
	return regex.test(path);
}

function matchesAnyGlob(path, globs) {
	for (const glob of globs) {
		if (matchesGlob(path, glob)) return true;
	}
	return false;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

function resolveRulesPath(options) {
	if (options.rules) return options.rules;
	const variant = process.env.GUARD_RULES;
	const name = variant && variant !== 'v1' ? `forbidden-${variant}.json` : 'forbidden.json';
	return join(options.root, 'guard', name);
}

function loadRules(rulesPath) {
	if (!existsSync(rulesPath)) {
		throw new Error(`rules file not found: ${rulesPath}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
	} catch (error) {
		throw new Error(`rules file is not valid JSON: ${rulesPath} (${error.message})`);
	}
	if (!parsed || !Array.isArray(parsed.rules)) {
		throw new Error(`rules file has no "rules" array: ${rulesPath}`);
	}

	const seen = new Set();
	for (const rule of parsed.rules) {
		if (typeof rule.id !== 'string' || !/^[A-Z0-9-]+$/.test(rule.id)) {
			throw new Error(`rule id must be upper-case and dash-separated: ${JSON.stringify(rule.id)}`);
		}
		if (seen.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`);
		seen.add(rule.id);
		if (typeof rule.why !== 'string' || rule.why.length < 20) {
			throw new Error(`rule ${rule.id} needs a "why" that explains the finding to a reader`);
		}
		if (rule.kind !== 'path' && rule.kind !== 'content') {
			throw new Error(`rule ${rule.id} has an unknown kind: ${String(rule.kind)}`);
		}
		if (rule.kind === 'path' && !rule.glob && !rule.pattern) {
			throw new Error(`path rule ${rule.id} needs a glob or a pattern`);
		}
		if (rule.kind === 'content' && typeof rule.pattern !== 'string') {
			throw new Error(`content rule ${rule.id} needs a pattern`);
		}
		if (rule.glob !== undefined) {
			rule.globs = Array.isArray(rule.glob) ? rule.glob : [rule.glob];
		}
		if (rule.flags !== undefined && !/^[gimsu]*$/.test(rule.flags)) {
			throw new Error(`rule ${rule.id} has unsupported regex flags: ${rule.flags}`);
		}
		if (rule.pattern !== undefined) {
			const flags = new Set([...(rule.flags ?? ''), 'g']);
			try {
				rule.regexSource = rule.pattern;
				rule.regexFlags = [...flags].join('');
				new RegExp(rule.pattern, rule.regexFlags);
			} catch (error) {
				throw new Error(`rule ${rule.id} has an invalid pattern: ${error.message}`);
			}
		}
		if (rule.allow !== undefined) {
			if (!Array.isArray(rule.allow)) throw new Error(`rule ${rule.id}: allow must be an array`);
			for (const entry of rule.allow) {
				if (typeof entry.file !== 'string') {
					throw new Error(`rule ${rule.id}: every allow entry needs a "file" glob`);
				}
				if (typeof entry.note !== 'string' || entry.note.length < 10) {
					throw new Error(`rule ${rule.id}: allow entry for ${entry.file} needs a "note" giving the reason`);
				}
			}
		}
	}
	return parsed;
}

/**
 * `match` is compared against the matched text AND against the line it sits on,
 * so an exception can be tied to the sentence that makes it legitimate ("no AI,
 * no license") instead of to a line number that shifts with the next edit.
 */
function isAllowed(rule, path, line, text, context) {
	if (!rule.allow) return false;
	for (const entry of rule.allow) {
		if (!matchesGlob(path, entry.file)) continue;
		if (entry.line !== undefined && entry.line !== line) continue;
		if (entry.match !== undefined) {
			const needle = entry.match.toLowerCase();
			if (!text.toLowerCase().includes(needle) && !context.toLowerCase().includes(needle)) continue;
		}
		return true;
	}
	return false;
}

/* -------------------------------------------------------------------------- */
/* Git                                                                         */
/* -------------------------------------------------------------------------- */

function git(root, args) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 128 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function gitQuiet(root, args) {
	try {
		return git(root, args);
	} catch {
		return '';
	}
}

function splitZ(output) {
	return output.split('\0').filter((entry) => entry.length > 0);
}

function listFiles(root, includeUntracked) {
	const tracked = splitZ(git(root, ['ls-files', '-z']));
	if (!includeUntracked) return { tracked, untracked: [] };
	const untracked = splitZ(gitQuiet(root, ['ls-files', '-z', '--others', '--exclude-standard']));
	return { tracked, untracked };
}

/* -------------------------------------------------------------------------- */
/* File reading                                                                */
/* -------------------------------------------------------------------------- */

function readIfPresent(root, path) {
	const absolute = join(root, path);
	try {
		if (!statSync(absolute).isFile()) return null;
		return readFileSync(absolute);
	} catch {
		return null;
	}
}

function isBinary(buffer) {
	const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < limit; i += 1) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

function lineStarts(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

function lineOf(starts, index) {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= index) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

function trimMatch(text) {
	const single = text.replace(/[\r\n\t]+/g, ' ').trim();
	return single.length > MAX_MATCH_TEXT ? `${single.slice(0, MAX_MATCH_TEXT)}...` : single;
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                    */
/* -------------------------------------------------------------------------- */

function scanPaths(rules, paths) {
	const findings = [];
	for (const rule of rules) {
		if (rule.kind !== 'path') continue;
		const regex = rule.regexSource ? new RegExp(rule.regexSource, rule.regexFlags.replace('g', '')) : null;
		for (const path of paths) {
			const byGlob = rule.globs ? matchesAnyGlob(path, rule.globs) : false;
			const byRegex = regex ? regex.test(path) : false;
			if (!byGlob && !byRegex) continue;
			if (isAllowed(rule, path, 0, path, path)) continue;
			findings.push({ rule: rule.id, why: rule.why, file: path, line: 0, text: path });
		}
	}
	return findings;
}

function scanContent(rules, files, root, skipPaths) {
	const findings = [];
	const contentRules = rules.filter((rule) => rule.kind === 'content');
	let scanned = 0;
	let binary = 0;

	for (const path of files) {
		if (skipPaths.has(path)) continue;
		const applicable = contentRules.filter(
			(rule) => !rule.targets || matchesAnyGlob(path, rule.targets),
		);
		if (applicable.length === 0) continue;

		const buffer = readIfPresent(root, path);
		if (buffer === null) continue;
		if (isBinary(buffer)) {
			binary += 1;
			continue;
		}
		scanned += 1;

		const raw = buffer.toString('utf8');
		const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
		let starts = null;

		for (const rule of applicable) {
			const regex = new RegExp(rule.regexSource, rule.regexFlags);
			let hits = 0;
			let match = regex.exec(text);
			while (match !== null) {
				if (match[0].length === 0) {
					regex.lastIndex += 1;
				} else {
					starts ??= lineStarts(text);
					const line = lineOf(starts, match.index);
					const lineText = text.slice(starts[line - 1], starts[line] ?? text.length);
					const shown = trimMatch(match[0]);
					if (isAllowed(rule, path, line, match[0], lineText)) {
						// Recorded as legitimate in the rule's allow list.
					} else if (hits < MAX_HITS_PER_RULE_AND_FILE) {
						findings.push({ rule: rule.id, why: rule.why, file: path, line, text: shown });
						hits += 1;
					} else {
						hits += 1;
					}
				}
				match = regex.exec(text);
			}
			if (hits > MAX_HITS_PER_RULE_AND_FILE) {
				findings.push({
					rule: rule.id,
					why: rule.why,
					file: path,
					line: 0,
					text: `... and ${hits - MAX_HITS_PER_RULE_AND_FILE} further matches in this file`,
				});
			}
		}
	}

	return { findings, scanned, binary };
}

/* -------------------------------------------------------------------------- */
/* Structural checks                                                           */
/* -------------------------------------------------------------------------- */

function checkHistory(config, root) {
	const findings = [];
	const warnings = [];
	const paths = Array.isArray(config.historyPaths) ? config.historyPaths : [];
	if (paths.length > 0) {
		const log = gitQuiet(root, ['log', '--oneline', '--', ...paths]).trim();
		if (log.length > 0) {
			for (const line of log.split('\n').slice(0, MAX_HITS_PER_RULE_AND_FILE)) {
				findings.push({
					rule: 'HISTORY-PAID-CODE',
					why: 'A public repository publishes its history. Code that was committed once and deleted later is still reachable in the log and in code search, so removing it needs a history rewrite before the repo is made public.',
					file: paths.join(' '),
					line: 0,
					text: line.trim(),
				});
			}
		}
	}
	const advisory = Array.isArray(config.historyAdvisoryPaths) ? config.historyAdvisoryPaths : [];
	if (advisory.length > 0) {
		const log = gitQuiet(root, ['log', '--oneline', '--', ...advisory]).trim();
		if (log.length > 0) {
			warnings.push(
				`history still contains ${advisory.join(', ')} (${log.split('\n').length} commit(s)). Deleting the files from the tree clears the guard, but the blobs stay reachable - plan a history rewrite before the repository is made public.`,
			);
		}
	}
	return { findings, warnings };
}

function checkGitignore(config, root) {
	const required = Array.isArray(config.requiredGitignore) ? config.requiredGitignore : [];
	if (required.length === 0) return [];
	const buffer = readIfPresent(root, '.gitignore');
	const lines = buffer === null
		? []
		: buffer.toString('utf8').split('\n').map((line) => line.trim());
	const findings = [];
	for (const entry of required) {
		if (!lines.includes(entry)) {
			findings.push({
				rule: 'GITIGNORE-MISSING-ENTRY',
				why: 'Belt and braces for the files that must never be committed: an ignore entry is what stops a secrets file, a vault data.json or the build output from being added by a careless `git add -A` in the first place.',
				file: '.gitignore',
				line: 0,
				text: `missing entry: ${entry}`,
			});
		}
	}
	return findings;
}

function checkPackageDependencies(config, root) {
	if (config.packageJsonNoRuntimeDeps !== true) return [];
	const buffer = readIfPresent(root, 'package.json');
	if (buffer === null) return [];
	let manifest;
	try {
		manifest = JSON.parse(buffer.toString('utf8'));
	} catch {
		return [{
			rule: 'DEPS-PACKAGE-JSON',
			why: 'package.json must parse; the build and every release check reads it.',
			file: 'package.json',
			line: 0,
			text: 'package.json is not valid JSON',
		}];
	}
	const names = Object.keys(manifest.dependencies ?? {});
	if (names.length === 0) return [];
	return names.map((name) => ({
		rule: 'DEPS-RUNTIME-DEPENDENCY',
		why: 'The plugin has no runtime dependencies besides the Obsidian API. A dependency appearing here is almost always the first AI or backend package sneaking in, and it also has to be vendored into the bundle.',
		file: 'package.json',
		line: 0,
		text: `runtime dependency: ${name}`,
	}));
}

/* -------------------------------------------------------------------------- */
/* Release checks                                                              */
/* -------------------------------------------------------------------------- */

const EMOJI = /\p{Extended_Pictographic}/u;
const DESCRIPTION_CHARSET = /^[A-Za-z0-9\s.,!?'"-]+$/;

function releaseFinding(id, text, why) {
	return { rule: id, why, file: 'manifest.json', line: 0, text };
}

function checkRelease(config, root) {
	const findings = [];
	const release = config.release ?? {};
	const requiredFiles = Array.isArray(release.requiredFiles) ? release.requiredFiles : [];
	for (const file of requiredFiles) {
		if (readIfPresent(root, file) === null) {
			findings.push({
				rule: 'RELEASE-MISSING-FILE',
				why: 'The submission requires a public repository with a README, a LICENSE and the manifest at its root, and the release must carry main.js, manifest.json and styles.css.',
				file,
				line: 0,
				text: `missing file: ${file}`,
			});
		}
	}

	const manifestBuffer = readIfPresent(root, 'manifest.json');
	if (manifestBuffer === null) {
		findings.push({
			rule: 'RELEASE-MANIFEST',
			why: 'manifest.json must exist at the root of the default branch.',
			file: 'manifest.json',
			line: 0,
			text: 'manifest.json not found',
		});
		return findings;
	}

	let manifest;
	try {
		manifest = JSON.parse(manifestBuffer.toString('utf8'));
	} catch (error) {
		findings.push(releaseFinding('RELEASE-MANIFEST', `manifest.json is not valid JSON: ${error.message}`, 'The manifest must be a single valid JSON object.'));
		return findings;
	}

	const requiredKeys = Array.isArray(release.manifestRequiredKeys) ? release.manifestRequiredKeys : [];
	const optionalKeys = Array.isArray(release.manifestOptionalKeys) ? release.manifestOptionalKeys : [];
	for (const key of requiredKeys) {
		if (!(key in manifest)) {
			findings.push(releaseFinding('RELEASE-MANIFEST-KEY', `missing required key: ${key}`, 'All seven required manifest keys must be present or the directory bot rejects the submission.'));
		}
	}
	const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
	for (const key of Object.keys(manifest)) {
		if (!allowedKeys.has(key)) {
			findings.push(releaseFinding('RELEASE-MANIFEST-KEY', `unknown key: ${key}`, 'Only the seven required keys plus authorUrl and fundingUrl are allowed in the manifest.'));
		}
	}

	const description = typeof manifest.description === 'string' ? manifest.description : '';
	const maxLength = release.descriptionMaxLength ?? 250;
	const minLength = release.descriptionMinLength ?? 10;
	const descWhy = 'The manifest description is the store listing text; the review bot checks its length, punctuation, character set and opening word mechanically.';
	if (description.length < minLength || description.length > maxLength) {
		findings.push(releaseFinding('RELEASE-DESCRIPTION', `description length ${description.length}, must be ${minLength}-${maxLength}`, descWhy));
	}
	if (!description.endsWith('.')) {
		findings.push(releaseFinding('RELEASE-DESCRIPTION', 'description does not end with a period', descWhy));
	}
	if (!/^[A-Z]/.test(description)) {
		findings.push(releaseFinding('RELEASE-DESCRIPTION', 'description does not start with a capital letter', descWhy));
	}
	if (EMOJI.test(description)) {
		findings.push(releaseFinding('RELEASE-DESCRIPTION', 'description contains an emoji', descWhy));
	}
	if (description.length > 0 && !DESCRIPTION_CHARSET.test(description)) {
		findings.push(releaseFinding('RELEASE-DESCRIPTION', 'description contains characters outside letters, digits, whitespace and . , ! ? \' " -', descWhy));
	}
	const verbs = Array.isArray(release.descriptionVerbs) ? release.descriptionVerbs : [];
	const firstWord = description.split(/[^A-Za-z]/, 1)[0].toLowerCase();
	if (verbs.length > 0 && !verbs.includes(firstWord)) {
		findings.push(releaseFinding(
			'RELEASE-DESCRIPTION',
			`description starts with "${firstWord}", which is not one of the accepted action verbs`,
			`${descWhy} It must open with an action statement, not with "This is a plugin" or "Allows you to".`,
		));
	}
	for (const field of ['id', 'name']) {
		const value = typeof manifest[field] === 'string' ? manifest[field].toLowerCase() : '';
		for (const word of ['obsidian', 'plugin']) {
			if (value.includes(word)) {
				findings.push(releaseFinding('RELEASE-MANIFEST-NAME', `${field} contains "${word}"`, 'The id and the name may not contain "obsidian" or "plugin"; that is a hard rejection in the directory bot.'));
			}
		}
	}
	if (description.toLowerCase().includes('obsidian') || description.toLowerCase().includes('plugin')) {
		findings.push(releaseFinding('RELEASE-DESCRIPTION', 'description contains "obsidian" or "plugin"', descWhy));
	}

	const version = typeof manifest.version === 'string' ? manifest.version : '';
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		findings.push(releaseFinding('RELEASE-VERSION', `manifest version "${version}" is not a plain x.y.z semver`, 'The release tag equals the manifest version and must carry no "v" prefix and no pre-release suffix.'));
	}

	const packageBuffer = readIfPresent(root, 'package.json');
	if (packageBuffer !== null) {
		try {
			const pkg = JSON.parse(packageBuffer.toString('utf8'));
			if (pkg.version !== version) {
				findings.push({
					rule: 'RELEASE-VERSION',
					why: 'manifest.json and package.json must agree, otherwise `npm version` tags a release whose manifest says something else.',
					file: 'package.json',
					line: 0,
					text: `package.json version ${String(pkg.version)} does not equal manifest version ${version}`,
				});
			}
		} catch {
			findings.push({
				rule: 'RELEASE-VERSION',
				why: 'package.json must parse for the version comparison to mean anything.',
				file: 'package.json',
				line: 0,
				text: 'package.json is not valid JSON',
			});
		}
	}

	const versionsBuffer = readIfPresent(root, 'versions.json');
	if (versionsBuffer === null) {
		findings.push({
			rule: 'RELEASE-VERSIONS',
			why: 'versions.json maps every published plugin version to the minimum app version it needs; Obsidian reads it to decide which release an older client may install.',
			file: 'versions.json',
			line: 0,
			text: 'versions.json not found',
		});
	} else {
		try {
			const versions = JSON.parse(versionsBuffer.toString('utf8'));
			if (!(version in versions)) {
				findings.push({
					rule: 'RELEASE-VERSIONS',
					why: 'versions.json must contain the version that is about to be released.',
					file: 'versions.json',
					line: 0,
					text: `versions.json has no entry for ${version}`,
				});
			} else if (versions[version] !== manifest.minAppVersion) {
				findings.push({
					rule: 'RELEASE-VERSIONS',
					why: 'The versions.json entry must repeat the manifest minAppVersion for that release.',
					file: 'versions.json',
					line: 0,
					text: `versions.json maps ${version} to ${String(versions[version])}, manifest says ${String(manifest.minAppVersion)}`,
				});
			}
		} catch {
			findings.push({
				rule: 'RELEASE-VERSIONS',
				why: 'versions.json must be valid JSON.',
				file: 'versions.json',
				line: 0,
				text: 'versions.json is not valid JSON',
			});
		}
	}

	const minLines = release.mainJsMinLines ?? 200;
	const bundle = readIfPresent(root, 'main.js');
	if (bundle === null) {
		findings.push({
			rule: 'RELEASE-BUNDLE',
			why: 'The release asset main.js has to exist and stay readable; run the build before the release check.',
			file: 'main.js',
			line: 0,
			text: 'main.js not found - run `npm run build` first',
		});
	} else {
		const lines = bundle.toString('utf8').split('\n').length;
		if (lines <= minLines) {
			findings.push({
				rule: 'RELEASE-BUNDLE',
				why: 'A bundle collapsed onto a handful of lines means it was minified. Obfuscated or unreadable builds are rejected by the developer policies.',
				file: 'main.js',
				line: 0,
				text: `main.js has ${lines} lines, expected more than ${minLines}`,
			});
		}
	}

	return findings;
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

function printFindings(findings, warnings, summary) {
	for (const warning of warnings) {
		process.stdout.write(`warning  ${warning}\n`);
	}
	if (warnings.length > 0 && findings.length > 0) process.stdout.write('\n');

	if (findings.length > 0) {
		const ruleWidth = Math.max(...findings.map((f) => f.rule.length));
		const locations = findings.map((f) => (f.line > 0 ? `${f.file}:${f.line}` : f.file));
		const locationWidth = Math.max(...locations.map((l) => l.length));
		findings.forEach((finding, index) => {
			process.stdout.write(
				`${finding.rule.padEnd(ruleWidth)}  ${locations[index].padEnd(locationWidth)}  ${finding.text}\n`,
			);
		});

		process.stdout.write('\n');
		const seen = new Set();
		for (const finding of findings) {
			if (seen.has(finding.rule)) continue;
			seen.add(finding.rule);
			process.stdout.write(`${finding.rule}: ${finding.why}\n`);
		}
		process.stdout.write('\n');
	}

	process.stdout.write(`${summary}\n`);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`scope-guard: ${error.message}\n\n${HELP}`);
		return 1;
	}
	if (options.help) {
		process.stdout.write(HELP);
		return 0;
	}

	let config;
	let rulesPath;
	try {
		rulesPath = resolveRulesPath(options);
		config = loadRules(rulesPath);
	} catch (error) {
		process.stderr.write(`scope-guard: ${error.message}\n`);
		return 1;
	}

	let files;
	try {
		files = listFiles(options.root, options.worktree);
	} catch (error) {
		process.stderr.write(`scope-guard: cannot read the git file list (${error.message})\n`);
		return 1;
	}

	const scanList = [...files.tracked, ...files.untracked];
	const known = new Set(scanList);
	const extras = [];
	for (const extra of config.extraScanTargets ?? []) {
		if (!known.has(extra) && readIfPresent(options.root, extra) !== null) {
			extras.push(extra);
			known.add(extra);
		}
	}
	const allFiles = [...scanList, ...extras];

	// The rules file matches its own patterns; it is content-exempt but still
	// path-checked like every other file.
	const rulesRelative = relative(options.root, rulesPath).split(sep).join('/');
	const contentSkip = new Set([rulesRelative]);

	const findings = [];
	const warnings = [];

	findings.push(...scanPaths(config.rules, allFiles));
	const content = scanContent(config.rules, allFiles, options.root, contentSkip);
	findings.push(...content.findings);

	const history = checkHistory(config, options.root);
	findings.push(...history.findings);
	warnings.push(...history.warnings);

	findings.push(...checkGitignore(config, options.root));
	findings.push(...checkPackageDependencies(config, options.root));

	if (options.release) {
		findings.push(...checkRelease(config, options.root));
	}

	// Findings without a line (path rules, structural checks, the "further
	// matches" marker) sort after the located ones of the same file.
	const lineKey = (finding) => (finding.line > 0 ? finding.line : Number.MAX_SAFE_INTEGER);
	findings.sort(
		(a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || lineKey(a) - lineKey(b),
	);

	const ruleCount = config.rules.length;
	const fileCount = allFiles.length;
	const extraNote = extras.length > 0 ? `, ${extras.length} build artefact` : '';
	const untrackedNote = files.untracked.length > 0 ? `, ${files.untracked.length} untracked` : '';
	const summary = findings.length === 0
		? `scope-guard: OK - ${ruleCount} rules, ${fileCount} files checked (${files.tracked.length} tracked${untrackedNote}${extraNote}, ${content.binary} binary), 0 findings.`
		: `scope-guard: FAIL - ${findings.length} finding(s) from ${new Set(findings.map((f) => f.rule)).size} rule(s) in ${new Set(findings.map((f) => f.file)).size} file(s); ${ruleCount} rules, ${fileCount} files checked.`;

	if (options.json) {
		process.stdout.write(`${JSON.stringify({
			ok: findings.length === 0,
			summary,
			rulesPath: rulesRelative,
			counts: {
				rules: ruleCount,
				files: fileCount,
				tracked: files.tracked.length,
				untracked: files.untracked.length,
				extras: extras.length,
				binary: content.binary,
				scanned: content.scanned,
			},
			warnings,
			findings,
		}, null, '\t')}\n`);
	} else {
		printFindings(findings, warnings, summary);
	}

	return findings.length === 0 ? 0 : 1;
}

process.exitCode = main();
