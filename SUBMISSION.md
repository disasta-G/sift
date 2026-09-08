# Before submission

A maintainer checklist. It is deliberately not part of `README.md`, which is the
page every user of the plugin reads.

## Done

- **The public repository** `disasta-G/sift` exists, with `master` and the
  `1.0.0` tag pushed. The CI workflow triggers on `main` and on `master`, so
  either name works, and it is green.

- **The release is cut.** Tag `1.0.0`, no `v` prefix, matching `manifest.json`.
  `main.js`, `manifest.json` and `styles.css` hang on it as three individual
  assets, not a zip, and all three are byte-identical to what the current
  sources build.

- **README, LICENSE and manifest.json** sit in the repository root, which is
  where the directory looks for them.

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

- **Submit through the directory.** See "How the submission works" below. It
  is a web form on community.obsidian.md, not a pull request.

## The release gate

Run before tagging. Every one of these has to be green.

```
npm run check     # build, release guard, lint, tests
npm run bench     # 10 000 notes; all six budgets must pass
```

`npm run check` builds first on purpose: the release guard reads `main.js`, so
the bundle has to be the one the current sources produce.

## How the submission works

**Not a pull request.** Submitting used to mean opening one against
`obsidianmd/obsidian-releases` and appending an entry to
`community-plugins.json`. That path is gone: pull requests and issues are
switched off on that repository, and an attempt now answers with "An owner of
this repository has disabled the ability to open pull requests." Editing
`community-plugins.json` by hand is no longer part of the process at all — the
directory writes that file itself.

The current route, per
<https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin>:

1. Sign in at <https://community.obsidian.md> with an Obsidian account.
2. Link the GitHub account to that profile. This is how the directory verifies
   that the submitter owns the repository.
3. Add the plugin through the directory interface.
4. Answer the automated review there. Its feedback appears in the directory
   itself, and a correction means a new release with a raised version, not a
   comment on a thread.

What it reads: the `manifest.json` at the **HEAD of the default branch**, so
that file has to be correct and pushed before submitting — not merely correct
inside the release. The `id` has to be unique across the directory and must not
contain "obsidian". `sift` satisfies both.

## After submission

The directory reviews the whole repository, not the release, and the review
takes weeks. `npm run guard` is what keeps anything belonging to a later
release out of this branch in the meantime; it runs in `npm run check` and in
CI, and it reads the working tree, the built bundle and the git history.
