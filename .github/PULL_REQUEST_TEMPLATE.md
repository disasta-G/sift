<!--
Thanks for the patch. Please read CONTRIBUTING.md if you have not yet.

Do not paste content, titles or paths from your own notes anywhere in this pull
request, including screenshots. Invent examples instead: foo, bar, Foomaschine.
-->

## What this changes

<!-- One or two sentences. What behaviour is different after this is merged? -->

## Why

<!-- The problem being solved. Link the issue: "Fixes #123". For anything beyond
     a typo or a translation fix, there should be an issue that was discussed
     first. -->

## How it was checked

<!-- The commands you ran and what you tried by hand in Obsidian. If the change
     touches performance, paste the relevant numbers from `npm run bench`. -->

## Checklist

- [ ] `npm run check` passes (guard, type check, lint, tests).
- [ ] Changes to the parser, the searcher or the ranker come with a unit test
      that fails without this patch.
- [ ] Every new user-visible string goes through `src/i18n/`, in sentence case,
      with the same key in `en.json` and `de.json`.
- [ ] No hardcoded colours; every own CSS class starts with `sift-`.
- [ ] No `innerHTML`, no Node or Electron API, no network request, no logging of
      search terms or note content.
- [ ] No new runtime dependency (or the description explains the exception).
- [ ] `main.js` is not committed.
- [ ] Nothing in this pull request contains content, titles or paths from a real
      vault.
