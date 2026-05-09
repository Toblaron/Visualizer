// FREQUENCY SPECTRUM — 32 log-spaced vertical bars with peak ghosts.
import { sizeCanvas, clear } from './_canvas.js';

const NUM_BARS = 32;
const PEAK_DECAY = 0.45;          // px per frame
const PEAK_HOLD_MS = 600;
const Y_LABELS = [0, -6, -12, -24, -48];
const X_LABELS = ['20Hz', '40', '60', '100', '200', '300Hz', '1k', '2k', '6k', '10k', '20kHz'];

let canvas, audio;
let bands = new Float32Array(NUM_BARS);
let peaks = new Float32Array(NUM_BARS);
let peakTimes = new Float32Array(NUM_BARS);
let centroidEma = 0;

export function init(c, a) {
  canvas = c;
  audio = a;
}

export function render(now) {
  const { ctx, w, h } = sizeCanvas(canvas);
  clear(ctx, w, h);

  // Layout: leave room for left dB labels and bottom freq labels.
  const padL = 32, padR = 4, padT = 6, padB = 18;
  const plotX = padL;
  const plotY = padT;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  drawDbAxis(ctx, plotX, plotY, plotW, plotH);
  drawFreqAxis(ctx, plotX, plotY, plotW, plotH);

  if (!audio || !audio.getFreqData) return;

  const freq = audio.getFreqData();
  const nyquist = audio.getSampleRate() / 2;

  // Log buckets across 20Hz..nyquist
  const minHz = 20;
  const maxHz = Math.min(20000, nyquist);
  const logMin = Math.log2(minHz);
  const logMax = Math.log2(maxHz);

  for (let i = 0; i < NUM_BARS; i++) {
    const f0 = Math.pow(2, logMin + (i / NUM_BARS) * (logMax - logMin));
    const f1 = Math.pow(2, logMin + ((i + 1) / NUM_BARS) * (logMax - logMin));
    const i0 = Math.floor(f0 / nyquist * freq.length);
    const i1 = Math.max(i0 + 1, Math.floor(f1 / nyquist * freq.length));
    let max = 0;
    for (let j = i0; j < i1 && j < freq.length; j++) if (freq[j] > max) max = freq[j];
    const v = max / 255;
    // smooth attack
    bands[i] = bands[i] * 0.55 + v * 0.45;
  }

  const gap = 2;
  const barW = (plotW - gap * (NUM_BARS - 1)) / NUM_BARS;

  // ghost / peak bars
  for (let i = 0; i < NUM_BARS; i++) {
    const x = plotX + i * (barW + gap);
    const targetH = bands[i] * plotH;

    if (targetH > peaks[i]) {
      peaks[i] = targetH;
      peakTimes[i] = now;
    } else if (now - peakTimes[i] > PEAK_HOLD_MS) {
      peaks[i] = Math.max(0, peaks[i] - PEAK_DECAY);
    }

    // ghost (full peak) bar
    ctx.fillStyle = 'rgba(120, 70, 130, 0.20)';
    ctx.fillRect(x, plotY + plotH - peaks[i], barW, peaks[i]);
  }

  // active bars on top
  for (let i = 0; i < NUM_BARS; i++) {
    const x = plotX + i * (barW + gap);
    const targetH = bands[i] * plotH;
    if (targetH < 1) continue;
    const grad = ctx.createLinearGradient(0, plotY + plotH - targetH, 0, plotY + plotH);
    grad.addColorStop(0,    'rgba(34, 230, 255, 0.95)');
    grad.addColorStop(0.55, 'rgba(170, 90, 220, 0.95)');
    grad.addColorStop(1,    'rgba(255, 58, 214, 0.95)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, plotY + plotH - targetH, barW, targetH);
  }

  drawCentroidMarker(ctx, plotX, plotY, plotW, plotH, minHz, maxHz, logMin, logMax);
}

function drawCentroidMarker(ctx, plotX, plotY, plotW, plotH, minHz, maxHz, logMin, logMax) {
  if (!audio || !audio.getSpectralCentroid) return;
  const c = audio.getSpectralCentroid();
  if (c < minHz) {
    centroidEma *= 0.9;
    if (centroidEma < minHz) return;
  } else {
    centroidEma = centroidEma === 0 ? c : centroidEma * 0.85 + c * 0.15;
  }

  const t = (Math.log2(Math.max(minHz, centroidEma)) - logMin) / (logMax - logMin);
  if (t < 0 || t > 1) return;
  const px = plotX + t * plotW;
  const py = plotY + plotH;

  // Vertical guide line down through the bars (very faint)
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 0.5, plotY);
  ctx.lineTo(px + 0.5, py);
  ctx.stroke();

  // Triangle pointing up at the X axis
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.shadowBlur = 6;
  ctx.shadowColor = 'rgba(34, 230, 255, 0.85)';
  ctx.beginPath();
  ctx.moveTo(px,     py - 5);
  ctx.lineTo(px - 4, py + 1);
  ctx.lineTo(px + 4, py + 1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDbAxis(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(120, 160, 200, 0.7)';
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < Y_LABELS.length; i++) {
    const t = i / (Y_LABELS.length - 1);
    const py = y + t * h;
    ctx.fillText(String(Y_LABELS[i]), x - 4, py);
    ctx.strokeStyle = 'rgba(34, 230, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, py + 0.5);
    ctx.lineTo(x + w, py + 0.5);
    ctx.stroke();
  }
}

function drawFreqAxis(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(120, 160, 200, 0.7)';
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < X_LABELS.length; i++) {
    const t = i / (X_LABELS.length - 1);
    const px = x + t * w;
    ctx.fillText(X_LABELS[i], px, y + h + 4);
  }
}
