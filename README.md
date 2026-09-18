# Tampermonkey userscripts

Small userscripts that smooth over day-to-day annoyances in the tools I use.
Each one is a single self-contained file: no build step, no dependencies.

| Script | What it does |
|--------|--------------|
| [GitHub: mark test files as viewed](github-mark-test-files-viewed.user.js) | Adds a button to a pull request diff that ticks every test file as *viewed*, leaving only the real code to review. |
| [GitHub: collapse pull request labels](github-collapse-pr-labels.user.js) | Folds the labels on a pull request list into one small count, so the titles line up. Click the count to see a row's labels. |

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
| **19** Mark tests viewed | there is work to do |
| **19** All tests viewed *(greyed out)* | everything already viewed |
| `loading… 8/48` | GitHub is still streaming the diff in |
| No test files *(greyed out)* | nothing in this pull request matches |

The count sits in a badge on the button, and the button greys out when there is
nothing to press. It is disabled with `aria-disabled` rather than the `disabled`
attribute: both look the same in GitHub's styling, but a truly disabled button
leaves the tab order and swallows the hover that shows its tooltip — losing the
explanation of why it cannot be pressed, exactly when it is wanted.

You can press the button while the diff is still loading. GitHub renders large
diffs in batches over several seconds, so the script waits for files that have
not appeared yet instead of stopping at whatever is on screen. **Undo** reverses
the files that run touched, and nothing else.

### Appearance

The buttons borrow GitHub's own styling rather than imitating it: the
`prc-Button-*` classes are read off a real button on the page at runtime, and
the cog is cloned from GitHub's diff settings button. Those class names carry
build hashes that change whenever GitHub rebuilds, which is exactly why they are
read from the page instead of written down here.

### Settings

The cog next to the button opens a small menu. Settings are stored by the user
script manager, so they survive a reload and a site-data wipe, and they apply on
every repository.

- **Count factories and seeders as tests** — includes `Database/Factories`,
  `Seeders` and `Seeds`. Off by default, since those are test *support* and
  worth a look more often than a test is.
- **Fold away finished folders** — collapses sidebar folders in which every file
  is viewed, so the tree shrinks to what is left to read.

GitHub does not remember a folded tree, so the folding is worked out again on
every load from what is viewed — which GitHub *does* remember — rather than
stored. Open a folder by hand and it stays open, along with everything inside
it, for the rest of the session. Switching the setting off unfolds everything
the script folded.

The cog sits outside the main button on purpose: the button is disabled once
everything is viewed, and changing what counts as a test has to stay reachable.

### Which files count as tests

The `TEST_PATTERNS` list at the top of the script decides. It ships with the
common PHP and JavaScript conventions:

- `tests/`, `spec/`, `e2e/`, `__tests__/` and similar directories
- `*Test.php`, `*Cest.php`, `*.test.js`, `*.spec.ts`
- `phpunit.xml`, `codeception.yml`, `*.suite.yml`
- `cypress/`

Edit that list to match your own layout. Factories and seeders are not a pattern
to uncomment any more — they are a setting in the cog menu.

## GitHub: collapse pull request labels

Every label on a pull request list is repeated on nearly every row, and between
them they push the titles out of line and off the edge. This folds a row's
labels into a single chip — a tag icon and a count — sitting where they were:

| | |
|---|---|
| `🏷 3` | three labels, folded away |
| `🏷 3` *(blue)* | that row is showing its labels |
| `🏷 3` *(red)* | one of them is a **hotfix** |

Click the chip to show that row's labels, click it again to fold them back.
Alt-click shows every row at once, and Alt-click again folds them all. Hovering
gives the label names without opening anything.

A red chip is the exception to folding: something you want to see *before* you
unfold a row. Which labels earn it is the `ALERT_PATTERNS` list at the top of
the script — `hotfix` out of the box.

Nothing is remembered between page loads. Folded is the point of the script, so
every visit starts folded, and a row you opened stays open only as long as you
are on that list — filtering, sorting and paging keep it.

Labels are hidden by a stylesheet rule that matches GitHub's own markup rather
than by the script reaching into each row. Rows stream in a batch at a time and
React re-renders them as it pleases; a rule that is already in the page hides
them on first paint, instead of letting them flash into view and then vanish.

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
