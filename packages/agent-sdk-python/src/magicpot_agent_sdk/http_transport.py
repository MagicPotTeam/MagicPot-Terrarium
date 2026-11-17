from __future__ import annotations

import ipaddress
import json
import re
import socket
from typing import Iterator
from urllib.error import HTTPError
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, OpenerDirector, ProxyHandler, Request, build_opener, urlopen

from .contracts import JsonValue

# Dotted IPv4 in any form the C resolver accepts (127.1, 0x7f.1, 2130706433, octal parts).
# inet_aton alone also accepts trailing text after a space, so the shape is checked first.
_NUMERIC_IPV4 = re.compile(r"^[0-9a-fx]+(\.[0-9a-fx]+){0,3}$")


def _is_loopback_host(host: str | None) -> bool:
    """True when ``host`` can only name this machine: 127.0.0.0/8, ::1 (also IPv4-mapped and
    with a zone id), the unspecified 0.0.0.0 / ::, and ``localhost`` / ``*.localhost`` (RFC 6761),
    in any letter case, percent-encoded or with one trailing dot."""
    if not host:
        return False
    name = unquote(host).strip().lower()
    if name.startswith("[") and name.endswith("]"):
        name = name[1:-1]
    if name.endswith("."):
        name = name[:-1]
    if not name:
        return False
    if name == "localhost" or name.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(name)
    except ValueError:
        address = None
    if address is not None:
        mapped = getattr(address, "ipv4_mapped", None)
        if mapped is not None:
            address = mapped
        return address.is_loopback or address.is_unspecified
    if _NUMERIC_IPV4.match(name):
        try:
            packed = socket.inet_aton(name)
        except OSError:
            return False
        return packed[0] == 127 or packed == b"\0\0\0\0"
    return False


def _origin(url: str) -> tuple[str, str, int | None]:
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    try:
        port = parts.port
    except ValueError:
        port = -1
    if port is None:
        port = {"http": 80, "https": 443}.get(scheme)
    return scheme, unquote(parts.hostname or "").lower().rstrip("."), port


class _SameOriginRedirectHandler(HTTPRedirectHandler):
    """Follows a redirect only to the origin of the request (scheme, host and port).

    The loopback opener has no proxy, so following a redirect to another host would also reach
    that host directly, bypassing the user's proxy settings, with any custom headers attached."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _origin(newurl) != _origin(req.full_url):
            if fp is not None:
                fp.close()
            raise RuntimeError(
                f"MagicAgent server at {req.full_url} answered HTTP {code} with a redirect to another "
                f"origin ({newurl}); the SDK does not follow it."
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _loopback_opener() -> OpenerDirector:
    # ProxyHandler({}) disables every proxy (environment, Windows registry, macOS settings) for
    # this opener, so a request to this machine and its Bearer token never reach a proxy.
    return build_opener(ProxyHandler({}), _SameOriginRedirectHandler())


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
        # A loopback MagicPot is always reached directly; any other host keeps the default
        # opener, so a remote MagicPot is still reached through the user's proxy settings.
        self._opener = _loopback_opener() if _is_loopback_host(urlsplit(self._base_url).hostname) else None

    def _request(self, method: str, payload: JsonValue) -> Request:
        headers = {"content-type": "application/json"}
        credentials: dict[str, str] = {}
        for name, value in self._headers.items():
            if name.lower() == "authorization":
                credentials["authorization"] = value
            else:
                headers[name] = value
        if self._token:
            credentials["authorization"] = f"Bearer {self._token}"
        request = Request(
            f"{self._base_url}/v2/sdk/{method}",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        # urllib copies ordinary headers onto a redirected request but not unredirected ones, so
        # the credential is sent to the configured origin only, never to a host it redirects to.
        for name, value in credentials.items():
            request.add_unredirected_header(name, value)
        return request

    def _open(self, request: Request):
        if self._opener is not None:
            return self._opener.open(request, timeout=self._timeout)
        return urlopen(request, timeout=self._timeout)

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
            with self._open(self._request(method, payload)) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise self._http_error(error) from error

    def stream(self, method: str, payload: JsonValue) -> NdjsonStream:
        """Open an incremental, sync-compatible NDJSON response stream."""
        try:
            response = self._open(self._request(method, payload))
        except HTTPError as error:
            raise self._http_error(error) from error
        return NdjsonStream(response)
