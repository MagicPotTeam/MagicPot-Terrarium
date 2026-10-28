import { fileURLToPath } from 'node:url'
import { normalizeExternalImageFileUrl, parseExternalImageDrop } from '@shared/externalImageDrop'

export const EXTERNAL_IMAGE_DROP_LEASE_MS = 15_000

type DropEventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>
type DropLeaseEntry = { consumed: boolean; pending?: Promise<string> }
type DropLease = { expiresAt: number; entries: Map<string, DropLeaseEntry> }

/** Private preload state; neither event capture nor lease creation crosses the bridge. */
export function createExternalImageDropAuthorization(options: {
  target?: DropEventSource
  authorizePath: (filePath: string) => Promise<boolean>
  now?: () => number
}): {
  authorizeDroppedLocalImage: (canonicalUrl: unknown) => Promise<string>
  dispose: () => void
} {
  const now = options.now ?? (() => performance.now())
  let lease: DropLease | undefined
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
      lease = {
        expiresAt: now() + EXTERNAL_IMAGE_DROP_LEASE_MS,
        entries: new Map(content.fileUrls.map((url) => [url, { consumed: false }]))
      }
    } catch {
      invalidate()
    }
  }
  const isLive = (candidate: DropLease): boolean =>
    !disposed && lease === candidate && now() < candidate.expiresAt
  const authorizeDroppedLocalImage = (canonicalUrl: unknown): Promise<string> => {
    const current = lease
    if (
      !current ||
      !isLive(current) ||
      typeof canonicalUrl !== 'string' ||
      normalizeExternalImageFileUrl(canonicalUrl) !== canonicalUrl
    )
      return Promise.resolve('')
    const entry = current.entries.get(canonicalUrl)
    if (!entry) return Promise.resolve('')
    if (entry.pending) return entry.pending
    if (entry.consumed) return Promise.resolve('')
    entry.consumed = true
    const pending = Promise.resolve()
      .then(async () => {
        try {
          if (!isLive(current)) return ''
          const filePath = fileURLToPath(canonicalUrl)
          const allowed = await options.authorizePath(filePath)
          return allowed === true && isLive(current) ? filePath : ''
        } catch {
          return ''
        }
      })
      .then((result) => {
        entry.pending = undefined
        return result
      })
    entry.pending = pending
    return pending
  }
  const navigationEvents = ['beforeunload', 'pagehide', 'hashchange', 'popstate'] as const
  options.target?.addEventListener('drop', onDrop, true)
  for (const name of navigationEvents) options.target?.addEventListener(name, invalidate, true)
  return {
    authorizeDroppedLocalImage,
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
