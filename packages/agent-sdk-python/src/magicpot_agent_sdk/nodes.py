from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Mapping, Protocol


@dataclass(frozen=True)
class NodeContext:
    request_id: str
    actor_kind: str
    actor_id: str
    graph_id: str | None = None
    node_id: str | None = None
    session_id: str | None = None


@dataclass(frozen=True)
class NodeDefinition:
    type: str
    version: str
    input_schema: Mapping[str, Any]
    output_schema: Mapping[str, Any]


class NodeHandler(Protocol):
    def __call__(self, input: Any, context: NodeContext) -> Any | Awaitable[Any]: ...


@dataclass(frozen=True)
class NodeRegistration:
    definition: NodeDefinition
    run: NodeHandler


def define_node(definition: NodeDefinition, run: NodeHandler) -> NodeRegistration:
    if not definition.type.strip() or not definition.version.strip():
        raise ValueError("Node type and version must not be empty.")
    return NodeRegistration(definition, run)
