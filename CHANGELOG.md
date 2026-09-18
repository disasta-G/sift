# Changelog

All notable changes to Sift are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] — 2026-09-18

### Added

- **Canvases and bases are searched.** Sift read `.md` and nothing else, so the
  canvases and base files in a vault were invisible to it. A `.canvas` is now
  searched by the text on its cards, its group and edge labels, and the notes it
  embeds; a `.base` by its view names and filters. Both are on by default and
  have a switch of their own in the settings.

- **A "Notes only" switch** in the filter bar hides the other kinds from a
  single search without touching the index. Like "Open todos", the off position
  is the absence of the filter and not its opposite.

### Changed

- The stored index is rebuilt once after this update. Records carry the file
  kind now, and the settings fingerprint counts it — without that, switching a
  kind off would leave its records in the database.

## [1.5.0] — 2026-09-18

### Changed

- **An exclusion matches whole words now.** `-altbau` used to be a substring
  test and removed a note that only said `Altbauwohnungen` — letters the search
  never asked to be rid of. A bare exclusion takes out the standalone word, and
  a `*` says where more is meant: `-altbau*` opens the end, `-*bau` the
  beginning, `-*bau*` both, which is the behaviour up to 1.4.1 spelled out. In a
  phrase the star sits inside the quotes, `-"alter bau*"`, and behind a field
  prefix it follows it, `-path:*archiv`. A star in the middle of a term stays
  text, so `-a*b` still looks for `a*b`.

  This changes existing queries: a saved `-altbau` returns more notes than it
  did before. Write `-altbau*` to keep the old result.

- Positive terms are untouched. Substring matching is what the plugin is for, so
  `altbau` still finds `Altbauwohnungen` and a star on a positive term is
  consumed without effect.

## [1.4.1] — 2026-09-14

### Fixed

- The cursor no longer flickers at the edge of the folder chip.
- The same flicker on the sort chip and on the remove buttons is gone.

## [1.4.0] — 2026-09-09

### Added

- A filter for notes with open todos. `- [ ]`, `- [/]` and `- [?]` count as
  open; a ticked or cancelled box does not. It works with no search term at all.

### Fixed

- The selected range in the calendar is visible again.
- "This note" stays usable on a phone.

## [1.3.0] — 2026-09-08

### Added

- Hotkeys are recorded by pressing the combination rather than typed out.
- Results can be marked as kept, and a kept hit survives the next run.
- "This note" confines a search to the note that was open when the overlay was
  called — the whole query language, filters included, on a single file.

### Changed

- The filter bar was tidied up.

## [1.2.1] — 2026-09-08

### Fixed

- A hotkey can be typed one character at a time again.

## [1.2.0] — 2026-09-08

### Added

- The two curation hotkeys can be changed in the settings.

### Changed

- The filter chips keep a fixed width, so the bar no longer jumps while typing.

## [1.1.1] — 2026-09-08

### Fixed

- The overlay has a close button that a thumb can reach on a phone.

## [1.1.0] — 2026-09-08

### Added

- A property filter: by the presence of a property, or by its value. The chip
  completes both from the properties the vault actually uses.
- A quick pick for today in the date filter.

### Changed

- The filter bar folds on a narrow screen.

## [1.0.1] — 2026-09-08

### Added

- The settings are declared so that Obsidian's own settings search finds them.

### Fixed

- The findings of the community directory review.

## [1.0.0] — 2026-09-08

The first release. Local full-text and substring search for an Obsidian vault:

- Substring matching over a trigram index — `maschine` finds `Espressomaschine`.
- Umlaut and ß tolerance in both directions, marked as an alias match.
- Operators: AND by space, `"quoted phrase"`, `-exclusion`, `a OR b`.
- Field prefixes `path:`, `tag:`, `title:`.
- Folder, created and modified filters, and a search by filter alone.
- Ranked results with highlighted excerpts and a keyboard-first overlay.
- Optional typo tolerance behind the "Similar" toggle.
- English and German interface.

Everything runs on the device; the plugin makes no network requests.

[Unreleased]: https://github.com/disasta-G/sift/compare/2.0.0...HEAD
[2.0.0]: https://github.com/disasta-G/sift/compare/1.5.0...2.0.0
[1.5.0]: https://github.com/disasta-G/sift/compare/1.4.1...1.5.0
[1.4.1]: https://github.com/disasta-G/sift/compare/1.4.0...1.4.1
[1.4.0]: https://github.com/disasta-G/sift/compare/1.3.0...1.4.0
[1.3.0]: https://github.com/disasta-G/sift/compare/1.2.1...1.3.0
[1.2.1]: https://github.com/disasta-G/sift/compare/1.2.0...1.2.1
[1.2.0]: https://github.com/disasta-G/sift/compare/1.1.1...1.2.0
[1.1.1]: https://github.com/disasta-G/sift/compare/1.1.0...1.1.1
[1.1.0]: https://github.com/disasta-G/sift/compare/1.0.1...1.1.0
[1.0.1]: https://github.com/disasta-G/sift/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/disasta-G/sift/releases/tag/1.0.0
