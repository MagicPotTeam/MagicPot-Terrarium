import type { ComfyBatchProbeResult } from '@shared/api/svcComfyBatch'

export function getComfyProfileStatusLabel(
  probe?: Pick<ComfyBatchProbeResult, 'ok' | 'latencyMs' | 'error'>
): string {
  if (!probe) return ''
  return probe.ok ? `${probe.latencyMs} ms` : (probe.error ?? '')
}
