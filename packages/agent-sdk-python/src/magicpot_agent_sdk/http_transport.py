from __future__ import annotations

import json
from typing import Iterator
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .contracts import JsonValue


class NdjsonStream(Iterator[JsonValue]):
    """Incremental NDJSON iterator that owns and closes its HTTP response."""

    def __init__(self, response):
        self._response = response
        self._lines = iter(response)
        self._closed = False

    def __iter__(self) -> NdjsonStream:
        return self

    def __next__(self) -> JsonValue:
        if self._closed:
            raise StopIteration
        try:
            while True:
                raw_line = next(self._lines)
                line = raw_line.decode("utf-8").strip()
                if line:
                    return json.loads(line)
        except StopIteration:
            self.close()
            raise
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._response.close()

    def __enter__(self) -> NdjsonStream:
        return self

    def __exit__(self, *_args) -> None:
        self.close()


class HttpAgentTransport:
    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        timeout: float = 30.0,
        headers: dict[str, str] | None = None,
    ):
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout
        self._headers = dict(headers or {})

    def _request(self, method: str, payload: JsonValue) -> Request:
        headers = {"content-type": "application/json", **self._headers}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        return Request(
            f"{self._base_url}/v2/sdk/{method}",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )

    @staticmethod
    def _http_error(error: HTTPError) -> RuntimeError:
        body = error.read().decode("utf-8")
        try:
            value = json.loads(body)
            message = value.get("message", body) if isinstance(value, dict) else body
        except json.JSONDecodeError:
            message = body
        return RuntimeError(message or f"MagicAgent request failed with HTTP {error.code}.")

    def request(self, method: str, payload: JsonValue) -> JsonValue:
        try:
            with urlopen(self._request(method, payload), timeout=self._timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise self._http_error(error) from error

    def stream(self, method: str, payload: JsonValue) -> NdjsonStream:
        """Open an incremental, sync-compatible NDJSON response stream."""
        try:
            response = urlopen(self._request(method, payload), timeout=self._timeout)
        except HTTPError as error:
            raise self._http_error(error) from error
        return NdjsonStream(response)
