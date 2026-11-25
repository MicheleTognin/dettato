// Disegno delle viste (stesse scelte della versione per Mac).
import { SECTION, MEASURE } from "./markers.js";

const A = window.DettatoAnalysis;
export const RULER = 22, LANE = 40, GUTTER = 46;
export const KB_LOW = 21, KB_HIGH = 108;

export const C = {
  bg: "#15161a", panel: "#1d1f25", panel2: "#252830", line: "#31353f", text: "#e9e6e1", dim: "#969ca5",
  accent: "#f2a33a", wave: "#6f9fc8", waveDim: "#3f5d78", section: "#ff7a59", playhead: "#ffd27a", cursor: "#4fc3b0"
};

const HEAT = ["#15161a", "#23304a", "#5a2f6e", "#c2533a", "#f2a33a", "#fff1c9"].map(h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)));
function heat(v) {
  v = Math.min(1, Math.max(0, v));
  const x = v * 5, i = Math.min(4, Math.floor(x)), f = x - i, a = HEAT[i], b = HEAT[i + 1];
  return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f));
}
const LUT = (() => {
  const u = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { const [r, g, b] = heat(i / 255); u[i] = (255 << 24) | (b << 16) | (g << 8) | r; }
  return u;
})();
const packRGB = h => { const r = parseInt(h.substr(1, 2), 16), g = parseInt(h.substr(3, 2), 16), b = parseInt(h.substr(5, 2), 16); return (255 << 24) | (b << 16) | (g << 8) | r; };
const ROLL_WHITE = packRGB("#18191e"), ROLL_BLACK = packRGB("#121317");

export const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

export function fmtTime(s, hundredths = true) {
  if (!(s > 0)) s = 0;
  // arrotonda prima di separare minuti e secondi: 3,9999999 deve diventare 0:04, non 0:03
  s = hundredths ? Math.round(s * 100) / 100 : Math.floor(s + 1e-6);
  const m = Math.floor(s / 60), r = s - m * 60;
  if (hundredths) { const t = r.toFixed(2); return m + ":" + (r < 10 ? "0" : "") + t; }
  return m + ":" + String(Math.floor(r)).padStart(2, "0");
}

// prepara il canvas alla risoluzione dello schermo e restituisce il contesto in pixel CSS
export function fit(canvas) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h, dpr };
}

export class MainGeometry {
  constructor(S, w, h) { this.S = S; this.w = w; this.h = h; }
  get gutter() { return this.S.showNotes ? GUTTER : 0; }
  timeToX(t) { const S = this.S; return this.gutter + (t - S.viewStart) / (S.viewEnd - S.viewStart) * (this.w - this.gutter); }
  xToTime(x) { const S = this.S; return S.viewStart + (x - this.gutter) / Math.max(1, this.w - this.gutter) * (S.viewEnd - S.viewStart); }
  pxToSec(px) { const S = this.S; return px * (S.viewEnd - S.viewStart) / Math.max(1, this.w - this.gutter); }
}

const rollCache = { key: "", canvas: null };
const layer = { key: "", canvas: null };

function markersKey(S) {
  let k = S.markers.firstMeasure + ":" + S.markers.size;
  for (const m of S.markers.items) k += "," + m.type + m.time.toFixed(4) + m.label;
  return k;
}

// La parte fissa (righello, marker, onda o piano roll, selezione, cursore) si ridisegna solo quando cambia;
// a ogni fotogramma si aggiunge soltanto la testina.
export function drawMain(canvas, S, an) {
  const { g, w, h, dpr } = fit(canvas);
  const geo = new MainGeometry(S, w, h);
  if (!S.L) { g.fillStyle = C.bg; g.fillRect(0, 0, w, h); layer.key = ""; return geo; }
  const key = [w, h, dpr, S.viewStart.toFixed(5), S.viewEnd.toFixed(5), S.showNotes, S.selStart.toFixed(4), S.selEnd.toFixed(4),
    S.cursor.toFixed(4), S.italian, S.transpose, S.mono, S.selMarker ? S.markers.indexOf(S.selMarker) : -1, markersKey(S),
    an ? an.id + ":" + (an.peaks ? 1 : 0) + ":" + Math.floor(an.done / 200) : 0].join("|");
  if (key !== layer.key || !layer.canvas) {
    layer.key = key;
    const cv = layer.canvas || (layer.canvas = document.createElement("canvas"));
    cv.width = canvas.width; cv.height = canvas.height;
    const lg = cv.getContext("2d");
    lg.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStatic(lg, geo, S, an, w, h);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(layer.canvas, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.playing && S.playPos >= S.viewStart && S.playPos <= S.viewEnd) drawPlayhead(g, geo.timeToX(S.playPos), h);
  return geo;
}

function drawPlayhead(g, x, h) {
  g.save();
  g.shadowColor = "rgba(255,210,122,0.55)"; g.shadowBlur = 8;
  g.fillStyle = C.playhead;
  g.fillRect(x - 1.25, RULER, 2.5, h - RULER);
  g.shadowBlur = 0;
  g.beginPath(); g.moveTo(x - 8, 0); g.lineTo(x + 8, 0); g.lineTo(x, 13); g.closePath(); g.fill();
  g.restore();
}

function drawStatic(g, geo, S, an, w, h) {
  g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
  const top = RULER + LANE, ch = h - top;
  drawRuler(g, geo, w);
  drawLane(g, geo, S, w);
  if (S.showNotes) drawRoll(g, geo, S, an, top, w, ch); else drawWave(g, geo, S, an, top, w, ch);

  // griglia dai marker
  for (const m of S.markers.items) {
    if (m.time < S.viewStart || m.time > S.viewEnd) continue;
    const x = Math.round(geo.timeToX(m.time)) + 0.5;
    g.strokeStyle = m.type === SECTION ? "rgba(255,122,89,0.7)" : m.type === MEASURE ? "rgba(233,230,225,0.28)" : "rgba(233,230,225,0.10)";
    g.lineWidth = 1; g.beginPath(); g.moveTo(x, top); g.lineTo(x, h); g.stroke();
  }

  // selezione
  if (S.selEnd - S.selStart > 0.01) {
    const x0 = Math.max(geo.gutter, geo.timeToX(S.selStart)), x1 = Math.min(w, geo.timeToX(S.selEnd));
    if (x1 > x0) {
      g.fillStyle = "rgba(242,163,58,0.15)"; g.fillRect(x0, RULER, x1 - x0, h - RULER);
      g.fillStyle = C.accent;
      for (const t of [S.selStart, S.selEnd]) {
        if (t < S.viewStart || t > S.viewEnd) continue;
        const x = geo.timeToX(t);
        g.fillRect(Math.round(x) - 1, RULER, 2, h - RULER);
        // maniglie da trascinare con il dito
        g.beginPath(); g.arc(x, h - 18, 9, 0, Math.PI * 2); g.fill();
      }
    }
  }

  // cursore (punto di partenza)
  if (S.cursor >= S.viewStart && S.cursor <= S.viewEnd) {
    const x = geo.timeToX(S.cursor);
    g.fillStyle = "rgba(79,195,176,0.95)"; g.fillRect(Math.round(x) - 0.75, RULER, 1.5, h - RULER);
    g.beginPath(); g.moveTo(x - 6, RULER); g.lineTo(x + 6, RULER); g.lineTo(x, RULER + 9); g.closePath(); g.fill();
  }
}

function drawRuler(g, geo, w) {
  const S = geo.S;
  g.fillStyle = C.panel; g.fillRect(0, 0, w, RULER);
  const pxPerSec = (w - geo.gutter) / (S.viewEnd - S.viewStart);
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let step = 600; for (const s of steps) if (s * pxPerSec >= 84) { step = s; break; }
  const minor = step / 5;
  g.font = "11px -apple-system, system-ui, sans-serif"; g.textBaseline = "middle";
  // posizioni calcolate da un indice intero, senza sommare errori di arrotondamento
  const perMajor = 5;
  for (let i = Math.max(0, Math.floor(S.viewStart / minor)); i * minor <= S.viewEnd + 1e-9; i++) {
    const t = Math.round(i * minor * 1000) / 1000;
    const x = Math.round(geo.timeToX(t)) + 0.5;
    const major = i % perMajor === 0;
    g.strokeStyle = major ? "rgba(150,156,165,0.9)" : "rgba(150,156,165,0.35)";
    g.beginPath(); g.moveTo(x, RULER - (major ? 8 : 4)); g.lineTo(x, RULER); g.stroke();
    if (major) { g.fillStyle = C.dim; g.fillText(fmtTime(t, step < 1).replace(/\.00$/, ""), x + 4, RULER / 2 - 1); }
  }
}

function drawLane(g, geo, S, w) {
  g.fillStyle = C.panel2; g.fillRect(0, RULER, w, LANE);
  g.fillStyle = C.line; g.fillRect(0, RULER + LANE - 1, w, 1);
  const items = S.markers.items;
  let num = S.markers.firstMeasure - 1;
  g.textBaseline = "middle";
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    if (m.type === MEASURE) num++;
    if (m.time < S.viewStart - 10 || m.time > S.viewEnd) continue;
    const x = Math.round(geo.timeToX(m.time)) + 0.5, sel = S.selMarker === m;
    if (m.type === SECTION) {
      g.font = "600 12px -apple-system, system-ui, sans-serif";
      const tw = Math.max(24, g.measureText(m.label).width + 12);
      g.fillStyle = sel ? C.text : C.section;
      roundRect(g, x, RULER + 3, tw, 17, 4); g.fill();
      g.fillStyle = C.bg; g.fillText(m.label, x + 6, RULER + 12);
      g.strokeStyle = C.section; g.beginPath(); g.moveTo(x, RULER); g.lineTo(x, RULER + LANE); g.stroke();
    } else if (m.type === MEASURE) {
      g.strokeStyle = sel ? C.accent : "rgba(233,230,225,0.85)"; g.lineWidth = sel ? 3 : 1;
      g.beginPath(); g.moveTo(x, RULER + LANE - 17); g.lineTo(x, RULER + LANE); g.stroke(); g.lineWidth = 1;
      const next = i + 1 < items.length ? geo.timeToX(items[i + 1].time) - x : 100;
      if (next > 16 || i + 1 >= items.length) {
        g.font = "600 11px -apple-system, system-ui, sans-serif"; g.fillStyle = sel ? C.accent : "rgba(233,230,225,0.85)";
        g.fillText(String(num), x + 3, RULER + LANE - 9);
      }
    } else {
      g.strokeStyle = sel ? C.accent : "rgba(150,156,165,0.8)"; g.lineWidth = sel ? 3 : 1;
      g.beginPath(); g.moveTo(x, RULER + LANE - 7); g.lineTo(x, RULER + LANE); g.stroke(); g.lineWidth = 1;
    }
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawWave(g, geo, S, an, top, w, ch) {
  const sr = S.sampleRate, len = S.L.length, lanes = S.mono ? 1 : 2;
  const laneH = (ch - (lanes - 1) * 2) / lanes, dpr = window.devicePixelRatio || 1;
  const peaks = an && an.peaks;
  const step = 1 / dpr;
  for (let c = 0; c < lanes; c++) {
    const y0 = top + c * (laneH + 2), mid = y0 + laneH / 2, half = laneH * 0.47;
    g.fillStyle = "rgba(29,31,37,0.5)"; g.fillRect(0, y0, w, laneH);
    g.fillStyle = C.line; g.fillRect(0, Math.round(mid), w, 1);
    const src = c === 0 ? S.L : S.R;
    const pk = peaks ? peaks.ch[c] : null;
    for (let x = 0; x < w; x += step) {
      const t0 = geo.xToTime(x), t1 = geo.xToTime(x + step);
      if (t1 < 0 || t0 > len / sr) continue;
      const s0 = Math.min(len - 1, Math.max(0, Math.floor(t0 * sr)));
      const s1 = Math.min(len, Math.max(s0 + 1, Math.floor(t1 * sr) + 1));
      const spp = (t1 - t0) * sr;
      let lo = 0, hi = 0;
      if (pk && spp >= peaks.block2) {
        for (let k = Math.floor(s0 / peaks.block2); k <= Math.floor((s1 - 1) / peaks.block2) && k < pk.max2.length; k++) { if (pk.min2[k] < lo) lo = pk.min2[k]; if (pk.max2[k] > hi) hi = pk.max2[k]; }
      } else if (pk && spp >= peaks.block) {
        for (let k = Math.floor(s0 / peaks.block); k <= Math.floor((s1 - 1) / peaks.block) && k < pk.max.length; k++) { if (pk.min[k] < lo) lo = pk.min[k]; if (pk.max[k] > hi) hi = pk.max[k]; }
      } else {
        const stride = Math.max(1, Math.floor((s1 - s0) / 256));
        lo = hi = src[s0];
        for (let i = s0; i < s1; i += stride) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (spp < 1 && s0 + 1 < len) { lo = Math.min(lo, src[s0 + 1]); hi = Math.max(hi, src[s0 + 1]); }
      }
      const inSel = S.selEnd - S.selStart > 0.01 && t0 >= S.selStart && t1 <= S.selEnd;
      g.fillStyle = inSel ? "#9cc0e0" : C.wave;
      const yA = mid - Math.min(1, hi) * half, yB = mid - Math.max(-1, lo) * half;
      g.fillRect(x, yA, step, Math.max(step, yB - yA));
    }
  }
}

function drawRoll(g, geo, S, an, top, w, ch) {
  const lo = KB_LOW, hi = KB_HIGH, rows = hi - lo + 1, gut = geo.gutter;
  const aw = Math.max(1, Math.floor(w - gut)), ah = Math.max(1, Math.floor(ch)), rowH = ah / rows;
  const done = an ? an.done : 0;
  const key = [S.viewStart.toFixed(4), S.viewEnd.toFixed(4), aw, ah, Math.floor(done / 200), S.transpose, an ? an.id : 0].join("|");
  if (an && an.notes && key !== rollCache.key) {
    rollCache.key = key;
    const cv = rollCache.canvas || (rollCache.canvas = document.createElement("canvas"));
    cv.width = aw; cv.height = ah;
    const cg = cv.getContext("2d"), img = cg.createImageData(aw, ah), px = new Uint32Array(img.data.buffer);
    const gmax = Math.max(1e-6, an.maxAmp), col = new Float32Array(rows), NN = A.NUM_NOTES;
    for (let x = 0; x < aw; x++) {
      const t0 = geo.xToTime(x + gut), t1 = geo.xToTime(x + gut + 1);
      const f0 = Math.floor(t0 / an.hop), f1 = Math.max(f0, Math.floor(t1 / an.hop));
      const valid = f0 >= 0 && f0 < done, fstep = Math.max(1, Math.floor((f1 - f0) / 6));
      for (let r = 0; r < rows; r++) {
        const k = (hi - r) - S.transpose - A.LOW_MIDI;
        let v = -1;
        if (valid && k >= 0 && k < NN) {
          let m = 0;
          for (let f = f0; f <= f1 && f < done; f += fstep) { const a = an.notes[f * NN + k]; if (a > m) m = a; }
          v = (20 * Math.log10(m / gmax + 1e-9) + 54) / 54;
        }
        col[r] = v;
      }
      for (let y = 0; y < ah; y++) {
        const r = Math.min(rows - 1, Math.floor(y / rowH)), v = col[r];
        px[y * aw + x] = v <= 0.02 ? (isBlack(hi - r) ? ROLL_BLACK : ROLL_WHITE) : LUT[Math.min(255, Math.max(0, Math.floor(v * 255)))];
      }
    }
    cg.putImageData(img, 0, 0);
  }
  if (rollCache.canvas && rollCache.key === key) { g.imageSmoothingEnabled = false; g.drawImage(rollCache.canvas, gut, top, aw, ah); }
  g.fillStyle = C.panel; g.fillRect(0, top, gut, ch);
  g.font = "10.5px -apple-system, system-ui, sans-serif"; g.textBaseline = "alphabetic"; g.textAlign = "right";
  for (let m = lo; m <= hi; m++) {
    if (((m % 12) + 12) % 12 !== 0) continue;
    const y = top + (hi - m + 1) * rowH;
    g.fillStyle = "rgba(49,53,63,0.9)"; g.fillRect(gut, Math.round(y), w - gut, 1);
    g.fillStyle = C.dim; g.fillText(A.noteName(m, S.italian), gut - 5, y - 2);
  }
  g.textAlign = "left";
}

export function drawOverview(canvas, S, an) {
  const { g, w, h } = fit(canvas);
  g.fillStyle = C.panel; g.fillRect(0, 0, w, h);
  if (!S.L) return;
  const len = S.duration, tx = t => t / len * w;
  if (an && an.peaks) {
    const pk = an.peaks.ch[0], n = pk.max2.length, mid = h / 2, half = h * 0.42;
    g.fillStyle = C.waveDim;
    for (let x = 0; x < w; x++) {
      const k0 = Math.floor(x / w * n), k1 = Math.max(k0 + 1, Math.floor((x + 1) / w * n));
      let lo = 0, hi = 0;
      for (let k = k0; k < k1 && k < n; k++) { if (pk.min2[k] < lo) lo = pk.min2[k]; if (pk.max2[k] > hi) hi = pk.max2[k]; }
      g.fillRect(x, mid - hi * half, 1, Math.max(1, (hi - lo) * half));
    }
  }
  if (S.selEnd - S.selStart > 0.01) { g.fillStyle = "rgba(242,163,58,0.3)"; g.fillRect(tx(S.selStart), 0, Math.max(1, tx(S.selEnd) - tx(S.selStart)), h); }
  g.fillStyle = C.section;
  for (const m of S.markers.items) if (m.type === SECTION) g.fillRect(Math.round(tx(m.time)), 0, 1, h);
  g.strokeStyle = "rgba(233,230,225,0.75)"; g.lineWidth = 1.5;
  g.strokeRect(tx(S.viewStart), 1, Math.max(4, tx(S.viewEnd) - tx(S.viewStart)), h - 2);
  const pos = S.playing ? S.playPos : S.cursor, px = tx(pos);
  if (S.playing) { g.fillStyle = "rgba(255,210,122,0.16)"; g.fillRect(0, 0, px, h); }
  g.fillStyle = S.playing ? C.playhead : C.cursor;
  g.fillRect(Math.round(px) - 1, 0, 2, h);
}

// barra di avanzamento: brano intero, parte ascoltata, selezione, sezioni e cursore
export function drawSeek(canvas, S, pos) {
  const { g, w, h } = fit(canvas);
  g.clearRect(0, 0, w, h);
  const pad = 10, tw = Math.max(1, w - 2 * pad), cy = Math.round(h / 2), len = Math.max(0.001, S.duration);
  const tx = t => pad + Math.min(1, Math.max(0, t / len)) * tw;
  g.fillStyle = C.line; roundRect(g, pad, cy - 3, tw, 6, 3); g.fill();
  if (!S.L) return;
  if (S.selEnd - S.selStart > 0.01) { g.fillStyle = "rgba(242,163,58,0.35)"; g.fillRect(tx(S.selStart), cy - 7, Math.max(2, tx(S.selEnd) - tx(S.selStart)), 14); }
  g.fillStyle = S.playing ? C.playhead : C.accent;
  roundRect(g, pad, cy - 3, Math.max(6, tx(pos) - pad), 6, 3); g.fill();
  g.fillStyle = C.section;
  for (const m of S.markers.items) if (m.type === SECTION) g.fillRect(Math.round(tx(m.time)) - 1, cy - 11, 2, 6);
  const x = tx(pos);
  g.save(); g.shadowColor = "rgba(0,0,0,0.5)"; g.shadowBlur = 6;
  g.fillStyle = "#fff6e3"; g.beginPath(); g.arc(x, cy, 9, 0, Math.PI * 2); g.fill(); g.restore();
  g.fillStyle = S.playing ? C.playhead : C.accent; g.beginPath(); g.arc(x, cy, 5, 0, Math.PI * 2); g.fill();
}
export function seekTimeAt(canvas, clientX, S) {
  const r = canvas.getBoundingClientRect(), pad = 10, tw = Math.max(1, r.width - 2 * pad);
  return Math.min(1, Math.max(0, (clientX - r.left - pad) / tw)) * S.duration;
}

// --- tastiera con lo spettro ---
export function kbRange(w) {
  if (w >= 640) return [KB_LOW, KB_HIGH];      // 88 tasti
  if (w >= 420) return [36, 96];               // Do1–Do6 (italiano)
  return [48, 84];                             // Do2–Do5
}
export function keyRects(w, h) {
  const [lo, hi] = kbRange(w);
  let whites = 0; for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites++;
  const ww = w / whites, keyTop = h * 0.5, keyH = h * 0.5, rects = {};
  let idx = 0;
  for (let m = lo; m <= hi; m++) {
    if (!isBlack(m)) { rects[m] = { x: idx * ww, y: keyTop, w: ww, h: keyH, black: false }; idx++; }
    else { const bw = ww * 0.62; rects[m] = { x: idx * ww - bw / 2, y: keyTop, w: bw, h: keyH * 0.62, black: true }; }
  }
  return { rects, ww, lo, hi, barTop: 0, barBottom: h * 0.48 };
}

export function midiAtKeyboard(x, y, w, h) {
  const { rects, lo, hi } = keyRects(w, h);
  for (let m = lo; m <= hi; m++) { const r = rects[m]; if (r.black && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return m; }
  for (let m = lo; m <= hi; m++) { const r = rects[m]; if (!r.black && x >= r.x && x <= r.x + r.w) return m; }
  return -1;
}

export function drawKeyboard(canvas, S, sum, hover) {
  const { g, w, h } = fit(canvas);
  g.fillStyle = C.panel; g.fillRect(0, 0, w, h);
  const { rects, ww, barBottom, lo, hi } = keyRects(w, h);
  const tr = S.transpose, strong = new Set();
  if (sum) for (const m of sum.topNotes) strong.add(m + tr);
  for (const pass of [false, true])
    for (let m = lo; m <= hi; m++) {
      const r = rects[m]; if (r.black !== pass) continue;
      let fill = r.black ? "#1a1b20" : "#d9d6d0";
      if (strong.has(m)) fill = r.black ? "#b87828" : C.accent;
      if (m === hover) fill = C.cursor;
      g.fillStyle = fill; g.fillRect(r.x + (r.black ? 0 : 0.5), r.y, r.w - (r.black ? 0 : 1), r.h);
      if (!r.black && ((m % 12) + 12) % 12 === 0 && ww > 11) {
        g.fillStyle = "#55585f"; g.font = "9px -apple-system, system-ui, sans-serif"; g.textAlign = "center";
        g.fillText(A.noteName(m, S.italian), r.x + r.w / 2, r.y + r.h - 5); g.textAlign = "left";
      }
    }
  g.fillStyle = C.bg; g.fillRect(0, 0, w, barBottom);
  if (sum && sum.valid) {
    for (let k = 0; k < A.NUM_NOTES; k++) {
      const m = k + A.LOW_MIDI + tr; if (m < lo || m > hi) continue;
      const v = sum.levels[k]; if (v <= 0.01) continue;
      const r = rects[m], bh = v * (barBottom - 3), bw = ww * 0.56;
      const [cr, cg, cb] = heat(0.25 + 0.6 * v);
      g.fillStyle = strong.has(m) ? C.accent : `rgb(${cr},${cg},${cb})`;
      g.fillRect(r.x + r.w / 2 - bw / 2, barBottom - bh, bw, bh);
    }
  }
}
