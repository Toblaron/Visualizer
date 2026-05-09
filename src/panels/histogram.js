// AMPLITUDE HISTOGRAM — track-mapped spectrogram.
// X axis = track timeline (full duration). Each column accumulates the
// maximum spectrum it sees while the playhead sits in that time slice,
// so the panel shows the entire track's amplitude/spectrum history.
import { sizeCanvas, clear } from './_canvas.js';
import { formatTime } from '../audio/metadata.js';

const ROWS = 28;             // freq buckets, low → high
const COLS = 240;            // time slices across the full track
const Y_LABELS = ['+0', '-6', '-12', '-18', '-24', '-36', '-48'];

let canvas, audio;
let history = null;          // Float32Array[COLS * ROWS], values in 0..1
let prevCol = -1;
let prevDurationKey = -1;    // changes when a new track is loaded
// Rolling fallback bookkeeping (used only when track has no duration).
let lastRollAt = 0;

// Latest plot bounds (CSS pixels) — written by render(), read by the click handler.
let plotBounds = { x: 0, y: 0, w: 0, h: 0 };

export function init(c, a) {
  canvas = c;
  audio = a;
  history = new Float32Array(COLS * ROWS);

  canvas.style.cursor = 'pointer';
  canvas.addEventListener('click', onClickSeek);
  canvas.addEventListener('mousemove', onHover);
}

function onClickSeek(e) {
  const dur = audio.getDuration();
  if (!isFinite(dur) || dur <= 0) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const { x: px, w: pw } = plotBounds;
  if (pw <= 0) return;
  const t = Math.max(0, Math.min(1, (x - px) / pw));
  audio.seek(t * dur);
  e.stopPropagation();        // don't fire the stage play/pause click
}

function onHover(e) {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const { x: px, w: pw } = plotBounds;
  const inside = pw > 0 && x >= px && x <= px + pw;
  canvas.style.cursor = inside && audio.getDuration() > 0 ? 'pointer' : 'default';
}

export function reset() {
  history.fill(0);
  prevCol = -1;
}

export function render(now) {
  const { ctx, w, h } = sizeCanvas(canvas);
  clear(ctx, w, h);

  const padL = 56, padR = 30, padT = 6, padB = 18;
  const plotX = padL;
  const plotY = padT;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  plotBounds.x = plotX;
  plotBounds.y = plotY;
  plotBounds.w = plotW;
  plotBounds.h = plotH;

  drawChannelMeters(ctx, 6, plotY, padL - 14, plotH);

  const elapsed = audio.getElapsed();
  const duration = audio.getDuration();

  // Detect track change (duration is the most reliable cue).
  const durKey = isFinite(duration) ? Math.round(duration * 100) : 0;
  if (durKey !== prevDurationKey) {
    history.fill(0);
    prevCol = -1;
    prevDurationKey = durKey;
  }

  const trackMode = isFinite(duration) && duration > 0.1;
  let col;
  if (trackMode) {
    col = Math.min(COLS - 1, Math.max(0, Math.floor((elapsed / duration) * COLS)));
  } else {
    // Live / unknown duration → roll one column every 250ms.
    if (now - lastRollAt > 250) {
      prevCol = (prevCol + 1) % COLS;
      lastRollAt = now;
      // clear the new column so the rolling window stays clean
      const off = prevCol * ROWS;
      for (let r = 0; r < ROWS; r++) history[off + r] = 0;
    }
    col = Math.max(0, prevCol);
  }

  // Write/accumulate spectrum into the current column.
  if (audio.getFreqData && audio.state === 'playing') {
    const freq = audio.getFreqData();
    const off = col * ROWS;
    const stepIntoNewCol = trackMode && col !== prevCol;
    for (let r = 0; r < ROWS; r++) {
      const t0 = Math.pow(r / ROWS, 1.6);
      const t1 = Math.pow((r + 1) / ROWS, 1.6);
      const i0 = Math.floor(t0 * freq.length * 0.55);
      const i1 = Math.max(i0 + 1, Math.floor(t1 * freq.length * 0.55));
      let max = 0;
      for (let j = i0; j < i1 && j < freq.length; j++) if (freq[j] > max) max = freq[j];
      const v = max / 255;
      history[off + r] = stepIntoNewCol ? v : Math.max(history[off + r], v);
    }
    prevCol = col;
  }

  // Draw the spectrogram.
  const cellW = plotW / COLS;
  const cellH = plotH / ROWS;
  for (let c = 0; c < COLS; c++) {
    const off = c * ROWS;
    const px = plotX + c * cellW;
    for (let r = 0; r < ROWS; r++) {
      const v = history[off + r];
      if (v < 0.04) continue;
      const py = plotY + plotH - (r + 1) * cellH;
      const segW = Math.max(0.5, v * cellW * 1.4);
      const hue = 190 + (1 - r / ROWS) * 130;
      const alpha = 0.25 + v * 0.7;
      ctx.fillStyle = `hsla(${hue}, 95%, 60%, ${alpha})`;
      ctx.fillRect(px, py + 0.5, Math.min(segW, cellW), cellH - 1);
    }
  }

  // Faint scrim of the unseen future (right of playhead) to imply "yet to play".
  if (trackMode && col < COLS - 1) {
    const fxX = plotX + (col + 1) * cellW;
    ctx.fillStyle = 'rgba(8, 16, 36, 0.35)';
    ctx.fillRect(fxX, plotY, plotW - (col + 1) * cellW, plotH);
  }

  // Playhead marker.
  if (trackMode) {
    const phX = plotX + col * cellW + cellW * 0.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(phX + 0.5, plotY);
    ctx.lineTo(phX + 0.5, plotY + plotH);
    ctx.stroke();
  }

  drawDbAxis(ctx, plotX + plotW, plotY, padR - 6, plotH);
  drawTimeAxis(ctx, plotX, plotY + plotH + 4, plotW, duration);
}

function drawChannelMeters(ctx, x, y, w, h) {
  if (!audio || !audio.getRMSL) return;
  const l = Math.min(1, audio.getRMSL() * 1.4);
  const r = Math.min(1, audio.getRMSR() * 1.4);
  const halfW = (w - 4) / 2;
  drawMeter(ctx, x,            y, halfW, h, l);
  drawMeter(ctx, x + halfW + 4, y, halfW, h, r);
}

function drawMeter(ctx, x, y, w, h, level) {
  ctx.strokeStyle = 'rgba(34, 230, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  const fillH = level * (h - 2);
  if (fillH < 1) return;
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0,   'rgba(255, 138, 61, 0.9)');
  grad.addColorStop(0.4, 'rgba(255, 58, 214, 0.9)');
  grad.addColorStop(1,   'rgba(34, 230, 255, 0.9)');
  ctx.fillStyle = grad;
  ctx.fillRect(x + 1, y + h - 1 - fillH, w - 2, fillH);
}

function drawDbAxis(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(120, 160, 200, 0.7)';
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < Y_LABELS.length; i++) {
    const t = i / (Y_LABELS.length - 1);
    const py = y + t * h;
    ctx.fillText(Y_LABELS[i], x + 2, py);
  }
}

function drawTimeAxis(ctx, x, y, w, duration) {
  ctx.fillStyle = 'rgba(120, 160, 200, 0.7)';
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const N = 5;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const px = x + t * w;
    const label = (isFinite(duration) && duration > 0)
      ? formatTime(duration * t)
      : '--:--';
    if (i === 0)         ctx.textAlign = 'left';
    else if (i === N - 1) ctx.textAlign = 'right';
    else                  ctx.textAlign = 'center';
    ctx.fillText(label, px, y);
  }
}
