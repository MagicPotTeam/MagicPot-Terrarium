# Main-process policy authorization

This module is a main-process trust boundary. It owns policy evaluation, approval grant
validation, atomic grant consumption, durable audit records, and branded one-shot execution
permits. Callers provide requests and stable command identifiers, never decisions.

Approval and audit state/events contain only redacted request copies; request digests are
computed from the validated original request. This store intentionally supports only
request-scoped approvals. The durable grant scope is always
`{ kind: 'request', value: decision.requestDigest }`; action, target, and session approval
requirements are rejected.

Permits are branded by a private `WeakSet` owned by each service instance. A permit from a
clone, another service instance, or a previous process is never trusted; callers must use
`service.isTrustedPermit(value)` and still consume it through the service. Authorization
replay and permit consumption re-evaluate current policy, while approval-backed permits also
remain bound to their durable grant and receipt. Permits are deliberately not wired to Tool
or IPC production paths by this milestone.
