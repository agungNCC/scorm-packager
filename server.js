const express = require("express")
const multer = require("multer")
const unzipper = require("unzipper")
const archiver = require("archiver")
const fs = require("fs-extra")
const path = require("path")

const app = express()

app.use(express.static("public"))

const upload = multer({ dest: "uploads/" })

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

                                // naik ke parent max 5 level
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
                    <title>⁠Scorm Player</title>
                    <item identifier="CourseItem01" identifierref="SCO_Resource_01" isvisible="true"> 
                        <title>⁠Scorm Player</title>

                    </item>
                </organization>
            </organizations>
            <resources>
                <resource identifier="SCO_Resource_01" type="webcontent" adlcp:scormtype="sco" href="genially.html"></resource>
            </resources>
            </manifest>
            `

}

app.post("/convert", upload.single("file"), async (req, res) => {

    const id = generateId()

    const extractPath = `extracted/${id}`

    const outputZip = `output/${id}.zip`

    await fs.ensureDir(extractPath)
    await fs.ensureDir("output")

    await fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: extractPath }))
        .promise()

    const entry = findEntryHtml(extractPath)

    if (!entry) {
        return res.status(400).send("No HTML entry found")
    }

    const htmlPath = path.join(extractPath, entry)

    await injectSCORM(htmlPath)

    await fs.copy("templates/imsmanifest.xml", `${extractPath}/imsmanifest.xml`)
    await fs.copy("templates/scorm.js", `${extractPath}/scorm.js`)
    await fs.copy("templates/SCORM_API_wrapper.min.js", `${extractPath}/SCORM_API_wrapper.min.js`)

    //const manifest = generateManifest(entry)
    //await fs.writeFile(`${extractPath}/imsmanifest.xml`, manifest)

    const output = fs.createWriteStream(outputZip)

    const archive = archiver("zip")

    archive.pipe(output)

    archive.directory(extractPath, false)

    await archive.finalize()

    output.on("close", () => {

        res.download(outputZip)

    })

})

app.listen(3000, () => {

    console.log("Server running http://localhost:3000")

})