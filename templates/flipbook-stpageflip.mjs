import * as pdfjsLib from "./pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;

const PDF_SRC = new URL("./document.pdf", import.meta.url).href;

/**
 * Konfigurasi warna (bisa Anda ubah manual).
 *
 * Cara pakai:
 * - Buka `flipbook-stpageflip.mjs` di zip SCORM hasil konversi
 * - Ubah nilai `FLIPBOOK_THEME` di bawah ini
 */
const FLIPBOOK_THEME = {
    headerBg: "#164794",
    footerBg: "#164794",
    appBg: "#0d1b2a",
    stageBgTop: "#000",
    stageBgBottom: "#000",
    overlayBg: "rgba(10, 37, 64, 0.55)",
    text: "#e8eef5",
    indicator: "#b8d4f0",
    pageBg: "#ffffff",
};

function applyTheme(t) {
    const root = document.documentElement;
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

const loadingOverlay = document.getElementById("loadingOverlay");
const pageIndicator = document.getElementById("pageIndicator");
const btnFirst = document.getElementById("btnFirst");
const btnPrev = document.getElementById("btnPrev");
const btnNext = document.getElementById("btnNext");
const btnLast = document.getElementById("btnLast");

let pageFlip = null;
let pageCount = 0;
let completedSent = false;

function setLoading(on) {
    loadingOverlay.classList.toggle("is-visible", on);
}

function saveBookmark(pageOneBased) {
    try {
        const scorm = window.pipwerks && window.pipwerks.SCORM;
        if (scorm && scorm.connection && scorm.connection.isActive) {
            scorm.set("cmi.core.lesson_location", String(pageOneBased));
            scorm.save();
        }
    } catch (_) {
        /* ignore */
    }
}

function readBookmark() {
    try {
        const scorm = window.pipwerks && window.pipwerks.SCORM;
        if (scorm && scorm.connection && scorm.connection.isActive) {
            const loc = scorm.get("cmi.core.lesson_location");
            const p = parseInt(loc, 10);
            if (Number.isFinite(p) && p >= 1) return p;
        }
    } catch (_) {
        /* ignore */
    }
    return 1;
}

function maybeMarkCompleted(lastVisibleOneBased) {
    if (completedSent) return;
    if (lastVisibleOneBased >= pageCount) {
        completedSent = true;
        if (typeof setLmsStatusCompleted === "function") {
            setLmsStatusCompleted();
        }
    }
}

function maxLeftPageIndex() {
    if (pageCount < 1) return 0;
    return pageCount % 2 === 1 ? pageCount - 1 : pageCount - 2;
}

function updateIndicatorAndNav() {
    if (!pageFlip) return;
    const idx = pageFlip.getCurrentPageIndex();
    const orient = pageFlip.getOrientation();
    let label = "";
    if (orient === "portrait") {
        label = `${idx + 1}/${pageCount}`;
    } else {
        const l = idx + 1;
        const r = idx + 2 <= pageCount ? idx + 2 : null;
        label = r ? `${l}-${r}/${pageCount}` : `${l}/${pageCount}`;
    }
    pageIndicator.textContent = label;

    const atFirst = idx <= 0;
    const atLast = orient === "portrait" ? idx >= pageCount - 1 : idx >= maxLeftPageIndex();
    btnFirst.disabled = atFirst;
    btnPrev.disabled = atFirst;
    btnNext.disabled = atLast;
    btnLast.disabled = atLast;

    const visMax = orient === "portrait" ? idx + 1 : Math.min(idx + 2, pageCount);
    saveBookmark(visMax);
    maybeMarkCompleted(visMax);
}

async function rasterizePdfToPages(pdf) {
    const num = pdf.numPages;
    const pages = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const targetCssLong = num > 48 ? 720 : 960;

    for (let i = 1; i <= num; i++) {
        const page = await pdf.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = (targetCssLong / Math.max(base.width, base.height)) * dpr;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));

        await page.render({ canvasContext: ctx, viewport }).promise;

        const div = document.createElement("div");
        div.className = "page";
        div.appendChild(canvas);
        pages.push(div);
    }
    return pages;
}

function waitFrames(n) {
    return new Promise((resolve) => {
        let c = 0;
        function step() {
            c += 1;
            if (c >= n) resolve();
            else requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    });
}

async function start() {
    applyTheme(FLIPBOOK_THEME);

    if (typeof St === "undefined" || !St.PageFlip) {
        pageIndicator.textContent = "Library flip tidak dimuat";
        setLoading(false);
        return;
    }

    setLoading(true);
    pageIndicator.textContent = "…";

    try {
        const loadingTask = pdfjsLib.getDocument({ url: PDF_SRC });
        const pdf = await loadingTask.promise;
        const p1 = await pdf.getPage(1);
        const base = p1.getViewport({ scale: 1 });
        const bookW = 480;
        const bookH = Math.max(340, Math.round((bookW * base.height) / base.width));

        pageCount = pdf.numPages;

        const pageElements = await rasterizePdfToPages(pdf);

        const startIdx = Math.min(Math.max(0, readBookmark() - 1), pageCount - 1);

        const el = document.getElementById("flipbook");
        el.innerHTML = "";

        pageFlip = new St.PageFlip(el, {
            width: bookW,
            height: bookH,
            size: "stretch",
            // Landscape mobile (mis. 780x360) butuh bisa mengecil, kalau minHeight terlalu besar akan terpotong.
            minWidth: 220,
            maxWidth: 2000,
            minHeight: 220,
            maxHeight: 2400,
            showCover: false,
            mobileScrollSupport: false,
            startPage: startIdx,
            flippingTime: 880,
            usePortrait: true,
            drawShadow: true,
            maxShadowOpacity: 0.38,
            autoSize: true,
            swipeDistance: 32,
            useMouseEvents: true,
        });

        pageFlip.loadFromHTML(pageElements);

        pageFlip.on("flip", () => updateIndicatorAndNav());
        pageFlip.on("changeOrientation", () => updateIndicatorAndNav());

        btnFirst.addEventListener("click", () => {
            if (pageFlip) pageFlip.turnToPage(0);
        });
        btnPrev.addEventListener("click", () => {
            if (pageFlip) pageFlip.flipPrev("top");
        });
        btnNext.addEventListener("click", () => {
            if (pageFlip) pageFlip.flipNext("top");
        });
        btnLast.addEventListener("click", () => {
            if (pageFlip) pageFlip.turnToPage(maxLeftPageIndex());
        });

        document.body.addEventListener("keydown", (e) => {
            if (!pageFlip) return;
            if (e.key === "Home") pageFlip.turnToPage(0);
            if (e.key === "End") pageFlip.turnToPage(maxLeftPageIndex());
            if (e.key === "ArrowLeft") {
                e.preventDefault();
                pageFlip.flipPrev("top");
            }
            if (e.key === "ArrowRight") {
                e.preventDefault();
                pageFlip.flipNext("top");
            }
        });

        window.addEventListener(
            "orientationchange",
            () => {
                window.setTimeout(() => {
                    try {
                        window.dispatchEvent(new Event("resize"));
                        updateIndicatorAndNav();
                    } catch (_) {
                        /* ignore */
                    }
                }, 400);
            },
            { passive: true }
        );

        await waitFrames(2);
        updateIndicatorAndNav();
    } catch (err) {
        console.error(err);
        pageIndicator.textContent = "Error";
    } finally {
        setLoading(false);
    }
}

window.addEventListener("load", () => {
    window.setTimeout(start, 320);
});
