# Security policy

## Supported versions

Sift is maintained as a single line. Fixes go into the next release; there are
no long-lived maintenance branches.

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| Older pre-release builds | No |

Always reproduce a problem on the latest release before reporting it.

## What "security" means for this plugin

Sift runs entirely inside Obsidian on your device. It makes no network requests,
talks to no server, and stores its index in the browser's IndexedDB inside
Obsidian's own app storage for that vault. There is no account, no key material
and no remote component, so the interesting attack surface is narrow and mostly
consists of what the plugin does with untrusted *note content*:

- Note text, file names, tags or frontmatter that lead to code execution,
  DOM injection or an escape from Obsidian's sandbox when they are indexed,
  matched, highlighted or shown in an excerpt.
- A crafted note or query that makes Obsidian read, write or delete a file
  outside the vault, or that reaches a Node, Electron or file-system API — the
  plugin uses none of these and must keep using none.
- Anything that causes note content, note titles, paths or search terms to
  leave the device, be written outside the vault, or be logged.
- A stored index that becomes readable by, or is shared with, another vault on
  the same machine.
- A crafted note or query that reliably hangs or crashes Obsidian, rather than
  merely making a search slow.

The following are **not** security issues, and belong in the ordinary bug
tracker instead: wrong or missing search results, a search that is slower than
the numbers in the README, high memory use on a very large vault, layout or
theme glitches, and translation mistakes.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/disasta-G/sift/security) of this repository
and choose **Report a vulnerability**. The report is visible only to you and
the maintainer until a fix is published.

A useful report contains:

- what an attacker can do, and what they need in order to do it;
- the steps to reproduce, with the Sift version, the Obsidian version and the
  platform;
- a minimal example note or query that triggers it — **invented**, not one of
  your own notes.

As with bug reports: do not paste the content of your notes, note titles, folder
names or a real search term. A description of the shape of the input is enough
to reproduce nearly everything, and a security report becomes public once it is
resolved.

## What happens next

This is a single-maintainer project, so please expect a human pace rather than a
service-level agreement:

- an acknowledgement within about a week;
- an assessment — accepted, needs more information, or not a security issue —
  once the report has been reproduced;
- a fix released as soon as it is ready, with the advisory published afterwards.

Credit is given in the advisory unless you ask to stay anonymous. Please give
the fix a chance to ship before disclosing publicly.
