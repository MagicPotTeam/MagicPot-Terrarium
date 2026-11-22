import { createHash } from 'node:crypto'
import type { MagicAgentEventStore } from '../persistence/eventStore'

/** Durable namespace exclusion only. Neither presence nor absence grants execution. */
export const MANAGED_AGENT_COVERAGE_KIND = 'managed-agent-instance-coverage'
export const managedAgentCoverageId = (instanceId: string): string =>
  `managed-coverage:${createHash('sha256').update(JSON.stringify(instanceId)).digest('hex')}`

/**
 * Read the exact namespace identity, including tombstones and historical evidence,
 * without parsing/validating a possibly unsupported coverage body. Never convert
 * a read/integrity failure into a legacy fallback. This is not inspect()/clean.
 */
export const hasManagedAgentInstanceEvidence = (events: MagicAgentEventStore, instanceId: string): boolean =>
  events.hasResourceEvidence(MANAGED_AGENT_COVERAGE_KIND, managedAgentCoverageId(instanceId))

export class ManagedAgentOrdinaryAdmissionError extends Error {
  readonly code = 'MANAGED_AGENT_ORDINARY_ADMISSION'
  constructor() {
    super('Managed Agent identity is quarantined from ordinary lifecycle and mutation paths.')
    this.name = 'ManagedAgentOrdinaryAdmissionError'
  }
}
