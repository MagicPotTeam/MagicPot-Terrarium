import type { ModelPackageFileEntry } from './modelArchive'

type LegacyFileSystemEntry = {
  fullPath?: string
  isDirectory: boolean
  isFile: boolean
  name: string
}

type LegacyFileSystemFileEntry = LegacyFileSystemEntry & {
  file: (
    successCallback: (file: File) => void,
    errorCallback?: (error: DOMException | Error) => void
  ) => void
}

type LegacyFileSystemDirectoryReader = {
  readEntries: (
    successCallback: (entries: LegacyFileSystemEntry[]) => void,
    errorCallback?: (error: DOMException | Error) => void
  ) => void
}

type LegacyFileSystemDirectoryEntry = LegacyFileSystemEntry & {
  createReader: () => LegacyFileSystemDirectoryReader
}

type DragDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => LegacyFileSystemEntry | null
}

const normalizeEntryPath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '')

const readFileEntry = (entry: LegacyFileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => {
    entry.file(resolve, reject)
  })

const readDirectoryEntries = async (entry: LegacyFileSystemDirectoryEntry) => {
  const reader = entry.createReader()
  const entries: LegacyFileSystemEntry[] = []

  while (true) {
    const batch = await new Promise<LegacyFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })

    if (batch.length === 0) {
      return entries
    }

    entries.push(...batch)
  }
}

const walkDroppedEntry = async (
  entry: LegacyFileSystemEntry,
  inheritedPath?: string
): Promise<ModelPackageFileEntry[]> => {
  const entryPath = normalizeEntryPath(entry.fullPath || inheritedPath || entry.name)

  if (entry.isFile) {
    const file = await readFileEntry(entry as LegacyFileSystemFileEntry)
    return [
      {
        path: entryPath || file.name,
        file
      }
    ]
  }

  if (!entry.isDirectory) {
    return []
  }

  const childEntries = await readDirectoryEntries(entry as LegacyFileSystemDirectoryEntry)
  const nestedFiles = await Promise.all(
    childEntries.map((childEntry) =>
      walkDroppedEntry(childEntry, `${entryPath}/${childEntry.name}`)
    )
  )

  return nestedFiles.flat()
}

export async function collectDroppedDirectoryFiles(
  items: DataTransferItemList
): Promise<ModelPackageFileEntry[]> {
  const collectedEntries = await Promise.all(
    Array.from(items).map(async (item) => {
      if (item.kind !== 'file') return []

      const entry = (item as DragDataTransferItem).webkitGetAsEntry?.()
      if (entry) {
        return walkDroppedEntry(entry)
      }

      const file = item.getAsFile()
      if (!file) return []

      return [
        {
          path: file.name,
          file
        }
      ]
    })
  )

  const uniqueEntries = new Map<string, ModelPackageFileEntry>()
  for (const entry of collectedEntries.flat()) {
    const normalizedPath = normalizeEntryPath(entry.path)
    if (!normalizedPath) continue
    if (!uniqueEntries.has(normalizedPath)) {
      uniqueEntries.set(normalizedPath, {
        path: normalizedPath,
        file: entry.file
      })
    }
  }

  return Array.from(uniqueEntries.values())
}
