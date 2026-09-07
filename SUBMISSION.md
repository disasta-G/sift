# Before submission

A maintainer checklist. It is deliberately not part of README.md, which is the
page every user of the plugin reads.

Everything above describes the plugin as it stands. This last section is a maintainer checklist and not part of the description: it lists what still has to happen before Sift is offered to the community directory.

- **Record the screenshots.** None exist in the repository yet. Five images go under `docs/`, and a Screenshots section linking them belongs directly under the introduction:
  - `docs/screenshot-overlay-dark.png` — the search overlay in a dark theme, query typed, several result cards with highlighted excerpts visible.
  - `docs/screenshot-overlay-light.png` — the same overlay in a light theme, to show that no colour is hardcoded.
  - `docs/screenshot-filters.png` — the filter bar expanded: folder picker, "Include subfolders", the created-date range and the sort dropdown.
  - `docs/screenshot-settings.png` — the settings tab, including the index statistics line and the "Rebuild index" button.
  - `docs/screenshot-indexing.png` — the empty state shown while the index is still being built.
