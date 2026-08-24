import type {
  ComfyDispatchTarget,
  ComfyInstanceState,
  ComfyJobRequirements
} from '@shared/comfy/dispatch'

export type ComfyScheduleCandidate = Readonly<{
  state: ComfyInstanceState
  active: number
  pending: number
}>

const containsAll = (
  available: readonly string[],
  required: readonly string[] | undefined
): boolean => (required ?? []).every((value) => available.includes(value))

export const isComfyInstanceCompatible = (
  instance: ComfyInstanceState,
  target: ComfyDispatchTarget,
  requirements: ComfyJobRequirements
): boolean => {
  if (!instance.enabled || !['online', 'degraded'].includes(instance.health.status)) return false
  if (target.mode === 'specific' && target.instanceId !== instance.id) return false
  if (target.mode === 'tag' && !instance.tags.includes(target.tag)) return false
  if (target.mode === 'local-only' && instance.kind !== 'local') return false
  return (
    containsAll(instance.tags, requirements.tags) &&
    containsAll(instance.capabilities.models, requirements.models) &&
    containsAll(instance.capabilities.customNodes, requirements.customNodes)
  )
}

export class ComfyLeastUtilizationScheduler {
  private cursor = 0

  select(
    candidates: readonly ComfyScheduleCandidate[],
    target: ComfyDispatchTarget,
    requirements: ComfyJobRequirements,
    excludedIds: ReadonlySet<string> = new Set()
  ): ComfyScheduleCandidate | undefined {
    const eligible = candidates.filter(
      (candidate) =>
        !excludedIds.has(candidate.state.id) &&
        candidate.active + candidate.pending < candidate.state.maxConcurrency &&
        isComfyInstanceCompatible(candidate.state, target, requirements)
    )
    if (!eligible.length) return undefined
    const utilization = (candidate: ComfyScheduleCandidate): number =>
      (candidate.active + candidate.pending) / candidate.state.maxConcurrency
    const minimum = Math.min(...eligible.map(utilization))
    const tied = eligible
      .filter((candidate) => utilization(candidate) === minimum)
      .sort((left, right) => left.state.id.localeCompare(right.state.id))
    const selected = tied[this.cursor % tied.length]
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER
    return selected
  }
}

export const getWorkflowRequiredNodeClasses = (
  workflow: Record<string, { class_type: string }>
): string[] => [...new Set(Object.values(workflow).map((node) => node.class_type))].sort()
