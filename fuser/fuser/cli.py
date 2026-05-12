from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from .pipeline import RenderJob, run_render_job


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a beat-aware transition between two tracks.")
    parser.add_argument("track_a", help="Outgoing track.")
    parser.add_argument("track_b", help="Incoming track.")
    parser.add_argument("-o", "--output", default="fused.wav", help="Output WAV path.")
    parser.add_argument("--sample-rate", type=_positive_int, default=44_100, help="Render sample rate.")
    parser.add_argument("--bars", type=_positive_int, default=16, help="Transition length in 4/4 bars.")
    parser.add_argument("--style", choices=["bass-swap", "clean"], default="bass-swap")
    parser.add_argument("--no-stretch", action="store_true", help="Disable tempo matching.")
    parser.add_argument(
        "--stretch-backend",
        choices=["auto", "rubberband", "fast"],
        default="auto",
        help="Tempo stretch backend. auto uses Rubber Band if available, then falls back.",
    )
    parser.add_argument(
        "--max-tempo-shift",
        type=_positive_float,
        default=0.06,
        help="Maximum allowed tempo stretch ratio, e.g. 0.06 for 6%%.",
    )
    parser.add_argument("--report", help="Optional JSON report path.")
    parser.add_argument(
        "--preview-dir",
        help="Optional directory for short WAV previews of the top scored candidates.",
    )
    parser.add_argument("--preview-count", type=_non_negative_int, default=3, help="Number of candidate previews to export.")
    parser.add_argument("--preview-html", help="Optional HTML report path for auditioning candidate previews.")
    return parser


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        result = run_render_job(
            RenderJob(
                track_a=Path(args.track_a),
                track_b=Path(args.track_b),
                output=Path(args.output),
                sample_rate=args.sample_rate,
                bars=args.bars,
                style=args.style,
                allow_stretch=not args.no_stretch,
                max_tempo_shift=args.max_tempo_shift,
                stretch_backend=args.stretch_backend,
                report=Path(args.report) if args.report else None,
                preview_dir=Path(args.preview_dir) if args.preview_dir else None,
                preview_html=Path(args.preview_html) if args.preview_html else None,
                preview_count=args.preview_count,
            )
        )
        report_data = asdict(result.report)
    except (OSError, RuntimeError, ValueError) as exc:
        parser.exit(2, f"fuser: error: {exc}\n")

    print(json.dumps(report_data, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
