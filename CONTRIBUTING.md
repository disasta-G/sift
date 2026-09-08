# Contributing to Sift

Thanks for taking an interest. Sift is a small, single-maintainer plugin, and
this file says what a contribution needs to look like so that it can be reviewed
quickly rather than bounce.

## Before you write code

- **Bugs**: open an issue with the bug report form first. It deliberately does
  not ask for the content of your notes — see the note on privacy below.
- **Features**: open an issue and describe the problem before writing the patch.
  Sift is intentionally narrow: local search over the Markdown notes of the
  vault, with operators, path and date filters, ranking and excerpts. A pull
  request that widens that scope is likely to be declined however good the code
  is, and it is kinder to find that out before you spend an evening on it.
- **Suspected security problems**: do not open an issue. Follow
  [SECURITY.md](SECURITY.md).

Small, obvious fixes — a typo, a wrong translation, a broken link — need no
issue. Just send the pull request.

## Privacy, in issues and pull requests

The issue tracker is public and Sift's whole promise is that your notes stay on
your device. So: **no content, titles or paths from your own notes** in an
issue, a pull request, a test fixture or a screenshot. Describe the shape of the
input instead ("a two-word query with an umlaut in the second word"), and invent
examples where you need them — `foo`, `bar`, `Foomaschine`. If you attach
console output, strip note titles and paths from it first.

## Setting up

```
npm install                            # install the build toolchain
npm run fixtures -- --count 2000       # generate the test vault, once after cloning
npm run dev                            # watch build into main.js
npm run build                          # type-check and production build
npm test                               # unit tests (Vitest)
npm run bench                          # benchmark index build and search against that vault
npm run guard                          # scan the source for store-policy violations
npm run check                          # guard + typecheck + lint + test
```

**Generate the test vault before your first `npm test`.** It is git-ignored, so
a fresh clone has none, and the searcher, fuzzy and filter suites read it.
`test/fixture-vault.test.ts` is the gate in front of them: it fails first and
prints the command above. 2 000 notes is what the suite is written for; the
generator is seeded, so a larger vault is a superset and works too.

To try a build inside Obsidian, copy `main.js`, `manifest.json` and `styles.css`
into `<a scratch vault>/.obsidian/plugins/sift/` and enable the plugin. Use a
scratch vault, not the one you actually work in.

## House rules

These are checked mechanically wherever that is possible, and by review where it
is not.

- **`npm run check` must pass before every commit.** It is the same gate the
  project uses for a release: the policy scan, the TypeScript type check, ESLint
  (including `eslint-plugin-obsidianmd`) and the full test suite. A commit is
  expected to build and to leave the test suite green.
- **English everywhere in the repository** — code, comments, identifiers, commit
  messages, issues and pull requests — even though the plugin ships a German
  interface.
- **Every user-visible string goes through `src/i18n/`** and is written in
  sentence case ("Include subfolders", not "Include Subfolders"). `en.json` and
  `de.json` must carry exactly the same key set, and no interface file may write
  text of its own; `test/i18n.test.ts` enforces the first and
  `test/i18n-callsites.test.ts` the second.
- **DOM is built with `createEl()`, `createDiv()` and `setText()`.**
  `innerHTML`, `outerHTML` and `insertAdjacentHTML` are not used anywhere.
- **No hardcoded colours.** Every surface, border and highlight comes from an
  Obsidian CSS variable, so the plugin follows whatever theme is active. Every
  own CSS class starts with `sift-`.
- **No network requests, no telemetry, no logging of search terms** — not even
  to the local developer console. This is the plugin's central claim and
  `npm run guard` fails on it.
- **No Node or Electron APIs.** `isDesktopOnly` is `false` and stays that way;
  persistence goes through IndexedDB or `this.app.vault.adapter`, and the vault
  is reached through `this.app`, never through the global `app`.
- **No runtime dependencies** beyond the Obsidian API, and new build
  dependencies only with a reason in the pull request.
- **No default hotkeys.** Sift registers none, so it cannot collide with your
  bindings or another plugin's.
- **Changes to the parser, the searcher or the ranker need a unit test.** A test
  that fails before your fix and passes after it is the most convincing part of
  the patch.
- **`main.js` is a build artefact**, is git-ignored, and ships only as a release
  asset. Never commit it.
- **`test/fixtures/vault` is generated, never edited by hand.** If a case is
  missing, extend the generator in `test/fixtures/`.

## Commits and pull requests

- One topic per pull request, and a branch off `master`.
- Commit per module, in the imperative mood, with the reason in the body if the
  change is not self-evident (`fix: keep the umlaut alias out of phrase
  matches`). Every commit should build and pass the tests on its own.
- Fill in the pull request template: what changes, why, and how you checked it.
- Say in the description if the change touches performance. The targets are a
  cold index of 10 000 notes in under 5 s, a search in under 100 ms and an index
  below 100 MB; `npm run bench` prints all three.
- Review is a conversation, not a verdict. Expect questions, especially about
  scope and about strings.

## Licence

By contributing you agree that your contribution is published under the MIT
licence of this project — see [LICENSE](LICENSE).
