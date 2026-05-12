// Web Audio engine — AudioContext + EQ + compressor + mic + all analysis.
import { readTags, basenameWithoutExt } from './metadata.js';
import { BpmEstimator } from './bpm.js';

const FFT_SIZE    = 2048;
const ONSET_BANDS = 11;

// Krumhansl-Kessler key profiles
const KK_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KK_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function detectKey(chroma) {
  let bestScore = -Infinity;
  let bestKey = { name: '---', root: 0, mode: 'major', confidence: 0 };
  const n = 12;
  for (let root = 0; root < n; root++) {
    for (const [mode, profile] of [['major', KK_MAJOR], ['minor', KK_MINOR]]) {
      let sC=0, sP=0, sCC=0, sPP=0, sCP=0;
      for (let i = 0; i < n; i++) {
        const c = chroma[i], p = profile[(i - root + n) % n];
        sC += c; sP += p; sCC += c*c; sPP += p*p; sCP += c*p;
      }
      const mC = sC/n, mP = sP/n;
      const cov  = sCP/n - mC*mP;
      const varC = Math.max(0, sCC/n - mC*mC);
      const varP = Math.max(0, sPP/n - mP*mP);
      const denom = Math.sqrt(varC * varP);
      const r = denom > 1e-9 ? cov / denom : 0;
      if (r > bestScore) {
        bestScore = r;
        bestKey = {
          name: NOTE_NAMES[root] + (mode === 'minor' ? 'm' : ''),
          root, mode, confidence: Math.max(0, Math.min(1, r)),
        };
      }
    }
  }
  return bestKey;
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.audioEl = null;
    this.source = null;
    this.gainNode = null;
    this.analyserSpec = null;
    this.analyserWave = null;
    this.splitter = null;
    this.analyserL = null;
    this.analyserR = null;

    this.eqLow = null;
    this.eqMid = null;
    this.eqHigh = null;
    this.compressorNode = null;
    this._compressorEnabled = false;
    this._eqGains = { low: 0, mid: 0, high: 0 };

    this._micStream = null;
    this._micSource = null;
    this._tabCaptureMode = false;
    this._timeOverride = null; // { elapsed(), duration(), seek(t) } set when YouTube player is active

    this.freqBuf  = new Uint8Array(FFT_SIZE / 2);
    this.timeBuf  = new Uint8Array(FFT_SIZE);
    this.timeBufL = new Uint8Array(FFT_SIZE);
    this.timeBufR = new Uint8Array(FFT_SIZE);

    this.metadata = { title: '', artist: '', album: '', picture: null, genres: [] };
    this.state = 'idle';
    this._userVolume = 0.78;
    this._muted = false;
    this._rms = 0;
    this._rmsL = 0;
    this._rmsR = 0;
    this._onset = null;
    this._lastTickMs = 0;
    this._bpm = new BpmEstimator();

    this._prevFreqBuf    = null;
    this._spectralFlux   = 0;
    this._spectralRolloff= 0;
    this._spectralFlatness = 0;
    this._zcr            = 0;
    this._crestFactor    = 0;
    this._stereoCorr     = 0;
    this._chromagram     = new Float32Array(12);
    this._chromaSmooth   = new Float32Array(12);
    this._key            = { name: '---', root: 0, mode: 'major', confidence: 0 };
    this._keyUpdateAt    = 0;
    this._clipping       = false;

    this.overviewPeaks = null;
    this._overviewGen  = 0;

    // Set externally by main.js after album-art color extraction
    this.themeHue = null;
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

    this.splitter   = this.ctx.createChannelSplitter(2);
    this.analyserL  = this.ctx.createAnalyser();
    this.analyserR  = this.ctx.createAnalyser();
    this.analyserL.fftSize = FFT_SIZE;
    this.analyserR.fftSize = FFT_SIZE;
    this.analyserL.smoothingTimeConstant = 0.0;
    this.analyserR.smoothingTimeConstant = 0.0;

    // EQ: low shelf → peaking mid → high shelf
    this.eqLow = this.ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 250;
    this.eqLow.gain.value = 0;

    this.eqMid = this.ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 1.4;
    this.eqMid.gain.value = 0;

    this.eqHigh = this.ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 8000;
    this.eqHigh.gain.value = 0;

    // Compressor starts as passthrough (threshold=0, ratio=1)
    this.compressorNode = this.ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = 0;
    this.compressorNode.ratio.value = 1;
    this.compressorNode.knee.value = 0;
    this.compressorNode.attack.value = 0.003;
    this.compressorNode.release.value = 0.25;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this._muted ? 0 : this._userVolume;

    // source → EQ → analysers (tap) + gainNode → compressor → output
    this.source.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.analyserSpec);
    this.eqHigh.connect(this.analyserWave);
    this.eqHigh.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.eqHigh.connect(this.gainNode);
    this.gainNode.connect(this.compressorNode);
    this.compressorNode.connect(this.ctx.destination);

    this.audioEl.addEventListener('play',  () => { this.state = 'playing'; });
    this.audioEl.addEventListener('pause', () => { this.state = 'paused'; });
    this.audioEl.addEventListener('ended', () => { this.state = 'paused'; });
  }

  async loadFile(file) {
    this._ensureContext();
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (_) {}
    }
    if (this._micStream) this.stopMic();

    this.state = 'loading';
    this.metadata = { title: basenameWithoutExt(file.name), artist: '', album: '', picture: null, genres: [] };
    this.themeHue = null;
    this.overviewPeaks = null;
    this._overviewGen++;

    if (this.audioEl.src) {
      try { URL.revokeObjectURL(this.audioEl.src); } catch (_) {}
    }
    this.audioEl.src = URL.createObjectURL(file);

    try {
      await this.audioEl.play();
      this.state = 'playing';
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      this.state = 'idle';
      this.metadata.title = `ERROR — ${err?.name}: ${err?.message}`;
      console.error('[audio] play failed:', err);
      throw err;
    }

    Promise.race([
      readTags(file),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]).then((tags) => {
      if (!tags) return;
      if (tags.title)   this.metadata.title   = tags.title;
      if (tags.artist)  this.metadata.artist  = tags.artist;
      if (tags.album)   this.metadata.album   = tags.album;
      if (tags.picture) this.metadata.picture = tags.picture;
      if (tags.genres && tags.genres.length) this.metadata.genres = tags.genres;
    }).catch(() => {});

    this._buildOverview(file);
  }

  async _buildOverview(file) {
    if (file.size > 150 * 1024 * 1024) return;
    const gen = this._overviewGen;
    try {
      const arrayBuf = await file.arrayBuffer();
      if (gen !== this._overviewGen) return;
      const decoded = await this.ctx.decodeAudioData(arrayBuf);
      if (gen !== this._overviewGen) return;
      const ch = decoded.getChannelData(0);
      const N = 1200;
      const step = Math.max(1, Math.floor(ch.length / N));
      const mn = new Float32Array(N);
      const mx = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let lo = 0, hi = 0;
        const end = Math.min((i + 1) * step, ch.length);
        for (let j = i * step; j < end; j++) {
          if (ch[j] < lo) lo = ch[j];
          if (ch[j] > hi) hi = ch[j];
        }
        mn[i] = lo; mx[i] = hi;
      }
      this.overviewPeaks = { min: mn, max: mx, len: N };
    } catch (_) {
      if (gen === this._overviewGen) this.overviewPeaks = null;
    }
  }

  play()   {
    if (!this.audioEl || !this.audioEl.src) return;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.audioEl.play().catch(() => {});
  }
  pause()  { if (this.audioEl) this.audioEl.pause(); }
  stop()   { if (!this.audioEl) return; this.audioEl.pause(); try { this.audioEl.currentTime = 0; } catch (_) {} }
  toggle() { if (!this.audioEl || !this.audioEl.src) return; if (this.audioEl.paused) this.play(); else this.audioEl.pause(); }
  seek(t)  {
    if (this._timeOverride?.seek) { this._timeOverride.seek(t); return; }
    if (this.audioEl) this.audioEl.currentTime = t;
  }

  setVolume(v) { this._userVolume = Math.max(0, Math.min(1, v)); this._muted = false; if (this.gainNode) this.gainNode.gain.value = this._userVolume; }
  getVolume()  { return this._userVolume; }
  mute()       { this._muted = true;  if (this.gainNode) this.gainNode.gain.value = 0; }
  unmute()     { this._muted = false; if (this.gainNode) this.gainNode.gain.value = this._userVolume; }
  toggleMute() { if (this._muted) this.unmute(); else this.mute(); }
  isMuted()    { return this._muted; }

  getElapsed()  {
    if (this._timeOverride?.elapsed) { try { return this._timeOverride.elapsed(); } catch (_) {} }
    return this.audioEl ? this.audioEl.currentTime : 0;
  }
  getDuration() {
    if (this._timeOverride?.duration) { try { return this._timeOverride.duration(); } catch (_) {} }
    return this.audioEl ? (this.audioEl.duration || 0) : 0;
  }

  // EQ: gains in dB (±12), applied with 15ms smoothing to avoid clicks
  setEq(low, mid, high) {
    this._eqGains = { low, mid, high };
    const t = this.ctx ? this.ctx.currentTime : 0;
    if (this.eqLow)  this.eqLow.gain.setTargetAtTime(low,  t, 0.015);
    if (this.eqMid)  this.eqMid.gain.setTargetAtTime(mid,  t, 0.015);
    if (this.eqHigh) this.eqHigh.gain.setTargetAtTime(high, t, 0.015);
  }
  getEq() { return { ...this._eqGains }; }

  // Compressor toggle — uses setTargetAtTime for click-free transition
  setCompressor(enabled) {
    this._compressorEnabled = enabled;
    if (!this.compressorNode) return;
    const t = this.ctx.currentTime;
    if (enabled) {
      this.compressorNode.threshold.setTargetAtTime(-24, t, 0.1);
      this.compressorNode.ratio.setTargetAtTime(4, t, 0.1);
      this.compressorNode.knee.setTargetAtTime(30, t, 0.1);
    } else {
      this.compressorNode.threshold.setTargetAtTime(0, t, 0.1);
      this.compressorNode.ratio.setTargetAtTime(1, t, 0.1);
      this.compressorNode.knee.setTargetAtTime(0, t, 0.1);
    }
  }
  isCompressorEnabled() { return this._compressorEnabled; }

  // Mic input — disconnects file source, connects mic through same EQ chain
  async startMic() {
    this._ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    if (this.audioEl) this.audioEl.pause();
    try {
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this._micSource = this.ctx.createMediaStreamSource(this._micStream);
      this._micSource.connect(this.eqLow);
      this.state = 'playing';
      this.metadata = { title: 'MICROPHONE INPUT', artist: 'LIVE', album: '', picture: null };
    } catch (err) {
      this._micStream = null;
      console.error('[audio] mic failed:', err);
      throw err;
    }
  }

  stopMic() {
    if (this._micSource) { try { this._micSource.disconnect(); } catch (_) {} this._micSource = null; }
    if (this._micStream) { this._micStream.getTracks().forEach((t) => t.stop()); this._micStream = null; }
    if (this._tabCaptureMode) {
      this._tabCaptureMode = false;
      // Reconnect audio output that was silenced during tab capture.
      if (this.compressorNode && this.ctx) {
        try { this.compressorNode.connect(this.ctx.destination); } catch (_) {}
      }
    }
    if (this.state === 'playing') this.state = 'paused';
  }

  isMicActive() { return this._micStream !== null; }

  // Capture from a specific audio input device (e.g. Stereo Mix) — no sharing bar.
  async startFromDevice(deviceId) {
    this._ensureContext();
    if (this._micSource) this.stopMic();
    if (this.audioEl) this.audioEl.pause();
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this._micStream  = stream;
    this._micSource  = this.ctx.createMediaStreamSource(stream);
    this._micSource.connect(this.eqLow);
    // Silence engine output — source device already plays audio to speakers.
    if (this.compressorNode) { try { this.compressorNode.disconnect(this.ctx.destination); } catch (_) {} }
    this._tabCaptureMode = true;
    this.state    = 'playing';
    this.metadata = { title: 'YOUTUBE · DEVICE AUDIO', artist: 'LIVE CAPTURE', album: '', picture: null, genres: [] };
    stream.getAudioTracks()[0].addEventListener('ended', () => this.stopMic());
  }

  // Tab audio capture via getDisplayMedia — call during a user gesture so the browser allows it.
  async startTabCapture() {
    this._ensureContext();
    if (this._micSource) this.stopMic();
    if (this.audioEl) this.audioEl.pause();

    // getDisplayMedia must be called close to the user gesture — do it first.
    // preferCurrentTab + selfBrowserSurface hint Chrome to pre-select the current tab.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      preferCurrentTab: true,
      video: { selfBrowserSurface: 'include', width: 1, height: 1, frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio track captured — tick "Share tab audio" or "Share system audio" in the picker.');
    }

    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});

    // Silence the engine's speaker output — the YouTube iframe already plays the audio.
    // The analyser chain stays connected so all panels still receive data.
    if (this.compressorNode) {
      try { this.compressorNode.disconnect(this.ctx.destination); } catch (_) {}
    }
    this._tabCaptureMode = true;

    this._micStream = stream;
    this._micSource = this.ctx.createMediaStreamSource(stream);
    this._micSource.connect(this.eqLow);
    this.state = 'playing';
    this.metadata = { title: 'YOUTUBE · TAB AUDIO', artist: 'LIVE CAPTURE', album: '', picture: null, genres: [] };

    // Stop sharing automatically when the user ends the capture from the browser UI.
    stream.getAudioTracks()[0].addEventListener('ended', () => this.stopMic());
  }

  tick() {
    if (!this.analyserSpec) return;
    this.analyserSpec.getByteFrequencyData(this.freqBuf);
    this.analyserWave.getByteTimeDomainData(this.timeBuf);
    this.analyserL.getByteTimeDomainData(this.timeBufL);
    this.analyserR.getByteTimeDomainData(this.timeBufR);

    // RMS full mix
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
      sl += vl * vl; sr += vr * vr;
    }
    this._rmsL = Math.sqrt(sl / this.timeBufL.length);
    this._rmsR = Math.sqrt(sr / this.timeBufR.length);

    // Spectral flux — positive-only inter-frame delta
    if (this._prevFreqBuf) {
      let flux = 0;
      for (let i = 0; i < this.freqBuf.length; i++) {
        const d = this.freqBuf[i] - this._prevFreqBuf[i];
        if (d > 0) flux += d;
      }
      this._spectralFlux = flux / (this.freqBuf.length * 255);
    } else {
      this._prevFreqBuf = new Uint8Array(this.freqBuf.length);
    }
    this._prevFreqBuf.set(this.freqBuf);

    // Spectral rolloff (85th-percentile energy bin)
    {
      let total = 0;
      for (let i = 0; i < this.freqBuf.length; i++) total += this.freqBuf[i];
      const target = total * 0.85;
      let acc = 0, bin = 0;
      for (let i = 0; i < this.freqBuf.length; i++) {
        acc += this.freqBuf[i];
        if (acc >= target) { bin = i; break; }
      }
      this._spectralRolloff = (bin + 0.5) * (this.getSampleRate() / FFT_SIZE);
    }

    // Spectral flatness (Wiener entropy)
    {
      const f = this.freqBuf;
      let logSum = 0, linSum = 0, count = 0;
      for (let i = 1; i < f.length; i++) {
        if (f[i] > 0) { logSum += Math.log(f[i]); linSum += f[i]; count++; }
      }
      this._spectralFlatness = (count > 0 && linSum > 0)
        ? Math.min(1, Math.exp(logSum / count) / (linSum / count))
        : 0;
    }

    // Zero-crossing rate
    {
      let zc = 0;
      for (let i = 1; i < this.timeBuf.length; i++) {
        if ((this.timeBuf[i] >= 128) !== (this.timeBuf[i - 1] >= 128)) zc++;
      }
      this._zcr = zc / (this.timeBuf.length - 1);
    }

    // Crest factor (peak / RMS in dB)
    {
      let peak = 0;
      for (let i = 0; i < this.timeBuf.length; i++) {
        const v = Math.abs(this.timeBuf[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      this._crestFactor = (peak > 0 && this._rms > 1e-5)
        ? 20 * Math.log10(peak / this._rms) : 0;
    }

    // Stereo correlation (Pearson L/R)
    {
      const n = this.timeBufL.length;
      let slm = 0, srm = 0, sl2 = 0, sr2 = 0, slr = 0;
      for (let i = 0; i < n; i++) {
        const l = (this.timeBufL[i] - 128) / 128;
        const r = (this.timeBufR[i] - 128) / 128;
        slm += l; srm += r; sl2 += l*l; sr2 += r*r; slr += l*r;
      }
      const ml = slm/n, mr = srm/n;
      const cov  = slr/n - ml*mr;
      const denom = Math.sqrt(Math.max(0, sl2/n - ml*ml) * Math.max(0, sr2/n - mr*mr));
      this._stereoCorr = denom > 1e-8 ? Math.max(-1, Math.min(1, cov / denom)) : 0;
    }

    // Chromagram + key detection
    {
      const f = this.freqBuf, sr = this.getSampleRate(), fLen = f.length;
      const raw = new Float32Array(12);
      for (let i = 2; i < fLen; i++) {
        const hz = (i + 0.5) * sr / FFT_SIZE;
        if (hz < 65.4 || hz > 2093) continue;
        const pc = ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12;
        const v = f[i] / 255;
        if (v > raw[pc]) raw[pc] = v;
      }
      let maxV = 0;
      for (let i = 0; i < 12; i++) if (raw[i] > maxV) maxV = raw[i];
      const scale = maxV > 0.01 ? 1 / maxV : 0;
      for (let i = 0; i < 12; i++) {
        this._chromaSmooth[i] = this._chromaSmooth[i] * 0.85 + raw[i] * scale * 0.15;
        this._chromagram[i] = this._chromaSmooth[i];
      }
      const now = performance.now();
      if (now - this._keyUpdateAt > 500 && maxV > 0.05) {
        this._key = detectKey(this._chromagram);
        this._keyUpdateAt = now;
      }
    }

    this._clipping = this.getPeakDb() > -0.3;

    if (!this._onset) this._onset = new OnsetDetector(ONSET_BANDS);
    const bands = this.getMultiBands(ONSET_BANDS);
    const now = performance.now();
    this._onset.feed(now, bands);
    this._bpm.push(now, bands[0]);
    this._lastTickMs = now;
  }

  getOnsetBands()     { return this._onset ? this._onset.fired    : null; }
  getOnsetStrength()  { return this._onset ? this._onset.strength : null; }
  getOnsetBandCount() { return ONSET_BANDS; }

  getBpm()              { return this._bpm.bpm; }
  getBeatPhase()        { return this._bpm.getBeatPhase(performance.now()); }
  getContinuousBeats()  { return this._bpm.getContinuousBeats(performance.now()); }
  didBeatFire()         { return this._bpm.fired; }
  getBpmConfidence()    { return this._bpm.confidence; }
  resetBpm()            { this._bpm.reset(); }
  forceBpm(bpm)         { this._bpm.forceBpm(bpm); }

  getFreqData()   { return this.freqBuf; }
  getTimeData()   { return this.timeBuf; }
  getTimeDataL()  { return this.timeBufL; }
  getTimeDataR()  { return this.timeBufR; }
  getRMS()        { return this._rms; }
  getRMSL()       { return this._rmsL; }
  getRMSR()       { return this._rmsR; }
  getSampleRate() { return this.ctx ? this.ctx.sampleRate : 44100; }
  getFftSize()    { return FFT_SIZE; }
  getBinCount()   { return this.freqBuf.length; }

  getSpectralFlux()      { return this._spectralFlux; }
  getSpectralRolloff()   { return this._spectralRolloff; }
  getSpectralFlatness()  { return this._spectralFlatness; }
  getZCR()               { return this._zcr; }
  getCrestFactor()       { return this._crestFactor; }
  getStereoCorrelation() { return this._stereoCorr; }
  getChromagram()        { return this._chromagram; }
  getKey()               { return this._key; }
  isClipping()           { return this._clipping; }

  getPeakDb() {
    let peak = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const v = Math.abs(this.timeBuf[i] - 128);
      if (v > peak) peak = v;
    }
    return peak === 0 ? -Infinity : 20 * Math.log10(peak / 128);
  }

  getDominantFreq() {
    const f = this.freqBuf;
    let maxV = 0, maxI = 0;
    for (let i = 1; i < f.length; i++) { if (f[i] > maxV) { maxV = f[i]; maxI = i; } }
    if (maxV < 12) return 0;
    return (maxI + 0.5) * (this.getSampleRate() / FFT_SIZE);
  }

  getStereoBalance() {
    const s = this._rmsL + this._rmsR;
    return s < 1e-4 ? 0 : (this._rmsR - this._rmsL) / s;
  }

  getBands() {
    const f = this.freqBuf, n = f.length;
    const bassEnd = Math.floor(n * 0.06), midEnd = Math.floor(n * 0.35);
    let bass = 0, mid = 0, high = 0;
    for (let i = 0; i < bassEnd; i++) bass += f[i];
    for (let i = bassEnd; i < midEnd; i++) mid += f[i];
    for (let i = midEnd; i < n; i++) high += f[i];
    return {
      bass: bass / (bassEnd * 255 || 1),
      mid:  mid  / ((midEnd - bassEnd) * 255 || 1),
      high: high / ((n - midEnd) * 255 || 1),
    };
  }

  getBand7() {
    const f = this.freqBuf, n = f.length;
    const sr = this.getSampleRate(), nyquist = sr / 2;
    const defs = [
      ['sub',20,80],['bass',80,250],['loMid',250,500],
      ['mid',500,2000],['hiMid',2000,4000],['presence',4000,8000],['air',8000,20000],
    ];
    const out = {};
    for (const [name, lo, hi] of defs) {
      const i0 = Math.max(1, Math.floor(lo / nyquist * n));
      const i1 = Math.min(n, Math.ceil(hi / nyquist * n));
      let s = 0;
      for (let i = i0; i < i1; i++) s += f[i];
      out[name] = s / (Math.max(1, i1 - i0) * 255);
    }
    return out;
  }

  getMultiBands(N) {
    if (!this._mb || this._mb.length !== N) this._mb = new Float32Array(N);
    const f = this.freqBuf, sr = this.getSampleRate(), nyquist = sr / 2, fLen = f.length;
    const logMin = Math.log2(20), logMax = Math.log2(Math.min(20000, nyquist));
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

  getSpectralCentroid() {
    const f = this.freqBuf, binHz = this.getSampleRate() / FFT_SIZE;
    let num = 0, den = 0;
    for (let i = 1; i < f.length; i++) { num += f[i] * (i + 0.5) * binHz; den += f[i]; }
    return den < 8 ? 0 : num / den;
  }
}

export class OnsetDetector {
  constructor(numBands = 11, opts = {}) {
    this.N = numBands;
    this.window = opts.window ?? 32;
    this.k = opts.k ?? 1.6;
    this.refractoryMs = opts.refractoryMs ?? 90;
    this.history = [];
    for (let i = 0; i < this.window; i++) this.history.push(new Float32Array(numBands));
    this.cursor = 0;
    this.lastFireMs = new Float32Array(numBands);
    this.fired    = new Uint8Array(numBands);
    this.strength = new Float32Array(numBands);
  }

  feed(now, bands) {
    this.fired.fill(0);
    this.strength.fill(0);
    this.history[this.cursor].set(bands);
    for (let b = 0; b < this.N; b++) {
      let mean = 0;
      for (let i = 0; i < this.window; i++) mean += this.history[i][b];
      mean /= this.window;
      let varSum = 0;
      for (let i = 0; i < this.window; i++) { const d = this.history[i][b] - mean; varSum += d*d; }
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
