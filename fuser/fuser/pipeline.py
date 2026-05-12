from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from .analysis import analyze_track, compatibility_warnings
from .audio_io import load_track, write_wav
from .preview import write_preview_html
from .render import RenderReport, StretchBackend, render_candidate_preview, render_transition


@dataclass(frozen=True)
class RenderJob:
    track_a: Path
    track_b: Path
    output: Path
    sample_rate: int = 44_100
    bars: int = 16
    style: str = "bass-swap"
    allow_stretch: bool = True
    max_tempo_shift: float = 0.06
    stretch_backend: StretchBackend = "auto"
    report: Path | None = None
    preview_dir: Path | None = None
    preview_html: Path | None = None
    preview_count: int = 3


@dataclass(frozen=True)
class RenderJobResult:
    report: RenderReport
    output: Path
    report_json: Path | None
    preview_html: Path | None
    preview_files: tuple[Path, ...]


def run_render_job(job: RenderJob) -> RenderJobResult:
    _validate_job(job)
    track_a = load_track(job.track_a, sample_rate=job.sample_rate)
    track_b = load_track(job.track_b, sample_rate=job.sample_rate)

    analysis_a = analyze_track(track_a.samples, track_a.sample_rate)
    analysis_b = analyze_track(track_b.samples, track_b.sample_rate)
    warnings = tuple(compatibility_warnings(analysis_a, analysis_b, job.max_tempo_shift))

    output, report = render_transition(
        track_a.samples,
        track_b.samples,
        job.sample_rate,
        analysis_a,
        analysis_b,
        bars=job.bars,
        style=job.style,
        allow_stretch=job.allow_stretch,
        max_tempo_shift=job.max_tempo_shift,
        stretch_backend=job.stretch_backend,
        warnings=warnings,
    )
    write_wav(job.output, output, job.sample_rate)

    report_json = None
    if job.report is not None:
        job.report.parent.mkdir(parents=True, exist_ok=True)
        job.report.write_text(json.dumps(asdict(report), indent=2), encoding="utf-8")
        report_json = job.report

    preview_files: list[Path] = []
    if job.preview_dir is not None and job.preview_count > 0:
        job.preview_dir.mkdir(parents=True, exist_ok=True)
        for index, candidate in enumerate(report.candidates[: job.preview_count], start=1):
            preview = render_candidate_preview(
                track_a.samples,
                track_b.samples,
                job.sample_rate,
                candidate.transition_start_a,
                candidate.entry_start_b,
                report.transition_length,
                report.style,
                stretch_ratio=report.stretch_ratio,
                stretch_backend=job.stretch_backend,
            )
            preview_path = job.preview_dir / f"candidate-{index:02d}.wav"
            write_wav(preview_path, preview, job.sample_rate)
            preview_files.append(preview_path)

    if job.preview_html is not None:
        write_preview_html(job.preview_html, report, job.preview_dir)

    return RenderJobResult(
        report=report,
        output=job.output,
        report_json=report_json,
        preview_html=job.preview_html,
        preview_files=tuple(preview_files),
    )


def _validate_job(job: RenderJob) -> None:
    if not job.track_a.exists():
        raise FileNotFoundError(job.track_a)
    if not job.track_b.exists():
        raise FileNotFoundError(job.track_b)
    if job.sample_rate <= 0:
        raise ValueError("Sample rate must be positive.")
    if job.bars <= 0:
        raise ValueError("Bars must be positive.")
    if job.max_tempo_shift <= 0:
        raise ValueError("Max tempo shift must be positive.")
    if job.preview_count < 0:
        raise ValueError("Preview count must not be negative.")
    if job.style not in {"bass-swap", "clean"}:
        raise ValueError("Unknown transition style.")
    if job.stretch_backend not in {"auto", "rubberband", "fast"}:
        raise ValueError("Unknown stretch backend.")

