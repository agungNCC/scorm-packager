const scorm = (window.pipwerks && window.pipwerks.SCORM) ? window.pipwerks.SCORM : null;
if (scorm) scorm.version = "1.2";


var initiated = false;
var dtmSessionTime = new Date();
var lessonStatus = "";
var prevTime = 0;

function safeNumber(v, f = 0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function msToCMIDuration(n) {
    const d = new Date(); d.setTime(n);
    const h = "000" + Math.floor(n / 3600000), m = "0" + d.getMinutes(), s = "0" + d.getSeconds(), cs = "0" + Math.round(d.getMilliseconds() / 10);
    return h.slice(-4) + ":" + m.slice(-2) + ":" + s.slice(-2) + "." + cs.slice(-2);
}

function setLmsSession() {
    if (!scorm) return;

    const tm = Date.now() - dtmSessionTime.getTime();
    scorm.set("cmi.core.session_time", msToCMIDuration(tm));
    scorm.save();

}

function setLmsStatusCompleted() {
    if (!scorm || lessonStatus === "completed") return;
    lessonStatus = "completed";
    scorm.set("cmi.core.lesson_status", lessonStatus);
    scorm.save();
    setLmsSession();
    scorm.quit();

}

function persistLocation(sec) {
    if (!scorm) return;
    scorm.set("cmi.core.lesson_location", String(safeNumber(sec, 0))); scorm.save();

}

function unloadHandler() {
    setLmsSession();

}

function Initializing() {



    if (initiated) return;
    initiated = true;
    dtmSessionTime = new Date();
    let success = false; try { success = scorm ? scorm.init() : false; } catch (e) { }

    if (success) {
        lessonStatus = scorm.get("cmi.core.lesson_status") || "incomplete";
        // Restore last known location if available (avoid undefined globals).
        const loc = scorm.get("cmi.core.lesson_location");
        prevTime = safeNumber(loc, 0);
        if (lessonStatus === 'completed' || lessonStatus === 'passed') { lessonStatus = 'completed'; }

    }


    console.log(' initiated');

}


console.log(' main');

Initializing();
window.onbeforeunload = unloadHandler;
window.onunload = unloadHandler;
window.onload = Initializing;