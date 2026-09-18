/**
 * Prints the body of a GitHub release: the section CHANGELOG.md holds for that
 * version, followed by the compare link against the previous tag.
 *
 * The release workflow used to publish `--generate-notes`, which on a repository
 * that squashes its work into one commit per module produces a list of commit
 * subjects and nothing a reader of the plugin can act on. The changelog already
 * says what changed and why, in the words meant for a user, so the release page
 * should say the same thing rather than a second, worse version of it.
 *
 * Deliberately dumb: the headings are found with a regex, there is no Markdown
 * parser and no dependency. A missing section exits non-zero, which is what
 * stops a release before it builds anything — publishing a version whose
 * changelog entry was forgotten is the failure this guards against.
 *
 * Usage: node scripts/release-notes.mjs <version> [previous-tag] [owner/repo]
 */

import { readFileSync } from 'node:fs';

/** A version heading: `## [1.5.0] — 2026-09-18`, or the same without a date. */
const HEADING = /^## +\[([^\]]+)\]/;

/** A link definition at the foot of the file: `[1.5.0]: https://…`. */
const LINK_DEFINITION = /^\[[^\]]+\]: +\S/;

/**
 * The lines under `version`'s heading, up to the next heading.
 *
 * Link definitions are dropped: they sit at the very bottom of the file and
 * would otherwise be swept into the oldest section. Blank lines at either end go
 * too, so the body starts on its first real line whatever the file's spacing is.
 */
export function sectionFor(changelog, version) {
	const lines = changelog.split('\n');
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const heading = HEADING.exec(lines[i]);
		if (heading === null) continue;
		if (start < 0) {
			if (heading[1] === version) start = i + 1;
			continue;
		}
		// The next version heading ends the section.
		return trim(lines.slice(start, i));
	}
	return start < 0 ? null : trim(lines.slice(start));
}

function trim(lines) {
	const kept = lines.filter((line) => !LINK_DEFINITION.test(line));
	let first = 0;
	let last = kept.length;
	while (first < last && kept[first].trim() === '') first++;
	while (last > first && kept[last - 1].trim() === '') last--;
	return kept.slice(first, last).join('\n');
}

function main() {
	const [version, previousTag, repository] = process.argv.slice(2);
	if (version === undefined || version.length === 0) {
		process.stderr.write('release-notes: no version given.\n');
		return 1;
	}

	const changelog = readFileSync('CHANGELOG.md', 'utf8');
	const section = sectionFor(changelog, version);
	if (section === null) {
		process.stderr.write(`release-notes: CHANGELOG.md has no section for ${version}.\n`);
		return 1;
	}
	if (section.length === 0) {
		process.stderr.write(`release-notes: the section for ${version} in CHANGELOG.md is empty.\n`);
		return 1;
	}

	const parts = [section];
	// The link is what `--generate-notes` contributed that was worth keeping. It
	// is left out for the very first release, which has nothing to compare to.
	if (previousTag !== undefined && previousTag.length > 0 && repository !== undefined && repository.length > 0) {
		parts.push(`**Full Changelog**: https://github.com/${repository}/compare/${previousTag}...${version}`);
	}
	process.stdout.write(`${parts.join('\n\n')}\n`);
	return 0;
}

process.exitCode = main();
