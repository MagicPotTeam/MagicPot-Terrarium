export type ProjectCanvasWebGLPriorityQueueEntry = {
  itemId: string
  src: string
  priority: number
}

export const PROJECT_CANVAS_WEBGL_DEFAULT_RENDER_RESOLUTION_CAP = 1.5
export const PROJECT_CANVAS_WEBGL_LOW_POWER_RENDER_RESOLUTION_CAP = 1
export const PROJECT_CANVAS_WEBGL_DEFAULT_ERROR_SAMPLE_INTERVAL = 120

export function getProjectCanvasWebGLRenderResolution(
  options: {
    devicePixelRatio?: number
    lowPower?: boolean
    resolutionOverride?: number
  } = {}
) {
  const override = options.resolutionOverride
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override
  }

  const devicePixelRatio =
    typeof options.devicePixelRatio === 'number' && Number.isFinite(options.devicePixelRatio)
      ? options.devicePixelRatio
      : 1
  const cap = options.lowPower
    ? PROJECT_CANVAS_WEBGL_LOW_POWER_RENDER_RESOLUTION_CAP
    : PROJECT_CANVAS_WEBGL_DEFAULT_RENDER_RESOLUTION_CAP
  return Math.min(cap, Math.max(1, devicePixelRatio))
}

export function shouldSampleProjectCanvasWebGLError(
  renderCount: number,
  sampleInterval = PROJECT_CANVAS_WEBGL_DEFAULT_ERROR_SAMPLE_INTERVAL
) {
  const normalizedInterval =
    Number.isFinite(sampleInterval) && sampleInterval > 0
      ? Math.max(1, Math.floor(sampleInterval))
      : PROJECT_CANVAS_WEBGL_DEFAULT_ERROR_SAMPLE_INTERVAL
  return renderCount === 1 || renderCount % normalizedInterval === 0
}

export function buildProjectCanvasWebGLItemLookup<T extends { id: string }>(items: readonly T[]) {
  const itemById = new Map<string, T>()
  const itemIds = new Set<string>()
  for (const item of items) {
    itemById.set(item.id, item)
    itemIds.add(item.id)
  }
  return { itemById, itemIds }
}

const getProjectCanvasWebGLQueueInsertIndex = <T extends ProjectCanvasWebGLPriorityQueueEntry>(
  queue: readonly T[],
  priority: number
) => {
  let low = 0
  let high = queue.length

  while (low < high) {
    const mid = (low + high) >>> 1
    if (queue[mid].priority < priority) {
      high = mid
    } else {
      low = mid + 1
    }
  }

  return low
}

export const insertProjectCanvasWebGLPriorityQueueEntry = <
  T extends ProjectCanvasWebGLPriorityQueueEntry
>(
  queue: T[],
  entry: T
) => {
  queue.splice(getProjectCanvasWebGLQueueInsertIndex(queue, entry.priority), 0, entry)
}

export const reprioritizeProjectCanvasWebGLPriorityQueueEntry = <
  T extends ProjectCanvasWebGLPriorityQueueEntry
>(
  queue: T[],
  itemId: string,
  src: string,
  priority: number
) => {
  const existingIndex = queue.findIndex((entry) => entry.itemId === itemId && entry.src === src)
  if (existingIndex === -1) {
    return false
  }

  const existing = queue[existingIndex]
  if (existing.priority >= priority) {
    return true
  }

  queue.splice(existingIndex, 1)
  existing.priority = priority
  insertProjectCanvasWebGLPriorityQueueEntry(queue, existing)
  return true
}

export const refreshProjectCanvasWebGLPriorityQueuePriorities = <
  T extends ProjectCanvasWebGLPriorityQueueEntry
>(
  queue: T[],
  getPriority: (entry: T) => number | undefined
) => {
  if (queue.length === 0) {
    return
  }

  const indexedEntries = queue.map((entry, index) => {
    const nextPriority = getPriority(entry)
    if (nextPriority !== undefined && Number.isFinite(nextPriority)) {
      entry.priority = nextPriority
    }
    return { entry, index }
  })

  indexedEntries.sort((left, right) => {
    if (left.entry.priority !== right.entry.priority) {
      return right.entry.priority - left.entry.priority
    }

    return left.index - right.index
  })

  queue.splice(0, queue.length, ...indexedEntries.map(({ entry }) => entry))
}

export type ProjectCanvasWebGLResidentTextureRecord = {
  textureByteSize: number
}

const normalizeProjectCanvasWebGLTextureByteSize = (textureByteSize: number) =>
  Number.isFinite(textureByteSize) && textureByteSize > 0 ? textureByteSize : 0

export const createProjectCanvasWebGLResidentTextureByteTracker = (
  records?: Iterable<readonly [string, ProjectCanvasWebGLResidentTextureRecord]>
) => {
  const textureBytesById = new Map<string, number>()
  let residentTextureBytes = 0

  const set = (itemId: string, textureByteSize: number) => {
    const previousTextureBytes = textureBytesById.get(itemId) ?? 0
    const nextTextureBytes = normalizeProjectCanvasWebGLTextureByteSize(textureByteSize)

    if (nextTextureBytes > 0) {
      textureBytesById.set(itemId, nextTextureBytes)
    } else {
      textureBytesById.delete(itemId)
    }

    residentTextureBytes = Math.max(
      0,
      residentTextureBytes - previousTextureBytes + nextTextureBytes
    )
    return residentTextureBytes
  }

  const deleteItem = (itemId: string) => {
    const previousTextureBytes = textureBytesById.get(itemId)
    if (previousTextureBytes === undefined) {
      return residentTextureBytes
    }

    textureBytesById.delete(itemId)
    residentTextureBytes = Math.max(0, residentTextureBytes - previousTextureBytes)
    return residentTextureBytes
  }

  const clear = () => {
    textureBytesById.clear()
    residentTextureBytes = 0
  }

  const reset = (
    nextRecords: Iterable<readonly [string, ProjectCanvasWebGLResidentTextureRecord]>
  ) => {
    clear()
    for (const [itemId, record] of nextRecords) {
      set(itemId, record.textureByteSize)
    }
    return residentTextureBytes
  }

  if (records) {
    reset(records)
  }

  return {
    getTotal: () => residentTextureBytes,
    set,
    delete: deleteItem,
    clear,
    reset
  }
}

export type ProjectCanvasWebGLResidentTextureByteTracker = ReturnType<
  typeof createProjectCanvasWebGLResidentTextureByteTracker
>

export type ProjectCanvasWebGLItemReconcileSnapshotInput = {
  id: string
  src: string
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
  rotation: number
  zIndex: number
  imageIdentityKey?: string | number
  extraKeys?: readonly (string | number | boolean | null | undefined)[]
  crop?: {
    x: number
    y: number
    width: number
    height: number
  }
  image?: {
    naturalWidth?: number
    naturalHeight?: number
    width?: number
    height?: number
  } | null
  sourceWidth?: number
  sourceHeight?: number
  sourceIdentity?: {
    kind?: string
    cacheKey?: string
    canonicalPath?: string
    sizeBytes?: number
    lastModifiedMs?: number
  }
  thumbnailSet?: {
    version?: number
    cacheKey?: string
    updatedAt?: string
    sourceIdentity?: {
      kind?: string
      cacheKey?: string
      canonicalPath?: string
      sizeBytes?: number
      lastModifiedMs?: number
    }
    levels?: readonly {
      maxSide: number
      src: string
      width?: number
      height?: number
      sizeBytes?: number
    }[]
  } | null
}

export type ProjectCanvasWebGLItemReconcileSnapshotOptions = {
  selected?: boolean
  stageScale?: number
  deviceScale?: number
  sourceUpgradeBlocked?: boolean
  performanceThrottled?: boolean
  viewportInteracting?: boolean
}

export type ProjectCanvasWebGLItemReconcileSnapshot = {
  itemId: string
  renderKey: string
}

const normalizeProjectCanvasWebGLSnapshotNumber = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const getProjectCanvasWebGLSnapshotImageSize = (
  image: ProjectCanvasWebGLItemReconcileSnapshotInput['image']
) => ({
  width: normalizeProjectCanvasWebGLSnapshotNumber(image?.naturalWidth ?? image?.width),
  height: normalizeProjectCanvasWebGLSnapshotNumber(image?.naturalHeight ?? image?.height)
})

const getProjectCanvasWebGLSourceIdentitySnapshotKey = (
  sourceIdentity: ProjectCanvasWebGLItemReconcileSnapshotInput['sourceIdentity']
) =>
  [
    sourceIdentity?.kind ?? '',
    sourceIdentity?.cacheKey ?? '',
    sourceIdentity?.canonicalPath ?? '',
    sourceIdentity?.sizeBytes ?? '',
    sourceIdentity?.lastModifiedMs ?? ''
  ].join(':')

const getProjectCanvasWebGLThumbnailSetSnapshotKey = (
  thumbnailSet: ProjectCanvasWebGLItemReconcileSnapshotInput['thumbnailSet']
) => {
  if (!thumbnailSet) {
    return ''
  }

  return [
    thumbnailSet.version ?? '',
    thumbnailSet.cacheKey ?? '',
    thumbnailSet.updatedAt ?? '',
    getProjectCanvasWebGLSourceIdentitySnapshotKey(thumbnailSet.sourceIdentity),
    ...(thumbnailSet.levels ?? []).map((level) =>
      [
        level.maxSide,
        level.src,
        normalizeProjectCanvasWebGLSnapshotNumber(level.width),
        normalizeProjectCanvasWebGLSnapshotNumber(level.height),
        normalizeProjectCanvasWebGLSnapshotNumber(level.sizeBytes)
      ].join(':')
    )
  ].join('|')
}

export const buildProjectCanvasWebGLItemReconcileSnapshot = (
  item: ProjectCanvasWebGLItemReconcileSnapshotInput,
  options: ProjectCanvasWebGLItemReconcileSnapshotOptions = {}
): ProjectCanvasWebGLItemReconcileSnapshot => {
  const imageSize = getProjectCanvasWebGLSnapshotImageSize(item.image)
  return {
    itemId: item.id,
    renderKey: [
      item.id,
      item.src,
      item.x,
      item.y,
      item.width,
      item.height,
      item.scaleX,
      item.scaleY,
      item.rotation,
      item.zIndex,
      item.crop?.x ?? '',
      item.crop?.y ?? '',
      item.crop?.width ?? '',
      item.crop?.height ?? '',
      item.sourceWidth ?? '',
      item.sourceHeight ?? '',
      item.imageIdentityKey ?? '',
      imageSize.width,
      imageSize.height,
      getProjectCanvasWebGLSourceIdentitySnapshotKey(item.sourceIdentity),
      getProjectCanvasWebGLThumbnailSetSnapshotKey(item.thumbnailSet),
      options.selected === true ? 'selected' : 'unselected',
      options.stageScale ?? '',
      options.deviceScale ?? '',
      options.sourceUpgradeBlocked === true ? 'source-blocked' : 'source-allowed',
      options.performanceThrottled === true ? 'throttled' : 'unthrottled',
      options.viewportInteracting === true ? 'interacting' : 'idle',
      ...(item.extraKeys ?? []).map((value) => value ?? '')
    ].join('\u001f')
  }
}

export const areProjectCanvasWebGLItemReconcileSnapshotsEqual = (
  left: ProjectCanvasWebGLItemReconcileSnapshot | null | undefined,
  right: ProjectCanvasWebGLItemReconcileSnapshot | null | undefined
) => Boolean(left && right && left.itemId === right.itemId && left.renderKey === right.renderKey)

export type ProjectCanvasWebGLSpatialTileResourceKey = {
  source: string
  level: number
  config: string
}
export type ProjectCanvasWebGLSpatialTilePresentationKey = {
  crop: string
  transform: string
  viewport: string
}
export type ProjectCanvasWebGLSpatialTileMode = 'fallback' | 'tiled'
export type ProjectCanvasWebGLSpatialTileGeneration = {
  resourceGeneration: number
  presentationGeneration: number
}
export type ProjectCanvasWebGLSpatialTileState<Asset = unknown> = {
  generation: ProjectCanvasWebGLSpatialTileGeneration
  resourceKey: ProjectCanvasWebGLSpatialTileResourceKey | null
  presentationKey: ProjectCanvasWebGLSpatialTilePresentationKey | null
  mode: ProjectCanvasWebGLSpatialTileMode
  requiredVisibleKeys: readonly string[]
  readyKeys: readonly string[]
  asset: Asset | null
  candidate: {
    generation: ProjectCanvasWebGLSpatialTileGeneration
    presentationKey: ProjectCanvasWebGLSpatialTilePresentationKey
    mode: ProjectCanvasWebGLSpatialTileMode
    requiredVisibleKeys: readonly string[]
    readyKeys: Set<string>
    asset: Asset | null
  } | null
}
export type ProjectCanvasWebGLSpatialTileStateMachineOptions<Asset> = {
  initialResourceKey?: ProjectCanvasWebGLSpatialTileResourceKey | null
  initialPresentationKey?: ProjectCanvasWebGLSpatialTilePresentationKey | null
  initialAsset?: Asset | null
  dispose?: (asset: Asset, reason: 'stale' | 'cancelled' | 'replaced') => void
}
export type ProjectCanvasWebGLSpatialTilePresentationToken = ProjectCanvasWebGLSpatialTileGeneration
export type ProjectCanvasWebGLSpatialTileStateMachine<Asset = unknown> = ReturnType<
  typeof createProjectCanvasWebGLSpatialTileStateMachine<Asset>
>
const sameSpatialTileKey = <T extends object>(left: T | null, right: T | null) =>
  JSON.stringify(left) === JSON.stringify(right)

/** Per-item state machine. Resource generations invalidate work; presentation generations reuse assets. */
export function createProjectCanvasWebGLSpatialTileStateMachine<Asset = unknown>(
  options: ProjectCanvasWebGLSpatialTileStateMachineOptions<Asset> = {}
) {
  if (options.initialAsset != null && options.initialResourceKey == null) {
    throw new Error('A spatial tile initial asset requires an initial resource key.')
  }

  let state: ProjectCanvasWebGLSpatialTileState<Asset> = {
    generation: { resourceGeneration: 0, presentationGeneration: 0 },
    resourceKey: options.initialResourceKey ?? null,
    presentationKey: options.initialPresentationKey ?? null,
    mode: 'fallback',
    requiredVisibleKeys: [],
    readyKeys: [],
    asset: options.initialAsset ?? null,
    candidate: null
  }
  const dispose = (asset: Asset | null | undefined, reason: 'stale' | 'cancelled' | 'replaced') => {
    if (asset != null) options.dispose?.(asset, reason)
  }
  const snapshot = (): ProjectCanvasWebGLSpatialTileState<Asset> => ({
    ...state,
    generation: { ...state.generation },
    requiredVisibleKeys: [...state.requiredVisibleKeys],
    readyKeys: [...state.readyKeys],
    candidate: state.candidate
      ? {
          ...state.candidate,
          generation: { ...state.candidate.generation },
          readyKeys: new Set(state.candidate.readyKeys)
        }
      : null
  })
  const beginResource = (resourceKey: ProjectCanvasWebGLSpatialTileResourceKey) => {
    if (sameSpatialTileKey(state.resourceKey, resourceKey)) return snapshot()
    dispose(state.candidate?.asset, 'stale')
    dispose(state.asset, 'stale')
    state = {
      ...state,
      generation: {
        resourceGeneration: state.generation.resourceGeneration + 1,
        presentationGeneration: state.generation.presentationGeneration + 1
      },
      resourceKey,
      presentationKey: null,
      mode: 'fallback',
      requiredVisibleKeys: [],
      readyKeys: [],
      asset: null,
      candidate: null
    }
    return snapshot()
  }
  const beginPresentation = (
    presentationKey: ProjectCanvasWebGLSpatialTilePresentationKey,
    input: {
      requiredVisibleKeys?: readonly string[]
      mode?: ProjectCanvasWebGLSpatialTileMode
    } = {}
  ) => {
    const requiredVisibleKeys = [...new Set(input.requiredVisibleKeys ?? [])]
    const mode = input.mode ?? 'tiled'
    if (
      sameSpatialTileKey(state.presentationKey, presentationKey) &&
      !state.candidate &&
      state.mode === mode
    )
      return { token: { ...state.generation }, reusedAsset: state.asset, state: snapshot() }
    dispose(state.candidate?.asset, 'cancelled')
    const generation = {
      resourceGeneration: state.generation.resourceGeneration,
      presentationGeneration: state.generation.presentationGeneration + 1
    }
    state = {
      ...state,
      generation,
      candidate: {
        generation,
        presentationKey,
        mode,
        requiredVisibleKeys,
        readyKeys: new Set(),
        asset: null
      }
    }
    return { token: { ...generation }, reusedAsset: state.asset, state: snapshot() }
  }
  const isCurrent = (token: ProjectCanvasWebGLSpatialTilePresentationToken) =>
    token.resourceGeneration === state.generation.resourceGeneration &&
    token.presentationGeneration === state.generation.presentationGeneration
  const setCandidateAsset = (
    token: ProjectCanvasWebGLSpatialTilePresentationToken,
    asset: Asset | null
  ) => {
    if (!isCurrent(token) || !state.candidate) {
      if (asset != null) dispose(asset, 'stale')
      return false
    }
    state.candidate.asset = asset
    return true
  }
  const markTileReady = (token: ProjectCanvasWebGLSpatialTilePresentationToken, key: string) => {
    if (!isCurrent(token) || !state.candidate) return false
    state.candidate.readyKeys.add(key)
    return true
  }
  const commitVisibleReady = (token: ProjectCanvasWebGLSpatialTilePresentationToken) => {
    const candidate = state.candidate
    if (
      !isCurrent(token) ||
      candidate == null ||
      candidate.asset == null ||
      candidate.requiredVisibleKeys.some((key) => !candidate.readyKeys.has(key))
    ) {
      return false
    }
    const previous = state.asset
    state = {
      ...state,
      presentationKey: candidate.presentationKey,
      mode: candidate.mode,
      requiredVisibleKeys: [...candidate.requiredVisibleKeys],
      readyKeys: [...candidate.readyKeys],
      asset: candidate.asset,
      candidate: null
    }
    if (previous !== state.asset) dispose(previous, 'replaced')
    return true
  }
  const cancelPresentation = (token?: ProjectCanvasWebGLSpatialTilePresentationToken) => {
    if (token && !isCurrent(token)) return false
    dispose(state.candidate?.asset, 'cancelled')
    state = { ...state, candidate: null }
    return true
  }
  const leavePolicy = (token?: ProjectCanvasWebGLSpatialTilePresentationToken) => {
    if (token && !isCurrent(token)) return false
    dispose(state.candidate?.asset, 'cancelled')
    dispose(state.asset, 'cancelled')
    state = {
      ...state,
      presentationKey: null,
      mode: 'fallback',
      requiredVisibleKeys: [],
      readyKeys: [],
      asset: null,
      candidate: null
    }
    return true
  }
  return {
    getState: snapshot,
    beginResource,
    beginPresentation,
    isCurrent,
    setCandidateAsset,
    markTileReady,
    commitVisibleReady,
    cancelPresentation,
    leavePolicy
  }
}
