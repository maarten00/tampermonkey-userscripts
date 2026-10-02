# Repository Guidelines

## Project Structure & Module Organization

This repository contains standalone Tampermonkey scripts; there is no build system or dependency tree. Each `*.user.js` file in the repository root is a complete script, including its userscript metadata, configuration, DOM logic, styles, and navigation handling. `README.md` documents installation and user-facing behavior, while `LICENSE` contains the MIT license. There are currently no separate test or asset directories.

When adding a script, name it descriptively with kebab case, for example `github-collapse-pr-labels.user.js`, and add it to the README's script table. Keep `@updateURL` and `@downloadURL` aligned with the filename. Bump `@version` whenever a published script changes.

## Build, Test, and Development Commands

No install or build command is required. Use these lightweight checks from the repository root:

- `node --check github-collapse-pr-labels.user.js` validates JavaScript syntax without executing browser code.
- `node --check github-mark-test-files-viewed.user.js` checks the larger userscript.
- `git diff --check` catches trailing whitespace and malformed patches.

For development, install the edited file as a local userscript in Tampermonkey, then exercise it on the matching GitHub page. Verify both a direct page load and GitHub client-side navigation because GitHub reuses the document with `pushState`.

## Coding Style & Naming Conventions

Follow the existing plain JavaScript style: four-space indentation, single quotes, semicolons, `const` by default, and `camelCase` for functions and variables. Use `UPPER_SNAKE_CASE` for selectors and other module-level constants. Keep scripts inside an IIFE with `'use strict'`. Prefer stable attributes and partial class matches over GitHub's generated class names. Preserve keyboard access, ARIA state, and cleanup behavior when modifying UI.

## Testing Guidelines

There is no automated test framework or coverage target. Manually test the affected states, including empty/loading content, repeated React renders, direct loads, in-site navigation, and leaving the target page. Confirm console output is clean and unrelated GitHub controls still work.

## Commit & Pull Request Guidelines

Recent commits use concise, imperative, sentence-case subjects such as `Fold pull request labels into a count`, followed by bodies that explain motivation and behavior. Keep each commit focused and signed; never bypass commit signing. Pull requests should summarize user-visible changes, list manual test scenarios, link relevant issues, and include screenshots or a short recording for visual changes.
