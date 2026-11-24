/* Dettato — analisi (stessi algoritmi della versione per Mac).
   Usato dal worker (analisi del brano) e dalla pagina (riassunto e nomi degli accordi). */
(function (root) {
  "use strict";

  const LOW_MIDI = 21, NUM_NOTES = 88;            // La0 .. Do8
  const PEAK_BLOCK = 256, PEAK_BLOCK2 = 4096;

  function nextPow2(x) { let n = 1; while (n < x) n <<= 1; return n; }

  /* FFT reale di lunghezza N (potenza di 2) tramite una FFT complessa di N/2 punti. */
  function RealFFT(N) {
    const M = N >> 1, half = M >> 1;
    const cosT = new Float64Array(half), sinT = new Float64Array(half);
    for (let i = 0; i < half; i++) { cosT[i] = Math.cos(2 * Math.PI * i / M); sinT[i] = -Math.sin(2 * Math.PI * i / M); }
    const rev = new Uint32Array(M);
    let bits = 0; while ((1 << bits) < M) bits++;
    for (let i = 0; i < M; i++) { let r = 0, v = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; } rev[i] = r; }
    const wr = new Float64Array(M), wi = new Float64Array(M);
    for (let k = 0; k < M; k++) { wr[k] = Math.cos(2 * Math.PI * k / N); wi[k] = -Math.sin(2 * Math.PI * k / N); }
    const re = new Float64Array(M), im = new Float64Array(M);
    const window = new Float64Array(N);
    let wsum = 0;
    for (let i = 0; i < N; i++) { window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N); wsum += window[i]; }
    const scale = 2 / wsum;
    const mag = new Float32Array(M);

    /* modulo dello spettro finestrato (Hann) centrato in `centre` */
    this.N = N;
    this.mag = mag;
    this.compute = function (x, length, centre) {
      const start = centre - M;
      for (let n = 0; n < M; n++) {
        const i0 = start + 2 * n, i1 = i0 + 1;
        const a = (i0 >= 0 && i0 < length) ? x[i0] * window[2 * n] : 0;
        const b = (i1 >= 0 && i1 < length) ? x[i1] * window[2 * n + 1] : 0;
        const r = rev[n]; re[r] = a; im[r] = b;
      }
      for (let size = 2; size <= M; size <<= 1) {
        const h = size >> 1, step = M / size;
        for (let s = 0; s < M; s += size) {
          for (let j = 0, t = 0; j < h; j++, t += step) {
            const c = cosT[t], d = sinT[t];
            const p = s + j, q = p + h;
            const xr = re[q] * c - im[q] * d, xi = re[q] * d + im[q] * c;
            re[q] = re[p] - xr; im[q] = im[p] - xi;
            re[p] += xr; im[p] += xi;
          }
        }
      }
      mag[0] = 0;
      for (let k = 1; k < M; k++) {
        const zr = re[k], zi = im[k], cr = re[M - k], ci = -im[M - k];
        const er = 0.5 * (zr + cr), ei = 0.5 * (zi + ci);
        const dr = zr - cr, di = zi - ci;
        const or_ = 0.5 * di, oi = -0.5 * dr;
        const xr = er + wr[k] * or_ - wi[k] * oi, xi = ei + wr[k] * oi + wi[k] * or_;
        mag[k] = Math.sqrt(xr * xr + xi * xi) * scale;
      }
    };
  }

  /* dimezza la frequenza di campionamento con un filtro FIR (sinc con finestra di Blackman) */
  function decimate2(x) {
    const taps = 63, mid = (taps - 1) >> 1, h = new Float64Array(taps), fc = 0.225;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const n = i - mid;
      const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
      h[i] = sinc * w; sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    const n = x.length, out = new Float32Array(n >> 1);
    for (let o = 0; o < out.length; o++) {
      const c = 2 * o; let acc = 0;
      if (c - mid >= 0 && c + mid < n) for (let k = 0; k < taps; k++) acc += h[k] * x[c - mid + k];
      else for (let k = 0; k < taps; k++) { const idx = c - mid + k; if (idx >= 0 && idx < n) acc += h[k] * x[idx]; }
      out[o] = acc;
    }
    return out;
  }

  function computePeaks(ch, block) {
    const nb = Math.ceil(ch.length / block), mn = new Float32Array(nb), mx = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let lo = 0, hi = 0; const e = Math.min(ch.length, (b + 1) * block);
      for (let i = b * block; i < e; i++) { const v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      mn[b] = lo; mx[b] = hi;
    }
    return { min: mn, max: mx };
  }

  /* Analisi completa. cb: { peaks(p), tuning(cents, confidence), info(hop, rate, numFrames), frames(start, Float32Array, maxAmp) } */
  function analyze(L, R, sampleRate, cb, shouldStop) {
    const len = L.length;
    const peaks = { block: PEAK_BLOCK, block2: PEAK_BLOCK2, ch: [] };
    for (const ch of [L, R]) {
      const p1 = computePeaks(ch, PEAK_BLOCK), p2 = computePeaks(ch, PEAK_BLOCK2);
      peaks.ch.push({ min: p1.min, max: p1.max, min2: p2.min, max2: p2.max });
    }
    cb.peaks && cb.peaks(peaks);
    if (shouldStop && shouldStop()) return;

    let mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = 0.5 * (L[i] + R[i]);
    let ar = sampleRate;
    if (sampleRate >= 32000) { mono = decimate2(mono); ar = sampleRate / 2; }
    const n = mono.length;

    const bigN = nextPow2(ar * 0.33);
    const big = new RealFFT(bigN), mid = new RealFFT(bigN >> 1), small = new RealFFT(bigN >> 2);

    /* accordatura: media circolare dello scarto in cents dei picchi spettrali */
    let sumC = 0, sumS = 0, sumW = 0;
    {
      const step = Math.floor(ar * 0.2), N = mid.N, mag = mid.mag;
      const bLo = Math.floor(100 * N / ar), bHi = Math.min(N / 2 - 2, Math.floor(2000 * N / ar));
      for (let c = N >> 1; c < n; c += step) {
        mid.compute(mono, n, c);
        let fmax = 0;
        for (let b = bLo; b <= bHi; b++) if (mag[b] > fmax) fmax = mag[b];
        if (fmax < 1e-4) continue;
        for (let b = bLo; b <= bHi; b++) {
          const m = mag[b];
          if (m < 0.08 * fmax || m <= mag[b - 1] || m < mag[b + 1]) continue;
          const lm = Math.log(mag[b - 1] + 1e-12), l0 = Math.log(m + 1e-12), lp = Math.log(mag[b + 1] + 1e-12);
          const den = lm - 2 * l0 + lp;
          const p = Math.abs(den) > 1e-12 ? 0.5 * (lm - lp) / den : 0;
          const f = (b + p) * ar / N;
          const cents = 1200 * Math.log2(f / 440);
          const dev = cents - 100 * Math.round(cents / 100);
          const w = m / fmax;
          sumC += w * Math.cos(2 * Math.PI * dev / 100);
          sumS += w * Math.sin(2 * Math.PI * dev / 100);
          sumW += w;
        }
      }
    }
    const tuning = sumW > 0 ? Math.atan2(sumS, sumC) / (2 * Math.PI) * 100 : 0;
    const confidence = sumW > 0 ? Math.hypot(sumC, sumS) / sumW : 0;
    cb.tuning && cb.tuning(tuning, confidence);
    if (shouldStop && shouldStop()) return;

    /* energia per semitono con tre risoluzioni: bassi, medi, acuti */
    const hop = Math.max(128, Math.round(ar * 0.02322));
    const numFrames = Math.floor(n / hop) + 1;
    cb.info && cb.info(hop / ar, numFrames);

    const makeBins = (s, lo, hi) => {
      const out = [];
      for (let m = lo; m <= hi; m++) {
        const f = 440 * Math.pow(2, (m - 69) / 12 + tuning / 1200);
        const flo = f * Math.pow(2, -1 / 24) * s.N / ar, fhi = f * Math.pow(2, 1 / 24) * s.N / ar;
        out.push({
          b0: Math.min(Math.max(Math.ceil(flo), 1), s.N / 2 - 2),
          b1: Math.min(Math.max(Math.floor(fhi), 0), s.N / 2 - 2),
          centre: f * s.N / ar
        });
      }
      return out;
    };
    const splitA = 47, splitB = 71;
    const bands = [
      { fft: big, bins: makeBins(big, LOW_MIDI, splitA), offset: 0 },
      { fft: mid, bins: makeBins(mid, splitA + 1, splitB), offset: splitA + 1 - LOW_MIDI },
      { fft: small, bins: makeBins(small, splitB + 1, LOW_MIDI + NUM_NOTES - 1), offset: splitB + 1 - LOW_MIDI }
    ];
    const amp = (s, nb) => {
      const mag = s.mag;
      if (nb.b0 <= nb.b1) { let m = 0; for (let b = nb.b0; b <= nb.b1; b++) if (mag[b] > m) m = mag[b]; return m; }
      const b = Math.floor(nb.centre), fr = nb.centre - b;
      if (b < 1 || b + 1 >= s.N / 2) return 0;
      return mag[b] * (1 - fr) + mag[b + 1] * fr;
    };

    const CHUNK = 64;
    let maxAmp = 1e-6;
    let chunk = new Float32Array(CHUNK * NUM_NOTES), chunkStart = 0, inChunk = 0;
    for (let i = 0; i < numFrames; i++) {
      if ((i & 31) === 0 && shouldStop && shouldStop()) return;
      const c = i * hop, base = inChunk * NUM_NOTES;
      for (const band of bands) {
        band.fft.compute(mono, n, c);
        for (let k = 0; k < band.bins.length; k++) {
          const v = amp(band.fft, band.bins[k]);
          chunk[base + band.offset + k] = v;
          if (v > maxAmp) maxAmp = v;
        }
      }
      inChunk++;
      if (inChunk === CHUNK || i === numFrames - 1) {
        cb.frames && cb.frames(chunkStart, chunk.subarray(0, inChunk * NUM_NOTES), maxAmp);
        chunkStart = i + 1; inChunk = 0; chunk = new Float32Array(CHUNK * NUM_NOTES);
      }
    }
  }

  /* ---- riconoscimento degli accordi ---- */
  const CHORD_TYPES = [
    { suffix: "", iv: [0, 4, 7], penalty: 0.000 },
    { suffix: "m", iv: [0, 3, 7], penalty: 0.000 },
    { suffix: "7", iv: [0, 4, 7, 10], penalty: 0.012 },
    { suffix: "maj7", iv: [0, 4, 7, 11], penalty: 0.012 },
    { suffix: "m7", iv: [0, 3, 7, 10], penalty: 0.012 },
    { suffix: "6", iv: [0, 4, 7, 9], penalty: 0.030 },
    { suffix: "m6", iv: [0, 3, 7, 9], penalty: 0.032 },
    { suffix: "m7b5", iv: [0, 3, 6, 10], penalty: 0.030 },
    { suffix: "dim", iv: [0, 3, 6], penalty: 0.035 },
    { suffix: "dim7", iv: [0, 3, 6, 9], penalty: 0.040 },
    { suffix: "aug", iv: [0, 4, 8], penalty: 0.040 },
    { suffix: "sus4", iv: [0, 5, 7], penalty: 0.030 },
    { suffix: "sus2", iv: [0, 2, 7], penalty: 0.035 },
    { suffix: "7sus4", iv: [0, 5, 7, 10], penalty: 0.040 },
    { suffix: "m(maj7)", iv: [0, 3, 7, 11], penalty: 0.045 }
  ];
  const TEMPLATES = (() => {
    const out = [];
    for (let root = 0; root < 12; root++)
      for (let t = 0; t < CHORD_TYPES.length; t++) {
        const tpl = new Float64Array(12);
        for (const iv of CHORD_TYPES[t].iv) {
          const p = root + iv;
          tpl[p % 12] += 1; tpl[(p + 7) % 12] += 0.29; tpl[(p + 4) % 12] += 0.11;
        }
        let tn = 0; for (let i = 0; i < 12; i++) tn += tpl[i] * tpl[i];
        out.push({ root, type: t, tpl, norm: Math.sqrt(tn) });
      }
    return out;
  })();

  /* notes: Float32Array (frame * 88), done: frame analizzati, f0..f1 compresi */
  function summarize(notes, done, maxAmp, f0, f1) {
    const s = { valid: false, silent: true, levels: new Float32Array(NUM_NOTES), topNotes: [], chords: [] };
    if (done <= 0) return s;
    f0 = Math.min(Math.max(f0, 0), done - 1);
    f1 = Math.min(Math.max(f1, f0), done - 1);
    const n = f1 - f0 + 1, step = Math.max(1, Math.floor(n / 400));
    const NN = NUM_NOTES, avg = new Float64Array(NN);
    let count = 0;
    for (let i = f0; i <= f1; i += step) { const b = i * NN; for (let k = 0; k < NN; k++) avg[k] += notes[b + k]; count++; }
    let localMax = 1e-9;
    for (let k = 0; k < NN; k++) { avg[k] /= count; if (avg[k] > localMax) localMax = avg[k]; }
    const gmax = Math.max(1e-6, maxAmp);
    for (let k = 0; k < NN; k++) {
      const db = 20 * Math.log10(avg[k] / gmax + 1e-9);
      s.levels[k] = Math.min(1, Math.max(0, (db + 60) / 60));
    }
    s.valid = true;
    s.silent = 20 * Math.log10(localMax / gmax + 1e-9) < -50;
    if (s.silent) return s;

    const isPeak = k => (k === 0 || avg[k] >= avg[k - 1]) && (k === NN - 1 || avg[k] >= avg[k + 1]);
    const rel = k => 20 * Math.log10(avg[k] / localMax + 1e-9);

    let peaks = [];
    for (let k = 0; k < NN; k++) if (isPeak(k) && rel(k) > -18) peaks.push(k);
    peaks.sort((a, b) => avg[b] - avg[a]);
    peaks = peaks.slice(0, 6).sort((a, b) => a - b);
    s.topNotes = peaks.map(k => k + LOW_MIDI);

    const chroma = new Float64Array(12);
    for (let k = 0; k < NN; k++) {
      const midi = k + LOW_MIDI;
      if (midi < 33 || midi > 96) continue;
      const nb = Math.max(k > 0 ? avg[k - 1] : 0, k < NN - 1 ? avg[k + 1] : 0);
      if (!isPeak(k) && avg[k] < 0.16 * nb) continue;
      const r = rel(k);
      if (r < -36) continue;
      const w = (r + 36) / 36;
      chroma[midi % 12] += w * w;
    }
    let cnorm = 0; for (let i = 0; i < 12; i++) cnorm += chroma[i] * chroma[i];
    cnorm = Math.sqrt(cnorm);
    if (cnorm < 1e-6) return s;

    let bassPc = -1;
    for (let k = 0; k < NN; k++) {
      const midi = k + LOW_MIDI;
      if (midi < 28) continue;
      if (midi > 55) break;
      if (isPeak(k) && rel(k) > -24) { bassPc = midi % 12; break; }
    }

    const all = [];
    for (const T of TEMPLATES) {
      let dot = 0; for (let i = 0; i < 12; i++) dot += T.tpl[i] * chroma[i];
      let score = dot / (T.norm * cnorm) - CHORD_TYPES[T.type].penalty;
      let bass = -1;
      if (bassPc >= 0) {
        if (bassPc === T.root) score += 0.03;
        else for (const iv of CHORD_TYPES[T.type].iv) if ((T.root + iv) % 12 === bassPc) { bass = bassPc; score += 0.01; break; }
      }
      all.push({ root: T.root, type: T.type, bass, score });
    }
    all.sort((a, b) => b.score - a.score);
    s.chords = all.slice(0, 3);
    return s;
  }

  const PC_IT = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Fa#", "Sol", "Lab", "La", "Sib", "Si"];
  const PC_EN = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const pc = x => ((x % 12) + 12) % 12;
  function pitchClass(p, italian) { return (italian ? PC_IT : PC_EN)[pc(p)]; }
  /* convenzione italiana: Do3 = do centrale */
  function noteName(midi, italian) {
    let oct = Math.floor(midi / 12) - 1;
    if (italian) oct -= 1;
    return pitchClass(midi, italian) + oct;
  }
  function chordName(c, transpose, italian) {
    let name = pitchClass(c.root + transpose, italian) + CHORD_TYPES[c.type].suffix;
    if (c.bass >= 0 && c.bass !== c.root) name += "/" + pitchClass(c.bass + transpose, italian);
    return name;
  }

  const api = { LOW_MIDI, NUM_NOTES, PEAK_BLOCK, PEAK_BLOCK2, RealFFT, decimate2, analyze, summarize, pitchClass, noteName, chordName };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DettatoAnalysis = api;
})(typeof self !== "undefined" ? self : this);
