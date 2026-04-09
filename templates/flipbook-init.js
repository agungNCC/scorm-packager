/* global St, FLIPBOOK_PAGES, FLIPBOOK_CONTENT_COUNT, FLIPBOOK_HAS_BACK_COVER */

(function () {
    "use strict";

    var FLIPBOOK_THEME = {
        headerBg: "#0a2540",
        footerBg: "#0a2540",
        appBg: "#0d1b2a",
        stageBgTop: "#333333",
        stageBgBottom: "#333333",
        overlayBg: "rgba(10, 37, 64, 0.55)",
        text: "#e8eef5",
        indicator: "#b8d4f0",
        pageBg: "#333333",
        completeAtRatio: 0.7,
    };

    function applyTheme(t) {
        var root = document.documentElement;
        if (!root || !t) return;
        if (t.headerBg) root.style.setProperty("--fb-header-bg", t.headerBg);
        if (t.footerBg) root.style.setProperty("--fb-footer-bg", t.footerBg);
        if (t.appBg) root.style.setProperty("--fb-app-bg", t.appBg);
        if (t.stageBgTop) root.style.setProperty("--fb-stage-bg-top", t.stageBgTop);
        if (t.stageBgBottom) root.style.setProperty("--fb-stage-bg-bottom", t.stageBgBottom);
        if (t.overlayBg) root.style.setProperty("--fb-overlay-bg", t.overlayBg);
        if (t.text) root.style.setProperty("--fb-text", t.text);
        if (t.indicator) root.style.setProperty("--fb-indicator", t.indicator);
        if (t.pageBg) root.style.setProperty("--fb-page-bg", t.pageBg);
    }

    var loadingOverlay = document.getElementById("loadingOverlay");
    var pageIndicator = document.getElementById("pageIndicator");
    var btnFirst = document.getElementById("btnFirst");
    var btnPrev = document.getElementById("btnPrev");
    var btnNext = document.getElementById("btnNext");
    var btnLast = document.getElementById("btnLast");

    var pageFlip = null;
    var totalImages = 0;
    var contentCount = 0;
    var hasBackCover = false;
    var completedSent = false;
    var maxPageVisited = 1;

    function setLoading(on) {
        if (!loadingOverlay) return;
        if (on) loadingOverlay.classList.add("is-visible");
        else loadingOverlay.classList.remove("is-visible");
    }

    function saveBookmark(pageOneBased) {
        try {
            var scorm = window.pipwerks && window.pipwerks.SCORM;
            if (scorm && scorm.connection && scorm.connection.isActive) {
                scorm.set("cmi.core.lesson_location", String(pageOneBased));
                scorm.save();
            }
        } catch (_) { }
    }

    function readBookmark() {
        try {
            var scorm = window.pipwerks && window.pipwerks.SCORM;
            if (scorm && scorm.connection && scorm.connection.isActive) {
                var loc = scorm.get("cmi.core.lesson_location");
                var p = parseInt(loc, 10);
                if (isFinite(p) && p >= 1) return p;
            }
        } catch (_) { }
        return 1;
    }

    function completionThresholdPage() {
        var r = FLIPBOOK_THEME.completeAtRatio;
        if (typeof r !== "number" || r <= 0 || r > 1) r = 0.7;
        return Math.max(1, Math.ceil(contentCount * r));
    }

    function maybeMarkCompleted(highestVisitedOneBased) {
        if (completedSent) return;
        if (highestVisitedOneBased >= completionThresholdPage()) {
            completedSent = true;
            if (typeof window.setLmsStatusCompleted === "function") {
                window.setLmsStatusCompleted();
            }
        }
    }

    // Image index 0 = front cover, content starts at index 1
    function imgIdxToContentPage(idx) {
        return idx; // idx 1 → content page 1, idx 2 → page 2, etc.
    }

    function contentPageToImgIdx(p) {
        return p; // content page 1 → idx 1
    }

    function maxImageIndex() {
        if (totalImages < 1) return 0;
        return totalImages % 2 === 0 ? totalImages - 2 : totalImages - 1;
    }

    function isPortrait() {
        return pageFlip && pageFlip.getOrientation() === "portrait";
    }

    function recenterBook() {
        try { if (pageFlip) pageFlip.update(); } catch (_) { }
        try { updateIndicatorAndNav(); } catch (_) { }
    }

    function scheduleRecenter(delay) {
        window.setTimeout(recenterBook, typeof delay === "number" ? delay : 0);
    }

    function updateIndicatorAndNav() {
        if (!pageFlip) return;
        var idx = pageFlip.getCurrentPageIndex();
        var orient = pageFlip.getOrientation();

        var contentL, contentR;
        if (orient === "portrait") {
            contentL = imgIdxToContentPage(idx);
            contentR = null;
        } else {
            contentL = imgIdxToContentPage(idx);
            contentR = idx + 1 < totalImages ? imgIdxToContentPage(idx + 1) : null;
        }

        // Clamp to content range (1..contentCount), skip covers
        if (contentL < 1) contentL = null;
        if (contentL > contentCount) contentL = null;
        if (contentR !== null && (contentR < 1 || contentR > contentCount)) contentR = null;

        var label = "";
        if (contentL && contentR) {
            label = String(contentL) + "-" + String(contentR) + "/" + String(contentCount);
        } else if (contentL) {
            label = String(contentL) + "/" + String(contentCount);
        } else if (contentR) {
            label = String(contentR) + "/" + String(contentCount);
        } else {
            label = "—";
        }
        if (pageIndicator) pageIndicator.textContent = label;

        var atFirst, atLast;
        if (orient === "portrait") {
            atFirst = idx <= 1;
            atLast = idx >= contentCount;
        } else {
            atFirst = idx <= 0;
            atLast = idx >= maxImageIndex();
        }
        if (btnFirst) btnFirst.disabled = atFirst;
        if (btnPrev) btnPrev.disabled = atFirst;
        if (btnNext) btnNext.disabled = atLast;
        if (btnLast) btnLast.disabled = atLast;

        var visMax = 0;
        if (contentL) visMax = contentL;
        if (contentR && contentR > visMax) visMax = contentR;
        if (visMax > maxPageVisited) maxPageVisited = visMax;
        if (visMax > 0) saveBookmark(visMax);
        maybeMarkCompleted(maxPageVisited);
    }

    function start() {
        applyTheme(FLIPBOOK_THEME);

        if (typeof St === "undefined" || !St.PageFlip) {
            if (pageIndicator) pageIndicator.textContent = "Library flip tidak dimuat";
            setLoading(false);
            return;
        }

        if (!window.FLIPBOOK_PAGES || !window.FLIPBOOK_PAGES.length) {
            if (pageIndicator) pageIndicator.textContent = "Halaman tidak ditemukan";
            setLoading(false);
            return;
        }

        var el = document.getElementById("flipbook");
        if (!el) return;

        totalImages = window.FLIPBOOK_PAGES.length;
        contentCount = window.FLIPBOOK_CONTENT_COUNT || (totalImages - 1);
        hasBackCover = !!window.FLIPBOOK_HAS_BACK_COVER;

        var bookmark = readBookmark();
        var startIdx;
        var orient = window.innerWidth > window.innerHeight ? "landscape" : "portrait";

        if (orient === "portrait") {
            startIdx = contentPageToImgIdx(Math.min(Math.max(1, bookmark), contentCount));
        } else {
            startIdx = 0;
            if (bookmark > 1) {
                var bmIdx = contentPageToImgIdx(Math.min(bookmark, contentCount));
                startIdx = bmIdx % 2 === 0 ? bmIdx - 1 : bmIdx;
                if (startIdx < 0) startIdx = 0;
            }
        }

        maxPageVisited = Math.max(1, bookmark);

        pageFlip = new St.PageFlip(el, {
            width: 480,
            height: 640,
            size: "stretch",
            minWidth: 220,
            maxWidth: 2000,
            minHeight: 220,
            maxHeight: 1600,
            showCover: false,
            mobileScrollSupport: false,
            startPage: startIdx,
            flippingTime: 1050,
            usePortrait: true,
            drawShadow: true,
            maxShadowOpacity: 0.78,
            autoSize: true,
            swipeDistance: 32,
            useMouseEvents: true,
            showPageCorners: true,
        });

        pageFlip.loadFromImages(window.FLIPBOOK_PAGES);

        function nudgeFlipbookLayout() {
            recenterBook();
        }
        window.setTimeout(nudgeFlipbookLayout, 50);
        window.setTimeout(nudgeFlipbookLayout, 350);

        pageFlip.on("flip", updateIndicatorAndNav);
        pageFlip.on("changeOrientation", function () {
            var orient = pageFlip.getOrientation();
            var idx = pageFlip.getCurrentPageIndex();

            if (orient === "portrait") {
                // In portrait, skip covers — jump to nearest content page
                if (idx < 1) {
                    pageFlip.turnToPage(1);
                } else if (idx > contentCount) {
                    pageFlip.turnToPage(contentCount);
                }
            }
            updateIndicatorAndNav();
            scheduleRecenter(0);
            scheduleRecenter(80);
        });

        // Navigation: portrait skips covers
        if (btnFirst) btnFirst.addEventListener("click", function () {
            if (!pageFlip) return;
            pageFlip.turnToPage(isPortrait() ? 1 : 0);
        });
        if (btnPrev) btnPrev.addEventListener("click", function () {
            if (!pageFlip) return;
            var idx = pageFlip.getCurrentPageIndex();
            if (isPortrait() && idx <= 1) return;
            pageFlip.flipPrev("top");
        });
        if (btnNext) btnNext.addEventListener("click", function () {
            if (!pageFlip) return;
            var idx = pageFlip.getCurrentPageIndex();
            if (isPortrait() && idx >= contentCount) return;
            pageFlip.flipNext("top");
        });
        if (btnLast) btnLast.addEventListener("click", function () {
            if (!pageFlip) return;
            if (isPortrait()) {
                pageFlip.turnToPage(contentCount);
            } else {
                pageFlip.turnToPage(maxImageIndex());
            }
        });

        document.body.addEventListener("keydown", function (e) {
            if (!pageFlip) return;
            var idx = pageFlip.getCurrentPageIndex();
            if (e.key === "Home") {
                pageFlip.turnToPage(isPortrait() ? 1 : 0);
            }
            if (e.key === "End") {
                pageFlip.turnToPage(isPortrait() ? contentCount : maxImageIndex());
            }
            if (e.key === "ArrowLeft") {
                e.preventDefault();
                if (isPortrait() && idx <= 1) return;
                pageFlip.flipPrev("top");
            }
            if (e.key === "ArrowRight") {
                e.preventDefault();
                if (isPortrait() && idx >= contentCount) return;
                pageFlip.flipNext("top");
            }
        });

        window.addEventListener("orientationchange", function () {
            window.setTimeout(function () {
                try {
                    window.dispatchEvent(new Event("resize"));
                    recenterBook();
                } catch (_) { }
            }, 400);
        }, { passive: true });

        recenterBook();
        setLoading(false);
    }

    window.addEventListener("load", function () {
        setTimeout(start, 250);
    });
})();
