from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Sequence

PolicyEffectName = Literal["allow", "deny", "allow-with-constraints", "require-approval"]


@dataclass(frozen=True)
class PolicyEffect:
    kind: str
    risk: Literal["low", "medium", "high", "critical"]
    target: str | None = None


@dataclass(frozen=True)
class PolicyRequest:
    request_id: str
    actor: Mapping[str, str]
    origin: Mapping[str, Any]
    action: str
    target: Mapping[str, str]
    input: Any
    effects: tuple[PolicyEffect, ...] = ()
    version: int = 1
    discriminator: str = "magic-agent.policy-request.v1"


@dataclass(frozen=True)
class PolicyRule:
    rule_id: str
    priority: int
    effect: PolicyEffectName
    explanation: str
    actions: tuple[str, ...] = ()
    target_kinds: tuple[str, ...] = ()
    target_ids: tuple[str, ...] = ()
    effect_kinds: tuple[str, ...] = ()
    constraints: Mapping[str, Any] | None = None
    approval_requirement_id: str | None = None


@dataclass(frozen=True)
class PolicyDecision:
    effect: PolicyEffectName
    explanation: str
    matched_rule_ids: tuple[str, ...] = ()
    constraints: Mapping[str, Any] | None = None
    approval_requirement_id: str | None = None
    evaluated_at: int = 0
    policy_version: str = "sdk"


def _matches(request: PolicyRequest, rule: PolicyRule) -> bool:
    return (
        (not rule.actions or request.action in rule.actions)
        and (not rule.target_kinds or request.target.get("kind") in rule.target_kinds)
        and (not rule.target_ids or request.target.get("id") in rule.target_ids)
        and (
            not rule.effect_kinds
            or all(effect.kind in rule.effect_kinds for effect in request.effects)
        )
    )


def evaluate_policy(
    request: PolicyRequest,
    rules: Sequence[PolicyRule],
    *,
    evaluated_at: int,
    policy_version: str,
) -> PolicyDecision:
    matched = sorted((rule for rule in rules if _matches(request, rule)), key=lambda rule: (-rule.priority, rule.rule_id))
    if not matched:
        return PolicyDecision("deny", "No policy rule matched the request.", evaluated_at=evaluated_at, policy_version=policy_version)
    rule = matched[0]
    return PolicyDecision(
        rule.effect,
        rule.explanation,
        tuple(item.rule_id for item in matched),
        rule.constraints,
        rule.approval_requirement_id,
        evaluated_at,
        policy_version,
    )


def assert_policy_allowed(decision: PolicyDecision) -> None:
    if decision.effect == "deny":
        raise PermissionError(decision.explanation)
    if decision.effect == "require-approval":
        raise PermissionError(
            f"Approval required: {decision.approval_requirement_id or decision.explanation}"
        )
