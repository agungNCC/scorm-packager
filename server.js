const express = require("express")
const multer = require("multer")
const unzipper = require("unzipper")
const archiver = require("archiver")
const fs = require("fs-extra")
const fsp = require("fs").promises
const path = require("path")

// pdfjs-dist 4.9+ uses process.getBuiltinModule (Node.js 20.16+). Older runtimes need this shim.
if (typeof process.getBuiltinModule !== "function") {
    process.getBuiltinModule = function (id) {
        return require(id)
    }
}

const app = express()

app.use(express.static("public"))

const pdfjsPackageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"))
const pdfjsBuildDir = path.join(pdfjsPackageRoot, "build")

const pageFlipPackageRoot = path.dirname(require.resolve("page-flip/package.json"))
const pageFlipBrowserJs = path.join(pageFlipPackageRoot, "dist", "js", "page-flip.browser.js")
const flipbookInitTemplatePath = path.join(__dirname, "templates", "flipbook-init.js")

/**
 * Baca `FLIPBOOK_THEME.pageBg` dari templates/flipbook-init.js — satu sumber untuk:
 * render PDF→PNG (pdf.js background), patch page-flip (clear kanvas), dan tema di browser.
 */
async function readFlipbookThemePageBg() {
    const src = await fs.readFile(flipbookInitTemplatePath, "utf8")
    const m = src.match(/pageBg\s*:\s*["']([^"']+)["']/)
    if (m && m[1]) {
        return m[1].trim()
    }
    console.warn("flipbook-init.js: pageBg tidak terbaca, fallback #000000")
    return "#000000"
}

/**
 * page-flip mengosongkan kanvas dengan putih di clear(); kita ganti agar selaras pageBg.
 */
function patchPageFlipBrowserJsSource(js, canvasClearColor) {
    const c = canvasClearColor
    return js
        .replaceAll("this.ctx.fillStyle=\"white\"", `this.ctx.fillStyle="${c}"`)
        .replaceAll("t.fillStyle=\"rgb(255, 255, 255)\"", `t.fillStyle="${c}"`)
}

async function renderPdfToImages(extractPath, pageBg, onProgress) {

    const pdfPath = path.join(extractPath, "document.pdf")
    const pagesDir = path.join(extractPath, "pages")
    await fs.ensureDir(pagesDir)

    const buf = await fs.readFile(pdfPath)
    const data = new Uint8Array(buf)

    // pdfjs-dist is ESM (.mjs); use dynamic import from CJS.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
    const { createCanvas } = require("@napi-rs/canvas")

    const loadingTask = pdfjs.getDocument({ data, disableWorker: true })
    const pdf = await loadingTask.promise

    const pageFiles = []
    const targetLongPx = 1600

    for (let i = 1; i <= pdf.numPages; i++) {

        const page = await pdf.getPage(i)
        const base = page.getViewport({ scale: 1 })
        const scale = Math.min(targetLongPx / Math.max(base.width, base.height), 3)
        const viewport = page.getViewport({ scale })

        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const ctx = canvas.getContext("2d")

        await page.render({
            canvasContext: ctx,
            viewport,
            background: pageBg,
        }).promise

        const name = `p${String(i).padStart(4, "0")}.png`
        const outPath = path.join(pagesDir, name)
        await fs.writeFile(outPath, canvas.toBuffer("image/png"))

        pageFiles.push(`pages/${name}`)

        if (onProgress) {
            const pct = Math.round(10 + (i / pdf.numPages) * 75)
            onProgress(pct, `Rendering page ${i}/${pdf.numPages}`)
        }
    }

    // Generate a simple JS file to avoid fetch/XHR (works in strict LMS).
    const pagesJs = `window.FLIPBOOK_PAGES = ${JSON.stringify(pageFiles)};\n`
    await fs.writeFile(path.join(extractPath, "flipbook-pages.js"), pagesJs)

}

function isPdfUpload(file) {
    const name = (file && file.originalname) ? file.originalname.toLowerCase() : ""
    const mt = (file && file.mimetype) ? file.mimetype.toLowerCase() : ""
    return name.endsWith(".pdf") || mt === "application/pdf"
}

function isZipUpload(file) {
    const name = (file && file.originalname) ? file.originalname.toLowerCase() : ""
    const mt = (file && file.mimetype) ? file.mimetype.toLowerCase() : ""
    return name.endsWith(".zip") || mt === "application/zip" || mt === "application/x-zip-compressed"
}

/**
 * Detect real file type from content. Browsers often send PDF as application/octet-stream
 * or users may use wrong extension — avoids feeding PDF bytes to unzipper (invalid signature %PDF).
 */
async function sniffUploadKind(filePath) {
    const buf = Buffer.alloc(8)
    const fh = await fsp.open(filePath, "r")
    try {
        const { bytesRead } = await fh.read(buf, 0, 8, 0)
        if (bytesRead < 4) return null
    } finally {
        await fh.close()
    }

    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
        return "pdf"
    }

    const zipSig2 = buf[2]
    const zipSig3 = buf[3]
    if (buf[0] === 0x50 && buf[1] === 0x4B) {
        if (zipSig2 === 0x03 && zipSig3 === 0x04) return "zip"
        if (zipSig2 === 0x05 && zipSig3 === 0x06) return "zip"
        if (zipSig2 === 0x07 && zipSig3 === 0x08) return "zip"
    }

    return null
}

/*
UPLOAD CONFIG
limit 200MB
*/
const upload = multer({
    dest: "uploads/",
    limits: {
        fileSize: 200 * 1024 * 1024
    },
    fileFilter(req, file, cb) {
        const mt = (file.mimetype || "").toLowerCase()
        const looseBinary =
            mt === "application/octet-stream" ||
            mt === "binary/octet-stream" ||
            mt === ""

        if (isPdfUpload(file) || isZipUpload(file) || looseBinary) {
            cb(null, true)
        } else {
            const e = new Error("INVALID_TYPE")
            e.code = "INVALID_TYPE"
            cb(e)
        }
    }
})

function generateId() {
    return Date.now().toString()
}

function findEntryHtml(folder) {

    const files = fs.readdirSync(folder)

    for (const f of files) {

        if (f.endsWith(".html")) {
            return f
        }

    }

    return null
}

async function injectSCORM(htmlPath) {

    let html = await fs.readFile(htmlPath, "utf8");

    const injection = `
<script src="SCORM_API_wrapper.min.js"></script>
<script src="scorm.js"></script>

<script>

const KEYWORD = "selesai";

window.addEventListener("load", function () {

document.body.addEventListener("click", function (e) {

    let el = e.target;

    for (let i = 0; i < 5; i++) {

        if (!el) break;

        const text = (el.textContent || "").toLowerCase();
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();

        console.log("DEBUG CLICK:", text, label, title);

        if (
            text.includes(KEYWORD) ||
            label.includes(KEYWORD) ||
            title.includes(KEYWORD)
        ) {

            console.log("SCORM COMPLETE TRIGGER");

            if (typeof setLmsStatusCompleted === "function") {
                setLmsStatusCompleted();
            }

            break;
        }

        el = el.parentElement;
    }

}, true);

});

</script>
`

    html = html.replace("</body>", "\n" + injection + "\n</body>");
    await fs.writeFile(htmlPath, html);

    console.log("SCORM injection completed");
}

function generateManifest(entry) {
    return `
<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="BAWANA" 
        version="1.2"
        xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" 
        xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2" 
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
        xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd  http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd  http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">

<metadata>
<schema>ADL SCORM</schema>
<schemaversion>1.2</schemaversion>
</metadata>

<organizations default="BAWANA">
<organization identifier="BAWANA">
<title>Scorm Player</title>

<item identifier="CourseItem01" identifierref="SCO_Resource_01" isvisible="true">
<title>Scorm Player</title>
</item>

</organization>
</organizations>

<resources>
<resource identifier="SCO_Resource_01" type="webcontent" adlcp:scormtype="sco" href="${entry}"></resource>
</resources>

</manifest>
`
}

async function buildPdfFlipbookScorm(uploadedPath, extractPath, onProgress) {

    if (onProgress) onProgress(2, "Preparing files…")

    await fs.copy(uploadedPath, path.join(extractPath, "document.pdf"))

    const pageBg = await readFlipbookThemePageBg()
    const pageFlipSrc = await fs.readFile(pageFlipBrowserJs, "utf8")
    const pageFlipPatched = patchPageFlipBrowserJsSource(pageFlipSrc, pageBg)
    await fs.writeFile(path.join(extractPath, "page-flip.browser.js"), pageFlipPatched, "utf8")

    if (onProgress) onProgress(5, "Copying templates…")

    await fs.copy("templates/flipbook-index.html", path.join(extractPath, "index.html"))
    await fs.copy("templates/flipbook-stpageflip.css", path.join(extractPath, "flipbook-stpageflip.css"))
    await fs.copy("templates/flipbook-init.js", path.join(extractPath, "flipbook-init.js"))
    await fs.copy("templates/flipbook-pages.js", path.join(extractPath, "flipbook-pages.js"))

    if (onProgress) onProgress(10, "Rendering PDF pages…")

    // Render PDF to images and write real flipbook-pages.js
    await renderPdfToImages(extractPath, pageBg, onProgress)

    if (onProgress) onProgress(88, "Packaging SCORM…")

    await fs.copy("templates/scorm.js", path.join(extractPath, "scorm.js"))
    await fs.copy("templates/SCORM_API_wrapper.min.js", path.join(extractPath, "SCORM_API_wrapper.min.js"))

    await fs.writeFile(path.join(extractPath, "imsmanifest.xml"), generateManifest("index.html").trim())

}

async function buildGeniallyZipScorm(uploadedPath, extractPath) {

    try {
        await fs.createReadStream(uploadedPath)
            .pipe(unzipper.Extract({ path: extractPath }))
            .promise()
    } catch (zipErr) {
        console.error(zipErr)
        const hint =
            "File bukan arsip ZIP yang valid. Jika Anda mengunggah PDF, pastikan berkas ber-ekstensi .pdf."
        const err = new Error(hint)
        err.code = "BAD_ZIP"
        throw err
    }

    const entry = findEntryHtml(extractPath)

    if (!entry) {
        const err = new Error("No HTML entry found")
        err.code = "NO_HTML"
        throw err
    }

    const htmlPath = path.join(extractPath, entry)

    await injectSCORM(htmlPath)

    await fs.writeFile(path.join(extractPath, "imsmanifest.xml"), generateManifest(entry).trim())
    await fs.copy("templates/scorm.js", path.join(extractPath, "scorm.js"))
    await fs.copy("templates/SCORM_API_wrapper.min.js", path.join(extractPath, "SCORM_API_wrapper.min.js"))

}

/** @returns {Promise<string|null>} error message or null if ok */
async function runGeniallyZipWithErrors(uploadedPath, extractPath) {
    try {
        await buildGeniallyZipScorm(uploadedPath, extractPath)
        return null
    } catch (e) {
        if (e.code === "BAD_ZIP") {
            return e.message
        }
        if (e.code === "NO_HTML") {
            return "No HTML entry found"
        }
        throw e
    }
}

// ── Upload + SSE progress endpoints ──────────────────────────────────

const pendingJobs = new Map()

app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" })
        const id = generateId()
        pendingJobs.set(id, { filePath: req.file.path, file: req.file, ts: Date.now() })
        res.json({ id })
    } catch (err) {
        console.error("UPLOAD ERROR:", err)
        res.status(500).json({ error: String(err.message || err) })
    }
})

app.get("/convert-sse/:id", async (req, res) => {
    const id = req.params.id
    const job = pendingJobs.get(id)
    if (!job) return res.status(404).end("Job not found")
    pendingJobs.delete(id)

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    })

    function sendProgress(pct, msg) {
        res.write(`data: ${JSON.stringify({ percent: pct, message: msg })}\n\n`)
    }

    try {
        const extractPath = `extracted/${id}`
        const outputZip = `output/${id}.zip`

        await fs.ensureDir("uploads")
        await fs.ensureDir("extracted")
        await fs.ensureDir("output")
        await fs.ensureDir(extractPath)

        const sniffed = await sniffUploadKind(job.filePath)

        if (sniffed === "pdf" || isPdfUpload(job.file)) {
            await buildPdfFlipbookScorm(job.filePath, extractPath, sendProgress)
        } else if (sniffed === "zip" || isZipUpload(job.file)) {
            sendProgress(10, "Extracting ZIP…")
            const zipErr = await runGeniallyZipWithErrors(job.filePath, extractPath)
            if (zipErr) {
                res.write(`data: ${JSON.stringify({ error: zipErr })}\n\n`)
                res.end()
                return
            }
            sendProgress(80, "Packaging SCORM…")
        } else {
            res.write(`data: ${JSON.stringify({ error: "Tipe file tidak dikenali." })}\n\n`)
            res.end()
            return
        }

        sendProgress(90, "Creating ZIP…")

        const output = fs.createWriteStream(outputZip)
        const archive = archiver("zip")
        archive.pipe(output)
        archive.directory(extractPath, false)
        const outputClosed = new Promise((resolve, reject) => {
            output.once("close", resolve)
            output.once("error", reject)
            archive.once("error", reject)
        })
        await archive.finalize()
        await outputClosed

        res.write(`data: ${JSON.stringify({ percent: 100, message: "Done!", done: true, downloadId: id })}\n\n`)
        res.end()
    } catch (err) {
        console.error("CONVERT-SSE ERROR:", err)
        res.write(`data: ${JSON.stringify({ error: String(err.message || err) })}\n\n`)
        res.end()
    }
})

app.get("/download/:id", (req, res) => {
    const zipPath = `output/${req.params.id}.zip`
    if (!fs.existsSync(zipPath)) return res.status(404).send("File not found")
    res.download(zipPath)
})

// ── Legacy single-request endpoint (backward compat) ────────────────

app.post("/convert", upload.single("file"), async (req, res) => {

    try {

        if (!req.file) {
            return res.status(400).send("No file uploaded")
        }

        const id = generateId()

        const extractPath = `extracted/${id}`
        const outputZip = `output/${id}.zip`

        await fs.ensureDir("uploads")
        await fs.ensureDir("extracted")
        await fs.ensureDir("output")

        await fs.ensureDir(extractPath)

        const sniffed = await sniffUploadKind(req.file.path)

        if (sniffed === "pdf") {

            await buildPdfFlipbookScorm(req.file.path, extractPath)

        } else if (sniffed === "zip") {

            const zipErr = await runGeniallyZipWithErrors(req.file.path, extractPath)
            if (zipErr) {
                return res.status(400).send(zipErr)
            }

        } else if (isPdfUpload(req.file)) {

            await buildPdfFlipbookScorm(req.file.path, extractPath)

        } else if (isZipUpload(req.file)) {

            const zipErr = await runGeniallyZipWithErrors(req.file.path, extractPath)
            if (zipErr) {
                return res.status(400).send(zipErr)
            }

        } else {
            return res.status(400).send(
                "Tipe file tidak dikenali. Unggah PDF (flipbook) atau ZIP export Genially."
            )
        }

        const output = fs.createWriteStream(outputZip)

        const archive = archiver("zip")

        archive.pipe(output)

        archive.directory(extractPath, false)

        const outputClosed = new Promise((resolve, reject) => {
            output.once("close", resolve)
            output.once("error", reject)
            archive.once("error", reject)
        })

        await archive.finalize()
        await outputClosed

        res.download(outputZip)

    } catch (err) {

        console.error("CONVERT ERROR:", err && err.stack ? err.stack : err);
        res.status(500).send("Conversion failed: " + (err && err.message ? err.message : String(err)))

    }

})

/*
UPLOAD ERROR HANDLER
*/
app.use((err, req, res, next) => {

    if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).send("File terlalu besar. Maksimal 200MB.")
    }

    if (err.code === "INVALID_TYPE") {
        return res.status(400).send("Hanya file PDF atau ZIP yang didukung.")
    }

    next(err)

})

/*
AUTO CLEANUP TEMP FILES
*/
async function cleanupTemp() {

    const folders = ["uploads", "extracted", "output"]

    for (const folder of folders) {

        if (!fs.existsSync(folder)) continue

        const files = await fs.readdir(folder)

        for (const file of files) {

            const filePath = path.join(folder, file)

            const stat = await fs.stat(filePath)

            const now = Date.now()

            const age = now - stat.mtimeMs

            const maxAge = 30 * 60 * 1000

            if (age > maxAge) {

                await fs.remove(filePath)

                console.log("cleanup:", filePath)

            }

        }

    }

}

/*
RUN CLEANUP EVERY 10 MINUTES
*/
setInterval(cleanupTemp, 10 * 60 * 1000)

const PORT = 3333

app.listen(PORT, "0.0.0.0", () => {
    console.log("Server running on port " + PORT)
})