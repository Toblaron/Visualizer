// Bootstrap: wire engine + panels, drag-drop file zone, single RAF loop.

import { audio } from './audio/engine.js';
import * as header    from './panels/header.js';
import * as spectrum  from './panels/spectrum.js';
import * as histogram from './panels/histogram.js';
import * as waveform  from './panels/waveform.js';
import * as routing   from './panels/routing.js';
import * as center    from './panels/center.js';
import * as infoBar   from './panels/infoBar.js';

const $canvas = (name) => document.querySelector(`canvas[data-canvas="${name}"]`);

function boot() {
  header.init();
  spectrum.init($canvas('spectrum'),   audio);
  histogram.init($canvas('histogram'), audio);
  waveform.init($canvas('waveform'),   audio);
  routing.init($canvas('routing'),     audio);
  center.init($canvas('center'),       audio);
  infoBar.init(null, audio);
  infoBar.setOnModeChange((m) => center.setMode(m));

  setupFileDropZone();
  setupKeyboard();
  setupVolumeWheel();

  let lastT = performance.now();
  function frame(now) {
    audio.tick();
    header.render(now);
    spectrum.render(now);
    histogram.render(now);
    waveform.render(now);
    routing.render(now);
    center.render(now);
    infoBar.render(now);
    lastT = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function setupFileDropZone() {
  const overlay = document.getElementById('drop-overlay');
  const input = document.getElementById('file-input');
  const stage = document.querySelector('.stage');

  let dragDepth = 0;

  document.addEventListener('dragenter', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.classList.add('visible');
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFile(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.remove('visible');
  });
  document.addEventListener('drop', async (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('visible');
    const file = e.dataTransfer.files[0];
    if (file) await loadFile(file);
  });

  // Click on the track field opens the file picker.
  document.getElementById('info-track').addEventListener('click', () => input.click());
  document.getElementById('info-artist').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (input.files && input.files[0]) await loadFile(input.files[0]);
    input.value = '';
  });

  // Click anywhere on the stage to play/pause once a file is loaded.
  stage.addEventListener('click', (e) => {
    if (e.target.closest('.info-value.clickable')) return;
    if (e.target.closest('#info-track')) return;
    if (e.target.closest('#info-artist')) return;
    if (audio.state === 'idle' || audio.state === 'loading') return;
    audio.toggle();
  });
}

async function loadFile(file) {
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|flac|m4a|aac|webm)$/i.test(file.name)) {
    return;
  }
  try {
    histogram.reset();
    await audio.loadFile(file);
    infoBar.onTrackLoaded();
  } catch (err) {
    console.error('Failed to load file', err);
  }
}

function hasFile(e) {
  if (!e.dataTransfer) return false;
  return Array.from(e.dataTransfer.types || []).includes('Files');
}

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        audio.toggle();
        break;
      case 'ArrowLeft':
        audio.seek(Math.max(0, audio.getElapsed() - 5));
        break;
      case 'ArrowRight':
        audio.seek(Math.min(audio.getDuration(), audio.getElapsed() + 5));
        break;
      case 'ArrowUp':
        audio.setVolume(Math.min(1, audio.getVolume() + 0.05));
        break;
      case 'ArrowDown':
        audio.setVolume(Math.max(0, audio.getVolume() - 0.05));
        break;
    }
  });
}

function setupVolumeWheel() {
  const volEl = document.getElementById('info-volume');
  volEl.classList.add('clickable');
  volEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.05 : -0.05;
    audio.setVolume(Math.max(0, Math.min(1, audio.getVolume() + step)));
  }, { passive: false });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
