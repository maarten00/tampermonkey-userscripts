# Tampermonkey userscripts

Small userscripts that smooth over day-to-day annoyances in the tools I use.
Each one is a single self-contained file: no build step, no dependencies.

| Script | What it does |
|--------|--------------|
| [GitHub: mark test files as viewed](github-mark-test-files-viewed.user.js) | Adds a button to a pull request diff that ticks every test file as *viewed*, leaving only the real code to review. |

## Install

**1. Install Tampermonkey**

[Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) ·
[Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/) ·
[Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

**2. On Chrome and Edge, allow user scripts**

Chrome's extension platform blocks userscripts until you explicitly allow them.
Until you do, Tampermonkey is installed but **nothing happens** — no error, no
button, just silence.

Open `chrome://extensions`, find Tampermonkey, and either flip **Allow user
scripts** on its details page, or — on older Chrome versions without that
toggle — turn on **Developer mode** at the top right.

Firefox needs no equivalent step.

**3. Install the script**

Open the script's **Raw** view from the table above. Tampermonkey recognises the
`.user.js` file and offers to install it.

Either way — from here or from Greasy Fork — Tampermonkey keeps it up to date on
its own.

## GitHub: mark test files as viewed

A large pull request is mostly tests. This adds a button next to GitHub's
`0 / 48 viewed` counter that ticks the *Viewed* checkbox on every test file, so
the diff collapses down to the code you actually want to read.

It uses GitHub's own per-file *Viewed* toggle — the same one you would click by
hand. Nothing is hidden, deleted or altered, and the state is private to you.

The panel reflects what it can do:

| | |
|---|---|
| `Mark 19 tests viewed` | there is work to do |
| `✓ All 19 tests viewed` | nothing to do, so there is no button |
| `loading… 8/48` | GitHub is still streaming the diff in |
| `no test files` | nothing in this pull request matches |

You can press the button while the diff is still loading. GitHub renders large
diffs in batches over several seconds, so the script waits for files that have
not appeared yet instead of stopping at whatever is on screen. **Undo** reverses
the files that run touched, and nothing else.

### Settings

The chevron next to the button opens a small menu. Settings are stored by the
user script manager, so they survive a reload and a site-data wipe, and they
apply on every repository.

- **Also skip factories and seeders** — treats `Database/Factories`, `Seeders`
  and `Seeds` as tests too. Off by default, since those are test *support* and
  worth a look more often than a test is.

The chevron sits outside the main button on purpose: the button disappears once
everything is viewed, and the settings have to stay reachable.

### Which files count as tests

The `TEST_PATTERNS` list at the top of the script decides. It ships with the
common PHP and JavaScript conventions:

- `tests/`, `spec/`, `e2e/`, `__tests__/` and similar directories
- `*Test.php`, `*Cest.php`, `*.test.js`, `*.spec.ts`
- `phpunit.xml`, `codeception.yml`, `*.suite.yml`
- `cypress/`

Edit that list to match your own layout. There is a commented-out pattern for
skipping factories and seeders too.

## Updating

Scripts declare `@updateURL`, so Tampermonkey checks for new versions by itself.
Installed from Greasy Fork, it updates from Greasy Fork instead — Greasy Fork
strips those keys from its copy on purpose, so a script only ever updates from
wherever it was installed.

Either way the rule is the same: **bump `@version` whenever the file changes.**
Tampermonkey ignores an update that does not claim to be newer, so a fix shipped
without a bump reaches nobody.

Expect to need that occasionally. These scripts read the markup of the sites
they run on, and that markup changes without warning.

## Adding a script

1. Drop `<name>.user.js` in the repository root.
2. Copy a metadata block from an existing script and change the details. Point
   `@updateURL` and `@downloadURL` at the new filename — renaming a script
   without updating them silently cuts its users off from updates.
3. Add a row to the table above.

`@namespace` is worth choosing once and leaving alone: script managers combine
it with the name to recognise an installed script, and Greasy Fork warns when it
changes.

## Licence

[MIT](LICENSE).
