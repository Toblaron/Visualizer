# Fuser

Fuser is a prototype tool for creating cleaner transitions between two audio tracks.
The first version is a command-line renderer for WAV/AIFF/FLAC files supported by
`soundfile`. The prototype intentionally avoids heavyweight analysis paths so it
stays responsive on local machines.

It currently:

- analyzes tempo, beat grid, loudness, and rough spectral energy;
- estimates rough key, phrase anchors, and vocal-presence risk;
- scores candidate transition pairs instead of blindly taking the last beat;
- optionally time-stretches track B toward track A's tempo with a fast prototype
  stretcher or Rubber Band when available;
- aligns track B on a beat;
- gain-matches the incoming transition region;
- renders an equal-power blend with smoothed automation and a simple bass-swap
  EQ curve;
- applies DC cleanup, subsonic filtering, oversampled peak checking, a -1 dB
  output ceiling, and tiny edge fades to avoid clipping/clicks;
- writes a WAV file, optional candidate previews, and a transition report.

## Usage

Local browser GUI:

```powershell
python -m fuser.gui
```

Then open `http://127.0.0.1:8765/` if your browser does not open automatically.
Rendered files are written under `fuser-runs/`.

Command line:

```powershell
python -m fuser.cli path\to\track-a.wav path\to\track-b.wav -o fused.wav
```

Useful options:

```powershell
python -m fuser.cli a.wav b.wav -o fused.wav --bars 16 --style bass-swap
python -m fuser.cli a.wav b.wav -o fused.wav --no-stretch
python -m fuser.cli a.wav b.wav -o fused.wav --max-tempo-shift 0.06
python -m fuser.cli a.wav b.wav -o fused.wav --preview-dir previews
python -m fuser.cli a.wav b.wav -o fused.wav --preview-dir previews --preview-html preview.html
python -m fuser.cli a.wav b.wav -o fused.wav --stretch-backend rubberband
```

The report includes detected tempos, stretch ratio, transition timing, incoming
track gain, key estimates, harmonic distance, candidate scores, style, and
warnings. It also reports output duration, peak level, RMS level, and any peak
reduction applied during final mastering.

## Higher Quality Stretch

Install the optional Python package and the Rubber Band command-line tool to get
pitch-preserving tempo changes:

```powershell
python -m pip install -e .[quality]
```

Then use `--stretch-backend rubberband` or leave the default `auto`. If Rubber
Band is unavailable, `auto` falls back to the fast prototype stretcher and reports
a warning when the tempo change is likely audible.

## Current Limits

This is not yet a finished professional product. The engine intentionally exposes
analysis and compatibility warnings because some track pairs should not be blended
automatically. The current key, phrase, and vocal estimates are lightweight
heuristics. Next steps are a richer interactive UI, stronger downbeat/phrase
detection, stem-aware vocal clash detection, and FFmpeg support for broader input
and export formats.
