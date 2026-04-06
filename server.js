const express = require("express")
const multer = require("multer")
const unzipper = require("unzipper")
const archiver = require("archiver")
const fs = require("fs-extra")
const fsp = require("fs").promises
const path = require("path")

const app = express()

app.use(express.static("public"))

const pdfjsPackageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"))
const pdfjsBuildDir = path.join(pdfjsPackageRoot, "build")

const pageFlipPackageRoot = path.dirname(require.resolve("page-flip/package.json"))
const pageFlipBrowserJs = path.join(pageFlipPackageRoot, "dist", "js", "page-flip.browser.js")

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

async function buildPdfFlipbookScorm(uploadedPath, extractPath) {

    await fs.copy(uploadedPath, path.join(extractPath, "document.pdf"))

    await fs.copy(path.join(pdfjsBuildDir, "pdf.min.mjs"), path.join(extractPath, "pdf.min.mjs"))
    await fs.copy(path.join(pdfjsBuildDir, "pdf.worker.min.mjs"), path.join(extractPath, "pdf.worker.min.mjs"))

    await fs.copy(pageFlipBrowserJs, path.join(extractPath, "page-flip.browser.js"))

    await fs.copy("templates/flipbook-index.html", path.join(extractPath, "index.html"))
    await fs.copy("templates/flipbook-stpageflip.css", path.join(extractPath, "flipbook-stpageflip.css"))
    await fs.copy("templates/flipbook-stpageflip.mjs", path.join(extractPath, "flipbook-stpageflip.mjs"))

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