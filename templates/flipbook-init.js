/* global St, FLIPBOOK_PAGES */

(function () {
    "use strict";

    // =========================
    // THEME CONFIG (edit manual)
    // pageBg = latar halaman + warna dasar PDF→PNG + patch kanvas page-flip (server membaca nilai ini dari file ini).
    // completeAtRatio = selesai SCORM setelah peserta pernah mencapai halaman ke-N (N = ceil(ratio * jumlah halaman)).
    // Bookmark SCORM: cmi.core.lesson_location disetel ke halaman terakhir yang terlihat (simpan + resume).
    // =========================
    /** Selaraskan dengan opsi showCover di St.PageFlip di bawah */
    var FLIPBOOK_SHOW_COVER = true;

    var FLIPBOOK_THEME = {
        headerBg: "#0a2540",
        footerBg: "#0a2540",
        appBg: "#0d1b2a",
        stageBgTop: "#000000",
        stageBgBottom: "#000000",
        overlayBg: "rgba(10, 37, 64, 0.55)",
        text: "#e8eef5",
        indicator: "#b8d4f0",
        pageBg: "#000000",
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
    var pageCount = 0;
    var completedSent = false;
    /** Halaman tertinggi yang pernah dikunjungi (untuk completion %) */
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
        return Math.max(1, Math.ceil(pageCount * r));
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

    function maxLeftPageIndex() {
        if (pageCount < 1) return 0;
        return pageCount % 2 === 1 ? pageCount - 1 : pageCount - 2;
    }

    function recenterBook() {
        try {
            if (pageFlip) pageFlip.update();
        } catch (_) { }
        try {
            updateIndicatorAndNav();
        } catch (_) { }
    }

    function scheduleRecenter(delay) {
        window.setTimeout(recenterBook, typeof delay === "number" ? delay : 0);
    }

    function updateIndicatorAndNav() {
        if (!pageFlip) return;
        var idx = pageFlip.getCurrentPageIndex();
        var orient = pageFlip.getOrientation();
        var label = "";

        if (orient === "portrait") {
            label = String(idx + 1) + "/" + String(pageCount);
        } else if (FLIPBOOK_SHOW_COVER && idx === 0) {
            label = "1/" + String(pageCount);
        } else {
            var l = idx + 1;
            var r = idx + 2 <= pageCount ? idx + 2 : null;
            label = r ? (String(l) + "-" + String(r) + "/" + String(pageCount)) : (String(l) + "/" + String(pageCount));
        }

        if (pageIndicator) pageIndicator.textContent = label;

        var atFirst = idx <= 0;
        var atLast = orient === "portrait" ? idx >= pageCount - 1 : idx >= maxLeftPageIndex();
        if (btnFirst) btnFirst.disabled = atFirst;
        if (btnPrev) btnPrev.disabled = atFirst;
        if (btnNext) btnNext.disabled = atLast;
        if (btnLast) btnLast.disabled = atLast;

        var visMax;
        if (orient === "portrait") {
            visMax = idx + 1;
        } else if (FLIPBOOK_SHOW_COVER && idx === 0) {
            visMax = 1;
        } else if (pageCount % 2 === 1 && idx === pageCount - 1) {
            visMax = pageCount;
        } else {
            visMax = Math.min(idx + 2, pageCount);
        }
        if (visMax > maxPageVisited) maxPageVisited = visMax;
        saveBookmark(visMax);
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

        pageCount = window.FLIPBOOK_PAGES.length;

        var startIdx = Math.min(Math.max(0, readBookmark() - 1), pageCount - 1);
        maxPageVisited = Math.max(1, startIdx + 1);

        pageFlip = new St.PageFlip(el, {
            width: 480,
            height: 640,
            size: "stretch",
            minWidth: 220,
            maxWidth: 2000,
            minHeight: 220,
            maxHeight: 1600,
            showCover: FLIPBOOK_SHOW_COVER,
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
        pageFlip.on("changeOrientation", updateIndicatorAndNav);
        pageFlip.on("changeOrientation", function () {
            scheduleRecenter(0);
            scheduleRecenter(80);
        });

        if (btnFirst) btnFirst.addEventListener("click", function () { pageFlip && pageFlip.turnToPage(0); });
        if (btnPrev) btnPrev.addEventListener("click", function () { pageFlip && pageFlip.flipPrev("top"); });
        if (btnNext) btnNext.addEventListener("click", function () { pageFlip && pageFlip.flipNext("top"); });
        if (btnLast) btnLast.addEventListener("click", function () { pageFlip && pageFlip.turnToPage(maxLeftPageIndex()); });

        document.body.addEventListener("keydown", function (e) {
            if (!pageFlip) return;
            if (e.key === "Home") pageFlip.turnToPage(0);
            if (e.key === "End") pageFlip.turnToPage(maxLeftPageIndex());
            if (e.key === "ArrowLeft") { e.preventDefault(); pageFlip.flipPrev("top"); }
            if (e.key === "ArrowRight") { e.preventDefault(); pageFlip.flipNext("top"); }
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

