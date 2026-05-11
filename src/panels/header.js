// HEADER — song progress bar with decoded waveform overview behind it.
// Click/drag to seek. Beat-flash on elapsed label. A/B loop region tinted.
import { formatTime } from '../audio/metadata.js';

let audio = null;
let elContainer, elBar, elFill, elHandle, elElapsed, elTotal, elOverview;
let beatFlashUntil = 0;
let seekDrag = null;

// Loop region (set from main.js)
export let loopA = null;
export let loopB = null;
export function setLoop(a, b) { loopA = a; loopB = b; }

export function init(a) {
  audio = a;
  elContainer = document.getElementById('track-progress');
  elBar       = document.getElementById('track-progress-bar');
  elFill      = document.getElementById('track-progress-fill');
  elHandle    = document.getElementById('track-progress-handle');
  elElapsed   = document.getElementById('track-time-elapsed');
  elTotal     = document.getElementById('track-time-total');
  elOverview  = document.getElementById('overview-canvas');

  bindBar();
}

export function render(now) {
  if (!audio || !elBar) return;

  const elapsed = audio.getElapsed ? audio.getElapsed() : 0;
  const total   = audio.getDuration ? audio.getDuration() : 0;
  const hasTrack = total > 0;

  const t = seekDrag != null ? seekDrag : (hasTrack ? Math.min(1, elapsed / total) : 0);

  if (elFill)   elFill.style.width = (t * 100) + '%';
  if (elHandle) elHandle.style.left = (t * 100) + '%';
  if (elBar)    elBar.classList.toggle('disabled', !hasTrack);

  const shownElapsed = seekDrag != null ? seekDrag * total : elapsed;
  setText(elElapsed, formatTime(hasTrack ? shownElapsed : 0));
  setText(elTotal,   formatTime(hasTrack ? total : 0));

  if (audio.didBeatFire && audio.didBeatFire()) beatFlashUntil = now + 110;
  if (elContainer) elContainer.classList.toggle('beat-flash', now < beatFlashUntil);

  // Clip warning on elapsed time
  if (elElapsed) elElapsed.classList.toggle('clipping', !!(audio.isClipping && audio.isClipping()));

  renderOverview(total);
}

function renderOverview(total) {
  if (!elOverview) return;
  const peaks = audio.overviewPeaks;
  const dpr = window.devicePixelRatio || 1;
  const w = elOverview.clientWidth;
  const h = elOverview.clientHeight;
  if (w < 2 || h < 2) return;

  const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
  if (elOverview.width !== pw || elOverview.height !== ph) {
    elOverview.width  = pw;
    elOverview.height = ph;
  }
  const ctx = elOverview.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!peaks) return;

  const themeHue = (audio.themeHue != null) ? audio.themeHue : 188;
  const elapsed  = audio.getElapsed ? audio.getElapsed() : 0;
  const playT    = total > 0 ? elapsed / total : 0;

  // A/B loop tint
  if (loopA !== null && loopB !== null && total > 0) {
    const lax = (loopA / total) * w;
    const lbx = (loopB / total) * w;
    ctx.fillStyle = `hsla(${themeHue}, 90%, 55%, 0.18)`;
    ctx.fillRect(lax, 0, lbx - lax, h);
    // loop boundary lines
    ctx.strokeStyle = `hsla(${themeHue}, 100%, 65%, 0.7)`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lax + 0.5, 0); ctx.lineTo(lax + 0.5, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(lbx + 0.5, 0); ctx.lineTo(lbx + 0.5, h); ctx.stroke();
  }

  // Waveform
  const cy = h / 2;
  const { min: mn, max: mx, len: N } = peaks;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';

  // Played region (brighter)
  const playX = Math.floor(playT * w);
  for (let i = 0; i < N; i++) {
    const x = (i / N) * w;
    const xn = ((i + 1) / N) * w;
    const barW = Math.max(0.5, xn - x - 0.5);
    const loH = cy + mn[i] * (h * 0.45);
    const hiH = cy + mx[i] * (h * 0.45);
    const barH = Math.max(0.5, hiH - loH);
    const played = x < playX;
    ctx.fillStyle = played
      ? `hsla(${themeHue}, 90%, 62%, 0.8)`
      : `hsla(${themeHue}, 60%, 45%, 0.35)`;
    ctx.fillRect(x, loH, barW, barH);
  }
  ctx.restore();
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function bindBar() {
  if (!elBar) return;
  let dragging = false;
  const canInteract = () => audio && audio.getDuration && audio.getDuration() > 0;
  const ratio = (clientX) => {
    const r = elBar.getBoundingClientRect();
    return r.width <= 0 ? 0 : Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const apply = (t) => { const d = audio.getDuration(); if (d > 0) audio.seek(t * d); };

  elBar.addEventListener('mousedown', (e) => {
    if (!canInteract()) return;
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    elBar.classList.add('dragging');
    seekDrag = ratio(e.clientX);
    apply(seekDrag);
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    seekDrag = ratio(e.clientX);
    apply(seekDrag);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    elBar.classList.remove('dragging');
    seekDrag = null;
  });
  elBar.addEventListener('wheel', (e) => {
    if (!canInteract()) return;
    e.preventDefault();
    const cur = audio.getElapsed() / audio.getDuration();
    apply(Math.max(0, Math.min(1, cur + (e.deltaY < 0 ? 0.02 : -0.02))));
  }, { passive: false });
}
