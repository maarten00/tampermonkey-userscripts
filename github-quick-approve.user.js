// ==UserScript==
// @name         GitHub: quick approve
// @namespace    https://github.com/maarten00
// @version      2.0.0
// @description  Adds an Approve button to every tab of a pull request. One click approves it, without opening the review dialog yourself.
// @author       maarten00
// @license      MIT
// @homepageURL  https://github.com/maarten00/tampermonkey-userscripts
// @supportURL   https://github.com/maarten00/tampermonkey-userscripts/issues
// @updateURL    https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-quick-approve.user.js
// @downloadURL  https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-quick-approve.user.js
// @match        https://github.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Configuration
     *
     * The script presses GitHub's own buttons — open the review dialog, pick
     * Approve, submit — so it needs no token and does nothing you could not
     * do by hand. The class names carry build hashes, so everything matches
     * on the stable part of the name or on the form's own field names.
     * ------------------------------------------------------------------ */

    // The "Submit review" / "Submit comments" button in the Files changed header.
    const REVIEW_BUTTON = '[class*="ReviewMenuButton"]';
    const APPROVE_RADIO = 'input[name="reviewEvent"][value="approve"]';
    const DIALOG = '[role="dialog"]';
    // The title row's actions (View status, Code), present on every tab.
    const HEADER_ACTIONS = '[class*="PageHeader-Actions"]';
    const TAB_NAV = 'nav[aria-label="Pull request navigation"]';

    const BUTTON_ID = 'tm-quick-approve';
    const LABEL = 'Approve';

    // How long to wait for GitHub's dialog to appear, and for its submit
    // button to wake up once Approve is picked.
    const WAIT_MS = 4000;

    const onPullPage = () => /^\/[^/]+\/[^/]+\/pull\/\d+(\/|$)/.test(location.pathname);
    const onDiffPage = () => /^\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)\b/.test(location.pathname);

    /* ------------------------------------------------------------------ *
     * Waiting for the page
     * ------------------------------------------------------------------ */

    function waitFor(find, timeout = WAIT_MS) {
        return new Promise((resolve) => {
            const started = Date.now();

            (function poll() {
                const found = find();

                if (found || Date.now() - started > timeout) {
                    resolve(found ?? null);
                    return;
                }

                setTimeout(poll, 50);
            })();
        });
    }

    const isDisabled = (element) => element.disabled || element.getAttribute('aria-disabled') === 'true';

    const dialogSubmit = (dialog) => [...dialog.querySelectorAll('button')]
        .find((button) => button.dataset.variant === 'primary' && /^submit/i.test(button.textContent.trim()));

    const dialogCancel = (dialog) => [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === 'Cancel');

    /* ------------------------------------------------------------------ *
     * The button's state
     *
     * Kept outside the button: approving from another tab moves to Files
     * changed, where the button is built afresh, and its progress has to
     * survive the trip.
     * ------------------------------------------------------------------ */

    let state = { label: LABEL, title: '', disabled: false };
    let resetTimer = null;

    function render() {
        const button = document.getElementById(BUTTON_ID);
        if (!button) {
            return;
        }

        button.textContent = state.label;
        button.title = state.title;
        button.setAttribute('aria-disabled', String(state.disabled));
    }

    function setState(label, { disabled = false, title = '' } = {}) {
        clearTimeout(resetTimer);
        state = { label, title, disabled };
        render();
    }

    /**
     * Reports back on the button itself and reverts a moment later, rather than
     * raising a toast of its own: the button is already where the eye is.
     */
    function report(label, title) {
        setState(label, { title });
        resetTimer = setTimeout(() => setState(LABEL), 3000);
    }

    /* ------------------------------------------------------------------ *
     * Approving
     * ------------------------------------------------------------------ */

    let busy = false;

    /**
     * The review button only exists on the Files changed tab, so from any
     * other tab that is where the approval happens. GitHub's own tab link is
     * clicked rather than the address changed: the page is not reloaded, and
     * going back afterwards is an ordinary Back.
     */
    async function reachDiff() {
        if (onDiffPage()) {
            return false;
        }

        const link = [...document.querySelectorAll(`${TAB_NAV} a`)]
            .find((anchor) => /\/pull\/\d+\/(files|changes)$/.test(anchor.getAttribute('href') ?? ''));

        link?.click();

        return link ? true : null;
    }

    async function approve() {
        if (busy || !onPullPage()) {
            return;
        }

        busy = true;
        setState('Approving…', { disabled: true });

        let moved = false;

        try {
            moved = await reachDiff();

            if (moved === null) {
                report('Could not approve', 'The Files changed tab was not found.');
                return;
            }

            const review = await waitFor(() => (onDiffPage() ? document.querySelector(REVIEW_BUTTON) : null));
            if (!review) {
                report('Could not approve', 'GitHub did not show its review button.');
                return;
            }

            review.click();

            const dialog = await waitFor(() => {
                const open = document.querySelector(DIALOG);
                return open?.querySelector(APPROVE_RADIO) ? open : null;
            });

            if (!dialog) {
                report('Could not approve', 'The review dialog did not open.');
                return;
            }

            const radio = dialog.querySelector(APPROVE_RADIO);

            // GitHub disables it for your own pull request and where you lack
            // write access; the dialog is left the way it was found.
            if (isDisabled(radio)) {
                dialogCancel(dialog)?.click();
                report('Cannot approve', 'GitHub does not let you approve this pull request.');
                return;
            }

            radio.click();

            const submit = await waitFor(() => {
                const candidate = dialogSubmit(dialog);
                return candidate && !isDisabled(candidate) ? candidate : null;
            });

            if (!submit) {
                dialogCancel(dialog)?.click();
                report('Could not approve', 'GitHub did not enable its submit button.');
                return;
            }

            submit.click();

            const closed = await waitFor(() => (dialog.isConnected ? null : true));

            if (!closed) {
                report('Check the review', 'The review dialog is still open.');
                return;
            }

            report('Approved');

            // Back to the tab it was started from. Only on success: after a
            // failure the reader is left where the reason can be seen.
            if (moved) {
                history.back();
            }
        } finally {
            busy = false;
        }
    }

    /* ------------------------------------------------------------------ *
     * The button
     * ------------------------------------------------------------------ */

    /**
     * Dressed from a real button beside it, so it follows GitHub's styling
     * through whatever Primer ships next. Only the prc-Button-* classes are
     * taken; the rest of that list is layout for that button alone.
     */
    function createButton(reference) {
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = [...reference.classList].filter((name) => name.startsWith('prc-Button-')).join(' ');
        button.dataset.component = 'Button';
        button.dataset.size = reference.dataset.size ?? 'small';
        button.dataset.variant = 'default';
        button.setAttribute('aria-live', 'polite');

        // A disabled-looking button that still takes focus and shows its
        // tooltip, so the reason it cannot be pressed stays readable.
        button.addEventListener('click', (event) => {
            event.preventDefault();

            if (button.getAttribute('aria-disabled') !== 'true') {
                approve();
            }
        });

        return button;
    }

    /**
     * Where the button goes: beside the review button on the diff, where
     * GitHub keeps it, and in the title row's actions on every other tab.
     * Returns the element to put it in front of, or null if the page is not
     * ready.
     */
    function findAnchor() {
        if (!onPullPage()) {
            return null;
        }

        if (onDiffPage()) {
            const review = document.querySelector(REVIEW_BUTTON);
            return review ? { before: review, reference: review, margin: true } : null;
        }

        const actions = document.querySelector(HEADER_ACTIONS);
        const reference = actions?.querySelector('button[class*="prc-Button-"]');
        // The first child that is not the button itself, or the button, once
        // placed, would be its own anchor and be moved again on every pass.
        const first = actions?.querySelector(`:scope > :not(#${BUTTON_ID})`);
        return reference && first ? { before: first, reference, margin: false } : null;
    }

    function sync() {
        const existing = document.getElementById(BUTTON_ID);
        const anchor = findAnchor();

        // GitHub keeps the old header on screen while the next page loads, so
        // the button is taken out by hand when the reader leaves a pull request.
        if (!anchor) {
            existing?.remove();
            return;
        }

        if (existing && existing.nextElementSibling === anchor.before) {
            return;
        }

        existing?.remove();

        const button = createButton(anchor.reference);
        button.style.marginRight = anchor.margin ? '8px' : '';
        anchor.before.before(button);
        render();
    }

    /* ------------------------------------------------------------------ *
     * Wiring into GitHub's client-side navigation
     *
     * GitHub only loads a user script when you arrive from outside the site;
     * every step within it is a pushState away. The script is therefore
     * matched on all of github.com and finds its own page by watching the DOM.
     * ------------------------------------------------------------------ */

    let debounce = null;

    function schedule() {
        clearTimeout(debounce);
        debounce = setTimeout(sync, 100);
    }

    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', schedule);
    document.addEventListener('turbo:load', schedule);
    schedule();
})();
