from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from fuser.analysis import analyze_track
from fuser.audio_io import load_track, write_wav
from fuser.pipeline import RenderJob, run_render_job
from fuser.preview import write_preview_html
from fuser.render import render_candidate_preview, render_transition


class EngineTests(unittest.TestCase):
    def test_render_transition_outputs_finite_stereo_audio(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=24, bpm=120, tone=220.0, channels=2)
        b = _click_track(sr, seconds=24, bpm=120, tone=330.0, channels=2)

        output, report = render_transition(
            a,
            b,
            sr,
            analyze_track(a, sr),
            analyze_track(b, sr),
            bars=4,
        )

        self.assertEqual(output.shape[1], 2)
        self.assertGreater(len(output), sr * 20)
        self.assertTrue(np.all(np.isfinite(output)))
        self.assertLessEqual(float(np.max(np.abs(output))), 0.9801)
        self.assertLessEqual(float(np.max(np.abs(output))), 0.8914)
        self.assertEqual(report.style, "bass-swap")
        self.assertGreater(report.transition_length, 1.0)
        self.assertGreaterEqual(len(report.candidates), 1)
        self.assertIsInstance(report.key_a, str)
        self.assertIsInstance(report.key_b, str)
        self.assertLessEqual(report.output_peak_db, -0.9)
        self.assertGreater(report.output_duration, 1.0)

    def test_mono_and_stereo_tracks_are_matched(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=18, bpm=120, tone=220.0, channels=1)
        b = _click_track(sr, seconds=18, bpm=120, tone=330.0, channels=2)
        output, _ = render_transition(
            a,
            b,
            sr,
            analyze_track(a, sr),
            analyze_track(b, sr),
            bars=2,
        )
        self.assertEqual(output.shape[1], 2)

    def test_short_tracks_raise_clear_error(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=2, bpm=120, tone=220.0, channels=2)
        b = _click_track(sr, seconds=2, bpm=120, tone=330.0, channels=2)
        with self.assertRaisesRegex(ValueError, "too short"):
            render_transition(a, b, sr, analyze_track(a, sr), analyze_track(b, sr), bars=4)

    def test_silent_track_does_not_create_nan_output(self) -> None:
        sr = 22_050
        a = np.zeros((sr * 12, 2), dtype=np.float32)
        b = _click_track(sr, seconds=12, bpm=120, tone=330.0, channels=2)

        output, report = render_transition(
            a,
            b,
            sr,
            analyze_track(a, sr),
            analyze_track(b, sr),
            bars=2,
        )

        self.assertTrue(np.all(np.isfinite(output)))
        self.assertIn("Tempo could not be estimated reliably.", report.warnings)

    def test_fast_stretch_backend_is_reported(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=20, bpm=120, tone=220.0, channels=2)
        b = _click_track(sr, seconds=20, bpm=124, tone=330.0, channels=2)

        _, report = render_transition(
            a,
            b,
            sr,
            analyze_track(a, sr),
            analyze_track(b, sr),
            bars=4,
            stretch_backend="fast",
        )

        self.assertEqual(report.stretch_backend, "fast")
        self.assertNotEqual(report.stretch_ratio, 1.0)

    def test_candidate_preview_renders(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=20, bpm=120, tone=220.0, channels=2)
        b = _click_track(sr, seconds=20, bpm=124, tone=330.0, channels=2)
        _, report = render_transition(
            a,
            b,
            sr,
            analyze_track(a, sr),
            analyze_track(b, sr),
            bars=4,
            stretch_backend="fast",
        )
        preview = render_candidate_preview(
            a,
            b,
            sr,
            report.candidates[0].transition_start_a,
            report.candidates[0].entry_start_b,
            report.transition_length,
            report.style,
            stretch_ratio=report.stretch_ratio,
            stretch_backend="fast",
        )

        self.assertEqual(preview.shape[1], 2)
        self.assertTrue(np.all(np.isfinite(preview)))
        self.assertLessEqual(float(np.max(np.abs(preview))), 0.9801)

    def test_preview_html_writes_candidate_table(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=20, bpm=120, tone=220.0, channels=2)
        b = _click_track(sr, seconds=20, bpm=120, tone=330.0, channels=2)
        _, report = render_transition(a, b, sr, analyze_track(a, sr), analyze_track(b, sr), bars=4)
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "preview.html"
            write_preview_html(target, report, Path(tmp))
            html = target.read_text(encoding="utf-8")
        self.assertIn("Fuser Preview", html)
        self.assertIn("Candidates", html)

    def test_preview_html_only_links_existing_preview_files(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=20, bpm=120, tone=220.0, channels=2)
        b = _click_track(sr, seconds=20, bpm=120, tone=330.0, channels=2)
        _, report = render_transition(a, b, sr, analyze_track(a, sr), analyze_track(b, sr), bars=4)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            preview_dir = root / "previews"
            preview_dir.mkdir()
            (preview_dir / "candidate-01.wav").write_bytes(b"placeholder")
            target = root / "preview.html"
            write_preview_html(target, report, preview_dir)
            html = target.read_text(encoding="utf-8")

        self.assertIn("candidate-01.wav", html)
        self.assertNotIn("candidate-02.wav", html)

    def test_rubberband_backend_failure_is_clear(self) -> None:
        sr = 22_050
        a = _click_track(sr, seconds=20, bpm=120, tone=220.0, channels=2)
        b = _click_track(sr, seconds=20, bpm=124, tone=330.0, channels=2)

        with self.assertRaisesRegex(RuntimeError, "Rubber Band"):
            render_transition(
                a,
                b,
                sr,
                analyze_track(a, sr),
                analyze_track(b, sr),
                bars=4,
                stretch_backend="rubberband",
            )

    def test_load_and_write_roundtrip(self) -> None:
        sr = 22_050
        samples = _click_track(sr, seconds=4, bpm=120, tone=220.0, channels=2)
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.wav"
            target = Path(tmp) / "target.wav"
            sf.write(source, samples, sr)

            track = load_track(source, sample_rate=sr)
            write_wav(target, track.samples, track.sample_rate)

            self.assertTrue(target.exists())
            self.assertEqual(track.channels, 2)
            self.assertAlmostEqual(track.duration, 4.0, places=2)

    def test_pipeline_writes_all_requested_outputs(self) -> None:
        sr = 22_050
        samples_a = _click_track(sr, seconds=20, bpm=120, tone=220.0, channels=2)
        samples_b = _click_track(sr, seconds=20, bpm=124, tone=330.0, channels=2)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            track_a = root / "a.wav"
            track_b = root / "b.wav"
            sf.write(track_a, samples_a, sr)
            sf.write(track_b, samples_b, sr)
            result = run_render_job(
                RenderJob(
                    track_a=track_a,
                    track_b=track_b,
                    output=root / "fused.wav",
                    sample_rate=sr,
                    bars=4,
                    stretch_backend="fast",
                    report=root / "report.json",
                    preview_dir=root / "previews",
                    preview_html=root / "preview.html",
                    preview_count=2,
                )
            )

            self.assertTrue(result.output.exists())
            self.assertTrue(result.report_json and result.report_json.exists())
            self.assertTrue(result.preview_html and result.preview_html.exists())
            self.assertEqual(len(result.preview_files), 2)
            self.assertTrue(all(path.exists() for path in result.preview_files))


def _click_track(
    sample_rate: int,
    seconds: int,
    bpm: float,
    tone: float,
    channels: int,
) -> np.ndarray:
    t = np.arange(sample_rate * seconds, dtype=np.float32) / sample_rate
    beat_period = 60.0 / bpm
    click_len = max(2, int(0.025 * sample_rate))
    click = np.zeros_like(t)
    for beat in np.arange(0.0, seconds, beat_period):
        start = int(beat * sample_rate)
        end = min(len(click), start + click_len)
        if end > start:
            click[start:end] += np.hanning((end - start) * 2)[: end - start] * 0.45
    audio = (0.18 * np.sin(2 * np.pi * tone * t) + click).astype(np.float32)
    if channels == 1:
        return audio[:, None]
    return np.repeat(audio[:, None], channels, axis=1)


if __name__ == "__main__":
    unittest.main()
