import type { DesignInspectionTraceEntry } from '@shared/designInspection'

export function createDesignInspectionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function roundDesignInspectionMetric(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

export function createDesignInspectionTraceEntry(
  stage: DesignInspectionTraceEntry['stage'],
  message: string
): DesignInspectionTraceEntry {
  return {
    at: new Date().toISOString(),
    stage,
    message
  }
}
