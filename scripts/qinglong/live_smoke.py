#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib import error, request

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = ROOT / "scripts" / "qinglong"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import companion_server


DEFAULT_MODE = "all"
DEFAULT_INPUT_MODE = "file-url"
DEFAULT_PROVIDER_ID = "paddle_ocr"
DEFAULT_TEXT_LINES = [
    "MagicPot OCR Smoke 2026",
    "Task Status: running",
]
DEFAULT_EXPECTED_OCR_TOKENS = [
    "MagicPot",
    "running",
]
DEFAULT_EXPECTED_MIN_TAGS = 1
DEFAULT_REPEAT = 2
FONT_CANDIDATES = (
    "arial.ttf",
    "segoeui.ttf",
    "consola.ttf",
    "DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/consola.ttf",
)
DEFAULT_CACHE_ROOT = ROOT / ".cache" / "qinglong"


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def parse_live_smoke_mode(value: Optional[str]) -> str:
    normalized = _normalize_text(value).lower()
    if not normalized:
        return DEFAULT_MODE
    if normalized in ("backend", "http", "all"):
        return normalized
    raise ValueError(f'Unsupported live smoke mode "{value}". Expected backend, http, or all.')


def parse_input_mode(value: Optional[str]) -> str:
    normalized = _normalize_text(value).lower()
    if not normalized:
        return DEFAULT_INPUT_MODE
    if normalized in ("file-url", "data-url"):
        return normalized
    raise ValueError(f'Unsupported input mode "{value}". Expected file-url or data-url.')


def infer_provider_family(provider_id: str) -> str:
    descriptor = companion_server.TAGGER_PROVIDER_REGISTRY.get(provider_id)
    if not descriptor:
        raise ValueError(f"Unsupported provider: {provider_id}")
    return descriptor.family


def default_model_name(provider_id: str) -> str:
    if provider_id == "wdtagger":
        return "WD14 Local"
    if provider_id == "cl_tagger":
        return "cella110n/cl_tagger"
    if provider_id == "paddle_ocr":
        return "PaddleOCR VL"
    raise ValueError(f"Unsupported provider: {provider_id}")


def default_system_prompt(provider_id: str) -> str:
    if infer_provider_family(provider_id) == "ocr":
        return "Extract readable document text and preserve layout."
    return "Tag this asset using the current MagicPot structured tagging schema."


def _load_font(size: int):
    try:
        from PIL import ImageFont
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "Pillow is required to generate the qinglong smoke image. "
            "Install the OCR environment first."
        ) from exc

    for candidate in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def create_sample_image(output_path: Path, text_lines: Sequence[str]) -> Path:
    try:
        from PIL import Image, ImageDraw
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "Pillow is required to generate the qinglong smoke image. "
            "Install the OCR environment first."
        ) from exc

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1600, 900), color="white")
    draw = ImageDraw.Draw(image)
    title_font = _load_font(56)
    body_font = _load_font(42)
    y = 120

    for index, line in enumerate(text_lines):
        font = title_font if index == 0 else body_font
        draw.text((120, y), line, fill="black", font=font)
        y += 120 if index == 0 else 90

    image.save(output_path, format="PNG")
    return output_path


def build_attachment_url(image_path: Path, input_mode: str) -> str:
    normalized_mode = parse_input_mode(input_mode)
    if normalized_mode == "file-url":
        return image_path.resolve().as_uri()
    encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def build_request_payload(*, provider_id: str, endpoint: str, attachment_url: str, file_name: str) -> Dict[str, Any]:
    descriptor = companion_server.TAGGER_PROVIDER_REGISTRY[provider_id]
    return {
        "provider": {
            "id": descriptor.id,
            "name": descriptor.name,
            "family": descriptor.family,
            "endpoint": endpoint,
            "cacheKey": "",
        },
        "profile": {
            "id": "magicpot-qinglong-smoke",
            "modelName": default_model_name(provider_id),
            "taggerProvider": provider_id,
            "taggerEndpoint": endpoint,
            "cacheScope": descriptor.cache_scope,
        },
        "request": {
            "skillId": "builtin-tagging",
            "outputMode": "structured",
            "systemPrompt": default_system_prompt(provider_id),
            "messages": [
                {
                    "role": "user",
                    "content": "Run the current MagicPot qinglong smoke request.",
                    "attachments": [
                        {
                            "type": "image",
                            "url": attachment_url,
                            "mimeType": "image/png",
                            "fileName": file_name,
                        }
                    ],
                }
            ],
        },
    }


def configure_qinglong_cache_env(
    *,
    qinglong_root: Path,
    cache_root: Path,
    model_cache_dir: Path,
    temp_root: Path,
) -> Dict[str, str]:
    env_map = {
        "QINGLONG_CAPTIONS_ROOT": str(qinglong_root),
        "QINGLONG_TEMP_ROOT": str(temp_root),
        "QINGLONG_MODEL_CACHE_DIR": str(model_cache_dir),
        "HF_HOME": str(cache_root / "huggingface"),
        "HUGGINGFACE_HUB_CACHE": str(cache_root / "huggingface" / "hub"),
        "PADDLE_PDX_CACHE_HOME": str(cache_root / "paddlex"),
        "PADDLE_HOME": str(cache_root / "paddle"),
        "XDG_CACHE_HOME": str(cache_root),
    }
    for key, value in env_map.items():
        os.environ[key] = value
    for path_key in (
        "QINGLONG_TEMP_ROOT",
        "QINGLONG_MODEL_CACHE_DIR",
        "HF_HOME",
        "HUGGINGFACE_HUB_CACHE",
        "PADDLE_PDX_CACHE_HOME",
        "PADDLE_HOME",
        "XDG_CACHE_HOME",
    ):
        Path(env_map[path_key]).mkdir(parents=True, exist_ok=True)
    return env_map


def _decode_json_response(body: bytes) -> Dict[str, Any]:
    if not body:
        return {}
    parsed = json.loads(body.decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("Expected a JSON object response.")
    return parsed


def http_json(url: str, *, method: str = "GET", payload: Optional[Dict[str, Any]] = None) -> Tuple[int, Dict[str, Any]]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    try:
        with request.urlopen(req, timeout=600) as response:
            return response.status, _decode_json_response(response.read())
    except error.HTTPError as exc:
        return exc.code, _decode_json_response(exc.read())


def unique_strings(values: Iterable[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for value in values:
        normalized = _normalize_text(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def describe_exception(exc: BaseException) -> str:
    exc_type = exc.__class__.__name__
    message = _normalize_text(exc)
    if not message:
        return exc_type
    return f"{exc_type}: {message}"


def summarize_response(response: Dict[str, Any]) -> Dict[str, Any]:
    provider = response.get("provider") if isinstance(response.get("provider"), dict) else {}
    runtime = response.get("runtime") if isinstance(response.get("runtime"), dict) else {}
    results = response.get("results") if isinstance(response.get("results"), list) else []
    first_result = results[0] if results and isinstance(results[0], dict) else {}
    top_level_attachments = response.get("attachments") if isinstance(response.get("attachments"), list) else []
    result_attachments = first_result.get("attachments") if isinstance(first_result.get("attachments"), list) else []
    attachments = top_level_attachments or result_attachments

    content_json_parses = False
    content_result_count: Optional[int] = None
    content_payload = response.get("content")
    if isinstance(content_payload, str) and content_payload:
        try:
            parsed_content = json.loads(content_payload)
        except json.JSONDecodeError:
            parsed_content = None
        if isinstance(parsed_content, dict):
            content_json_parses = True
            parsed_results = parsed_content.get("results")
            if isinstance(parsed_results, list):
                content_result_count = len(parsed_results)

    attachment_mime_types = unique_strings(
        attachment.get("mimeType")
        for attachment in attachments
        if isinstance(attachment, dict)
    )
    attachment_types = unique_strings(
        attachment.get("type")
        for attachment in attachments
        if isinstance(attachment, dict)
    )
    attachment_file_names = unique_strings(
        attachment.get("fileName")
        for attachment in attachments
        if isinstance(attachment, dict)
    )

    ocr_result = response.get("ocrResult") if isinstance(response.get("ocrResult"), dict) else {}
    if not ocr_result and isinstance(first_result.get("ocrResult"), dict):
        ocr_result = first_result.get("ocrResult")
    ocr_text = _normalize_text(ocr_result.get("text"))

    tags = first_result.get("tags") if isinstance(first_result.get("tags"), list) else []
    return {
        "provider": {
            "id": _normalize_text(provider.get("id")),
            "family": _normalize_text(provider.get("family")),
        },
        "runtime": {
            "cacheKey": _normalize_text(runtime.get("cacheKey")),
            "profileId": _normalize_text(runtime.get("profileId")),
            "modelName": _normalize_text(runtime.get("modelName")),
        },
        "inputCount": int(response.get("inputCount") or 0),
        "resultCount": len(results),
        "contentJsonParses": content_json_parses,
        "contentResultCount": content_result_count,
        "topLevelHasOcrResult": isinstance(response.get("ocrResult"), dict),
        "attachmentCount": len(attachments),
        "attachmentTypes": attachment_types,
        "attachmentMimeTypes": attachment_mime_types,
        "attachmentFileNames": attachment_file_names,
        "ocrTextExcerpt": ocr_text[:240],
        "tagCount": len(tags),
    }


def validate_response_summary(
    *,
    summary: Dict[str, Any],
    provider_id: str,
    provider_family: str,
    expected_tokens: Sequence[str],
    expected_min_tags: int,
) -> List[str]:
    errors: List[str] = []
    actual_provider_id = _normalize_text(summary.get("provider", {}).get("id"))
    actual_provider_family = _normalize_text(summary.get("provider", {}).get("family"))

    if actual_provider_id != provider_id:
        errors.append(f'Provider id mismatch: expected "{provider_id}", got "{actual_provider_id}".')
    if actual_provider_family != provider_family:
        errors.append(
            f'Provider family mismatch: expected "{provider_family}", got "{actual_provider_family}".'
        )
    if not bool(summary.get("contentJsonParses")):
        errors.append("Response content field did not parse as JSON.")
    content_result_count = summary.get("contentResultCount")
    result_count = int(summary.get("resultCount") or 0)
    if content_result_count is not None and content_result_count != result_count:
        errors.append(
            f"Parsed content result count mismatch: expected {result_count}, got {content_result_count}."
        )

    attachment_mime_types = {
        _normalize_text(value).lower() for value in summary.get("attachmentMimeTypes") or []
    }
    attachment_file_names = {
        _normalize_text(value).lower() for value in summary.get("attachmentFileNames") or []
    }

    if provider_family == "ocr":
        if not bool(summary.get("topLevelHasOcrResult")):
            errors.append("OCR smoke response did not include a top-level ocrResult.")

        excerpt = _normalize_text(summary.get("ocrTextExcerpt")).lower()
        for token in expected_tokens:
            normalized = _normalize_text(token).lower()
            if normalized and normalized not in excerpt:
                errors.append(f'OCR smoke response is missing expected token "{token}".')

        if "application/json" not in attachment_mime_types:
            errors.append("OCR smoke response did not include a JSON attachment artifact.")
        if not any(mime.startswith("image/") for mime in attachment_mime_types):
            errors.append("OCR smoke response did not include an image attachment artifact.")
        if not (
            "text/markdown" in attachment_mime_types
            or any(file_name.endswith(".md") for file_name in attachment_file_names)
        ):
            errors.append("OCR smoke response did not include a markdown attachment artifact.")
    else:
        tag_count = int(summary.get("tagCount") or 0)
        if tag_count < expected_min_tags:
            errors.append(
                f"Tagger smoke response returned {tag_count} tags, below the expected minimum {expected_min_tags}."
            )

    return errors


def run_backend_smoke(
    *,
    provider_id: str,
    payload: Dict[str, Any],
    qinglong_root: Path,
    model_cache_dir: Path,
    temp_root: Path,
    repeat: int,
    expected_tokens: Sequence[str],
    expected_min_tags: int,
) -> Dict[str, Any]:
    backend = companion_server.make_backend(
        mode="real",
        qinglong_root=qinglong_root,
        model_cache_dir=model_cache_dir,
    )
    normalized = companion_server.normalize_tagger_request(payload)
    images = companion_server.extract_images(normalized.messages)
    if not images:
        raise RuntimeError("Backend smoke did not extract any images from the request payload.")

    cache_key = companion_server.build_runtime_cache_key(normalized.provider, payload)
    build_started_at = time.time()
    try:
        runtime = backend.build_runtime(normalized)
    except Exception as exc:
        return {
            "ok": False,
            "mode": "backend",
            "runtimeBuildMs": round((time.time() - build_started_at) * 1000, 2),
            "repeat": repeat,
            "response": {},
            "errors": [
                f"Backend runtime build failed for provider {provider_id}: {describe_exception(exc)}"
            ],
            "exception": traceback.format_exc(),
        }
    build_runtime_ms = round((time.time() - build_started_at) * 1000, 2)

    infer_durations_ms: List[float] = []
    latest_response: Optional[Dict[str, Any]] = None
    for _ in range(repeat):
        started_at = time.time()
        with tempfile.TemporaryDirectory(prefix="magicpot-qinglong-backend-", dir=str(temp_root)) as request_dir:
            request_root = Path(request_dir)
            prepared_images = [
                (attachment, companion_server.write_temp_image(request_root, attachment))
                for attachment in images
            ]
            try:
                results = backend.infer(runtime, normalized, prepared_images)
            except Exception as exc:
                return {
                    "ok": False,
                    "mode": "backend",
                    "runtimeBuildMs": build_runtime_ms,
                    "inferDurationsMs": infer_durations_ms
                    + [round((time.time() - started_at) * 1000, 2)],
                    "repeat": repeat,
                    "response": {},
                    "errors": [
                        f"Backend inference failed for provider {provider_id}: {describe_exception(exc)}"
                    ],
                    "exception": traceback.format_exc(),
                }
            latest_response = companion_server.build_response_payload(
                normalized,
                cache_key,
                prepared_images,
                results,
            )
        infer_durations_ms.append(round((time.time() - started_at) * 1000, 2))

    if latest_response is None:
        raise RuntimeError("Backend smoke did not produce a response payload.")

    response_summary = summarize_response(latest_response)
    errors = validate_response_summary(
        summary=response_summary,
        provider_id=provider_id,
        provider_family=infer_provider_family(provider_id),
        expected_tokens=expected_tokens,
        expected_min_tags=expected_min_tags,
    )
    return {
        "ok": not errors,
        "mode": "backend",
        "runtimeBuildMs": build_runtime_ms,
        "inferDurationsMs": infer_durations_ms,
        "repeat": repeat,
        "response": response_summary,
        "errors": errors,
    }


def run_http_smoke(
    *,
    provider_id: str,
    payload: Dict[str, Any],
    qinglong_root: Path,
    model_cache_dir: Path,
    temp_root: Path,
    host: str,
    port: int,
    repeat: int,
    expected_tokens: Sequence[str],
    expected_min_tags: int,
) -> Dict[str, Any]:
    backend = companion_server.make_backend(
        mode="real",
        qinglong_root=qinglong_root,
        model_cache_dir=model_cache_dir,
    )
    server = companion_server.create_server(
        host=host,
        port=port,
        backend=backend,
        temp_root=temp_root,
        runtime_cache=companion_server.RuntimeCache(),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    base_url = f"http://{server.server_address[0]}:{server.server_address[1]}"
    infer_url = f"{base_url}{companion_server.TAGGER_ENDPOINT_PATH}"
    health_url = f"{base_url}{companion_server.HEALTH_ENDPOINT_PATH}"

    request_payload = json.loads(json.dumps(payload))
    request_payload["provider"]["endpoint"] = base_url
    request_payload["profile"]["taggerEndpoint"] = base_url

    try:
        health_status, health_payload = http_json(health_url)
        infer_durations_ms: List[float] = []
        response_summaries: List[Dict[str, Any]] = []
        cache_keys: List[str] = []
        statuses: List[int] = []

        for _ in range(repeat):
            started_at = time.time()
            status, response_payload = http_json(
                infer_url,
                method="POST",
                payload=request_payload,
            )
            infer_durations_ms.append(round((time.time() - started_at) * 1000, 2))
            statuses.append(status)
            summary = summarize_response(response_payload)
            response_summaries.append(summary)
            cache_keys.append(_normalize_text(summary.get("runtime", {}).get("cacheKey")))

        latest_summary = response_summaries[-1] if response_summaries else {}
        errors = validate_response_summary(
            summary=latest_summary,
            provider_id=provider_id,
            provider_family=infer_provider_family(provider_id),
            expected_tokens=expected_tokens,
            expected_min_tags=expected_min_tags,
        )

        if health_status != 200:
            errors.append(f"/healthz returned status {health_status} instead of 200.")
        if any(status != 200 for status in statuses):
            errors.append(f"{companion_server.TAGGER_ENDPOINT_PATH} returned non-200 status codes: {statuses}.")
        stable_cache_key = bool(cache_keys) and len(set(cache_keys)) == 1 and all(cache_keys)
        if repeat > 1 and not stable_cache_key:
            errors.append("HTTP smoke cacheKey changed across repeated requests.")

        return {
            "ok": not errors,
            "mode": "http",
            "baseUrl": base_url,
            "healthz": {
                "status": health_status,
                "service": _normalize_text(health_payload.get("service")),
                "endpoint": _normalize_text(health_payload.get("endpoint")),
            },
            "infer": {
                "status": statuses[-1] if statuses else 0,
                "statuses": statuses,
                "durationsMs": infer_durations_ms,
                "repeat": repeat,
                "cacheKeys": cache_keys,
                "cacheKeyStableAcrossRepeats": stable_cache_key,
            },
            "response": latest_summary,
            "errors": errors,
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repeatable live smoke for the MagicPot qinglong companion.")
    parser.add_argument("--mode", default=DEFAULT_MODE, help="backend, http, or all")
    parser.add_argument("--provider", default=DEFAULT_PROVIDER_ID, help="paddle_ocr, wdtagger, or cl_tagger")
    parser.add_argument("--input-mode", default=DEFAULT_INPUT_MODE, help="file-url or data-url")
    parser.add_argument("--repeat", type=int, default=DEFAULT_REPEAT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--qinglong-root", type=Path, default=None)
    parser.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE_ROOT)
    parser.add_argument(
        "--model-cache-dir",
        type=Path,
        default=DEFAULT_CACHE_ROOT / "models",
    )
    parser.add_argument(
        "--temp-root",
        type=Path,
        default=DEFAULT_CACHE_ROOT / "http-tmp",
    )
    parser.add_argument("--expected-token", action="append", default=[])
    parser.add_argument("--expected-min-tags", type=int, default=DEFAULT_EXPECTED_MIN_TAGS)
    parser.add_argument("--text-line", action="append", default=[])
    parser.add_argument("--output-json", type=Path, default=None)
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    mode = parse_live_smoke_mode(args.mode)
    provider_id = _normalize_text(args.provider).lower()
    if provider_id not in companion_server.TAGGER_PROVIDER_REGISTRY:
        raise ValueError(f"Unsupported provider: {args.provider}")

    qinglong_root = args.qinglong_root or companion_server._default_qinglong_root()
    if not qinglong_root:
        raise ValueError("Missing qinglong root. Set --qinglong-root or QINGLONG_CAPTIONS_ROOT.")
    qinglong_root = qinglong_root.resolve()
    if not qinglong_root.exists():
        raise FileNotFoundError(str(qinglong_root))

    input_mode = parse_input_mode(args.input_mode)
    repeat = max(int(args.repeat or 1), 1)
    text_lines = list(args.text_line or DEFAULT_TEXT_LINES)
    provider_family = infer_provider_family(provider_id)
    expected_tokens = list(args.expected_token or [])
    if provider_family == "ocr" and not expected_tokens:
        expected_tokens = list(DEFAULT_EXPECTED_OCR_TOKENS)

    cache_root = Path(args.cache_root).resolve()
    model_cache_dir = Path(args.model_cache_dir).resolve()
    temp_root = Path(args.temp_root).resolve()
    env_map = configure_qinglong_cache_env(
        qinglong_root=qinglong_root,
        cache_root=cache_root,
        model_cache_dir=model_cache_dir,
        temp_root=temp_root,
    )

    with tempfile.TemporaryDirectory(prefix="magicpot-qinglong-live-smoke-", dir=str(temp_root)) as smoke_dir:
        smoke_root = Path(smoke_dir)
        sample_image_path = create_sample_image(smoke_root / "magicpot-qinglong-smoke.png", text_lines)
        attachment_url = build_attachment_url(sample_image_path, input_mode)
        payload = build_request_payload(
            provider_id=provider_id,
            endpoint="http://127.0.0.1:7860",
            attachment_url=attachment_url,
            file_name=sample_image_path.name,
        )

        result: Dict[str, Any] = {
            "ok": True,
            "mode": mode,
            "provider": {
                "id": provider_id,
                "family": provider_family,
            },
            "inputMode": input_mode,
            "repeat": repeat,
            "qinglongRoot": str(qinglong_root),
            "cacheRoot": str(cache_root),
            "modelCacheDir": str(model_cache_dir),
            "tempRoot": str(temp_root),
            "env": env_map,
            "sampleImagePath": str(sample_image_path),
            "sampleTextLines": text_lines,
            "errors": [],
        }

        if mode in ("backend", "all"):
            backend_result = run_backend_smoke(
                provider_id=provider_id,
                payload=payload,
                qinglong_root=qinglong_root,
                model_cache_dir=model_cache_dir,
                temp_root=temp_root,
                repeat=repeat,
                expected_tokens=expected_tokens,
                expected_min_tags=args.expected_min_tags,
            )
            result["backend"] = backend_result
            result["errors"].extend(backend_result.get("errors") or [])

        if mode in ("http", "all"):
            http_result = run_http_smoke(
                provider_id=provider_id,
                payload=payload,
                qinglong_root=qinglong_root,
                model_cache_dir=model_cache_dir,
                temp_root=temp_root,
                host=args.host,
                port=args.port,
                repeat=repeat,
                expected_tokens=expected_tokens,
                expected_min_tags=args.expected_min_tags,
            )
            result["http"] = http_result
            result["errors"].extend(http_result.get("errors") or [])

        result["errors"] = unique_strings(result["errors"])
        result["ok"] = not result["errors"]

        output = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output_json:
            args.output_json.parent.mkdir(parents=True, exist_ok=True)
            args.output_json.write_text(output + "\n", encoding="utf-8")
        print(output)
        return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
