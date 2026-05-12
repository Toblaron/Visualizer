// CENTER — full audio-reactive scene.
//   Layers (back to front): trail fade, backdrop ellipses, crosshair,
//   beat shockwaves, radial FFT bars, particle haze (with velocity +
//   spring-back + beat impulse + stereo bias), polar waveforms (cyan
//   outer / magenta inner, BPM-locked counter-rotation, beat flash),
//   onset streamers, onset shards, lightning bolts on high-freq onsets,
//   core diamond + particle explosion + glow.
// Whole scene rides a beat-driven camera shake.
import { sizeCanvas } from './_canvas.js';

const PARTICLE_COUNT = 4800;
const X_SCALE = 1.40;
const Y_SCALE = 0.85;
const WAVE_REVS = 1;

// Worst-case multiplier on `radius` from particles + audio expansion.
// Particles + spring-offset can reach ~1.85; waveform reach ~1.55. Use
// the larger so we fit at full bass + RMS.
const PEAK_EXTENT = 1.85;

const RADIAL_BARS   = 96;
const RADIAL_BAR_R0 = 0.66;   // inner radius (× radius)
const RADIAL_BAR_R1 = 0.92;   // max outer reach (× radius)

let canvas, audio;
let pAngle, pBaseR, pPhase, pAmp, pBand;
// Spring-driven displacement: each particle has an offset from base
// position with velocity & damping. Beat impulses kick outward; mid
// energy adds jitter; stereo balance biases X.
let pOffX, pOffY, pVx, pVy;

let scanTicks   = [];
let streamers   = [];
let shockwaves  = [];
let lightnings  = [];
let coreParts   = [];
let phraseFlashes = []; // { life, max, cx, cy }
let mode = 'AMBIENT PULSE';

let shakeX = 0, shakeY = 0;
let waveFlash = 0;       // 0..1, set to 1 on beat, decays per frame

let dataPeak, dataF0, dataFft, dataStereo, dataRms;
let lastStatsAt = 0;

// Adaptive mode
let autoModeTimer = 0;
let autoEffectiveMode = 'AMBIENT PULSE';

// Phrase tracking
let prevBeatFloor = 0;

// Reduced-motion flag (set from main.js)
export let reducedMotion = false;
export function setReducedMotion(v) { reducedMotion = v; }


const MODE_PARAMS = {
  'AMBIENT PULSE': {
    bass: 0.55, mid: 0.40, high: 0.30, trail: 0.20, ringPow: 1.0,
    hueBase: 188, hueSpread: 90,
    shockwave: 0.8, radialBars: 0.7, lightning: 0.3, shake: 0.3,
    beatKick: 0.8, coreBurst: 0.7,
  },
  // AUTO uses resolveParams() to pick a real mode dynamically
  'AUTO': {
    bass: 0.55, mid: 0.40, high: 0.30, trail: 0.20, ringPow: 1.0,
    hueBase: 188, hueSpread: 90,
    shockwave: 0.8, radialBars: 0.7, lightning: 0.3, shake: 0.3,
    beatKick: 0.8, coreBurst: 0.7,
  },
  'DEEP FIELD': {
    bass: 0.85, mid: 0.20, high: 0.55, trail: 0.10, ringPow: 0.7,
    hueBase: 220, hueSpread: 120,
    shockwave: 1.4, radialBars: 0.4, lightning: 0.4, shake: 0.15,
    beatKick: 1.2, coreBurst: 1.2,
  },
  'NEON GRID': {
    bass: 0.30, mid: 0.70, high: 0.40, trail: 0.28, ringPow: 1.4,
    hueBase: 280, hueSpread: 60,
    shockwave: 0.4, radialBars: 1.4, lightning: 1.6, shake: 0.7,
    beatKick: 0.5, coreBurst: 0.5,
  },
  'PHASE LOCK': {
    bass: 0.65, mid: 0.55, high: 0.20, trail: 0.18, ringPow: 1.0,
    hueBase: 165, hueSpread: 40,
    shockwave: 0.7, radialBars: 0.8, lightning: 0.2, shake: 1.0,
    beatKick: 1.4, coreBurst: 1.0,
  },
};

export function init(c, a) {
  canvas = c;
  audio = a;
  pAngle = new Float32Array(PARTICLE_COUNT);
  pBaseR = new Float32Array(PARTICLE_COUNT);
  pPhase = new Float32Array(PARTICLE_COUNT);
  pAmp   = new Float32Array(PARTICLE_COUNT);
  pBand  = new Float32Array(PARTICLE_COUNT);
  pOffX  = new Float32Array(PARTICLE_COUNT);
  pOffY  = new Float32Array(PARTICLE_COUNT);
  pVx    = new Float32Array(PARTICLE_COUNT);
  pVy    = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    pAngle[i] = Math.random() * Math.PI * 2;
    pBaseR[i] = 0.30 + Math.random() * 0.65;
    pPhase[i] = Math.random() * Math.PI * 2;
    pAmp[i]   = 0.20 + Math.random() * 0.80;
    pBand[i]  = Math.random();
  }

  dataPeak   = document.getElementById('data-peak');
  dataF0     = document.getElementById('data-f0');
  dataFft    = document.getElementById('data-fft');
  dataStereo = document.getElementById('data-stereo');
  dataRms    = document.getElementById('data-rms');
}

export function setMode(m) { mode = m; }

function resolveParams(bass, mid, high, now) {
  if (mode !== 'AUTO') return MODE_PARAMS[mode] || MODE_PARAMS['AMBIENT PULSE'];
  // Recompute effective auto-mode every 4 seconds
  if (now - autoModeTimer > 4000) {
    autoModeTimer = now;
    const flat = audio && audio.getSpectralFlatness ? audio.getSpectralFlatness() : 0;
    if (bass > 0.45 && flat < 0.25)        autoEffectiveMode = 'DEEP FIELD';
    else if (flat > 0.45 || high > 0.40)   autoEffectiveMode = 'NEON GRID';
    else if (mid > 0.35 && bass < 0.28)    autoEffectiveMode = 'PHASE LOCK';
    else                                    autoEffectiveMode = 'AMBIENT PULSE';
  }
  return MODE_PARAMS[autoEffectiveMode] || MODE_PARAMS['AMBIENT PULSE'];
}

export function render(now) {
  const { ctx, w, h } = sizeCanvas(canvas);
  let bass = 0, mid = 0, high = 0;
  if (audio && audio.getBands) { const b = audio.getBands(); bass = b.bass; mid = b.mid; high = b.high; }
  const params = resolveParams(bass, mid, high, now);

  // Trail fade — applied without the shake transform so the trail covers
  // the full canvas regardless of how far we shift the scene.
  ctx.save();
  ctx.fillStyle = `rgba(5, 10, 24, ${params.trail})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const cx = w / 2;
  const cy = h / 2;
  const margin = 6;
  const fitX = (w / 2 - margin) / (X_SCALE * PEAK_EXTENT);
  const fitY = (h / 2 - margin) / (Y_SCALE * PEAK_EXTENT);
  const radius = Math.min(fitX, fitY);

  let rms = 0, stereo = 0;
  if (audio && audio.getBands) {
    rms    = audio.getRMS();
    stereo = audio.getStereoBalance ? audio.getStereoBalance() : 0;
  }
  const didBeat = audio && audio.didBeatFire ? audio.didBeatFire() : false;

  // Phrase boundary — every 16 beats, spawn a large accent shockwave
  if (didBeat && audio && audio.getContinuousBeats) {
    const beatFloor = Math.floor(audio.getContinuousBeats());
    if (beatFloor > prevBeatFloor && beatFloor % 16 === 0) {
      spawnPhraseMarker(cx, cy, bass, params);
    }
    prevBeatFloor = beatFloor;
  }

  // Camera shake — decay every frame, kick on each beat.
  shakeX *= 0.82;
  shakeY *= 0.82;
  if (didBeat && !reducedMotion) {
    const k = 9 * params.shake * (0.4 + bass * 1.6);
    shakeX += (Math.random() - 0.5) * k;
    shakeY += (Math.random() - 0.5) * k * 0.6;
  }

  if (didBeat) waveFlash = 1;
  waveFlash *= 0.86;

  if (didBeat && params.shockwave > 0)        spawnShockwave(bass, high, params);
  if (didBeat && bass > 0.16 && params.coreBurst > 0) spawnCoreExplosion(bass, params);
  spawnLightningOnHighOnsets(cx, cy, radius, params);

  // Update particle physics once per frame, before drawing.
  updateParticles(bass, mid, high, stereo, didBeat, params);

  // Wrap the audio-reactive layers in the shake transform.
  ctx.save();
  ctx.translate(shakeX, shakeY);

  drawBackdropRings(ctx, cx, cy, radius);
  drawCrosshair(ctx, cx, cy, radius);
  drawShockwaves(ctx, cx, cy, radius);
  drawRadialBars(ctx, cx, cy, radius, params);
  drawParticles(ctx, cx, cy, radius, now, bass, mid, high, rms, params);

  let rotOuter = 0, rotInner = 0;
  if (audio && audio.getContinuousBeats) {
    const beats = audio.getContinuousBeats();
    rotOuter =  beats * (Math.PI / 2);
    rotInner = -beats * (Math.PI / 2) + 0.18;
  }
  const beatPhase = audio && audio.getBeatPhase ? audio.getBeatPhase() : 0;
  const beatKick  = Math.max(0, 1 - beatPhase * 4) * 0.06;

  drawPolarWaveform(ctx, cx, cy, radius, bass, mid, high, rms,
    rotOuter, 0.95 + beatKick, 188,
    0.85 + waveFlash * 0.15, 1.2 + waveFlash * 1.6);
  drawPolarWaveform(ctx, cx, cy, radius, bass, mid, high, rms,
    rotInner, 0.62 + beatKick * 0.6, 320,
    0.75 + waveFlash * 0.20, 1.0 + waveFlash * 1.3);

  spawnOnsetStreamers(cx, cy, radius);
  drawStreamers(ctx);

  spawnOnsetShards(cx, cy, radius);
  drawScanTicks(ctx);

  drawLightnings(ctx);
  drawPhraseFlashes(ctx, cx, cy);
  drawCoreParticles(ctx, cx, cy);
  drawDiamondCore(ctx, cx, cy, bass, rms, waveFlash);
  drawCoreGlow(ctx, cx, cy, bass, waveFlash);

  ctx.restore();

  updateDataLabels(now, rms);
}

// ============================================================
// Backdrop / crosshair (static)
// ============================================================
function drawBackdropRings(ctx, cx, cy, radius) {
  ctx.save();
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

// ============================================================
// Phrase markers — accent ring every 16 beats
// ============================================================
function spawnPhraseMarker(cx, cy, bass, params) {
  phraseFlashes.push({ life: 0, max: 80, cx, cy, hue: (audio && audio.themeHue) ? audio.themeHue : 55 });
}

function drawPhraseFlashes(ctx, cx, cy) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = phraseFlashes.length - 1; i >= 0; i--) {
    const p = phraseFlashes[i];
    p.life++;
    const k = 1 - p.life / p.max;
    if (k <= 0) { phraseFlashes.splice(i, 1); continue; }
    const r = 20 + (1 - k) * 180;
    ctx.strokeStyle = `hsla(${p.hue}, 100%, 75%, ${k * k * 0.7})`;
    ctx.lineWidth = 3 * k;
    ctx.shadowBlur = 20 * k;
    ctx.shadowColor = `hsla(${p.hue}, 100%, 65%, ${k})`;
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ============================================================
// Shockwaves — beat-driven expanding rings
// ============================================================
function spawnShockwave(bass, high, params) {
  const intensity = (0.4 + bass * 1.0 + high * 0.3) * params.shockwave;
  if (intensity < 0.05) return;
  shockwaves.push({
    life: 0,
    max: 55 + bass * 25,
    intensity,
    hue: 188 + high * 60,
  });
}

function drawShockwaves(ctx, cx, cy, radius) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const s = shockwaves[i];
    s.life++;
    const k = 1 - s.life / s.max;
    if (k <= 0) { shockwaves.splice(i, 1); continue; }

    // Expand from 0.35× radius outward to ~1.7× — past the outer ring.
    const r = radius * (0.35 + (1 - k) * 1.35);
    const fade = k * k;
    const lineW = 1 + k * 2.6;

    ctx.strokeStyle = `hsla(${s.hue}, 100%, 78%, ${fade * 0.85 * s.intensity})`;
    ctx.lineWidth = lineW;
    ctx.shadowBlur = 10;
    ctx.shadowColor = `hsla(${s.hue}, 100%, 78%, ${fade * s.intensity})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * X_SCALE, r * Y_SCALE, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ============================================================
// Radial FFT bars — frequency content visible at a glance
// ============================================================
function getThemeHueBase(params) {
  if (audio && audio.themeHue != null) {
    // Blend theme hue into the mode's base hue (30% influence)
    return params.hueBase + (audio.themeHue - params.hueBase) * 0.3;
  }
  return params.hueBase;
}

function drawRadialBars(ctx, cx, cy, radius, params) {
  if (!audio || !audio.getFreqData) return;
  const f = audio.getFreqData();
  const fLen = f.length;
  if (params.radialBars < 0.05) return;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  const r0 = radius * RADIAL_BAR_R0;
  const reach = (RADIAL_BAR_R1 - RADIAL_BAR_R0) * params.radialBars;
  const hueBase = getThemeHueBase(params);

  for (let i = 0; i < RADIAL_BARS; i++) {
    // Log-ish mapping so bass bins don't dominate the entire ring.
    const t = i / RADIAL_BARS;
    const bin = Math.max(1, Math.floor(Math.pow(t, 1.55) * fLen * 0.78));
    const v = f[bin] / 255;
    if (v < 0.04) continue;

    const ang = -Math.PI / 2 + t * Math.PI * 2;
    const r1 = radius * (RADIAL_BAR_R0 + v * reach);

    const x0 = cx + Math.cos(ang) * r0 * X_SCALE;
    const y0 = cy + Math.sin(ang) * r0 * Y_SCALE;
    const x1 = cx + Math.cos(ang) * r1 * X_SCALE;
    const y1 = cy + Math.sin(ang) * r1 * Y_SCALE;

    const hue = hueBase + t * params.hueSpread;
    const light = 55 + v * 30;
    ctx.strokeStyle = `hsla(${hue}, 95%, ${light}%, ${0.25 + v * 0.7})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
}

// ============================================================
// Particles — base position from angle/radius, plus a spring-driven
// offset that responds to beats, mid jitter, and stereo balance.
// ============================================================
function updateParticles(bass, mid, high, stereo, didBeat, params) {
  const beatForce = didBeat ? bass * 5.5 * params.beatKick : 0;
  const stereoForce = stereo * (0.30 + mid * 0.60);
  const midJitter = mid * 0.50;
  const highJitter = high * 0.20;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    if (beatForce > 0) {
      const r = 0.4 + Math.random() * 0.6;
      pVx[i] += Math.cos(pAngle[i]) * beatForce * r;
      pVy[i] += Math.sin(pAngle[i]) * beatForce * r * 0.7;  // less Y kick
    }
    pVx[i] += stereoForce;
    pVx[i] += (Math.random() - 0.5) * midJitter;
    pVy[i] += (Math.random() - 0.5) * (midJitter + highJitter);

    // Spring back to base, plus damping.
    pVx[i] -= pOffX[i] * 0.045;
    pVy[i] -= pOffY[i] * 0.045;
    pVx[i] *= 0.93;
    pVy[i] *= 0.93;

    pOffX[i] += pVx[i];
    pOffY[i] += pVy[i];
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

    let bandV = 0, jitter = 0;
    if (f) {
      const idx = Math.floor(pBand[i] * fLen * 0.7);
      bandV = f[idx] / 255;
      const jIdx = Math.floor((pBand[i] * 0.4 + 0.55) * fLen);
      jitter = (f[jIdx] / 255) - 0.5;
    }

    const baseR = Math.pow(pBaseR[i], params.ringPow);
    const factor = 1 +
        bassMod * (0.40 + 0.30 * Math.sin(pPhase[i])) +
        midMod  * 0.55 * Math.sin(ang * 2 + t * 1.4) +
        highMod * jitter * 0.45 +
        bandV * 0.22;
    const cappedFactor = Math.min(factor, PEAK_EXTENT);
    const r = baseR * radius * cappedFactor;

    const x = cx + Math.cos(ang) * r * X_SCALE + pOffX[i];
    const y = cy + Math.sin(ang) * r * Y_SCALE + pOffY[i];

    const hue = getThemeHueBase(params) + high * params.hueSpread + bandV * 40;
    const light = 55 + bandV * 25;
    const alpha = (0.18 + bandV * 0.65 + rms * 0.35) * pAmp[i];

    ctx.fillStyle = `hsla(${hue}, 95%, ${light}%, ${Math.min(0.95, alpha)})`;
    const size = 0.7 + bandV * 1.3 + rms * 0.6;
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

// ============================================================
// Polar waveforms (cyan outer / magenta inner)
// ============================================================
function drawPolarWaveform(ctx, cx, cy, radius, bass, mid, high, rms, phase, radiusFrac, hue, alpha, lineW) {
  if (!audio || !audio.getTimeData) return;
  const t = audio.getTimeData();
  const N = t.length;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  ctx.strokeStyle = `hsla(${hue}, 100%, 65%, ${alpha * 0.45})`;
  ctx.lineWidth = lineW * 3;
  ctx.shadowBlur = 12;
  ctx.shadowColor = `hsla(${hue}, 100%, 65%, ${alpha})`;
  drawPath(ctx);

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
      const s = (t[ix] - 128) / 128;
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

// ============================================================
// Streamers — horizontal sweep on band onsets
// ============================================================
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
    const yFrac = 1 - (b + 0.5) / N;
    const yOff = (yFrac - 0.5) * radius * 1.7;
    const dir = streamerDir;
    streamerDir = -streamerDir;
    const startX = dir > 0 ? 4 : (canvas.clientWidth - 4);
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

// ============================================================
// Onset shards — short tracers fired from each band's slot
// ============================================================
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

// ============================================================
// Lightning — jagged polylines on high-frequency onsets
// ============================================================
function spawnLightningOnHighOnsets(cx, cy, radius, params) {
  if (params.lightning < 0.05) return;
  if (!audio || !audio.getOnsetBands) return;
  const onsets = audio.getOnsetBands();
  const strengths = audio.getOnsetStrength();
  if (!onsets) return;
  const N = audio.getOnsetBandCount();
  const highStart = Math.floor(N * 0.6);

  for (let b = highStart; b < N; b++) {
    if (!onsets[b]) continue;
    const strength = strengths ? strengths[b] : 0.5;
    if (strength < 0.1) continue;
    if (Math.random() > 0.4 + strength * 0.6 * params.lightning) continue;

    const ang = -Math.PI / 2 + (b / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const tx = cx + Math.cos(ang) * radius * X_SCALE * 0.95;
    const ty = cy + Math.sin(ang) * radius * Y_SCALE * 0.95;
    const segs = 8 + Math.floor(Math.random() * 6);
    const points = new Array(segs + 1);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const baseX = cx + (tx - cx) * t;
      const baseY = cy + (ty - cy) * t;
      // Jitter peaks in the middle, zero at endpoints.
      const j = (1 - Math.abs(t - 0.5) * 2) * 35 * (0.5 + strength);
      points[i] = {
        x: baseX + (Math.random() - 0.5) * j,
        y: baseY + (Math.random() - 0.5) * j,
      };
    }
    lightnings.push({
      points,
      life: 0,
      max: 10 + Math.floor(strength * 8),
      hue: 195 + (b / (N - 1)) * 130,
      thick: 0.8 + strength * 0.8,
    });
  }
}

function drawLightnings(ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = lightnings.length - 1; i >= 0; i--) {
    const l = lightnings[i];
    l.life++;
    const k = 1 - l.life / l.max;
    if (k <= 0) { lightnings.splice(i, 1); continue; }

    // Outer glow pass
    ctx.strokeStyle = `hsla(${l.hue}, 100%, 70%, ${0.30 * k})`;
    ctx.lineWidth = l.thick * 5;
    ctx.shadowBlur = 14;
    ctx.shadowColor = `hsla(${l.hue}, 100%, 70%, ${k})`;
    ctx.beginPath();
    ctx.moveTo(l.points[0].x, l.points[0].y);
    for (let j = 1; j < l.points.length; j++) ctx.lineTo(l.points[j].x, l.points[j].y);
    ctx.stroke();

    // Bright core
    ctx.strokeStyle = `hsla(${l.hue}, 100%, 95%, ${k})`;
    ctx.lineWidth = l.thick;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(l.points[0].x, l.points[0].y);
    for (let j = 1; j < l.points.length; j++) ctx.lineTo(l.points[j].x, l.points[j].y);
    ctx.stroke();
  }
  ctx.restore();
}

// ============================================================
// Core particle explosion — fires from dead-center on bass beats
// ============================================================
function spawnCoreExplosion(bass, params) {
  const strength = bass * params.coreBurst;
  const count = 10 + Math.floor(strength * 22);
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
    const speed = 1.5 + strength * 5 + Math.random() * 2.5;
    coreParts.push({
      x: 0, y: 0,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      life: 0,
      max: 28 + Math.floor(strength * 26),
      size: 1.5 + Math.random() * 1.5 + strength * 1.5,
      hue: 180 + Math.random() * 160,
    });
  }
}

function drawCoreParticles(ctx, cx, cy) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = coreParts.length - 1; i >= 0; i--) {
    const p = coreParts[i];
    p.life++;
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.95;
    p.vy *= 0.95;
    const k = 1 - p.life / p.max;
    if (k <= 0) { coreParts.splice(i, 1); continue; }

    const x = cx + p.x * X_SCALE;
    const y = cy + p.y * Y_SCALE;
    const size = p.size * (0.5 + k * 0.8);

    ctx.fillStyle = `hsla(${p.hue}, 100%, 80%, ${k * 0.95})`;
    ctx.shadowBlur = 8;
    ctx.shadowColor = `hsla(${p.hue}, 100%, 70%, ${k})`;
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
  }
  ctx.restore();
}

// ============================================================
// Core diamond + glow — anchor at center
// ============================================================
function drawDiamondCore(ctx, cx, cy, bass, rms, waveFlash) {
  const size = 16 + bass * 22 + rms * 8 + waveFlash * 6;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = `rgba(220, 250, 255, ${0.5 + bass * 0.5 + waveFlash * 0.3})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx + size, cy);
  ctx.lineTo(cx, cy + size);
  ctx.lineTo(cx - size, cy);
  ctx.closePath();
  ctx.stroke();

  ctx.strokeStyle = `rgba(255, 80, 220, ${0.3 + bass * 0.7 + waveFlash * 0.3})`;
  ctx.beginPath();
  ctx.moveTo(cx, cy - size * 0.5);
  ctx.lineTo(cx + size * 0.5, cy);
  ctx.lineTo(cx, cy + size * 0.5);
  ctx.lineTo(cx - size * 0.5, cy);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawCoreGlow(ctx, cx, cy, bass, waveFlash) {
  const intensity = 0.35 + bass * 0.7 + waveFlash * 0.25;
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

// ============================================================
// Live data labels (top-left/right and bottom corners)
// ============================================================
function updateDataLabels(now, rms) {
  if (!dataPeak || now - lastStatsAt < 100) return;
  lastStatsAt = now;
  if (!audio || !audio.getPeakDb) return;

  const peakDb = audio.getPeakDb();
  const f0 = audio.getDominantFreq();
  const balance = audio.getStereoBalance();

  dataPeak.textContent = isFinite(peakDb) ? `${peakDb.toFixed(1)} dB` : '-INF dB';
  dataPeak.classList.toggle('data-clip', audio.isClipping && audio.isClipping());

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
