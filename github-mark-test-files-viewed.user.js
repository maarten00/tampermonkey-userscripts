// ==UserScript==
// @name         GitHub: mark test files as viewed
// @namespace    https://github.com/maarten00
// @version      3.8.0
// @description  Cuts a GitHub pull request diff down to what you actually need to read: marks test files as viewed and folds away finished folders.
// @author       maarten00
// @license      MIT
// @homepageURL  https://github.com/maarten00/tampermonkey-userscripts
// @supportURL   https://github.com/maarten00/tampermonkey-userscripts/issues
// @updateURL    https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-mark-test-files-viewed.user.js
// @downloadURL  https://raw.githubusercontent.com/maarten00/tampermonkey-userscripts/main/github-mark-test-files-viewed.user.js
// @match        https://github.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * Configuration
     * ------------------------------------------------------------------ */

    let startedAt = Date.now();
    let lastPath = null;

    const CONFIG = {
        clickDelayMs: 250,      // Pause between toggles; GitHub throttles rapid-fire requests.
        scrollSettleMs: 400,    // Time given to the lazy-loaded diff to render after scrolling.
        reflowSettleMs: 1500,   // GitHub collapses a diff only once the server confirms; the shift lands late.
        pinFallbackMs: 100,     // Backstop for nudging the view back onto its anchor when frames stop coming.
        scrollStep: 0.6,        // Fraction of the viewport to advance per step.
        maxRuntimeMs: 300000,
        settleWindowMs: 1500,   // Fallback only: how long the count must hold steady when no total is known.
        stallTimeoutMs: 15000,  // Give up waiting for stragglers; rendering can pause for seconds.
        anchorGraceMs: 8000,    // How long to wait for the toolbar before floating the panel instead.
        jumpWaitMs: 4000,       // How long a file jumped to may take to render its toggle.
        jumpPollMs: 50,         // How often to look for it meanwhile.
        requestConcurrency: 6,  // Viewed-state requests in flight at once.
        requestAttempts: 3,     // Tries per file before it counts as failed.
        retryDelayMs: 1000,     // Wait before retrying a throttled request, doubled each time.
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

    // A path is a test when it matches any of these. A bare spec/ folder is not
    // on the list: the word names too many things that are not tests, such as
    // a plugin that writes specifications.
    const TEST_PATTERNS = [
        /(^|\/)(tests?|integrationtests|unittests|featuretests|functionaltests|acceptancetests|browsertests|e2e)\//i,
        /(^|\/)__tests__\//,
        /Test\.php$/,
        /Cest\.php$/,
        /\.(test|spec)\.[jt]sx?$/,
        /_spec\.rb$/,
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

    /**
     * The extension is what tells a path from any other text with a slash in
     * it. Files without one, such as LICENSE or a Makefile, only count when the
     * embedded file list names them.
     */
    function pathFromText(text) {
        const trimmed = clean(text);
        if (!trimmed || trimmed.length > 200) {
            return null;
        }

        const isPath = (candidate) => PATH_LIKE.test(candidate) || Boolean(payloadPaths()?.has(candidate));
        if (isPath(trimmed)) {
            return trimmed;
        }

        // Accessible names such as "Mark tests/FooTest.php as viewed".
        const embedded = trimmed.match(/[\w.@~+-]+(?:\/[\w.@~+-]+)+/);

        return embedded && isPath(embedded[0]) ? embedded[0] : null;
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

    const currentPr = () => location.pathname.match(/\/pull\/(\d+)/)?.[1] ?? null;

    const emptyCache = (pr) => ({
        pr, files: null, paths: null, digests: null, live: new Map(), scanned: false, requested: false,
    });

    let payloadCache = emptyCache(null);

    /** Everything known about the pull request in the URL, started afresh on moving to another. */
    function prCache() {
        const current = currentPr();
        if (payloadCache.pr !== current) {
            payloadCache = emptyCache(current);
        }

        return payloadCache;
    }

    function adoptRoute(cache, route) {
        if (!Array.isArray(route?.diffSummaries) || String(route.pullRequest?.number) !== cache.pr) {
            return false;
        }

        cache.files = route.diffSummaries.map((summary) => ({
            path: summary.path,
            viewed: Boolean(summary.markedAsViewed),
        }));
        cache.paths = new Set(cache.files.map((file) => file.path));
        cache.digests = new Map(route.diffSummaries
            .filter((summary) => summary.pathDigest)
            .map((summary) => [summary.path, summary.pathDigest]));

        return true;
    }

    /**
     * GitHub ships the complete file list in the page as JSON, and it is there
     * long before the diffs themselves render. The script node survives
     * client-side navigation untouched, so it goes stale as soon as you move to
     * another pull request; it is only trusted when its number matches the URL.
     * Arriving by client-side navigation leaves no list for this pull request in
     * the page at all, so then it is asked for instead.
     */
    function payloadFiles() {
        const cache = prCache();
        if (!cache.pr || cache.files) {
            return cache.files;
        }

        if (!cache.scanned) {
            cache.scanned = true;

            for (const script of document.querySelectorAll('script[type="application/json"]')) {
                let route;
                try {
                    route = JSON.parse(script.textContent)?.payload?.pullRequestsChangesRoute;
                } catch {
                    continue;
                }

                if (adoptRoute(cache, route)) {
                    break;
                }
            }
        }

        if (!cache.files && !cache.requested && /\/pull\/\d+\/changes\b/.test(location.pathname)) {
            cache.requested = true;
            requestRoute(cache);
        }

        return cache.files;
    }

    /** The changes page hands over the same JSON when asked for it. */
    async function fetchRoute() {
        const response = await fetch(location.pathname, {
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            cache: 'no-store',
        });

        return (await response.json())?.payload?.pullRequestsChangesRoute ?? null;
    }

    async function requestRoute(cache) {
        try {
            if (adoptRoute(cache, await fetchRoute()) && cache === payloadCache) {
                refreshCount();
            }
        } catch {
            // Then the tally makes do with what has rendered.
        }
    }

    function payloadPaths() {
        payloadFiles();

        return prCache().paths;
    }

    /**
     * Viewed state as last seen on the page. A large diff is virtualized and
     * unmounts files scrolled out of view, while the payload only knows how
     * things stood at load, so whatever was seen is remembered instead.
     */
    function remember(files) {
        const { live } = prCache();
        for (const file of files) {
            live.set(file.path, isViewed(file.control));
        }

        return live;
    }

    /**
     * What the diff contains and how much of it is done. Paths come from the
     * payload when it is usable, so the tally is right before rendering
     * finishes; viewed state prefers what the page has shown, which is live.
     */
    function tally() {
        const live = remember(scanFiles());
        const payload = payloadFiles();
        const known = payload ?? [...live].map(([path, viewed]) => ({ path, viewed }));

        // How many files the diff really holds: the payload knows, and failing
        // that GitHub's own counter carries the total from the first paint.
        const total = payload ? payload.length : (totalFileCount() ?? live.size);

        const tests = known.filter((file) => isTestPath(file.path));
        const pending = tests.filter((file) => !(live.get(file.path) ?? file.viewed));

        return {
            hasPayload: Boolean(payload),
            total,
            seen: live.size,
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

    /** Every file in the diff mapped to whether it is viewed; what the page has shown wins. */
    function fileViewState() {
        const viewed = new Map();

        for (const file of payloadFiles() ?? []) {
            viewed.set(file.path, file.viewed);
        }
        for (const [path, isSeen] of remember(scanFiles())) {
            viewed.set(path, isSeen);
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

    const frameTopOf = (scroller) => (scroller === document.scrollingElement || scroller === document.documentElement
        ? 0
        : scroller.getBoundingClientRect().top);

    // A row of the virtualized diff list a large pull request gets: only the
    // rows around the viewport exist, and each loads its diff after it mounts.
    const VIRTUAL_ROW = '[data-path-digest][data-index]';

    /**
     * Brings one file into view through its #diff- anchor, as a link from the
     * file tree does, and waits for its toggle. GitHub follows the URL even
     * when it is replaced rather than navigated, and replacing keeps the jumps
     * out of the history: a few hundred pushed entries would leave nothing else
     * on the back button.
     */
    async function jumpTo(digest) {
        const hash = `#diff-${digest}`;
        if (location.hash === hash) {
            location.replace('#');      // The same hash again is no change, and so no jump.
        }
        location.replace(hash);

        const deadline = Date.now() + CONFIG.jumpWaitMs;
        while (Date.now() < deadline && !document.getElementById(`diff-${digest}`)?.querySelector(VIEWED_BUTTON)) {
            await sleep(CONFIG.jumpPollMs);
        }
    }

    /**
     * Pins the reader's view in place for the length of a sweep.
     *
     * Toggling a file collapses or expands its diff, but only about a second
     * later, once GitHub has heard back from the server. A file above the
     * viewport then drags everything below it along by the full height of that
     * diff, a thousand pixels at a time, and the browser's own scroll anchoring
     * is no help: the diff list renders with content-visibility, so the
     * elements it would anchor to are not rendered at all.
     *
     * So the file header the reader is looking at is remembered and put back on
     * its pixel, over and over, for as long as the sweep runs. Correcting on
     * its own schedule rather than after each click means the clicking never
     * has to wait for a reflow that has not landed yet.
     */
    function pinView(scroller) {
        const frameTop = frameTopOf(scroller);
        const scrollTop = scroller.scrollTop;

        // The first header still on screen, or failing that the next one down;
        // either way it moves exactly as much as the reader's view does.
        function find() {
            let found = null;

            for (const node of document.querySelectorAll(FILE_HEADER)) {
                const box = node.getBoundingClientRect();
                found = { node, offset: box.top };
                if (box.bottom > frameTop) {
                    break;
                }
            }

            return found;
        }

        function correctTo(target) {
            if (!target) {
                return;
            }
            if (!target.node.isConnected) {
                scroller.scrollTop = scrollTop;
                return;
            }

            const drift = target.node.getBoundingClientRect().top - target.offset;
            if (drift) {
                scroller.scrollTop += drift;
            }
        }

        const home = find();
        let anchor = home;
        let live = true;

        // Correcting inside an animation frame puts the view back before the
        // shifted layout is ever painted, so the reader sees nothing move. A
        // background tab stops painting altogether, and there the timer keeps
        // it ticking over.
        function schedule() {
            let fired = false;

            const run = () => {
                if (fired || !live) {
                    return;
                }

                fired = true;
                clearTimeout(timer);
                correctTo(anchor);
                schedule();
            };

            const timer = setTimeout(run, CONFIG.pinFallbackMs);
            requestAnimationFrame(run);
        }

        schedule();

        // A jump swaps out every header a virtualized list had rendered, and a
        // lost anchor means snapping back to the start, so jumping lets go.
        return {
            reset: () => { anchor = find(); },      // After a deliberate scroll, the new position is the one to hold.
            release: () => { anchor = null; },
            stop: () => { live = false; },
            restore: () => correctTo(home),
        };
    }

    /* ------------------------------------------------------------------ *
     * Sweeping the diff
     * ------------------------------------------------------------------ */

    const state = { pr: null, running: false, cancelled: false, marked: [], resultText: '', resultPending: 0 };

    /**
     * Scans and toggles until every target has been dealt with.
     *
     * Reaching the bottom is not the finish line: GitHub streams the diff in
     * over several seconds, so early on the page is short and most files simply
     * do not exist yet. The sweep therefore waits for stragglers to arrive and
     * only gives up when nothing new has appeared for a while.
     *
     * Scrolling is a last resort rather than the method. The current diff view
     * puts every file in the page up front and hydrates the toggles by itself,
     * so scrolling past them buys nothing and only throws the reader around.
     * The classic view does render on scroll, so a round that turns up nothing
     * new advances a step to shake the next batch loose. A large pull request
     * gets a virtualized list that only ever holds the files in view, and there
     * the sweep jumps from one target to the next by its #diff- anchor, so no
     * time goes on rendering the files in between. Whatever the sweep does
     * move, it moves back when it is done.
     */
    async function sweep(desired, matches, onProgress, expected, minSeen) {
        const touched = new Set();
        const handled = new Set();
        const deadline = Date.now() + CONFIG.maxRuntimeMs;
        const scroller = getScroller();
        const pin = pinView(scroller);
        const origin = { url: location.href, state: history.state, scrollTop: scroller.scrollTop, inView: fileInView(scroller) };

        const outstanding = () => (expected ? [...expected].filter((path) => !handled.has(path)).length : null);

        // Jumping needs the anchor of each file, which only the payload knows.
        const jumped = new Set();
        const digests = expected ? prCache().digests : null;
        const nextJump = () => (digests
            ? [...expected].find((path) => !handled.has(path) && !jumped.has(path) && digests.has(path))
            : undefined);

        let lastProgressAt = Date.now();
        let idleStreak = 0;
        let scrolled = false;

        try {
            while (Date.now() < deadline && !state.cancelled) {
                let progressed = false;
                const files = scanFiles();
                remember(files);

                for (const file of files) {
                    if (handled.has(file.path)) {
                        continue;
                    }

                    handled.add(file.path);
                    progressed = true;

                    if (!matches(file.path) || isViewed(file.control) === desired) {
                        continue;
                    }

                    file.control.click();
                    prCache().live.set(file.path, desired);
                    touched.add(file.path);
                    onProgress(touched.size, outstanding());
                    await sleep(CONFIG.clickDelayMs);
                }

                // Done when every intended file is handled; without that list, when
                // every file the diff promises has at least been seen.
                const finished = expected
                    ? outstanding() === 0
                    : minSeen !== null && handled.size >= minSeen;

                if (finished) {
                    break;
                }

                if (progressed) {
                    lastProgressAt = Date.now();
                    idleStreak = 0;
                } else {
                    idleStreak++;

                    if (Date.now() - lastProgressAt >= CONFIG.stallTimeoutMs) {
                        break;
                    }
                }

                // A virtualized list never renders a file until it is in view, so
                // there the next target is fetched as soon as the ones on screen
                // are done. Elsewhere files turn up on their own, and a jump only
                // goes after one that a whole round has not produced.
                const jump = !progressed || document.querySelector(VIRTUAL_ROW) ? nextJump() : undefined;
                if (jump) {
                    jumped.add(jump);
                    pin.release();
                    await jumpTo(digests.get(jump));
                    continue;
                }

                if (!progressed) {
                    if (!atBottom(scroller)) {
                        // Nothing arrived on its own, so this is the classic view:
                        // it renders what has been scrolled past and nothing more.
                        scrolled = true;
                        scroller.scrollTop += Math.round(scroller.clientHeight * CONFIG.scrollStep);
                        pin.reset();
                    } else if (expected === null && minSeen === null && idleStreak >= 2) {
                        break;      // Nothing left to scroll past and no total to wait for.
                    }
                }

                await sleep(CONFIG.scrollSettleMs);
            }

            // The last few toggles are still waiting on the server, and their
            // reflow has to be caught too before the pin is let go.
            if (touched.size) {
                await sleep(CONFIG.reflowSettleMs);
            }
        } finally {
            pin.stop();
        }

        if (jumped.size) {
            await returnTo(origin, scroller);
        } else if (scrolled) {
            pin.restore();
        }

        return { touched: [...touched], missed: outstanding() ?? 0 };
    }

    /** Puts the reader back after a run of jumps, on the file and the URL they had. */
    async function returnTo(origin, scroller) {
        const digest = origin.inView?.slice('diff-'.length);
        if (digest) {
            await jumpTo(digest);
        } else {
            scroller.scrollTop = origin.scrollTop;
        }

        history.replaceState(origin.state, '', origin.url);
    }

    /* ------------------------------------------------------------------ *
     * Marking without the diff
     *
     * The toggle in the current diff view is one request to the pull
     * request's file_review endpoint, so files can be marked without being
     * rendered. The page never hears of requests it did not send itself, so it
     * is reloaded afterwards, and the run's result and undo list ride along in
     * sessionStorage.
     * ------------------------------------------------------------------ */

    const RUN_KEY = `${STORAGE_PREFIX}last-run`;

    /** Only the current view has the endpoint. The classic one posts a form. */
    function reviewEndpoint() {
        const base = location.pathname.match(/^\/[^/]+\/[^/]+\/pull\/\d+(?=\/changes\b)/)?.[0];
        const nonce = document.querySelector('meta[name="fetch-nonce"]')?.content;

        return base && nonce ? { url: `${base}/file_review`, nonce } : null;
    }

    /**
     * 'ok' once GitHub has taken the change, 'throttled' when it keeps
     * answering 429, and 'refused' for anything else. Unmarking has to be a
     * real DELETE: a POST carrying _method is answered with a 200 and changes
     * nothing.
     */
    async function sendReview(endpoint, path, viewed) {
        const body = viewed ? { path, viewed: 'viewed' } : { path, _method: 'delete' };

        for (let attempt = 0; attempt < CONFIG.requestAttempts; attempt++) {
            let response = null;
            try {
                response = await fetch(endpoint.url, {
                    method: viewed ? 'POST' : 'DELETE',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        'GitHub-Verified-Fetch': 'true',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-Fetch-Nonce': endpoint.nonce,
                    },
                    body: JSON.stringify(body),
                });
            } catch {
                // The network dropped it. That is worth another try.
            }

            if (response?.ok) {
                return 'ok';
            }
            if (response && response.status !== 429 && response.status < 500) {
                return 'refused';   // Asking again will not change it.
            }
            if (attempt === CONFIG.requestAttempts - 1) {
                return response?.status === 429 ? 'throttled' : 'refused';
            }

            await sleep(CONFIG.retryDelayMs * 2 ** attempt);
        }

        return 'refused';
    }

    /** Reads one file's state back from GitHub. */
    async function confirmReview(path, viewed) {
        try {
            const summary = (await fetchRoute())?.diffSummaries?.find((candidate) => candidate.path === path);

            return Boolean(summary?.markedAsViewed) === viewed;
        } catch {
            return false;
        }
    }

    /**
     * Sets every path to the desired state, a few requests at a time. Returns
     * null when this is not possible at all, so the caller can click instead.
     *
     * Throttling is the exception. GitHub limits how many files can be marked
     * in a while, its own toggle included, so clicking would fail silently.
     * The run stops and says so instead.
     */
    async function setViewedRemotely(paths, viewed, onProgress) {
        const endpoint = reviewEndpoint();
        const queue = [...paths];
        if (!endpoint || queue.length === 0) {
            return null;
        }

        const total = queue.length;
        const touched = [];
        let failed = 0;

        // The first one goes alone and is read back: should the endpoint have
        // moved, or answer 200 without doing anything, that costs one request
        // rather than a burst of them, and clicking takes over.
        const first = queue.shift();
        const outcome = await sendReview(endpoint, first, viewed);
        if (outcome === 'throttled') {
            return { touched, failed, throttled: true, left: total };
        }
        if (outcome === 'refused' || !(await confirmReview(first, viewed))) {
            return null;
        }
        touched.push(first);
        onProgress(touched.length, queue.length);

        let throttled = false;

        async function worker() {
            while (queue.length > 0 && !state.cancelled && !throttled) {
                const path = queue.shift();
                const result = await sendReview(endpoint, path, viewed);
                if (result === 'ok') {
                    touched.push(path);
                } else if (result === 'throttled') {
                    throttled = true;
                    queue.push(path);
                } else {
                    failed++;
                }
                onProgress(touched.length, total - touched.length - failed);
            }
        }

        await Promise.all(Array.from({ length: CONFIG.requestConcurrency }, worker));

        return { touched, failed, throttled, left: queue.length };
    }

    /** The diff currently at the top of the view, unless that is the top of the page. */
    function fileInView(scroller) {
        if (scroller.scrollTop < scroller.clientHeight) {
            return null;
        }

        const frameTop = frameTopOf(scroller);
        for (const node of document.querySelectorAll('[id^="diff-"]')) {
            if (/^diff-[0-9a-f]{64}$/.test(node.id) && node.getBoundingClientRect().bottom > frameTop) {
                return node.id;
            }
        }

        return null;
    }

    /**
     * Reloads so the diff shows what the endpoint changed. GitHub opens a
     * #diff- link at that file, which puts the reader back where they were.
     */
    function reloadWith(result) {
        try {
            sessionStorage.setItem(RUN_KEY, JSON.stringify({ pr: currentPr(), ...result }));
        } catch {
            // The reload still shows the new state; only the summary and Undo are lost.
        }

        const inView = fileInView(getScroller());
        history.replaceState(history.state, '', location.pathname + location.search + (inView ? `#${inView}` : ''));
        location.reload();
    }

    /** Ends an endpoint run, reloading to show it when anything changed. */
    function finishRemotely(remote, verb, stillMarked) {
        const notes = [`${remote.touched.length} ${verb}`];
        if (state.cancelled) {
            notes.push('stopped');
        }
        if (remote.failed) {
            notes.push(`${remote.failed} failed`);
        }
        if (remote.throttled) {
            notes.push(`throttled by GitHub, ${remote.left} left for later`);
        }

        const resultText = notes.join(' · ');
        console.log(`[mark-tests-viewed] ${verb}:`, remote.touched);

        if (remote.touched.length === 0) {
            state.marked = stillMarked;
            setBusy(false);
            state.resultPending = tally().pending;
            state.resultText = resultText;
            elements.status.textContent = resultText;
            return;
        }

        elements.status.textContent = `${resultText} · reloading…`;
        reloadWith({ marked: stillMarked, resultText });
    }

    /**
     * Clicking cannot tell whether GitHub kept a change: the toggle flips at
     * once and stays flipped when the request is turned away. So the page is
     * asked afterwards, and its answer replaces what the tally believed.
     * Returns the paths that did not stick.
     */
    async function unsaved(paths, viewed) {
        const cache = prCache();
        try {
            if (!adoptRoute(cache, await fetchRoute())) {
                return [];
            }
        } catch {
            return [];
        }

        const saved = new Map(cache.files.map((file) => [file.path, file.viewed]));
        const lost = paths.filter((path) => saved.get(path) !== viewed);
        for (const path of lost) {
            cache.live.set(path, !viewed);
        }

        return lost;
    }

    /**
     * Brings a new panel up to date. Run state belongs to one pull request, so
     * whatever another one left is dropped, and a run that reloaded the page
     * hands over its summary and undo list.
     */
    function restoreRun() {
        if (state.pr !== currentPr()) {
            Object.assign(state, { pr: currentPr(), marked: [], resultText: '', resultPending: 0 });
        }

        let saved = null;
        try {
            saved = JSON.parse(sessionStorage.getItem(RUN_KEY));
            sessionStorage.removeItem(RUN_KEY);
        } catch {
            // Storage is off limits, so there is nothing to pick up.
        }

        if (saved?.pr === state.pr) {
            state.marked = Array.isArray(saved.marked) ? saved.marked : [];
            state.resultText = String(saved.resultText || '');
            state.resultPending = tally().pending;
        }

        elements.status.textContent = state.resultText;
        elements.undo.hidden = state.marked.length === 0;
    }

    /* ------------------------------------------------------------------ *
     * Panel
     * ------------------------------------------------------------------ */

    const MENU_OPTIONS = [
        {
            key: 'skipFactories',
            label: 'Count factories and seeders as tests',
            hint: 'Includes Database/Factories, Seeders and Seeds when marking files viewed.',
        },
        {
            key: 'collapseViewedDirs',
            label: 'Fold away finished folders',
            hint: 'Collapses sidebar folders in which every file is viewed. Reapplied on reload, since GitHub forgets it.',
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
            #${PANEL_ID} .tm-menu-wrap { position: relative; display: inline-flex; }
            #${PANEL_ID} .tm-count {
                display: inline-block; min-width: 16px; padding: 2px 6px; border-radius: 20px;
                font-size: 12px; font-weight: 600; line-height: 12px; text-align: center;
                background: var(--bgColor-neutral-muted, rgba(129, 139, 152, .12));
            }
            #${PANEL_ID} .tm-menu {
                position: absolute; top: calc(100% + 4px); right: 0; z-index: 2147483000;
                min-width: 252px; padding: 8px; text-align: left;
                font: 400 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                color: var(--fgColor-default, #1f2328);
                background: var(--overlay-bgColor, var(--bgColor-default, #ffffff));
                border: 1px solid var(--borderColor-default, #d1d9e0);
                border-radius: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, .15);
            }
            #${PANEL_ID} .tm-menu-heading {
                padding: 2px 2px 6px; font-weight: 600; font-size: 12px;
                border-bottom: 1px solid var(--borderColor-muted, #d1d9e0); margin-bottom: 6px;
            }
            #${PANEL_ID} .tm-menu label {
                display: flex; gap: 8px; align-items: flex-start; cursor: pointer; padding: 4px 2px;
                font-weight: 400;   /* GitHub bolds labels in this part of the page. */
            }
            #${PANEL_ID} .tm-menu input { margin: 2px 0 0; flex: none; }
            #${PANEL_ID} .tm-menu .tm-hint {
                display: block; margin-top: 1px; font-size: 11px; font-weight: 400;
                color: var(--fgColor-muted, #59636e);
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
        // Re-use the known anchor while it lives: searching for it again scans
        // the whole document, and re-attaching needs to be cheap.
        const counter = mountedCounter && document.body.contains(mountedCounter)
            ? mountedCounter
            : findCounterElement();
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

        // Nothing to anchor to yet. Early in a load that only means the toolbar
        // has not rendered, so wait rather than dropping the panel in a corner
        // it would then be stuck in.
        if (Date.now() - startedAt < CONFIG.anchorGraceMs) {
            return null;
        }

        Object.assign(container.style, {
            position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483000', padding: '8px',
            background: 'var(--bgColor-default, #ffffff)',
            border: '1px solid var(--borderColor-default, #d1d9e0)',
            borderRadius: '6px', boxShadow: '0 3px 12px rgba(0,0,0,.15)',
        });

        return 'floating';
    }

    const BUTTON_REF = '[data-component="Button"][data-size="small"]';
    const ICON_BUTTON_REF = '[data-component="IconButton"][data-size="small"]';

    const FALLBACK_BUTTON_STYLE = 'padding: 3px 10px; font: inherit; font-weight: 600; cursor: pointer;'
        + ' white-space: nowrap; color: var(--fgColor-default, #1f2328);'
        + ' background: var(--bgColor-muted, #f6f8fa);'
        + ' border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px;';

    /**
     * GitHub's own button styling, borrowed rather than reproduced. Only the
     * prc-Button-* classes are taken — the rest of a button's class list is
     * particular to where it sits — and they are read off the page instead of
     * hard-coded, because the hashes change whenever GitHub rebuilds.
     */
    function primerClasses(selector) {
        const reference = document.querySelector(selector);
        const classes = reference
            ? [...reference.classList].filter((name) => name.startsWith('prc-Button-'))
            : [];

        return classes.length > 0 ? classes.join(' ') : null;
    }

    const innerClass = (part) => document.querySelector(`${BUTTON_REF} [data-component="${part}"]`)?.className || null;

    /**
     * GitHub's counter pill, for the number in front of the label. The variant
     * meant for use inside a button is tried first and queried separately: a
     * comma-separated selector returns whichever matches earliest in the
     * document, not whichever selector was listed first.
     */
    function counterClasses() {
        const reference = document.querySelector('[class*="prc-Button-CounterLabel"]')
            || document.querySelector('[class*="prc-CounterLabel"]');

        const classes = reference
            ? [...reference.classList].filter((name) => name.includes('CounterLabel'))
            : [];

        return classes.length > 0 ? classes.join(' ') : null;
    }

    /** The cog, copied from the diff settings button so it always matches. */
    function gearIcon() {
        const octicon = document.querySelector('svg.octicon-gear');
        if (octicon) {
            return octicon.cloneNode(true);
        }

        const fallback = document.createElement('span');
        fallback.textContent = '⚙';
        return fallback;
    }

    function createButton({ label, icon }) {
        const button = document.createElement('button');
        button.type = 'button';

        const base = primerClasses(icon ? ICON_BUTTON_REF : BUTTON_REF);
        if (base) {
            button.className = base;
            button.setAttribute('data-component', icon ? 'IconButton' : 'Button');
            button.setAttribute('data-size', 'small');
            button.setAttribute('data-variant', 'default');
        } else {
            button.style.cssText = FALLBACK_BUTTON_STYLE;
        }

        if (icon) {
            button.append(gearIcon());
            return button;
        }

        const contentClass = innerClass('buttonContent');
        const labelClass = innerClass('text');

        const content = document.createElement('span');
        content.setAttribute('data-component', 'buttonContent');
        content.className = contentClass || '';

        const counter = document.createElement('span');
        counter.dataset.role = 'count';
        counter.className = counterClasses() || 'tm-count';
        counter.hidden = true;

        const text = document.createElement('span');
        text.setAttribute('data-component', 'text');
        text.className = labelClass || '';
        text.textContent = label;

        content.append(counter, text);
        button.append(content);

        return button;
    }

    function setButtonCount(button, count) {
        const counter = button.querySelector('[data-role="count"]');
        if (!counter) {
            return;
        }

        counter.hidden = count === null;
        if (count !== null) {
            counter.textContent = String(count);
        }
    }

    /**
     * aria-disabled rather than the disabled attribute: Primer styles both the
     * same way, but a genuinely disabled button drops out of the tab order and
     * swallows the hover that shows its tooltip — losing the explanation of why
     * it cannot be pressed just when it is needed.
     */
    function setButtonDisabled(button, disabled) {
        button.setAttribute('aria-disabled', String(disabled));
    }

    const isButtonDisabled = (button) => button.getAttribute('aria-disabled') === 'true';

    /** Writes into the label span when there is one, so styling survives. */
    function setButtonLabel(button, text) {
        const label = button.querySelector('[data-component="text"]');
        if (label) {
            label.textContent = text;
        } else {
            button.textContent = text;
        }
    }

    function buildPanel() {
        const container = document.createElement('div');
        container.id = PANEL_ID;
        container.style.cssText = `
            display: inline-flex; align-items: center; gap: 8px; margin-right: 8px;
            font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: var(--fgColor-default, #1f2328); vertical-align: middle;
        `;

        const button = createButton({ label: 'Mark tests viewed' });

        const spinner = document.createElement('span');
        spinner.className = 'tm-spinner';
        spinner.hidden = true;

        const status = document.createElement('span');
        status.setAttribute('aria-live', 'polite');
        status.style.cssText = 'color: var(--fgColor-muted, #59636e); white-space: nowrap;';


        // The settings live outside the main button, which disappears whenever
        // there is nothing to mark; they have to stay reachable in every state.
        const menuWrap = document.createElement('span');
        menuWrap.className = 'tm-menu-wrap';

        const chevron = createButton({ icon: true });
        chevron.title = 'Diff settings';
        chevron.setAttribute('aria-label', 'Open diff helper settings');
        chevron.setAttribute('aria-haspopup', 'true');
        chevron.setAttribute('aria-expanded', 'false');

        const menu = document.createElement('div');
        menu.className = 'tm-menu';
        menu.hidden = true;

        const heading = document.createElement('div');
        heading.className = 'tm-menu-heading';
        heading.textContent = 'Diff settings';
        menu.append(heading);

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

        const undo = createButton({ label: 'Undo' });
        undo.hidden = true;

        ensureStyle();
        container.append(spinner, button, undo, status, menuWrap);

        const placement = mount(container);
        if (placement === null) {
            container.remove();
            return { placement: null };
        }

        button.addEventListener('click', () => {
            if (isButtonDisabled(button)) {
                return;
            }

            if (state.running) {
                cancel();
            } else {
                start();
            }
        });
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

        return { container, button, spinner, status, undo, menu, chevron, placement };
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

        if (counts.seen !== scanState.lastCount) {
            scanState.lastCount = counts.seen;
            scanState.stableSince = now;
        }

        // The tally is final as soon as the payload is readable, and marking
        // goes through the endpoint without waiting for anything to render.
        // Only without the payload does the count have to wait for the diff.
        const stalled = now - scanState.stableSince >= CONFIG.stallTimeoutMs;
        const loading = !counts.hasPayload && (counts.total === 0
            ? now - scanState.stableSince < CONFIG.settleWindowMs
            : counts.seen < counts.total && !stalled);

        elements.spinner.hidden = !loading;
        elements.container.setAttribute('aria-busy', String(loading));

        const actionable = counts.tests > 0 && counts.pending > 0;
        setButtonDisabled(elements.button, !actionable);

        if (actionable) {
            setButtonCount(elements.button, counts.pending);
            setButtonLabel(elements.button, 'Mark tests viewed');
            elements.button.title = `${counts.tests} of ${counts.total} changed files match the test patterns.`
                + (counts.pending < counts.tests ? `\n${counts.tests - counts.pending} already viewed.` : '')
                + (loading ? `\n${counts.seen} loaded so far; the rest are waited for.` : '')
                + '\nMarks each one with GitHub\'s own "Viewed" toggle'
                + (counts.hasPayload && reviewEndpoint() ? ', then reloads to show them folded.' : '.');
        } else if (counts.tests > 0) {
            setButtonCount(elements.button, counts.tests);
            setButtonLabel(elements.button, 'All tests viewed');
            elements.button.title = 'Every file matching the test patterns is already marked as viewed.'
                + '\nUse the cog to change what counts as a test.';
        } else {
            setButtonCount(elements.button, null);
            setButtonLabel(elements.button, loading ? 'Checking for tests…' : 'No test files');
            elements.button.title = loading
                ? 'Still waiting for GitHub to load the file list.'
                : `None of the ${counts.total} changed files match the test patterns.`
                    + '\nUse the cog to change what counts as a test.';
        }

        // A finished run's summary holds until there is something new to do.
        if (state.resultText && counts.pending > state.resultPending) {
            state.resultText = '';
        }

        if (!state.resultText) {
            if (loading) {
                elements.status.textContent = `loading… ${counts.seen}/${counts.total}`;
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
            setButtonDisabled(elements.button, false);
            setButtonCount(elements.button, null);
            setButtonLabel(elements.button, 'Cancel');
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
        const progress = (count, outstanding) => {
            elements.status.textContent = outstanding === null
                ? `marked ${count}…`
                : `marked ${count}, ${outstanding} to go…`;
        };

        state.cancelled = false;
        state.marked = [];
        state.resultText = '';
        setBusy(true);

        const remote = expected && await setViewedRemotely(expected, true, progress);
        if (remote) {
            finishRemotely(remote, 'marked', remote.touched);
            return;
        }

        const { touched, missed } = await sweep(true, isTestPath, progress, expected, counts.total || null);
        const lost = expected ? await unsaved(touched, true) : [];

        state.marked = touched.filter((path) => !lost.includes(path));
        console.log('[mark-tests-viewed] marked as viewed:', state.marked);
        setBusy(false);

        const notes = [`${state.marked.length} marked`];
        if (state.cancelled) {
            notes.push('stopped');
        }
        if (missed) {
            notes.push(`${missed} never rendered`);
        }
        if (lost.length) {
            notes.push(`${lost.length} not saved by GitHub`);
        }
        state.resultPending = tally().pending;
        state.resultText = notes.join(' · ');
        elements.status.textContent = state.resultText;
    }

    async function undoRun() {
        const previous = new Set(state.marked);

        const progress = (count) => {
            elements.status.textContent = `unmarked ${count}…`;
        };

        state.cancelled = false;
        state.resultText = '';
        setBusy(true);

        const remote = await setViewedRemotely(previous, false, progress);
        if (remote) {
            const undone = new Set(remote.touched);
            finishRemotely(remote, 'unmarked', [...previous].filter((path) => !undone.has(path)));
            return;
        }

        const { touched } = await sweep(false, (path) => previous.has(path), progress, previous, null);
        const lost = prCache().files ? await unsaved(touched, false) : [];

        state.marked = lost;
        setBusy(false);
        state.resultPending = tally().pending;
        state.resultText = `${touched.length - lost.length} unmarked`
            + (lost.length ? ` · ${lost.length} not saved by GitHub` : '');
        elements.status.textContent = state.resultText;
    }

    /* ------------------------------------------------------------------ *
     * Wiring into GitHub's client-side navigation
     *
     * A user script is injected when a document loads, and GitHub only loads
     * one when you arrive from outside the site. Opening a pull request from
     * the list, or its Files tab from the pull request, is a pushState away
     * and injects nothing. Hence the match on the whole of github.com: the
     * script has to already be running by the time the diff appears, and
     * ensureUi decides for itself whether the page is one of its own.
     * ------------------------------------------------------------------ */

    const onDiffPage = () => /\/pull\/\d+\/(files|changes)\b/.test(location.pathname);

    function ensureUi() {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            startedAt = Date.now();
        }

        prCache();

        if (!onDiffPage()) {
            document.getElementById(PANEL_ID)?.remove();
            elements = null;
            return;
        }

        if (elements && !document.body.contains(elements.container)) {
            // React re-rendered the toolbar and took the panel with it. Putting
            // the same node straight back keeps its state and avoids the blink
            // that rebuilding on the next debounce would cause.
            elements.placement = mount(elements.container);
        } else if (!elements) {
            document.getElementById(PANEL_ID)?.remove();
            const built = buildPanel();
            elements = built.placement === null ? null : built;

            if (elements) {
                restoreRun();
            }
        }

        refreshCount();
    }

    let debounce = null;
    new MutationObserver(() => {
        // Re-attachment is checked on every batch, unthrottled: a debounce here
        // is exactly how long the panel would be missing from the page.
        if (elements && !document.body.contains(elements.container) && onDiffPage()) {
            elements.placement = mount(elements.container);
        }

        clearTimeout(debounce);
        debounce = setTimeout(ensureUi, 300);
    }).observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('popstate', ensureUi);
    document.addEventListener('turbo:load', ensureUi);
    ensureUi();
})();
