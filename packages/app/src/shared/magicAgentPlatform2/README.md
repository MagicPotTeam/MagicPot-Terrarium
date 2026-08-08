# Magic Agent Platform 2 shared contracts

This directory is contract-only. The M2 policy module is a synchronous, dependency-free,
deterministic policy engine and does not connect to production main, IPC, preload, renderer,
runtime, persistence, or tool execution. A policy decision is not itself an execution bypass;
production enforcement will be integrated in a later slice.

The engine defaults to deny, treats unknown effect kinds as a hard deny, requires approval for
known high-risk/destructive effects, and only permits known read effects with conservative
constraints. Explicit rules may allow known high-risk effects only when they include the exact
request digest as well as narrow category matches. Such a digest exception binds the complete
canonical request, including target ID, input arguments, paths, and tool names, so target ID needs
no separate match field. Low-risk/read and no-effects rules retain their existing exact-category
requirements and do not require a digest. Legacy `confirmation` is evidence only and never grants
approval.

The shared module never authorizes an approval and exports no API that converts an
`ApprovalGrant`, consumption intent, receipt, or externally supplied decision into `allow`.
Grant, intent, and receipt parsers are data-contract boundaries for a future trusted main-process
store only. Consumption intents must carry `authorization: false`; their IDs are correlation and
integrity hashes, not authority. Grant constraints remain contract data, and merging/enforcement
is deferred to that trusted store.

`PolicyDecision` and request hashes detect accidental or malicious content changes but provide
integrity only, not authenticity. An untrusted party can recompute them. Downstream execution must
therefore re-evaluate the original request in trusted main-process code against trusted policy and
approval state; it must never authorize from an external decision's `effect` field. A matching
`requestDigests` entry is an exact-content exception, not proof of who created or approved either
the request or rule. Rule sources must eventually be limited to a trusted policy store or trusted
configuration; untrusted callers must not be allowed to supply digest-bearing allow rules.

Risk classification uses a kind-derived minimum. `filesystem.delete` is always destructive;
credential access, writes, process execution, UI interaction, package installation, external
messages, and generic tool invocation are at least high risk. Unknown kinds are hard denied.
Destructive effects always require approval even under a precise allow rule, while high-risk
allow rules must exactly identify origin, action, actor kind, target kind, and effect kinds and must
include the current `sha256:<64 lowercase hex>` request digest. Digest lists are non-empty and
unique. Legacy `confirmation` remains evidence only.

## Domain references

`MagicAgentDomainRef` adds an explicit semantic kind to an existing opaque identifier. It
distinguishes concepts such as an agent definition, an agent instance, a graph definition, a
graph run, and a session without imposing a common identifier format.

Domain references do not replace or redefine existing ID generation, storage paths, session-key
logic, or API contracts. Callers must continue to use the existing producers for those values;
for example, `createSessionDomainRef` delegates to the existing normalized agent-route session
key implementation and preserves that key exactly.

This directory contains additive, shared-only M0 contracts. It does not connect V2 behavior
to production runtimes or stores.

Domain-ref parsers accept only JSON-safe data properties, detach accepted values into frozen
plain records, and do not retain Proxy objects. Transparent Proxies cannot be identified reliably
in JavaScript; the boundary guarantee is instead that throwing Proxy traps are converted into
validation failures and never escape to callers.

## Migration preview plans

`migrationPlan.ts` defines the `magic-agent.migration-plan.v1` contract. Plans are JSON-safe,
deterministic, recursively frozen `preview-only` values. Valid routes are Graph V1 to the current
Graph V2 draft schema, Session V1/V2/V3 to Event Store V1, and Package Manifest V1 to preserved
Package Manifest V1. Package endpoint version `1` is the manifest schema version, not a package
business version such as `1.0.0`.

Graph plans contain exactly one validated `graph-v2-draft-preview` artifact and bind its `graphId`
to the source endpoint `resourceId`. Session and package plans cannot contain artifacts. Required
preconditions, steps, warnings, and rollback arrays remain non-empty.

Plan creators perform no filesystem or crypto I/O, never apply a migration, and require callers to
provide the source `sha256:<64 lowercase hex>` and timestamp. The parser preserves unknown
JSON-safe extension fields but returns a detached deep clone with all arrays and records frozen.
Shared references are preserved; cycles, accessors, proxies, unsafe keys, sparse arrays, and other
non-JSON-safe inputs are rejected with validation issues rather than allowed to escape the boundary.
