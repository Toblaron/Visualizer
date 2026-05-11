// WAVEFORM SYNC / VECTORSCOPE — toggle with V key or panel double-click.
import { sizeCanvas, clear } from './_canvas.js';

let canvas, audio;
let viewMode = 'WAVEFORM'; // 'WAVEFORM' | 'SCOPE'
const beatPulses = [];
const PULSE_LIFE = 800;

// Per-mode trail for vectorscope persistence
const SCOPE_TRAIL = 3;
let scopeFrames = []; // ring of Float32Array pairs

export function init(c, a) {
  canvas = c;
  audio = a;

  // Double-click title label toggles mode
  const panel = canvas.closest('[data-panel]');
  if (panel) {
    const title = panel.querySelector('.panel-title');
    if (title) {
      title.style.cursor = 'pointer';
      title.title = 'Double-click to toggle Vectorscope';
      title.addEventListener('dblclick', toggleView);
    }
  }
}

export function toggleView() {
  viewMode = viewMode === 'WAVEFORM' ? 'SCOPE' : 'WAVEFORM';
  const panel = canvas.closest('[data-panel]');
  if (panel) {
    const title = panel.querySelector('.panel-title');
    if (title) title.textContent = viewMode === 'SCOPE' ? 'VECTORSCOPE' : 'WAVEFORM SYNC';
  }
}

export function getViewMode() { return viewMode; }

export function render(now) {
  const { ctx, w, h } = sizeCanvas(canvas);
  clear(ctx, w, h);

  if (!audio || !audio.getTimeData) return;

  if (viewMode === 'SCOPE') {
    renderScope(ctx, w, h);
  } else {
    renderWaveform(ctx, w, h, now);
  }
}

function renderWaveform(ctx, w, h, now) {
  const cy = h / 2;
  const tL   = audio.getTimeDataL ? audio.getTimeDataL() : null;
  const tR   = audio.getTimeDataR ? audio.getTimeDataR() : null;
  const tMix = audio.getTimeData();

  ctx.strokeStyle = 'rgba(34, 230, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, cy + 0.5); ctx.lineTo(w, cy + 0.5); ctx.stroke();

  drawBeatPulses(ctx, w, h, now);
  if (audio.didBeatFire && audio.didBeatFire()) beatPulses.push({ startedAt: now });

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (tL) drawTrace(ctx, tL, w, cy, h, 'rgba(34, 230, 255, 0.85)', 1.2, 12);
  if (tR) drawTrace(ctx, tR, w, cy, h, 'rgba(255, 58, 214, 0.80)', 1.2, 12);

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(220, 250, 255, 0.65)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < tMix.length; i += 2) {
    const x = (i / (tMix.length - 1)) * w;
    const y = cy + ((tMix[i] - 128) / 128) * (h * 0.42);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Peak dots
  ctx.fillStyle = 'rgba(255, 58, 214, 0.85)';
  for (let i = 8; i < tMix.length - 8; i += 6) {
    const v = tMix[i] - 128;
    const a = Math.abs(v);
    if (a > 60 && a >= Math.abs(tMix[i - 4] - 128) && a >= Math.abs(tMix[i + 4] - 128)) {
      const x = (i / (tMix.length - 1)) * w;
      const y = cy + (v / 128) * (h * 0.42);
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function renderScope(ctx, w, h) {
  const tL = audio.getTimeDataL ? audio.getTimeDataL() : null;
  const tR = audio.getTimeDataR ? audio.getTimeDataR() : null;
  if (!tL || !tR) return;

  const cx = w / 2, cy = h / 2;
  const scale = Math.min(w, h) * 0.44;

  // Grid: crosshair + circles
  ctx.save();
  ctx.strokeStyle = 'rgba(34, 230, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
  for (const r of [0.33, 0.66, 1.0]) {
    ctx.beginPath(); ctx.arc(cx, cy, scale * r, 0, Math.PI * 2); ctx.stroke();
  }
  // Phase lines ±45°
  ctx.strokeStyle = 'rgba(255, 58, 214, 0.06)';
  const d = scale * 1.05;
  ctx.beginPath(); ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - d, cy + d); ctx.lineTo(cx + d, cy - d); ctx.stroke();
  ctx.restore();

  // Build trail — keep last SCOPE_TRAIL frames
  const snap = new Float32Array(tL.length * 2);
  for (let i = 0; i < tL.length; i++) {
    snap[i * 2]     = (tL[i] - 128) / 128;
    snap[i * 2 + 1] = (tR[i] - 128) / 128;
  }
  scopeFrames.push(snap);
  if (scopeFrames.length > SCOPE_TRAIL) scopeFrames.shift();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let fi = 0; fi < scopeFrames.length; fi++) {
    const frame = scopeFrames[fi];
    const age = (fi + 1) / scopeFrames.length;
    const alpha = age * 0.55;
    const step = 2;
    ctx.fillStyle = `rgba(34, 230, 255, ${alpha})`;
    for (let i = 0; i < frame.length / 2; i += step) {
      const x = cx + frame[i * 2]     * scale;
      const y = cy - frame[i * 2 + 1] * scale; // invert Y for standard scope orientation
      ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    }
  }

  // Current frame brighter
  const cur = scopeFrames[scopeFrames.length - 1];
  if (cur) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (let i = 0; i < cur.length / 2; i += 4) {
      const x = cx + cur[i * 2]     * scale;
      const y = cy - cur[i * 2 + 1] * scale;
      ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
    }
  }
  ctx.restore();

  // Correlation readout
  const corr = audio.getStereoCorrelation ? audio.getStereoCorrelation() : 0;
  ctx.fillStyle = 'rgba(120, 160, 200, 0.7)';
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`CORR ${corr >= 0 ? '+' : ''}${corr.toFixed(2)}`, 6, h - 6);
}

function drawTrace(ctx, t, w, cy, h, stroke, lineW, shadow) {
  ctx.shadowBlur = shadow;
  ctx.shadowColor = stroke;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineW;
  ctx.beginPath();
  for (let i = 0; i < t.length; i++) {
    const x = (i / (t.length - 1)) * w;
    const y = cy + ((t[i] - 128) / 128) * (h * 0.42);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawBeatPulses(ctx, w, h, now) {
  ctx.save();
  for (let i = beatPulses.length - 1; i >= 0; i--) {
    const p = beatPulses[i];
    const t = (now - p.startedAt) / PULSE_LIFE;
    if (t >= 1) { beatPulses.splice(i, 1); continue; }
    const x = t * w;
    const alpha = (1 - t) * 0.55;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.shadowBlur = 6;
    ctx.shadowColor = `rgba(255, 58, 214, ${alpha * 0.8})`;
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
  }
  ctx.restore();
}
