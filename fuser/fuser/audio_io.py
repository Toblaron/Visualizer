from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


@dataclass(frozen=True)
class AudioTrack:
    path: Path
    samples: np.ndarray
    sample_rate: int

    @property
    def channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def duration(self) -> float:
        return float(len(self.samples) / self.sample_rate)


def load_track(path: str | Path, sample_rate: int = 44_100) -> AudioTrack:
    source = Path(path)
    if not source.exists():
        raise FileNotFoundError(source)

    data, sr = sf.read(source, dtype="float32", always_2d=True)
    samples = data
    if sr != sample_rate:
        gcd = int(np.gcd(sr, sample_rate))
        up = sample_rate // gcd
        down = sr // gcd
        resampled = [
            resample_poly(samples[:, channel], up, down)
            for channel in range(samples.shape[1])
        ]
        min_len = min(len(channel) for channel in resampled)
        samples = np.stack([channel[:min_len] for channel in resampled], axis=1)

    samples = np.asarray(samples, dtype=np.float32)
    samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    samples = np.clip(samples, -1.0, 1.0)
    return AudioTrack(path=source, samples=samples, sample_rate=sample_rate)


def write_wav(path: str | Path, samples: np.ndarray, sample_rate: int) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    safe = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    sf.write(target, np.clip(safe, -1.0, 1.0), sample_rate, subtype="PCM_24")


def match_channel_count(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if a.shape[1] == b.shape[1]:
        return a, b
    if a.shape[1] == 1:
        a = np.repeat(a, b.shape[1], axis=1)
    elif b.shape[1] == 1:
        b = np.repeat(b, a.shape[1], axis=1)
    else:
        channels = min(a.shape[1], b.shape[1])
        a = a[:, :channels]
        b = b[:, :channels]
    return a, b
