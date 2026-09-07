/**
 * Fixture-vault generator — `npm run fixtures` (runs through tsx).
 *
 * Writes a Markdown vault to `test/fixtures/vault/` (git-ignored) that exercises
 * every trap the search engine has to survive: German compounds for infix
 * matching, umlauts and ß next to their ASCII aliases, a pair of folders sharing
 * a name prefix, `created:` frontmatter in four different notations alongside
 * notes with none at all, and a few files stored in NFD so the offset-map branch
 * is reachable.
 *
 * DETERMINISM IS THE POINT
 * ------------------------
 * Everything comes out of one mulberry32 stream seeded with {@link SEED}, and
 * notes are emitted in order, so a 200-note vault is a byte-for-byte prefix of a
 * 2000-note vault. `Math.random` is never called; neither is `Date.now` for
 * content. File times are stamped with `utimesSync` and repeated verbatim in
 * `_manifest.json`, which is the authority the loader and the date-filter tests
 * read — a filesystem that cannot represent a birth time therefore cannot make a
 * test flaky.
 *
 * Node APIs are fine here: this file is a script and never ships.
 *
 * Usage:
 *   tsx test/fixtures/generate.ts [--count 2000] [--out <dir>] [--seed <n>]
 */

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ========================================================================== */
/* 1. Determinism                                                             */
/* ========================================================================== */

/** Fixed seed. Changing it regenerates every note, so treat it as a fixture version. */
export const SEED = 0x51f7_2026;

/** mulberry32 — 32 bits of state, uniform enough for fixture text, identical on every platform. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The seeded helpers every generator below draws from. */
interface Random {
	next(): number;
	int(minInclusive: number, maxInclusive: number): number;
	chance(probability: number): boolean;
	pick<T>(items: readonly T[]): T;
	sample<T>(items: readonly T[], count: number): T[];
}

function makeRandom(seed: number): Random {
	const next = mulberry32(seed);
	const random: Random = {
		next,
		int: (minInclusive, maxInclusive) => minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1)),
		chance: (probability) => next() < probability,
		pick: (items) => items[Math.floor(next() * items.length)],
		sample: (items, count) => {
			const pool = items.slice();
			const taken: typeof pool = [];
			const wanted = Math.min(count, pool.length);
			for (let i = 0; i < wanted; i++) {
				const at = Math.floor(next() * pool.length);
				taken.push(pool.splice(at, 1)[0]);
			}
			return taken;
		},
	};
	return random;
}

/* ========================================================================== */
/* 2. Vocabulary                                                              */
/* ========================================================================== */

/**
 * The compounds the acceptance tests search for. Every one of these is a real
 * German word whose interesting substring sits in the middle — `maschine`,
 * `pumpe`, `heizung`, `anlage` — which is exactly what a prefix index cannot
 * find and a trigram index can.
 */
export const COMPOUNDS = [
	'Espressomaschine',
	'Kaffeemaschine',
	'Kaffeevollautomat',
	'Wärmepumpe',
	'Fussbodenheizung',
	'Lüftungsanlage',
	'Warmwasseraufbereitung',
	'Gebäudehülle',
	'Küchenplanung',
	'Erdsondenfeld',
] as const;

/** Deliberate misspellings, one edit away from a compound above. The fuzzy tests live off these. */
export const NEAR_MISSES = ['Espresomaschine', 'Kafeemaschine'] as const;

/**
 * Which note carries which misspelling, by ordinal.
 *
 * Placed by index rather than by a dice roll for two reasons: a 200-note vault
 * still gets five of them (a random 1.5% would have produced none, which is how
 * this list came to exist), and the count stays a handful even at 10 000 notes,
 * so an exact match is never crowded out by its own typo.
 */
const NEAR_MISS_NOTES: ReadonlyMap<number, string> = new Map<number, string>([
	[7, 'Espresomaschine'],
	[23, 'Kafeemaschine'],
	[61, 'Espresomaschine'],
	[118, 'Kafeemaschine'],
	[176, 'Espresomaschine'],
	[233, 'Kafeemaschine'],
	[351, 'Espresomaschine'],
	[502, 'Kafeemaschine'],
	[733, 'Espresomaschine'],
	[1150, 'Kafeemaschine'],
	[1777, 'Espresomaschine'],
	[2600, 'Kafeemaschine'],
]);

/** Umlaut and ß words, paired below with their ASCII transliterations. */
export const UMLAUT_WORDS = [
	'Küche',
	'Straße',
	'Grüße',
	'Überprüfung',
	'Maßnahme',
	'Größe',
	'Öffnung',
	'Änderung',
	'Weiß',
] as const;

/** ASCII aliases of the words above, written out by hand in other notes. */
export const ALIAS_WORDS = ['Kueche', 'Strasse', 'Gruesse', 'Ueberpruefung', 'Massnahme', 'Groesse'] as const;

/** Accented French and Italian, for the folding table. */
export const ACCENTED_WORDS = [
	'café',
	'crème brûlée',
	'déjà-vu',
	'naïve',
	'forêt',
	'città',
	'però',
	'caffè macchiato',
	'jalapeño',
	'Curaçao',
] as const;

export const EMOJI = ['☕', '🔥', '📐', '🏠', '✅', '🧊', '⚡', '🌡️'] as const;

/** English counterparts, so a query in either language has something to find. */
export const ENGLISH_TERMS = [
	'espresso machine',
	'heat pump',
	'underfloor heating',
	'ventilation system',
	'domestic hot water',
	'building envelope',
	'kitchen planning',
	'borehole field',
	'coffee grinder',
	'thermal bridge',
] as const;

/** Everything the manifest tracks per note. Order fixed so `markerCounts` keys are stable. */
export const MARKERS: readonly string[] = [
	...COMPOUNDS,
	...NEAR_MISSES,
	...UMLAUT_WORDS,
	...ALIAS_WORDS,
	...ENGLISH_TERMS,
];

const DE_TITLE_STEMS = [
	'Notiz zur',
	'Protokoll',
	'Auslegung',
	'Bericht',
	'Konzept',
	'Offerte',
	'Abnahme',
	'Vorstudie',
	'Checkliste',
	'Rückfragen zur',
] as const;

const DE_TITLE_TOPICS = [
	'Wärmepumpe',
	'Lüftungsanlage',
	'Fussbodenheizung',
	'Gebäudehülle',
	'Küchenplanung',
	'Erdsondenfeld',
	'Warmwasseraufbereitung',
	'Sanierung Altbau',
	'Kaffeemaschine',
	'Espressomaschine',
	'Türbau',
	'Aussenwand',
] as const;

const EN_TITLE_STEMS = [
	'Notes on',
	'Report',
	'Design of',
	'Review',
	'Concept for',
	'Quote',
	'Handover',
	'Study',
	'Checklist',
	'Questions about',
] as const;

const EN_TITLE_TOPICS = [
	'the heat pump',
	'the ventilation system',
	'underfloor heating',
	'the building envelope',
	'kitchen planning',
	'the borehole field',
	'domestic hot water',
	'a retrofit',
	'the espresso machine',
	'the coffee grinder',
	'the roof detail',
	'the facade',
] as const;

const DE_SENTENCES = [
	'Die {marker} wurde am Montag geprüft und läuft seither ohne Beanstandung.',
	'Für die {marker} braucht es eine saubere Abnahme, sonst bleibt die Frage offen.',
	'Wir haben die {marker} mit dem Bauherrn besprochen und die Kosten festgehalten.',
	'Im Untergeschoss steht die {marker}, die Zuleitung liegt bereits.',
	'Die Messung an der {marker} ergab Werte innerhalb der Toleranz.',
	'Ohne die {marker} wäre der Nachweis nach Norm nicht zu führen.',
	'Der Unterhalt der {marker} ist jährlich einzuplanen.',
	'Wir haben die {marker} gegen die Vorgabe geprüft und nichts gefunden.',
	'Die Lieferung der {marker} verzögert sich um zwei Wochen.',
	'Nach dem Umbau ist die {marker} deutlich leiser als vorher.',
] as const;

const EN_SENTENCES = [
	'The {marker} was checked on Monday and has been running without complaints since.',
	'The {marker} needs a proper handover, otherwise the question stays open.',
	'We discussed the {marker} with the client and wrote down the cost.',
	'The {marker} sits in the basement and the supply line is already in place.',
	'Measurements at the {marker} came out within tolerance.',
	'Without the {marker} the calculation cannot be signed off.',
	'Maintenance of the {marker} has to be budgeted every year.',
	'We checked the {marker} against the specification and found nothing.',
	'Delivery of the {marker} is delayed by two weeks.',
	'After the retrofit the {marker} is noticeably quieter than before.',
] as const;

const DE_FILLER = [
	'Der Termin steht noch nicht fest.',
	'Die Unterlagen liegen im Ordner beim Sekretariat.',
	'Bitte vor dem Versand nochmals gegenlesen.',
	'Das Budget ist knapp, aber tragbar.',
	'Die Baustelle ist ab dem 12. wieder zugänglich.',
	'Der Bauherr wünscht eine schriftliche Bestätigung.',
	'Wir warten noch auf die Rückmeldung des Ingenieurs.',
] as const;

const EN_FILLER = [
	'The appointment is not fixed yet.',
	'The documents are in the folder at the front desk.',
	'Please proofread once more before sending.',
	'The budget is tight but workable.',
	'The site is accessible again from the twelfth.',
	'The client would like written confirmation.',
	'We are still waiting for the engineer to reply.',
] as const;

const TAG_POOL = [
	'projekt',
	'heizung',
	'lüftung',
	'küche',
	'protokoll',
	'offerte',
	'abnahme',
	'idee',
	'archiv',
	'norm/sia',
	'norm/en',
] as const;

const STATUS_POOL = ['offen', 'in Arbeit', 'erledigt', 'draft', 'review'] as const;
const AUTHOR_POOL = ['Dario', 'M. Brunner', 'S. Caduff', 'A. Bühler', 'T. Rüegg'] as const;

/* ========================================================================== */
/* 3. Folder layout                                                           */
/* ========================================================================== */

/**
 * `Projekte` and `Projekte2` are the point of this list: a folder filter that
 * matches by string prefix instead of by path segment lets `Projekte2` leak into
 * a `Projekte` search, and that bug is invisible without a name-prefix pair.
 * `Rezepte/Süßes` puts a ß in a folder name so `path:` folding is covered too.
 */
export const FOLDERS: readonly string[] = [
	'',
	'Inbox',
	'Templates',
	'Projekte',
	'Projekte/2024',
	'Projekte/2024/Büro-Umbau',
	'Projekte/2024/Küchenplanung',
	'Projekte/2025/Wärmepumpe',
	'Projekte/2025/Erdsondenfeld',
	'Projekte/2026/Gebäudehülle',
	'Projekte2',
	'Projekte2/2024',
	'Projekte2/2024/Büro-Umbau',
	'Projekte2/Archiv',
	'Notizen',
	'Notizen/Ideen',
	'Notizen/Täglich/2026/03',
	'Notizen/Täglich/2026/04',
	'Meetings/Intern',
	'Meetings/Kunden/Nord',
	'Meetings/Kunden/Süd',
	'Reference/Normen/SIA',
	'Reference/Normen/EN',
	'Rezepte/Kaffee',
	'Rezepte/Süßes',
];

/** Relative weights, same length as {@link FOLDERS}. Root and `Templates` stay thin on purpose. */
const FOLDER_WEIGHTS: readonly number[] = [
	3, 8, 2, 4, 5, 9, 7, 8, 6, 6, 3, 3, 5, 4, 5, 7, 9, 8, 6, 6, 5, 5, 4, 5, 4,
];

function buildFolderPicker(random: Random): () => string {
	const cumulative: number[] = [];
	let total = 0;
	for (const weight of FOLDER_WEIGHTS) {
		total += weight;
		cumulative.push(total);
	}
	return (): string => {
		const roll = random.next() * total;
		for (let i = 0; i < cumulative.length; i++) {
			if (roll < cumulative[i]) return FOLDERS[i];
		}
		return FOLDERS[FOLDERS.length - 1];
	};
}

/* ========================================================================== */
/* 4. Manifest shape                                                          */
/* ========================================================================== */

/** How a note's `created` frontmatter value was written, or `none` when it has no such key. */
export type CreatedFormat = 'iso' | 'date' | 'german' | 'unix' | 'none';

/** One note, as recorded in `_manifest.json`. */
export interface ManifestNote {
	/** Vault-relative path with forward slashes. */
	path: string;
	/** Basename without extension. */
	title: string;
	folder: string;
	language: 'de' | 'en';
	/** The literal `created:` value, or `null` when the note has no such key. */
	created: string | null;
	createdFormat: CreatedFormat;
	/** `created` resolved to epoch milliseconds, or `null`. This is what a date filter must produce. */
	createdMs: number | null;
	/** Whether the note has a frontmatter block at all. */
	hasFrontmatter: boolean;
	/** Stamped file times. Authoritative — the loader prefers these over `fs.stat`. */
	ctime: number;
	mtime: number;
	/** Bytes written to disk. */
	bytes: number;
	/** True when the file was stored decomposed, which is what forces an offset map. */
	nfd: boolean;
	/** Which entries of {@link MARKERS} occur in the note, sorted. */
	markers: string[];
	tags: string[];
}

/** The whole `_manifest.json`. */
export interface VaultManifest {
	seed: number;
	count: number;
	generatedBy: string;
	folders: readonly string[];
	markers: readonly string[];
	/** How many notes contain each marker. The expected hit count for a one-term search. */
	markerCounts: Record<string, number>;
	notes: ManifestNote[];
	totalBytes: number;
	nfdCount: number;
	frontmatterCount: number;
	createdFieldCount: number;
}

/** Filename of the manifest inside the generated vault. Not a Markdown file, so it never gets indexed. */
export const MANIFEST_NAME = '_manifest.json';

/* ========================================================================== */
/* 5. Note assembly                                                           */
/* ========================================================================== */

const DATE_FLOOR = Date.UTC(2019, 0, 1);
const DATE_CEILING = Date.UTC(2026, 5, 30);
const MTIME_CEILING = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

function two(value: number): string {
	return String(value).padStart(2, '0');
}

/** Formats `at` in one of the four notations a real vault mixes. */
function formatCreated(at: number, format: CreatedFormat): string {
	const date = new Date(at);
	const y = date.getUTCFullYear();
	const m = two(date.getUTCMonth() + 1);
	const d = two(date.getUTCDate());
	switch (format) {
		case 'iso':
			return `${y}-${m}-${d}T${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:00Z`;
		case 'date':
			return `${y}-${m}-${d}`;
		case 'german':
			return `${d}.${m}.${y}`;
		case 'unix':
			// Seconds, not milliseconds — a ten-digit number is what people actually store.
			return String(Math.floor(at / 1000));
		case 'none':
			return '';
	}
}

/**
 * The instant a `created` value denotes.
 *
 * `german` and `date` carry no time of day, so they resolve to UTC midnight —
 * the manifest records this resolved value, and a date-filter test compares
 * against it rather than re-deriving it.
 */
function resolveCreated(at: number, format: CreatedFormat): number | null {
	switch (format) {
		case 'iso':
			return at - (at % 60_000);
		case 'date':
		case 'german':
			return at - (at % DAY);
		case 'unix':
			return Math.floor(at / 1000) * 1000;
		case 'none':
			return null;
	}
}

function slug(text: string): string {
	return text
		.normalize('NFC')
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
}

/** Strips the characters Windows and macOS refuse in a filename. Nothing else is touched. */
function safeName(text: string): string {
	return text.replace(/[\\/:*?"<>|]/g, '-').trim();
}

interface NotePlan {
	index: number;
	language: 'de' | 'en';
	folder: string;
	title: string;
	path: string;
	markers: Set<string>;
	tags: string[];
	created: string | null;
	createdFormat: CreatedFormat;
	createdMs: number | null;
	hasFrontmatter: boolean;
	ctime: number;
	mtime: number;
	nfd: boolean;
	/** The misspelling this note is required to contain, from {@link NEAR_MISS_NOTES}. */
	nearMiss: string | null;
}

function sentence(random: Random, language: 'de' | 'en', marker: string): string {
	const template = random.pick(language === 'de' ? DE_SENTENCES : EN_SENTENCES);
	return template.replace('{marker}', marker);
}

function paragraph(random: Random, plan: NotePlan, terms: readonly string[]): string {
	const parts: string[] = [];
	const count = random.int(2, 4);
	for (let i = 0; i < count; i++) {
		if (random.chance(0.65)) {
			const marker = random.pick(terms);
			plan.markers.add(marker);
			parts.push(sentence(random, plan.language, marker));
		} else {
			parts.push(random.pick(plan.language === 'de' ? DE_FILLER : EN_FILLER));
		}
	}
	if (random.chance(0.18)) parts.push(`${random.pick(ACCENTED_WORDS)} ${random.pick(EMOJI)}`);
	return parts.join(' ');
}

function bulletList(random: Random, plan: NotePlan, terms: readonly string[]): string {
	const lines: string[] = [];
	const count = random.int(2, 5);
	for (let i = 0; i < count; i++) {
		const marker = random.pick(terms);
		plan.markers.add(marker);
		const bullet = random.chance(0.25) ? `- [${random.chance(0.5) ? 'x' : ' '}]` : '-';
		lines.push(`${bullet} ${marker} — ${random.pick(plan.language === 'de' ? DE_FILLER : EN_FILLER)}`);
	}
	return lines.join('\n');
}

function numberedList(random: Random, plan: NotePlan, terms: readonly string[]): string {
	const lines: string[] = [];
	const count = random.int(2, 4);
	for (let i = 0; i < count; i++) {
		const marker = random.pick(terms);
		plan.markers.add(marker);
		lines.push(`${i + 1}. ${sentence(random, plan.language, marker)}`);
	}
	return lines.join('\n');
}

function table(random: Random, plan: NotePlan, terms: readonly string[]): string {
	const header = plan.language === 'de' ? '| Position | Wert | Bemerkung |' : '| Item | Value | Note |';
	const lines = [header, '|---|---|---|'];
	const count = random.int(2, 4);
	for (let i = 0; i < count; i++) {
		const marker = random.pick(terms);
		plan.markers.add(marker);
		lines.push(`| ${marker} | ${random.int(1, 400)} ${random.pick(['kW', 'm²', 'l/h', 'Pa'])} | ${random.pick(plan.language === 'de' ? DE_FILLER : EN_FILLER)} |`);
	}
	return lines.join('\n');
}

function codeFence(random: Random, plan: NotePlan): string {
	const language = random.pick(['ts', 'json', 'bash', 'yaml']);
	switch (language) {
		case 'json':
			return ['```json', `{ "leistung": ${random.int(3, 40)}, "typ": "${random.pick(COMPOUNDS)}" }`, '```'].join('\n');
		case 'bash':
			return ['```bash', `# ${plan.language === 'de' ? 'Messwerte holen' : 'fetch readings'}`, 'cat messwerte.csv | head -20', '```'].join('\n');
		case 'yaml':
			return ['```yaml', `typ: ${random.pick(COMPOUNDS)}`, `leistung: ${random.int(3, 40)}`, '```'].join('\n');
		default:
			return ['```ts', `const leistung = ${random.int(3, 40)}; // ${random.pick(COMPOUNDS)}`, '```'].join('\n');
	}
}

function blockQuote(random: Random, plan: NotePlan, terms: readonly string[]): string {
	const marker = random.pick(terms);
	plan.markers.add(marker);
	return `> ${sentence(random, plan.language, marker)}\n> — ${random.pick(AUTHOR_POOL)}`;
}

function links(random: Random, plan: NotePlan): string {
	const target = random.pick(DE_TITLE_TOPICS);
	const parts = [
		`[${plan.language === 'de' ? 'Datenblatt' : 'Datasheet'}](https://beispiel.invalid/${slug(target)}.pdf)`,
		`[[${target}]]`,
	];
	if (random.chance(0.4)) parts.push(`![[plan-${random.int(1, 40)}.png]]`);
	if (random.chance(0.3)) parts.push(`<https://beispiel.invalid/${slug(target)}>`);
	return parts.join(' · ');
}

function heading(random: Random, plan: NotePlan, terms: readonly string[]): string {
	const marker = random.pick(terms);
	plan.markers.add(marker);
	const level = random.chance(0.6) ? '##' : '###';
	return `${level} ${marker}`;
}

/* ========================================================================== */
/* 6. Generation                                                              */
/* ========================================================================== */

export interface GenerateOptions {
	count: number;
	outDir: string;
	seed: number;
}

export interface GenerateResult {
	manifest: VaultManifest;
	outDir: string;
	elapsedMs: number;
}

/**
 * Writes `options.count` notes plus the manifest, and returns what it wrote.
 *
 * The output directory is wiped first, but only when it is empty, absent, or
 * already carries a manifest — a typo in `--out` must not delete somebody's
 * folder.
 */
export function generateVault(options: GenerateOptions): GenerateResult {
	const startedAt = Date.now();
	const random = makeRandom(options.seed);
	const pickFolder = buildFolderPicker(random);

	prepareOutDir(options.outDir);
	for (const folder of FOLDERS) {
		if (folder !== '') mkdirSync(join(options.outDir, folder), { recursive: true });
	}

	const notes: ManifestNote[] = [];
	const usedPaths = new Set<string>();
	let totalBytes = 0;
	let nfdCount = 0;
	let frontmatterCount = 0;
	let createdFieldCount = 0;

	for (let index = 0; index < options.count; index++) {
		const plan = planNote(random, index, pickFolder, usedPaths);
		const raw = renderNote(random, plan);
		const content = plan.nfd ? raw.normalize('NFD') : raw.normalize('NFC');
		const absolute = join(options.outDir, plan.path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content, 'utf8');
		// Seconds, because utimes takes seconds; the manifest keeps the millisecond truth.
		utimesSync(absolute, plan.mtime / 1000, plan.mtime / 1000);

		const bytes = new TextEncoder().encode(content).length;
		totalBytes += bytes;
		if (plan.nfd) nfdCount++;
		if (plan.hasFrontmatter) frontmatterCount++;
		if (plan.createdFormat !== 'none') createdFieldCount++;

		notes.push({
			path: plan.path,
			title: plan.title,
			folder: plan.folder,
			language: plan.language,
			created: plan.created,
			createdFormat: plan.createdFormat,
			createdMs: plan.createdMs,
			hasFrontmatter: plan.hasFrontmatter,
			ctime: plan.ctime,
			mtime: plan.mtime,
			bytes,
			nfd: plan.nfd,
			markers: [...plan.markers].sort(),
			tags: plan.tags,
		});
	}

	const markerCounts: Record<string, number> = {};
	for (const marker of MARKERS) markerCounts[marker] = 0;
	for (const note of notes) {
		for (const marker of note.markers) markerCounts[marker] = (markerCounts[marker] ?? 0) + 1;
	}

	const manifest: VaultManifest = {
		seed: options.seed,
		count: notes.length,
		generatedBy: 'test/fixtures/generate.ts',
		folders: FOLDERS,
		markers: MARKERS,
		markerCounts,
		notes,
		totalBytes,
		nfdCount,
		frontmatterCount,
		createdFieldCount,
	};
	writeFileSync(join(options.outDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, '\t')}\n`, 'utf8');

	return { manifest, outDir: options.outDir, elapsedMs: Date.now() - startedAt };
}

function prepareOutDir(outDir: string): void {
	let existing: string[] | null = null;
	try {
		existing = statSync(outDir).isDirectory() ? readdirSync(outDir) : null;
	} catch {
		existing = null;
	}
	if (existing === null) {
		mkdirSync(outDir, { recursive: true });
		return;
	}
	if (existing.length > 0 && !existing.includes(MANIFEST_NAME)) {
		throw new Error(
			`Refusing to wipe "${outDir}": it is not empty and holds no ${MANIFEST_NAME}, so it is probably not a generated vault.`,
		);
	}
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
}

function planNote(random: Random, index: number, pickFolder: () => string, usedPaths: Set<string>): NotePlan {
	// 55/45 German to English, as the fixture brief asks for.
	const language: 'de' | 'en' = random.chance(0.55) ? 'de' : 'en';
	const folder = pickFolder();
	const stem = random.pick(language === 'de' ? DE_TITLE_STEMS : EN_TITLE_STEMS);
	const topic = random.pick(language === 'de' ? DE_TITLE_TOPICS : EN_TITLE_TOPICS);
	const base = safeName(`${stem} ${topic}`);
	// The ordinal guarantees uniqueness without a collision loop, and a slice of
	// notes uses the lowercase-dashed style real vaults are full of.
	const title = random.chance(0.15) ? `${slug(base)}-${index}` : `${base} ${index}`;
	const path = folder === '' ? `${title}.md` : `${folder}/${title}.md`;
	if (usedPaths.has(path)) throw new Error(`generator bug: duplicate path "${path}"`);
	usedPaths.add(path);

	const createdAt = DATE_FLOOR + Math.floor(random.next() * (DATE_CEILING - DATE_FLOOR));
	// 70% carry a `created` key; of the rest, a fifth still has frontmatter so the
	// ctime fallback is also exercised WITH a frontmatter block present.
	const hasCreatedField = random.chance(0.7);
	const hasFrontmatter = hasCreatedField || random.chance(0.2);
	const createdFormat: CreatedFormat = hasCreatedField
		? random.pick(['iso', 'date', 'german', 'unix'] as const)
		: 'none';
	const created = hasCreatedField ? formatCreated(createdAt, createdFormat) : null;
	const createdMs = hasCreatedField ? resolveCreated(createdAt, createdFormat) : null;

	// When a note carries `created:`, its ctime is deliberately pushed away from
	// that date. Otherwise a parser that silently ignored the frontmatter would
	// still produce the right `createdAt` and no test could tell.
	const ctime = hasCreatedField ? Math.min(createdAt + random.int(10, 200) * DAY, MTIME_CEILING) : createdAt;
	const mtime = Math.min(Math.max(ctime, createdMs ?? ctime) + random.int(0, 400) * DAY, MTIME_CEILING);

	const tags = hasFrontmatter && random.chance(0.7) ? random.sample(TAG_POOL, random.int(1, 3)) : [];

	return {
		index,
		language,
		folder,
		title,
		path,
		markers: new Set<string>(),
		tags,
		created,
		createdFormat,
		createdMs,
		hasFrontmatter,
		ctime,
		mtime,
		// ~2%: enough that the offset-map branch is always hit, few enough that it
		// stays the rounding error the Normalizer's doc comment claims it is.
		nfd: random.chance(0.02),
		nearMiss: NEAR_MISS_NOTES.get(index) ?? null,
	};
}

function renderNote(random: Random, plan: NotePlan): string {
	const terms = termsFor(random, plan);
	const blocks: string[] = [];

	if (plan.hasFrontmatter) blocks.push(renderFrontmatter(random, plan));
	blocks.push(`# ${plan.title}`);

	// Exactly once, in a sentence of its own, so a fuzzy hit's `matchedText` has
	// one unambiguous source.
	if (plan.nearMiss !== null) {
		plan.markers.add(plan.nearMiss);
		blocks.push(sentence(random, plan.language, plan.nearMiss));
	}

	const sectionCount = random.int(3, 8);
	for (let i = 0; i < sectionCount; i++) {
		const roll = random.next();
		if (roll < 0.3) blocks.push(paragraph(random, plan, terms));
		else if (roll < 0.42) blocks.push(heading(random, plan, terms));
		else if (roll < 0.56) blocks.push(bulletList(random, plan, terms));
		else if (roll < 0.66) blocks.push(numberedList(random, plan, terms));
		else if (roll < 0.75) blocks.push(table(random, plan, terms));
		else if (roll < 0.83) blocks.push(codeFence(random, plan));
		else if (roll < 0.9) blocks.push(blockQuote(random, plan, terms));
		else if (roll < 0.96) blocks.push(links(random, plan));
		else blocks.push(paragraph(random, plan, terms));
	}

	// Inline tags, which the Normalizer has to find outside the frontmatter too.
	if (plan.tags.length > 0 && random.chance(0.5)) {
		blocks.push(plan.tags.map((tag) => `#${tag}`).join(' '));
	}

	return `${blocks.join('\n\n')}\n`;
}

/**
 * The vocabulary one note draws from.
 *
 * German notes always get compounds and umlaut words; a slice of them gets the
 * ASCII aliases instead, which is what makes the "query `Kueche` finds `Küche`"
 * round trip testable in both directions. The near-misses go into a handful of
 * notes only — enough for the fuzzy tests, few enough that they never crowd out
 * an exact match.
 */
function termsFor(random: Random, plan: NotePlan): readonly string[] {
	const terms: string[] = [];
	if (plan.language === 'de') {
		terms.push(...random.sample(COMPOUNDS, random.int(2, 4)));
		terms.push(...random.sample(UMLAUT_WORDS, random.int(1, 3)));
		if (random.chance(0.25)) terms.push(...random.sample(ALIAS_WORDS, random.int(1, 2)));
		if (random.chance(0.35)) terms.push(random.pick(ENGLISH_TERMS));
	} else {
		terms.push(...random.sample(ENGLISH_TERMS, random.int(2, 4)));
		if (random.chance(0.3)) terms.push(random.pick(COMPOUNDS));
		if (random.chance(0.2)) terms.push(random.pick(UMLAUT_WORDS));
	}
	// Near-misses are placed by {@link NEAR_MISS_NOTES}, never drawn from here.
	return terms;
}

function renderFrontmatter(random: Random, plan: NotePlan): string {
	const lines = ['---'];
	if (plan.created !== null) {
		// Unix timestamps and German dates go in unquoted, ISO dates sometimes
		// quoted — all three shapes occur in real vaults and all three must parse.
		const quoted = plan.createdFormat === 'iso' && random.chance(0.5);
		lines.push(`created: ${quoted ? `"${plan.created}"` : plan.created}`);
	}
	if (plan.tags.length > 0) lines.push(`tags: [${plan.tags.join(', ')}]`);
	if (random.chance(0.4)) {
		lines.push(`aliases: [${random.sample(DE_TITLE_TOPICS, random.int(1, 2)).join(', ')}]`);
	}
	if (random.chance(0.5)) lines.push(`status: ${random.pick(STATUS_POOL)}`);
	if (random.chance(0.4)) lines.push(`author: ${random.pick(AUTHOR_POOL)}`);
	if (random.chance(0.25)) lines.push(`projekt-nr: ${random.int(1000, 9999)}`);
	lines.push('---');
	return lines.join('\n');
}

/* ========================================================================== */
/* 7. CLI                                                                     */
/* ========================================================================== */

const DEFAULT_OUT = fileURLToPath(new URL('./vault', import.meta.url));

export function parseArgs(argv: readonly string[]): GenerateOptions {
	let count = 2000;
	let outDir = DEFAULT_OUT;
	let seed = SEED;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === '--count' || flag === '-n') {
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--count needs a positive integer, got "${value}"`);
			count = parsed;
			i++;
		} else if (flag === '--out' || flag === '-o') {
			if (value === undefined) throw new Error('--out needs a directory');
			outDir = resolve(value);
			i++;
		} else if (flag === '--seed') {
			const parsed = Number(value);
			if (!Number.isInteger(parsed)) throw new Error(`--seed needs an integer, got "${value}"`);
			seed = parsed;
			i++;
		} else if (flag === '--help' || flag === '-h') {
			throw new Error('usage: tsx test/fixtures/generate.ts [--count 2000] [--out <dir>] [--seed <n>]');
		} else {
			throw new Error(`unknown flag "${flag}"`);
		}
	}
	return { count, outDir, seed };
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const { manifest, outDir, elapsedMs } = generateVault(options);
	const folders = new Set(manifest.notes.map((note) => note.folder));
	console.log(`Fixture vault written to ${outDir}`);
	console.log(
		[
			`${manifest.count} notes`,
			`${formatBytes(manifest.totalBytes)}`,
			`${folders.size} folders`,
			`${manifest.createdFieldCount} with created:`,
			`${manifest.nfdCount} in NFD`,
			`${elapsedMs} ms`,
		].join(' · '),
	);
	const busiest = Object.entries(manifest.markerCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([marker, hits]) => `${marker} ${hits}`)
		.join(', ');
	console.log(`Top markers: ${busiest}`);
}

// Only run when invoked directly, so a test may import the generator.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main();
}
