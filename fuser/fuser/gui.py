from __future__ import annotations

import argparse
import cgi
import html
import json
import mimetypes
import shutil
import tempfile
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from dataclasses import asdict

from .pipeline import RenderJob, run_render_job

RUNS_DIR = Path.cwd() / "fuser-runs"


class FuserHandler(BaseHTTPRequestHandler):
    server_version = "FuserGUI/0.1"

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/":
            self._send_html(_index_page())
            return
        if path.startswith("/files/"):
            self._send_file(path.removeprefix("/files/"))
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/render":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        try:
            result = self._handle_render()
        except Exception as exc:
            self._send_html(_error_page(str(exc)), status=HTTPStatus.BAD_REQUEST)
            return
        self._send_html(_result_page(result))

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def _handle_render(self) -> dict[str, object]:
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            },
        )
        session_dir = Path(tempfile.mkdtemp(prefix="run-", dir=_runs_dir()))
        uploads = session_dir / "uploads"
        previews = session_dir / "previews"
        uploads.mkdir()
        previews.mkdir()

        track_a_path = _save_upload(form, "track_a", uploads / "track-a")
        track_b_path = _save_upload(form, "track_b", uploads / "track-b")

        sample_rate = _positive_int(_field_value(form, "sample_rate", "44100"), "sample rate")
        bars = _positive_int(_field_value(form, "bars", "16"), "bars")
        preview_count = _non_negative_int(_field_value(form, "preview_count", "3"), "preview count")
        max_tempo_shift = _positive_float(_field_value(form, "max_tempo_shift", "0.06"), "max tempo shift")
        style = _choice(_field_value(form, "style", "bass-swap"), {"bass-swap", "clean"}, "style")
        stretch_backend = _choice(_field_value(form, "stretch_backend", "auto"), {"auto", "rubberband", "fast"}, "stretch backend")
        allow_stretch = _field_value(form, "allow_stretch", "off") == "on"

        final_wav = session_dir / "fused.wav"
        report_json = session_dir / "report.json"
        preview_html = session_dir / "preview.html"
        result = run_render_job(
            RenderJob(
                track_a=track_a_path,
                track_b=track_b_path,
                output=final_wav,
                sample_rate=sample_rate,
                bars=bars,
                style=style,
                allow_stretch=allow_stretch,
                max_tempo_shift=max_tempo_shift,
                stretch_backend=stretch_backend,
                report=report_json,
                preview_dir=previews,
                preview_html=preview_html,
                preview_count=preview_count,
            )
        )

        session_id = session_dir.name
        return {
            "session": session_id,
            "report": asdict(result.report),
            "final_wav": f"/files/{session_id}/fused.wav",
            "report_json": f"/files/{session_id}/report.json",
            "preview_html": f"/files/{session_id}/preview.html",
            "preview_count": preview_count,
        }

    def _send_html(self, body: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, relative_path: str) -> None:
        root = _runs_dir().resolve()
        target = (root / unquote(relative_path)).resolve()
        if root not in target.parents and target != root:
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(target.stat().st_size))
        self.end_headers()
        with target.open("rb") as file:
            shutil.copyfileobj(file, self.wfile)


def _index_page() -> str:
    return _page(
        "Fuser",
        """
        <form action="/render" method="post" enctype="multipart/form-data">
          <section>
            <h2>Tracks</h2>
            <label>Outgoing track <input required type="file" name="track_a" accept="audio/*,.wav,.aif,.aiff,.flac,.ogg"></label>
            <label>Incoming track <input required type="file" name="track_b" accept="audio/*,.wav,.aif,.aiff,.flac,.ogg"></label>
          </section>
          <section>
            <h2>Render Settings</h2>
            <div class="grid">
              <label>Style
                <select name="style">
                  <option value="bass-swap">Bass swap</option>
                  <option value="clean">Clean</option>
                </select>
              </label>
              <label>Bars <input type="number" name="bars" min="1" max="64" value="16"></label>
              <label>Sample rate
                <select name="sample_rate">
                  <option value="44100">44100</option>
                  <option value="48000">48000</option>
                  <option value="22050">22050</option>
                </select>
              </label>
              <label>Preview count <input type="number" name="preview_count" min="0" max="10" value="3"></label>
              <label>Stretch backend
                <select name="stretch_backend">
                  <option value="auto">Auto</option>
                  <option value="fast">Fast</option>
                  <option value="rubberband">Rubber Band</option>
                </select>
              </label>
              <label>Max tempo shift <input type="number" name="max_tempo_shift" min="0.001" max="0.5" step="0.001" value="0.06"></label>
            </div>
            <label class="check"><input type="checkbox" name="allow_stretch" checked> Tempo match incoming track</label>
          </section>
          <button type="submit">Render Transition</button>
        </form>
        """,
    )


def _result_page(result: dict[str, object]) -> str:
    report = result["report"]
    assert isinstance(report, dict)
    warnings = report.get("warnings") or []
    candidates = report.get("candidates") or []
    rows = []
    for index, candidate in enumerate(candidates, start=1):
        if not isinstance(candidate, dict):
            continue
        preview_href = f"/files/{result['session']}/previews/candidate-{index:02d}.wav"
        rows.append(
            "<tr>"
            f"<td>{index}</td>"
            f"<td>{candidate.get('score')}</td>"
            f"<td>{candidate.get('transition_start_a')}s</td>"
            f"<td>{candidate.get('entry_start_b')}s</td>"
            f"<td><audio controls preload=\"metadata\" src=\"{preview_href}\"></audio></td>"
            "</tr>"
        )
    warning_items = "".join(f"<li>{html.escape(str(item))}</li>" for item in warnings) or "<li>None</li>"
    summary = _metadata_table(report, {"warnings", "candidates"})
    return _page(
        "Render Complete",
        f"""
        <section>
          <h2>Final Mix</h2>
          <audio controls preload="metadata" src="{result['final_wav']}"></audio>
          <p class="links">
            <a href="{result['final_wav']}">Final WAV</a>
            <a href="{result['report_json']}">JSON Report</a>
            <a href="{result['preview_html']}">HTML Preview</a>
          </p>
        </section>
        <section>
          <h2>Summary</h2>
          {summary}
        </section>
        <section>
          <h2>Candidates</h2>
          <table>
            <thead><tr><th>#</th><th>Score</th><th>Track A Start</th><th>Track B Entry</th><th>Preview</th></tr></thead>
            <tbody>{''.join(rows)}</tbody>
          </table>
        </section>
        <section class="warnings">
          <h2>Warnings</h2>
          <ul>{warning_items}</ul>
        </section>
        <p><a href="/">Render another transition</a></p>
        """,
    )


def _error_page(message: str) -> str:
    return _page(
        "Render Failed",
        f"""
        <section class="warnings">
          <h2>Error</h2>
          <p>{html.escape(message)}</p>
        </section>
        <p><a href="/">Back</a></p>
        """,
    )


def _page(title: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <style>
    :root {{ color-scheme: light; }}
    body {{ margin: 0; font-family: Arial, sans-serif; color: #151718; background: #f5f6f2; }}
    main {{ max-width: 1120px; margin: 0 auto; padding: 24px; }}
    h1 {{ margin: 0 0 18px; font-size: 30px; }}
    h2 {{ margin: 0 0 12px; font-size: 17px; }}
    section {{ background: #ffffff; border: 1px solid #d7dbd0; padding: 14px; margin-bottom: 12px; }}
    label {{ display: block; font-size: 13px; font-weight: 700; margin-bottom: 10px; }}
    input, select {{ box-sizing: border-box; width: 100%; margin-top: 5px; padding: 8px; border: 1px solid #aeb7bc; font: inherit; }}
    input[type="checkbox"] {{ width: auto; margin-right: 8px; }}
    .check {{ font-weight: 400; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }}
    button {{ background: #175f6d; color: white; border: 0; padding: 10px 14px; font: inherit; cursor: pointer; }}
    button:hover {{ background: #104c58; }}
    table {{ width: 100%; border-collapse: collapse; background: #fff; }}
    th, td {{ border: 1px solid #d7dbd0; padding: 8px; text-align: left; vertical-align: middle; }}
    th {{ background: #e9ece4; }}
    audio {{ width: min(320px, 100%); }}
    .links a {{ display: inline-block; margin-right: 12px; color: #175f6d; }}
    .warnings {{ background: #fff8df; border-color: #ddc66f; }}
  </style>
</head>
<body>
  <main>
    <h1>{html.escape(title)}</h1>
    {body}
  </main>
</body>
</html>
"""


def _metadata_table(values: dict[str, object], exclude: set[str]) -> str:
    rows = []
    for key, value in values.items():
        if key in exclude:
            continue
        rows.append(f"<tr><th>{html.escape(str(key))}</th><td>{html.escape(str(value))}</td></tr>")
    return f"<table><tbody>{''.join(rows)}</tbody></table>"


def _save_upload(form: cgi.FieldStorage, name: str, target_base: Path) -> Path:
    item = form[name] if name in form else None
    if item is None or not getattr(item, "filename", ""):
        raise ValueError(f"Missing upload: {name}")
    extension = Path(item.filename).suffix or ".wav"
    target = target_base.with_suffix(extension)
    with target.open("wb") as file:
        shutil.copyfileobj(item.file, file)
    return target


def _field_value(form: cgi.FieldStorage, name: str, default: str) -> str:
    value = form.getfirst(name, default)
    return str(value)


def _choice(value: str, allowed: set[str], label: str) -> str:
    if value not in allowed:
        raise ValueError(f"Invalid {label}.")
    return value


def _positive_int(value: str, label: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise ValueError(f"{label.capitalize()} must be positive.")
    return parsed


def _non_negative_int(value: str, label: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise ValueError(f"{label.capitalize()} must not be negative.")
    return parsed


def _positive_float(value: str, label: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise ValueError(f"{label.capitalize()} must be positive.")
    return parsed


def _runs_dir() -> Path:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    return RUNS_DIR


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Fuser local browser GUI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), FuserHandler)
    url = f"http://{args.host}:{args.port}/"
    print(f"Fuser GUI running at {url}")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping Fuser GUI")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
