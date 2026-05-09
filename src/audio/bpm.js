// Lightweight BPM estimator: bass-band peak interval -> EMA-smoothed BPM.

const WINDOW_MS = 6000;          // history length for peak intervals
const REFRACTORY_MS = 220;       // min gap between peaks
const MIN_BPM = 60;
const MAX_BPM = 200;

export class BpmEstimator {
  constructor() {
    this.samples = [];           // { t, v } recent bass-RMS
    this.peaks = [];             // peak timestamps (ms)
    this.ema = null;
    this.fired = false;
    this.totalBeats = 0;
  }

  // Call every audio frame. `bassEnergy` is 0..1.
  // Returns true if a beat fired this call.
  push(now, bassEnergy) {
    this.fired = false;
    this.samples.push({ t: now, v: bassEnergy });
    while (this.samples.length && now - this.samples[0].t > WINDOW_MS) {
      this.samples.shift();
    }

    let mean = 0;
    for (const s of this.samples) mean += s.v;
    mean /= this.samples.length || 1;
    let varSum = 0;
    for (const s of this.samples) varSum += (s.v - mean) ** 2;
    const stddev = Math.sqrt(varSum / (this.samples.length || 1));

    const threshold = mean + stddev * 1.4;
    const lastPeak = this.peaks[this.peaks.length - 1] || 0;

    if (bassEnergy > threshold && now - lastPeak > REFRACTORY_MS) {
      this.peaks.push(now);
      this.totalBeats++;
      this.fired = true;
      while (this.peaks.length && now - this.peaks[0] > WINDOW_MS) {
        this.peaks.shift();
      }
      this._recompute();
    }
    return this.fired;
  }

  // Fractional beat count since first detected beat. Smoothly increments
  // between fires using the EMA-smoothed period.
  getContinuousBeats(now) {
    if (this.ema == null || !this.peaks.length) return 0;
    const period = 60000 / this.ema;
    const last = this.peaks[this.peaks.length - 1];
    const elapsed = (now - last) / period;
    return this.totalBeats + Math.min(1.5, Math.max(0, elapsed));
  }

  // 0..1, where 0 = just hit a beat, 0.5 = halfway between, 1 = next beat.
  getBeatPhase(now) {
    if (this.ema == null || !this.peaks.length) return 0;
    const period = 60000 / this.ema;
    const last = this.peaks[this.peaks.length - 1];
    return ((now - last) % period) / period;
  }

  getLastBeatMs() { return this.peaks.length ? this.peaks[this.peaks.length - 1] : 0; }

  _recompute() {
    if (this.peaks.length < 4) return;
    const intervals = [];
    for (let i = 1; i < this.peaks.length; i++) {
      intervals.push(this.peaks[i] - this.peaks[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    let bpm = 60000 / median;
    while (bpm < MIN_BPM) bpm *= 2;
    while (bpm > MAX_BPM) bpm /= 2;
    this.ema = this.ema === null ? bpm : this.ema * 0.7 + bpm * 0.3;
  }

  get bpm() {
    return this.ema === null ? null : Math.round(this.ema);
  }

  reset() {
    this.samples.length = 0;
    this.peaks.length = 0;
    this.ema = null;
    this.fired = false;
    this.totalBeats = 0;
  }
}
