/**
 * Fixtures shared by the UI tests.
 *
 * Everything here is plain data plus the smallest stand-ins the modal needs:
 * an indexer that only answers `isReady`, a searcher that returns a canned
 * list, a real Ranker, and a snippet builder the test drives by hand. Node
 * APIs are allowed in test files; none are used here.
 */

import { Ranker } from '../../src/search/Ranker';
import { DEFAULT_SETTINGS, DEFAULT_TUNING } from '../../src/settings';
import type {
	Match,
	QueryAst,
	RankedHit,
	RawHit,
	ResultItem,
	SearchOptions,
	SiftSettings,
	Snippet,
	Span,
} from '../../src/types';
import type { Indexer } from '../../src/index/Indexer';
import type { Searcher } from '../../src/search/Searcher';
import type { Snippets } from '../../src/search/Snippets';

export const TUNING = DEFAULT_TUNING;

export function settings(overrides: Partial<SiftSettings> = {}): SiftSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

export function match(overrides: Partial<Match> = {}): Match {
	return {
		start: 0,
		end: 4,
		field: 'body',
		termIndex: 0,
		wholeWord: true,
		quality: 'exact',
		...overrides,
	};
}

export function snippet(overrides: Partial<Snippet> = {}): Snippet {
	const text = overrides.text ?? 'Der Anschluss für die Kaffeemaschine ist fertig.';
	return {
		text,
		offset: 0,
		marks: [] as readonly Span[],
		focus: { start: 0, end: text.length },
		leadingEllipsis: false,
		trailingEllipsis: false,
		jumpOffset: 0,
		...overrides,
	};
}

export function hit(index: number, overrides: Partial<RankedHit> = {}): RankedHit {
	return {
		fileId: index,
		path: `Projekte/2026/Note ${index}.md`,
		title: `Note ${index}`,
		folder: 'Projekte/2026',
		createdAt: Date.UTC(2026, 2, 14),
		modifiedAt: Date.UTC(2026, 2, 15),
		matches: [match()],
		quality: 'exact',
		score: 100 - index,
		relevance: 100 - index,
		...overrides,
	};
}

export function item(index: number, overrides: Partial<ResultItem> = {}): ResultItem {
	return { ...hit(index), snippets: [], similarTo: [], ...overrides };
}

/** An indexer whose only observable behaviour is readiness. */
export function fakeIndexer(ready = true): { indexer: Indexer; setReady(value: boolean): void } {
	let isReady = ready;
	const stub = {
		isReady: () => isReady,
	};
	return {
		indexer: stub as unknown as Indexer,
		setReady: (value: boolean) => {
			isReady = value;
		},
	};
}

/** A searcher that returns whatever the test last put in `results`. */
export interface FakeSearcher {
	searcher: Searcher;
	results: RawHit[];
	calls: Array<{ ast: QueryAst; options: SearchOptions }>;
}

export function fakeSearcher(results: RawHit[] = []): FakeSearcher {
	const state: FakeSearcher = {
		results,
		calls: [],
		searcher: undefined as unknown as Searcher,
	};
	state.searcher = {
		search: (ast: QueryAst, options: SearchOptions): RawHit[] => {
			state.calls.push({ ast, options });
			return state.results;
		},
	} as unknown as Searcher;
	return state;
}

export function realRanker(): Ranker {
	return new Ranker(DEFAULT_TUNING.weights);
}

/** A snippet builder the test can resolve by hand, so a late result is reproducible. */
export interface FakeSnippets {
	snippets: Snippets;
	/** The hit list of every `build` call, in call order — kept in both modes. */
	log: Array<readonly RankedHit[]>;
	/** The signal of every `build` call, in call order, so cancellation is observable. */
	signals: Array<AbortSignal | undefined>;
	/** Calls still waiting for `flush`, only when the builder was created with `autoResolve: false`. */
	pending: Array<{ hits: readonly RankedHit[]; resolve(items: ResultItem[]): void }>;
	/** Resolves every outstanding call with one snippet per hit. */
	flush(text?: string): void;
}

export function fakeSnippets(autoResolve = true): FakeSnippets {
	const state: FakeSnippets = {
		log: [],
		signals: [],
		pending: [],
		snippets: undefined as unknown as Snippets,
		flush: (text?: string) => {
			const outstanding = state.pending.splice(0, state.pending.length);
			for (const call of outstanding) call.resolve(withSnippets(call.hits, text));
		},
	};
	state.snippets = {
		build: (hits: readonly RankedHit[], _maxPerHit: number, signal?: AbortSignal): Promise<ResultItem[]> => {
			state.log.push(hits);
			state.signals.push(signal);
			if (autoResolve) return Promise.resolve(withSnippets(hits));
			return new Promise<ResultItem[]>((resolve) => {
				state.pending.push({ hits, resolve });
			});
		},
	} as unknown as Snippets;
	return state;
}

function withSnippets(hits: readonly RankedHit[], text?: string): ResultItem[] {
	return hits.map((source) => ({
		...source,
		snippets: [snippet(text === undefined ? {} : { text })],
		similarTo: [],
	}));
}
