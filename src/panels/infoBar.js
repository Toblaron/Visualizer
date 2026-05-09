// INFO BAR — TRACK / ARTIST / ELAPSED / BPM / VOLUME / EQ / MODE
import { formatTime } from '../audio/metadata.js';

const MODES = ['AMBIENT PULSE', 'DEEP FIELD', 'NEON GRID', 'PHASE LOCK'];

let audio;
let modeIndex = 0;
let onModeChange = () => {};

let elTrack, elArtist, elElapsed, elBpm, elVolume, elEq, elMode;

export function init(_canvas, a) {
  audio = a;

  elTrack   = document.getElementById('info-track');
  elArtist  = document.getElementById('info-artist');
  elElapsed = document.getElementById('info-elapsed');
  elBpm     = document.getElementById('info-bpm');
  elVolume  = document.getElementById('info-volume');
  elEq      = document.getElementById('info-eq');
  elMode    = document.getElementById('info-mode');

  elMode.addEventListener('click', () => {
    modeIndex = (modeIndex + 1) % MODES.length;
    elMode.textContent = MODES[modeIndex];
    onModeChange(MODES[modeIndex]);
  });
}

export function onTrackLoaded() {
  if (audio && audio.resetBpm) audio.resetBpm();
}

export function setOnModeChange(fn) { onModeChange = fn; }

export function render(now) {
  if (!audio) return;

  const meta = audio.metadata || {};
  setText(elTrack,  meta.title  || '— DROP AN AUDIO FILE —');
  setText(elArtist, meta.artist || 'AETHER SYNC');

  const elapsed = audio.getElapsed();
  const total = audio.getDuration();
  setText(elElapsed, `${formatTime(elapsed)} / ${formatTime(total)}`);

  const trackedBpm = audio.getBpm ? audio.getBpm() : null;
  setText(elBpm, trackedBpm == null ? '---' : String(trackedBpm));

  // Volume
  const vol = Math.round((audio.getVolume() || 0) * 100);
  setText(elVolume, `${vol}%`);

  // EQ — flip to PASSIVE when nothing is playing
  setText(elEq, audio.state === 'playing' ? 'ACTIVE' : 'PASSIVE');
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}
