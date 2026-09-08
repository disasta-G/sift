# Before submission

A maintainer checklist. It is deliberately not part of `README.md`, which is the
page every user of the plugin reads.

## Done

- **The public repository** `disasta-G/sift` exists, with `master` and the
  `1.0.0` tag pushed. The CI workflow triggers on `main` and on `master`, so
  either name works.

## What still has to happen

- **Record the remaining screenshots.** Three are in the repository and linked
  from the Screenshots section of `README.md`, directly under the introduction:
  the overlay in a dark and in a light theme, and the settings tab. Two more
  were planned. They are optional — the directory asks for at least one — so
  either record them and add them to the same section, or drop them from this
  list:
  - `docs/screenshot-filters.png` — the filter bar with the created-date
    popover open: quick picks, calendar, folder picker and sort.
  - `docs/screenshot-indexing.png` — the empty state shown while the index is
    still being built.

- **Cut the release.** Tag `1.0.0`, no `v` prefix — the directory matches the
  tag against `manifest.json` exactly. Attach `main.js`, `manifest.json` and
  `styles.css` as three individual assets, never a zip.

- **Open the submission pull request** against `obsidianmd/obsidian-releases`.
  It must change `community-plugins.json` and nothing else, and it must come
  from the account that owns the plugin repository.

## The release gate

Run before tagging. Every one of these has to be green.

```
npm run check     # build, release guard, lint, tests
npm run bench     # 10 000 notes; all six budgets must pass
```

`npm run check` builds first on purpose: the release guard reads `main.js`, so
the bundle has to be the one the current sources produce.

## The directory entry

Append this as the **last** element of `community-plugins.json`. The five
fields are the only ones allowed, and `id`, `name` and `description` have to
match `manifest.json` character for character.

Field order and indentation follow the file, not this project's own style: all
7 406 entries in it are ordered `id, name, author, description, repo` and are
indented with two spaces. A tab-indented entry in a different order still
parses, but it shows up as a reformatting of someone else's file.

```json
  {
    "id": "sift",
    "name": "Sift",
    "author": "Dario Giovanoli",
    "description": "Search your notes with substring matching, operators, path and date filters, and ranked results in a large overlay.",
    "repo": "disasta-G/sift"
  }
```

Do not append " - This plugin has not been manually reviewed by Obsidian
staff." to the description. Many entries carry that sentence; it is added by
the directory, not by the person submitting.

## After submission

The directory reviews the whole repository, not the release, and the review
takes weeks. `npm run guard` is what keeps anything belonging to a later
release out of this branch in the meantime; it runs in `npm run check` and in
CI, and it reads the working tree, the built bundle and the git history.
