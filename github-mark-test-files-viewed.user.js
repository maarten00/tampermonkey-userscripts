// ==UserScript==
// @name         GitHub: mark test files as viewed
// @namespace    https://github.com/maarten00
// @version      3.3.0
// @description  Adds a button to a GitHub pull request diff that marks every test file as viewed, leaving only the real code to review.
// @author       maarten00
// @license      MIT
// @homepageURL  https://github.com/maarten00/tampermonkey-userscripts
// @supportURL   https://github.com/maarten00/tampermonkey-userscripts/issues
// @updateURL    https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-mark-test-files-viewed.user.js
// @downloadURL  https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-mark-test-files-viewed.user.js
// @match        https://github.com/*/*/pull/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Configuration
     * ------------------------------------------------------------------ */

    const CONFIG = {
        clickDelayMs: 250,      // Pause between toggles; GitHub throttles rapid-fire requests.
        scrollSettleMs: 400,    // Time given to the lazy-loaded diff to render after scrolling.
        scrollStep: 0.6,        // Fraction of the viewport to advance per step.
        maxRuntimeMs: 300000,
        settleWindowMs: 1500,   // Fallback only: how long the count must hold steady when no total is known.
        stallTimeoutMs: 15000,  // Give up waiting for stragglers; rendering can pause for seconds.
    };

    /* ------------------------------------------------------------------ *
     * Settings
     *
     * Kept in the user script manager's own storage, so they survive a reload
     * and even a site-data wipe. localStorage is only a fallback for managers
     * that do not expose the GM API.
     * ------------------------------------------------------------------ */

    const STORAGE_PREFIX = 'mark-tests-viewed:';

    const DEFAULTS = {
        skipFactories: false,
        collapseViewedDirs: false,
    };

    const store = {
        read(key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    return GM_getValue(key, fallback);
                }
            } catch {
                // Fall through to localStorage.
            }

            try {
                return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback;
            } catch {
                return fallback;
            }
        },
        write(key, value) {
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, value);
                    return;
                }
            } catch {
                // Fall through to localStorage.
            }

            try {
                localStorage.setItem(STORAGE_PREFIX + key, value);
            } catch {
                // Nothing else to try; the setting lasts for this page only.
            }
        },
    };

    function loadSettings() {
        try {
            return { ...DEFAULTS, ...JSON.parse(store.read('settings', '{}')) };
        } catch {
            return { ...DEFAULTS };
        }
    }

    let settings = loadSettings();

    function updateSetting(key, value) {
        settings = { ...settings, [key]: value };
        store.write('settings', JSON.stringify(settings));
        refreshCount();
    }

    // A path is a test when it matches any of these.
    const TEST_PATTERNS = [
        /(^|\/)(tests?|integrationtests|unittests|featuretests|functionaltests|acceptancetests|browsertests|e2e|spec)\//i,
        /(^|\/)__tests__\//,
        /Test\.php$/,
        /Cest\.php$/,
        /\.(test|spec)\.[jt]sx?$/,
        /\.suite\.ya?ml$/,
        /(^|\/)(phpunit|codeception)[\w.]*\.(xml|ya?ml)(\.dist)?$/i,
        /(^|\/)cypress\//i,
    ];

    // Test support rather than tests: close enough to skip, far enough that it
    // is a choice. Toggled from the settings menu.
    const OPTIONAL_PATTERNS = {
        skipFactories: /(^|\/)Database\/(Factories|Seeders|Seeds)\//i,
    };

    function isTestPath(path) {
        if (TEST_PATTERNS.some((pattern) => pattern.test(path))) {
            return true;
        }

        return Object.entries(OPTIONAL_PATTERNS)
            .some(([key, pattern]) => settings[key] && pattern.test(path));
    }

    /* ------------------------------------------------------------------ *
     * Locating files in the diff
     *
     * Two diff views are in circulation. The newer one (/changes) renders the
     * toggle as a button carrying aria-pressed; the classic one (/files) uses a
     * native checkbox. Both are handled, newest first.
     * ------------------------------------------------------------------ */

    const VIEWED_BUTTON = 'button[class*="MarkAsViewedButton"], button[aria-pressed][aria-label$="iewed" i]';
    const FILE_HEADER = '[class*="diff-file-header"], [class*="diffHeaderWrapper"], [class*="file-header"]';
    const FILE_NAME = 'h3[class*="file-name"], [class*="file-name"]';

    const VIEWED = /\bviewed\b/i;
    const PATH_LIKE = /[\w.@~+-]+(?:\/[\w.@~+-]+)*\.[A-Za-z0-9]{1,8}$/;

    /** GitHub wraps file names in bidi marks, which corrupt path matching. */
    const clean = (text) => (text || '').replace(/[‎‏‪-‮]/g, '').trim();

    function isViewedCheckbox(element) {
        if (element.type !== 'checkbox') {
            return false;
        }
        if (element.name === 'viewed' || element.classList.contains('js-reviewed-checkbox')) {
            return true;
        }

        const labelledBy = element.id
            ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
            : null;

        return [element.getAttribute('aria-label'), labelledBy?.textContent, element.closest('label')?.textContent]
            .some((text) => text && text.trim().length < 60 && VIEWED.test(text));
    }

    function pathFromText(text) {
        const trimmed = clean(text);
        if (!trimmed || trimmed.length > 200) {
            return null;
        }
        if (PATH_LIKE.test(trimmed)) {
            return trimmed;
        }

        // Accessible names such as "Mark tests/FooTest.php as viewed".
        const embedded = trimmed.match(/[\w.@~+-]+(?:\/[\w.@~+-]+)+/);

        return embedded && PATH_LIKE.test(embedded[0]) ? embedded[0] : null;
    }

    function countControls(node) {
        return node.querySelectorAll(VIEWED_BUTTON).length
            + [...node.querySelectorAll('input[type="checkbox"]')].filter(isViewedCheckbox).length;
    }

    /**
     * Walks up from the toggle until the file's own container yields a path.
     * Climbing stops as soon as the ancestor holds more than one file, so a
     * path is never borrowed from the neighbouring diff.
     */
    function resolvePath(control) {
        const header = control.closest(FILE_HEADER);
        const named = header?.querySelector(FILE_NAME);
        if (named) {
            const path = pathFromText(named.textContent);
            if (path) {
                return path;
            }
        }

        const fromLabel = pathFromText(control.getAttribute('aria-label'));
        if (fromLabel) {
            return fromLabel;
        }

        let node = control.parentElement;
        for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
            if (countControls(node) > 1) {
                break;
            }

            const candidates = [node, ...node.querySelectorAll('[data-tagsearch-path],[data-path],[title],h1,h2,h3,h4,a,code')];
            for (const candidate of candidates) {
                const path = candidate.getAttribute?.('data-tagsearch-path')
                    || candidate.getAttribute?.('data-path')
                    || pathFromText(candidate.getAttribute?.('title'))
                    || pathFromText(candidate.textContent);

                if (path) {
                    return path;
                }
            }
        }

        return null;
    }

    /** True when this file is already ticked off. */
    function isViewed(control) {
        if (control.tagName === 'BUTTON') {
            return control.getAttribute('aria-pressed') === 'true'
                || clean(control.getAttribute('aria-label')).toLowerCase() === 'viewed';
        }

        return control.checked;
    }

    function scanFiles() {
        const controls = [
            ...document.querySelectorAll(VIEWED_BUTTON),
            ...[...document.querySelectorAll('input[type="checkbox"]')].filter(isViewedCheckbox),
        ];

        const files = [];
        const seen = new Set();

        for (const control of controls) {
            let path = resolvedPaths.get(control);
            if (path === undefined) {
                path = resolvePath(control);
                resolvedPaths.set(control, path);
            }

            if (path && !seen.has(path)) {
                seen.add(path);
                files.push({ path, control });
            }
        }

        return files;
    }

    const resolvedPaths = new WeakMap();

    /* ------------------------------------------------------------------ *
     * The embedded file list
     * ------------------------------------------------------------------ */

    let payloadCache = { pr: null, files: null };

    /**
     * GitHub ships the complete file list in the page as JSON, and it is there
     * long before the diffs themselves render. The script node survives
     * client-side navigation untouched, so it goes stale as soon as you move to
     * another pull request; it is only trusted when its number matches the URL.
     */
    function payloadFiles() {
        const current = location.pathname.match(/\/pull\/(\d+)/)?.[1];
        if (!current) {
            return null;
        }
        if (payloadCache.pr === current) {
            return payloadCache.files;
        }

        payloadCache = { pr: current, files: null };

        for (const script of document.querySelectorAll('script[type="application/json"]')) {
            let route;
            try {
                route = JSON.parse(script.textContent)?.payload?.pullRequestsChangesRoute;
            } catch {
                continue;
            }

            if (Array.isArray(route?.diffSummaries) && String(route.pullRequest?.number) === current) {
                payloadCache.files = route.diffSummaries.map((summary) => ({
                    path: summary.path,
                    viewed: Boolean(summary.markedAsViewed),
                }));
                break;
            }
        }

        return payloadCache.files;
    }

    /**
     * What the diff contains versus what is on screen right now. Paths come from
     * the payload when it is usable, so the tally is right before rendering
     * finishes; viewed state prefers the DOM, which is live.
     */
    function tally() {
        const rendered = new Map(scanFiles().map((file) => [file.path, isViewed(file.control)]));
        const payload = payloadFiles();
        const known = payload ?? [...rendered].map(([path, viewed]) => ({ path, viewed }));

        // How many files the diff really holds: the payload knows, and failing
        // that GitHub's own counter carries the total from the first paint.
        const total = payload ? payload.length : (totalFileCount() ?? rendered.size);

        const tests = known.filter((file) => isTestPath(file.path));
        const pending = tests.filter(
            (file) => (rendered.has(file.path) ? !rendered.get(file.path) : !file.viewed),
        );

        return {
            hasPayload: Boolean(payload),
            total,
            rendered: rendered.size,
            tests: tests.length,
            pending: pending.length,
            pendingPaths: new Set(pending.map((file) => file.path)),
        };
    }

    /* ------------------------------------------------------------------ *
     * The file tree
     *
     * The sidebar is a Primer TreeView: each folder is a treeitem whose id is
     * its path and whose chevron toggles it. GitHub forgets the folded state on
     * every load, so it is derived again each time from what is viewed — which
     * GitHub does remember — rather than stored.
     * ------------------------------------------------------------------ */

    const TREE_FOLDER = 'li[role="treeitem"][aria-expanded]';
    const TREE_TOGGLE = '.PRIVATE_TreeView-item-toggle, [class*="item-toggle"]';

    // Folders this script folded, so the setting can be switched back off, and
    // folders the reader opened by hand, so it never fights them.
    const autoCollapsed = new Set();
    const keptExpanded = new Set();
    let clickingTree = false;

    /** Every file in the diff mapped to whether it is viewed; the DOM wins. */
    function fileViewState() {
        const viewed = new Map();

        for (const file of payloadFiles() ?? []) {
            viewed.set(file.path, file.viewed);
        }
        for (const file of scanFiles()) {
            viewed.set(file.path, isViewed(file.control));
        }

        return viewed;
    }

    /** Clicks the chevron rather than the row, which would follow its link. */
    function toggleFolder(folder) {
        const toggle = folder.querySelector(TREE_TOGGLE);
        if (!toggle) {
            return false;
        }

        clickingTree = true;
        try {
            toggle.click();
        } finally {
            clickingTree = false;
        }

        return true;
    }

    const folderDepth = (folder) => folder.id.split('/').length;

    /**
     * True once the reader has opened this folder, or anything containing it, by
     * hand. Folding the children of a folder somebody just opened to look inside
     * would be the opposite of helpful.
     */
    function isKeptExpanded(id) {
        return keptExpanded.has(id)
            || [...keptExpanded].some((opened) => id.startsWith(`${opened}/`));
    }

    function collapseViewedFolders() {
        const viewed = fileViewState();
        if (viewed.size === 0) {
            return;
        }

        // Shallowest first: folding a parent makes folding its children pointless.
        const folders = [...document.querySelectorAll(`${TREE_FOLDER}[aria-expanded="true"]`)]
            .filter((folder) => folder.id)
            .sort((a, b) => folderDepth(a) - folderDepth(b));

        const folded = [];

        for (const folder of folders) {
            if (isKeptExpanded(folder.id)) {
                continue;
            }
            if (folded.some((done) => folder.id.startsWith(`${done}/`))) {
                continue;
            }

            const prefix = `${folder.id}/`;
            const contents = [...viewed].filter(([path]) => path.startsWith(prefix));

            if (contents.length === 0 || contents.some(([, isSeen]) => !isSeen)) {
                continue;
            }

            if (toggleFolder(folder)) {
                autoCollapsed.add(folder.id);
                folded.push(folder.id);
            }
        }
    }

    /** Puts the tree back the way it was when the setting is switched off. */
    function expandAutoCollapsed() {
        if (autoCollapsed.size === 0) {
            return;
        }

        for (const folder of document.querySelectorAll(`${TREE_FOLDER}[aria-expanded="false"]`)) {
            if (autoCollapsed.has(folder.id)) {
                toggleFolder(folder);
            }
        }

        autoCollapsed.clear();
    }

    function syncTree() {
        if (settings.collapseViewedDirs) {
            collapseViewedFolders();
        } else {
            expandAutoCollapsed();
        }
    }

    // Anything the reader opens by hand stays open for the rest of the session.
    document.addEventListener('click', (event) => {
        if (clickingTree) {
            return;
        }

        const item = event.target?.closest?.('li[role="treeitem"]');
        if (item?.id && item.matches(TREE_FOLDER)) {
            keptExpanded.add(item.id);
        }
    }, true);

    /* ------------------------------------------------------------------ *
     * Scrolling
     * ------------------------------------------------------------------ */

    /** The diff may live in its own scroll container rather than the window. */
    function getScroller() {
        let node = scanFiles()[0]?.control?.parentElement;

        while (node && node !== document.body) {
            const overflow = getComputedStyle(node).overflowY;
            if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight + 20) {
                return node;
            }
            node = node.parentElement;
        }

        return document.scrollingElement || document.documentElement;
    }

    const atBottom = (scroller) => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /* ------------------------------------------------------------------ *
     * Sweeping the diff
     * ------------------------------------------------------------------ */

    const state = { running: false, cancelled: false, marked: [], resultText: '', resultPending: 0 };

    /**
     * Scans, toggles and scrolls until every target has been dealt with.
     *
     * Reaching the bottom is not the finish line: GitHub streams the diff in
     * over several seconds, so early on the page is short and most files simply
     * do not exist yet. The sweep therefore waits at the bottom for stragglers
     * to arrive and only gives up when nothing new has appeared for a while.
     */
    async function sweep(desired, matches, onProgress, expected, minSeen) {
        const touched = new Set();
        const handled = new Set();
        const deadline = Date.now() + CONFIG.maxRuntimeMs;
        const scroller = getScroller();

        const outstanding = () => (expected ? [...expected].filter((path) => !handled.has(path)).length : null);

        let lastProgressAt = Date.now();
        let bottomStreak = 0;

        scroller.scrollTop = 0;
        await sleep(CONFIG.scrollSettleMs);

        while (Date.now() < deadline && !state.cancelled) {
            let progressed = false;

            for (const file of scanFiles()) {
                if (handled.has(file.path)) {
                    continue;
                }

                handled.add(file.path);
                progressed = true;

                if (!matches(file.path) || isViewed(file.control) === desired) {
                    continue;
                }

                file.control.click();
                touched.add(file.path);
                onProgress(touched.size, outstanding());
                await sleep(CONFIG.clickDelayMs);
            }

            // Done when every intended file is handled; without that list, when
            // every file the diff promises has at least been seen.
            if (expected) {
                if (outstanding() === 0) {
                    break;
                }
            } else if (atBottom(scroller)) {
                const seenEverything = minSeen !== null && handled.size >= minSeen;
                if (seenEverything || (minSeen === null && bottomStreak >= 2)) {
                    break;
                }
            }

            if (progressed) {
                lastProgressAt = Date.now();
                bottomStreak = 0;
            } else if (Date.now() - lastProgressAt >= CONFIG.stallTimeoutMs) {
                break;
            }

            if (atBottom(scroller)) {
                bottomStreak++;     // Nothing left to scroll past; hold still and let the rest stream in.
            } else {
                bottomStreak = 0;
                scroller.scrollTop += Math.round(scroller.clientHeight * CONFIG.scrollStep);
            }

            await sleep(CONFIG.scrollSettleMs);
        }

        return { touched: [...touched], missed: outstanding() ?? 0 };
    }

    /* ------------------------------------------------------------------ *
     * Panel
     * ------------------------------------------------------------------ */

    const MENU_OPTIONS = [
        {
            key: 'skipFactories',
            label: 'Also skip factories and seeders',
            hint: 'Counts Database/Factories, Seeders and Seeds as tests.',
        },
        {
            key: 'collapseViewedDirs',
            label: 'Collapse fully viewed folders',
            hint: 'Folds away sidebar folders where every file is viewed. Reapplied on reload, since GitHub does not remember it.',
        },
    ];

    const PANEL_ID = 'tm-mark-tests-viewed';
    const STYLE_ID = 'tm-mark-tests-viewed-style';
    let elements = null;

    /** GitHub streams the file list in, so the count is not final on first paint. */
    const scanState = { lastCount: -1, stableSince: 0, timer: null };

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${PANEL_ID} .tm-spinner {
                display: inline-block; box-sizing: border-box; width: 12px; height: 12px; flex: none;
                border: 2px solid var(--borderColor-muted, #d1d9e0);
                border-top-color: var(--fgColor-accent, #0969da);
                border-radius: 50%;
                animation: tm-spin 0.7s linear infinite;
            }
            #${PANEL_ID} [hidden] { display: none !important; }
            #${PANEL_ID} .tm-state {
                display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
                color: var(--fgColor-muted, #59636e);
            }
            #${PANEL_ID} .tm-state.tm-complete { color: var(--fgColor-success, #1a7f37); }
            #${PANEL_ID} .tm-state .tm-check { font-weight: 700; }
            #${PANEL_ID} .tm-menu-wrap { position: relative; display: inline-flex; }
            #${PANEL_ID} .tm-chevron { padding: 3px 6px; line-height: 1; }
            #${PANEL_ID} .tm-menu {
                position: absolute; top: calc(100% + 4px); right: 0; z-index: 2147483000;
                min-width: 232px; padding: 8px; text-align: left;
                background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
                border: 1px solid var(--borderColor-default, #d1d9e0);
                border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, .15);
            }
            #${PANEL_ID} .tm-menu label {
                display: flex; gap: 8px; align-items: flex-start; cursor: pointer; padding: 4px 2px;
            }
            #${PANEL_ID} .tm-menu input { margin: 2px 0 0; flex: none; }
            #${PANEL_ID} .tm-menu .tm-hint {
                display: block; margin-top: 1px; color: var(--fgColor-muted, #59636e);
            }
            @keyframes tm-spin { to { transform: rotate(360deg); } }
            @media (prefers-reduced-motion: reduce) {
                #${PANEL_ID} .tm-spinner { animation-duration: 2.4s; }
            }
        `;
        document.head.appendChild(style);
    }

    // Matches GitHub's own progress indicator, e.g. "0 / 15 viewed".
    const COUNTER_TEXT = /^\s*\d+\s*\/\s*\d+\s*(files?\s*)?viewed\s*$/i;
    // Looser tier, for wordier variants such as "0 of 15 files viewed".
    const COUNTER_LOOSE = /\d+[\s\S]{0,4}(\/|of)[\s\S]{0,4}\d+[\s\S]*\bviewed\b/i;

    const TOOLBAR_FALLBACKS = [
        '[class*="ViewedFileProgress"]',
        '[data-testid*="diff-toolbar"]',
        '.pr-review-tools',
        '[class*="DiffsHeader"]',
        '[class*="diffbar"]',
    ];

    let mountedCounter = null;

    /**
     * GitHub's counter carries the server-side total ("0 / 85 viewed") from the
     * first paint, long before the files themselves render. That makes it an
     * exact "still loading" signal rather than a guess based on timing.
     */
    function totalFileCount() {
        if (!mountedCounter || !document.body.contains(mountedCounter)) {
            mountedCounter = findCounterElement();
        }

        const match = clean(mountedCounter?.textContent).match(/(\d+)\s*(?:\/|of)\s*(\d+)/i);

        return match ? Number(match[2]) : null;
    }

    /** Text as sighted users see it: screen-reader-only duplicates excluded. */
    function visibleText(element) {
        const copy = element.cloneNode(true);
        copy.querySelectorAll('.sr-only').forEach((node) => node.remove());

        return clean(copy.textContent);
    }

    /**
     * The counter is a group: a progress donut, the "0 / 85 viewed" text and an
     * sr-only copy. Inserting before the text alone would split the donut off
     * from its number, so climb to the outermost node that is still only the
     * counter and insert before that.
     */
    function counterWidget(inner) {
        let node = inner;

        while (node.parentElement) {
            const text = visibleText(node.parentElement);
            if (text.length < 40 && COUNTER_LOOSE.test(text)) {
                node = node.parentElement;
            } else {
                break;
            }
        }

        return node;
    }

    /** The innermost element whose text is the viewed counter. */
    function findCounterElement() {
        for (const pattern of [COUNTER_TEXT, COUNTER_LOOSE]) {
            const matches = [...document.querySelectorAll('span, div, strong, label, p')]
                .filter((element) => {
                    const text = element.textContent;
                    return text && text.length < 40 && pattern.test(text) && !element.closest('.sr-only');
                });

            // Keep only the innermost match, so the button lands on the counter
            // itself rather than on some ancestor that happens to contain it.
            const innermost = matches.find(
                (element) => !matches.some((other) => other !== element && element.contains(other)),
            );

            if (innermost) {
                return innermost;
            }
        }

        return null;
    }

    /** Places the controls beside the counter, falling back to the toolbar, then to a corner. */
    function mount(container) {
        const counter = findCounterElement();
        if (counter?.parentElement) {
            const widget = counterWidget(counter);
            widget.parentElement.insertBefore(container, widget);
            mountedCounter = counter;
            return 'counter';
        }

        for (const selector of TOOLBAR_FALLBACKS) {
            const toolbar = document.querySelector(selector);
            if (toolbar?.parentElement) {
                toolbar.parentElement.insertBefore(container, toolbar);
                return 'toolbar';
            }
        }

        Object.assign(container.style, {
            position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483000', padding: '8px',
            background: 'var(--bgColor-default, #ffffff)',
            border: '1px solid var(--borderColor-default, #d1d9e0)',
            borderRadius: '6px', boxShadow: '0 3px 12px rgba(0,0,0,.15)',
        });

        return 'floating';
    }

    function buildPanel() {
        const container = document.createElement('div');
        container.id = PANEL_ID;
        container.style.cssText = `
            display: inline-flex; align-items: center; gap: 8px; margin-right: 8px;
            font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: var(--fgColor-default, #1f2328); vertical-align: middle;
        `;

        const buttonStyle = 'padding: 3px 10px; font: inherit; font-weight: 600; cursor: pointer;'
            + ' white-space: nowrap; color: var(--fgColor-default, #1f2328);'
            + ' background: var(--bgColor-muted, #f6f8fa);'
            + ' border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px;';

        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = buttonStyle;

        const spinner = document.createElement('span');
        spinner.className = 'tm-spinner';
        spinner.hidden = true;

        const status = document.createElement('span');
        status.setAttribute('aria-live', 'polite');
        status.style.cssText = 'color: var(--fgColor-muted, #59636e); white-space: nowrap;';

        // Shown instead of the button whenever there is nothing to act on, so a
        // dead control never sits there looking clickable.
        const indicator = document.createElement('span');
        indicator.className = 'tm-state';
        indicator.setAttribute('role', 'status');
        indicator.hidden = true;

        // The settings live outside the main button, which disappears whenever
        // there is nothing to mark; they have to stay reachable in every state.
        const menuWrap = document.createElement('span');
        menuWrap.className = 'tm-menu-wrap';

        const chevron = document.createElement('button');
        chevron.type = 'button';
        chevron.className = 'tm-chevron';
        chevron.textContent = '⌄';
        chevron.title = 'Settings';
        chevron.setAttribute('aria-label', 'Test file settings');
        chevron.setAttribute('aria-haspopup', 'true');
        chevron.setAttribute('aria-expanded', 'false');
        chevron.style.cssText = buttonStyle + 'padding: 1px 7px 5px;';

        const menu = document.createElement('div');
        menu.className = 'tm-menu';
        menu.hidden = true;

        for (const option of MENU_OPTIONS) {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = Boolean(settings[option.key]);
            input.addEventListener('change', () => updateSetting(option.key, input.checked));

            const text = document.createElement('span');
            text.append(option.label);
            const hint = document.createElement('small');
            hint.className = 'tm-hint';
            hint.textContent = option.hint;
            text.append(hint);

            label.append(input, text);
            menu.append(label);
        }

        menuWrap.append(chevron, menu);

        const undo = document.createElement('button');
        undo.type = 'button';
        undo.textContent = 'Undo';
        undo.hidden = true;
        undo.style.cssText = buttonStyle;

        ensureStyle();
        container.append(spinner, button, indicator, undo, status, menuWrap);
        const placement = mount(container);

        button.addEventListener('click', () => (state.running ? cancel() : start()));
        undo.addEventListener('click', undoRun);

        chevron.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleMenu(menu.hidden);
        });

        // A menu that only closes via its own button is a trap.
        document.addEventListener('click', (event) => {
            if (!menu.hidden && !menuWrap.contains(event.target)) {
                toggleMenu(false);
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !menu.hidden) {
                toggleMenu(false);
                chevron.focus();
            }
        });

        return { container, button, spinner, indicator, status, undo, menu, chevron, placement };
    }

    /**
     * Renders whichever of four states the panel is in: still loading, work to
     * do, everything already viewed, or nothing to view at all. Only the second
     * one is a button, because only the second one does anything.
     */
    function toggleMenu(open) {
        elements.menu.hidden = !open;
        elements.chevron.setAttribute('aria-expanded', String(open));
    }

    function refreshCount() {
        if (!elements || state.running) {
            return;
        }

        const counts = tally();
        const now = Date.now();

        if (counts.rendered !== scanState.lastCount) {
            scanState.lastCount = counts.rendered;
            scanState.stableSince = now;
        }

        // The tally is final as soon as the payload is readable; only clicking
        // has to wait, because clicking needs files that have actually rendered.
        const stalled = now - scanState.stableSince >= CONFIG.stallTimeoutMs;
        const loading = counts.total === 0
            ? now - scanState.stableSince < CONFIG.settleWindowMs
            : counts.rendered < counts.total && !stalled;

        elements.spinner.hidden = !loading;
        elements.container.setAttribute('aria-busy', String(loading));

        const actionable = counts.tests > 0 && counts.pending > 0;
        elements.button.hidden = !actionable;
        elements.indicator.hidden = actionable;

        if (actionable) {
            elements.button.textContent =
                `Mark ${counts.pending} test${counts.pending === 1 ? '' : 's'} viewed`;
            elements.button.title = `${counts.tests} of ${counts.total} files match the test patterns.`
                + (counts.pending < counts.tests ? `\n${counts.tests - counts.pending} already viewed.` : '')
                + (loading ? `\n${counts.rendered} rendered so far; the sweep waits for the rest.` : '')
                + '\nTicks GitHub\'s own "Viewed" toggle on each one.';
        } else {
            const complete = counts.tests > 0;
            elements.indicator.classList.toggle('tm-complete', complete);
            elements.indicator.textContent = '';

            if (complete) {
                const check = document.createElement('span');
                check.className = 'tm-check';
                check.textContent = '✓';
                elements.indicator.append(check, document.createTextNode(
                    ` All ${counts.tests} test${counts.tests === 1 ? '' : 's'} viewed`,
                ));
                elements.indicator.title = 'Every file matching the test patterns is already marked as viewed.';
            } else {
                elements.indicator.textContent = loading ? 'checking for tests…' : 'no test files';
                elements.indicator.title = `None of the ${counts.total} changed files match the test patterns.`;
            }
        }

        // A finished run's summary holds until there is something new to do.
        if (state.resultText && counts.pending > state.resultPending) {
            state.resultText = '';
        }

        if (!state.resultText) {
            if (loading) {
                elements.status.textContent = `loading… ${counts.rendered}/${counts.total}`;
            } else if (actionable && counts.pending < counts.tests) {
                elements.status.textContent = `${counts.tests - counts.pending} of ${counts.tests} done`;
            } else {
                elements.status.textContent = '';
            }
        }

        // Mutations may stop before everything has rendered, so keep polling.
        clearTimeout(scanState.timer);
        if (loading) {
            scanState.timer = setTimeout(refreshCount, 400);
        } else {
            syncTree();
        }
    }

    function setBusy(busy) {
        state.running = busy;
        elements.undo.hidden = busy || state.marked.length === 0;

        if (busy) {
            elements.spinner.hidden = true;
            elements.indicator.hidden = true;
            elements.button.hidden = false;
            elements.button.textContent = 'Cancel';
        } else {
            refreshCount();
        }
    }

    function cancel() {
        state.cancelled = true;
        elements.status.textContent = 'Stopping…';
    }

    async function start() {
        const counts = tally();
        // Without the payload the pending list only covers rendered files, so it
        // would be a false finish line; fall back to counting files seen.
        const expected = counts.hasPayload ? counts.pendingPaths : null;

        state.cancelled = false;
        state.marked = [];
        state.resultText = '';
        setBusy(true);

        const { touched, missed } = await sweep(
            true,
            isTestPath,
            (count, outstanding) => {
                elements.status.textContent = outstanding === null
                    ? `marked ${count}…`
                    : `marked ${count}, ${outstanding} to go…`;
            },
            expected,
            counts.total || null,
        );

        state.marked = touched;
        console.log('[mark-tests-viewed] marked as viewed:', touched);
        setBusy(false);

        const notes = [`${touched.length} marked`];
        if (state.cancelled) {
            notes.push('stopped');
        }
        if (missed) {
            notes.push(`${missed} never rendered`);
        }
        state.resultPending = tally().pending;
        state.resultText = notes.join(' · ');
        elements.status.textContent = state.resultText;
    }

    async function undoRun() {
        const previous = new Set(state.marked);

        state.cancelled = false;
        state.resultText = '';
        setBusy(true);

        const { touched } = await sweep(
            false,
            (path) => previous.has(path),
            (count) => {
                elements.status.textContent = `unmarked ${count}…`;
            },
            previous,
            null,
        );

        state.marked = [];
        setBusy(false);
        state.resultPending = tally().pending;
        state.resultText = `${touched.length} unmarked`;
        elements.status.textContent = state.resultText;
    }

    /* ------------------------------------------------------------------ *
     * Wiring into GitHub's client-side navigation
     * ------------------------------------------------------------------ */

    const onDiffPage = () => /\/pull\/\d+\/(files|changes)\b/.test(location.pathname);

    function ensureUi() {
        if (payloadCache.pr && !location.pathname.includes(`/pull/${payloadCache.pr}/`)) {
            payloadCache = { pr: null, files: null };
        }

        if (!onDiffPage()) {
            document.getElementById(PANEL_ID)?.remove();
            elements = null;
            return;
        }

        if (!elements || !document.body.contains(elements.container)) {
            document.getElementById(PANEL_ID)?.remove();
            elements = buildPanel();
        }

        refreshCount();
    }

    let debounce = null;
    new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(ensureUi, 300);
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener('popstate', ensureUi);
    document.addEventListener('turbo:load', ensureUi);
    ensureUi();
})();
