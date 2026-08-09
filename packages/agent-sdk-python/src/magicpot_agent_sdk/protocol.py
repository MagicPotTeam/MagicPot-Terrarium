from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

SUPPORTED_RUNTIME_PROTOCOL_MAJOR_VERSIONS = (2,)
RUNTIME_PROTOCOL_VERSION = "2.0.0"


def _nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _envelope_error(value: Any) -> str | None:
    if not isinstance(value, dict):
        return "Envelope must be an object."
    version = value.get("protocolVersion")
    if not isinstance(version, str):
        return "protocolVersion must be a string."
    try:
        major = int(version.split(".", 1)[0])
    except (TypeError, ValueError):
        return f"Unsupported runtime protocol version: {version}"
    if major not in SUPPORTED_RUNTIME_PROTOCOL_MAJOR_VERSIONS:
        return f"Unsupported runtime protocol version: {version}"
    if not _nonempty(value.get("id")):
        return "id is required."
    if not _nonempty(value.get("type")):
        return "type is required."
    if not isinstance(value.get("createdAt"), (int, float)):
        return "createdAt must be a finite number."
    if "payload" not in value:
        return "payload is required."
    return None


@dataclass(frozen=True)
class ParseResult:
    ok: bool
    value: Mapping[str, Any] | None = None
    error: str | None = None


def parse_magic_agent_envelope(value: Any) -> ParseResult:
    error = _envelope_error(value)
    return ParseResult(False, error=error) if error else ParseResult(True, value=value)


def parse_magic_agent_command(value: Any) -> ParseResult:
    parsed = parse_magic_agent_envelope(value)
    if not parsed.ok:
        return parsed
    if value.get("envelopeKind") != "command":
        return ParseResult(False, error='envelopeKind must equal "command".')
    actor = value.get("actor")
    if not isinstance(actor, dict) or not _nonempty(actor.get("kind")) or not _nonempty(actor.get("id")):
        return ParseResult(False, error="actor.kind and actor.id are required.")
    if not _nonempty(value.get("idempotencyKey")):
        return ParseResult(False, error="idempotencyKey is required.")
    return parsed


def parse_magic_agent_event(value: Any) -> ParseResult:
    parsed = parse_magic_agent_envelope(value)
    if not parsed.ok:
        return parsed
    if value.get("envelopeKind") != "event":
        return ParseResult(False, error='envelopeKind must equal "event".')
    if not _nonempty(value.get("streamId")):
        return ParseResult(False, error="streamId is required.")
    sequence = value.get("sequence")
    if not isinstance(sequence, int) or sequence < 0:
        return ParseResult(False, error="sequence must be a non-negative integer.")
    return parsed
