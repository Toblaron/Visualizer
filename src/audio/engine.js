// Web Audio engine: AudioContext + analysers + file loading.
// Single shared instance, exported as `audio`.

import { readTags, basenameWithoutExt } from './metadata.js';
import { BpmEstimator } from './bpm.js';

const FFT_SIZE = 2048;
const ONSET_BANDS = 11;

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.audioEl = null;
    this.source = null;
    this.gainNode = null;
    this.analyserSpec = null;   // smoothed, for spectrum/histogram
    this.analyserWave = null;   // sharp, for waveform
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;

    this.freqBuf = new Uint8Array(FFT_SIZE / 2);
    this.timeBuf = new Uint8Array(FFT_SIZE);
    this.timeBufL = new Uint8Array(FFT_SIZE);
    this.timeBufR = new Uint8Array(FFT_SIZE);

    this.metadata = {
      title: '',
      artist: '',
      album: '',
      picture: null,
    };
    this.state = 'idle';      // idle | loading | playing | paused
    this._rms = 0;
    this._rmsL = 0;
    this._rmsR = 0;
    this._onset = null;       // lazy: needs OnsetDetector after definition
    this._lastTickMs = 0;
    this._bpm = new BpmEstimator();
  }

  _ensureContext() {
    if (this.ctx) return;
    this.audioEl = document.getElementById('audio-element');
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.source = this.ctx.createMediaElementSource(this.audioEl);

    this.analyserSpec = this.ctx.createAnalyser();
    this.analyserSpec.fftSize = FFT_SIZE;
    this.analyserSpec.smoothingTimeConstant = 0.82;

    this.analyserWave = this.ctx.createAnalyser();
    this.analyserWave.fftSize = FFT_SIZE;
    this.analyserWave.smoothingTimeConstant = 0.0;

    this.splitter = this.ctx.createChannelSplitter(2);
    this.analyserL = this.ctx.createAnalyser();
    this.analyserR = this.ctx.createAnalyser();
    this.analyserL.fftSize = FFT_SIZE;
    this.analyserR.fftSize = FFT_SIZE;
    this.analyserL.smoothingTimeConstant = 0.0;
    this.analyserR.smoothingTimeConstant = 0.0;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 0.78;

    // routing
    this.source.connect(this.analyserSpec);
    this.source.connect(this.analyserWave);
    this.source.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);

    this.audioEl.addEventListener('play',  () => { this.state = 'playing'; });
    this.audioEl.addEventListener('pause', () => { this.state = 'paused'; });
    this.audioEl.addEventListener('ended', () => { this.state = 'paused'; });
  }

  async loadFile(file) {
    this._ensureContext();
    this.state = 'loading';

    if (this.audioEl.src) URL.revokeObjectURL(this.audioEl.src);
    this.audioEl.src = URL.createObjectURL(file);

    this.metadata = {
      title: basenameWithoutExt(file.name),
      artist: 'UNKNOWN',
      album: '',
      picture: null,
    };

    try {
      const tags = await readTags(file);
      if (tags) {
        if (tags.title)  this.metadata.title  = tags.title;
        if (tags.artist) this.metadata.artist = tags.artist;
        if (tags.album)  this.metadata.album  = tags.album;
        if (tags.picture) this.metadata.picture = tags.picture;
      }
    } catch (_) {
      // metadata is optional; ignore parse failures
    }

    await new Promise((resolve) => {
      // Metadata may already be ready (e.g., it loaded while we awaited
      // readTags). Without this readyState check the listener never fires
      // and loadFile hangs.
      if (this.audioEl.readyState >= 1) { resolve(); return; }
      const done = () => { this.audioEl.removeEventListener('loadedmetadata', done); resolve(); };
      this.audioEl.addEventListener('loadedmetadata', done);
    });

    if (this.ctx.state === 'suspended') await this.ctx.resume();
    try {
      await this.audioEl.play();
      this.state = 'playing';
    } catch (err) {
      // Rapid track-switching can abort the previous play() with AbortError.
      // The next loadFile() will start cleanly; nothing to do here.
      if (err && err.name !== 'AbortError') throw err;
    }
  }

  play()  { if (this.audioEl) this.audioEl.play(); }
  pause() { if (this.audioEl) this.audioEl.pause(); }
  toggle() {
    if (!this.audioEl) return;
    if (this.audioEl.paused) this.audioEl.play();
    else this.audioEl.pause();
  }
  seek(t) { if (this.audioEl) this.audioEl.currentTime = t; }

  setVolume(v) {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, v));
  }
  getVolume() { return this.gainNode ? this.gainNode.gain.value : 0.78; }

  getElapsed()   { return this.audioEl ? this.audioEl.currentTime : 0; }
  getDuration()  { return this.audioEl ? (this.audioEl.duration || 0) : 0; }

  // refresh data buffers — called once per RAF frame
  tick() {
    if (!this.analyserSpec) return;
    this.analyserSpec.getByteFrequencyData(this.freqBuf);
    this.analyserWave.getByteTimeDomainData(this.timeBuf);
    this.analyserL.getByteTimeDomainData(this.timeBufL);
    this.analyserR.getByteTimeDomainData(this.timeBufR);

    // RMS for full mix
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = (this.timeBuf[i] - 128) / 128;
      sum += v * v;
    }
    this._rms = Math.sqrt(sum / this.timeBuf.length);

    // RMS L/R
    let sl = 0, sr = 0;
    for (let i = 0; i < this.timeBufL.length; i++) {
      const vl = (this.timeBufL[i] - 128) / 128;
      const vr = (this.timeBufR[i] - 128) / 128;
      sl += vl * vl;
      sr += vr * vr;
    }
    this._rmsL = Math.sqrt(sl / this.timeBufL.length);
    this._rmsR = Math.sqrt(sr / this.timeBufR.length);

    // Onset detection across N log-spaced bands.
    if (!this._onset) this._onset = new OnsetDetector(ONSET_BANDS);
    const bands = this.getMultiBands(ONSET_BANDS);
    const now = performance.now();
    this._onset.feed(now, bands);

    // BPM tracking driven by sub-bass onset/energy (kick band).
    this._bpm.push(now, bands[0]);

    this._lastTickMs = now;
  }

  getOnsetBands()    { return this._onset ? this._onset.fired    : null; }
  getOnsetStrength() { return this._onset ? this._onset.strength : null; }
  getOnsetBandCount(){ return ONSET_BANDS; }

  // BPM / beat helpers
  getBpm()              { return this._bpm.bpm; }
  getBeatPhase()        { return this._bpm.getBeatPhase(performance.now()); }
  getContinuousBeats()  { return this._bpm.getContinuousBeats(performance.now()); }
  didBeatFire()         { return this._bpm.fired; }
  resetBpm()            { this._bpm.reset(); }

  getFreqData()  { return this.freqBuf; }
  getTimeData()  { return this.timeBuf; }
  getTimeDataL() { return this.timeBufL; }
  getTimeDataR() { return this.timeBufR; }
  getRMS()       { return this._rms; }
  getRMSL()      { return this._rmsL; }
  getRMSR()      { return this._rmsR; }
  getSampleRate() { return this.ctx ? this.ctx.sampleRate : 44100; }
  getFftSize()    { return FFT_SIZE; }
  getBinCount()   { return this.freqBuf.length; }

  // Peak dBFS for the current time-domain frame (-Infinity..0).
  getPeakDb() {
    let peak = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = Math.abs(this.timeBuf[i] - 128);
      if (v > peak) peak = v;
    }
    if (peak === 0) return -Infinity;
    return 20 * Math.log10(peak / 128);
  }

  // Dominant frequency in Hz (bin center of the loudest FFT bin, smoothed).
  getDominantFreq() {
    const f = this.freqBuf;
    let maxV = 0, maxI = 0;
    for (let i = 1; i < f.length; i++) {   // skip DC bin
      if (f[i] > maxV) { maxV = f[i]; maxI = i; }
    }
    if (maxV < 12) return 0;               // silence floor — avoid label flicker
    const sr = this.getSampleRate();
    return (maxI + 0.5) * (sr / FFT_SIZE);
  }

  // Stereo balance in [-1, +1]: -1 fully left, 0 centered, +1 fully right.
  getStereoBalance() {
    const sum = this._rmsL + this._rmsR;
    if (sum < 1e-4) return 0;
    return (this._rmsR - this._rmsL) / sum;
  }

  // band energies in 0..1
  getBands() {
    const f = this.freqBuf;
    const n = f.length;
    let bass = 0, mid = 0, high = 0;
    const bassEnd = Math.floor(n * 0.06);   // ~0..1.3kHz
    const midEnd  = Math.floor(n * 0.35);   // ~1.3..7.5kHz
    for (let i = 0; i < bassEnd; i++) bass += f[i];
    for (let i = bassEnd; i < midEnd; i++) mid += f[i];
    for (let i = midEnd;  i < n; i++) high += f[i];
    bass /= bassEnd * 255 || 1;
    mid  /= (midEnd - bassEnd) * 255 || 1;
    high /= (n - midEnd) * 255 || 1;
    return { bass, mid, high };
  }

  // N log-spaced sub-bands across 20Hz..nyquist, each in 0..1.
  // Cached array reused across calls (don't mutate in callers).
  getMultiBands(N) {
    if (!this._mb || this._mb.length !== N) this._mb = new Float32Array(N);
    const f = this.freqBuf;
    const sr = this.getSampleRate();
    const nyquist = sr / 2;
    const fLen = f.length;
    const minHz = 20;
    const maxHz = Math.min(20000, nyquist);
    const logMin = Math.log2(minHz);
    const logMax = Math.log2(maxHz);
    for (let b = 0; b < N; b++) {
      const f0 = Math.pow(2, logMin + (b / N) * (logMax - logMin));
      const f1 = Math.pow(2, logMin + ((b + 1) / N) * (logMax - logMin));
      const i0 = Math.max(1, Math.floor(f0 / nyquist * fLen));
      const i1 = Math.max(i0 + 1, Math.floor(f1 / nyquist * fLen));
      let max = 0;
      for (let j = i0; j < i1 && j < fLen; j++) if (f[j] > max) max = f[j];
      this._mb[b] = max / 255;
    }
    return this._mb;
  }

  // Spectral centroid in Hz — the "brightness" of the sound.
  // Returns 0 during silence.
  getSpectralCentroid() {
    const f = this.freqBuf;
    const sr = this.getSampleRate();
    const binHz = sr / FFT_SIZE;
    let num = 0, den = 0;
    for (let i = 1; i < f.length; i++) {
      const v = f[i];
      num += v * (i + 0.5) * binHz;
      den += v;
    }
    return den < 8 ? 0 : num / den;
  }
}

// ---------------------------------------------------------------------
// Onset detector: per-band transient detection.
// Tracks a short-term energy mean per band; fires when current energy
// exceeds (mean + k·stddev) AND a refractory period has passed.
// Designed to be fed once per audio frame.
// ---------------------------------------------------------------------
export class OnsetDetector {
  constructor(numBands = 11, opts = {}) {
    this.N = numBands;
    this.window = opts.window ?? 32;       // history length per band
    this.k = opts.k ?? 1.6;                // sensitivity
    this.refractoryMs = opts.refractoryMs ?? 90;
    this.history = [];                     // ring of Float32Array(N)
    for (let i = 0; i < this.window; i++) this.history.push(new Float32Array(numBands));
    this.cursor = 0;
    this.lastFireMs = new Float32Array(numBands);
    this.fired = new Uint8Array(numBands); // 0/1 latch per frame
    this.strength = new Float32Array(numBands); // delta over threshold
  }

  // Returns indices of bands that fired this frame. `bands` is a
  // Float32Array of per-band energies (0..1).
  feed(now, bands) {
    this.fired.fill(0);
    this.strength.fill(0);
    this.history[this.cursor].set(bands);

    for (let b = 0; b < this.N; b++) {
      let mean = 0;
      for (let i = 0; i < this.window; i++) mean += this.history[i][b];
      mean /= this.window;
      let varSum = 0;
      for (let i = 0; i < this.window; i++) {
        const d = this.history[i][b] - mean;
        varSum += d * d;
      }
      const stddev = Math.sqrt(varSum / this.window);
      const thresh = mean + stddev * this.k;
      const v = bands[b];
      if (v > thresh && v > 0.04 && now - this.lastFireMs[b] > this.refractoryMs) {
        this.fired[b] = 1;
        this.strength[b] = Math.min(1, (v - thresh) / Math.max(0.05, mean + stddev));
        this.lastFireMs[b] = now;
      }
    }
    this.cursor = (this.cursor + 1) % this.window;
    return this.fired;
  }
}

export const audio = new AudioEngine();
