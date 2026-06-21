export const CANVAS_IMAGE_RESOURCE_BUDGET_VERSION = 1
export const CANVAS_IMAGE_TEXTURE_BYTES_PER_PIXEL = 4

export const CANVAS_IMAGE_RESOURCE_BUDGET_KEYS = [
  'sourceTextureBytes',
  'thumbnailTextureBytes',
  'decodedInFlightBytes',
  'objectUrlCount',
  'activeSourceUpgrades'
] as const

export type CanvasImageResourceBudgetKey = (typeof CANVAS_IMAGE_RESOURCE_BUDGET_KEYS)[number]

export type CanvasImageResourceBudgetUsage = Record<CanvasImageResourceBudgetKey, number>
export type CanvasImageResourceBudgetLimits = Partial<CanvasImageResourceBudgetUsage>

export type CanvasImageResourceBudgetPressureReason =
  | 'source-texture-budget'
  | 'thumbnail-texture-budget'
  | 'decoded-in-flight-budget'
  | 'object-url-budget'
  | 'source-upgrade-budget'

export type CanvasImageResourceBudgetAdmissionReason =
  | 'within-budget'
  | CanvasImageResourceBudgetPressureReason

export type CanvasImageResourceBudgetPressureState =
  | 'unbounded'
  | 'available'
  | 'at-limit'
  | 'over-budget'

export type CanvasImageResourceBudgetReservation = Partial<CanvasImageResourceBudgetUsage> & {
  id: string
  evictable?: boolean
  visible?: boolean
  selected?: boolean
  priority?: number
  lastAccessedAt?: number
}

export type CanvasImageResourceBudgetPressure = {
  key: CanvasImageResourceBudgetKey
  reason: CanvasImageResourceBudgetPressureReason
  usage: number
  limit: number
  excess: number
}

export type CanvasImageResourceBudgetAdmissionDecision = {
  allowed: boolean
  reason: CanvasImageResourceBudgetAdmissionReason
  reasons: CanvasImageResourceBudgetPressureReason[]
  currentUsage: CanvasImageResourceBudgetUsage
  requestedUsage: CanvasImageResourceBudgetUsage
  replacedUsage: CanvasImageResourceBudgetUsage
  projectedUsage: CanvasImageResourceBudgetUsage
  overBudget: CanvasImageResourceBudgetPressure[]
}

export type CanvasImageResourceBudgetEvictionCandidate = {
  id: string
  reason: CanvasImageResourceBudgetPressureReason
  reasons: CanvasImageResourceBudgetPressureReason[]
  release: CanvasImageResourceBudgetUsage
  score: number
  visible: boolean
  selected: boolean
  priority: number
  lastAccessedAt: number
}

export type CanvasImageResourceBudgetMetricsSnapshot = {
  version: typeof CANVAS_IMAGE_RESOURCE_BUDGET_VERSION
  limits: Record<CanvasImageResourceBudgetKey, number | null>
  usage: CanvasImageResourceBudgetUsage
  remaining: Record<CanvasImageResourceBudgetKey, number | null>
  pressure: Record<CanvasImageResourceBudgetKey, CanvasImageResourceBudgetPressureState>
  overBudget: CanvasImageResourceBudgetPressure[]
  reservationCount: number
  evictableReservationCount: number
  sourceTextureReservationCount: number
  thumbnailTextureReservationCount: number
  decodedInFlightReservationCount: number
  objectUrlReservationCount: number
  activeSourceUpgradeReservationCount: number
}

const CANVAS_IMAGE_RESOURCE_BUDGET_REASON_BY_KEY: Record<
  CanvasImageResourceBudgetKey,
  CanvasImageResourceBudgetPressureReason
> = {
  sourceTextureBytes: 'source-texture-budget',
  thumbnailTextureBytes: 'thumbnail-texture-budget',
  decodedInFlightBytes: 'decoded-in-flight-budget',
  objectUrlCount: 'object-url-budget',
  activeSourceUpgrades: 'source-upgrade-budget'
}

const ZERO_CANVAS_IMAGE_RESOURCE_BUDGET_USAGE: CanvasImageResourceBudgetUsage = {
  sourceTextureBytes: 0,
  thumbnailTextureBytes: 0,
  decodedInFlightBytes: 0,
  objectUrlCount: 0,
  activeSourceUpgrades: 0
}

function normalizeBudgetAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0
  }

  return Math.max(0, Math.floor(value))
}

function normalizeBudgetLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.floor(value))
}

function emptyCanvasImageResourceBudgetUsage(): CanvasImageResourceBudgetUsage {
  return { ...ZERO_CANVAS_IMAGE_RESOURCE_BUDGET_USAGE }
}

function addCanvasImageResourceBudgetUsage(
  left: CanvasImageResourceBudgetUsage,
  right: CanvasImageResourceBudgetUsage
): CanvasImageResourceBudgetUsage {
  const next = emptyCanvasImageResourceBudgetUsage()
  CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.forEach((key) => {
    next[key] = left[key] + right[key]
  })
  return next
}

function replaceCanvasImageResourceBudgetUsage({
  current,
  replacing,
  request
}: {
  current: CanvasImageResourceBudgetUsage
  replacing: CanvasImageResourceBudgetUsage
  request: CanvasImageResourceBudgetUsage
}): CanvasImageResourceBudgetUsage {
  const projected = emptyCanvasImageResourceBudgetUsage()
  CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.forEach((key) => {
    projected[key] = Math.max(0, current[key] - replacing[key]) + request[key]
  })
  return projected
}

export function estimateCanvasImageTextureBytes(
  width: number,
  height: number,
  bytesPerPixel = CANVAS_IMAGE_TEXTURE_BYTES_PER_PIXEL
): number {
  const safeWidth = normalizeBudgetAmount(width)
  const safeHeight = normalizeBudgetAmount(height)
  const safeBytesPerPixel = normalizeBudgetAmount(bytesPerPixel)

  if (safeWidth === 0 || safeHeight === 0 || safeBytesPerPixel === 0) {
    return 0
  }

  return safeWidth * safeHeight * safeBytesPerPixel
}

export function normalizeCanvasImageResourceBudgetUsage(
  usage?: Partial<CanvasImageResourceBudgetUsage> | null
): CanvasImageResourceBudgetUsage {
  const normalized = emptyCanvasImageResourceBudgetUsage()
  if (!usage) {
    return normalized
  }

  CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.forEach((key) => {
    normalized[key] = normalizeBudgetAmount(usage[key])
  })
  return normalized
}

export function normalizeCanvasImageResourceBudgetLimits(
  limits?: CanvasImageResourceBudgetLimits | null
): Record<CanvasImageResourceBudgetKey, number | null> {
  return CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.reduce(
    (normalized, key) => {
      normalized[key] = normalizeBudgetLimit(limits?.[key])
      return normalized
    },
    {} as Record<CanvasImageResourceBudgetKey, number | null>
  )
}

export function normalizeCanvasImageResourceBudgetReservation(
  reservation: CanvasImageResourceBudgetReservation
): CanvasImageResourceBudgetReservation {
  return {
    ...reservation,
    ...normalizeCanvasImageResourceBudgetUsage(reservation)
  }
}

export function getCanvasImageResourceBudgetUsage(
  reservations: Iterable<Partial<CanvasImageResourceBudgetUsage>>
): CanvasImageResourceBudgetUsage {
  let usage = emptyCanvasImageResourceBudgetUsage()
  for (const reservation of reservations) {
    usage = addCanvasImageResourceBudgetUsage(
      usage,
      normalizeCanvasImageResourceBudgetUsage(reservation)
    )
  }
  return usage
}

export function getCanvasImageResourceBudgetPressures({
  usage,
  limits
}: {
  usage: Partial<CanvasImageResourceBudgetUsage>
  limits?: CanvasImageResourceBudgetLimits | null
}): CanvasImageResourceBudgetPressure[] {
  const normalizedUsage = normalizeCanvasImageResourceBudgetUsage(usage)
  const normalizedLimits = normalizeCanvasImageResourceBudgetLimits(limits)

  return CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.flatMap((key) => {
    const limit = normalizedLimits[key]
    if (limit === null || normalizedUsage[key] <= limit) {
      return []
    }

    return [
      {
        key,
        reason: CANVAS_IMAGE_RESOURCE_BUDGET_REASON_BY_KEY[key],
        usage: normalizedUsage[key],
        limit,
        excess: normalizedUsage[key] - limit
      }
    ]
  })
}

export function resolveCanvasImageResourceBudgetAdmission({
  currentUsage,
  limits,
  request,
  replacing
}: {
  currentUsage?: Partial<CanvasImageResourceBudgetUsage> | null
  limits?: CanvasImageResourceBudgetLimits | null
  request: Partial<CanvasImageResourceBudgetUsage>
  replacing?: Partial<CanvasImageResourceBudgetUsage> | null
}): CanvasImageResourceBudgetAdmissionDecision {
  const normalizedCurrentUsage = normalizeCanvasImageResourceBudgetUsage(currentUsage)
  const requestedUsage = normalizeCanvasImageResourceBudgetUsage(request)
  const replacedUsage = normalizeCanvasImageResourceBudgetUsage(replacing)
  const projectedUsage = replaceCanvasImageResourceBudgetUsage({
    current: normalizedCurrentUsage,
    replacing: replacedUsage,
    request: requestedUsage
  })
  const overBudget = getCanvasImageResourceBudgetPressures({
    usage: projectedUsage,
    limits
  })
  const reasons = overBudget.map((pressure) => pressure.reason)

  return {
    allowed: overBudget.length === 0,
    reason: reasons[0] ?? 'within-budget',
    reasons,
    currentUsage: normalizedCurrentUsage,
    requestedUsage,
    replacedUsage,
    projectedUsage,
    overBudget
  }
}

function getEvictionReleaseScore(
  release: CanvasImageResourceBudgetUsage,
  pressuredKeys: ReadonlySet<CanvasImageResourceBudgetKey>
): number {
  return CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.reduce((score, key) => {
    if (!pressuredKeys.has(key)) {
      return score
    }

    if (key === 'objectUrlCount' || key === 'activeSourceUpgrades') {
      return score + release[key] * 1024 * 1024
    }

    return score + release[key]
  }, 0)
}

function getReservationSortNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function getCanvasImageResourceBudgetEvictionCandidates({
  reservations,
  limits,
  currentUsage,
  request,
  replacing,
  protectedIds = new Set<string>()
}: {
  reservations: Iterable<CanvasImageResourceBudgetReservation>
  limits?: CanvasImageResourceBudgetLimits | null
  currentUsage?: Partial<CanvasImageResourceBudgetUsage> | null
  request?: Partial<CanvasImageResourceBudgetUsage> | null
  replacing?: Partial<CanvasImageResourceBudgetUsage> | null
  protectedIds?: ReadonlySet<string>
}): CanvasImageResourceBudgetEvictionCandidate[] {
  const reservationList = Array.from(reservations, normalizeCanvasImageResourceBudgetReservation)
  const normalizedCurrentUsage = currentUsage
    ? normalizeCanvasImageResourceBudgetUsage(currentUsage)
    : getCanvasImageResourceBudgetUsage(reservationList)
  const pressureUsage = request
    ? resolveCanvasImageResourceBudgetAdmission({
        currentUsage: normalizedCurrentUsage,
        limits,
        request,
        replacing
      }).projectedUsage
    : normalizedCurrentUsage
  const pressures = getCanvasImageResourceBudgetPressures({
    usage: pressureUsage,
    limits
  })

  if (pressures.length === 0) {
    return []
  }

  const pressureByKey = new Map(pressures.map((pressure) => [pressure.key, pressure]))
  const pressuredKeys = new Set(pressures.map((pressure) => pressure.key))

  return reservationList
    .flatMap((reservation): CanvasImageResourceBudgetEvictionCandidate[] => {
      if (reservation.evictable === false || protectedIds.has(reservation.id)) {
        return []
      }

      const release = normalizeCanvasImageResourceBudgetUsage(reservation)
      const reasons = CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.flatMap((key) => {
        const pressure = pressureByKey.get(key)
        return pressure && release[key] > 0 ? [pressure.reason] : []
      })

      if (reasons.length === 0) {
        return []
      }

      return [
        {
          id: reservation.id,
          reason: reasons[0],
          reasons,
          release,
          score: getEvictionReleaseScore(release, pressuredKeys),
          visible: reservation.visible !== false,
          selected: reservation.selected === true,
          priority: getReservationSortNumber(reservation.priority, 0),
          lastAccessedAt: getReservationSortNumber(reservation.lastAccessedAt, 0)
        }
      ]
    })
    .sort((left, right) => {
      if (left.selected !== right.selected) {
        return left.selected ? 1 : -1
      }
      if (left.visible !== right.visible) {
        return left.visible ? 1 : -1
      }
      if (left.priority !== right.priority) {
        return left.priority - right.priority
      }
      if (left.lastAccessedAt !== right.lastAccessedAt) {
        return left.lastAccessedAt - right.lastAccessedAt
      }
      if (left.score !== right.score) {
        return right.score - left.score
      }
      return left.id.localeCompare(right.id)
    })
}

export function buildCanvasImageResourceBudgetMetricsSnapshot({
  limits,
  usage,
  reservations
}: {
  limits?: CanvasImageResourceBudgetLimits | null
  usage?: Partial<CanvasImageResourceBudgetUsage> | null
  reservations?: Iterable<CanvasImageResourceBudgetReservation>
}): CanvasImageResourceBudgetMetricsSnapshot {
  const reservationList = reservations
    ? Array.from(reservations, normalizeCanvasImageResourceBudgetReservation)
    : []
  const normalizedLimits = normalizeCanvasImageResourceBudgetLimits(limits)
  const normalizedUsage = usage
    ? normalizeCanvasImageResourceBudgetUsage(usage)
    : getCanvasImageResourceBudgetUsage(reservationList)
  const remaining = {} as Record<CanvasImageResourceBudgetKey, number | null>
  const pressure = {} as Record<
    CanvasImageResourceBudgetKey,
    CanvasImageResourceBudgetPressureState
  >

  CANVAS_IMAGE_RESOURCE_BUDGET_KEYS.forEach((key) => {
    const limit = normalizedLimits[key]
    if (limit === null) {
      remaining[key] = null
      pressure[key] = 'unbounded'
      return
    }

    remaining[key] = Math.max(0, limit - normalizedUsage[key])
    pressure[key] =
      normalizedUsage[key] > limit
        ? 'over-budget'
        : normalizedUsage[key] === limit
          ? 'at-limit'
          : 'available'
  })

  return {
    version: CANVAS_IMAGE_RESOURCE_BUDGET_VERSION,
    limits: normalizedLimits,
    usage: normalizedUsage,
    remaining,
    pressure,
    overBudget: getCanvasImageResourceBudgetPressures({
      usage: normalizedUsage,
      limits
    }),
    reservationCount: reservationList.length,
    evictableReservationCount: reservationList.filter(
      (reservation) => reservation.evictable !== false
    ).length,
    sourceTextureReservationCount: reservationList.filter(
      (reservation) => normalizeBudgetAmount(reservation.sourceTextureBytes) > 0
    ).length,
    thumbnailTextureReservationCount: reservationList.filter(
      (reservation) => normalizeBudgetAmount(reservation.thumbnailTextureBytes) > 0
    ).length,
    decodedInFlightReservationCount: reservationList.filter(
      (reservation) => normalizeBudgetAmount(reservation.decodedInFlightBytes) > 0
    ).length,
    objectUrlReservationCount: reservationList.filter(
      (reservation) => normalizeBudgetAmount(reservation.objectUrlCount) > 0
    ).length,
    activeSourceUpgradeReservationCount: reservationList.filter(
      (reservation) => normalizeBudgetAmount(reservation.activeSourceUpgrades) > 0
    ).length
  }
}

export class CanvasImageResourceBudgetTracker {
  private readonly reservations = new Map<string, CanvasImageResourceBudgetReservation>()

  constructor(
    private limits: CanvasImageResourceBudgetLimits = {},
    reservations: Iterable<CanvasImageResourceBudgetReservation> = []
  ) {
    for (const reservation of reservations) {
      this.upsert(reservation)
    }
  }

  setLimits(limits: CanvasImageResourceBudgetLimits): void {
    this.limits = { ...limits }
  }

  getLimits(): CanvasImageResourceBudgetLimits {
    return { ...this.limits }
  }

  upsert(reservation: CanvasImageResourceBudgetReservation): void {
    this.reservations.set(
      reservation.id,
      normalizeCanvasImageResourceBudgetReservation(reservation)
    )
  }

  remove(id: string): void {
    this.reservations.delete(id)
  }

  clear(): void {
    this.reservations.clear()
  }

  getReservation(id: string): CanvasImageResourceBudgetReservation | null {
    const reservation = this.reservations.get(id)
    return reservation ? { ...reservation } : null
  }

  getReservations(): CanvasImageResourceBudgetReservation[] {
    return Array.from(this.reservations.values(), (reservation) => ({ ...reservation }))
  }

  getUsage(): CanvasImageResourceBudgetUsage {
    return getCanvasImageResourceBudgetUsage(this.reservations.values())
  }

  resolveAdmission(
    request: CanvasImageResourceBudgetReservation
  ): CanvasImageResourceBudgetAdmissionDecision {
    return resolveCanvasImageResourceBudgetAdmission({
      currentUsage: this.getUsage(),
      limits: this.limits,
      request,
      replacing: this.reservations.get(request.id) ?? null
    })
  }

  admit(request: CanvasImageResourceBudgetReservation): CanvasImageResourceBudgetAdmissionDecision {
    const decision = this.resolveAdmission(request)
    if (decision.allowed) {
      this.upsert(request)
    }
    return decision
  }

  getEvictionCandidates({
    request,
    protectedIds
  }: {
    request?: Partial<CanvasImageResourceBudgetUsage> | null
    protectedIds?: ReadonlySet<string>
  } = {}): CanvasImageResourceBudgetEvictionCandidate[] {
    return getCanvasImageResourceBudgetEvictionCandidates({
      reservations: this.reservations.values(),
      limits: this.limits,
      currentUsage: this.getUsage(),
      request,
      protectedIds
    })
  }

  getMetricsSnapshot(): CanvasImageResourceBudgetMetricsSnapshot {
    return buildCanvasImageResourceBudgetMetricsSnapshot({
      limits: this.limits,
      reservations: this.reservations.values()
    })
  }
}
