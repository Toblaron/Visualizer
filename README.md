# Audio Visualizer v3.14

A browser-based audio visualizer with frequency spectrum, waveform, BPM detection, EQ, and more.

## Getting Started

Because the app uses ES modules, it must be served over HTTP — opening `index.html` directly in a browser will not work.

**Requirements:** Python 3 (comes pre-installed on most systems)

1. Download or clone this repo
2. Open a terminal in the project folder
3. Run:

```bash
python -m http.server 8080
```

4. Open your browser and go to `http://localhost:8080`

For the best experience (no browser chrome), launch Chrome in app mode instead:

```bash
chrome --app=http://localhost:8080
```

## Usage

- Click **LOAD AUDIO** or drag and drop an audio file onto the window
- Press **?** to see all keyboard shortcuts

## YouTube Music Videos

You can play YouTube videos in the center panel with full visualizer support.

1. Click the **YT** button in the toolbar (or press **Y**)
2. Paste a YouTube URL and press Enter — the video loads in the center panel
3. A browser share dialog will appear — this is how the visualizer captures the audio for analysis
4. Choose **Window** and select your browser window, then tick **"Share system audio"** (or **"Share audio"**), then click Share
5. All panels (frequency spectrum, waveform, BPM, key, etc.) will react to the video audio in real time

Press **Esc** or click **✕ CLOSE VIDEO** to return to the normal visualizer.

> **No feedback loop:** the captured audio is routed through the analyser only — it is not re-played through your speakers. The YouTube video handles its own playback at normal volume.

> **Tip:** If a "Chrome Tab" option appears in the share dialog, select that and tick "Share tab audio" for the cleanest capture. Otherwise, Window sharing with system audio works fine.
