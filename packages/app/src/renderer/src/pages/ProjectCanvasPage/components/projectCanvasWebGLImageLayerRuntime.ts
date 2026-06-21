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
