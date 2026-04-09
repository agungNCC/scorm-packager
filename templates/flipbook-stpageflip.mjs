import * as pdfjsLib from "./pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdf.worker.min.mjs", import.meta.url).href;

const PDF_SRC = new URL("./document.pdf", import.meta.url).href;
const COVER_SRC = new URL("./cover.pdf", import.meta.url).href;

const FLIPBOOK_THEME = {
    headerBg: "#0a2540",
    footerBg: "#0a2540",
    appBg: "#0d1b2a",
    stageBgTop: "#cccccc",
    stageBgBottom: "#cccccc",
    overlayBg: "rgba(10, 37, 64, 0.55)",
    text: "#e8eef5",
    indicator: "#b8d4f0",
    pageBg: "#cccccc",
    completeAtRatio: 0.7,
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
let totalImages = 0;
let contentCount = 0;
let hasBackCover = false;
let completedSent = false;
let maxPageVisited = 1;

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
    } catch (_) { /* ignore */ }
}

function readBookmark() {
    try {
        const scorm = window.pipwerks && window.pipwerks.SCORM;
        if (scorm && scorm.connection && scorm.connection.isActive) {
            const loc = scorm.get("cmi.core.lesson_location");
            const p = parseInt(loc, 10);
            if (Number.isFinite(p) && p >= 1) return p;
        }
    } catch (_) { /* ignore */ }
    return 1;
}

function completionThresholdPage() {
    const r = FLIPBOOK_THEME.completeAtRatio;
    if (typeof r !== "number" || r <= 0 || r > 1) return Math.max(1, Math.ceil(contentCount * 0.7));
    return Math.max(1, Math.ceil(contentCount * r));
}

function maybeMarkCompleted(highestVisitedOneBased) {
    if (completedSent) return;
    if (highestVisitedOneBased >= completionThresholdPage()) {
        completedSent = true;
        if (typeof setLmsStatusCompleted === "function") setLmsStatusCompleted();
    }
}

function imgIdxToContentPage(idx) { return idx; }
function contentPageToImgIdx(p) { return p; }

function maxImageIndex() {
    if (totalImages < 1) return 0;
    return totalImages % 2 === 0 ? totalImages - 2 : totalImages - 1;
}

function isPortrait() {
    return pageFlip && pageFlip.getOrientation() === "portrait";
}

function updateIndicatorAndNav() {
    if (!pageFlip) return;
    const idx = pageFlip.getCurrentPageIndex();
    const orient = pageFlip.getOrientation();

    let contentL, contentR;
    if (orient === "portrait") {
        contentL = imgIdxToContentPage(idx);
        contentR = null;
    } else {
        contentL = imgIdxToContentPage(idx);
        contentR = idx + 1 < totalImages ? imgIdxToContentPage(idx + 1) : null;
    }

    if (contentL < 1) contentL = null;
    if (contentL > contentCount) contentL = null;
    if (contentR !== null && (contentR < 1 || contentR > contentCount)) contentR = null;

    let label = "";
    if (contentL && contentR) label = `${contentL}-${contentR}/${contentCount}`;
    else if (contentL) label = `${contentL}/${contentCount}`;
    else if (contentR) label = `${contentR}/${contentCount}`;
    else label = "—";
    pageIndicator.textContent = label;

    let atFirst, atLast;
    if (orient === "portrait") {
        atFirst = idx <= 1;
        atLast = idx >= contentCount;
    } else {
        atFirst = idx <= 0;
        atLast = idx >= maxImageIndex();
    }
    btnFirst.disabled = atFirst;
    btnPrev.disabled = atFirst;
    btnNext.disabled = atLast;
    btnLast.disabled = atLast;

    let visMax = 0;
    if (contentL) visMax = contentL;
    if (contentR && contentR > visMax) visMax = contentR;
    if (visMax > maxPageVisited) maxPageVisited = visMax;
    if (visMax > 0) saveBookmark(visMax);
    maybeMarkCompleted(maxPageVisited);
}

async function renderCoverElement(coverPdf, targetW, targetH) {
    const page = await coverPdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const scale = Math.min((targetW * dpr) / base.width, (targetH * dpr) / base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(targetW * dpr);
    canvas.height = Math.round(targetH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = FLIPBOOK_THEME.pageBg || "#cccccc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const offX = Math.round((canvas.width - viewport.width) / 2);
    const offY = Math.round((canvas.height - viewport.height) / 2);
    await page.render({
        canvasContext: ctx,
        viewport,
        transform: [1, 0, 0, 1, offX, offY],
    }).promise;
    canvas.style.width = targetW + "px";
    canvas.style.height = targetH + "px";
    const div = document.createElement("div");
    div.className = "page";
    div.appendChild(canvas);
    return div;
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
        const [pdf, coverPdf] = await Promise.all([
            pdfjsLib.getDocument({ url: PDF_SRC }).promise,
            pdfjsLib.getDocument({ url: COVER_SRC }).promise,
        ]);

        const p1 = await pdf.getPage(1);
        const base = p1.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const targetCssLong = pdf.numPages > 48 ? 720 : 960;
        const cssScale = targetCssLong / Math.max(base.width, base.height);
        const targetW = Math.round(base.width * cssScale);
        const targetH = Math.round(base.height * cssScale);

        const bookW = 480;
        const bookH = Math.max(340, Math.round((bookW * base.height) / base.width));

        contentCount = pdf.numPages;
        hasBackCover = contentCount % 2 === 0;

        const contentPages = await rasterizePdfToPages(pdf);
        const frontCover = await renderCoverElement(coverPdf, targetW, targetH);

        const allPages = [frontCover, ...contentPages];

        if (hasBackCover) {
            const backCover = await renderCoverElement(coverPdf, targetW, targetH);
            allPages.push(backCover);
        }

        totalImages = allPages.length;

        const bookmark = readBookmark();
        const orient = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
        let startIdx;
        if (orient === "portrait") {
            startIdx = contentPageToImgIdx(Math.min(Math.max(1, bookmark), contentCount));
        } else {
            startIdx = 0;
            if (bookmark > 1) {
                const bmIdx = contentPageToImgIdx(Math.min(bookmark, contentCount));
                startIdx = bmIdx % 2 === 0 ? bmIdx - 1 : bmIdx;
                if (startIdx < 0) startIdx = 0;
            }
        }
        maxPageVisited = Math.max(1, bookmark);

        const el = document.getElementById("flipbook");
        el.innerHTML = "";

        pageFlip = new St.PageFlip(el, {
            width: bookW,
            height: bookH,
            size: "stretch",
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

        pageFlip.loadFromHTML(allPages);

        pageFlip.on("flip", () => updateIndicatorAndNav());
        pageFlip.on("changeOrientation", () => {
            const orient = pageFlip.getOrientation();
            const idx = pageFlip.getCurrentPageIndex();
            if (orient === "portrait") {
                if (idx < 1) pageFlip.turnToPage(1);
                else if (idx > contentCount) pageFlip.turnToPage(contentCount);
            }
            updateIndicatorAndNav();
        });

        btnFirst.addEventListener("click", () => {
            if (!pageFlip) return;
            pageFlip.turnToPage(isPortrait() ? 1 : 0);
        });
        btnPrev.addEventListener("click", () => {
            if (!pageFlip) return;
            if (isPortrait() && pageFlip.getCurrentPageIndex() <= 1) return;
            pageFlip.flipPrev("top");
        });
        btnNext.addEventListener("click", () => {
            if (!pageFlip) return;
            if (isPortrait() && pageFlip.getCurrentPageIndex() >= contentCount) return;
            pageFlip.flipNext("top");
        });
        btnLast.addEventListener("click", () => {
            if (!pageFlip) return;
            pageFlip.turnToPage(isPortrait() ? contentCount : maxImageIndex());
        });

        document.body.addEventListener("keydown", (e) => {
            if (!pageFlip) return;
            const idx = pageFlip.getCurrentPageIndex();
            if (e.key === "Home") pageFlip.turnToPage(isPortrait() ? 1 : 0);
            if (e.key === "End") pageFlip.turnToPage(isPortrait() ? contentCount : maxImageIndex());
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

        window.addEventListener("orientationchange", () => {
            window.setTimeout(() => {
                try {
                    window.dispatchEvent(new Event("resize"));
                    updateIndicatorAndNav();
                } catch (_) { /* ignore */ }
            }, 400);
        }, { passive: true });

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
