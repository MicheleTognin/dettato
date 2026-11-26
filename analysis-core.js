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

  /* ricampiona a `target` Hz (per frequenze diverse da 44,1 kHz): filtro sinc con finestra di
     Blackman, stessa banda passante di decimate2, pesi in tabella per 1024 fasi */
  function resample(x, sr, target) {
    const r = target / sr, fc = 0.45 * r, half = Math.ceil(15.5 / r), taps = 2 * half, P = 1024;
    const table = new Float64Array((P + 1) * taps);
    for (let p = 0; p <= P; p++) {
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        const d = j - half + 1 - p / P;
        const sinc = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
        const u = (d + half) / (2 * half);
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
        table[p * taps + j] = sinc * w; sum += sinc * w;
      }
      for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
    }
    const n = x.length, out = new Float32Array(Math.floor(n * target / sr));
    for (let o = 0; o < out.length; o++) {
      const t = o * sr / target, i0 = Math.floor(t), base = Math.round((t - i0) * P) * taps, start = i0 - half + 1;
      let acc = 0;
      if (start >= 0 && start + taps <= n) for (let j = 0; j < taps; j++) acc += table[base + j] * x[start + j];
      else for (let j = 0; j < taps; j++) { const idx = start + j; if (idx >= 0 && idx < n) acc += table[base + j] * x[idx]; }
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
    /* tutto si analizza a 22 050 Hz (o meno, per file a bassa frequenza): finestre e risoluzione
       uguali qualunque sia la frequenza del file, quindi stessi accordi da un MP3 a 44,1 kHz
       e da un video a 48 kHz */
    let ar = sampleRate;
    if (sampleRate === 44100) { mono = decimate2(mono); ar = 22050; }
    else if (sampleRate > 22050) { mono = resample(mono, sampleRate, 22050); ar = 22050; }
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

  /* ---- riconoscimento degli accordi ----
     1) croma (somma pesata delle note per classe d'altezza) confrontato con modelli che includono le
        armoniche principali: sceglie fondamentale e famiglia (maggiore, minore, diminuito, sospeso…);
     2) una stima delle note realmente suonate, senza armoniche (minimi quadrati non negativi), decide
        settima, sesta e nona, che il croma da solo confonde con le armoniche e le ottave raddoppiate. */
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
    { suffix: "m(maj7)", iv: [0, 3, 7, 11], penalty: 0.045 },
    { suffix: "5", iv: [0, 7], penalty: 0.020 },
    { suffix: "add9", iv: [0, 2, 4, 7], penalty: 0.030 },
    { suffix: "madd9", iv: [0, 2, 3, 7], penalty: 0.035 },
    { suffix: "9", iv: [0, 2, 4, 7, 10], penalty: 0.035 },
    { suffix: "m9", iv: [0, 2, 3, 7, 10], penalty: 0.035 },
    { suffix: "maj9", iv: [0, 2, 4, 7, 11], penalty: 0.040 }
  ];
  const typeIndex = suffix => CHORD_TYPES.findIndex(c => c.suffix === suffix);
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

  /* note fondamentali che spiegano lo spettro: ogni nota contribuisce con le sue armoniche
     (2ª…8ª, ampiezza 0.6^(h-1)); aggiornamenti moltiplicativi di Lee–Seung */
  const HARM = [[0, 1], [12, 2], [19, 3], [24, 4], [28, 5], [31, 6], [34, 7], [36, 8]];
  const NNLS_COLS = (() => {
    const cols = [];
    for (let j = 0; j < NUM_NOTES; j++) {
      const col = [];
      for (const [off, h] of HARM) if (j + off < NUM_NOTES) col.push([j + off, Math.pow(0.6, h - 1)]);
      cols.push(col);
    }
    return cols;
  })();
  function nnlsNotes(y) {
    const NN = NUM_NOTES, x = new Float64Array(NN), Dty = new Float64Array(NN), Dx = new Float64Array(NN);
    for (let j = 0; j < NN; j++) { let v = 0; for (const [i, w] of NNLS_COLS[j]) v += w * y[i]; Dty[j] = v; x[j] = y[j]; }
    for (let it = 0; it < 150; it++) {
      Dx.fill(0);
      for (let j = 0; j < NN; j++) if (x[j] > 0) for (const [i, w] of NNLS_COLS[j]) Dx[i] += w * x[j];
      for (let j = 0; j < NN; j++) { let v = 0; for (const [i, w] of NNLS_COLS[j]) v += w * Dx[i]; x[j] *= Dty[j] / (v + 1e-12); }
    }
    return x;
  }

  /* notes: Float32Array (frame * 88), done: frame analizzati, f0..f1 compresi */
  function summarize(notes, done, maxAmp, f0, f1, fast) {
    const s = { valid: false, silent: true, levels: new Float32Array(NUM_NOTES), topNotes: [], chords: [], bass: -1 };
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

    /* basso: tra i picchi gravi (Mi1…Sol3) il più grave con abbastanza "sostegno" armonico
       (ottava, dodicesima, …); così la grancassa o un rumore sordo non diventano il basso */
    const sal = k => avg[k] + 0.7 * (avg[k + 12] || 0) + 0.5 * (avg[k + 19] || 0) + 0.35 * (avg[k + 24] || 0) + 0.25 * (avg[k + 28] || 0);
    const cands = [];
    let bestSal = 0;
    for (let m = 28; m <= 55; m++) {
      const k = m - LOW_MIDI;
      if (!isPeak(k) || rel(k) < -24) continue;
      const v = sal(k); cands.push([m, v]); if (v > bestSal) bestSal = v;
    }
    for (const [m, v] of cands) if (v >= 0.5 * bestSal) { s.bass = m; break; }
    const bassPc = s.bass >= 0 ? s.bass % 12 : -1;

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
    if (!fast) refineChord(all, avg, bassPc);
    s.chords = all.slice(0, 3);
    return s;
  }

  const FAMILY = {
    "": "maj", "7": "maj", "maj7": "maj", "6": "maj", "add9": "maj", "9": "maj", "maj9": "maj",
    "m": "min", "m7": "min", "m6": "min", "m(maj7)": "min", "madd9": "min", "m9": "min",
    "dim": "dim", "m7b5": "dim", "dim7": "dim", "sus4": "sus4", "7sus4": "sus4", "5": "open", "sus2": "open"
  };
  function refineChord(all, avg, bassPc) {
    const best = all[0], R = best.root, suf = CHORD_TYPES[best.type].suffix;
    let fam = FAMILY[suf];
    if (!fam) return;                                   // aug: resta com'è
    const x = nnlsNotes(avg), P = new Float64Array(12);
    for (let m = 40; m <= 79; m++) { const v = x[m - LOW_MIDI]; if (v > P[m % 12]) P[m % 12] = v; }
    let want;
    if (fam === "open") {
      /* bicordo o sus2: fondamentale e quinta ci sono; terza, quarta o seconda decidono */
      const base = (P[R] + P[(R + 7) % 12]) / 2;
      if (base <= 0) return;
      const q = iv => P[(R + iv) % 12] / base;
      if (Math.max(q(4), q(3)) >= 0.35) fam = q(4) >= q(3) ? "maj" : "min";
      else if (q(5) >= 0.35 && q(5) >= q(2)) fam = "sus4";
      else want = q(2) >= 0.35 ? "sus2" : "5";
    }
    if (!want) {
      const triad = { maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], sus4: [0, 5, 7] }[fam];
      let ref = 0; for (const iv of triad) ref += P[(R + iv) % 12]; ref /= 3;
      if (ref <= 0) return;
      const p = iv => P[(R + iv) % 12] / ref;
      const b7 = p(10), M7 = p(11), six = p(9), nine = p(2) >= 0.6;
      if (fam === "maj") {
        want = b7 >= 0.5 && b7 >= M7 ? "7" : M7 >= (nine ? 0.65 : 0.5) ? "maj7" : six >= 0.6 ? "6" : "";
        if (nine) want = { "": "add9", "7": "9", "maj7": "maj9", "6": "6" }[want];
      } else if (fam === "min") {
        want = b7 >= 0.5 && b7 >= M7 ? "m7" : M7 >= 0.65 ? "m(maj7)" : six >= 0.6 ? "m6" : "m";
        if (nine) want = { "m": "madd9", "m7": "m9" }[want] || want;
      } else if (fam === "dim") {
        want = b7 >= 0.5 && b7 >= six ? "m7b5" : six >= 0.5 ? "dim7" : "dim";
      } else {
        want = b7 >= 0.5 ? "7sus4" : "sus4";
      }
    }
    if (want === suf) return;
    const t = typeIndex(want);
    const i = all.findIndex(c => c.root === R && c.type === t);
    const pick = i >= 0 ? all.splice(i, 1)[0] : { root: R, type: t, bass: -1, score: best.score };
    pick.bass = bassPc >= 0 && bassPc !== R && CHORD_TYPES[t].iv.some(iv => (R + iv) % 12 === bassPc) ? bassPc : -1;
    all.unshift(pick);
  }

  /* ---- tonalità del brano ----
     Profili di Krumhansl–Kessler confrontati con le note degli accordi riconosciuti lungo il brano
     (più il basso): usare gli accordi invece dello spettro evita che le armoniche spingano la stima
     una quinta sopra. */
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function correlation(a, b) {
    let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }
  /* hop: secondi per frame. Restituisce { tonic: 0..11, minor, score, margin } oppure null */
  function estimateKey(notes, done, maxAmp, hop) {
    const hist = new Float64Array(12);
    const half = Math.max(1, Math.round(0.15 / hop));
    const step = Math.max(Math.round(0.25 / hop), Math.ceil((done - 2 * half) / 2400), 1);
    let used = 0;
    for (let f = half; f < done - half; f += step) {
      const s = summarize(notes, done, maxAmp, f - half, f + half, true);
      if (!s.valid || s.silent || !s.chords.length) continue;
      const c = s.chords[0];
      for (const iv of CHORD_TYPES[c.type].iv) hist[(c.root + iv) % 12] += 1;
      if (s.bass >= 0) hist[s.bass % 12] += 0.5;
      used++;
    }
    if (used < 8) return null;
    const scores = [];
    for (let t = 0; t < 12; t++)
      for (const minor of [false, true]) {
        const prof = minor ? KK_MIN : KK_MAJ, rot = new Float64Array(12);
        for (let i = 0; i < 12; i++) rot[(t + i) % 12] = prof[i];
        scores.push({ tonic: t, minor, score: correlation(hist, rot) });
      }
    scores.sort((a, b) => b.score - a.score);
    return { tonic: scores[0].tonic, minor: scores[0].minor, score: scores[0].score, margin: scores[0].score - scores[1].score };
  }
  function transposeKey(key, tr) { return key ? { tonic: pc(key.tonic + tr), minor: key.minor } : null; }

  /* ---- nomi delle note: lettera + alterazioni scelte in base alla tonalità e all'accordo ---- */
  const LETTERS_IT = ["Do", "Re", "Mi", "Fa", "Sol", "La", "Si"], LETTERS_EN = ["C", "D", "E", "F", "G", "A", "B"];
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const SHARP = "♯", FLAT = "♭";
  const pc = x => ((x % 12) + 12) % 12;
  const alterOf = (letter, p) => { let a = pc(p - LETTER_PC[letter]); return a > 6 ? a - 12 : a; };
  /* lettera della tonica: Reb, Mib, Fa#, Lab, Sib maggiore; Do#, Mib, Fa#, Sol#, Sib minore */
  const TONIC_LETTER_MAJ = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];
  const TONIC_LETTER_MIN = [0, 0, 1, 2, 2, 3, 3, 4, 4, 5, 6, 6];
  /* grado della scala per ogni distanza dalla tonica: cromatismi come b2, b3, #4, b6, b7 in maggiore
     e b2, #3, #4, #6, #7 in minore (le alterazioni seguono da sole dalla lettera) */
  const DEGREE = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];
  const NEUTRAL = { tonic: 0, minor: false };
  function simpleSpelling(p, preferSharp) {
    const nat = LETTER_PC.indexOf(pc(p));
    if (nat >= 0) return { l: nat, a: 0 };
    return preferSharp ? { l: LETTER_PC.indexOf(pc(p - 1)), a: 1 } : { l: LETTER_PC.indexOf(pc(p + 1)), a: -1 };
  }
  const SCALE_MAJ = [0, 2, 4, 5, 7, 9, 11], SCALE_MIN = [0, 2, 3, 5, 7, 8, 10];
  const tonicLetter = key => (key.minor ? TONIC_LETTER_MIN : TONIC_LETTER_MAJ)[key.tonic];
  /* somma delle alterazioni in chiave: > 0 tonalità con diesis, < 0 con bemolle */
  function keySharps(key) {
    const sc = key.minor ? SCALE_MIN : SCALE_MAJ, tl = tonicLetter(key);
    let s = 0; for (let d = 0; d < 7; d++) s += alterOf((tl + d) % 7, key.tonic + sc[d]);
    return s;
  }
  function spellPc(p, key) {
    key = key || NEUTRAL;
    const off = pc(p - key.tonic);
    const l = (tonicLetter(key) + DEGREE[off]) % 7, a = alterOf(l, p);
    /* in minore anche sesta e settima alzate (minore melodica e armonica) contano come note della scala */
    const diatonic = (key.minor ? SCALE_MIN : SCALE_MAJ).includes(off) || (key.minor && (off === 9 || off === 11));
    /* niente doppie alterazioni; Mi#, Si#, Dob, Fab solo se appartengono alla scala */
    if (Math.abs(a) > 1 || (!diatonic && a !== 0 && LETTER_PC.includes(pc(p))))
      return simpleSpelling(p, keySharps(key) >= 0);
    return { l, a };
  }
  /* passi di lettera per ogni intervallo dell'accordo (terza = 2 lettere sopra, ecc.) */
  const IV_STEP = [0, 1, 1, 2, 2, 3, 4, 4, 4, 5, 6, 6];
  function spellChordTones(rootPc, ivs, rootSp) {
    const out = new Map(); let doubles = 0;
    for (const iv of ivs) {
      const l = (rootSp.l + IV_STEP[iv]) % 7, a = alterOf(l, rootPc + iv);
      if (Math.abs(a) > 1) doubles++;
      out.set(pc(rootPc + iv), { l, a });
    }
    return { tones: out, doubles };
  }
  /* ortografia di un accordo già trasposto: fondamentale secondo la tonalità, note come intervalli */
  function spellChord(c, transpose, key) {
    const R = pc(c.root + transpose), ivs = CHORD_TYPES[c.type].iv;
    let root = spellPc(R, key), sp = spellChordTones(R, ivs, root);
    if (!key && root.a !== 0) {
      /* tonalità ancora sconosciuta: tra Do# e Reb sceglie la grafia con meno alterazioni nell'accordo */
      const alt = simpleSpelling(R, root.a < 0), sp2 = spellChordTones(R, ivs, alt);
      const cost = t => { let n = 0; for (const v of t.tones.values()) n += Math.abs(v.a); return n + 2 * t.doubles; };
      if (cost(sp2) < cost(sp)) { root = alt; sp = sp2; }
    }
    if (sp.doubles) {
      const alt = root.a > 0 ? simpleSpelling(R, false) : root.a < 0 ? simpleSpelling(R, true) : null;
      if (alt && alt.l !== root.l) { const sp2 = spellChordTones(R, ivs, alt); if (sp2.doubles < sp.doubles) { root = alt; sp = sp2; } }
    }
    for (const [k, v] of sp.tones) if (Math.abs(v.a) > 1) sp.tones.set(k, simpleSpelling(k, v.a > 0));
    sp.tones.set(R, root);
    return { root, tones: sp.tones, bass: c.bass >= 0 && c.bass !== c.root ? sp.tones.get(pc(c.bass + transpose)) || spellPc(c.bass + transpose, key) : null };
  }
  function spText(sp, italian) {
    return (italian ? LETTERS_IT : LETTERS_EN)[sp.l] + (sp.a > 0 ? SHARP.repeat(sp.a) : FLAT.repeat(-sp.a));
  }
  function pitchClass(p, italian, key) { return spText(spellPc(p, key), italian); }
  /* convenzione italiana: Do3 = do centrale; l'ottava segue la lettera (Si#3 = Do4) */
  function noteName(midi, italian, key, chordSp) {
    const sp = (chordSp && chordSp.tones.get(pc(midi))) || spellPc(midi, key);
    let oct = Math.floor((midi - sp.a) / 12) - 1;
    if (italian) oct -= 1;
    return spText(sp, italian) + oct;
  }
  const SUFFIX_SHOW = { "m7b5": "m7" + FLAT + "5" };
  function chordName(c, transpose, italian, key) {
    const sp = spellChord(c, transpose, key);
    let name = spText(sp.root, italian) + (SUFFIX_SHOW[CHORD_TYPES[c.type].suffix] || CHORD_TYPES[c.type].suffix);
    if (sp.bass) name += "/" + spText(sp.bass, italian);
    return name;
  }
  function keyName(key, italian) {
    if (!key) return "";
    const t = spText(spellPc(key.tonic, key), italian);
    return italian ? t + (key.minor ? " minore" : " maggiore") : t + (key.minor ? " minor" : " major");
  }

  const api = { LOW_MIDI, NUM_NOTES, PEAK_BLOCK, PEAK_BLOCK2, CHORD_TYPES, RealFFT, decimate2, resample, analyze, summarize,
    estimateKey, transposeKey, keyName, spellChord, pitchClass, noteName, chordName };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DettatoAnalysis = api;
})(typeof self !== "undefined" ? self : this);
