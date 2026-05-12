// Bootstrap: wire engine + panels, drag-drop, queue, keyboard, recording, etc.
import { audio } from './audio/engine.js';
import * as header    from './panels/header.js';
import * as spectrum  from './panels/spectrum.js';
import * as histogram from './panels/histogram.js';
import * as waveform  from './panels/waveform.js';
import * as routing   from './panels/routing.js';
import * as center    from './panels/center.js';
import * as infoBar   from './panels/infoBar.js';

const $canvas = (name) => document.querySelector(`canvas[data-canvas="${name}"]`);

const STAGE_TOGGLE_EXCLUDE =
  '.tp-btn, .load-btn, .seek-bar, .volume-bar, .track-progress-bar, .info-btn, ' +
  '#info-track, .info-value.clickable, .info-label.clickable, ' +
  '.eq-band, #key-help, .overlay, #yt-wrap, .yt-close, #playlist-panel';

// ── Playlist ──────────────────────────────────────────────────────────────────
// Each item: { type: 'file'|'youtube', file: File|null, videoId: string|null, title: string }
let playlist   = [];
let nowPlaying = -1;
let ytActive   = false;
let ytQueueMode = false; // true → next YT overlay submit adds to queue instead of playing

function itemTitle(item) {
  if (item.type === 'file') return item.file.name.replace(/\.[^.]+$/, '');
  return item.title || ('YOUTUBE · ' + item.videoId);
}

function updateQueueBadge() {
  const el = document.getElementById('queue-badge');
  if (!el) return;
  const ahead = playlist.length - (nowPlaying + 1);
  if (ahead > 0) { el.textContent = `+${ahead}`; el.style.display = ''; }
  else el.style.display = 'none';
}

function renderPlaylist() {
  const body  = document.getElementById('playlist-body');
  const count = document.getElementById('playlist-count');
  if (!body) return;
  if (count) count.textContent = `${playlist.length} TRACK${playlist.length !== 1 ? 'S' : ''}`;
  if (playlist.length === 0) {
    body.innerHTML = '<div class="playlist-empty">NO TRACKS LOADED</div>';
    return;
  }
  body.innerHTML = '';
  playlist.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'playlist-item' + (i === nowPlaying ? ' now-playing' : '');

    const num = document.createElement('span');
    num.className = 'playlist-item-num';
    num.textContent = i === nowPlaying ? '▶' : String(i + 1).padStart(2, '0');

    const info = document.createElement('div');
    info.className = 'playlist-item-info';
    const title = document.createElement('div');
    title.className = 'playlist-item-title';
    title.textContent = itemTitle(item);
    const type = document.createElement('div');
    type.className = 'playlist-item-type';
    type.textContent = item.type === 'youtube' ? 'YOUTUBE' : 'AUDIO';
    info.append(title, type);

    const rm = document.createElement('button');
    rm.className = 'playlist-item-remove';
    rm.textContent = '✕';
    rm.title = 'Remove';
    rm.addEventListener('click', (e) => { e.stopPropagation(); playlistRemove(i); });

    row.append(num, info, rm);
    row.addEventListener('click', () => playlistJump(i));
    body.appendChild(row);
  });
  body.querySelector('.now-playing')?.scrollIntoView({ block: 'nearest' });
}

async function playlistJump(index) {
  if (index < 0 || index >= playlist.length) return;
  nowPlaying = index;
  const item = playlist[index];
  if (item.type === 'youtube') {
    await _playYouTubeItem(item.videoId);
  } else {
    if (ytActive) _closeYouTubeUI();
    audio._timeOverride = null;
    histogram.reset();
    await loadFile(item.file);
  }
  renderPlaylist();
  updateQueueBadge();
}

function playlistRemove(index) {
  const wasActive = index === nowPlaying;
  playlist.splice(index, 1);
  if (index < nowPlaying) {
    nowPlaying--;
  } else if (wasActive) {
    nowPlaying = Math.min(index, playlist.length - 1);
    if (nowPlaying >= 0) playlistJump(nowPlaying);
    else { audio.stop(); _closeYouTubeUI(); nowPlaying = -1; }
  }
  renderPlaylist();
  updateQueueBadge();
}

function playlistClear() {
  audio.stop();
  _closeYouTubeUI();
  playlist = [];
  nowPlaying = -1;
  renderPlaylist();
  updateQueueBadge();
}

function enqueueFiles(files) {
  const arr = Array.from(files);
  if (arr.length === 0) return;
  const startIdx = playlist.length;
  for (const f of arr) {
    playlist.push({ type: 'file', file: f, videoId: null, title: '' });
  }
  if (nowPlaying < 0) playlistJump(startIdx);
  else { renderPlaylist(); updateQueueBadge(); }
}

// ── Playlist panel UI ─────────────────────────────────────────────────────────
function showPlaylist() {
  const el = document.getElementById('playlist-panel');
  if (el) el.style.display = '';
  renderPlaylist();
}
function hidePlaylist() {
  const el = document.getElementById('playlist-panel');
  if (el) el.style.display = 'none';
}
function togglePlaylist() {
  const el = document.getElementById('playlist-panel');
  if (!el) return;
  if (el.style.display === 'none' || !el.style.display) showPlaylist();
  else hidePlaylist();
}
function setupPlaylist() {
  document.getElementById('playlist-btn')?.addEventListener('click', (e) => {
    e.stopPropagation(); togglePlaylist();
  });
  document.getElementById('playlist-close-btn')?.addEventListener('click', (e) => {
    e.stopPropagation(); hidePlaylist();
  });
  document.getElementById('playlist-clear-btn')?.addEventListener('click', (e) => {
    e.stopPropagation(); playlistClear();
  });
  document.getElementById('playlist-add-yt-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    ytQueueMode = true;
    showYtOverlay();
  });
  document.getElementById('queue-badge')?.addEventListener('click', (e) => {
    e.stopPropagation(); togglePlaylist();
  });
}

// ── A/B loop ────────────────────────────────────────────────────────────────
let loopA = null, loopB = null;
function setLoopA() {
  loopA = audio.getElapsed();
  if (loopB !== null && loopA >= loopB) loopB = null;
  updateLoopUI();
  header.setLoop(loopA, loopB);
}
function setLoopB() {
  loopB = audio.getElapsed();
  if (loopA !== null && loopB <= loopA) loopA = null;
  updateLoopUI();
  header.setLoop(loopA, loopB);
}
function clearLoop() {
  loopA = loopB = null;
  updateLoopUI();
  header.setLoop(null, null);
}
function updateLoopUI() {
  const markers = document.getElementById('loop-markers');
  if (!markers) return;
  if (loopA !== null || loopB !== null) {
    markers.style.display = '';
    const total = audio.getDuration();
    const la = document.getElementById('loop-a-label');
    const lb = document.getElementById('loop-b-label');
    if (la && loopA !== null && total > 0) la.style.left = (loopA / total * 100) + '%';
    if (lb && loopB !== null && total > 0) lb.style.left = (loopB / total * 100) + '%';
  } else {
    markers.style.display = 'none';
  }
}

// ── Tap tempo ────────────────────────────────────────────────────────────────
const tapTimes = [];
function tapTempo() {
  const now = performance.now();
  tapTimes.push(now);
  // Expire taps older than 3s
  while (tapTimes.length > 1 && now - tapTimes[0] > 3000) tapTimes.shift();
  if (tapTimes.length >= 4) {
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const bpm = 60000 / avg;
    if (bpm >= 40 && bpm <= 220) {
      audio.forceBpm(bpm);
    }
  }
}

// ── Recording ────────────────────────────────────────────────────────────────
let mediaRecorder = null;
let recordedChunks = [];

function startRecording() {
  const cv = document.querySelector('canvas[data-canvas="center"]');
  if (!cv) return;
  const stream = cv.captureStream(30);

  // Mix audio into the recording
  if (audio.ctx && audio.gainNode) {
    try {
      const dest = audio.ctx.createMediaStreamDestination();
      audio.gainNode.connect(dest);
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
    } catch (_) {}
  }

  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((t) => MediaRecorder.isTypeSupported(t)) || '';

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = saveRecording;
  mediaRecorder.start(250);

  const ind = document.getElementById('rec-indicator');
  if (ind) ind.style.display = 'flex';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  mediaRecorder = null;
  const ind = document.getElementById('rec-indicator');
  if (ind) ind.style.display = 'none';
}

function saveRecording() {
  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `av_${Date.now()}.webm` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') stopRecording();
  else startRecording();
}

// ── YouTube ───────────────────────────────────────────────────────────────────
function parseYouTubeId(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// YouTube IFrame API loader — resolves when YT global is ready.
let _ytApiReady = false;
const _ytApiWaiters = [];
window.onYouTubeIframeAPIReady = () => {
  _ytApiReady = true;
  _ytApiWaiters.splice(0).forEach((r) => r());
};
function _waitForYTApi() {
  if (_ytApiReady) return Promise.resolve();
  return new Promise((r) => _ytApiWaiters.push(r));
}
function _loadYTApiScript() {
  if (document.getElementById('yt-api-script')) return;
  const s = Object.assign(document.createElement('script'), {
    id:  'yt-api-script',
    src: 'https://www.youtube.com/iframe_api',
  });
  document.head.appendChild(s);
}

let ytPlayer = null;

// Internal: close YouTube player + capture — does not modify playlist array.
function _closeYouTubeUI() {
  if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }
  audio._timeOverride = null;
  const wrap = document.getElementById('yt-wrap');
  if (wrap) wrap.style.display = 'none';
  center.setYouTubeMode(false);
  ytActive = false;
  if (audio.isMicActive()) {
    audio.stopMic();
    document.getElementById('mic-btn')?.classList.remove('active');
  }
}

// Internal: play a YouTube video (called by playlistJump).
async function _playYouTubeItem(videoId) {
  if (ytActive) _closeYouTubeUI();
  audio.stop();

  const wrap = document.getElementById('yt-wrap');
  if (wrap) wrap.style.display = 'flex';
  center.setYouTubeMode(true);
  ytActive = true;

  // Tab capture needs to happen inside the user-gesture chain — do it first.
  try {
    await audio.startTabCapture();
    document.getElementById('mic-btn')?.classList.add('active');
    infoBar.onTrackLoaded();
  } catch (err) {
    console.info('[yt] Tab audio capture cancelled:', err.message);
  }

  // Create the YouTube IFrame API player for time tracking + seeking.
  _loadYTApiScript();
  _waitForYTApi().then(() => {
    if (!ytActive) return; // user closed the video while API was loading
    if (ytPlayer) { try { ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }
    audio._timeOverride = null;

    const div = document.getElementById('yt-player-div');
    if (!div) return;
    ytPlayer = new YT.Player(div, {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          audio._timeOverride = {
            elapsed:  () => { try { return ytPlayer.getCurrentTime() || 0; } catch (_) { return 0; } },
            duration: () => { try { return ytPlayer.getDuration()  || 0; } catch (_) { return 0; } },
            seek:     (t) => { try { ytPlayer.seekTo(t, true); } catch (_) {} },
          };
        },
        onStateChange: (e) => {
          if (typeof YT !== 'undefined' && YT.PlayerState && e.data === YT.PlayerState.ENDED) {
            onTrackEnded();
          }
        },
      },
    });
  });
}

// User-facing: load from YT overlay — adds to playlist and plays (or queues if ytQueueMode).
async function loadYouTubeVideo(videoId) {
  if (ytQueueMode) {
    ytQueueMode = false;
    playlist.push({ type: 'youtube', file: null, videoId, title: 'YOUTUBE · ' + videoId });
    renderPlaylist();
    updateQueueBadge();
    return;
  }
  // Insert after current item (or at start) and play immediately.
  const insertAt = nowPlaying + 1;
  playlist.splice(insertAt, 0, { type: 'youtube', file: null, videoId, title: 'YOUTUBE · ' + videoId });
  nowPlaying = insertAt;
  await _playYouTubeItem(videoId);
  renderPlaylist();
  updateQueueBadge();
}

// User-facing close (ESC / close button).
function closeYouTubeVideo() {
  _closeYouTubeUI();
  renderPlaylist();
  updateQueueBadge();
}

function showYtOverlay() {
  const el = document.getElementById('yt-overlay');
  if (!el) return;
  el.style.display = '';
  setTimeout(() => document.getElementById('yt-url-input')?.focus(), 40);
}

function hideYtOverlay() {
  const el = document.getElementById('yt-overlay');
  if (el) el.style.display = 'none';
  ytQueueMode = false; // reset if user cancels
}

function setupYouTube() {
  document.getElementById('yt-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    showYtOverlay();
  });

  document.getElementById('yt-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'yt-overlay') hideYtOverlay();
  });

  document.getElementById('yt-url-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const id = parseYouTubeId(e.target.value.trim());
      if (id) {
        hideYtOverlay();
        e.target.value = '';
        await loadYouTubeVideo(id); // await keeps getDisplayMedia inside the user-gesture chain
      } else {
        e.target.style.borderColor = 'var(--magenta)';
        setTimeout(() => { e.target.style.borderColor = ''; }, 900);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideYtOverlay();
    }
  });

  document.getElementById('yt-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeYouTubeVideo();
  });
}

// ── Screenshot ───────────────────────────────────────────────────────────────
function takeSnapshot() {
  const cv = document.querySelector('canvas[data-canvas="center"]');
  if (!cv) return;
  cv.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), { href: url, download: `snapshot_${Date.now()}.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// ── Keyboard help ────────────────────────────────────────────────────────────
function showKeyHelp() {
  const el = document.getElementById('key-help');
  if (el) el.style.display = '';
}
function hideKeyHelp() {
  const el = document.getElementById('key-help');
  if (el) el.style.display = 'none';
}

// ── Album art color extraction ────────────────────────────────────────────────
function extractThemeHue(picture) {
  if (!picture || !picture.data) return;
  const blob = new Blob([new Uint8Array(picture.data)], { type: picture.format || 'image/jpeg' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image();
  img.onload = () => {
    const cv = Object.assign(document.createElement('canvas'), { width: 16, height: 16 });
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0, 16, 16);
    const px = cx.getImageData(0, 0, 16, 16).data;
    let hSum = 0, count = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, g = px[i+1] / 255, b = px[i+2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d < 0.2 || max < 0.2) continue; // skip dark/grey pixels
      let h;
      if (max === r)      h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else                h = (r - g) / d + 4;
      hSum += (h * 60 + 360) % 360;
      count++;
    }
    if (count > 0) audio.themeHue = hSum / count;
    URL.revokeObjectURL(url);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

// ── Persist settings ─────────────────────────────────────────────────────────
function saveSettings() {
  try {
    localStorage.setItem('av_volume', audio.getVolume());
    localStorage.setItem('av_mode',   infoBar.getCurrentMode());
    const eq = audio.getEq();
    localStorage.setItem('av_eq', JSON.stringify(eq));
    localStorage.setItem('av_comp', audio.isCompressorEnabled() ? '1' : '0');
  } catch (_) {}
}

function loadSettings() {
  try {
    const vol = parseFloat(localStorage.getItem('av_volume'));
    if (!isNaN(vol)) audio.setVolume(vol);

    const mode = localStorage.getItem('av_mode');
    if (mode) {
      infoBar.setModeByName(mode);
      center.setMode(mode);
      onModeChange(mode);
    }

    const eq = JSON.parse(localStorage.getItem('av_eq') || 'null');
    if (eq) audio.setEq(eq.low ?? 0, eq.mid ?? 0, eq.high ?? 0);

    if (localStorage.getItem('av_comp') === '1') audio.setCompressor(true);
  } catch (_) {}
}

// ── Transport state ───────────────────────────────────────────────────────────
let tpButtons = {};
let lastTpState = '';
function updateTransportState() {
  const s = audio.state;
  if (s === lastTpState) return;
  lastTpState = s;
  const playing = s === 'playing';
  const paused  = s === 'paused';
  if (tpButtons.play)  tpButtons.play.classList.toggle('active', playing);
  if (tpButtons.pause) tpButtons.pause.classList.toggle('active', paused);
}

// ── File load ─────────────────────────────────────────────────────────────────
async function loadFile(file) {
  try {
    histogram.reset();
    await audio.loadFile(file);
    infoBar.onTrackLoaded();
    // Watch for album art to arrive (tags are loaded async)
    const checkArt = setInterval(() => {
      if (audio.metadata.picture) {
        clearInterval(checkArt);
        extractThemeHue(audio.metadata.picture);
      }
    }, 300);
    setTimeout(() => clearInterval(checkArt), 3000);
  } catch (err) {
    console.error('[main] loadFile failed:', err);
  }
}

// ── Mode change callback ──────────────────────────────────────────────────────
function onModeChange(m) {
  center.setMode(m);
  saveSettings();
}

// ── RAF loop ──────────────────────────────────────────────────────────────────
let rafRunning = false;
function startRaf() {
  if (rafRunning) return;
  rafRunning = true;
  function frame(now) {
    if (document.hidden) { rafRunning = false; return; } // pause when tab hidden
    audio.tick();
    header.render(now);
    spectrum.render(now);
    histogram.render(now);
    waveform.render(now);
    routing.render(now);
    center.render(now);
    infoBar.render(now);
    updateTransportState();
    // Loop enforcement
    if (loopA !== null && loopB !== null) {
      const t = audio.getElapsed();
      if (t >= loopB) audio.seek(loopA);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
function boot() {
  header.init(audio);
  spectrum.init($canvas('spectrum'),   audio);
  histogram.init($canvas('histogram'), audio);
  waveform.init($canvas('waveform'),   audio);
  routing.init($canvas('routing'),     audio);
  center.init($canvas('center'),       audio);
  infoBar.init(null, audio);
  infoBar.setOnModeChange(onModeChange);

  // Reduced-motion
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  center.setReducedMotion(prefersReduced);

  loadSettings();
  setupFileDropZone();
  setupTransport();
  setupYouTube();
  setupPlaylist();
  setupKeyboard();

  startRaf();

  // Resume RAF when tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) startRaf();
  });

  // Auto-advance queue on track end (audio-element exists in DOM before AudioContext)
  document.getElementById('audio-element')?.addEventListener('ended', onTrackEnded);
}

function onTrackEnded() {
  if (nowPlaying + 1 < playlist.length) playlistJump(nowPlaying + 1);
}


function setupFileDropZone() {
  const overlay = document.getElementById('drop-overlay');
  const input   = document.getElementById('file-input');
  const stage   = document.querySelector('.stage');
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
    const files = e.dataTransfer.files;
    if (files && files.length > 0) enqueueFiles(files);
  });

  document.getElementById('info-track')?.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) enqueueFiles(input.files);
    input.value = '';
  });

  stage.addEventListener('click', (e) => {
    if (e.target.closest(STAGE_TOGGLE_EXCLUDE)) return;
    if (audio.state === 'idle' || audio.state === 'loading') return;
    audio.toggle();
  });
}

function setupTransport() {
  document.querySelectorAll('.tp-btn[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    tpButtons[action] = btn;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (action === 'play')  audio.play();
      if (action === 'pause') audio.pause();
      if (action === 'stop')  { audio.stop(); clearLoop(); }
    });
  });

  // MIC button
  document.getElementById('mic-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (audio.isMicActive()) {
      audio.stopMic();
      document.getElementById('mic-btn').classList.remove('active');
    } else {
      try {
        await audio.startMic();
        document.getElementById('mic-btn').classList.add('active');
      } catch (_) {
        alert('Microphone access denied or unavailable.');
      }
    }
  });

  // Key help close
  document.getElementById('key-help')?.addEventListener('click', hideKeyHelp);
}

function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const ytOverlay = document.getElementById('yt-overlay');
    if (ytOverlay && ytOverlay.style.display !== 'none') {
      if (e.key === 'Escape') { hideYtOverlay(); e.preventDefault(); }
      return;
    }
    const help = document.getElementById('key-help');
    if (help && help.style.display !== 'none') {
      if (e.key === 'Escape') { hideKeyHelp(); e.preventDefault(); }
      return;
    }

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
        saveSettings();
        break;
      case 'ArrowDown':
        audio.setVolume(Math.max(0, audio.getVolume() - 0.05));
        saveSettings();
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        if (e.altKey) {
          (async () => {
            if (audio.isMicActive()) {
              audio.stopMic();
              document.getElementById('mic-btn')?.classList.remove('active');
            } else {
              try {
                await audio.startMic();
                document.getElementById('mic-btn')?.classList.add('active');
              } catch (_) {}
            }
          })();
        } else {
          audio.toggleMute();
        }
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
        else document.exitFullscreen().catch(() => {});
        break;
      case 'p':
      case 'P':
        e.preventDefault();
        takeSnapshot();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        toggleRecording();
        break;
      case 't':
      case 'T':
        tapTempo();
        break;
      case 'v':
      case 'V':
        waveform.toggleView();
        break;
      case '[':
        setLoopA();
        break;
      case ']':
        setLoopB();
        break;
      case 'l':
      case 'L':
        clearLoop();
        break;
      case 'y':
      case 'Y':
        e.preventDefault();
        showYtOverlay();
        break;
      case 'q':
      case 'Q':
        e.preventDefault();
        togglePlaylist();
        break;
      case '?':
        e.preventDefault();
        showKeyHelp();
        break;
      case 'Escape':
        hideKeyHelp();
        closeYouTubeVideo();
        clearLoop();
        break;
    }
  });
}

function hasFile(e) {
  if (!e.dataTransfer) return false;
  return Array.from(e.dataTransfer.types || []).includes('Files');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
