// ==UserScript==
// @name         GitHub: collapse pull request labels
// @namespace    https://github.com/maarten00
// @version      1.0.0
// @description  Folds the labels on a pull request list into one small count, so the titles line up again. Click the count to see that row's labels.
// @author       maarten00
// @license      MIT
// @homepageURL  https://github.com/maarten00/tampermonkey-userscripts
// @supportURL   https://github.com/maarten00/tampermonkey-userscripts/issues
// @updateURL    https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-collapse-pr-labels.user.js
// @downloadURL  https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-collapse-pr-labels.user.js
// @match        https://github.com/*/*/pulls*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Configuration
     *
     * GitHub's pull request list is a React component tree whose class names
     * carry build hashes, so everything here matches on the stable part of
     * the name rather than the whole of it.
     * ------------------------------------------------------------------ */

    // Primer's issue-label token: the coloured pill itself.
    const LABEL = '[class*="IssueLabel"]';
    // The span trailing a row's title, in which those pills sit.
    const BADGES = '[class*="trailingBadgesContainer"]';

    // Labels worth seeing before the row is unfolded: the chip turns red when
    // one of these is among them, so an urgent pull request still stands out
    // in a list whose labels are all folded away.
    const ALERT_PATTERNS = [
        /\bhotfix\b/i,
    ];

    const ROOT_CLASS = 'tm-collapse-pr-labels';
    const STYLE_ID = 'tm-collapse-pr-labels-style';
    const CHIP_CLASS = 'tm-label-chip';
    const OPEN_ATTR = 'data-tm-labels';

    /* ------------------------------------------------------------------ *
     * What is open
     *
     * Kept per pull request number for the life of the page. Collapsing is
     * the point of the script, so nothing is remembered across a reload —
     * every visit starts folded.
     * ------------------------------------------------------------------ */

    const opened = new Set();
    let openAll = false;

    function rowKey(container) {
        const link = container.closest('li')?.querySelector('a[href*="/pull/"]');
        return link?.getAttribute('href')?.match(/\/pull\/(\d+)/)?.[1] ?? null;
    }

    const isOpen = (key) => openAll || (key !== null && opened.has(key));

    function toggleRow(key) {
        if (key === null) {
            return;
        }

        const wasOpen = isOpen(key);

        // Folding one row away while every row is open leaves the rest open:
        // "all" becomes the rows that happen to be showing right now.
        if (openAll) {
            openAll = false;
            document.querySelectorAll(BADGES).forEach((node) => {
                const other = rowKey(node);
                if (other !== null) {
                    opened.add(other);
                }
            });
        }

        if (wasOpen) {
            opened.delete(key);
        } else {
            opened.add(key);
        }

        sync();
    }

    function toggleAll() {
        openAll = !openAll;
        opened.clear();
        sync();
    }

    /* ------------------------------------------------------------------ *
     * Hiding the labels
     *
     * Done from a stylesheet keyed on the markup itself, not by marking up
     * each row from script: rows stream in and re-render as React pleases,
     * and a rule that is already in the page hides them on first paint
     * instead of letting them flash into view and then disappear.
     *
     * Only children that contain a label are hidden. The container is named
     * for badges in general, and whatever else GitHub decides to trail a
     * title with is none of this script's business.
     * ------------------------------------------------------------------ */

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            html.${ROOT_CLASS} ${BADGES}:not([${OPEN_ATTR}="open"]) > :is(*:has(${LABEL}), ${LABEL}) {
                display: none !important;
            }
            .${CHIP_CLASS} {
                display: inline-flex; align-items: center; gap: 3px; vertical-align: middle;
                height: 20px; margin-right: 4px; padding: 0 7px;
                border: 0; border-radius: 999px;
                font: 600 12px/1 var(--fontStack-sansSerif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
                color: var(--fgColor-muted, #59636e);
                background: var(--bgColor-neutral-muted, rgba(129, 139, 152, .12));
                cursor: pointer;
            }
            .${CHIP_CLASS}:hover {
                color: var(--fgColor-default, #1f2328);
                background: var(--control-bgColor-hover, rgba(129, 139, 152, .2));
            }
            .${CHIP_CLASS}[aria-expanded="true"] { color: var(--fgColor-accent, #0969da); }
            .${CHIP_CLASS}[data-alert="true"] {
                color: var(--fgColor-danger, #d1242f);
                background: var(--bgColor-danger-muted, rgba(255, 129, 130, .1));
            }
            .${CHIP_CLASS}[data-alert="true"]:hover {
                color: var(--fgColor-onEmphasis, #ffffff);
                background: var(--bgColor-danger-emphasis, #cf222e);
            }
            .${CHIP_CLASS} svg { fill: currentColor; }
            .${CHIP_CLASS}:focus-visible {
                outline: 2px solid var(--fgColor-accent, #0969da); outline-offset: 1px;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }

    /* ------------------------------------------------------------------ *
     * The chip
     * ------------------------------------------------------------------ */

    const TAG_PATH = 'M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 '
        + '1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.75 1.75 0 0 1 1 7.775Zm1.5 '
        + '0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 '
        + '0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z';

    /**
     * GitHub's own tag icon where the page offers one — the Labels link in the
     * sidebar carries it — so the chip keeps step with whatever Octicons draws
     * today. The path below is the same icon, for pages that lack it.
     */
    function tagIcon() {
        const octicon = document.querySelector('svg.octicon-tag')?.cloneNode(true);
        const icon = octicon ?? document.createElementNS('http://www.w3.org/2000/svg', 'svg');

        if (!octicon) {
            icon.setAttribute('viewBox', '0 0 16 16');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', TAG_PATH);
            icon.appendChild(path);
        }

        icon.setAttribute('width', '12');
        icon.setAttribute('height', '12');
        icon.setAttribute('aria-hidden', 'true');
        icon.removeAttribute('class');

        return icon;
    }

    function createChip() {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = CHIP_CLASS;

        const count = document.createElement('span');
        count.dataset.role = 'count';

        chip.append(tagIcon(), count);

        // The whole row opens the pull request, and it does not wait for the
        // click to decide that. Every part of the gesture is kept to the chip,
        // including the modifiers the browser has its own plans for.
        ['pointerdown', 'mousedown', 'mouseup', 'auxclick'].forEach((type) => {
            chip.addEventListener(type, (event) => {
                event.preventDefault();
                event.stopPropagation();
                chip.focus();
            });
        });

        chip.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation();
            }
        });

        chip.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();

            if (event.altKey || event.shiftKey) {
                toggleAll();
                return;
            }

            toggleRow(rowKey(chip.parentElement));
        });

        return chip;
    }

    /* ------------------------------------------------------------------ *
     * Keeping the list in step
     * ------------------------------------------------------------------ */

    function labelNames(container) {
        return [...container.querySelectorAll(LABEL)].map((label) => label.textContent.trim()).filter(Boolean);
    }

    function syncContainer(container) {
        const names = labelNames(container);
        let chip = container.querySelector(`:scope > .${CHIP_CLASS}`);

        if (names.length === 0) {
            chip?.remove();
            container.removeAttribute(OPEN_ATTR);
            return;
        }

        if (!chip) {
            chip = createChip();
            container.prepend(chip);
        } else if (chip !== container.firstElementChild) {
            // A re-render dropped the labels back in ahead of the chip.
            container.prepend(chip);
        }

        const open = isOpen(rowKey(container));
        const count = chip.querySelector('[data-role="count"]');

        container.setAttribute(OPEN_ATTR, open ? 'open' : 'collapsed');

        // Only when it actually changed: writing the same text is still a DOM
        // change, and the observer that called this is watching for those.
        if (count.textContent !== String(names.length)) {
            count.textContent = String(names.length);
        }

        chip.dataset.alert = String(names.some((name) => ALERT_PATTERNS.some((pattern) => pattern.test(name))));
        chip.setAttribute('aria-expanded', String(open));
        const plural = names.length === 1 ? 'label' : 'labels';

        chip.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${names.length} ${plural}: ${names.join(', ')}`);
        chip.title = `${names.join('\n')}\n\nClick to ${open ? 'hide' : 'show'}, Alt-click for every row`;
    }

    function sync() {
        ensureStyle();
        document.documentElement.classList.add(ROOT_CLASS);
        document.querySelectorAll(BADGES).forEach(syncContainer);
    }

    /* ------------------------------------------------------------------ *
     * Wiring into GitHub's client-side navigation
     *
     * Filtering, paging and sorting all replace the list without a page load,
     * and rows stream in a batch at a time, so the only reliable signal is
     * the DOM changing. The debounce keeps a burst of row renders down to one
     * pass; the hiding rule is already in the stylesheet, so nothing shows
     * through while it waits.
     * ------------------------------------------------------------------ */

    let debounce = null;

    function schedule() {
        clearTimeout(debounce);
        debounce = setTimeout(sync, 100);
    }

    ensureStyle();
    document.documentElement.classList.add(ROOT_CLASS);

    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', schedule);
    document.addEventListener('turbo:load', schedule);
    schedule();
})();
