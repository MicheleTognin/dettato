// Motore di riproduzione: Signalsmith Stretch (lo stesso del Mac) in un AudioWorklet.
// Rallenta senza cambiare intonazione, traspone, ripete la selezione con pausa,
// suona il metronomo sui marker e le note di riferimento.
import SignalsmithStretch from "../vendor/SignalsmithStretch.mjs";

const LEAD = 0.06;        // anticipo con cui si programmano i cambi (s)
const LOOKAHEAD = 0.35;   // finestra di programmazione di loop e click (s)
const FADE = 0.008;

export const STEREO = { normal: 1, mono: 2, left: 3, right: 4, karaoke: 5, swap: 6 };

export function makeBuffers(L, R, mode, s0 = 0, s1 = L.length) {
  const n = s1 - s0, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = L[s0 + i], b = R[s0 + i];
    switch (mode) {
      case 2: a = b = 0.5 * (a + b); break;
      case 3: b = a; break;
      case 4: a = b; break;
      case 5: a = b = a - b; break;
      case 6: { const t = a; a = b; b = t; break; }
    }
    l[i] = a; r[i] = b;
  }
  return [l, r];
}

function buildEq(ctx, input, output, eq) {
  // passa-alto e passa-basso a 24 dB/ottava (due biquad Butterworth), più una campana.
  // In Web Audio il Q di passa-alto e passa-basso è in dB.
  const qdB = [20 * Math.log10(0.5411961), 20 * Math.log10(1.3065630)];
  const nodes = [];
  if (eq.hpOn) for (const q of qdB) { const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = eq.hpHz; f.Q.value = q; nodes.push(f); }
  if (eq.lpOn) for (const q of qdB) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = Math.min(eq.lpHz, ctx.sampleRate * 0.45); f.Q.value = q; nodes.push(f); }
  if (eq.peakOn && Math.abs(eq.peakDb) > 0.01) { const f = ctx.createBiquadFilter(); f.type = "peaking"; f.frequency.value = eq.peakHz; f.Q.value = eq.peakQ || 1.2; f.gain.value = eq.peakDb; nodes.push(f); }
  let prev = input;
  for (const n of nodes) { prev.connect(n); prev = n; }
  prev.connect(output);
  return nodes;
}

export class Engine {
  constructor() {
    this.ctx = null; this.ready = null;
    this.L = null; this.R = null; this.stereoMode = 1;
    this.rate = 1; this.semis = 0;
    this.hasSel = false; this.selStart = 0; this.selEnd = 0; this.loop = true; this.gap = 0;
    this.metro = false; this.metroGain = 0.6; this.clicks = [];
    this.passes = []; this.playing = false; this.stopAt = 0; this.clickMark = 0;
    this.scheduledClicks = [];
    this.eqNodes = []; this.eq = {};
    this.onEnded = null;
    this.timer = null;
  }

  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
      try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) { /* non supportato */ }
      const ctx = this.ctx;
      this.stretch = await SignalsmithStretch(ctx);
      this.fader = ctx.createGain();
      this.volume = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      Object.assign(this.limiter, {});
      this.limiter.threshold.value = -2; this.limiter.knee.value = 2; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002; this.limiter.release.value = 0.08;
      this.fx = ctx.createGain();
      this.stretch.connect(this.fader);
      this.eqNodes = buildEq(ctx, this.fader, this.volume, this.eq);
      this.eqKey = JSON.stringify(this.eq);
      this.volume.connect(this.limiter);
      this.limiter.connect(ctx.destination);
      this.fx.connect(ctx.destination);
      this.toneWave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0]), new Float32Array([0, 1, 0.35, 0.15]));
    })();
    return this.ready;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
  get duration() { return this.L ? this.L.length / this.ctx.sampleRate : 0; }

  async decode(arrayBuffer) {
    await this.init();
    return await new Promise((res, rej) => {
      const p = this.ctx.decodeAudioData(arrayBuffer, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  async setAudio(L, R) {
    await this.init();
    this.stop();
    this.L = L; this.R = R;
    await this.reloadBuffers();
  }

  async reloadBuffers() {
    if (!this.L) return;
    const [l, r] = makeBuffers(this.L, this.R, this.stereoMode);
    await this.stretch.dropBuffers();
    await this.stretch.addBuffers([l, r], [l.buffer, r.buffer]);
  }

  async setStereoMode(m) {
    if (m === this.stereoMode) return;
    this.stereoMode = m;
    await this.reloadBuffers();
  }

  setEq(eq) {
    // si ricollega solo se l'equalizzatore è davvero cambiato: ricollegare a ogni regolazione crea piccoli vuoti
    const k = JSON.stringify(eq);
    if (k === this.eqKey && this.ctx) return;
    this.eqKey = k;
    this.eq = { ...eq };
    if (!this.ctx) return;
    this.fader.disconnect();
    for (const n of this.eqNodes) n.disconnect();
    this.eqNodes = buildEq(this.ctx, this.fader, this.volume, this.eq);
  }

  setVolumeDb(db) {
    this.volumeDb = db;
    if (this.ctx) this.volume.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.02);
  }

  setRegion(hasSel, start, end, loop) {
    const changed = hasSel !== this.hasSel || start !== this.selStart || end !== this.selEnd || loop !== this.loop;
    this.hasSel = hasSel && end - start > 0.01; this.selStart = start; this.selEnd = end; this.loop = loop;
    if (changed && this.playing) this.reanchor(null, false);
  }
  setGap(g) { this.gap = g; }
  setRate(r) { r = Math.min(4, Math.max(0.05, r)); if (r === this.rate) return; this.rate = r; if (this.playing) this.reanchor(null, false); }
  setSemis(s) { if (s === this.semis) return; this.semis = s; if (this.playing) this.reanchor(null, false); }
  setMetronome(on, gain) { this.metro = on; this.metroGain = gain; if (!on) this._cancelClicks(0); }
  setClicks(list) { this.clicks = list.slice().sort((a, b) => a.time - b.time); if (this.playing) { this._cancelClicks(this.ctx.currentTime); this.clickMark = this.ctx.currentTime; } }

  // --- tempo ---
  // tempo del contesto audio che si sta ascoltando adesso, interpolato per un movimento fluido
  audibleTime() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const now = performance.now(), ct = ctx.currentTime;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        const t = ts.contextTime + Math.max(0, Math.min(0.2, (now - ts.performanceTime) / 1000));
        if (t <= ct + 0.05 && t >= ct - 0.5) return t;
      }
    }
    // Safari meno recenti: currentTime avanza a scatti, lo interpolo con l'orologio della pagina
    if (ct !== this._ct) { this._ct = ct; this._ctAt = now; }
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return Math.max(0, ct + Math.min(0.1, (now - this._ctAt) / 1000) - lat);
  }

  inputAt(T) {
    const ps = this.passes;
    if (!ps.length) return 0;
    let p = ps[0];
    for (const q of ps) if (q.T <= T) p = q;
    if (T < p.T) return p.t;
    if (T >= p.Tend) return p.gapTo != null ? p.end : p.end;
    return p.t + (T - p.T) * p.r;
  }

  position() { return this.playing ? this.inputAt(this.audibleTime()) : null; }

  _boundary(t) {
    if (this.hasSel && t < this.selEnd - 1e-6) return this.selEnd;
    return this.duration;
  }

  _startPass(T, t) {
    t = Math.min(Math.max(0, t), this.duration);
    const r = this.rate, end = this._boundary(t);
    const p = { T, t, r, end, Tend: T + Math.max(0, end - t) / r, next: false, gapTo: null };
    this.stretch.schedule({ active: true, input: t, rate: r, semitones: this.semis, output: T });
    this.passes.push(p);
    if (this.passes.length > 8) this.passes.splice(0, this.passes.length - 8);
    return p;
  }

  _dip(T) {
    const g = this.fader.gain;
    g.setValueAtTime(1, Math.max(this.ctx.currentTime, T - FADE));
    g.linearRampToValueAtTime(0.0, T);
    g.linearRampToValueAtTime(1, T + FADE * 2);
  }

  async play(from) {
    await this.init();
    if (this.ctx.state !== "running") {
      // su iPad resume() può restare in attesa se manca il tocco: non aspetto più di 1,5 s
      try { await Promise.race([this.ctx.resume(), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* richiede un tocco */ }
    }
    if (!this.L) return;
    const ctx = this.ctx, T = ctx.currentTime + LEAD;
    this.fader.gain.cancelScheduledValues(0);
    this.fader.gain.setValueAtTime(0, ctx.currentTime);
    this.fader.gain.linearRampToValueAtTime(0, T);
    this.fader.gain.linearRampToValueAtTime(1, T + FADE * 2);
    this._cancelClicks(0);
    this.passes = [];
    this.stopAt = 0;
    if (from >= this.duration - 0.02) from = 0;
    this._startPass(T, from);
    this.clickMark = T;
    this.playing = true;
    this._tick();
    if (!this.timer) this.timer = setInterval(() => this._tick(), 40);
  }

  // riparte da `t` (o dalla posizione attuale) con i parametri correnti
  reanchor(t, jump = true) {
    if (!this.playing) return;
    const ctx = this.ctx, T = ctx.currentTime + LEAD;
    let pos = t;
    if (pos == null) {
      pos = this.inputAt(T);
      const last = this.passes[this.passes.length - 1];
      if (last && last.gapTo != null && T >= last.Tend) pos = last.gapTo;
      if (this.hasSel && this.loop && pos >= this.selEnd - 1e-3 && this._boundary(this.selStart) === this.selEnd && last && last.end === this.selEnd) pos = this.selStart;
    }
    // tronca la programmazione futura
    this.passes = this.passes.filter(p => p.T < T);
    for (const p of this.passes) if (p.Tend > T) { p.Tend = T; p.end = p.t + (T - p.T) * p.r; }
    this.fader.gain.cancelScheduledValues(ctx.currentTime);
    this.fader.gain.setValueAtTime(1, ctx.currentTime);
    if (jump) this._dip(T);
    this._cancelClicks(T);
    this.stopAt = 0;
    this._startPass(T, pos);
    this.clickMark = T;
    this._tick();
  }

  seek(t) { if (this.playing) this.reanchor(t, true); }

  stop() {
    if (!this.playing) return null;
    const ctx = this.ctx, now = ctx.currentTime;
    const pos = this.inputAt(this.audibleTime());
    this.fader.gain.cancelScheduledValues(now);
    this.fader.gain.setValueAtTime(this.fader.gain.value, now);
    this.fader.gain.linearRampToValueAtTime(0, now + 0.015);
    this.stretch.schedule({ active: false, output: now + 0.02 });
    this._cancelClicks(now);
    this.passes = [];
    this.playing = false;
    this.stopAt = 0;
    return pos;
  }

  _tick() {
    if (!this.playing) { if (this.timer) { clearInterval(this.timer); this.timer = null; } return; }
    const now = this.ctx.currentTime;
    const last = this.passes[this.passes.length - 1];
    if (last && !last.next && last.Tend - now < LOOKAHEAD) {
      last.next = true;
      const looping = this.hasSel && this.loop && this.selEnd > this.selStart && Math.abs(last.end - this.selEnd) < 1e-6;
      if (looping) {
        if (this.gap > 0.001) {
          this.fader.gain.setValueAtTime(1, Math.max(now, last.Tend - FADE));
          this.fader.gain.linearRampToValueAtTime(0, last.Tend);
          this.stretch.schedule({ active: false, output: last.Tend + 0.002 });
          last.gapTo = this.selStart;
          const T2 = last.Tend + this.gap;
          this.fader.gain.setValueAtTime(0, T2);
          this.fader.gain.linearRampToValueAtTime(1, T2 + FADE * 2);
          this._startPass(T2, this.selStart);
        } else {
          this._dip(last.Tend);
          this._startPass(last.Tend, this.selStart);
        }
      } else {
        this.fader.gain.setValueAtTime(1, Math.max(now, last.Tend - FADE));
        this.fader.gain.linearRampToValueAtTime(0, last.Tend);
        this.stretch.schedule({ active: false, output: last.Tend + 0.005 });
        this.stopAt = last.Tend;
      }
    }
    this._scheduleClicks(now + LOOKAHEAD);
    if (this.stopAt && this.audibleTime() >= this.stopAt) {
      const endPos = last ? last.end : this.duration;
      this.playing = false; this.passes = []; this.stopAt = 0;
      clearInterval(this.timer); this.timer = null;
      if (this.onEnded) this.onEnded(endPos);
    }
  }

  // --- metronomo sui marker ---
  _scheduleClicks(until) {
    if (!this.metro || !this.clicks.length) { this.clickMark = Math.max(this.clickMark, until); return; }
    const cl = this.clicks;
    for (const p of this.passes) {
      const T0 = Math.max(this.clickMark, p.T), T1 = Math.min(until, p.Tend);
      if (T1 <= T0) continue;
      const i0 = p.t + (T0 - p.T) * p.r, i1 = p.t + (T1 - p.T) * p.r;
      let lo = 0, hi = cl.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cl[m].time < i0 - 1e-9) lo = m + 1; else hi = m; }
      for (let k = lo; k < cl.length && cl[k].time < i1; k++) {
        const T = p.T + (cl[k].time - p.t) / p.r;
        if (T >= T0 - 1e-9 && T < T1) this._click(T, cl[k].accent);
      }
    }
    this.clickMark = until;
  }

  _click(T, accent) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 2093 : 1568;
    const a = (accent ? 1 : 0.6) * this.metroGain * 0.9;
    g.gain.setValueAtTime(0, T);
    g.gain.linearRampToValueAtTime(a, T + 0.001);
    g.gain.setTargetAtTime(0, T + 0.001, 0.012);
    o.connect(g); g.connect(this.fx);
    o.start(T); o.stop(T + 0.12);
    this.scheduledClicks.push({ T, g });
    o.onended = () => { try { g.disconnect(); } catch (e) { /* già scollegato */ } };
    if (this.scheduledClicks.length > 64) this.scheduledClicks.splice(0, 32);
  }

  _cancelClicks(after) {
    this.scheduledClicks = this.scheduledClicks.filter(c => {
      if (c.T >= after) { try { c.g.disconnect(); } catch (e) { /* ok */ } return false; }
      return true;
    });
  }

  // --- nota di riferimento ---
  async tone(freq) {
    await this.init();
    if (this.ctx.state !== "running") { try { await this.ctx.resume(); } catch (e) { return; } }
    const ctx = this.ctx, T = ctx.currentTime + 0.01, o = ctx.createOscillator(), g = ctx.createGain();
    o.setPeriodicWave(this.toneWave);
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, T);
    g.gain.linearRampToValueAtTime(0.22, T + 0.004);
    g.gain.setTargetAtTime(0, T + 0.004, 0.9);
    o.connect(g); g.connect(this.fx);
    o.start(T); o.stop(T + 4.5);
    o.onended = () => g.disconnect();
  }

  // --- esportazione offline ---
  static async render({ L, R, sampleRate, start, end, rate, semis, stereoMode, eq, volumeDb }) {
    const s0 = Math.max(0, Math.floor(start * sampleRate)), s1 = Math.min(L.length, Math.floor(end * sampleRate));
    const inDur = (s1 - s0) / sampleRate, outLen = Math.max(1, Math.round(inDur / rate * sampleRate));
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(2, outLen, sampleRate);
    const st = await SignalsmithStretch(off);
    const [l, r] = makeBuffers(L, R, stereoMode, s0, s1);
    await st.addBuffers([l, r], [l.buffer, r.buffer]);
    // va confermato prima di avviare il rendering, che altrimenti parte in silenzio
    await st.schedule({ active: true, input: 0, rate, semitones: semis, output: 0 });
    const vol = off.createGain();
    vol.gain.value = Math.pow(10, volumeDb / 20);
    const lim = off.createDynamicsCompressor();
    lim.threshold.value = -2; lim.knee.value = 2; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.08;
    buildEq(off, st, vol, eq);
    vol.connect(lim); lim.connect(off.destination);
    return await off.startRendering();
  }
}

export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
  const bytes = 44 + n * ch * 2, ab = new ArrayBuffer(bytes), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, bytes - 8, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const s = Math.max(-1, Math.min(1, data[c][i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}
