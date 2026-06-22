export const CANVAS_IMAGE_RELEASE_MANAGER_VERSION = 1

export const CANVAS_IMAGE_RELEASE_REASONS = [
  'manual',
  'replaced',
  'release-all',
  'removed',
  'budget-pressure',
  'canvas-reset',
  'component-unmount',
  'error-cleanup'
] as const

export type CanvasImageReleaseReason = (typeof CANVAS_IMAGE_RELEASE_REASONS)[number]

export type CanvasImageReleaseResourceKind = 'objectUrl' | 'imageBitmap' | 'lease'

export type CanvasImageBitmapLike = {
  close: () => void
}

export type CanvasImageLeaseDisposer = () => void

export type CanvasImageReleaseErrorSnapshot = {
  id: string
  kind: CanvasImageReleaseResourceKind
  reason: CanvasImageReleaseReason
  name: string
  message: string
}

export type CanvasImageReleaseReasonsSnapshot = Record<CanvasImageReleaseReason, number>

export type CanvasImageReleaseManagerMetrics = {
  version: typeof CANVAS_IMAGE_RELEASE_MANAGER_VERSION
  activeObjectUrlCount: number
  activeImageBitmapCount: number
  activeLeaseCount: number
  activeResourceCount: number
  revokedObjectUrlCount: number
  closedImageBitmapCount: number
  disposedLeaseCount: number
  releaseErrors: CanvasImageReleaseErrorSnapshot[]
  releaseReasons: CanvasImageReleaseReasonsSnapshot
}

export type CanvasImageReleaseResult = {
  id: string
  kind: CanvasImageReleaseResourceKind | null
  reason: CanvasImageReleaseReason
  released: boolean
  errors: CanvasImageReleaseErrorSnapshot[]
}

export type CanvasImageReleaseHandle = {
  id: string
  kind: CanvasImageReleaseResourceKind
  release: (reason?: CanvasImageReleaseReason) => CanvasImageReleaseResult
}

export type CanvasImageReleaseManagerOptions = {
  revokeObjectUrl?: (objectUrl: string) => void
  maxReleaseErrors?: number
}

type ReleaseEntry = {
  id: string
  token: symbol
  kind: CanvasImageReleaseResourceKind
  objectUrl?: string
  imageBitmap?: CanvasImageBitmapLike
  dispose?: CanvasImageLeaseDisposer
}

type ReleaseCounterKey = 'revokedObjectUrlCount' | 'closedImageBitmapCount' | 'disposedLeaseCount'

const DEFAULT_MAX_RELEASE_ERRORS = 20

const CANVAS_IMAGE_RELEASE_REASON_SET: ReadonlySet<string> = new Set(CANVAS_IMAGE_RELEASE_REASONS)

function createEmptyReleaseReasons(): CanvasImageReleaseReasonsSnapshot {
  return CANVAS_IMAGE_RELEASE_REASONS.reduce((reasons, reason) => {
    reasons[reason] = 0
    return reasons
  }, {} as CanvasImageReleaseReasonsSnapshot)
}

function normalizeReleaseReason(
  reason: CanvasImageReleaseReason | undefined,
  fallback: CanvasImageReleaseReason
): CanvasImageReleaseReason {
  if (typeof reason === 'string' && CANVAS_IMAGE_RELEASE_REASON_SET.has(reason)) {
    return reason as CanvasImageReleaseReason
  }
  return fallback
}

function normalizeMaxReleaseErrors(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_RELEASE_ERRORS
  }
  return Math.floor(value)
}

function snapshotReleaseError({
  id,
  kind,
  reason,
  error
}: {
  id: string
  kind: CanvasImageReleaseResourceKind
  reason: CanvasImageReleaseReason
  error: unknown
}): CanvasImageReleaseErrorSnapshot {
  if (error instanceof Error) {
    return {
      id,
      kind,
      reason,
      name: error.name || 'Error',
      message: error.message
    }
  }

  return {
    id,
    kind,
    reason,
    name: 'Error',
    message: String(error)
  }
}

export class CanvasImageReleaseManager {
  private readonly entries = new Map<string, ReleaseEntry>()
  private readonly releaseErrors: CanvasImageReleaseErrorSnapshot[] = []
  private readonly maxReleaseErrors: number
  private readonly revokeObjectUrl: (objectUrl: string) => void
  private readonly releaseReasons = createEmptyReleaseReasons()
  private revokedObjectUrlCount = 0
  private closedImageBitmapCount = 0
  private disposedLeaseCount = 0

  constructor(options: CanvasImageReleaseManagerOptions = {}) {
    this.maxReleaseErrors = normalizeMaxReleaseErrors(options.maxReleaseErrors)
    this.revokeObjectUrl =
      options.revokeObjectUrl ?? ((objectUrl) => URL.revokeObjectURL(objectUrl))
  }

  trackObjectUrl(id: string, objectUrl: string): CanvasImageReleaseHandle {
    return this.track({
      id,
      kind: 'objectUrl',
      objectUrl
    })
  }

  trackImageBitmap(id: string, imageBitmap: CanvasImageBitmapLike): CanvasImageReleaseHandle {
    return this.track({
      id,
      kind: 'imageBitmap',
      imageBitmap
    })
  }

  trackLease(id: string, dispose: CanvasImageLeaseDisposer): CanvasImageReleaseHandle {
    return this.track({
      id,
      kind: 'lease',
      dispose
    })
  }

  release(id: string, reason: CanvasImageReleaseReason = 'manual'): CanvasImageReleaseResult {
    return this.releaseEntry(id, undefined, reason)
  }

  releaseAll(reason: CanvasImageReleaseReason = 'release-all'): CanvasImageReleaseResult[] {
    const normalizedReason = normalizeReleaseReason(reason, 'release-all')
    return Array.from(this.entries.values(), (entry) =>
      this.releaseEntry(entry.id, entry.token, normalizedReason)
    )
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  getMetricsSnapshot(): CanvasImageReleaseManagerMetrics {
    let activeObjectUrlCount = 0
    let activeImageBitmapCount = 0
    let activeLeaseCount = 0

    for (const entry of this.entries.values()) {
      if (entry.kind === 'objectUrl') {
        activeObjectUrlCount += 1
      } else if (entry.kind === 'imageBitmap') {
        activeImageBitmapCount += 1
      } else if (entry.kind === 'lease') {
        activeLeaseCount += 1
      }
    }

    return {
      version: CANVAS_IMAGE_RELEASE_MANAGER_VERSION,
      activeObjectUrlCount,
      activeImageBitmapCount,
      activeLeaseCount,
      activeResourceCount: this.entries.size,
      revokedObjectUrlCount: this.revokedObjectUrlCount,
      closedImageBitmapCount: this.closedImageBitmapCount,
      disposedLeaseCount: this.disposedLeaseCount,
      releaseErrors: this.releaseErrors.map((error) => ({ ...error })),
      releaseReasons: { ...this.releaseReasons }
    }
  }

  private track(entry: Omit<ReleaseEntry, 'token'>): CanvasImageReleaseHandle {
    const existing = this.entries.get(entry.id)
    if (existing) {
      this.releaseEntry(existing.id, existing.token, 'replaced')
    }

    const token = Symbol(entry.id)
    const trackedEntry: ReleaseEntry = {
      ...entry,
      token
    }
    this.entries.set(entry.id, trackedEntry)

    return {
      id: entry.id,
      kind: entry.kind,
      release: (reason: CanvasImageReleaseReason = 'manual') =>
        this.releaseEntry(entry.id, token, reason)
    }
  }

  private releaseEntry(
    id: string,
    token: symbol | undefined,
    reason: CanvasImageReleaseReason
  ): CanvasImageReleaseResult {
    const entry = this.entries.get(id)
    const normalizedReason = normalizeReleaseReason(reason, 'manual')

    if (!entry || (token && entry.token !== token)) {
      return {
        id,
        kind: null,
        reason: normalizedReason,
        released: false,
        errors: []
      }
    }

    this.entries.delete(id)
    this.releaseReasons[normalizedReason] += 1

    const errors = this.releaseTrackedEntry(entry, normalizedReason)
    return {
      id,
      kind: entry.kind,
      reason: normalizedReason,
      released: true,
      errors
    }
  }

  private releaseTrackedEntry(
    entry: ReleaseEntry,
    reason: CanvasImageReleaseReason
  ): CanvasImageReleaseErrorSnapshot[] {
    const errors: CanvasImageReleaseErrorSnapshot[] = []
    try {
      this.runReleaseAction(entry)
      const counterKey = getReleaseCounterKey(entry.kind)
      this[counterKey] += 1
    } catch (error) {
      const snapshot = snapshotReleaseError({
        id: entry.id,
        kind: entry.kind,
        reason,
        error
      })
      this.recordReleaseError(snapshot)
      errors.push(snapshot)
    }
    return errors
  }

  private runReleaseAction(entry: ReleaseEntry): void {
    if (entry.kind === 'objectUrl') {
      this.revokeObjectUrl(entry.objectUrl ?? '')
      return
    }

    if (entry.kind === 'imageBitmap') {
      entry.imageBitmap?.close()
      return
    }

    entry.dispose?.()
  }

  private recordReleaseError(error: CanvasImageReleaseErrorSnapshot): void {
    if (this.maxReleaseErrors === 0) {
      return
    }

    this.releaseErrors.push(error)
    if (this.releaseErrors.length > this.maxReleaseErrors) {
      this.releaseErrors.splice(0, this.releaseErrors.length - this.maxReleaseErrors)
    }
  }
}

function getReleaseCounterKey(kind: CanvasImageReleaseResourceKind): ReleaseCounterKey {
  if (kind === 'objectUrl') {
    return 'revokedObjectUrlCount'
  }
  if (kind === 'imageBitmap') {
    return 'closedImageBitmapCount'
  }
  return 'disposedLeaseCount'
}

export function createCanvasImageReleaseManager(
  options?: CanvasImageReleaseManagerOptions
): CanvasImageReleaseManager {
  return new CanvasImageReleaseManager(options)
}
