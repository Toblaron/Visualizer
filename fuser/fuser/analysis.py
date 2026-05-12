from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import find_peaks


@dataclass(frozen=True)
class TrackAnalysis:
    tempo: float
    beat_times: np.ndarray
    beat_samples: np.ndarray
    duration: float
    rms_db: float
    peak_db: float
    low_energy_ratio: float
    key: str
    key_confidence: float
    activity: np.ndarray
    activity_hop_samples: int
    vocal_presence: np.ndarray
    phrase_samples: np.ndarray
    warnings: tuple[str, ...]


def analyze_track(samples: np.ndarray, sample_rate: int) -> TrackAnalysis:
    raw_mono = np.mean(samples, axis=1).astype(np.float32)
    duration = float(len(raw_mono) / sample_rate)
    warnings: list[str] = []

    mono = _prepare_mono(samples)
    envelope, hop = _onset_envelope(mono, sample_rate)
    tempo_value = _estimate_tempo(envelope, sample_rate, hop)
    beat_samples = _estimate_beat_samples(envelope, sample_rate, hop, tempo_value, len(mono))
    beat_times = beat_samples / sample_rate

    if tempo_value <= 0:
        warnings.append("Tempo could not be estimated reliably.")
    if len(beat_samples) < 8:
        warnings.append("Beat grid is sparse; alignment may be unreliable.")

    rms = float(np.sqrt(np.mean(np.square(raw_mono)) + 1e-12))
    peak = float(np.max(np.abs(raw_mono)) + 1e-12)
    rms_db = _amp_to_db(rms)
    peak_db = _amp_to_db(peak)

    low_ratio = _low_energy_ratio(raw_mono, sample_rate)
    activity, activity_hop = _activity_curve(raw_mono, sample_rate)
    vocal_presence = _vocal_presence_curve(raw_mono, sample_rate, activity_hop)
    key, key_confidence = _estimate_key(raw_mono, sample_rate)
    phrase_samples = _estimate_phrase_samples(beat_samples, beats_per_phrase=16)
    if key_confidence < 0.12:
        warnings.append("Key estimate is weak; harmonic compatibility may be unreliable.")
    return TrackAnalysis(
        tempo=tempo_value,
        beat_times=beat_times,
        beat_samples=beat_samples.astype(np.int64),
        duration=duration,
        rms_db=rms_db,
        peak_db=peak_db,
        low_energy_ratio=low_ratio,
        key=key,
        key_confidence=key_confidence,
        activity=activity,
        activity_hop_samples=activity_hop,
        vocal_presence=vocal_presence,
        phrase_samples=phrase_samples,
        warnings=tuple(warnings),
    )


def _onset_envelope(mono: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
    hop = 512
    frame = 2048
    if len(mono) < frame:
        padded = np.pad(mono, (0, frame - len(mono)))
    else:
        padded = mono

    frame_count = 1 + (len(padded) - frame) // hop
    frames = np.lib.stride_tricks.as_strided(
        padded,
        shape=(frame, frame_count),
        strides=(padded.strides[0], padded.strides[0] * hop),
        writeable=False,
    )
    energy = np.sqrt(np.mean(np.square(frames), axis=0) + 1e-12)
    envelope = np.maximum(0.0, np.diff(energy, prepend=energy[0]))
    if np.max(envelope) > 0:
        envelope = envelope / np.max(envelope)
    return envelope.astype(np.float32), hop


def _prepare_mono(samples: np.ndarray) -> np.ndarray:
    mono = np.mean(samples, axis=1).astype(np.float32)
    if len(mono) == 0:
        return np.zeros(1, dtype=np.float32)
    mono = mono - float(np.mean(mono))
    peak = float(np.max(np.abs(mono)))
    if peak > 0:
        mono = mono / peak
    return mono


def _estimate_tempo(envelope: np.ndarray, sample_rate: int, hop: int) -> float:
    if len(envelope) < 8 or np.max(envelope) <= 0:
        return 0.0

    # Downsample the envelope before autocorrelation so long tracks stay fast.
    if len(envelope) > 4096:
        source_x = np.linspace(0.0, 1.0, len(envelope), dtype=np.float32)
        target_x = np.linspace(0.0, 1.0, 4096, dtype=np.float32)
        reduced = np.interp(target_x, source_x, envelope).astype(np.float32)
        effective_hop = hop * (len(envelope) / len(reduced))
    else:
        reduced = envelope
        effective_hop = float(hop)

    centered = reduced - np.mean(reduced)
    fft_len = 1 << int(np.ceil(np.log2(max(2, len(centered) * 2 - 1))))
    spectrum = np.fft.rfft(centered, n=fft_len)
    corr = np.fft.irfft(spectrum * np.conj(spectrum), n=fft_len)[: len(centered)]
    min_bpm = 70.0
    max_bpm = 180.0
    min_lag = int(round((60.0 / max_bpm) * sample_rate / effective_hop))
    max_lag = int(round((60.0 / min_bpm) * sample_rate / effective_hop))
    if max_lag >= len(corr):
        max_lag = len(corr) - 1
    if min_lag >= max_lag:
        return 0.0

    lag = int(np.argmax(corr[min_lag : max_lag + 1]) + min_lag)
    if lag <= 0:
        return 0.0
    return float(60.0 * sample_rate / (lag * effective_hop))


def _estimate_beat_samples(
    envelope: np.ndarray,
    sample_rate: int,
    hop: int,
    tempo: float,
    total_samples: int,
) -> np.ndarray:
    if tempo <= 0:
        step = int(round(0.5 * sample_rate))
        return np.arange(0, total_samples, step, dtype=np.int64)

    beat_hop = max(1, int(round((60.0 / tempo) * sample_rate / hop)))
    peaks, _ = find_peaks(envelope, distance=max(1, beat_hop // 2), height=max(0.08, float(np.mean(envelope))))
    first_peak = int(peaks[0]) if len(peaks) else 0
    beat_frames = np.arange(first_peak, len(envelope), beat_hop, dtype=np.int64)
    beat_samples = beat_frames * hop
    return beat_samples[beat_samples < total_samples].astype(np.int64)


def compatibility_warnings(a: TrackAnalysis, b: TrackAnalysis, max_shift: float) -> list[str]:
    warnings: list[str] = []
    if a.tempo > 0 and b.tempo > 0:
        tempo_delta = abs(a.tempo - b.tempo) / max(a.tempo, b.tempo)
        if tempo_delta > max_shift:
            warnings.append(
                f"Tempo difference is {tempo_delta:.1%}, above the configured stretch limit."
            )
        elif tempo_delta > 0.04:
            warnings.append("Tempo match requires an audible time stretch.")

    loudness_delta = abs(a.rms_db - b.rms_db)
    if loudness_delta > 8:
        warnings.append(f"Loudness differs by {loudness_delta:.1f} dB; gain matching is important.")

    if a.low_energy_ratio > 0.42 and b.low_energy_ratio > 0.42:
        warnings.append("Both transition regions may have heavy bass; bass-swap style is recommended.")

    distance = key_distance(a.key, b.key)
    if a.key_confidence >= 0.12 and b.key_confidence >= 0.12 and distance not in (0, 5, 7):
        warnings.append(f"Estimated keys may clash: {a.key} to {b.key}.")

    warnings.extend(a.warnings)
    warnings.extend(b.warnings)
    return warnings


def activity_between(analysis: TrackAnalysis, start_sample: int, end_sample: int) -> float:
    start = max(0, int(start_sample // analysis.activity_hop_samples))
    end = min(len(analysis.activity), int(np.ceil(end_sample / analysis.activity_hop_samples)))
    if end <= start:
        return 0.0
    return float(np.mean(analysis.activity[start:end]))


def vocal_presence_between(analysis: TrackAnalysis, start_sample: int, end_sample: int) -> float:
    start = max(0, int(start_sample // analysis.activity_hop_samples))
    end = min(len(analysis.vocal_presence), int(np.ceil(end_sample / analysis.activity_hop_samples)))
    if end <= start:
        return 0.0
    return float(np.mean(analysis.vocal_presence[start:end]))


def key_distance(a: str, b: str) -> int:
    notes = _NOTE_NAMES
    if a not in notes or b not in notes:
        return 0
    delta = abs(notes.index(a) - notes.index(b)) % 12
    return min(delta, 12 - delta)


def _amp_to_db(value: float) -> float:
    return float(20.0 * np.log10(max(value, 1e-12)))


def _low_energy_ratio(mono: np.ndarray, sample_rate: int) -> float:
    window = mono[: min(len(mono), sample_rate * 45)]
    if len(window) == 0:
        return 0.0
    spectrum = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(len(window), 1.0 / sample_rate)
    total = float(np.sum(spectrum) + 1e-12)
    low = float(np.sum(spectrum[freqs <= 180.0]))
    return low / total


def _activity_curve(mono: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
    frame = max(1024, int(sample_rate * 0.25))
    hop = max(512, int(sample_rate * 0.125))
    if len(mono) < frame:
        padded = np.pad(mono, (0, frame - len(mono)))
    else:
        padded = mono
    frame_count = 1 + (len(padded) - frame) // hop
    frames = np.lib.stride_tricks.as_strided(
        padded,
        shape=(frame, frame_count),
        strides=(padded.strides[0], padded.strides[0] * hop),
        writeable=False,
    )
    rms = np.sqrt(np.mean(np.square(frames), axis=0) + 1e-12)
    if np.max(rms) > 0:
        rms = rms / np.max(rms)
    return rms.astype(np.float32), hop


_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")


def _estimate_key(mono: np.ndarray, sample_rate: int) -> tuple[str, float]:
    window = mono[: min(len(mono), sample_rate * 60)]
    if len(window) < 2048 or float(np.max(np.abs(window))) <= 1e-6:
        return "unknown", 0.0

    frame = 4096
    hop = 2048
    if len(window) < frame:
        window = np.pad(window, (0, frame - len(window)))
    frame_count = 1 + (len(window) - frame) // hop
    frames = np.lib.stride_tricks.as_strided(
        window,
        shape=(frame, frame_count),
        strides=(window.strides[0], window.strides[0] * hop),
        writeable=False,
    )
    frames = frames * np.hanning(frame)[:, None]
    spectrum = np.abs(np.fft.rfft(frames, axis=0))
    freqs = np.fft.rfftfreq(frame, 1.0 / sample_rate)
    mask = (freqs >= 55.0) & (freqs <= 1760.0)
    freqs = freqs[mask]
    spectrum = spectrum[mask]
    if len(freqs) == 0:
        return "unknown", 0.0

    midi = np.rint(69 + 12 * np.log2(freqs / 440.0)).astype(int)
    pitch_classes = np.mod(midi, 12)
    chroma = np.zeros(12, dtype=np.float64)
    weights = np.mean(spectrum, axis=1)
    for pitch_class, weight in zip(pitch_classes, weights):
        chroma[int(pitch_class)] += float(weight)
    total = float(np.sum(chroma))
    if total <= 1e-12:
        return "unknown", 0.0
    chroma /= total
    key_index = int(np.argmax(chroma))
    sorted_chroma = np.sort(chroma)
    confidence = float(sorted_chroma[-1] - sorted_chroma[-2]) if len(sorted_chroma) > 1 else 0.0
    return _NOTE_NAMES[key_index], round(confidence, 4)


def _vocal_presence_curve(mono: np.ndarray, sample_rate: int, hop: int) -> np.ndarray:
    frame = max(2048, int(sample_rate * 0.25))
    if len(mono) < frame:
        padded = np.pad(mono, (0, frame - len(mono)))
    else:
        padded = mono
    frame_count = 1 + (len(padded) - frame) // hop
    frames = np.lib.stride_tricks.as_strided(
        padded,
        shape=(frame, frame_count),
        strides=(padded.strides[0], padded.strides[0] * hop),
        writeable=False,
    )
    spectrum = np.abs(np.fft.rfft(frames * np.hanning(frame)[:, None], axis=0))
    freqs = np.fft.rfftfreq(frame, 1.0 / sample_rate)
    vocal = (freqs >= 300.0) & (freqs <= 3400.0)
    low = freqs < 180.0
    total = np.sum(spectrum, axis=0) + 1e-12
    vocal_ratio = np.sum(spectrum[vocal], axis=0) / total
    low_ratio = np.sum(spectrum[low], axis=0) / total
    presence = np.clip((vocal_ratio - low_ratio * 0.35 - 0.18) / 0.42, 0.0, 1.0)
    return presence.astype(np.float32)


def _estimate_phrase_samples(beat_samples: np.ndarray, beats_per_phrase: int) -> np.ndarray:
    if len(beat_samples) == 0:
        return np.asarray([], dtype=np.int64)
    return beat_samples[::beats_per_phrase].astype(np.int64)
