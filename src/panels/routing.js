// AUDIO ROUTING / CHROMAGRAM — double-click panel title to toggle views.
import { sizeCanvas, clear } from './_canvas.js';

let canvas, audio;
let statusDots = [];
let viewMode = 'ROUTING'; // 'ROUTING' | 'CHROMA'

const HEX_COUNT = 11;
const flashDecay = new Float32Array(HEX_COUNT);
const HEX_TO_BAND = [0,1,2,3,4,5,6,7,8,9,10];
const STATUS_GROUPS = [[0,1,2],[3,4,5,6,7],[8,9,10]];
const statusFlash = new Float32Array(3);

// Precompute center-frequency labels for each of the 11 log-spaced bands.
// Matches the same 20 Hz–20 kHz log grid used by getMultiBands().
const BAND_FREQ_LABELS = (() => {
  const N = HEX_COUNT;
  const logMin = Math.log2(20), logMax = Math.log2(20000);
  return Array.from({ length: N }, (_, b) => {
    const f0 = Math.pow(2, logMin + (b / N) * (logMax - logMin));
    const f1 = Math.pow(2, logMin + ((b + 1) / N) * (logMax - logMin));
    const fc = Math.sqrt(f0 * f1); // geometric mean = perceptual center
    if (fc >= 10000) return `${Math.round(fc / 1000)}k`;
    if (fc >= 1000)  return `${(fc / 1000).toFixed(1)}k`;
    return `${Math.round(fc)}`;
  });
})();

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
// Smooth chromagram for display
const chromaSmooth = new Float32Array(12);

export function init(c, a) {
  canvas = c;
  audio = a;
  statusDots = [
    document.querySelector('.status-dot[data-status="0"]'),
    document.querySelector('.status-dot[data-status="1"]'),
    document.querySelector('.status-dot[data-status="2"]'),
  ];

  const panel = canvas.closest('[data-panel]');
  if (panel) {
    const title = panel.querySelector('.panel-title');
    if (title) {
      title.style.cursor = 'pointer';
      title.title = 'Double-click to toggle Chromagram';
      title.addEventListener('dblclick', toggleView);
    }
  }
}

export function toggleView() {
  viewMode = viewMode === 'ROUTING' ? 'CHROMA' : 'ROUTING';
  const panel = canvas.closest('[data-panel]');
  if (panel) {
    const title = panel.querySelector('.panel-title');
    if (title) title.textContent = viewMode === 'CHROMA' ? 'CHROMAGRAM' : 'AUDIO ROUTING';
  }
}

export function render() {
  const { ctx, w, h } = sizeCanvas(canvas);
  clear(ctx, w, h);

  if (viewMode === 'CHROMA') {
    renderChroma(ctx, w, h);
  } else {
    renderRouting(ctx, w, h);
  }
}

function renderChroma(ctx, w, h) {
  const chroma = audio && audio.getChromagram ? audio.getChromagram() : null;
  const key    = audio && audio.getKey        ? audio.getKey()        : null;
  if (!chroma) return;

  // Smooth display chroma
  for (let i = 0; i < 12; i++) {
    chromaSmooth[i] = chromaSmooth[i] * 0.82 + chroma[i] * 0.18;
  }

  const cx = w / 2, cy = h / 2;
  const outerR = Math.min(w, h) * 0.40;
  const innerR = outerR * 0.38;

  // Key name in center
  if (key && key.name !== '---') {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.floor(outerR * 0.32)}px "Orbitron", sans-serif`;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + key.confidence * 0.5})`;
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(34, 230, 255, 0.8)';
    ctx.fillText(key.name, cx, cy - outerR * 0.05);
    ctx.font = `9px "Share Tech Mono", monospace`;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(120, 160, 200, 0.7)';
    ctx.fillText(key.mode.toUpperCase(), cx, cy + outerR * 0.22);
    ctx.restore();
  }

  // 12 segments (bars + labels)
  for (let i = 0; i < 12; i++) {
    const ang = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const angW = (Math.PI * 2) / 12;
    const v = chromaSmooth[i];
    const barR = innerR + v * (outerR - innerR);
    const isRoot = key && key.root === i;
    const hue = 188 + (i / 12) * 260;

    ctx.save();
    // Bar arc
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, ang - angW * 0.38, ang + angW * 0.38);
    ctx.arc(cx, cy, barR,   ang + angW * 0.38, ang - angW * 0.38, true);
    ctx.closePath();
    ctx.fillStyle = isRoot
      ? `hsla(${hue}, 100%, 65%, ${0.3 + v * 0.7})`
      : `hsla(${hue}, 80%,  55%, ${0.15 + v * 0.6})`;
    if (isRoot) { ctx.shadowBlur = 14; ctx.shadowColor = `hsla(${hue}, 100%, 65%, 0.9)`; }
    ctx.fill();
    ctx.restore();

    // Note label around outer ring
    const labelR = outerR + 12;
    const lx = cx + Math.cos(ang) * labelR;
    const ly = cy + Math.sin(ang) * labelR;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${isRoot ? 'bold ' : ''}9px "Share Tech Mono", monospace`;
    ctx.fillStyle = isRoot
      ? `hsla(${hue}, 100%, 75%, 1.0)`
      : 'rgba(120, 160, 200, 0.55)';
    ctx.fillText(NOTE_NAMES[i], lx, ly);
    ctx.restore();
  }

  // Inner ring outline
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(34, 230, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function renderRouting(ctx, w, h) {
  const margin = 5;
  const cx = w * 0.58;
  const cy = h * 0.50;
  const rRight = (w - cx - margin) / 4;
  const rLeft  = (cx - margin) / 4;
  const rTop   = (cy - margin) / 2.73;
  const rBot   = (h - cy - margin) / 4.46;
  const r = Math.max(8, Math.min(rRight, rLeft, rTop, rBot));

  const bands    = audio && audio.getMultiBands ? audio.getMultiBands(HEX_COUNT) : null;
  const onsets   = audio && audio.getOnsetBands ? audio.getOnsetBands() : null;
  const strengths = audio && audio.getOnsetStrength ? audio.getOnsetStrength() : null;

  for (let i = 0; i < HEX_COUNT; i++) {
    flashDecay[i] = Math.max(0, flashDecay[i] - 0.08);
    const bandIdx = HEX_TO_BAND[i];
    if (onsets && onsets[bandIdx]) {
      flashDecay[i] = Math.max(flashDecay[i], 0.6 + (strengths ? strengths[bandIdx] * 0.4 : 0));
    }
  }

  const positions = [];
  positions.push([cx, cy]);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
    positions.push([cx + Math.cos(ang) * r * Math.sqrt(3), cy + Math.sin(ang) * r * Math.sqrt(3)]);
  }
  const outerAngles = [0, 1, 3, 5];
  for (const i of outerAngles) {
    const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
    positions.push([cx + Math.cos(ang) * r * 2 * Math.sqrt(3), cy + Math.sin(ang) * r * 2 * Math.sqrt(3)]);
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(34, 230, 255, 0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 7; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(positions[i][0], positions[i][1]);
    ctx.stroke();
  }
  ctx.restore();

  for (let i = 0; i < HEX_COUNT; i++) {
    const [x, y] = positions[i];
    const bandIdx = HEX_TO_BAND[i];
    const energy = bands ? bands[bandIdx] : 0;
    drawHex(ctx, x, y, r, energy, flashDecay[i], bandIdx);
  }

  updateStatusDots(onsets);
}

function drawHex(ctx, x, y, r, energy, flash, bandIdx) {
  energy = Math.max(0, Math.min(1, energy));
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const hue = 195 - (bandIdx / (HEX_COUNT - 1)) * 35 + flash * 60;
  ctx.fillStyle = `hsla(${hue}, 90%, ${22 + energy * 28 + flash * 20}%, ${0.16 + energy * 0.45 + flash * 0.30})`;
  ctx.fill();
  ctx.strokeStyle = `hsla(${hue}, 100%, ${50 + energy * 25 + flash * 25}%, ${0.45 + energy * 0.45 + flash * 0.4})`;
  ctx.lineWidth = 1 + energy * 1.4 + flash * 1.5;
  ctx.shadowBlur = energy * 8 + flash * 14;
  ctx.shadowColor = ctx.strokeStyle;
  ctx.stroke();
  const di = Math.max(energy, flash);
  if (di > 0.15) {
    ctx.beginPath();
    ctx.arc(x, y - r * 0.45, 1.5 + di * 1.8, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(220, 250, 255, ${0.4 + di * 0.6})`;
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Live dB level for this band — updates every frame
  const db = energy > 0.001 ? Math.round(20 * Math.log10(energy)) : null;
  const dbStr = db !== null ? String(Math.max(-60, db)) : '—';
  const textAlpha = Math.max(0.28, Math.min(0.95, 0.30 + energy * 1.3 + flash * 0.4));
  ctx.fillStyle = `rgba(210, 235, 255, ${textAlpha})`;
  ctx.font = `bold ${Math.max(6, Math.round(r * 0.42))}px "Share Tech Mono", monospace`;
  ctx.fillText(dbStr, x, y + r * 0.12);

  // Center-frequency label — fixed identifier for this band
  ctx.fillStyle = `rgba(120, 160, 200, ${0.28 + flash * 0.20})`;
  ctx.font = `${Math.max(5, Math.round(r * 0.30))}px "Share Tech Mono", monospace`;
  ctx.fillText(BAND_FREQ_LABELS[bandIdx], x, y + r * 0.68);

  ctx.restore();
}

function updateStatusDots(onsets) {
  for (let g = 0; g < STATUS_GROUPS.length; g++) {
    statusFlash[g] = Math.max(0, statusFlash[g] - 0.05);
    if (onsets) { for (const b of STATUS_GROUPS[g]) { if (onsets[b]) { statusFlash[g] = 1; break; } } }
    const dot = statusDots[g];
    if (!dot) continue;
    if (statusFlash[g] > 0.4) dot.classList.add('hot');
    else dot.classList.remove('hot');
  }
}
