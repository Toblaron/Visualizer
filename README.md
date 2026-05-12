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

## Usage

- Click **LOAD AUDIO** or drag and drop an audio file onto the window
- Press **?** to see all keyboard shortcuts

## YouTube Music Videos

You can play YouTube videos in the center panel with full visualizer support.

1. Click the **YT** button in the toolbar (or press **Y**)
2. Paste a YouTube URL and press Enter — the video loads in the center panel
3. A browser dialog will appear asking you to share your screen/tab — this is how the visualizer reads the audio
4. Select **Chrome Tab**, choose the current tab, **check "Share tab audio"**, then click Share
5. All panels (frequency spectrum, waveform, BPM, key, etc.) will react to the video audio in real time

Press **Esc** or click **✕ CLOSE VIDEO** to return to the normal visualizer.

> **Note:** Chrome works best. When sharing, select "Tab" (not Window or Entire Screen) and make sure the "Share tab audio" checkbox is ticked.
