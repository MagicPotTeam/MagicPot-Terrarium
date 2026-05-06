#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import shutil
import sys
import tempfile
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, Iterable, List, Optional, Protocol, Tuple
from urllib.parse import unquote, urlparse
from urllib.request import url2pathname


TAGGER_ENDPOINT_PATH = "/tagger/v2/infer"
HEALTH_ENDPOINT_PATH = "/healthz"


@dataclass(frozen=True)
class TaggerProviderDescriptor:
    id: str
    name: str
    repo_id: str
    family: str = "tagger"
    preferred_output_mode: str = "structured"
    cache_scope: str = "profile"

    def to_response_payload(self, endpoint: str, cache_key: str) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "family": self.family,
            "endpoint": endpoint,
            "cacheKey": cache_key,
        }


@dataclass(frozen=True)
class ImageAttachment:
    data: bytes
    mime_type: str
    file_name: str
    suffix: str
    source_url: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


@dataclass(frozen=True)
class NormalizedTaggerRequest:
    provider: TaggerProviderDescriptor
    endpoint: str
    profile_id: str
    profile_model_name: str
    tagger_endpoint: str
    output_mode: str
    skill_id: str
    system_prompt: str
    messages: List[Dict[str, Any]]
    raw: Dict[str, Any]


TAGGER_PROVIDER_REGISTRY: Dict[str, TaggerProviderDescriptor] = {
    "wdtagger": TaggerProviderDescriptor(
        id="wdtagger",
        name="WDTagger",
        repo_id="SmilingWolf/wd-v1-4-moat-tagger-v2",
        preferred_output_mode="sidecar",
        cache_scope="profile",
    ),
    "cl_tagger": TaggerProviderDescriptor(
        id="cl_tagger",
        name="CL_tagger",
        repo_id="cella110n/cl_tagger",
        preferred_output_mode="structured",
        cache_scope="profile",
    ),
    "paddle_ocr": TaggerProviderDescriptor(
        id="paddle_ocr",
        name="Paddle OCR",
        repo_id="PaddleOCR",
        family="ocr",
        preferred_output_mode="structured",
        cache_scope="profile",
    ),
}


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def infer_tagger_provider_id(model_name: str, explicit_provider: str = "") -> Optional[str]:
    normalized = _normalize_text(explicit_provider).lower()
    if normalized in TAGGER_PROVIDER_REGISTRY:
        return normalized

    normalized = _normalize_text(model_name).lower()
    if not normalized:
        return None

    if any(marker in normalized for marker in ("cl_tagger", "cl tagger", "cella110n/cl_tagger")):
        return "cl_tagger"
    if any(marker in normalized for marker in ("wdtagger", "wd14", "moat-tagger", "smilingwolf")):
        return "wdtagger"
    if any(marker in normalized for marker in ("paddleocr", "paddle_ocr", "paddle ocr")):
        return "paddle_ocr"
    return None


def resolve_provider(payload: Dict[str, Any]) -> TaggerProviderDescriptor:
    provider_record = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    profile_record = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}

    provider_id = infer_tagger_provider_id(
        profile_record.get("modelName", ""),
        explicit_provider=provider_record.get("id", "") or profile_record.get("taggerProvider", ""),
    )
    if not provider_id:
        raise ValueError("Unsupported provider. Expected wdtagger, cl_tagger, or paddle_ocr.")

    return TAGGER_PROVIDER_REGISTRY[provider_id]


def resolve_endpoint(payload: Dict[str, Any]) -> str:
    provider_record = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    profile_record = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}
    endpoint = _normalize_text(provider_record.get("endpoint") or profile_record.get("taggerEndpoint"))
    if not endpoint:
        endpoint = _normalize_text(profile_record.get("baseUrl") or profile_record.get("base_url"))
    return endpoint.rstrip("/")


def resolve_output_mode(payload: Dict[str, Any], provider: TaggerProviderDescriptor) -> str:
    request_record = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    requested = _normalize_text(request_record.get("outputMode")).lower()
    if requested in ("structured", "sidecar"):
        return requested
    return provider.preferred_output_mode


def build_runtime_cache_key(provider: TaggerProviderDescriptor, payload: Dict[str, Any]) -> str:
    provider_record = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    profile_record = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}
    request_record = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    endpoint = resolve_endpoint(payload).lower()
    profile_id = _normalize_text(profile_record.get("id") or "")
    skill_id = _normalize_text(request_record.get("skillId") or "")
    output_mode = resolve_output_mode(payload, provider)
    cache_scope = _normalize_text(provider_record.get("cacheScope") or profile_record.get("cacheScope") or provider.cache_scope)

    if cache_scope == "provider":
        return "|".join([provider.id, endpoint, output_mode])
    if cache_scope == "endpoint":
        return "|".join([endpoint, _normalize_text(profile_record.get("modelName") or ""), output_mode])
    return "|".join([profile_id or "default", provider.id, endpoint, skill_id, output_mode])


def normalize_tagger_request(payload: Dict[str, Any]) -> NormalizedTaggerRequest:
    provider = resolve_provider(payload)
    request_record = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    profile_record = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}
    endpoint = resolve_endpoint(payload)
    if not endpoint:
        raise ValueError("Missing tagger endpoint or base URL.")

    return NormalizedTaggerRequest(
        provider=provider,
        endpoint=endpoint,
        profile_id=_normalize_text(profile_record.get("id")),
        profile_model_name=_normalize_text(profile_record.get("modelName")),
        tagger_endpoint=endpoint,
        output_mode=resolve_output_mode(payload, provider),
        skill_id=_normalize_text(request_record.get("skillId")),
        system_prompt=_normalize_text(request_record.get("systemPrompt")),
        messages=list(request_record.get("messages") or []),
        raw=payload,
    )


def _guess_suffix(mime_type: str, file_name: str) -> str:
    suffix = Path(file_name).suffix
    if suffix:
        return suffix
    guessed = mimetypes.guess_extension(mime_type or "")
    return guessed or ".bin"


def _decode_data_url(url: str) -> Tuple[bytes, str]:
    prefix, _, encoded = url.partition(",")
    if ";base64" not in prefix:
        raise ValueError("Only base64 data URLs are supported for inline attachments.")
    mime_type = prefix[5 : prefix.find(";")] if prefix.startswith("data:") else "application/octet-stream"
    return base64.b64decode(encoded), mime_type or "application/octet-stream"


def _read_file_url(url: str) -> Tuple[bytes, str, str]:
    parsed = urlparse(url)
    raw_path = parsed.path or ""
    if parsed.netloc and raw_path:
        raw_path = f"//{parsed.netloc}{raw_path}"
    elif parsed.netloc:
        raw_path = parsed.netloc
    local_path = url2pathname(unquote(raw_path))
    if len(local_path) >= 3 and local_path[0] == "/" and local_path[2] == ":":
        local_path = local_path[1:]
    path = Path(local_path)
    if not path.exists():
        raise FileNotFoundError(str(path))
    data = path.read_bytes()
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return data, mime_type, path.name


def _normalize_attachment(attachment: Dict[str, Any]) -> Optional[ImageAttachment]:
    if not isinstance(attachment, dict):
        return None

    url = _normalize_text(attachment.get("url") or attachment.get("image") or attachment.get("path"))
    if not url:
        return None

    file_name = _normalize_text(attachment.get("fileName") or attachment.get("name") or "tagger-input")
    mime_type = _normalize_text(attachment.get("mimeType") or attachment.get("mime_type"))

    if url.startswith("data:"):
        data, inferred_mime = _decode_data_url(url)
        mime_type = mime_type or inferred_mime
    elif url.startswith("file://"):
        data, inferred_mime, inferred_name = _read_file_url(url)
        mime_type = mime_type or inferred_mime
        if file_name == "tagger-input":
            file_name = inferred_name
    elif Path(url).exists():
        file_path = Path(url)
        data = file_path.read_bytes()
        mime_type = mime_type or (mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        if file_name == "tagger-input":
            file_name = file_path.name
    else:
        return None

    suffix = _guess_suffix(mime_type, file_name)
    return ImageAttachment(
        data=data,
        mime_type=mime_type or "application/octet-stream",
        file_name=file_name,
        suffix=suffix,
        source_url=url,
    )


def extract_images(messages: Iterable[Dict[str, Any]]) -> List[ImageAttachment]:
    images: List[ImageAttachment] = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        attachments = message.get("attachments")
        if not isinstance(attachments, list):
            continue
        for attachment in attachments:
            normalized = _normalize_attachment(attachment)
            if normalized and normalized.mime_type.startswith("image/"):
                images.append(normalized)
    return images


def write_temp_image(temp_root: Path, attachment: ImageAttachment) -> Path:
    temp_root.mkdir(parents=True, exist_ok=True)
    digest = attachment.sha256[:16]
    temp_path = temp_root / f"{digest}{attachment.suffix}"
    temp_path.write_bytes(attachment.data)
    return temp_path


def build_output_dir(path: Path) -> Path:
    return path.with_suffix("")


def _read_text_if_exists(path: Path) -> str:
    if not path.exists() or not path.is_file():
        return ""
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def build_output_attachments(output_dir: Path) -> List[Dict[str, Any]]:
    if not output_dir.exists() or not output_dir.is_dir():
        return []

    attachments: List[Dict[str, Any]] = []
    for artifact_path in sorted(output_dir.rglob("*")):
        if not artifact_path.is_file():
            continue
        mime_type = mimetypes.guess_type(artifact_path.name)[0] or "application/octet-stream"
        attachment_type = "image" if mime_type.startswith("image/") else "file"
        attachments.append(
            {
                "type": attachment_type,
                "url": artifact_path.resolve().as_uri(),
                "fileName": artifact_path.name,
                "mimeType": mime_type,
            }
        )
    return attachments


def build_magicpot_provider_metadata(
    provider: TaggerProviderDescriptor, endpoint: str, cache_key: str
) -> Dict[str, Any]:
    return provider.to_response_payload(endpoint=endpoint, cache_key=cache_key)


def build_magicpot_result(
    *,
    provider: TaggerProviderDescriptor,
    endpoint: str,
    cache_key: str,
    attachment: ImageAttachment,
    tags: List[str],
    caption: str,
    warnings: Optional[List[str]] = None,
    score: Optional[float] = None,
    raw: Optional[Dict[str, Any]] = None,
    canvas_item_id: Optional[str] = None,
    ocr_result: Optional[Dict[str, Any]] = None,
    attachments: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    tags_text = ", ".join(tags)
    payload: Dict[str, Any] = {
        "fileName": attachment.file_name,
        "canvasItemId": canvas_item_id,
        "tags": tags,
        "tagsText": tags_text,
        "caption": caption or tags_text,
        "warnings": warnings or [],
        "provider": build_magicpot_provider_metadata(provider, endpoint, cache_key),
        "raw": raw or {},
    }
    if score is not None:
        payload["score"] = score
    if isinstance(ocr_result, dict):
        payload["ocrResult"] = ocr_result
    if isinstance(attachments, list) and attachments:
        payload["attachments"] = attachments
    return payload


class RuntimeCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cache: Dict[str, Any] = {}

    def get_or_create(self, key: str, builder: Callable[[], Any]) -> Any:
        with self._lock:
            if key in self._cache:
                return self._cache[key]
            value = builder()
            self._cache[key] = value
            return value

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


class TaggerBackend(Protocol):
    def build_runtime(self, normalized: NormalizedTaggerRequest) -> Any:
        ...

    def infer(self, runtime: Any, normalized: NormalizedTaggerRequest, images: List[Tuple[ImageAttachment, Path]]) -> List[Dict[str, Any]]:
        ...


class StubTaggerBackend:
    def __init__(self) -> None:
        self.build_calls: List[str] = []
        self.infer_calls: List[Dict[str, Any]] = []

    def build_runtime(self, normalized: NormalizedTaggerRequest) -> Dict[str, Any]:
        self.build_calls.append(normalized.provider.id)
        return {
            "provider": normalized.provider.id,
            "output_mode": normalized.output_mode,
        }

    def infer(
        self,
        runtime: Any,
        normalized: NormalizedTaggerRequest,
        images: List[Tuple[ImageAttachment, Path]],
    ) -> List[Dict[str, Any]]:
        self.infer_calls.append(
            {
                "runtime": runtime,
                "provider": normalized.provider.id,
                "images": [attachment.file_name for attachment, _ in images],
            }
        )

        results: List[Dict[str, Any]] = []
        request_record = (
            normalized.raw.get("request")
            if isinstance(normalized.raw.get("request"), dict)
            else {}
        )
        simulated_ocr = (
            request_record.get("simulateOcr")
            if isinstance(request_record, dict)
            else None
        )
        for index, (attachment, _path) in enumerate(images, start=1):
            is_ocr_provider = normalized.provider.family == "ocr"
            tags = [] if is_ocr_provider else [normalized.provider.id, f"tag-{index}"]
            tags_text = ", ".join(tags)
            default_ocr_result = (
                {
                    "kind": "document",
                    "text": f"OCR {attachment.file_name}",
                    "sourceImageUrl": attachment.source_url,
                }
                if is_ocr_provider
                else None
            )
            ocr_result = default_ocr_result
            if simulated_ocr is True:
                ocr_result = {
                    "kind": "document",
                    "text": f"OCR {attachment.file_name}",
                    "sourceImageUrl": attachment.source_url,
                }
            elif isinstance(simulated_ocr, dict):
                ocr_result = dict(simulated_ocr)
            caption = (ocr_result or {}).get("text") if is_ocr_provider else tags_text
            results.append(
                {
                    "fileName": attachment.file_name,
                    "canvasItemId": None,
                    "tags": tags,
                    "tagsText": tags_text,
                    "caption": caption or tags_text,
                    "warnings": [],
                    "provider": {
                        "id": normalized.provider.id,
                        "name": normalized.provider.name,
                        "family": normalized.provider.family,
                        "endpoint": normalized.endpoint,
                        "cacheKey": runtime["cacheKey"] if isinstance(runtime, dict) and "cacheKey" in runtime else "",
                    },
                    "raw": {
                        "backend": "stub",
                        "provider": normalized.provider.id,
                        "outputMode": normalized.output_mode,
                        "family": normalized.provider.family,
                    },
                    **({"ocrResult": ocr_result} if ocr_result else {}),
                }
            )
        return results


class QinglongCaptionsBackend:
    def __init__(self, qinglong_root: Optional[Path], model_cache_dir: Path) -> None:
        self.qinglong_root = qinglong_root
        self.model_cache_dir = model_cache_dir
        self.paddlex_cache_home = Path(
            _normalize_text(os.environ.get("PADDLE_PDX_CACHE_HOME"))
            or (self.model_cache_dir.parent / "paddlex")
        )
        self._runtime_lock = threading.Lock()
        self._runtime_cache: Dict[str, Any] = {}
        self._imports_ready = False

    def _configure_import_path(self) -> None:
        if self._imports_ready or not self.qinglong_root:
            return
        root = self.qinglong_root.resolve()
        module_root = root / "module"
        for candidate in (root, module_root):
            candidate_text = str(candidate)
            if candidate_text not in sys.path:
                sys.path.insert(0, candidate_text)
        self._imports_ready = True

    def _build_wdtagger_args(self, normalized: NormalizedTaggerRequest) -> SimpleNamespace:
        provider = normalized.provider
        repo_id = provider.repo_id
        defaults = {
            "repo_id": repo_id,
            "model_dir": str(self.model_cache_dir),
            "force_download": False,
            "remove_parents_tag": True,
            "remove_underscore": False,
            "character_tag_expand": False,
            "undesired_tags": "",
            "tag_replacement": "",
            "add_tags_threshold": False,
            "use_quality_tags": True,
            "use_rating_tags": True,
            "use_model_tags": True,
            "use_rating_tags_as_last_tag": False,
            "character_tags_first": False,
            "frequency_tags": False,
            "always_first_tags": "",
            "general_threshold": 0.35,
            "character_threshold": 0.35,
            "thresh": 0.35,
            "caption_separator": ", ",
            "append_tags": False,
        }
        return SimpleNamespace(**defaults)

    def _build_paddle_ocr_args(self) -> SimpleNamespace:
        defaults = {
            "step_api_key": "",
            "ark_api_key": "",
            "qwenVL_api_key": "",
            "glm_api_key": "",
            "kimi_code_api_key": "",
            "kimi_api_key": "",
            "mistral_api_key": "",
            "pixtral_api_key": "",
            "gemini_api_key": "",
            "ocr_model": "paddle_ocr",
            "document_image": True,
            "vlm_image_model": "",
            "alm_model": "",
            "audio_task": "",
            "gemma4_model_id": "",
            "pair_dir": "",
            "max_retries": 1,
            "wait_time": 0.01,
            "dir_name": False,
            "tags_highlightrate": 0.0,
        }
        return SimpleNamespace(**defaults)

    def _build_paddle_ocr_config(self, normalized: NormalizedTaggerRequest) -> Dict[str, Any]:
        prompt = normalized.system_prompt or "Extract readable document text and preserve layout."
        return {
            "prompts": {
                "paddle_ocr_prompt": prompt,
            },
            "paddle_ocr": {
                "save_json": True,
                "save_markdown": True,
                "save_img": True,
                "save_xlsx": False,
                "save_html": False,
                "save_csv": False,
                "save_video": False,
            },
        }

    def _run_paddle_ocr(
        self,
        runtime: Dict[str, Any],
        normalized: NormalizedTaggerRequest,
        attachment: ImageAttachment,
        image_path: Path,
    ) -> Dict[str, Any]:
        api_process_batch = runtime["api_process_batch"]
        result = api_process_batch(
            uri=str(image_path),
            mime=attachment.mime_type,
            config=runtime["config"],
            args=runtime["args"],
            sha256hash=attachment.sha256,
        )
        output_dir = build_output_dir(image_path)
        attachments = build_output_attachments(output_dir)
        markdown_text = _read_text_if_exists(output_dir / f"{output_dir.name}.md")
        json_text = _read_text_if_exists(output_dir / f"{output_dir.name}.json")
        raw_text = _normalize_text(getattr(result, "raw", ""))
        metadata = getattr(result, "metadata", {})
        ocr_text = markdown_text or raw_text
        raw_payload: Dict[str, Any] = {
            "backend": "qinglong-captions",
            "provider": normalized.provider.id,
            "sourceImage": str(image_path),
            "ocrMetadata": metadata if isinstance(metadata, dict) else {},
        }
        if json_text:
            try:
                raw_payload["ocrJson"] = json.loads(json_text)
            except Exception:
                raw_payload["ocrJsonText"] = json_text
        ocr_result = {
            "kind": "document",
            "text": ocr_text,
            "sourceImageUrl": attachment.source_url,
            **(
                {"metadata": metadata}
                if isinstance(metadata, dict) and metadata
                else {}
            ),
        }
        return build_magicpot_result(
            provider=normalized.provider,
            endpoint=normalized.endpoint,
            cache_key=_runtime_cache_key(normalized),
            attachment=attachment,
            tags=[],
            caption=ocr_text or raw_text,
            warnings=[],
            raw=raw_payload,
            ocr_result=ocr_result,
            attachments=attachments,
        )

    def build_runtime(self, normalized: NormalizedTaggerRequest) -> Dict[str, Any]:
        self._configure_import_path()

        if not self.qinglong_root:
            raise RuntimeError(
                "qinglong-captions root is not configured. Set --qinglong-root or QINGLONG_CAPTIONS_ROOT."
            )

        if normalized.provider.id == "paddle_ocr":
            repair_paddlex_official_models_cache(self.paddlex_cache_home)

        if normalized.provider.id in ("wdtagger", "cl_tagger"):
            self.model_cache_dir.mkdir(parents=True, exist_ok=True)

            from utils import wdtagger

            args = self._build_wdtagger_args(normalized)
            ort_sess, input_name, label_data, parent_to_child_map = wdtagger.load_model_and_tags(args)
            processed_names = wdtagger.process_tags(label_data, args)
            return {
                "wdtagger": wdtagger,
                "args": args,
                "ort_sess": ort_sess,
                "input_name": input_name,
                "label_data": label_data,
                "parent_to_child_map": parent_to_child_map,
                "processed_names": processed_names,
                "cacheKey": "",
            }

        if normalized.provider.id == "paddle_ocr":
            from module.api_handler_v2 import api_process_batch

            return {
                "api_process_batch": api_process_batch,
                "args": self._build_paddle_ocr_args(),
                "config": self._build_paddle_ocr_config(normalized),
                "cacheKey": "",
            }

        raise ValueError(f"Unsupported provider: {normalized.provider.id}")

    def infer(
        self,
        runtime: Any,
        normalized: NormalizedTaggerRequest,
        images: List[Tuple[ImageAttachment, Path]],
    ) -> List[Dict[str, Any]]:
        if normalized.provider.id == "paddle_ocr":
            return [
                self._run_paddle_ocr(runtime, normalized, attachment, image_path)
                for attachment, image_path in images
            ]
        if normalized.provider.id not in ("wdtagger", "cl_tagger"):
            raise ValueError(f"Unsupported provider: {normalized.provider.id}")

        wdtagger = runtime["wdtagger"]
        args = runtime["args"]
        ort_sess = runtime["ort_sess"]
        input_name = runtime["input_name"]
        label_data = runtime["label_data"]
        parent_to_child_map = runtime["parent_to_child_map"]
        processed_names = runtime["processed_names"]

        is_cl_tagger = normalized.provider.id == "cl_tagger"
        local_paths = [path for _, path in images]
        batch_images = wdtagger.load_and_preprocess_batch([str(path) for path in local_paths], is_cl_tagger)
        if not batch_images:
            raise RuntimeError("qinglong-captions failed to preprocess any images.")

        probs = wdtagger.process_batch(batch_images, ort_sess, input_name)
        if probs is None:
            raise RuntimeError("qinglong-captions returned no probabilities.")

        request_record = normalized.raw.get("request") if isinstance(normalized.raw.get("request"), dict) else {}
        general_confidence = _coerce_float(request_record.get("generalThreshold"), args.general_threshold or args.thresh)
        character_confidence = _coerce_float(
            request_record.get("characterThreshold"), args.character_threshold or args.thresh
        )

        results: List[Dict[str, Any]] = []
        for attachment, image_path, prob in zip(images, local_paths, probs):
            image_attachment = attachment[0]
            tags_result = wdtagger.get_tags_official(
                prob,
                label_data,
                general_confidence,
                character_confidence,
                args.use_rating_tags,
                args.use_quality_tags,
                args.use_model_tags,
                processed_names,
            )
            tag_freq: Dict[str, int] = {}
            found_tags = wdtagger.assemble_final_tags(tags_result, args, parent_to_child_map, tag_freq)
            categorized = wdtagger.assemble_tags_json(
                tags_result,
                add_tags_threshold=args.add_tags_threshold,
                remove_parents_tag=args.remove_parents_tag,
                parent_to_child_map=parent_to_child_map,
            )
            score = _average_confidence(tags_result)
            raw = {
                "backend": "qinglong-captions",
                "provider": normalized.provider.id,
                "tags": categorized,
                "tagFrequencies": tag_freq,
                "sourceImage": str(image_path),
            }
            results.append(
                build_magicpot_result(
                    provider=normalized.provider,
                    endpoint=normalized.endpoint,
                    cache_key=_runtime_cache_key(normalized),
                    attachment=image_attachment,
                    tags=found_tags,
                    caption=", ".join(found_tags),
                    warnings=[],
                    score=score,
                    raw=raw,
                )
            )
        return results


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _average_confidence(tags_result: Dict[str, List[Tuple[str, float]]]) -> Optional[float]:
    confidences: List[float] = []
    for tags in tags_result.values():
        for _tag, confidence in tags:
            try:
                confidences.append(float(confidence))
            except (TypeError, ValueError):
                continue
    if not confidences:
        return None
    return round(sum(confidences) / len(confidences), 4)


def _runtime_cache_key(normalized: NormalizedTaggerRequest) -> str:
    provider_record = normalized.raw.get("provider") if isinstance(normalized.raw.get("provider"), dict) else {}
    cache_key = _normalize_text(provider_record.get("cacheKey"))
    if cache_key:
        return cache_key
    return "|".join(
        [
            normalized.profile_id or "default",
            normalized.provider.id,
            normalized.endpoint.lower(),
            normalized.skill_id,
            normalized.output_mode,
        ]
    )


def make_backend(
    *,
    mode: str,
    qinglong_root: Optional[Path],
    model_cache_dir: Path,
) -> TaggerBackend:
    if mode == "stub":
        return StubTaggerBackend()
    return QinglongCaptionsBackend(qinglong_root=qinglong_root, model_cache_dir=model_cache_dir)


def build_response_payload(
    normalized: NormalizedTaggerRequest,
    cache_key: str,
    images: List[Tuple[ImageAttachment, Path]],
    results: List[Dict[str, Any]],
) -> Dict[str, Any]:
    content_payload = {"results": results}
    ocr_result = next(
        (
            result.get("ocrResult")
            for result in results
            if isinstance(result, dict) and isinstance(result.get("ocrResult"), dict)
        ),
        None,
    )
    attachments = [
        attachment
        for result in results
        if isinstance(result, dict) and isinstance(result.get("attachments"), list)
        for attachment in result["attachments"]
        if isinstance(attachment, dict)
    ]

    payload: Dict[str, Any] = {
        "content": json.dumps(content_payload, ensure_ascii=False),
        "results": results,
        "provider": normalized.provider.to_response_payload(normalized.endpoint, cache_key),
        "runtime": {
            "profileId": normalized.profile_id,
            "modelName": normalized.profile_model_name,
            "outputMode": normalized.output_mode,
            "skillId": normalized.skill_id,
            "cacheKey": cache_key,
        },
        "inputCount": len(images),
    }
    if isinstance(ocr_result, dict):
        payload["ocrResult"] = ocr_result
    if attachments:
        payload["attachments"] = attachments
    return payload


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: Dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler: BaseHTTPRequestHandler) -> Dict[str, Any]:
    content_length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(content_length)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Request body must be valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Request body must be a JSON object.")
    return parsed


def _build_http_handler(
    *,
    backend: TaggerBackend,
    runtime_cache: RuntimeCache,
    temp_root: Path,
) -> type[BaseHTTPRequestHandler]:
    class CompanionHandler(BaseHTTPRequestHandler):
        server_version = "MagicPotQinglongCompanion/1.0"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
            return

        def do_GET(self) -> None:  # noqa: N802
            if self.path == HEALTH_ENDPOINT_PATH:
                _json_response(
                    self,
                    200,
                    {
                        "online": True,
                        "service": "qinglong-companion",
                        "endpoint": TAGGER_ENDPOINT_PATH,
                    },
                )
                return
            _json_response(
                self,
                404,
                {
                    "error": "not_found",
                    "message": f"Unsupported route: {self.path}",
                },
            )

        def do_POST(self) -> None:  # noqa: N802
            if self.path != TAGGER_ENDPOINT_PATH:
                _json_response(
                    self,
                    404,
                    {
                        "error": "not_found",
                        "message": f"Unsupported route: {self.path}",
                    },
                )
                return

            try:
                payload = _read_json_body(self)
                normalized = normalize_tagger_request(payload)
                images = extract_images(normalized.messages)
                if not images:
                    raise ValueError("No image attachments were found in the tagging request.")

                cache_key = _runtime_cache_key(normalized)

                def _build_cached_runtime() -> Any:
                    runtime = backend.build_runtime(normalized)
                    if isinstance(runtime, dict):
                        return {**runtime, "cacheKey": cache_key}
                    return runtime

                runtime = runtime_cache.get_or_create(cache_key, _build_cached_runtime)

                with tempfile.TemporaryDirectory(
                    prefix="magicpot-qinglong-http-",
                    dir=str(temp_root),
                ) as request_temp_dir:
                    request_temp_root = Path(request_temp_dir)
                    prepared_images = [
                        (attachment, write_temp_image(request_temp_root, attachment))
                        for attachment in images
                    ]
                    results = backend.infer(runtime, normalized, prepared_images)

                response_payload = build_response_payload(normalized, cache_key, prepared_images, results)
                _json_response(self, 200, response_payload)
            except ValueError as exc:
                _json_response(
                    self,
                    400,
                    {
                        "error": "bad_request",
                        "message": str(exc),
                    },
                )
            except Exception as exc:  # pragma: no cover - exercised by integration callers
                _json_response(
                    self,
                    500,
                    {
                        "error": "internal_error",
                        "message": str(exc),
                    },
                )

    return CompanionHandler


def create_server(
    *,
    host: str,
    port: int,
    backend: TaggerBackend,
    temp_root: Path,
    runtime_cache: Optional[RuntimeCache] = None,
) -> ThreadingHTTPServer:
    cache = runtime_cache or RuntimeCache()
    handler = _build_http_handler(backend=backend, runtime_cache=cache, temp_root=temp_root)
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def _default_qinglong_root() -> Optional[Path]:
    configured = _normalize_text(os.environ.get("QINGLONG_CAPTIONS_ROOT"))
    return Path(configured) if configured else None


def _default_model_cache_dir() -> Path:
    configured = _normalize_text(os.environ.get("QINGLONG_MODEL_CACHE_DIR"))
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / "magicpot-qinglong-models"


def _default_temp_root() -> Path:
    configured = _normalize_text(os.environ.get("QINGLONG_TEMP_ROOT"))
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / "magicpot-qinglong-http"


def repair_paddlex_official_models_cache(cache_home: Path) -> List[Path]:
    """Promote partially downloaded PaddleX model artifacts into valid bundles."""

    official_models_root = Path(cache_home) / "official_models"
    repaired_paths: List[Path] = []
    if not official_models_root.exists():
        return repaired_paths

    for bundle_dir in official_models_root.iterdir():
        if not bundle_dir.is_dir():
            continue

        tmp_dirs = [
            child
            for child in bundle_dir.iterdir()
            if child.is_dir() and (child.name.endswith("_tmp") or child.name.startswith("._tmp"))
        ]
        for tmp_dir in tmp_dirs:
            for source_path in tmp_dir.rglob("*"):
                if not source_path.is_file():
                    continue
                target_path = bundle_dir / source_path.relative_to(tmp_dir)
                if target_path.exists():
                    continue
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, target_path)
                repaired_paths.append(target_path)

    return repaired_paths


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MagicPot qinglong-captions companion server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--mode", choices=("stub", "real"), default="stub")
    parser.add_argument("--qinglong-root", type=Path, default=_default_qinglong_root())
    parser.add_argument("--model-cache-dir", type=Path, default=_default_model_cache_dir())
    parser.add_argument("--temp-root", type=Path, default=_default_temp_root())
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    backend = make_backend(
        mode=args.mode,
        qinglong_root=args.qinglong_root,
        model_cache_dir=args.model_cache_dir,
    )
    temp_root = args.temp_root
    temp_root.mkdir(parents=True, exist_ok=True)
    server = create_server(
        host=args.host,
        port=args.port,
        backend=backend,
        temp_root=temp_root,
    )
    print(
        f"[qinglong-companion] listening on http://{args.host}:{server.server_address[1]}{TAGGER_ENDPOINT_PATH}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
