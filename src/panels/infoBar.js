// INFO BAR — TRACK / ARTIST / ELAPSED / BPM+confidence / KEY / MODE / EQ / COMP / VOLUME
import { formatTime } from '../audio/metadata.js';

const MODES = ['AUTO', 'AMBIENT PULSE', 'DEEP FIELD', 'NEON GRID', 'PHASE LOCK'];

let audio;
let modeIndex = 1;
let onModeChange = () => {};

let elTrack, elGenreTags, elElapsed, elBpm, elBpmConf, elKey, elVolume, elEq, elMode, elComp;
let elSeekBar, elSeekFill, elSeekHandle;
let elVolBar, elVolFill, elVolLabel;
let elEqLow, elEqMid, elEqHigh;

let seekDrag = null;

export function init(_canvas, a) {
  audio = a;

  elTrack     = document.getElementById('info-track');
  elGenreTags = document.getElementById('genre-tags');
  elElapsed = document.getElementById('info-elapsed');
  elBpm     = document.getElementById('info-bpm');
  elBpmConf = document.getElementById('info-bpm-conf');
  elKey     = document.getElementById('info-key');
  elVolume  = document.getElementById('info-volume');
  elEq      = document.getElementById('info-eq');
  elMode    = document.getElementById('info-mode');
  elComp    = document.getElementById('info-comp');

  elSeekBar    = document.getElementById('seek-bar');
  elSeekFill   = document.getElementById('seek-fill');
  elSeekHandle = document.getElementById('seek-handle');

  elVolBar   = document.getElementById('volume-bar');
  elVolFill  = document.getElementById('volume-fill');
  elVolLabel = document.getElementById('volume-label');

  elEqLow  = document.getElementById('eq-low');
  elEqMid  = document.getElementById('eq-mid');
  elEqHigh = document.getElementById('eq-high');

  elMode.addEventListener('click', () => {
    modeIndex = (modeIndex + 1) % MODES.length;
    elMode.textContent = MODES[modeIndex];
    onModeChange(MODES[modeIndex]);
  });

  if (elComp) {
    elComp.addEventListener('click', () => {
      const enabled = !(audio.isCompressorEnabled && audio.isCompressorEnabled());
      if (audio.setCompressor) audio.setCompressor(enabled);
      elComp.classList.toggle('active', enabled);
      elComp.textContent = enabled ? 'COMP ON' : 'COMP OFF';
    });
  }

  // EQ band scroll/click controls
  bindEqBand(elEqLow, 'low');
  bindEqBand(elEqMid, 'mid');
  bindEqBand(elEqHigh, 'high');

  bindBar(elSeekBar, {
    canInteract: () => audio.getDuration() > 0,
    onSet: (t) => { const d = audio.getDuration(); if (d > 0) audio.seek(t * d); },
    onDragStart: (t) => { seekDrag = t; },
    onDrag: (t) => { seekDrag = t; },
    onDragEnd: () => { seekDrag = null; },
  });

  bindBar(elVolBar, {
    canInteract: () => true,
    onSet: (t) => audio.setVolume(t),
  });

  if (elVolLabel) elVolLabel.addEventListener('click', () => audio.toggleMute());
}

export function onTrackLoaded() {
  if (audio && audio.resetBpm) audio.resetBpm();
  _lastGenreKey = '';
}

export function setOnModeChange(fn) { onModeChange = fn; }
export function getCurrentMode() { return MODES[modeIndex]; }
export function setModeByName(name) {
  const idx = MODES.indexOf(name);
  if (idx >= 0) { modeIndex = idx; if (elMode) elMode.textContent = name; }
}

export function render() {
  if (!audio) return;

  const meta = audio.metadata || {};
  setText(elTrack, meta.title || '— DROP AN AUDIO FILE —');
  renderGenres(meta.genres || []);

  const elapsed = audio.getElapsed();
  const total   = audio.getDuration();
  setText(elElapsed, `${formatTime(elapsed)} / ${formatTime(total)}`);

  // Clip warning on elapsed
  if (elElapsed) elElapsed.classList.toggle('clipping', !!(audio.isClipping && audio.isClipping()));

  // BPM + confidence pips
  const bpm  = audio.getBpm ? audio.getBpm() : null;
  const conf = audio.getBpmConfidence ? audio.getBpmConfidence() : 0;
  setText(elBpm, bpm == null ? '---' : String(bpm));
  if (elBpmConf) {
    const pips = 4;
    const filled = Math.round(conf * pips);
    elBpmConf.textContent = Array.from({ length: pips }, (_, i) => i < filled ? '●' : '○').join('');
  }

  // Key
  const key = audio.getKey ? audio.getKey() : null;
  setText(elKey, key && key.name !== '---' ? key.name : '---');

  // Volume
  const muted = audio.isMuted && audio.isMuted();
  const vol   = Math.round((audio.getVolume() || 0) * 100);
  setText(elVolume, muted ? 'MUTED' : `${vol}%`);
  if (elVolFill)  elVolFill.style.width  = (muted ? 0 : vol) + '%';
  if (elVolBar)   elVolBar.classList.toggle('muted', !!muted);
  if (elVolLabel) elVolLabel.classList.toggle('muted', !!muted);

  // Seek bar
  const seekT = seekDrag != null ? seekDrag : (total > 0 ? Math.min(1, elapsed / total) : 0);
  if (elSeekFill)   elSeekFill.style.width = (seekT * 100) + '%';
  if (elSeekHandle) elSeekHandle.style.left = (seekT * 100) + '%';
  if (elSeekBar)    elSeekBar.classList.toggle('disabled', total <= 0);

  // EQ display
  const eq = audio.getEq ? audio.getEq() : { low: 0, mid: 0, high: 0 };
  updateEqLabel(elEqLow,  eq.low);
  updateEqLabel(elEqMid,  eq.mid);
  updateEqLabel(elEqHigh, eq.high);

  // EQ row label
  const anyEq = (eq.low !== 0 || eq.mid !== 0 || eq.high !== 0);
  setText(elEq, anyEq ? 'EQ ON' : (audio.state === 'playing' ? 'ACTIVE' : 'PASSIVE'));

  // Comp button state
  if (elComp) {
    const c = audio.isCompressorEnabled && audio.isCompressorEnabled();
    elComp.classList.toggle('active', c);
    elComp.textContent = c ? 'COMP ON' : 'COMP OFF';
  }
}

function updateEqLabel(el, gain) {
  if (!el) return;
  const s = gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1);
  if (el.textContent !== s) el.textContent = s;
  el.classList.toggle('eq-boosted', gain > 0.5);
  el.classList.toggle('eq-cut', gain < -0.5);
}

function bindEqBand(el, band) {
  if (!el) return;
  el.style.cursor = 'ns-resize';
  el.title = `Scroll to adjust ${band} EQ (±12dB). Double-click to reset.`;

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const eq = audio.getEq ? audio.getEq() : { low: 0, mid: 0, high: 0 };
    const delta = e.deltaY < 0 ? 0.5 : -0.5;
    eq[band] = Math.max(-12, Math.min(12, eq[band] + delta));
    if (audio.setEq) audio.setEq(eq.low, eq.mid, eq.high);
  }, { passive: false });

  el.addEventListener('dblclick', () => {
    const eq = audio.getEq ? audio.getEq() : { low: 0, mid: 0, high: 0 };
    eq[band] = 0;
    if (audio.setEq) audio.setEq(eq.low, eq.mid, eq.high);
  });
}

// Cache the last rendered genre list to avoid rebuilding DOM every frame
let _lastGenreKey = '';
function renderGenres(genres) {
  if (!elGenreTags) return;
  const key = genres.join('|');
  if (key === _lastGenreKey) return;
  _lastGenreKey = key;

  elGenreTags.innerHTML = '';
  if (genres.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'genre-empty';
    empty.textContent = '—';
    elGenreTags.appendChild(empty);
    return;
  }
  for (const g of genres) {
    const chip = document.createElement('span');
    chip.className = 'genre-chip';
    chip.textContent = g.toUpperCase();
    elGenreTags.appendChild(chip);
  }
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function bindBar(bar, opts) {
  if (!bar) return;
  let dragging = false;
  const ratio = (clientX) => {
    const r = bar.getBoundingClientRect();
    return r.width <= 0 ? 0 : Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const onDown = (e) => {
    if (opts.canInteract && !opts.canInteract()) return;
    e.preventDefault(); e.stopPropagation();
    dragging = true;
    bar.classList.add('dragging');
    const t = ratio(e.clientX);
    if (opts.onDragStart) opts.onDragStart(t);
    opts.onSet(t);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const t = ratio(e.clientX);
    if (opts.onDrag) opts.onDrag(t);
    opts.onSet(t);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    if (opts.onDragEnd) opts.onDragEnd();
  };
  bar.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  bar.addEventListener('wheel', (e) => {
    if (opts.canInteract && !opts.canInteract()) return;
    e.preventDefault();
    const fill = bar.querySelector('.bar-fill');
    const cur = fill ? parseFloat(fill.style.width) / 100 || 0 : 0;
    opts.onSet(Math.max(0, Math.min(1, cur + (e.deltaY < 0 ? 0.05 : -0.05))));
  }, { passive: false });
}
