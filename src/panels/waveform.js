// WAVEFORM SYNC — stereo time-domain overlay (cyan = L, magenta = R)
// + magenta peak speckle. Beat ticks fade across when a beat fires.
import { sizeCanvas, clear } from './_canvas.js';

let canvas, audio;
const beatPulses = [];      // { startedAt, x } — short flashes on beat fires

export function init(c, a) {
  canvas = c;
  audio = a;
}

export function render(now) {
  const { ctx, w, h } = sizeCanvas(canvas);
  clear(ctx, w, h);

  if (!audio || !audio.getTimeData) return;

  const cy = h / 2;
  const tL = audio.getTimeDataL ? audio.getTimeDataL() : null;
  const tR = audio.getTimeDataR ? audio.getTimeDataR() : null;
  const tMix = audio.getTimeData();

  // Faint center line
  ctx.strokeStyle = 'rgba(34, 230, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cy + 0.5);
  ctx.lineTo(w, cy + 0.5);
  ctx.stroke();

  // Beat pulses — vertical flashes that walk across as they age.
  drawBeatPulses(ctx, w, h, now);

  // Track new beats
  if (audio.didBeatFire && audio.didBeatFire()) {
    beatPulses.push({ startedAt: now });
  }

  // Stereo traces — cyan L underneath, magenta R on top, then bright mix line.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  if (tL) drawTrace(ctx, tL, w, cy, h, 'rgba(34, 230, 255, 0.85)', 1.2, 12);
  if (tR) drawTrace(ctx, tR, w, cy, h, 'rgba(255, 58, 214, 0.80)', 1.2, 12);

  // Bright core trace from the mono mix for definition
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

  // Magenta peak dots from the mix
  ctx.fillStyle = 'rgba(255, 58, 214, 0.85)';
  for (let i = 8; i < tMix.length - 8; i += 6) {
    const v = tMix[i] - 128;
    const a = Math.abs(v);
    if (a > 60 && a >= Math.abs(tMix[i - 4] - 128) && a >= Math.abs(tMix[i + 4] - 128)) {
      const x = (i / (tMix.length - 1)) * w;
      const y = cy + (v / 128) * (h * 0.42);
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
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

// Beat pulses: each pulse appears on beat-fire, then sweeps from left to
// right across the panel over PULSE_LIFE ms while fading out. Several can
// be on screen at once; they form a visible BPM grid.
const PULSE_LIFE = 800;
function drawBeatPulses(ctx, w, h, now) {
  ctx.save();
  for (let i = beatPulses.length - 1; i >= 0; i--) {
    const p = beatPulses[i];
    const t = (now - p.startedAt) / PULSE_LIFE;
    if (t >= 1) { beatPulses.splice(i, 1); continue; }
    const x = t * w;                        // sweep left → right
    const alpha = (1 - t) * 0.55;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.shadowBlur = 6;
    ctx.shadowColor = `rgba(255, 58, 214, ${alpha * 0.8})`;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  ctx.restore();
}
