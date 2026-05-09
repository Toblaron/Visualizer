// AUDIO ROUTING — honeycomb topology where each of the 11 hexes is a
// distinct log-spaced frequency band. Center = sub-bass, ring of 6 = 6
// mid bands (kick, low-mid, mid, upper-mid, presence, brilliance), outer
// 4 = 4 high-frequency bands. Each hex independently glows + flashes
// when an onset fires in its band. Status dots blink on real onsets.
import { sizeCanvas, clear } from './_canvas.js';

let canvas, audio;
let statusDots = [];

// Per-hex state for layout + onset flash decay.
// Geometry is computed each frame from canvas size; flash state persists.
const HEX_COUNT = 11;
const flashDecay = new Float32Array(HEX_COUNT);

// Map of hex slot → onset-band index (we use 11 bands so it's 1:1).
// Slots 0..10 ordered: 0=center, 1..6=inner ring (clockwise), 7..10=outer ring.
const HEX_TO_BAND = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// 3 status dots correspond to summary groups of bands.
const STATUS_GROUPS = [
  [0, 1, 2],         // BASS  (lowest 3)
  [3, 4, 5, 6, 7],   // MIDS  (middle 5)
  [8, 9, 10],        // HIGH  (top 3)
];
const statusFlash = new Float32Array(3);

export function init(c, a) {
  canvas = c;
  audio = a;
  statusDots = [
    document.querySelector('.status-dot[data-status="0"]'),
    document.querySelector('.status-dot[data-status="1"]'),
    document.querySelector('.status-dot[data-status="2"]'),
  ];
}

export function render() {
  const { ctx, w, h } = sizeCanvas(canvas);
  clear(ctx, w, h);

  // Outer hexes at distance 2√3·r ≈ 3.46r. Each hex extends another r.
  // Worst case per axis:
  //   right (i=0 at 30°): cx + 3r + r = cx + 4r
  //   left  (i=3 at 210°): cx - 4r
  //   top   (i=5 at 330°): cy - 1.73r - r = cy - 2.73r
  //   bottom(i=1 at 90°):  cy + 3.46r + r = cy + 4.46r   ← longest reach
  const margin = 5;
  const cx = w * 0.58;       // slight right-bias so the status list has room
  const cy = h * 0.50;
  const rRight  = (w - cx - margin) / 4;
  const rLeft   = (cx - margin) / 4;
  const rTop    = (cy - margin) / 2.73;
  const rBot    = (h - cy - margin) / 4.46;
  const r = Math.max(8, Math.min(rRight, rLeft, rTop, rBot));

  const bands = audio && audio.getMultiBands ? audio.getMultiBands(HEX_COUNT) : null;
  const onsets = audio && audio.getOnsetBands ? audio.getOnsetBands() : null;
  const strengths = audio && audio.getOnsetStrength ? audio.getOnsetStrength() : null;

  // Decay flash buffer; reignite on a fresh onset.
  for (let i = 0; i < HEX_COUNT; i++) {
    flashDecay[i] = Math.max(0, flashDecay[i] - 0.08);
    const bandIdx = HEX_TO_BAND[i];
    if (onsets && onsets[bandIdx]) {
      flashDecay[i] = Math.max(flashDecay[i], 0.6 + (strengths ? strengths[bandIdx] * 0.4 : 0));
    }
  }

  // Layout — slot 0 = center, 1..6 = inner ring, 7..10 = outer (sparse).
  const positions = [];
  positions.push([cx, cy]);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
    positions.push([
      cx + Math.cos(ang) * r * Math.sqrt(3),
      cy + Math.sin(ang) * r * Math.sqrt(3),
    ]);
  }
  // 4 outer hexes at NW / NE / SW / SE-ish
  const outerAngles = [0, 1, 3, 5];
  for (const i of outerAngles) {
    const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
    positions.push([
      cx + Math.cos(ang) * r * 2 * Math.sqrt(3),
      cy + Math.sin(ang) * r * 2 * Math.sqrt(3),
    ]);
  }

  // Draw thin connection lines from center to each ring hex (optional)
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

  // Draw each hex with its band's energy + flash overlay.
  for (let i = 0; i < HEX_COUNT; i++) {
    const [x, y] = positions[i];
    const bandIdx = HEX_TO_BAND[i];
    const energy = bands ? bands[bandIdx] : 0;
    const flash = flashDecay[i];
    drawHex(ctx, x, y, r, energy, flash, bandIdx);
  }

  updateStatusDots(onsets);
}

function drawHex(ctx, x, y, r, energy, flash, bandIdx) {
  energy = Math.max(0, Math.min(1, energy));
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();

  // Hue trends from cyan (low bands) to magenta (high bands)
  const baseHue = 195 - (bandIdx / (HEX_COUNT - 1)) * 35;
  const hue = baseHue + flash * 60;
  const fillAlpha = 0.16 + energy * 0.45 + flash * 0.30;

  ctx.fillStyle = `hsla(${hue}, 90%, ${22 + energy * 28 + flash * 20}%, ${fillAlpha})`;
  ctx.fill();

  ctx.strokeStyle = `hsla(${hue}, 100%, ${50 + energy * 25 + flash * 25}%, ${0.45 + energy * 0.45 + flash * 0.4})`;
  ctx.lineWidth = 1 + energy * 1.4 + flash * 1.5;
  ctx.shadowBlur = energy * 8 + flash * 14;
  ctx.shadowColor = ctx.strokeStyle;
  ctx.stroke();

  // Inner core dot when energetic OR flashing
  const dotIntensity = Math.max(energy, flash);
  if (dotIntensity > 0.15) {
    ctx.beginPath();
    ctx.arc(x, y, 2 + dotIntensity * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(220, 250, 255, ${0.4 + dotIntensity * 0.6})`;
    ctx.fill();
  }

  // Tiny band index in dim gray for legibility
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(180, 220, 255, 0.35)';
  ctx.font = '7.5px "Share Tech Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(bandIdx.toString().padStart(2, '0'), x, y + r * 0.55);

  ctx.restore();
}

function updateStatusDots(onsets) {
  for (let g = 0; g < STATUS_GROUPS.length; g++) {
    statusFlash[g] = Math.max(0, statusFlash[g] - 0.05);
    if (onsets) {
      for (const b of STATUS_GROUPS[g]) {
        if (onsets[b]) { statusFlash[g] = 1; break; }
      }
    }
    const dot = statusDots[g];
    if (!dot) continue;
    if (statusFlash[g] > 0.4) dot.classList.add('hot');
    else dot.classList.remove('hot');
  }
}
