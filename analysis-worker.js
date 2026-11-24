// Analisi del brano in background: picchi, accordatura, energia per semitono.
importScripts("analysis-core.js");
self.onmessage = e => {
  const { L, R, sampleRate } = e.data;
  self.DettatoAnalysis.analyze(L, R, sampleRate, {
    peaks: p => postMessage({ type: "peaks", peaks: p }),
    tuning: (cents, conf) => postMessage({ type: "tuning", cents, conf }),
    info: (hop, numFrames) => postMessage({ type: "info", hop, numFrames }),
    frames: (start, data, maxAmp) => postMessage({ type: "frames", start, data, maxAmp }, [data.buffer])
  });
  postMessage({ type: "done" });
};
