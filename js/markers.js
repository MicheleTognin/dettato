// Marker di sezione, battuta e movimento (come nella versione per Mac), con annulla/ripeti.
export const SECTION = 0, MEASURE = 1, BEAT = 2;

export class MarkerList {
  constructor() { this.list = []; this.undoStack = []; this.redoStack = []; this.firstMeasure = 1; }

  get size() { return this.list.length; }
  get items() { return this.list; }
  at(i) { return this.list[i]; }

  checkpoint() {
    this.undoStack.push(this.list.map(m => ({ ...m })));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(this.list); this.list = this.undoStack.pop(); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(this.list); this.list = this.redoStack.pop(); return true; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  clearHistory() { this.undoStack = []; this.redoStack = []; }

  setAll(arr) { this.list = arr.map(m => ({ time: +m.time, type: m.type, label: m.label || "" })); this.sort(); }
  clear() { this.list = []; }

  sort() { this.list.sort((a, b) => a.time - b.time || a.type - b.type); }
  indexOf(m) { return this.list.indexOf(m); }

  add(m) {
    for (let i = 0; i < this.list.length; i++)
      if (this.list[i].type === m.type && Math.abs(this.list[i].time - m.time) < 0.02) return i;
    const nm = { time: Math.max(0, m.time), type: m.type, label: m.label || "" };
    if (nm.type === SECTION && !nm.label) nm.label = this.nextSectionLabel();
    this.list.push(nm);
    this.sort();
    return this.list.indexOf(nm);
  }
  remove(i) { if (i >= 0 && i < this.list.length) this.list.splice(i, 1); }
  move(i, t) {
    const m = this.list[i]; if (!m) return i;
    m.time = Math.max(0, t);
    this.sort();
    return this.list.indexOf(m);
  }
  setLabel(i, s) { if (this.list[i]) this.list[i].label = s; }

  findNear(t, tol) {
    let best = -1, bd = tol;
    this.list.forEach((m, i) => {
      const d = Math.abs(m.time - t);
      if (d < bd || (best >= 0 && d <= bd + 1e-9 && m.type < this.list[best].type)) { bd = d; best = i; }
    });
    return best;
  }

  measures() { return this.list.filter(m => m.type === MEASURE).map(m => m.time); }
  measureNumber(index) {
    let n = this.firstMeasure;
    for (let i = 0; i < index; i++) if (this.list[i].type === MEASURE) n++;
    return n;
  }
  measureRange(t, fileLength) {
    const ms = this.measures();
    if (!ms.length || t < ms[0]) return null;
    for (let i = 0; i < ms.length; i++) {
      const next = i + 1 < ms.length ? ms[i + 1] : fileLength;
      if (t >= ms[i] && t < next) return [ms[i], next];
    }
    return null;
  }
  position(t) {
    let measure = this.firstMeasure - 1, beat = 1, found = false;
    for (const m of this.list) {
      if (m.time > t + 1e-9) break;
      if (m.type === MEASURE) { measure++; beat = 1; found = true; }
      else if (m.type === BEAT && found) beat++;
    }
    return found ? { measure, beat } : null;
  }
  sectionAt(t) {
    let s = "";
    for (const m of this.list) { if (m.time > t + 1e-9) break; if (m.type === SECTION) s = m.label; }
    return s;
  }
  bpmAt(t, fileLength) {
    const r = this.measureRange(t, fileLength); if (!r) return 0;
    const [s, e] = r, ms = this.measures();
    if (ms.length < 2 && e >= fileLength) return 0;
    let beats = 1;
    for (const m of this.list) if (m.type === BEAT && m.time > s + 1e-6 && m.time < e - 1e-6) beats++;
    if (beats < 2) return 0;
    return beats * 60 / (e - s);
  }
  fillBeats(n) {
    const ms = this.measures();
    if (ms.length < 2 || n < 2) return;
    this.list = this.list.filter(m => !(m.type === BEAT && m.time > ms[0] && m.time < ms[ms.length - 1]));
    for (let i = 0; i + 1 < ms.length; i++)
      for (let k = 1; k < n; k++) this.list.push({ time: ms[i] + (ms[i + 1] - ms[i]) * k / n, type: BEAT, label: "" });
    this.sort();
  }
  extendMeasures(fileLength) {
    const ms = this.measures();
    if (ms.length < 2) return;
    const a = ms[ms.length - 2], b = ms[ms.length - 1], len = b - a;
    if (len < 0.2) return;
    const offs = this.list.filter(m => m.type === BEAT && m.time > a + 1e-6 && m.time < b - 1e-6).map(m => m.time - a);
    for (let t = b + len; t < fileLength - 0.05; t += len) {
      this.list.push({ time: t, type: MEASURE, label: "" });
      for (const o of offs) this.list.push({ time: t - len + o, type: BEAT, label: "" });
    }
    const last = this.measures().pop();
    for (const o of offs) if (last + o < fileLength) this.list.push({ time: last + o, type: BEAT, label: "" });
    this.sort();
    const out = [];
    for (const m of this.list) if (!out.some(o => o.type === m.type && Math.abs(o.time - m.time) < 0.01)) out.push(m);
    this.list = out;
  }
  nextSectionLabel() {
    const used = new Set(this.list.filter(m => m.type === SECTION).map(m => m.label));
    for (let c = 65; c <= 90; c++) { const s = String.fromCharCode(c); if (!used.has(s)) return s; }
    return "Z" + used.size;
  }

  // formato .dettato (lo stesso del Mac)
  toJSON() {
    return this.list.map(m => {
      const o = { t: m.time, type: m.type === SECTION ? "section" : m.type === MEASURE ? "measure" : "beat" };
      if (m.label) o.label = m.label;
      return o;
    });
  }
  static fromJSON(arr) {
    return (arr || []).map(m => ({
      time: +m.t || 0,
      type: m.type === "section" ? SECTION : m.type === "beat" ? BEAT : MEASURE,
      label: m.label ? String(m.label) : ""
    }));
  }
}
