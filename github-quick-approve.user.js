// ==UserScript==
// @name         GitHub: quick approve
// @namespace    https://github.com/maarten00
// @version      1.0.0
// @description  Approve the pull request you are looking at with one keyboard shortcut (Alt+Shift+U, or Cmd+Shift+U on a Mac), without opening the review dialog.
// @author       maarten00
// @license      MIT
// @homepageURL  https://github.com/maarten00/tampermonkey-userscripts
// @supportURL   https://github.com/maarten00/tampermonkey-userscripts/issues
// @updateURL    https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-quick-approve.user.js
// @downloadURL  https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-quick-approve.user.js
// @match        https://github.com/*
// @connect      api.github.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Configuration
     *
     * Approving goes through GitHub's REST API with a personal access token,
     * not through the review form: the form needs a CSRF token and markup
     * that GitHub rewrites at will, the API is a documented contract.
     * ------------------------------------------------------------------ */

    const API = 'https://api.github.com';
    const API_VERSION = '2022-11-28';

    const KEY_TOKEN = 'token';
    const KEY_SHORTCUT = 'shortcut';
    const KEY_MESSAGE = 'message';

    const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
    const DEFAULT_SHORTCUT = IS_MAC ? 'Meta+Shift+U' : 'Alt+Shift+U';

    const TOAST_ID = 'tm-quick-approve-toast';
    const TOAST_MS = 4000;

    /**
     * Any page of a pull request: Conversation, Commits, Checks, Files changed.
     * Captures owner, repository and number.
     */
    const PULL_PAGE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;

    /* ------------------------------------------------------------------ *
     * Shortcut
     *
     * Stored as text such as "Alt+Shift+U". Letters are matched on the
     * physical key (event.code) rather than the character: Option on a Mac
     * turns U into a dead key, and the character would never match.
     * ------------------------------------------------------------------ */

    const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];

    function parseShortcut(text) {
        const parts = String(text ?? '').split('+').map((part) => part.trim()).filter(Boolean);
        const key = parts.pop()?.toUpperCase();
        const modifiers = parts.map((part) => MODIFIERS.find((name) => name.toLowerCase() === part.toLowerCase()));

        // Without a modifier the shortcut would fire while typing, and a
        // misspelt modifier would silently be dropped.
        if (!key || !/^[A-Z0-9]$/.test(key) || modifiers.length === 0 || modifiers.includes(undefined)) {
            return null;
        }

        return { key, modifiers: new Set(modifiers) };
    }

    const readShortcut = () => parseShortcut(GM_getValue(KEY_SHORTCUT, DEFAULT_SHORTCUT))
        ?? parseShortcut(DEFAULT_SHORTCUT);

    function matches(event, shortcut) {
        const code = /^\d$/.test(shortcut.key) ? `Digit${shortcut.key}` : `Key${shortcut.key}`;

        return event.code === code
            && event.ctrlKey === shortcut.modifiers.has('Ctrl')
            && event.altKey === shortcut.modifiers.has('Alt')
            && event.shiftKey === shortcut.modifiers.has('Shift')
            && event.metaKey === shortcut.modifiers.has('Meta');
    }

    /** Typing a comment must never approve anything. */
    function isTyping(target) {
        return target instanceof Element
            && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null);
    }

    /* ------------------------------------------------------------------ *
     * Toast
     * ------------------------------------------------------------------ */

    let toastTimer = null;

    function toast(text, kind) {
        let node = document.getElementById(TOAST_ID);

        if (!node) {
            node = document.createElement('div');
            node.id = TOAST_ID;
            node.setAttribute('role', 'status');
            node.setAttribute('aria-live', 'polite');
            node.style.cssText = [
                'position: fixed', 'right: 16px', 'bottom: 16px', 'z-index: 2147483647',
                'max-width: 360px', 'padding: 10px 14px',
                'border: 1px solid transparent', 'border-radius: 6px',
                'font: 14px/1.4 var(--fontStack-sansSerif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
                'box-shadow: var(--shadow-floating-small, 0 4px 12px rgba(0, 0, 0, .25))',
            ].join(';');
            document.body.appendChild(node);
        }

        const failed = kind === 'error';
        const pending = kind === 'pending';

        node.textContent = text;
        node.style.color = failed ? 'var(--fgColor-danger, #d1242f)' : 'var(--fgColor-default, #1f2328)';
        node.style.background = failed ? 'var(--bgColor-danger-muted, #ffebe9)' : 'var(--bgColor-default, #ffffff)';
        node.style.borderColor = failed
            ? 'var(--borderColor-danger-muted, #ff818266)'
            : (kind === 'success' ? 'var(--borderColor-success-emphasis, #1a7f37)' : 'var(--borderColor-default, #d1d9e0)');

        clearTimeout(toastTimer);
        if (!pending) {
            toastTimer = setTimeout(() => node.remove(), TOAST_MS);
        }
    }

    /* ------------------------------------------------------------------ *
     * GitHub API
     * ------------------------------------------------------------------ */

    /**
     * GM_xmlhttpRequest rather than fetch: github.com's content security
     * policy decides what the page may connect to, and the token has no
     * business in page context anyway.
     */
    function api(method, path, token, body) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: `${API}${path}`,
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'X-GitHub-Api-Version': API_VERSION,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                data: body ? JSON.stringify(body) : undefined,
                onload: (response) => {
                    let json = {};
                    try {
                        json = JSON.parse(response.responseText);
                    } catch (error) {
                        // An empty or non-JSON body: the status says enough.
                    }

                    if (response.status >= 200 && response.status < 300) {
                        resolve(json);
                        return;
                    }

                    reject(new Error(json.message ?? `GitHub answered ${response.status}`));
                },
                onerror: () => reject(new Error('Could not reach api.github.com')),
                ontimeout: () => reject(new Error('api.github.com did not answer in time')),
            });
        });
    }

    /* ------------------------------------------------------------------ *
     * Approving
     * ------------------------------------------------------------------ */

    let approving = false;

    async function approve() {
        const match = location.pathname.match(PULL_PAGE);
        if (!match || approving) {
            return;
        }

        const token = GM_getValue(KEY_TOKEN, '');
        if (!token) {
            toast('Quick approve needs a GitHub token first.', 'error');
            setToken();
            return;
        }

        const [, owner, repo, number] = match;
        const message = GM_getValue(KEY_MESSAGE, '');

        approving = true;
        toast(`Approving ${owner}/${repo}#${number}…`, 'pending');

        try {
            await api('POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, token, {
                event: 'APPROVE',
                ...(message ? { body: message } : {}),
            });
            toast(`Approved ${owner}/${repo}#${number}`, 'success');
        } catch (error) {
            toast(`Could not approve: ${error.message}`, 'error');
        } finally {
            approving = false;
        }
    }

    document.addEventListener('keydown', (event) => {
        if (event.repeat || event.isComposing || isTyping(event.target)) {
            return;
        }

        if (PULL_PAGE.test(location.pathname) && matches(event, readShortcut())) {
            event.preventDefault();
            approve();
        }
    });

    /* ------------------------------------------------------------------ *
     * Settings, from the Tampermonkey menu
     * ------------------------------------------------------------------ */

    async function setToken() {
        const input = prompt(
            'Paste a GitHub personal access token.\n\n'
            + 'Fine-grained: "Pull requests: Read and write" on the repositories you review.\n'
            + 'Classic: the "repo" scope.\n\n'
            + 'Create one at https://github.com/settings/personal-access-tokens/new\n'
            + 'The token stays in your script manager and is only sent to api.github.com.\n'
            + 'Leave empty to remove it.',
            '',
        );

        if (input === null) {
            return;
        }

        const token = input.trim();
        if (!token) {
            GM_setValue(KEY_TOKEN, '');
            toast('Token removed', 'success');
            return;
        }

        try {
            const user = await api('GET', '/user', token);
            GM_setValue(KEY_TOKEN, token);
            toast(`Token saved for ${user.login}`, 'success');
        } catch (error) {
            toast(`Token not saved: ${error.message}`, 'error');
        }
    }

    function setShortcut() {
        const input = prompt(
            `Shortcut for approving, e.g. ${DEFAULT_SHORTCUT}\n\n`
            + 'Modifiers: Ctrl, Alt, Shift, Meta (Cmd). Then one letter or digit.',
            GM_getValue(KEY_SHORTCUT, DEFAULT_SHORTCUT),
        );

        if (input === null) {
            return;
        }

        if (!parseShortcut(input)) {
            toast('Not a valid shortcut. Use at least one modifier and one letter or digit.', 'error');
            return;
        }

        GM_setValue(KEY_SHORTCUT, input.trim());
        toast(`Shortcut is now ${input.trim()}`, 'success');
    }

    function setMessage() {
        const input = prompt('Comment to leave with each approval. Leave empty for none.', GM_getValue(KEY_MESSAGE, ''));

        if (input === null) {
            return;
        }

        GM_setValue(KEY_MESSAGE, input.trim());
        toast('Approval message saved', 'success');
    }

    GM_registerMenuCommand('Quick approve: set GitHub token…', setToken);
    GM_registerMenuCommand('Quick approve: change shortcut…', setShortcut);
    GM_registerMenuCommand('Quick approve: change approval message…', setMessage);
})();
