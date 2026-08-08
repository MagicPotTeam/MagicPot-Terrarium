from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Protocol, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class ToolContext:
    request_id: str
    actor_kind: str
    actor_id: str
    session_id: str | None = None


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: Mapping[str, Any]
    output_schema: Mapping[str, Any] | None = None
    effects: tuple[str, ...] = ()


class ToolHandler(Protocol):
    def __call__(self, input: Any, context: ToolContext) -> Any | Awaitable[Any]: ...


@dataclass(frozen=True)
class ToolRegistration:
    definition: ToolDefinition
    invoke: ToolHandler


def define_tool(definition: ToolDefinition, invoke: ToolHandler) -> ToolRegistration:
    if not definition.name.strip():
        raise ValueError("Tool name must not be empty.")
    return ToolRegistration(definition, invoke)
