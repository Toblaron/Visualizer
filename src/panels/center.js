// CENTER — elongated horizontal lens of audio-reactive particles + two
// polar waveform outlines (cyan outer, magenta inner) + horizontal streamers.
// Matches the reference HUD: wider-than-tall diamond, layered cyan/magenta
// rings, particle haze, scan-tick speckle.
import { sizeCanvas } from './_canvas.js';

const PARTICLE_COUNT = 4800;
const X_SCALE = 1.40;        // horizontal stretch — gives the lens shape
const Y_SCALE = 0.85;
const WAVE_REVS = 1;         // polar waveform: 1 revolution

// Worst-case multiplier on `radius` from particles + audio expansion.
// Bounded analysis: pBaseR<=0.95, plus audio mod sums to <= ~0.85 → ~1.8.
// Wave peak: radiusFrac<=0.92 * reach<=1.55 * wobble<=1.10 → ~1.55.
// Use the larger so we fit at full bass + RMS.
const PEAK_EXTENT = 1.85;

let canvas, audio;
let pAngle, pBaseR, pPhase, pAmp, pBand;
let scanTicks = [];
let streamers = [];
let mode = 'AMBIENT PULSE';

let dataPeak, dataF0, dataFft, dataStereo, dataRms;
let lastStatsAt = 0;

const MODE_PARAMS = {
  'AMBIENT PULSE': { bass: 0.55, mid: 0.40, high: 0.30, trail: 0.20, ringPow: 1.0, hueBase: 188, hueSpread: 90 },
  'DEEP FIELD':    { bass: 0.85, mid: 0.20, high: 0.55, trail: 0.10, ringPow: 0.7, hueBase: 220, hueSpread: 120 },
  'NEON GRID':     { bass: 0.30, mid: 0.70, high: 0.40, trail: 0.28, ringPow: 1.4, hueBase: 280, hueSpread: 60 },
  'PHASE LOCK':    { bass: 0.65, mid: 0.55, high: 0.20, trail: 0.18, ringPow: 1.0, hueBase: 165, hueSpread: 40 },
};

export function init(c, a) {
  canvas = c;
  audio = a;
  pAngle = new Float32Array(PARTICLE_COUNT);
  pBaseR = new Float32Array(PARTICLE_COUNT);
  pPhase = new Float32Array(PARTICLE_COUNT);
  pAmp   = new Float32Array(PARTICLE_COUNT);
  pBand  = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    pAngle[i] = Math.random() * Math.PI * 2;
    // Cloud spread 0.30..0.95 (capped) so peak audio expansion still fits.
    pBaseR[i] = 0.30 + Math.random() * 0.65;
    pPhase[i] = Math.random() * Math.PI * 2;
    pAmp[i]   = 0.20 + Math.random() * 0.80;
    pBand[i]  = Math.random();              // which freq band tap
  }

  dataPeak   = document.getElementById('data-peak');
  dataF0     = document.getElementById('data-f0');
  dataFft    = document.getElementById('data-fft');
  dataStereo = document.getElementById('data-stereo');
  dataRms    = document.getElementById('data-rms');
}

export function setMode(m) { mode = m; }

export function render(now) {
  const { ctx, w, h } = sizeCanvas(canvas);
  const params = MODE_PARAMS[mode] || MODE_PARAMS['AMBIENT PULSE'];

  // Trail fade
  ctx.save();
  ctx.fillStyle = `rgba(5, 10, 24, ${params.trail})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const cx = w / 2;
  const cy = h / 2;
  // Radius sized so peak extent fits within the panel on both axes.
  // Account for the lens scaling so wide panels don't bleed past the sides.
  const margin = 6;
  const fitX = (w / 2 - margin) / (X_SCALE * PEAK_EXTENT);
  const fitY = (h / 2 - margin) / (Y_SCALE * PEAK_EXTENT);
  const radius = Math.min(fitX, fitY);

  let bass = 0, mid = 0, high = 0, rms = 0;
  if (audio && audio.getBands) {
    const b = audio.getBands();
    bass = b.bass; mid = b.mid; high = b.high;
    rms = audio.getRMS();
  }

  drawBackdropRings(ctx, cx, cy, radius);
  drawCrosshair(ctx, cx, cy, radius);

  // Particle haze underneath
  drawParticles(ctx, cx, cy, radius, now, bass, mid, high, rms, params);

  // BPM-locked counter-rotation: outer ring spins at +π/2 per beat (one
  // full turn per bar of 4 beats); inner ring counter-rotates. Falls back
  // to no rotation if BPM hasn't locked yet.
  let rotOuter = 0, rotInner = 0;
  if (audio && audio.getContinuousBeats) {
    const beats = audio.getContinuousBeats();
    rotOuter =  beats * (Math.PI / 2);
    rotInner = -beats * (Math.PI / 2) + 0.18;
  }

  // Subtle bass-driven kick on each beat — the ring "snaps out" briefly.
  const beatPhase = audio && audio.getBeatPhase ? audio.getBeatPhase() : 0;
  const beatKick = Math.max(0, 1 - beatPhase * 4) * 0.06;   // brief decay over first 25% of beat

  drawPolarWaveform(ctx, cx, cy, radius, bass, mid, high, rms,
    /*phase*/ rotOuter, /*radiusFrac*/ 0.95 + beatKick, /*hue*/ 188, /*alpha*/ 0.85, /*lineW*/ 1.2);
  drawPolarWaveform(ctx, cx, cy, radius, bass, mid, high, rms,
    /*phase*/ rotInner, /*radiusFrac*/ 0.62 + beatKick * 0.6, /*hue*/ 320, /*alpha*/ 0.75, /*lineW*/ 1.0);

  // Horizontal streamers — fire on real onsets, Y mapped to dominant band
  spawnOnsetStreamers(cx, cy, radius);
  drawStreamers(ctx);

  // Shards — fire on onsets, angle = the band's slot on the spectral disc
  spawnOnsetShards(cx, cy, radius);
  drawScanTicks(ctx);

  drawDiamondCore(ctx, cx, cy, bass, rms);
  drawCoreGlow(ctx, cx, cy, bass);

  updateDataLabels(now, rms);
}

function drawBackdropRings(ctx, cx, cy, radius) {
  ctx.save();
  // Three concentric ellipses to suggest depth shells.
  for (let i = 1; i <= 3; i++) {
    ctx.strokeStyle = `rgba(34, 230, 255, ${0.05 + (3 - i) * 0.02})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius * (i / 3) * X_SCALE, radius * (i / 3) * Y_SCALE, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCrosshair(ctx, cx, cy, radius) {
  ctx.save();
  ctx.strokeStyle = 'rgba(34, 230, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - radius * X_SCALE, cy + 0.5);
  ctx.lineTo(cx + radius * X_SCALE, cy + 0.5);
  ctx.moveTo(cx + 0.5, cy - radius * Y_SCALE);
  ctx.lineTo(cx + 0.5, cy + radius * Y_SCALE);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(34, 230, 255, 0.30)';
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// Polar plot of time-domain waveform — produces the visible "outline rings"
// in the reference. radiusFrac controls how far out it sits.
function drawPolarWaveform(ctx, cx, cy, radius, bass, mid, high, rms, phase, radiusFrac, hue, alpha, lineW) {
  if (!audio || !audio.getTimeData) return;
  const t = audio.getTimeData();
  const N = t.length;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Outer glow pass
  ctx.strokeStyle = `hsla(${hue}, 100%, 65%, ${alpha * 0.45})`;
  ctx.lineWidth = lineW * 3;
  ctx.shadowBlur = 12;
  ctx.shadowColor = `hsla(${hue}, 100%, 65%, ${alpha})`;
  drawPath(ctx);

  // Bright core pass
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `hsla(${hue}, 100%, 80%, ${alpha})`;
  ctx.lineWidth = lineW;
  drawPath(ctx);

  ctx.restore();

  function drawPath(c) {
    c.beginPath();
    const baseAmp = radius * radiusFrac;
    const reach = 1 + bass * 0.22 + rms * 0.25;
    for (let i = 0; i <= N; i += 2) {
      const ix = i % N;
      const ang = (i / N) * Math.PI * 2 * WAVE_REVS + phase;
      const s = (t[ix] - 128) / 128;            // -1..1
      const wobble = 1 + s * (0.13 + mid * 0.16) + Math.sin(ang * 4) * high * 0.03;
      const r = baseAmp * reach * wobble;
      const x = cx + Math.cos(ang) * r * X_SCALE;
      const y = cy + Math.sin(ang) * r * Y_SCALE;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    c.stroke();
  }
}

function drawParticles(ctx, cx, cy, radius, now, bass, mid, high, rms, params) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  const t = now * 0.001;
  const bassMod = bass * params.bass;
  const midMod  = mid  * params.mid;
  const highMod = high * params.high;
  const f = audio && audio.getFreqData ? audio.getFreqData() : null;
  const fLen = f ? f.length : 0;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const ang = pAngle[i] + Math.sin(t * 0.3 + pPhase[i]) * 0.04;

    // Per-particle steady-state frequency tap (drives glow/size/color)
    let bandV = 0;
    let jitter = 0;
    if (f) {
      const idx = Math.floor(pBand[i] * fLen * 0.7);
      bandV = f[idx] / 255;
      // Jitter sourced from a high-end FFT bin specific to the particle —
      // shimmers only when there's actual high-frequency content.
      const jIdx = Math.floor((pBand[i] * 0.4 + 0.55) * fLen);
      jitter = (f[jIdx] / 255) - 0.5;
    }

    const baseR = Math.pow(pBaseR[i], params.ringPow);
    const factor = 1 +
        bassMod * (0.40 + 0.30 * Math.sin(pPhase[i])) +
        midMod  * 0.55 * Math.sin(ang * 2 + t * 1.4) +
        highMod * jitter * 0.45 +
        bandV * 0.22;
    // Hard cap so even pathological audio can't push particles out of frame.
    const cappedFactor = Math.min(factor, PEAK_EXTENT);
    const r = baseR * radius * cappedFactor;

    const x = cx + Math.cos(ang) * r * X_SCALE;
    const y = cy + Math.sin(ang) * r * Y_SCALE;

    const hue = params.hueBase + high * params.hueSpread + bandV * 40;
    const light = 55 + bandV * 25;
    const alpha = (0.18 + bandV * 0.65 + rms * 0.35) * pAmp[i];

    ctx.fillStyle = `hsla(${hue}, 95%, ${light}%, ${Math.min(0.95, alpha)})`;
    const size = 0.7 + bandV * 1.3 + rms * 0.6;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

// Streamers fire only when an onset fires. Y position is mapped from
// the band index of whichever onset triggered (low bands → bottom,
// high bands → top). Direction alternates per fire so streamers cross
// each other instead of always going one way.
let streamerDir = 1;
function spawnOnsetStreamers(cx, cy, radius) {
  if (!audio || !audio.getOnsetBands) return;
  const onsets = audio.getOnsetBands();
  const strengths = audio.getOnsetStrength();
  if (!onsets) return;
  const N = audio.getOnsetBandCount();

  for (let b = 0; b < N; b++) {
    if (!onsets[b]) continue;
    const strength = strengths ? strengths[b] : 0.5;
    // Map band to vertical position: band 0 (bass) → bottom, band N-1 → top
    const yFrac = 1 - (b + 0.5) / N;        // 0 = top, 1 = bottom
    const yOff = (yFrac - 0.5) * radius * 1.7;
    const dir = streamerDir;
    streamerDir = -streamerDir;
    // Start at the panel edge (with small inset) — not outside.
    const startX = dir > 0 ? 4 : (canvas.clientWidth - 4);
    // Hue: low bands cyan, high bands magenta
    const hue = 195 + (b / (N - 1)) * 130;
    streamers.push({
      x: startX,
      y: cy + yOff,
      vx: dir * (4 + strength * 4),
      life: 0,
      max: 50 + strength * 40,
      hue,
      len: 30 + strength * 70,
      thick: 0.8 + strength * 1.6,
    });
  }
}

function drawStreamers(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = streamers.length - 1; i >= 0; i--) {
    const s = streamers[i];
    s.life++;
    s.x += s.vx;
    const k = 1 - s.life / s.max;
    if (k <= 0) { streamers.splice(i, 1); continue; }
    const tailX = s.x - Math.sign(s.vx) * s.len;
    const grad = ctx.createLinearGradient(tailX, s.y, s.x, s.y);
    grad.addColorStop(0,   `hsla(${s.hue}, 100%, 70%, 0)`);
    grad.addColorStop(0.5, `hsla(${s.hue}, 100%, 75%, ${0.4 * k})`);
    grad.addColorStop(1,   `hsla(${s.hue}, 100%, 88%, ${0.95 * k})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = s.thick;
    ctx.shadowBlur = 6;
    ctx.shadowColor = `hsla(${s.hue}, 100%, 70%, ${0.6 * k})`;
    ctx.beginPath();
    ctx.moveTo(tailX, s.y);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  ctx.restore();
}

// Shards fire from each onset's angular position on the spectral disc.
// Band b sits at angle = -π/2 + b/N · 2π (clockwise from top).
function spawnOnsetShards(cx, cy, radius) {
  if (!audio || !audio.getOnsetBands) return;
  const onsets = audio.getOnsetBands();
  const strengths = audio.getOnsetStrength();
  if (!onsets) return;
  const N = audio.getOnsetBandCount();

  for (let b = 0; b < N; b++) {
    if (!onsets[b]) continue;
    const strength = strengths ? strengths[b] : 0.5;
    const baseAng = -Math.PI / 2 + (b / N) * Math.PI * 2;
    const burst = 2 + Math.floor(strength * 4);
    const hue = 195 + (b / (N - 1)) * 130;
    for (let k = 0; k < burst; k++) {
      // Spread bursts narrowly around the band's angle.
      const ang = baseAng + (Math.sin(k * 13.37) * 0.18);
      const startR = radius * 0.85;
      const x = cx + Math.cos(ang) * startR * X_SCALE;
      const y = cy + Math.sin(ang) * startR * Y_SCALE;
      const speed = 1.2 + strength * 2.4;
      scanTicks.push({
        x, y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        life: 0,
        max: 22 + strength * 24,
        hue,
      });
    }
  }
}

function drawScanTicks(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = scanTicks.length - 1; i >= 0; i--) {
    const t = scanTicks[i];
    t.life++;
    t.x += t.vx;
    t.y += t.vy;
    const k = 1 - t.life / t.max;
    if (k <= 0) { scanTicks.splice(i, 1); continue; }
    ctx.strokeStyle = `hsla(${t.hue}, 100%, 70%, ${0.4 * k})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(t.x - t.vx * 4, t.y - t.vy * 4);
    ctx.stroke();
  }
  ctx.restore();
}

// Small bright diamond outline + crosshair at the dead center.
function drawDiamondCore(ctx, cx, cy, bass, rms) {
  const size = 16 + bass * 18 + rms * 8;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = `rgba(220, 250, 255, ${0.5 + bass * 0.5})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx + size, cy);
  ctx.lineTo(cx, cy + size);
  ctx.lineTo(cx - size, cy);
  ctx.closePath();
  ctx.stroke();

  ctx.strokeStyle = `rgba(255, 80, 220, ${0.3 + bass * 0.7})`;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size * 0.5);
  ctx.lineTo(cx + size * 0.5, cy);
  ctx.lineTo(cx, cy + size * 0.5);
  ctx.lineTo(cx - size * 0.5, cy);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawCoreGlow(ctx, cx, cy, bass) {
  const intensity = 0.35 + bass * 0.7;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 110);
  grad.addColorStop(0,   `rgba(255, 80, 220, ${intensity * 0.85})`);
  grad.addColorStop(0.4, `rgba(34, 230, 255, ${intensity * 0.30})`);
  grad.addColorStop(1,   'rgba(34, 230, 255, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 110, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function updateDataLabels(now, rms) {
  if (!dataPeak || now - lastStatsAt < 100) return;
  lastStatsAt = now;
  if (!audio || !audio.getPeakDb) return;

  const peakDb = audio.getPeakDb();
  const f0 = audio.getDominantFreq();
  const balance = audio.getStereoBalance();

  dataPeak.textContent = isFinite(peakDb) ? `${peakDb.toFixed(1)} dB` : '-INF dB';

  if (f0 < 1) {
    dataF0.textContent = '---- Hz';
  } else if (f0 >= 1000) {
    dataF0.textContent = `${(f0 / 1000).toFixed(2)} kHz`;
  } else {
    dataF0.textContent = `${Math.round(f0)} Hz`;
  }

  dataFft.textContent = `${audio.getFftSize()} / ${audio.getBinCount()}`;

  const left  = Math.round((1 - (balance + 1) / 2) * 100);
  const right = 100 - left;
  dataStereo.textContent = `L ${String(left).padStart(2, '0')}  R ${String(right).padStart(2, '0')}`;

  dataRms.textContent = rms.toFixed(3);
}
