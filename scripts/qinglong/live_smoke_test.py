from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = ROOT / "scripts" / "qinglong"

import sys

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import live_smoke


class LiveSmokeTest(unittest.TestCase):
    def test_parse_live_smoke_mode_defaults_and_rejects_unknown_values(self):
        self.assertEqual(live_smoke.parse_live_smoke_mode(None), "all")
        self.assertEqual(live_smoke.parse_live_smoke_mode("http"), "http")
        with self.assertRaises(ValueError):
            live_smoke.parse_live_smoke_mode("weird")

    def test_build_attachment_url_supports_file_and_data_urls(self):
        temp_file = ROOT / ".codex-tmp" / "research" / "live-smoke-test.png"
        temp_file.parent.mkdir(parents=True, exist_ok=True)
        temp_file.write_bytes(b"PNG")
        self.addCleanup(temp_file.unlink, missing_ok=True)

        self.assertTrue(live_smoke.build_attachment_url(temp_file, "file-url").startswith("file://"))
        self.assertTrue(live_smoke.build_attachment_url(temp_file, "data-url").startswith("data:image/png;base64,"))

    def test_summarize_response_extracts_ocr_metadata(self):
        response = {
            "content": '{"results":[{"fileName":"sample.png"}]}',
            "results": [
                {
                    "fileName": "sample.png",
                    "tags": [],
                    "ocrResult": {
                        "kind": "document",
                        "text": "MagicPot OCR Smoke 2026 Task Status: running",
                    },
                    "attachments": [
                        {
                            "type": "image",
                            "fileName": "layout.png",
                            "mimeType": "image/png",
                        }
                    ],
                }
            ],
            "provider": {
                "id": "paddle_ocr",
                "family": "ocr",
            },
            "runtime": {
                "cacheKey": "profile|paddle_ocr|http://127.0.0.1:7860|builtin-tagging|structured",
            },
            "inputCount": 1,
            "ocrResult": {
                "kind": "document",
                "text": "MagicPot OCR Smoke 2026 Task Status: running",
            },
            "attachments": [
                {
                    "type": "file",
                    "fileName": "layout.md",
                    "mimeType": "text/markdown",
                },
                {
                    "type": "file",
                    "fileName": "layout.json",
                    "mimeType": "application/json",
                },
                {
                    "type": "image",
                    "fileName": "layout.png",
                    "mimeType": "image/png",
                },
            ],
        }

        summary = live_smoke.summarize_response(response)

        self.assertEqual(summary["provider"]["id"], "paddle_ocr")
        self.assertEqual(summary["provider"]["family"], "ocr")
        self.assertEqual(summary["resultCount"], 1)
        self.assertTrue(summary["contentJsonParses"])
        self.assertTrue(summary["topLevelHasOcrResult"])
        self.assertIn("application/json", summary["attachmentMimeTypes"])
        self.assertIn("image/png", summary["attachmentMimeTypes"])
        self.assertIn("text/markdown", summary["attachmentMimeTypes"])
        self.assertIn("MagicPot OCR Smoke 2026", summary["ocrTextExcerpt"])

    def test_validate_response_summary_accepts_expected_ocr_payloads(self):
        summary = {
            "provider": {"id": "paddle_ocr", "family": "ocr"},
            "resultCount": 1,
            "contentJsonParses": True,
            "contentResultCount": 1,
            "topLevelHasOcrResult": True,
            "attachmentMimeTypes": ["application/json", "text/markdown", "image/png"],
            "attachmentFileNames": ["layout.json", "layout.md", "layout.png"],
            "ocrTextExcerpt": "MagicPot OCR Smoke 2026 Task Status: running",
        }

        errors = live_smoke.validate_response_summary(
            summary=summary,
            provider_id="paddle_ocr",
            provider_family="ocr",
            expected_tokens=["MagicPot", "running"],
            expected_min_tags=1,
        )

        self.assertEqual(errors, [])

    def test_validate_response_summary_rejects_missing_markdown_artifact(self):
        summary = {
            "provider": {"id": "paddle_ocr", "family": "ocr"},
            "resultCount": 1,
            "contentJsonParses": True,
            "contentResultCount": 1,
            "topLevelHasOcrResult": True,
            "attachmentMimeTypes": ["application/json", "image/png"],
            "attachmentFileNames": ["layout.json", "layout.png"],
            "ocrTextExcerpt": "MagicPot OCR Smoke 2026 Task Status: running",
        }

        errors = live_smoke.validate_response_summary(
            summary=summary,
            provider_id="paddle_ocr",
            provider_family="ocr",
            expected_tokens=["MagicPot", "running"],
            expected_min_tags=1,
        )

        self.assertTrue(any("markdown attachment artifact" in error for error in errors))

    def test_run_backend_smoke_surfaces_runtime_failures_as_structured_errors(self):
        class ExplodingBackend:
            def build_runtime(self, normalized):
                raise RuntimeError("boom")

            def infer(self, runtime, normalized, images):
                raise AssertionError("not reached")

        payload = {
            "provider": {
                "id": "wdtagger",
                "name": "WDTagger",
                "family": "tagger",
                "endpoint": "http://127.0.0.1:7899",
                "cacheKey": "",
            },
            "profile": {
                "id": "profile-1",
                "modelName": "WD14 Local",
                "taggerProvider": "wdtagger",
                "taggerEndpoint": "http://127.0.0.1:7899",
            },
            "request": {
                "skillId": "builtin-tagging",
                "outputMode": "structured",
                "systemPrompt": "tag this asset",
                "messages": [
                    {
                        "role": "user",
                        "content": "tag this asset",
                        "attachments": [
                            {
                                "type": "image",
                                "url": "data:image/png;base64,iVBORw0KGgo=",
                                "mimeType": "image/png",
                                "fileName": "sample.png",
                            }
                        ],
                    }
                ],
            },
        }

        with mock.patch.object(live_smoke.companion_server, "make_backend", return_value=ExplodingBackend()):
            result = live_smoke.run_backend_smoke(
                provider_id="wdtagger",
                payload=payload,
                qinglong_root=ROOT / ".codex-tmp" / "qinglong-captions",
                model_cache_dir=ROOT / ".cache" / "qinglong" / "models",
                temp_root=ROOT / ".cache" / "qinglong" / "http-tmp",
                repeat=1,
                expected_tokens=["MagicPot"],
                expected_min_tags=1,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["mode"], "backend")
        self.assertTrue(any("Backend runtime build failed" in error for error in result["errors"]))
        self.assertIn("RuntimeError: boom", result["errors"][0])
        self.assertIn("exception", result)
        self.assertIn("RuntimeError: boom", result["exception"])


if __name__ == "__main__":
    unittest.main()
