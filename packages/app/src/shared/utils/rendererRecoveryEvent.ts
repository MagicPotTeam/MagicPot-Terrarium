// packages/app/src/shared/utils/rendererRecoveryEvent.ts
// The one event the main process sends after it reloaded a window whose renderer had died.
// It carries no content: the exit reason, the exit code and when the renderer died.

export const RENDERER_RECOVERED_CHANNEL = 'app:renderer-recovered'

export type RendererRecoveredEvent = {
  /** Electron's render-process-gone reason, e.g. 'crashed' or 'oom'. */
  reason: string
  exitCode: number
  /** Wall-clock time of the renderer death, ms since the epoch. */
  diedAt: number
}

const MAX_REASON_LENGTH = 64

/** Accepts only the exact event shape; anything else is dropped. */
export function parseRendererRecoveredEvent(value: unknown): RendererRecoveredEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { reason, exitCode, diedAt } = value as Record<string, unknown>
  if (typeof reason !== 'string' || !reason || reason.length > MAX_REASON_LENGTH) return null
  if (!/^[a-z0-9-]+$/i.test(reason)) return null
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return null
  if (typeof diedAt !== 'number' || !Number.isFinite(diedAt) || diedAt <= 0) return null
  return { reason, exitCode, diedAt }
}
