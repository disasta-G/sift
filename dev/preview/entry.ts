/**
 * Browser preview harness for the Sift overlay.
 *
 * Runs the REAL engine (Indexer, Searcher, Ranker, Snippets) and the REAL
 * SearchModal against an in-memory vault, inside a plain Chrome page, so the
 * rendered overlay can be compared against docs/mockup-dark.html pixel for
 * pixel. `obsidian` is aliased to test/stubs/obsidian.ts at bundle time.
 *
 * Lives in the scratchpad, not in the repo.
 */

import { installDomHelpers } from '../../test/stubs/obsidian';
import { createFakeApp } from '../../test/helpers/fakeVault';
import { Store } from '../../src/index/Store';
import { Indexer } from '../../src/index/Indexer';
import { Searcher } from '../../src/search/Searcher';
import { Ranker } from '../../src/search/Ranker';
import { Snippets } from '../../src/search/Snippets';
import { SearchModal } from '../../src/ui/SearchModal';
import { DEFAULT_SETTINGS, DEFAULT_TUNING } from '../../src/settings';
import { setLanguage } from '../../src/i18n/index';
import type { App } from 'obsidian';

installDomHelpers();

const D = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 9, 0, 0).getTime();

const VAULT: Record<string, { content: string; ctime: number; mtime: number }> = {
	'Projekte/2026/Büro-Umbau/Küchenplanung.md': {
		ctime: D(2026, 3, 14),
		mtime: D(2026, 5, 2),
		content: `---
created: 2026-03-14
tags: [kueche, elektro]
---

# Küchenplanung Büro-Umbau

Elektroanschlüsse in der Küchenzeile nach NIN. Der Anschluss für die Kaffeemaschine wird als
separate Gruppe 16 A ausgeführt, damit ein Vollautomat betrieben werden kann. Geschirrspüler auf
eigener Gruppe, Boiler über die bestehende Zuleitung.

## Sanitär

Wasseranschluss für Kaffeemaschine mit Absperrventil und Rückflussverhinderer gemäss SVGW W3,
Position hinter dem Hochschrank. Ablauf Geschirrspüler in den bestehenden Siphon.
`,
	},
	'Projekte/2026/Büro-Umbau/Beschaffung/Bestellungen Pausenraum.md': {
		ctime: D(2026, 2, 2),
		mtime: D(2026, 2, 20),
		content: `---
created: 2026-02-02
---

# Bestellungen Pausenraum

Offerte Möbel eingetroffen. Offerte Kaffeemaschinen von zwei Lieferanten eingeholt, Entscheid bis
Ende Februar. Kühlschrank wird vom Bauherrn gestellt.
`,
	},
	'Projekte/2026/Büro-Umbau/Protokolle/Besprechung Bauherr 12.05.md': {
		ctime: D(2026, 5, 12),
		mtime: D(2026, 5, 12),
		content: `---
created: 2026-05-12
---

# Besprechung Bauherr 12.05.

Wärmeabgabe im Pausenraum: Kühlschrank 120 W, Kaffeemaschine 1.4 kW im Betrieb, Geschirrspüler 2 kW.
Die Lüftungsanlage wird entsprechend nachgerechnet.
`,
	},
	'Projekte/2026/Büro-Umbau/Ausstattung Pausenraum.md': {
		ctime: D(2026, 1, 21),
		mtime: D(2026, 4, 3),
		content: `---
created: 2026-01-21
---

# Ausstattung Pausenraum

Wunschliste Mitarbeitende: eine Espressomaschine mit Festwasseranschluss statt Kapselgerät,
Wasserspender, Mikrowelle. Eine zweite Kaffeemaschine im Sitzungszimmer wurde gestrichen.
`,
	},
	'Projekte/2026/Heizung/Wärmepumpe Auslegung.md': {
		ctime: D(2026, 4, 8),
		mtime: D(2026, 6, 1),
		content: `---
created: 08.04.2026
tags: [heizung, waermepumpe]
---

# Wärmepumpe Auslegung

Heizlast nach SIA 384/2, Norm-Aussentemperatur -12 °C. Die Fussbodenheizung läuft mit 35/28 °C.
Die Kaffeemaschine in der Küche zählt nicht zur internen Wärmelast.
`,
	},
	'Notizen/Küche zuhause.md': {
		ctime: D(2025, 11, 3),
		mtime: D(2025, 11, 3),
		content: `# Küche zuhause

Die alte Kaffeemaschine entkalken. Ersatzteil für die Espressomaschine bestellt.
`,
	},
	'Notizen/Inbox/Ideen.md': {
		ctime: D(2026, 6, 20),
		mtime: D(2026, 6, 20),
		content: `# Ideen

Kaffeevollautomat für das Büro evaluieren. Lüftungsanlage im Sitzungszimmer prüfen.
`,
	},
};

async function main(): Promise<void> {
	setLanguage('de', 'de');

	const app = createFakeApp(VAULT) as unknown as App;
	const settings = { ...DEFAULT_SETTINGS, snippetCount: 2 };
	const tuning = DEFAULT_TUNING;

	const store = new Store('preview-vault');
	await store.open().catch(() => undefined);

	const indexer = new Indexer(app, store, settings, tuning);
	await indexer.start();

	const deps = {
		indexer,
		searcher: new Searcher(indexer, tuning),
		ranker: new Ranker(tuning.weights),
		snippets: new Snippets(app, indexer, tuning),
		settings,
		tuning,
	};

	const modal = new SearchModal(app, deps, 'Kaffeemaschine');
	modal.open();
	await modal.runSearch(true);

	// Preselect the first card so the screenshot shows the selected state.
	modal.moveSelection(0);

	const status = document.getElementById('sift-preview-status');
	if (status) status.textContent = `index ready · ${indexer.fileCount()} notes`;

	// Handles for the browser harness, so a session can drive the modal the way
	// a keyboard would and read the engine's answers back.
	Object.assign(w.siftPreview ?? {}, { modal, deps, app, indexer });
	w.siftPreview = { run: main, modal, deps, app, indexer };
}

interface PreviewHandles {
	run: () => Promise<void>;
	modal?: SearchModal;
	deps?: unknown;
	app?: App;
	indexer?: Indexer;
}

const w = window as unknown as { siftPreview?: PreviewHandles };
w.siftPreview = { run: main };

void main();
