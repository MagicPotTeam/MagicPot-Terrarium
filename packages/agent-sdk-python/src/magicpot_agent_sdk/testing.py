from __future__ import annotations

from collections.abc import Callable
from .contracts import JsonValue


class MemoryAgentTransport:
    def __init__(self, handler: Callable[[str, JsonValue], JsonValue]):
        self._handler = handler
        self.requests: list[tuple[str, JsonValue]] = []

    def request(self, method: str, payload: JsonValue) -> JsonValue:
        self.requests.append((method, payload))
        return self._handler(method, payload)
