export type ProjectCanvasWebGLPriorityQueueEntry = {
  itemId: string
  src: string
  priority: number
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
