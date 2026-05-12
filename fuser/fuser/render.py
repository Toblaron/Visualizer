from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Literal

import numpy as np
from scipy.signal import butter, resample_poly, sosfilt, sosfiltfilt

from .analysis import TrackAnalysis, activity_between, key_distance, vocal_presence_between
from .audio_io import match_channel_count

StretchBackend = Literal["auto", "rubberband", "fast"]


@dataclass(frozen=True)
class TransitionCandidate:
    transition_start_a: float
    entry_start_b: float
    score: float
    activity_gap: float
    vocal_overlap: float
    phrase_penalty: float
    harmonic_penalty: float


@dataclass(frozen=True)
class RenderReport:
    tempo_a: float
    tempo_b_original: float
    tempo_b_rendered: float
    stretch_ratio: float
    transition_start_a: float
    transition_length: float
    entry_start_b: float
    gain_db_b: float
    score: float
    key_a: str
    key_b: str
    key_distance: int
    stretch_backend: str
    output_duration: float
    output_peak_db: float
    output_rms_db: float
    output_peak_reduction_db: float
    candidates: tuple[TransitionCandidate, ...]
    style: str
    warnings: tuple[str, ...]


def render_transition(
    a: np.ndarray,
    b: np.ndarray,
    sample_rate: int,
    analysis_a: TrackAnalysis,
    analysis_b: TrackAnalysis,
    bars: int = 16,
    style: str = "bass-swap",
    allow_stretch: bool = True,
    max_tempo_shift: float = 0.06,
    stretch_backend: StretchBackend = "auto",
    warnings: tuple[str, ...] = (),
) -> tuple[np.ndarray, RenderReport]:
    if sample_rate <= 0:
        raise ValueError("Sample rate must be positive.")
    if bars <= 0:
        raise ValueError("Bars must be positive.")
    if len(a) == 0 or len(b) == 0:
        raise ValueError("Input tracks must not be empty.")

    a, b = match_channel_count(_prepare_audio(a), _prepare_audio(b))

    b_rendered = b
    stretch_ratio = 1.0
    tempo_b_rendered = analysis_b.tempo
    used_stretch_backend = "none"
    render_warnings = [*analysis_a.warnings, *analysis_b.warnings, *warnings]
    if allow_stretch and analysis_a.tempo > 0 and analysis_b.tempo > 0:
        stretch_ratio = analysis_a.tempo / analysis_b.tempo
        if abs(stretch_ratio - 1.0) <= max_tempo_shift:
            b_rendered, used_stretch_backend = _time_stretch_stereo(
                b,
                stretch_ratio,
                sample_rate,
                stretch_backend,
            )
            tempo_b_rendered = analysis_a.tempo
            if used_stretch_backend == "fast" and abs(stretch_ratio - 1.0) > 0.015:
                render_warnings.append(
                    "Prototype stretch changes pitch slightly; install a Rubber Band backend for release quality."
                )
        else:
            render_warnings.append("Tempo stretch was skipped because it exceeds the configured limit.")
            stretch_ratio = 1.0

    beats_per_bar = 4
    beat_seconds = 60.0 / analysis_a.tempo if analysis_a.tempo > 0 else 0.5
    transition_seconds = max(6.0, bars * beats_per_bar * beat_seconds)
    transition_samples = int(round(transition_seconds * sample_rate))
    transition_samples = min(transition_samples, len(a) // 2, len(b_rendered) // 2)
    if transition_samples <= sample_rate:
        raise ValueError("Tracks are too short for a transition.")

    start_a, entry_b, score, candidates = _choose_transition_pair(
        analysis_a,
        analysis_b,
        len(a),
        len(b),
        len(b_rendered),
        transition_samples,
        stretch_ratio,
        sample_rate,
    )

    end_a = start_a + transition_samples
    end_b = entry_b + transition_samples

    pre = a[:start_a]
    blend_a = a[start_a:end_a]
    blend_b = b_rendered[entry_b:end_b]
    post = b_rendered[end_b:]

    blend_b, gain_db_b = _match_loudness(blend_a, blend_b)
    blend = _blend(blend_a, blend_b, sample_rate, style)
    post = post * _db_to_amp(gain_db_b)
    output = np.concatenate([pre, blend, post], axis=0)
    output, master_stats = _master_output(output, sample_rate)

    report = RenderReport(
        tempo_a=analysis_a.tempo,
        tempo_b_original=analysis_b.tempo,
        tempo_b_rendered=tempo_b_rendered,
        stretch_ratio=stretch_ratio,
        transition_start_a=start_a / sample_rate,
        transition_length=transition_samples / sample_rate,
        entry_start_b=entry_b / sample_rate,
        gain_db_b=gain_db_b,
        score=score,
        key_a=analysis_a.key,
        key_b=analysis_b.key,
        key_distance=key_distance(analysis_a.key, analysis_b.key),
        stretch_backend=used_stretch_backend,
        output_duration=len(output) / sample_rate,
        output_peak_db=master_stats["peak_db"],
        output_rms_db=master_stats["rms_db"],
        output_peak_reduction_db=master_stats["peak_reduction_db"],
        candidates=tuple(candidates),
        style=style,
        warnings=tuple(dict.fromkeys(render_warnings)),
    )
    return output.astype(np.float32), report


def render_candidate_preview(
    a: np.ndarray,
    b: np.ndarray,
    sample_rate: int,
    transition_start_a: float,
    entry_start_b: float,
    transition_length: float,
    style: str,
    lead_seconds: float = 4.0,
    tail_seconds: float = 4.0,
    stretch_ratio: float = 1.0,
    stretch_backend: StretchBackend = "auto",
) -> np.ndarray:
    if lead_seconds < 0 or tail_seconds < 0:
        raise ValueError("Preview lead/tail must not be negative.")
    a, b = match_channel_count(_prepare_audio(a), _prepare_audio(b))
    if abs(stretch_ratio - 1.0) > 1e-5:
        b, _ = _time_stretch_stereo(b, stretch_ratio, sample_rate, stretch_backend)
    transition_samples = int(round(transition_length * sample_rate))
    start_a = int(round(transition_start_a * sample_rate))
    entry_b = int(round(entry_start_b * sample_rate))
    lead = int(round(lead_seconds * sample_rate))
    tail = int(round(tail_seconds * sample_rate))

    start_a = int(np.clip(start_a, 0, max(0, len(a) - transition_samples)))
    entry_b = int(np.clip(entry_b, 0, max(0, len(b) - transition_samples)))
    pre_start = max(0, start_a - lead)
    post_end = min(len(b), entry_b + transition_samples + tail)

    pre = a[pre_start:start_a]
    blend_a = a[start_a : start_a + transition_samples]
    blend_b = b[entry_b : entry_b + transition_samples]
    blend_b, gain_db_b = _match_loudness(blend_a, blend_b)
    post = b[entry_b + transition_samples : post_end] * _db_to_amp(gain_db_b)
    preview = np.concatenate([pre, _blend(blend_a, blend_b, sample_rate, style), post], axis=0)
    mastered, _ = _master_output(preview, sample_rate)
    return mastered.astype(np.float32)


def _choose_transition_pair(
    analysis_a: TrackAnalysis,
    analysis_b: TrackAnalysis,
    total_a: int,
    total_b_original: int,
    total_b_rendered: int,
    transition_samples: int,
    stretch_ratio: float,
    sample_rate: int,
) -> tuple[int, int, float, list[TransitionCandidate]]:
    exits = _candidate_exits(analysis_a.beat_samples, total_a, transition_samples)
    entries = _candidate_entries(analysis_b.beat_samples, total_b_original, transition_samples)
    if len(exits) == 0:
        exits = np.asarray([max(0, total_a - transition_samples)], dtype=np.int64)
    if len(entries) == 0:
        entries = np.asarray([0], dtype=np.int64)

    key_penalty = _harmonic_penalty(analysis_a, analysis_b)
    scored: list[tuple[float, int, int, TransitionCandidate]] = []
    for exit_sample in exits[-16:]:
        exit_activity = activity_between(analysis_a, int(exit_sample), int(exit_sample + transition_samples))
        exit_vocal = vocal_presence_between(analysis_a, int(exit_sample), int(exit_sample + transition_samples))
        exit_position = exit_sample / max(1, total_a - transition_samples)
        phrase_penalty = _phrase_penalty(analysis_a.phrase_samples, int(exit_sample), transition_samples)
        for entry_sample in entries[:16]:
            rendered_entry = int(entry_sample / max(stretch_ratio, 1e-6))
            if rendered_entry + transition_samples >= total_b_rendered:
                continue
            entry_activity = activity_between(
                analysis_b,
                int(entry_sample),
                int(entry_sample + transition_samples * max(stretch_ratio, 1e-6)),
            )
            entry_vocal = vocal_presence_between(
                analysis_b,
                int(entry_sample),
                int(entry_sample + transition_samples * max(stretch_ratio, 1e-6)),
            )
            activity_gap = abs(exit_activity - entry_activity)
            vocal_overlap = min(exit_vocal, entry_vocal)
            entry_phrase_penalty = _phrase_penalty(analysis_b.phrase_samples, int(entry_sample), transition_samples)
            combined_phrase_penalty = min(1.0, (phrase_penalty + entry_phrase_penalty) / 2.0)
            score = 1.0
            score -= activity_gap * 0.55
            score -= vocal_overlap * 0.40
            score -= combined_phrase_penalty * 0.18
            score -= key_penalty * 0.25
            score -= abs(exit_position - 0.88) * 0.20
            score -= min(entry_sample / max(1, total_b_original), 0.25) * 0.35
            candidate = TransitionCandidate(
                transition_start_a=round(int(exit_sample) / sample_rate, 3),
                entry_start_b=round(int(rendered_entry) / sample_rate, 3),
                score=round(float(score), 4),
                activity_gap=round(float(activity_gap), 4),
                vocal_overlap=round(float(vocal_overlap), 4),
                phrase_penalty=round(float(combined_phrase_penalty), 4),
                harmonic_penalty=round(float(key_penalty), 4),
            )
            scored.append((float(score), int(exit_sample), int(rendered_entry), candidate))

    if not scored:
        fallback = TransitionCandidate(0.0, 0.0, 0.0, 1.0, 0.0, 1.0, round(key_penalty, 4))
        return int(exits[-1]), 0, 0.0, [fallback]

    scored.sort(key=lambda item: item[0], reverse=True)
    best = scored[0]
    return best[1], best[2], round(best[0], 4), [item[3] for item in scored[:5]]


def _candidate_exits(beat_samples: np.ndarray, total_samples: int, transition_samples: int) -> np.ndarray:
    latest = max(0, total_samples - transition_samples)
    earliest = max(0, int(total_samples * 0.55))
    candidates = beat_samples[(beat_samples >= earliest) & (beat_samples <= latest)]
    if len(candidates):
        return candidates.astype(np.int64)
    return beat_samples[beat_samples <= latest].astype(np.int64)


def _candidate_entries(beat_samples: np.ndarray, total_samples: int, transition_samples: int) -> np.ndarray:
    latest = max(0, min(total_samples - transition_samples, int(total_samples * 0.45)))
    return beat_samples[(beat_samples >= 0) & (beat_samples <= latest)].astype(np.int64)


def _time_stretch_stereo(
    samples: np.ndarray,
    ratio: float,
    sample_rate: int,
    backend: StretchBackend,
) -> tuple[np.ndarray, str]:
    if ratio <= 0:
        raise ValueError("Stretch ratio must be positive.")
    if abs(ratio - 1.0) < 1e-5:
        return samples, "none"
    if backend in ("auto", "rubberband"):
        try:
            import pyrubberband as pyrb

            channels = [
                pyrb.time_stretch(samples[:, channel], sample_rate, ratio)
                for channel in range(samples.shape[1])
            ]
            min_len = min(len(channel) for channel in channels)
            return np.stack([channel[:min_len] for channel in channels], axis=1).astype(np.float32), "rubberband"
        except Exception as exc:
            if backend == "rubberband":
                raise RuntimeError("Rubber Band stretch backend is unavailable or failed.") from exc

    target_len = max(1, int(round(len(samples) / ratio)))
    fraction = Fraction(1.0 / ratio).limit_denominator(1000)
    stretched = resample_poly(samples, fraction.numerator, fraction.denominator, axis=0)
    if len(stretched) > target_len:
        stretched = stretched[:target_len]
    elif len(stretched) < target_len:
        pad = np.zeros((target_len - len(stretched), samples.shape[1]), dtype=stretched.dtype)
        stretched = np.concatenate([stretched, pad], axis=0)
    return stretched.astype(np.float32), "fast"


def _blend(a: np.ndarray, b: np.ndarray, sample_rate: int, style: str) -> np.ndarray:
    n = min(len(a), len(b))
    a = a[:n]
    b = b[:n]
    x = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
    smooth = x * x * (3.0 - 2.0 * x)
    fade_out = np.cos(smooth * np.pi / 2.0)
    fade_in = np.sin(smooth * np.pi / 2.0)

    if style == "clean":
        return a * fade_out + b * fade_in
    if style != "bass-swap":
        raise ValueError(f"Unknown style: {style}")

    a_low, a_high = _split_low_high(a, sample_rate)
    b_low, b_high = _split_low_high(b, sample_rate)

    low_out = np.clip(1.0 - x * 1.35, 0.0, 1.0)
    low_in = np.clip((x - 0.32) / 0.68, 0.0, 1.0)
    high = a_high * fade_out + b_high * fade_in
    low = a_low * low_out + b_low * low_in
    return low + high


def _split_low_high(samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    cutoff = min(180.0, sample_rate * 0.45)
    sos = butter(4, cutoff, btype="lowpass", fs=sample_rate, output="sos")
    low = np.zeros_like(samples)
    for channel in range(samples.shape[1]):
        if len(samples) > 32:
            low[:, channel] = sosfiltfilt(sos, samples[:, channel])
        else:
            low[:, channel] = sosfilt(sos, samples[:, channel])
    high = samples - low
    return low, high


def _true_peak_guard(samples: np.ndarray, ceiling: float = 0.98) -> np.ndarray:
    peak = float(np.max(np.abs(samples)) + 1e-12)
    if peak <= ceiling:
        return samples
    return samples * (ceiling / peak)


def _match_loudness(reference: np.ndarray, target: np.ndarray, limit_db: float = 9.0) -> tuple[np.ndarray, float]:
    ref_rms = float(np.sqrt(np.mean(np.square(reference)) + 1e-12))
    target_rms = float(np.sqrt(np.mean(np.square(target)) + 1e-12))
    gain_db = float(np.clip(20.0 * np.log10(ref_rms / target_rms), -limit_db, limit_db))
    return target * _db_to_amp(gain_db), round(gain_db, 3)


def _db_to_amp(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def _micro_fade_edges(samples: np.ndarray, fade_samples: int = 128) -> np.ndarray:
    if len(samples) < fade_samples * 2:
        return samples
    out = samples.copy()
    fade_in = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)[:, None]
    fade_out = np.linspace(1.0, 0.0, fade_samples, dtype=np.float32)[:, None]
    out[:fade_samples] *= fade_in
    out[-fade_samples:] *= fade_out
    return out


def _prepare_audio(samples: np.ndarray) -> np.ndarray:
    prepared = np.asarray(samples, dtype=np.float32)
    prepared = np.nan_to_num(prepared, nan=0.0, posinf=0.0, neginf=0.0)
    if prepared.ndim == 1:
        prepared = prepared[:, None]
    if len(prepared) == 0:
        return prepared
    prepared = prepared - np.mean(prepared, axis=0, keepdims=True)
    return np.clip(prepared, -1.25, 1.25)


def _master_output(samples: np.ndarray, sample_rate: int, ceiling_db: float = -1.0) -> tuple[np.ndarray, dict[str, float]]:
    if len(samples) == 0:
        return samples.astype(np.float32), {"peak_db": -120.0, "rms_db": -120.0, "peak_reduction_db": 0.0}

    output = _micro_fade_edges(_remove_subsonic_dc(samples, sample_rate))
    ceiling = _db_to_amp(ceiling_db)
    true_peak = _oversampled_peak(output)
    reduction_db = 0.0
    if true_peak > ceiling:
        gain = ceiling / max(true_peak, 1e-12)
        output = output * gain
        reduction_db = 20.0 * np.log10(max(gain, 1e-12))

    output = np.clip(output, -ceiling, ceiling)
    peak = float(np.max(np.abs(output)) + 1e-12)
    rms = float(np.sqrt(np.mean(np.square(output)) + 1e-12))
    stats = {
        "peak_db": round(20.0 * np.log10(peak), 3),
        "rms_db": round(20.0 * np.log10(rms), 3),
        "peak_reduction_db": round(reduction_db, 3),
    }
    return output.astype(np.float32), stats


def _remove_subsonic_dc(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    if len(samples) < 64:
        return samples - np.mean(samples, axis=0, keepdims=True)
    cutoff = min(20.0, sample_rate * 0.1)
    sos = butter(2, cutoff, btype="highpass", fs=sample_rate, output="sos")
    cleaned = np.zeros_like(samples)
    for channel in range(samples.shape[1]):
        cleaned[:, channel] = sosfiltfilt(sos, samples[:, channel])
    return cleaned


def _oversampled_peak(samples: np.ndarray) -> float:
    if len(samples) == 0:
        return 0.0
    if len(samples) > 2_000_000:
        return float(np.max(np.abs(samples)))
    oversampled = resample_poly(samples, 4, 1, axis=0)
    return float(np.max(np.abs(oversampled)) + 1e-12)


def _harmonic_penalty(a: TrackAnalysis, b: TrackAnalysis) -> float:
    if a.key == "unknown" or b.key == "unknown":
        return 0.1
    if a.key_confidence < 0.12 or b.key_confidence < 0.12:
        return 0.12
    distance = key_distance(a.key, b.key)
    if distance in (0, 5, 7):
        return 0.0
    if distance in (1, 11):
        return 0.35
    return 0.65


def _phrase_penalty(phrase_samples: np.ndarray, sample: int, transition_samples: int) -> float:
    if len(phrase_samples) == 0:
        return 0.5
    distance = float(np.min(np.abs(phrase_samples - sample)))
    return float(np.clip(distance / max(1, transition_samples), 0.0, 1.0))
