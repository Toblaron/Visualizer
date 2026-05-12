from __future__ import annotations

from dataclasses import asdict
from html import escape
from pathlib import Path
from typing import Any

from .render import RenderReport


def write_preview_html(path: str | Path, report: RenderReport, preview_dir: str | Path | None) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    preview_base = Path(preview_dir) if preview_dir else None
    rows = []
    for index, candidate in enumerate(report.candidates, start=1):
        audio = ""
        if preview_base is not None:
            preview_path = preview_base / f"candidate-{index:02d}.wav"
            if preview_path.exists():
                rel = _relative_link(target.parent, preview_path)
                audio = f'<audio controls preload="metadata" src="{escape(rel)}"></audio>'
        rows.append(
            "<tr>"
            f"<td>{index}</td>"
            f"<td>{candidate.score:.4f}</td>"
            f"<td>{candidate.transition_start_a:.3f}s</td>"
            f"<td>{candidate.entry_start_b:.3f}s</td>"
            f"<td>{candidate.activity_gap:.4f}</td>"
            f"<td>{candidate.vocal_overlap:.4f}</td>"
            f"<td>{candidate.phrase_penalty:.4f}</td>"
            f"<td>{candidate.harmonic_penalty:.4f}</td>"
            f"<td>{audio}</td>"
            "</tr>"
        )

    warnings = "".join(f"<li>{escape(warning)}</li>" for warning in report.warnings)
    metadata = _metadata_table(asdict(report), exclude={"warnings", "candidates"})
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fuser Preview</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 32px; color: #161616; background: #f7f7f5; }}
    main {{ max-width: 1180px; margin: 0 auto; }}
    h1 {{ font-size: 28px; margin: 0 0 20px; }}
    h2 {{ font-size: 18px; margin: 28px 0 10px; }}
    table {{ width: 100%; border-collapse: collapse; background: #fff; }}
    th, td {{ border: 1px solid #d8d8d2; padding: 8px; text-align: left; vertical-align: middle; }}
    th {{ background: #ededE7; }}
    audio {{ width: 220px; }}
    .warnings {{ background: #fff8df; border: 1px solid #e4ca75; padding: 12px 16px; }}
  </style>
</head>
<body>
  <main>
    <h1>Fuser Preview</h1>
    <h2>Render</h2>
    {metadata}
    <h2>Candidates</h2>
    <table>
      <thead>
        <tr>
          <th>#</th><th>Score</th><th>Track A Start</th><th>Track B Entry</th>
          <th>Activity Gap</th><th>Vocal Overlap</th><th>Phrase Penalty</th>
          <th>Harmonic Penalty</th><th>Preview</th>
        </tr>
      </thead>
      <tbody>{''.join(rows)}</tbody>
    </table>
    <h2>Warnings</h2>
    <ul class="warnings">{warnings or '<li>None</li>'}</ul>
  </main>
</body>
</html>
"""
    target.write_text(html, encoding="utf-8")


def _metadata_table(values: dict[str, Any], exclude: set[str]) -> str:
    rows = []
    for key, value in values.items():
        if key in exclude:
            continue
        rows.append(f"<tr><th>{escape(key)}</th><td>{escape(str(value))}</td></tr>")
    return f"<table><tbody>{''.join(rows)}</tbody></table>"


def _relative_link(base: Path, target: Path) -> str:
    try:
        return str(target.resolve().relative_to(base.resolve())).replace("\\", "/")
    except ValueError:
        return str(target).replace("\\", "/")
