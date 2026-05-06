from __future__ import annotations

import base64
import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from urllib import error, request


ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = ROOT / "scripts" / "qinglong"

import sys

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import companion_server


def _make_data_url() -> str:
    payload = b"PNG"
    return "data:image/png;base64," + base64.b64encode(payload).decode("ascii")


def _make_payload(provider_id: str = "wdtagger", model_name: str = "WD14 Local") -> dict:
    family = "ocr" if provider_id == "paddle_ocr" else "tagger"
    return {
        "provider": {
            "id": provider_id,
            "name": "Paddle OCR" if provider_id == "paddle_ocr" else "WDTagger",
            "family": family,
            "endpoint": "http://127.0.0.1:7899",
            "cacheKey": f"profile-1|{provider_id}|http://127.0.0.1:7899|builtin-tagging|structured",
        },
        "profile": {
            "id": "profile-1",
            "modelName": model_name,
            "taggerProvider": provider_id,
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
                            "url": _make_data_url(),
                            "mimeType": "image/png",
                            "fileName": "sample.png",
                        }
                    ],
                }
            ],
        },
    }


class CompanionServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = Path(tempfile.mkdtemp(prefix="magicpot-qinglong-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_root, ignore_errors=True)

    def _start_server(self, backend: companion_server.TaggerBackend):
        server = companion_server.create_server(
            host="127.0.0.1",
            port=0,
            backend=backend,
            temp_root=self.temp_root,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    def _post_json(self, url: str, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def _get_json(self, url: str):
        with request.urlopen(url, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def test_normalize_tagger_request_and_extract_images(self):
        payload = _make_payload()
        normalized = companion_server.normalize_tagger_request(payload)
        images = companion_server.extract_images(normalized.messages)

        self.assertEqual(normalized.provider.id, "wdtagger")
        self.assertEqual(normalized.output_mode, "structured")
        self.assertEqual(normalized.profile_id, "profile-1")
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].file_name, "sample.png")
        self.assertEqual(images[0].mime_type, "image/png")
        self.assertEqual(images[0].data, b"PNG")

    def test_http_infer_returns_magicpot_schema_and_reuses_runtime_cache(self):
        backend = companion_server.StubTaggerBackend()
        server, thread = self._start_server(backend)
        try:
            url = f"http://{server.server_address[0]}:{server.server_address[1]}{companion_server.TAGGER_ENDPOINT_PATH}"
            payload = _make_payload()

            status, response = self._post_json(url, payload)
            self.assertEqual(status, 200)
            self.assertIn("results", response)
            self.assertIn("content", response)
            self.assertEqual(response["provider"]["id"], "wdtagger")
            self.assertEqual(response["runtime"]["profileId"], "profile-1")
            self.assertEqual(response["results"][0]["fileName"], "sample.png")
            self.assertEqual(response["results"][0]["tags"], ["wdtagger", "tag-1"])
            self.assertEqual(response["results"][0]["tagsText"], "wdtagger, tag-1")
            self.assertEqual(response["results"][0]["caption"], "wdtagger, tag-1")
            self.assertEqual(response["results"][0]["raw"]["backend"], "stub")
            self.assertEqual(
                json.loads(response["content"]),
                {"results": response["results"]},
            )

            status, response_repeat = self._post_json(url, payload)
            self.assertEqual(status, 200)
            self.assertEqual(response_repeat["results"][0]["tags"], ["wdtagger", "tag-1"])
            self.assertEqual(len(backend.build_calls), 1)
            self.assertEqual(len(backend.infer_calls), 2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_http_healthz_reports_service_metadata(self):
        backend = companion_server.StubTaggerBackend()
        server, thread = self._start_server(backend)
        try:
            url = f"http://{server.server_address[0]}:{server.server_address[1]}{companion_server.HEALTH_ENDPOINT_PATH}"
            status, response = self._get_json(url)
            self.assertEqual(status, 200)
            self.assertEqual(response["online"], True)
            self.assertEqual(response["service"], "qinglong-companion")
            self.assertEqual(response["endpoint"], companion_server.TAGGER_ENDPOINT_PATH)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_http_infer_can_surface_structured_ocr_payloads(self):
        backend = companion_server.StubTaggerBackend()
        server, thread = self._start_server(backend)
        try:
            url = f"http://{server.server_address[0]}:{server.server_address[1]}{companion_server.TAGGER_ENDPOINT_PATH}"
            payload = _make_payload()
            payload["request"]["simulateOcr"] = {
                "kind": "document",
                "text": "sample ocr",
                "sourceImageUrl": payload["request"]["messages"][0]["attachments"][0]["url"],
            }

            status, response = self._post_json(url, payload)
            self.assertEqual(status, 200)
            self.assertEqual(
                response["ocrResult"],
                {
                    "kind": "document",
                    "text": "sample ocr",
                    "sourceImageUrl": payload["request"]["messages"][0]["attachments"][0]["url"],
                },
            )
            self.assertEqual(response["results"][0]["ocrResult"]["text"], "sample ocr")
            self.assertEqual(
                json.loads(response["content"])["results"][0]["ocrResult"]["kind"],
                "document",
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_http_infer_supports_ocr_provider_families_without_a_second_endpoint(self):
        backend = companion_server.StubTaggerBackend()
        server, thread = self._start_server(backend)
        try:
            url = f"http://{server.server_address[0]}:{server.server_address[1]}{companion_server.TAGGER_ENDPOINT_PATH}"
            payload = _make_payload(provider_id="paddle_ocr", model_name="PaddleOCR VL")

            status, response = self._post_json(url, payload)
            self.assertEqual(status, 200)
            self.assertEqual(response["provider"]["id"], "paddle_ocr")
            self.assertEqual(response["provider"]["family"], "ocr")
            self.assertEqual(response["results"][0]["tags"], [])
            self.assertEqual(response["results"][0]["ocrResult"]["kind"], "document")
            self.assertEqual(response["results"][0]["ocrResult"]["text"], "OCR sample.png")
            self.assertEqual(response["ocrResult"]["sourceImageUrl"], payload["request"]["messages"][0]["attachments"][0]["url"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_repair_paddlex_official_models_cache_promotes_tmp_params_into_bundle_root(self):
        cache_home = self.temp_root / "paddlex"
        bundle_root = cache_home / "official_models" / "PP-DocLayoutV3"
        tmp_dir = bundle_root / "._tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        (bundle_root / "inference.json").write_text("{}", encoding="utf-8")
        (tmp_dir / "inference.pdiparams").write_bytes(b"binary-params")

        repaired = companion_server.repair_paddlex_official_models_cache(cache_home)

        self.assertIn(bundle_root / "inference.pdiparams", repaired)
        self.assertTrue((bundle_root / "inference.pdiparams").exists())
        self.assertEqual((bundle_root / "inference.pdiparams").read_bytes(), b"binary-params")

    def test_extract_images_supports_windows_file_urls(self):
        image_path = self.temp_root / "sample image.png"
        image_path.write_bytes(b"PNG")
        payload = _make_payload()
        payload["request"]["messages"][0]["attachments"][0]["url"] = image_path.as_uri()
        payload["request"]["messages"][0]["attachments"][0]["fileName"] = "sample image.png"

        normalized = companion_server.normalize_tagger_request(payload)
        images = companion_server.extract_images(normalized.messages)

        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].file_name, "sample image.png")
        self.assertEqual(images[0].data, b"PNG")

    def test_http_rejects_payloads_without_image_attachments(self):
        backend = companion_server.StubTaggerBackend()
        server, thread = self._start_server(backend)
        try:
            url = f"http://{server.server_address[0]}:{server.server_address[1]}{companion_server.TAGGER_ENDPOINT_PATH}"
            payload = _make_payload()
            payload["request"]["messages"] = [{"role": "user", "content": "no attachments"}]

            body = json.dumps(payload).encode("utf-8")
            req = request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(error.HTTPError) as exc_info:
                request.urlopen(req, timeout=10)

            self.assertEqual(exc_info.exception.code, 400)
            payload_json = json.loads(exc_info.exception.read().decode("utf-8"))
            self.assertEqual(payload_json["error"], "bad_request")
            self.assertIn("No image attachments", payload_json["message"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
