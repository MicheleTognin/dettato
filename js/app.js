// Dettato per iPad: interfaccia, gesti, libreria e progetti.
import { Engine, encodeWav } from "./engine.js";
import { MarkerList, SECTION, MEASURE, BEAT } from "./markers.js";
import { drawMain, drawOverview, drawKeyboard, drawSeek, seekTimeAt, MainGeometry, RULER, LANE, fmtTime, midiAtKeyboard } from "./views.js";
import { db } from "./db.js";

const A = window.DettatoAnalysis;
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const DEFAULTS = {
  speed: 100, semitones: 0, cents: 0, volume: 0, stereo: 1, eqPreset: 1,
  hpOn: false, hpHz: 80, lpOn: false, lpHz: 8000, peakOn: false, peakHz: 1000, peakDb: 0,
  gap: 0, returnToStart: true, metronome: false, metroVolume: 60, notes: ""
};
const EQ_PRESETS = {
  1: { hpOn: false, hpHz: 80, lpOn: false, lpHz: 8000, peakOn: false, peakHz: 1000, peakDb: 0 },
  2: { hpOn: false, hpHz: 80, lpOn: true, lpHz: 320, peakOn: true, peakHz: 90, peakDb: 4 },
  3: { hpOn: true, hpHz: 180, lpOn: true, lpHz: 5000, peakOn: true, peakHz: 1500, peakDb: 3 },
  4: { hpOn: true, hpHz: 150, lpOn: true, lpHz: 6500, peakOn: true, peakHz: 2500, peakDb: 4 },
  5: { hpOn: true, hpHz: 200, lpOn: false, lpHz: 8000, peakOn: false, peakHz: 1000, peakDb: 0 }
};

const prefs = (() => { try { return JSON.parse(localStorage.getItem("dettato-prefs") || "{}"); } catch (e) { return {}; } })();
const savePrefs = () => { try { localStorage.setItem("dettato-prefs", JSON.stringify(prefs)); } catch (e) { /* niente */ } };

const S = {
  song: null, buffer: null, L: null, R: null, mono: false, sampleRate: 48000, duration: 0,
  markers: new MarkerList(),
  cursor: 0, selStart: 0, selEnd: 0, viewStart: 0, viewEnd: 1, playPos: 0, playing: false, playStart: 0,
  showNotes: false, follow: prefs.follow !== false, italian: prefs.italian !== false, loop: true, transpose: 0, selMarker: null,
  ctl: { ...DEFAULTS }
};
Object.defineProperty(S, "duration", { get() { return this.L ? this.L.length / this.sampleRate : 0; } });

let an = null, worker = null, analysisId = 0;
const engine = new Engine();
engine.init().catch(err => toast("Audio non disponibile: " + err.message));

const hasSel = () => S.selEnd - S.selStart > 0.01;
const shownPos = () => S.playing ? S.playPos : S.cursor;
const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

// ------------------------------------------------------------------ avvisi e finestre
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function busy(text) { $("busyText").textContent = text || ""; $("busy").hidden = !text; }

function dialog({ title, message = "", input = null, options = null, ok = "OK", cancel = "Annulla" }) {
  return new Promise(resolve => {
    const d = $("dlg"), shade = $("dlgShade");
    d.innerHTML = "";
    const h = document.createElement("h3"); h.textContent = title; d.appendChild(h);
    if (message) { const p = document.createElement("p"); p.textContent = message; d.appendChild(p); }
    let field = null;
    if (options) {
      field = document.createElement("select");
      for (const [v, label] of options) { const o = document.createElement("option"); o.value = v; o.textContent = label; field.appendChild(o); }
      if (input != null) field.value = String(input);
      d.appendChild(field);
    } else if (input != null) {
      field = document.createElement("input"); field.value = input; field.autocapitalize = "sentences";
      d.appendChild(field);
    }
    const acts = document.createElement("div"); acts.className = "acts";
    const done = v => { shade.hidden = true; document.removeEventListener("keydown", onKey, true); resolve(v); };
    if (cancel) { const b = document.createElement("button"); b.className = "btn"; b.textContent = cancel; b.onclick = () => done(null); acts.appendChild(b); }
    const okb = document.createElement("button"); okb.className = "btn primary"; okb.textContent = ok;
    okb.onclick = () => done(field ? field.value : true); acts.appendChild(okb);
    d.appendChild(acts);
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      else if (e.key === "Enter") { e.preventDefault(); okb.click(); }
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    shade.hidden = false;
    if (field && field.tagName === "INPUT") setTimeout(() => { field.focus(); field.select(); }, 50);
  });
}

function showMenu(x, y, items) {
  const m = $("menu");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "-") { m.appendChild(document.createElement("hr")); continue; }
    if (it.hidden) continue;
    const b = document.createElement("button"); b.textContent = it.label; b.disabled = it.disabled;
    if (it.disabled) b.style.opacity = 0.4;
    b.onclick = () => { hideMenu(); it.action(); };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = clamp(x, 8, innerWidth - r.width - 8) + "px";
  m.style.top = clamp(y, 8, innerHeight - r.height - 8) + "px";
}
function hideMenu() { $("menu").hidden = true; }
document.addEventListener("pointerdown", e => { if (!$("menu").hidden && !$("menu").contains(e.target)) hideMenu(); }, true);

// ------------------------------------------------------------------ controlli
const logMap = el => ({ lo: +el.dataset.lo, hi: +el.dataset.hi });
const toSlider = (el, f) => { const { lo, hi } = logMap(el); return Math.round(1000 * Math.log(f / lo) / Math.log(hi / lo)); };
const fromSlider = el => { const { lo, hi } = logMap(el); return Math.round(lo * Math.pow(hi / lo, +el.value / 1000)); };

function syncControls() {
  const c = S.ctl;
  $("speed").value = c.speed; $("cents").value = c.cents; $("volume").value = c.volume;
  $("stereo").value = c.stereo; $("eqPreset").value = c.eqPreset;
  $("hpOn").checked = c.hpOn; $("hpHz").value = toSlider($("hpHz"), c.hpHz);
  $("lpOn").checked = c.lpOn; $("lpHz").value = toSlider($("lpHz"), c.lpHz);
  $("peakOn").checked = c.peakOn; $("peakHz").value = toSlider($("peakHz"), c.peakHz); $("peakDb").value = c.peakDb;
  $("gap").value = c.gap; $("returnToStart").checked = c.returnToStart; $("metronome").checked = c.metronome; $("metroVol").value = c.metroVolume;
  $("notes").value = c.notes; $("italian").checked = S.italian;
  syncLabels();
}
function syncLabels() {
  const c = S.ctl;
  $("speedVal").textContent = c.speed + "%"; $("spVal").textContent = c.speed + "%";
  $("semiVal").textContent = (c.semitones > 0 ? "+" : "") + c.semitones;
  $("centsVal").textContent = (c.cents > 0 ? "+" : "") + c.cents + " c";
  $("volumeVal").textContent = (c.volume > 0 ? "+" : "") + c.volume + " dB";
  $("hpHzVal").textContent = c.hpHz + " Hz"; $("lpHzVal").textContent = c.lpHz + " Hz"; $("peakHzVal").textContent = c.peakHz + " Hz";
  $("peakDbVal").textContent = (c.peakDb > 0 ? "+" : "") + c.peakDb + " dB";
  $("gapVal").textContent = (+c.gap).toFixed(1).replace(".", ",") + " s"; $("metroVolVal").textContent = c.metroVolume + "%";
  document.querySelectorAll("[data-speed]").forEach(b => b.classList.toggle("on", +b.dataset.speed === c.speed));
}
function applyControls() {
  const c = S.ctl;
  engine.setRate(c.speed / 100);
  engine.setSemis(c.semitones + c.cents / 100);
  engine.setVolumeDb(c.volume);
  engine.setStereoMode(+c.stereo);
  engine.setEq({ hpOn: c.hpOn, hpHz: c.hpHz, lpOn: c.lpOn, lpHz: c.lpHz, peakOn: c.peakOn, peakHz: c.peakHz, peakDb: c.peakDb });
  engine.setGap(+c.gap);
  engine.setMetronome(c.metronome, c.metroVolume / 100);
  if (S.transpose !== c.semitones) { S.transpose = c.semitones; dirtyView = true; }
  syncLabels();
  requestRender();
}
function changed(fields) {
  Object.assign(S.ctl, fields);
  applyControls();
  markDirty();
}
const markCustom = () => { if (S.ctl.eqPreset !== 6) { S.ctl.eqPreset = 6; $("eqPreset").value = 6; } };

$("speed").addEventListener("input", e => changed({ speed: +e.target.value }));
document.querySelectorAll("[data-speed]").forEach(b => b.addEventListener("click", () => changed({ speed: +b.dataset.speed }) || syncControls()));
$("spDown").addEventListener("click", () => { changed({ speed: clamp(S.ctl.speed - 5, 10, 200) }); syncControls(); });
$("spUp").addEventListener("click", () => { changed({ speed: clamp(S.ctl.speed + 5, 10, 200) }); syncControls(); });
$("semiDown").addEventListener("click", () => changed({ semitones: clamp(S.ctl.semitones - 1, -12, 12) }));
$("semiUp").addEventListener("click", () => changed({ semitones: clamp(S.ctl.semitones + 1, -12, 12) }));
$("cents").addEventListener("input", e => changed({ cents: +e.target.value }));
$("fixTuning").addEventListener("click", () => { if (an && an.tuningReady) { changed({ cents: clamp(-Math.round(an.tuning), -50, 50) }); syncControls(); } });
$("resetTuning").addEventListener("click", () => { changed({ semitones: 0, cents: 0 }); syncControls(); });
$("volume").addEventListener("input", e => changed({ volume: +e.target.value }));
$("stereo").addEventListener("change", e => changed({ stereo: +e.target.value }));
$("eqPreset").addEventListener("change", e => {
  const id = +e.target.value;
  changed(id === 6 ? { eqPreset: 6 } : { eqPreset: id, ...EQ_PRESETS[id] });
  syncControls();
});
for (const k of ["hpOn", "lpOn", "peakOn"]) $(k).addEventListener("change", e => { markCustom(); changed({ [k]: e.target.checked }); });
for (const k of ["hpHz", "lpHz", "peakHz"]) $(k).addEventListener("input", e => { markCustom(); changed({ [k]: fromSlider(e.target) }); });
$("peakDb").addEventListener("input", e => { markCustom(); changed({ peakDb: +e.target.value }); });
$("gap").addEventListener("input", e => changed({ gap: +e.target.value }));
$("returnToStart").addEventListener("change", e => changed({ returnToStart: e.target.checked }));
$("metronome").addEventListener("change", e => changed({ metronome: e.target.checked }));
$("metroVol").addEventListener("input", e => changed({ metroVolume: +e.target.value }));
$("notes").addEventListener("input", e => { S.ctl.notes = e.target.value; markDirty(); });
$("italian").addEventListener("change", e => { S.italian = e.target.checked; prefs.italian = S.italian; savePrefs(); dirtyView = true; requestRender(); });

// pannello
function setPanel(open, remember = true) {
  $("panel").hidden = !open;
  $("panelShade").hidden = !open || innerWidth >= 1024;
  $("panelBtn").classList.toggle("on", open);
  if (remember && innerWidth >= 1024) { prefs.panel = open; savePrefs(); }
  requestRender();
}
$("panelBtn").addEventListener("click", () => setPanel($("panel").hidden));
$("panelShade").addEventListener("click", () => setPanel(false));

// ------------------------------------------------------------------ regione, click, stato
function updateRegion() { engine.setRegion(hasSel(), S.selStart, S.selEnd, S.loop); }
function updateClicks() {
  engine.setClicks(S.markers.items.filter(m => m.type !== SECTION).map(m => ({ time: m.time, accent: m.type === MEASURE })));
}
function selectionChanged() { updateRegion(); dirtyView = true; spectrumDirty = true; requestRender(); markDirty(); }
function markersEdited() { updateClicks(); dirtyView = true; requestRender(); markDirty(); }
function clampView() {
  const len = Math.max(0.05, S.duration), l = clamp(S.viewEnd - S.viewStart, 0.05, len);
  S.viewStart = clamp(S.viewStart, 0, len - l); S.viewEnd = S.viewStart + l;
}
function zoomAround(t, factor) {
  const len = Math.max(0.05, S.duration), vl = S.viewEnd - S.viewStart, nl = clamp(vl * factor, 0.05, len);
  S.viewStart = t - (t - S.viewStart) * nl / vl; S.viewEnd = S.viewStart + nl; clampView();
  dirtyView = true; requestRender();
}

// ------------------------------------------------------------------ trasporto
function unlockAudio() { engine.unlock(); }
document.addEventListener("pointerdown", unlockAudio, true);
document.addEventListener("keydown", unlockAudio, true);

async function togglePlay() {
  if (!S.L) return;
  unlockAudio();
  if (S.playing) { stopPlayback(); return; }
  let start = hasSel() ? S.selStart : S.cursor;
  if (!hasSel() && start >= S.duration - 0.05) start = 0;
  S.playStart = start;
  updateRegion();
  S.playing = true; S.playPos = start; updatePlayButton();
  try { await engine.play(start); }
  catch (e) { toast("L'audio non è partito: tocca di nuovo play"); }
  S.playing = engine.playing; updatePlayButton(); requestRender();
}
function stopPlayback() {
  const p = engine.stop();
  if (S.ctl.returnToStart) S.cursor = S.playStart;
  else { if (p != null) S.cursor = p; S.playStart = S.cursor; }
  S.playing = false; updatePlayButton(); dirtyView = true; requestRender(); markDirty();
}
engine.onEnded = endPos => {
  S.playing = false;
  if (S.ctl.returnToStart) S.cursor = S.playStart; else { S.cursor = endPos; S.playStart = endPos; }
  updatePlayButton(); dirtyView = true; requestRender();
};
function playFromStart() {
  if (!S.L) return;
  const start = hasSel() ? S.selStart : S.playStart;
  updateRegion();
  if (S.playing) engine.seek(start);
  else { S.cursor = start; togglePlay(); }
}
function seekTo(t) {
  t = clamp(t, 0, S.duration);
  S.cursor = t; S.playStart = t;
  if (S.playing) engine.seek(t);
  dirtyView = true; spectrumDirty = true; requestRender();
}
function nudge(dt) { if (S.L) seekTo(shownPos() + dt); }
function jumpMarker(dir) {
  if (!S.L) return;
  const pos = shownPos();
  let target = dir > 0 ? S.duration : 0;
  for (const m of S.markers.items) {
    if (dir > 0 && m.time > pos + 0.02) { target = m.time; break; }
    if (dir < 0 && m.time < pos - (S.playing ? 0.4 : 0.02)) target = m.time;
  }
  seekTo(target);
}
function updatePlayButton() {
  $("play").querySelector("use").setAttribute("href", S.playing ? "#i-pause" : "#i-play");
  $("clock").classList.toggle("playing", S.playing);
  $("loopBtn").classList.toggle("on", S.loop);
}

function addMarker(type, t) {
  if (!S.L) return;
  if (t == null) t = S.playing ? (engine.position() ?? S.playPos) : S.cursor;
  S.markers.checkpoint();
  const i = S.markers.add({ time: t, type });
  markersEdited();
  const m = S.markers.at(i);
  toast((type === SECTION ? "Sezione " + m.label : type === MEASURE ? "Battuta " + S.markers.measureNumber(i) : "Movimento") + " a " + fmtTime(t));
}
function deleteMarkerNear() {
  const i = S.selMarker ? S.markers.indexOf(S.selMarker) : S.markers.findNear(shownPos(), 0.35);
  if (i < 0) { toast("Nessun marker vicino alla posizione attuale"); return; }
  S.markers.checkpoint(); S.markers.remove(i); S.selMarker = null; markersEdited(); toast("Marker eliminato");
}
async function renameSection(m) {
  const v = await dialog({ title: "Nome della sezione", message: "Per esempio: Intro, Strofa, Ritornello, Solo", input: m.label });
  if (v == null) return;
  S.markers.checkpoint();
  m.label = v.trim() || S.markers.nextSectionLabel();
  markersEdited();
}
async function askFillBeats() {
  if (S.markers.measures().length < 2) { toast("Servono almeno due marker di battuta"); return; }
  const v = await dialog({ title: "Riempi i movimenti", message: "Movimenti per battuta, distribuiti in modo uniforme tra i marker di battuta.",
    options: [2, 3, 4, 5, 6, 7, 8, 9, 12].map(n => [n, n + " movimenti"]), input: 4 });
  if (v == null) return;
  S.markers.checkpoint(); S.markers.fillBeats(+v); markersEdited(); toast(v + " movimenti per battuta");
}
function extendMeasures() {
  if (S.markers.measures().length < 2) { toast("Servono almeno due marker di battuta"); return; }
  S.markers.checkpoint(); S.markers.extendMeasures(S.duration); markersEdited(); toast("Battute proseguite fino alla fine");
}
async function askFirstMeasure() {
  const v = await dialog({ title: "Numero della prima battuta", message: "Usa 0 se il brano inizia in levare.", input: String(S.markers.firstMeasure) });
  if (v == null) return;
  S.markers.firstMeasure = parseInt(v, 10) || 0; markersEdited();
}
async function clearMarkers() {
  if (!S.markers.size) return;
  S.markers.checkpoint(); S.markers.clear(); S.selMarker = null; markersEdited(); toast("Marker eliminati (Annulla per recuperarli)");
}
function undo() { if (S.markers.undo()) { S.selMarker = null; markersEdited(); } }
function redo() { if (S.markers.redo()) { S.selMarker = null; markersEdited(); } }

$("play").addEventListener("click", togglePlay);
$("toStart").addEventListener("click", () => seekTo(0));
$("back").addEventListener("click", () => nudge(-2));
$("fwd").addEventListener("click", () => nudge(2));
$("loopBtn").addEventListener("click", () => { S.loop = !S.loop; updateRegion(); updatePlayButton(); toast(S.loop ? "Ripeti la selezione: attivo" : "Ripeti la selezione: spento"); markDirty(); });
for (const [id, type] of [["mMeasure", MEASURE], ["mBeat", BEAT], ["mSection", SECTION]]) {
  const b = $(id);
  // pointerdown: il marker cade nel momento del tocco, non al rilascio
  b.addEventListener("pointerdown", e => { e.preventDefault(); addMarker(type); b.classList.add("hit"); setTimeout(() => b.classList.remove("hit"), 140); });
  b.addEventListener("click", e => e.preventDefault());
}
$("viewWave").addEventListener("click", () => setShowNotes(false));
$("viewNotes").addEventListener("click", () => setShowNotes(true));
$("pViewWave").addEventListener("click", () => setShowNotes(false));
$("pViewNotes").addEventListener("click", () => setShowNotes(true));
$("zoomAll").addEventListener("click", () => { S.viewStart = 0; S.viewEnd = S.duration; clampView(); dirtyView = true; requestRender(); });
function setShowNotes(v) {
  S.showNotes = v;
  for (const [a, b] of [["viewWave", "viewNotes"], ["pViewWave", "pViewNotes"]]) { $(a).classList.toggle("on", !v); $(b).classList.toggle("on", v); }
  dirtyView = true; requestRender(); markDirty();
}
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("fillBeats").addEventListener("click", askFillBeats);
$("extend").addEventListener("click", extendMeasures);
$("firstMeasure").addEventListener("click", askFirstMeasure);
$("clearMarkers").addEventListener("click", clearMarkers);

// ------------------------------------------------------------------ vista principale: gesti
const view = $("view");
let geo = new MainGeometry(S, 1, 1);
const ptrs = new Map();
let gest = null, lastTap = { time: 0, x: -99 };

function localXY(e) { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

view.addEventListener("pointerdown", e => {
  if (!S.L) return;
  view.setPointerCapture(e.pointerId);
  const p = localXY(e);
  ptrs.set(e.pointerId, p);
  if (ptrs.size === 2) { startPinch(); return; }
  if (ptrs.size > 2) return;
  const t = clamp(geo.xToTime(p.x), 0, S.duration), touch = e.pointerType !== "mouse";
  gest = { mode: "pending", x0: p.x, y0: p.y, t0: t, moved: false, shift: e.shiftKey, touch };
  if (e.button === 2) { gest = null; contextMenu(e.clientX, e.clientY, t, p.y); return; }
  if (p.y >= RULER && p.y < RULER + LANE) {
    const i = S.markers.findNear(t, geo.pxToSec(touch ? 16 : 7));
    if (i >= 0) { gest.mode = "marker"; gest.marker = S.markers.at(i); gest.cp = false; }
    else gest.mode = "lane";
  } else if (hasSel()) {
    const tol = geo.pxToSec(touch ? 20 : 6);
    if (Math.abs(t - S.selStart) < tol) gest.mode = "startEdge";
    else if (Math.abs(t - S.selEnd) < tol) gest.mode = "endEdge";
  }
  const cx = e.clientX, cy = e.clientY;
  gest.timer = setTimeout(() => {
    if (gest && !gest.moved && ptrs.size === 1) { const g = gest; gest = null; contextMenu(cx, cy, g.t0, g.y0); }
  }, 550);
});

view.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) {
    if (S.L && e.pointerType === "mouse") hoverCursor(localXY(e));
    return;
  }
  const p = localXY(e);
  ptrs.set(e.pointerId, p);
  if (pinch) { movePinch(); return; }
  if (!gest) return;
  if (!gest.moved && (Math.abs(p.x - gest.x0) > 7 || Math.abs(p.y - gest.y0) > 7)) { gest.moved = true; clearTimeout(gest.timer); }
  if (!gest.moved) return;
  const t = clamp(geo.xToTime(p.x), 0, S.duration);
  switch (gest.mode) {
    case "pending":
      gest.mode = "select";
      gest.anchor = gest.shift && hasSel() ? (Math.abs(gest.t0 - S.selStart) < Math.abs(gest.t0 - S.selEnd) ? S.selEnd : S.selStart) : gest.t0;
    // fallthrough
    case "select":
      S.selStart = Math.min(gest.anchor, t); S.selEnd = Math.max(gest.anchor, t); S.selMarker = null; selectionChanged(); break;
    case "startEdge": S.selStart = Math.min(t, S.selEnd - 0.02); selectionChanged(); break;
    case "endEdge": S.selEnd = Math.max(t, S.selStart + 0.02); selectionChanged(); break;
    case "marker":
      if (!gest.cp) { S.markers.checkpoint(); gest.cp = true; }
      S.markers.move(S.markers.indexOf(gest.marker), t); S.selMarker = gest.marker; markersEdited(); break;
    case "lane": {
      const a = S.markers.measureRange(gest.t0, S.duration), b = S.markers.measureRange(t, S.duration);
      if (a && b) { S.selStart = Math.min(a[0], b[0]); S.selEnd = Math.max(a[1], b[1]); selectionChanged(); }
      break;
    }
  }
});

function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (pinch) { if (ptrs.size < 2) { pinch = null; gest = null; } return; }
  if (!gest) return;
  clearTimeout(gest.timer);
  const g = gest; gest = null;
  if (e.type === "pointercancel" || g.moved) return;
  const now = performance.now(), dbl = now - lastTap.time < 320 && Math.abs(g.x0 - lastTap.x) < 24;
  lastTap = { time: dbl ? 0 : now, x: g.x0 };
  if (g.mode === "marker") {
    if (dbl && g.marker.type === SECTION) { renameSection(g.marker); return; }
    S.selMarker = g.marker; dirtyView = true; requestRender();
    markerMenu(e.clientX, e.clientY, g.marker);
    return;
  }
  if (g.mode === "lane") {
    const r = S.markers.measureRange(g.t0, S.duration);
    if (r) {
      if (g.shift && hasSel()) { S.selStart = Math.min(S.selStart, r[0]); S.selEnd = Math.max(S.selEnd, r[1]); }
      else { S.selStart = r[0]; S.selEnd = r[1]; }
      selectionChanged();
    } else if (!S.markers.measures().length) toast("Aggiungi i marker di battuta (M) per selezionare le battute");
    return;
  }
  if (dbl) {
    const r = S.markers.measureRange(g.t0, S.duration);
    if (r) { S.selStart = r[0]; S.selEnd = r[1]; selectionChanged(); }
    return;
  }
  if (g.shift) return;
  S.selMarker = null;
  if (hasSel()) { S.selStart = S.selEnd = 0; selectionChanged(); }
  seekTo(g.t0);
}
view.addEventListener("pointerup", endPointer);
view.addEventListener("pointercancel", endPointer);
view.addEventListener("contextmenu", e => e.preventDefault());

let pinch = null;
function startPinch() {
  if (gest) { clearTimeout(gest.timer); gest = null; }
  const [a, b] = [...ptrs.values()];
  const cx = (a.x + b.x) / 2;
  pinch = { d0: Math.max(10, Math.abs(a.x - b.x)), tc: geo.xToTime(cx), len0: S.viewEnd - S.viewStart, cx0: cx };
}
function movePinch() {
  const [a, b] = [...ptrs.values()];
  if (!a || !b) return;
  const d = Math.max(10, Math.abs(a.x - b.x)), cx = (a.x + b.x) / 2;
  const nl = clamp(pinch.len0 * pinch.d0 / d, 0.05, Math.max(0.05, S.duration));
  const frac = (cx - geo.gutter) / Math.max(1, geo.w - geo.gutter);
  S.viewStart = pinch.tc - frac * nl; S.viewEnd = S.viewStart + nl;
  clampView(); dirtyView = true; requestRender();
}

view.addEventListener("wheel", e => {
  if (!S.L) return;
  e.preventDefault();
  const p = localXY(e);
  if (e.ctrlKey || e.metaKey) zoomAround(geo.xToTime(p.x), Math.exp(e.deltaY * 0.01));
  else {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const shift = d / Math.max(1, geo.w) * (S.viewEnd - S.viewStart);
    S.viewStart += shift; S.viewEnd += shift; clampView(); dirtyView = true; requestRender();
  }
}, { passive: false });

function hoverCursor(p) {
  const t = geo.xToTime(p.x);
  let edge = false;
  if (p.y >= RULER && p.y < RULER + LANE) edge = S.markers.findNear(t, geo.pxToSec(7)) >= 0;
  else if (hasSel()) edge = Math.abs(t - S.selStart) < geo.pxToSec(6) || Math.abs(t - S.selEnd) < geo.pxToSec(6);
  view.style.cursor = edge ? "ew-resize" : "default";
}

function markerMenu(x, y, m) {
  const i = S.markers.indexOf(m);
  const what = m.type === SECTION ? "Sezione " + m.label : m.type === MEASURE ? "Battuta " + S.markers.measureNumber(i) : "Movimento";
  showMenu(x, y, [
    { label: what + " · " + fmtTime(m.time), disabled: true, action: () => {} },
    { label: "Rinomina la sezione…", hidden: m.type !== SECTION, action: () => renameSection(m) },
    { label: "Vai qui", action: () => seekTo(m.time) },
    { label: "Elimina", action: () => { S.markers.checkpoint(); S.markers.remove(S.markers.indexOf(m)); S.selMarker = null; markersEdited(); } }
  ]);
}

function contextMenu(x, y, t, ly) {
  const two = S.markers.measures().length >= 2;
  const items = [];
  if (ly >= RULER && ly < RULER + LANE) {
    const i = S.markers.findNear(t, geo.pxToSec(16));
    if (i >= 0) { markerMenu(x, y, S.markers.at(i)); return; }
  }
  items.push(
    { label: "Aggiungi una battuta qui", action: () => addMarker(MEASURE, t) },
    { label: "Aggiungi un movimento qui", action: () => addMarker(BEAT, t) },
    { label: "Aggiungi una sezione qui", action: () => addMarker(SECTION, t) },
    "-",
    { label: "Seleziona la battuta", disabled: !S.markers.measureRange(t, S.duration), action: () => { const r = S.markers.measureRange(t, S.duration); S.selStart = r[0]; S.selEnd = r[1]; selectionChanged(); } },
    { label: "Zoom sulla selezione", disabled: !hasSel(), action: zoomSel },
    "-",
    { label: "Riempi i movimenti delle battute…", disabled: !two, action: askFillBeats },
    { label: "Prosegui le battute fino alla fine", disabled: !two, action: extendMeasures }
  );
  showMenu(x, y, items);
}
function zoomSel() {
  if (!hasSel()) return;
  const pad = (S.selEnd - S.selStart) * 0.05;
  S.viewStart = S.selStart - pad; S.viewEnd = S.selEnd + pad; clampView(); dirtyView = true; requestRender();
}

// panoramica
const ov = $("overview");
function ovMove(e) {
  if (!S.L) return;
  const r = ov.getBoundingClientRect(), t = clamp((e.clientX - r.left) / r.width, 0, 1) * S.duration, l = S.viewEnd - S.viewStart;
  S.viewStart = t - l / 2; S.viewEnd = t + l / 2; clampView(); dirtyView = true; requestRender();
}
ov.addEventListener("pointerdown", e => { ov.setPointerCapture(e.pointerId); ovMove(e); });
ov.addEventListener("pointermove", e => { if (ov.hasPointerCapture(e.pointerId)) ovMove(e); });

// barra di avanzamento: tocca o trascina per spostarti; durante l'ascolto segue il trascinamento
const seekCv = $("seek");
let scrub = null;
function applyScrub(final) {
  const t = scrub.t;
  if (S.playing) {
    const now = performance.now();
    if (final || now - scrub.sent > 120) { scrub.sent = now; seekTo(t); }
  } else seekTo(t);
  if (t < S.viewStart || t > S.viewEnd) { const l = S.viewEnd - S.viewStart; S.viewStart = t - l * 0.1; S.viewEnd = S.viewStart + l; clampView(); }
  dirtyView = true; requestRender();
}
seekCv.addEventListener("pointerdown", e => {
  if (!S.L) return;
  seekCv.setPointerCapture(e.pointerId);
  scrub = { t: seekTimeAt(seekCv, e.clientX, S), sent: 0 };
  applyScrub(false);
});
seekCv.addEventListener("pointermove", e => { if (scrub) { scrub.t = seekTimeAt(seekCv, e.clientX, S); applyScrub(false); } });
seekCv.addEventListener("pointerup", e => { if (scrub) { scrub.t = seekTimeAt(seekCv, e.clientX, S); applyScrub(true); scrub = null; requestRender(); } });
seekCv.addEventListener("pointercancel", () => { scrub = null; });

// tastiera: nota di riferimento, già accordata come il disco
const kbd = $("kbd");
let kbdHover = -1;
kbd.addEventListener("pointerdown", e => {
  const r = kbd.getBoundingClientRect(), m = midiAtKeyboard(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  if (m < 0) return;
  const tune = (an && an.tuningReady ? an.tuning : 0) + S.ctl.cents;
  engine.tone(440 * Math.pow(2, (m - 69) / 12 + tune / 1200));
  kbdHover = m; spectrumDirty = true; requestRender();
  $("src").textContent = "Suona " + A.noteName(m, S.italian);
  setTimeout(() => { kbdHover = -1; spectrumDirty = true; requestRender(); }, 350);
});

document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("button");
  if (b && e.detail > 0 && !b.closest("#dlg")) b.blur();
});
document.addEventListener("change", e => { const t = e.target; if (t.tagName === "SELECT" || t.type === "checkbox" || t.type === "range") t.blur(); });

// ------------------------------------------------------------------ tastiera fisica
document.addEventListener("keydown", e => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || !$("dlgShade").hidden) return;
  const cmd = e.metaKey || e.ctrlKey, k = e.key;
  let handled = true;
  if (cmd && k.toLowerCase() === "z") e.shiftKey ? redo() : undo();
  else if (cmd && k.toLowerCase() === "a") { S.selStart = 0; S.selEnd = S.duration; selectionChanged(); }
  else if (cmd && k.toLowerCase() === "b") askFillBeats();
  else if (cmd && k.toLowerCase() === "o") $("fileAudio").click();
  else if (cmd) handled = false;
  else if (k === " ") togglePlay();
  else if (k === "Enter") playFromStart();
  else if (k === "Escape") { if (!$("library").hidden && S.L) showLibrary(false); else { S.selStart = S.selEnd = 0; S.selMarker = null; selectionChanged(); } }
  else if (k === "Home") seekTo(0);
  else if (k === "End") seekTo(S.duration - 0.01);
  else if (k === "ArrowLeft") e.altKey ? jumpMarker(-1) : nudge(e.shiftKey ? -5 : -1);
  else if (k === "ArrowRight") e.altKey ? jumpMarker(1) : nudge(e.shiftKey ? 5 : 1);
  else if (k === "ArrowUp") { e.shiftKey ? changed({ semitones: clamp(S.ctl.semitones + 1, -12, 12) }) : changed({ speed: clamp(S.ctl.speed + 5, 10, 200) }); syncControls(); }
  else if (k === "ArrowDown") { e.shiftKey ? changed({ semitones: clamp(S.ctl.semitones - 1, -12, 12) }) : changed({ speed: clamp(S.ctl.speed - 5, 10, 200) }); syncControls(); }
  else if (k === "l" || k === "L") $("loopBtn").click();
  else if (k === "m" || k === "M") addMarker(MEASURE);
  else if (k === "b" || k === "B") addMarker(BEAT);
  else if (k === "s" || k === "S") addMarker(SECTION);
  else if (k === "Backspace" || k === "Delete") deleteMarkerNear();
  else if (k === "k" || k === "K") { changed({ metronome: !S.ctl.metronome }); syncControls(); toast(S.ctl.metronome ? "Metronomo sui marker: attivo" : "Metronomo spento"); }
  else if (k === "v" || k === "V") setShowNotes(!S.showNotes);
  else if (k === "+" || k === "=") zoomAround(S.playing ? S.playPos : (S.viewStart + S.viewEnd) / 2, 0.5);
  else if (k === "-") zoomAround(S.playing ? S.playPos : (S.viewStart + S.viewEnd) / 2, 2);
  else if (k === "0") $("zoomAll").click();
  else if (k === "z" || k === "Z") zoomSel();
  else if (k === "f" || k === "F") { S.follow = !S.follow; prefs.follow = S.follow; savePrefs(); toast(S.follow ? "La vista segue la riproduzione" : "La vista resta ferma"); }
  else handled = false;
  if (handled) e.preventDefault();
});

// ------------------------------------------------------------------ disegno
let renderPending = false, dirtyView = true, spectrumDirty = true, lastSpectrum = 0, lastInfo = "";
function requestRender() { if (!renderPending) { renderPending = true; requestAnimationFrame(frame); } }
function frame(now) {
  renderPending = false;
  if (S.playing && engine.stalled()) {
    // l'audio si è interrotto (telefonata, Siri, uscita dall'app): mi fermo e preparo un motore nuovo
    engine.stop();
    S.playing = false; updatePlayButton(); dirtyView = true;
    toast("L'audio si era interrotto: tocca play per ripartire", 4000);
    engine.rebuild().then(() => { applyControls(); updateRegion(); updateClicks(); }).catch(() => {});
  }
  if (S.playing) {
    const p = engine.position();
    if (p != null) S.playPos = p;
    if (!engine.playing && S.playing) { S.playing = false; updatePlayButton(); }
    if (S.follow) {
      const l = S.viewEnd - S.viewStart;
      if (S.playPos > S.viewEnd - l * 0.02 || S.playPos < S.viewStart) { S.viewStart = S.playPos - l * 0.05; S.viewEnd = S.viewStart + l; clampView(); }
    }
  }
  const analysing = an && an.numFrames > 0 && an.done < an.numFrames;
  if (S.playing || dirtyView || analysing) {
    geo = drawMain(view, S, an);
    drawOverview(ov, S, an);
    dirtyView = false;
  }
  const seekPos = scrub ? scrub.t : shownPos();
  drawSeek(seekCv, S, seekPos);
  const tp = fmtTime(seekPos, false), tl = S.L ? fmtTime(S.duration, false) : "0:00";
  if ($("tmPos").textContent !== tp) $("tmPos").textContent = tp;
  if ($("tmLen").textContent !== tl) $("tmLen").textContent = tl;
  if (S.playing || spectrumDirty || (analysing && now - lastSpectrum > 400)) {
    if (now - lastSpectrum > (S.playing ? 90 : 0) || spectrumDirty) { updateSpectrum(); lastSpectrum = now; spectrumDirty = false; }
  }
  updateHeader();
  if (S.playing || analysing) requestRender();
}

function updateHeader() {
  const pos = shownPos();
  const clock = S.L ? fmtTime(pos) + ' <span>/ ' + fmtTime(S.duration, false) + "</span>" : '0:00.00 <span>/ 0:00</span>';
  if ($("clock").innerHTML !== clock) $("clock").innerHTML = clock;
  let info = "";
  if (S.L) {
    const parts = [], p = S.markers.position(pos);
    if (p) parts.push("Battuta " + p.measure + "." + p.beat);
    const sec = S.markers.sectionAt(pos); if (sec) parts.push("Sezione " + sec);
    const bpm = S.markers.bpmAt(pos, S.duration);
    if (bpm > 0) {
      let t = Math.round(bpm) + " BPM";
      if (S.ctl.speed !== 100) t += " (al " + S.ctl.speed + "%: " + Math.round(bpm * S.ctl.speed / 100) + ")";
      parts.push(t);
    }
    if (hasSel()) parts.push("Selezione " + (S.selEnd - S.selStart).toFixed(2).replace(".", ",") + " s");
    if (an && an.numFrames && an.done < an.numFrames) parts.push("Analisi " + Math.round(100 * an.done / an.numFrames) + "%");
    info = parts.join("  ·  ") || (S.mono ? "mono" : "stereo") + ", " + Math.round(S.sampleRate / 100) / 10 + " kHz";
  } else info = "Rallenta, ripeti e trascrivi a orecchio";
  if (info !== lastInfo) { $("info").textContent = info; lastInfo = info; }
}

function updateSpectrum() {
  let sum = null, src = "";
  if (an && an.done > 0) {
    const pos = shownPos(), fa = t => Math.round(t / an.hop);
    let a, b;
    if (S.playing) { a = pos - 0.1; b = pos + 0.1; src = "In ascolto a " + fmtTime(pos); }
    else if (hasSel()) { a = S.selStart; b = S.selEnd; src = "Media della selezione (" + (S.selEnd - S.selStart).toFixed(2).replace(".", ",") + " s)"; }
    else { a = pos - 0.15; b = pos + 0.15; src = "Al cursore, " + fmtTime(pos); }
    sum = A.summarize(an.notes, an.done, an.maxAmp, fa(a), fa(b));
  } else if (S.L) src = "Analisi in corso…";
  const tr = S.transpose, it = S.italian;
  if (!sum || !sum.valid) { $("chord").textContent = "–"; $("alts").innerHTML = "&nbsp;"; $("topNotes").innerHTML = "&nbsp;"; }
  else if (sum.silent || !sum.chords.length) { $("chord").textContent = "N.C."; $("alts").innerHTML = "&nbsp;"; $("topNotes").textContent = sum.topNotes.map(m => A.noteName(m + tr, it)).join("  ") || " "; }
  else {
    $("chord").textContent = A.chordName(sum.chords[0], tr, it);
    $("alts").textContent = "oppure  " + sum.chords.slice(1).map(c => A.chordName(c, tr, it)).join("   ");
    $("topNotes").textContent = sum.topNotes.map(m => A.noteName(m + tr, it)).join("  ");
  }
  if (kbdHover < 0) $("src").textContent = src;
  drawKeyboard(kbd, S, sum, kbdHover);
}

let wideLayout = innerWidth >= 1024;
new ResizeObserver(() => {
  const wide = innerWidth >= 1024;
  if (wide !== wideLayout) { wideLayout = wide; setPanel(wide ? !!prefs.panel : false, false); }
  $("panelShade").hidden = $("panel").hidden || wide;
  dirtyView = true; spectrumDirty = true; requestRender();
}).observe(document.body);
// niente zoom della pagina con il pizzico fuori dalla vista (Safari)
document.addEventListener("gesturestart", e => e.preventDefault());

// ------------------------------------------------------------------ analisi
function startAnalysis() {
  if (worker) worker.terminate();
  const id = ++analysisId;
  an = { id, peaks: null, hop: 0.0232, numFrames: 0, done: 0, notes: null, maxAmp: 1e-6, tuning: 0, conf: 0, tuningReady: false };
  $("tuningInfo").textContent = "Accordatura del disco: in analisi"; $("fixTuning").disabled = true;
  try { worker = new Worker("analysis-worker.js"); }
  catch (e) { toast("Analisi non disponibile qui"); return; }
  worker.onmessage = e => {
    if (!an || an.id !== id) return;
    const d = e.data;
    if (d.type === "peaks") { an.peaks = d.peaks; dirtyView = true; }
    else if (d.type === "tuning") {
      an.tuning = d.cents; an.conf = d.conf; an.tuningReady = true;
      const a4 = 440 * Math.pow(2, d.cents / 1200);
      $("tuningInfo").textContent = "Accordatura del disco: La = " + a4.toFixed(1).replace(".", ",") + " Hz (" + (d.cents >= 0 ? "+" : "") + Math.round(d.cents) + " cents)" + (d.conf < 0.25 ? ", incerta" : "");
      $("fixTuning").disabled = Math.abs(d.cents) < 1;
    }
    else if (d.type === "info") { an.hop = d.hop; an.numFrames = d.numFrames; an.notes = new Float32Array(d.numFrames * A.NUM_NOTES); }
    else if (d.type === "frames") { an.notes.set(d.data, d.start * A.NUM_NOTES); an.maxAmp = d.maxAmp; an.done = d.start + d.data.length / A.NUM_NOTES; spectrumDirty = true; }
    requestRender();
  };
  worker.onerror = () => toast("L'analisi delle note non è riuscita");
  const L = S.L.slice(), R = S.mono ? L.slice() : S.R.slice();
  worker.postMessage({ L, R, sampleRate: S.sampleRate }, [L.buffer, R.buffer]);
}

// ------------------------------------------------------------------ progetti
let saveTimer = 0;
function markDirty() { if (!S.song) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 700); }
async function saveProject() {
  clearTimeout(saveTimer);
  if (!S.song) return;
  try {
    await db.putProject(S.song.id, projectState());
    await db.touchSong(S.song.id, { markers: S.markers.items.filter(m => m.type === MEASURE).length, opened: Date.now() });
  } catch (e) { /* spazio esaurito o archivio non disponibile */ }
}
// Uscita e rientro: iPadOS sospende l'audio quando l'app va in secondo piano e a volte non lo lascia
// più ripartire. Fermo la riproduzione all'uscita e al rientro ricreo il motore audio da zero.
let wentAway = false;
function leaveApp() { wentAway = true; if (S.playing) stopPlayback(); saveProject(); }
function backToApp() {
  if (!wentAway) return;
  wentAway = false;
  engine.rebuild().then(() => { applyControls(); updateRegion(); updateClicks(); }).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (document.hidden) leaveApp(); else backToApp(); });
window.addEventListener("pagehide", leaveApp);
window.addEventListener("pageshow", e => { if (e.persisted) wentAway = true; backToApp(); });


function projectState() {
  const c = S.ctl;
  return {
    app: "Dettato", version: 1, audio: S.song ? S.song.name : "", audioRelative: S.song ? S.song.name : "",
    markers: S.markers.toJSON(), firstMeasure: S.markers.firstMeasure,
    selection: [S.selStart, S.selEnd], cursor: S.cursor, view: [S.viewStart, S.viewEnd], loop: S.loop, showNotes: S.showNotes,
    controls: {
      speed: c.speed, semitones: c.semitones, cents: c.cents, volume: c.volume, stereo: c.stereo, eqPreset: c.eqPreset,
      hpOn: c.hpOn, hpHz: c.hpHz, lpOn: c.lpOn, lpHz: c.lpHz, peakOn: c.peakOn, peakHz: c.peakHz, peakDb: c.peakDb,
      gap: c.gap, returnToStart: c.returnToStart, metronome: c.metronome, metroVolume: c.metroVolume, notes: c.notes
    }
  };
}
function applyProjectState(v) {
  if (!v || typeof v !== "object") return;
  S.markers.setAll(MarkerList.fromJSON(v.markers));
  S.markers.clearHistory();
  S.markers.firstMeasure = Number.isFinite(+v.firstMeasure) ? +v.firstMeasure : 1;
  if (Array.isArray(v.selection) && v.selection.length === 2) { S.selStart = clamp(+v.selection[0] || 0, 0, S.duration); S.selEnd = clamp(+v.selection[1] || 0, 0, S.duration); }
  if (Array.isArray(v.view) && v.view.length === 2 && v.view[1] > v.view[0]) { S.viewStart = +v.view[0]; S.viewEnd = +v.view[1]; clampView(); }
  S.cursor = S.playStart = clamp(+v.cursor || 0, 0, S.duration);
  S.loop = v.loop !== false;
  setShowNotes(!!v.showNotes);
  const c = v.controls || {}, n = (k, d) => (c[k] === undefined || c[k] === null || c[k] === "") ? d : +c[k], b = (k, d) => c[k] === undefined ? d : !!c[k];
  S.ctl = {
    speed: Math.round(clamp(n("speed", 100), 10, 200)), semitones: Math.round(clamp(n("semitones", 0), -12, 12)), cents: Math.round(clamp(n("cents", 0), -50, 50)),
    volume: clamp(n("volume", 0), -30, 12), stereo: clamp(Math.round(n("stereo", 1)), 1, 6), eqPreset: clamp(Math.round(n("eqPreset", 1)), 1, 6),
    hpOn: b("hpOn", false), hpHz: Math.round(clamp(n("hpHz", 80), 20, 2000)), lpOn: b("lpOn", false), lpHz: Math.round(clamp(n("lpHz", 8000), 200, 20000)),
    peakOn: b("peakOn", false), peakHz: Math.round(clamp(n("peakHz", 1000), 50, 8000)), peakDb: clamp(n("peakDb", 0), -18, 18),
    gap: clamp(n("gap", 0), 0, 5), returnToStart: b("returnToStart", true), metronome: b("metronome", false), metroVolume: clamp(n("metroVolume", 60), 0, 100),
    notes: c.notes ? String(c.notes) : ""
  };
  syncControls(); applyControls(); updateRegion(); updateClicks(); updatePlayButton();
  dirtyView = true; spectrumDirty = true; requestRender();
}

async function shareOrDownload(blob, name, what) {
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
  } catch (e) { if (e && e.name === "AbortError") return false; }
  try {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(what + " pronto: " + name);
    return true;
  } catch (e) { toast("Qui non posso salvare file: apri Dettato dalla sua icona"); return false; }
}

const baseName = n => n.replace(/\.[^.]+$/, "");
$("exportProject").addEventListener("click", async () => {
  if (!S.song) { toast("Apri prima un brano"); return; }
  await saveProject();
  const blob = new Blob([JSON.stringify(projectState(), null, 2)], { type: "application/octet-stream" });
  shareOrDownload(blob, baseName(S.song.name) + ".dettato", "Progetto");
});
$("importProject").addEventListener("click", () => $("fileProject").click());
$("fileProject").addEventListener("change", async e => { const f = e.target.files[0]; e.target.value = ""; if (f) importProjectFile(f); });

async function importProjectFile(file) {
  let v;
  try { v = JSON.parse(await file.text()); } catch (e) { toast(file.name + " non è un progetto di Dettato"); return; }
  if (!v || !Array.isArray(v.markers)) { toast(file.name + " non è un progetto di Dettato"); return; }
  const audioName = String(v.audio || v.audioRelative || "").split(/[\\/]/).pop();
  if (!S.L || (audioName && S.song && audioName !== S.song.name)) {
    const songs = await db.listSongs().catch(() => []);
    const match = songs.find(s => s.name === audioName);
    if (match) { await openFromLibrary(match.id); applyProjectState(v); markDirty(); toast("Progetto applicato a " + match.name); return; }
    if (!S.L) { toast("Apri prima il brano " + (audioName || "del progetto") + ", poi importa il progetto", 4000); return; }
  }
  applyProjectState(v);
  markDirty();
  toast(audioName && audioName !== S.song.name ? "Progetto di «" + audioName + "» applicato a questo brano" : "Progetto importato");
}

$("exportAudio").addEventListener("click", async () => {
  if (!S.L) { toast("Apri prima un brano"); return; }
  const c = S.ctl, a = hasSel() ? S.selStart : 0, b = hasSel() ? S.selEnd : S.duration;
  let name = baseName(S.song.name) + " - " + c.speed + "%";
  if (c.semitones) name += " " + (c.semitones > 0 ? "+" : "") + c.semitones + "st";
  if (hasSel()) name += " (selezione)";
  busy("Esporto l'audio…");
  try {
    const out = await Engine.render({ L: S.L, R: S.R, sampleRate: S.sampleRate, start: a, end: b, rate: c.speed / 100, semis: c.semitones + c.cents / 100,
      stereoMode: +c.stereo, eq: { hpOn: c.hpOn, hpHz: c.hpHz, lpOn: c.lpOn, lpHz: c.lpHz, peakOn: c.peakOn, peakHz: c.peakHz, peakDb: c.peakDb }, volumeDb: c.volume });
    busy(null);
    await shareOrDownload(encodeWav(out), name + ".wav", "Audio");
  } catch (e) { busy(null); toast("Esportazione non riuscita: " + (e.message || e)); }
});

// ------------------------------------------------------------------ apertura dei brani e libreria
async function openFile(file) {
  if (/\.(dettato|json)$/i.test(file.name)) return importProjectFile(file);
  busy("Apro " + file.name + "…");
  let buf, keep = null;
  try {
    const ab = await file.arrayBuffer();
    try { keep = ab.slice(0); } catch (e) { keep = null; }   // copia per la libreria: la decodifica consuma l'originale
    buf = await engine.decode(ab);
  } catch (e) {
    busy(null);
    toast("Non riesco a leggere «" + file.name + "». L'iPad apre MP3, M4A/AAC, WAV, AIFF, CAF, FLAC e l'audio dei video.", 5000);
    return;
  }
  const song = { id: file.name + "|" + file.size, name: file.name, size: file.size };
  let stored = true;
  try {
    const old = await db.getSong(song.id), has = old ? await db.hasAudio(song.id) : false;
    const meta = { ...song, type: file.type, duration: buf.duration, added: old ? old.added : Date.now(), opened: Date.now(), markers: old ? old.markers || 0 : 0 };
    await db.putSong(meta, has ? null : keep);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) { stored = false; }
  keep = null;
  try { await loadDecoded(buf, song); }
  catch (e) { busy(null); toast("Il brano non si è aperto: " + (e.message || e), 5000); return; }
  if (!stored) toast("Il brano è aperto, ma non posso tenerlo nella libreria (spazio pieno o navigazione privata)", 5000);
}
async function openFromLibrary(id) {
  const s = await db.getSong(id).catch(() => null);
  if (!s) { toast("Brano non trovato"); return; }
  busy("Apro " + s.name + "…");
  try {
    const data = await db.getAudio(id);
    if (!data) throw new Error("audio mancante");
    const buf = await engine.decode(data);
    await db.touchSong(id, { opened: Date.now() }).catch(() => {});
    await loadDecoded(buf, { id: s.id, name: s.name, size: s.size });
  } catch (e) { busy(null); toast("Non riesco ad aprire «" + s.name + "». Riaprilo dall'app File.", 5000); }
}
async function loadDecoded(buf, song) {
  if (S.playing) stopPlayback();
  await saveProject();
  S.song = song; S.buffer = buf;
  S.L = buf.getChannelData(0); S.R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : S.L; S.mono = buf.numberOfChannels === 1;
  S.sampleRate = buf.sampleRate;
  S.markers = new MarkerList(); S.selMarker = null;
  S.cursor = S.playStart = S.selStart = S.selEnd = 0; S.viewStart = 0; S.viewEnd = S.duration; S.playing = false;
  S.ctl = { ...DEFAULTS }; S.loop = true;
  await engine.setAudio(S.L, S.R, S.sampleRate);
  syncControls(); applyControls(); updateRegion(); updateClicks();
  startAnalysis();
  const saved = await db.getProject(song.id).catch(() => null);
  if (saved) applyProjectState(saved); else setShowNotes(false);
  $("title").firstChild.textContent = song.name;
  $("empty").hidden = true;
  showLibrary(false);
  busy(null);
  updatePlayButton(); dirtyView = true; spectrumDirty = true; requestRender();
  if (saved && S.markers.size) toast("Marker e impostazioni ripresi da dove avevi lasciato");
}

$("fileAudio").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); });
for (const id of ["emptyOpen", "libOpen"]) $(id).addEventListener("click", () => $("fileAudio").click());
$("libBtn").addEventListener("click", () => showLibrary(true));
$("libClose").addEventListener("click", () => showLibrary(false));
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });

async function showLibrary(open) {
  $("library").hidden = !open;
  $("libClose").hidden = !S.L;
  if (!open) return;
  if (S.playing) stopPlayback();
  $("installHint").hidden = isStandalone();
  const ul = $("songs"); ul.innerHTML = "";
  let songs = [];
  try { songs = await db.listSongs(); } catch (e) { /* archivio non disponibile */ }
  songs.sort((a, b) => (b.opened || 0) - (a.opened || 0));
  if (!songs.length) { const li = document.createElement("li"); li.className = "libEmpty"; li.textContent = "Nessun brano ancora. I brani che apri restano qui, con i loro marker."; ul.appendChild(li); }
  for (const s of songs) {
    const li = document.createElement("li");
    const open = document.createElement("button"); open.className = "open";
    const b = document.createElement("b"); b.textContent = s.name;
    const sp = document.createElement("span");
    const when = s.opened ? new Date(s.opened).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : "";
    sp.textContent = [fmtTime(s.duration || 0, false), s.markers ? s.markers + " battute segnate" : "", when ? "aperto il " + when : ""].filter(Boolean).join("  ·  ");
    open.append(b, sp);
    open.onclick = () => openFromLibrary(s.id);
    const del = document.createElement("button"); del.className = "btn ghost del"; del.setAttribute("aria-label", "Togli " + s.name);
    del.innerHTML = '<svg class="i"><use href="#i-trash"/></svg>';
    del.onclick = async () => {
      const ok = await dialog({ title: "Togliere il brano?", message: "«" + s.name + "» e i suoi marker spariscono da Dettato su questo iPad. Il file originale resta dov'era.", ok: "Togli" });
      if (!ok) return;
      await db.deleteSong(s.id).catch(() => {});
      if (S.song && S.song.id === s.id) S.song = { ...S.song, id: S.song.id + "|tolto" };
      showLibrary(true);
    };
    li.append(open, del);
    ul.appendChild(li);
  }
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      $("storage").textContent = "Spazio usato da Dettato: " + Math.round((est.usage || 0) / 1048576) + " MB";
    }
  } catch (e) { /* niente */ }
}

// ------------------------------------------------------------------ avvio
syncControls();
updatePlayButton();
setPanel(innerWidth >= 1024 && (prefs.panel === undefined ? innerWidth >= 1180 : !!prefs.panel), false);
showLibrary(true);
requestRender();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(reg => {
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      if (w) w.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) toast("È pronta una nuova versione di Dettato: chiudi e riapri l'app", 6000);
      });
    });
  }).catch(() => { /* fuori da un sito vero (anteprima): niente uso offline */ });
}

// per i test automatici
window.__dettato = { S, engine, get an() { return an; }, openFile, togglePlay, seekTo, addMarker, projectState, applyProjectState, setShowNotes, showLibrary };
