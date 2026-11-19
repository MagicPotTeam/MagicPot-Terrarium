import { fileURLToPath } from 'node:url'
import { normalizeExternalImageFileUrl, parseExternalImageDrop } from '@shared/externalImageDrop'

export const EXTERNAL_IMAGE_DROP_LEASE_MS = 15_000

type DropEventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>
/**
 * A one-use grant from main: the canonical path and its size when granted. bytesOnly: the
 * file is on a network path main does not import by path (a mapped drive); `path` is then the
 * dropped path, which main reads once for the page (readImageFromPath).
 */
export type DroppedLocalImageImportGrant = { path: string; sizeBytes: number; bytesOnly?: true }
type DropLeaseUse = 'persisted' | 'import'
type DropLeaseEntry = {
  consumed: boolean
  pending?: { use: DropLeaseUse; result: Promise<unknown> }
}
type DropLease = { expiresAt: number; entries: Map<string, DropLeaseEntry>; id: string }

/** Private preload state; neither event capture nor lease creation crosses the bridge. */
export function createExternalImageDropAuthorization(options: {
  target?: DropEventSource
  /** Records a persisted grant (canvas). */
  authorizePath: (filePath: string) => Promise<boolean>
  /** Records a one-use import grant in main (chat): no persisted grant, no bytes. */
  authorizeImportPath?: (
    filePath: string,
    mimeType: string,
    /** One id per drop: main lets the grants of one drop wait for each other's imports. */
    dropId: string
  ) => Promise<DroppedLocalImageImportGrant | null>
  now?: () => number
}): {
  authorizeDroppedLocalImage: (canonicalUrl: unknown) => Promise<string>
  authorizeDroppedLocalImageForImport: (
    canonicalUrl: unknown,
    mimeType: unknown
  ) => Promise<DroppedLocalImageImportGrant | null>
  dispose: () => void
} {
  const now = options.now ?? (() => performance.now())
  let lease: DropLease | undefined
  let leaseSerial = 0
  let disposed = false
  const invalidate = () => {
    lease = undefined
  }
  const onDrop = (event: Event) => {
    if (disposed || event.isTrusted !== true) return
    invalidate()
    try {
      const dataTransfer = (event as DragEvent).dataTransfer
      if (!dataTransfer) return
      const content = parseExternalImageDrop({
        plainText:
          dataTransfer.getData('text/plain') ||
          dataTransfer.getData('text') ||
          dataTransfer.getData('Text'),
        uriList: dataTransfer.getData('text/uri-list'),
        html: dataTransfer.getData('text/html')
      })
      if (!content.fileUrls.length) return
      leaseSerial += 1
      lease = {
        expiresAt: now() + EXTERNAL_IMAGE_DROP_LEASE_MS,
        entries: new Map(content.fileUrls.map((url) => [url, { consumed: false }])),
        id: `drop-${leaseSerial}-${Math.random().toString(36).slice(2, 10)}`
      }
    } catch {
      invalidate()
    }
  }
  const isLive = (candidate: DropLease): boolean =>
    !disposed && lease === candidate && now() < candidate.expiresAt
  /**
   * Runs `grant` for one URL of the current trusted drop, once: each URL of a drop is granted
   * at most once, whichever kind of grant is asked; the same request while it runs shares
   * its result.
   */
  const grantOnce = <T>(
    canonicalUrl: unknown,
    use: DropLeaseUse,
    refused: T,
    grant: (filePath: string, isCurrent: () => boolean, dropId: string) => Promise<T>
  ): Promise<T> => {
    const current = lease
    if (
      !current ||
      !isLive(current) ||
      typeof canonicalUrl !== 'string' ||
      normalizeExternalImageFileUrl(canonicalUrl) !== canonicalUrl
    )
      return Promise.resolve(refused)
    const entry = current.entries.get(canonicalUrl)
    if (!entry) return Promise.resolve(refused)
    if (entry.pending) {
      return entry.pending.use === use
        ? (entry.pending.result as Promise<T>)
        : Promise.resolve(refused)
    }
    if (entry.consumed) return Promise.resolve(refused)
    entry.consumed = true
    const result = Promise.resolve()
      .then(async () => {
        try {
          if (!isLive(current)) return refused
          return await grant(fileURLToPath(canonicalUrl), () => isLive(current), current.id)
        } catch {
          return refused
        }
      })
      .then((value) => {
        entry.pending = undefined
        return value
      })
    entry.pending = { use, result }
    return result
  }
  const authorizeDroppedLocalImage = (canonicalUrl: unknown): Promise<string> =>
    grantOnce(canonicalUrl, 'persisted', '', async (filePath, isCurrent) => {
      const allowed = await options.authorizePath(filePath)
      return allowed === true && isCurrent() ? filePath : ''
    })
  const authorizeDroppedLocalImageForImport = (
    canonicalUrl: unknown,
    mimeType: unknown
  ): Promise<DroppedLocalImageImportGrant | null> => {
    const authorizeImportPath = options.authorizeImportPath
    if (!authorizeImportPath || typeof mimeType !== 'string') return Promise.resolve(null)
    return grantOnce(canonicalUrl, 'import', null, async (filePath, isCurrent, dropId) => {
      const granted = await authorizeImportPath(filePath, mimeType, dropId)
      return granted && isCurrent() ? granted : null
    })
  }
  const navigationEvents = ['beforeunload', 'pagehide', 'hashchange', 'popstate'] as const
  options.target?.addEventListener('drop', onDrop, true)
  for (const name of navigationEvents) options.target?.addEventListener(name, invalidate, true)
  return {
    authorizeDroppedLocalImage,
    authorizeDroppedLocalImageForImport,
    dispose: () => {
      if (disposed) return
      disposed = true
      invalidate()
      options.target?.removeEventListener('drop', onDrop, true)
      for (const name of navigationEvents)
        options.target?.removeEventListener(name, invalidate, true)
    }
  }
}
