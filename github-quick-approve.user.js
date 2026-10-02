// ==UserScript==
// @name         GitHub: quick approve
// @namespace    https://github.com/maarten00
// @version      2.0.0
// @description  Adds an Approve button next to the review button on a pull request's Files changed tab. One click approves, without opening the review dialog yourself.
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

    const BUTTON_ID = 'tm-quick-approve';
    const LABEL = 'Approve';

    // How long to wait for GitHub's dialog to appear, and for its submit
    // button to wake up once Approve is picked.
    const WAIT_MS = 4000;

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
     * Approving
     * ------------------------------------------------------------------ */

    let busy = false;

    function setState(button, label, { disabled = false, title = '' } = {}) {
        button.textContent = label;
        button.title = title;
        button.setAttribute('aria-disabled', String(disabled));
    }

    /**
     * Reports back on the button itself and reverts a moment later, rather than
     * raising a toast of its own: the button is already where the eye is.
     */
    function report(button, label, title) {
        setState(button, label, { title });
        setTimeout(() => {
            if (button.isConnected) {
                setState(button, LABEL);
            }
        }, 3000);
    }

    async function approve(button) {
        if (busy) {
            return;
        }

        const review = document.querySelector(REVIEW_BUTTON);
        if (!review) {
            report(button, 'No review button', 'GitHub has not shown its review button on this page.');
            return;
        }

        busy = true;
        setState(button, 'Approving…', { disabled: true });

        try {
            review.click();

            const dialog = await waitFor(() => {
                const open = document.querySelector(DIALOG);
                return open?.querySelector(APPROVE_RADIO) ? open : null;
            });

            if (!dialog) {
                report(button, 'Could not approve', 'The review dialog did not open.');
                return;
            }

            const radio = dialog.querySelector(APPROVE_RADIO);

            // GitHub disables it for your own pull request and where you lack
            // write access; the dialog is left the way it was found.
            if (isDisabled(radio)) {
                dialogCancel(dialog)?.click();
                report(button, 'Cannot approve', 'GitHub does not let you approve this pull request.');
                return;
            }

            radio.click();

            const submit = await waitFor(() => {
                const candidate = dialogSubmit(dialog);
                return candidate && !isDisabled(candidate) ? candidate : null;
            });

            if (!submit) {
                dialogCancel(dialog)?.click();
                report(button, 'Could not approve', 'GitHub did not enable its submit button.');
                return;
            }

            submit.click();

            const closed = await waitFor(() => (dialog.isConnected ? null : true));
            report(button, closed ? 'Approved' : 'Check the review', closed ? '' : 'The review dialog is still open.');
        } finally {
            busy = false;
        }
    }

    /* ------------------------------------------------------------------ *
     * The button
     * ------------------------------------------------------------------ */

    /**
     * Dressed from the review button next to it, so it follows GitHub's styling
     * through whatever Primer ships next. Only the prc-Button-* classes are
     * taken; the rest of that list is layout for the review button alone.
     */
    function createButton(review) {
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = [...review.classList].filter((name) => name.startsWith('prc-Button-')).join(' ');
        button.dataset.component = 'Button';
        button.dataset.size = review.dataset.size ?? 'small';
        button.dataset.variant = 'default';
        button.style.marginRight = '8px';
        button.setAttribute('aria-live', 'polite');
        setState(button, LABEL);

        // A disabled-looking button that still takes focus and shows its
        // tooltip, so the reason it cannot be pressed stays readable.
        button.addEventListener('click', (event) => {
            event.preventDefault();

            if (button.getAttribute('aria-disabled') !== 'true') {
                approve(button);
            }
        });

        return button;
    }

    function sync() {
        const existing = document.getElementById(BUTTON_ID);
        const review = onDiffPage() ? document.querySelector(REVIEW_BUTTON) : null;

        // GitHub keeps the old header on screen while the next page loads, so
        // the button is taken out by hand when the reader leaves the diff.
        if (!review) {
            existing?.remove();
            return;
        }

        if (existing && existing.nextElementSibling === review) {
            return;
        }

        existing?.remove();
        review.before(createButton(review));
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
