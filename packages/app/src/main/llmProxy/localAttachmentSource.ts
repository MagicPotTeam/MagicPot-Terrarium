import fs from 'node:fs/promises'
import { getLocalMediaAllowedRoots } from '../localMediaAllowedRoots'
import { checkRendererLocalPath } from '../rendererLocalPathAccess'
import { normalizeLocalFilePath } from '../utils/localFileUrl'

export type LocalAttachmentSource = {
  /** The canonical path that was read. */
  filePath: string
  buffer: Buffer
}

export type ReadLocalAttachmentSourceOptions = {
  /** Larger files are refused before they are read. */
  maxBytes: number
  /** The prefix of the error messages, such as "[Tripo3D]". */
  label: string
  /** The canonical path of a path the policy serves, or null (default: the media policy). */
  authorize?: (filePath: string) => Promise<string | null>
}

/**
 * The media policy: what the local-media protocol serves (a file the user granted, or one in the
 * app's media, project or autosave folders), off main's event loop and under the deadline.
 */
async function authorizeMediaAttachmentPath(filePath: string): Promise<string | null> {
  return (await checkRendererLocalPath(filePath, getLocalMediaAllowedRoots())).canonicalPath
}

/**
 * The bytes of the local file an attachment URL names (`local-media:`, `file:` or a bare
 * absolute path), read only when the local-media protocol would serve it. A chat request carries
 * attachments from anywhere (a skill's reference images, a stored chat, a model or tool reply),
 * so the path in one is never trusted: config.json or any file outside the media folders is
 * refused before it is opened, and so is never uploaded to a provider.
 */
export async function readLocalAttachmentSource(
  url: string,
  { maxBytes, label, authorize = authorizeMediaAttachmentPath }: ReadLocalAttachmentSourceOptions
): Promise<LocalAttachmentSource> {
  const requested = normalizeLocalFilePath(String(url || '').trim())
  const filePath = requested ? await authorize(requested) : null
  if (!filePath) {
    throw new Error(`${label} The local attachment is not a file the app may read.`)
  }
  const handle = await fs.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new Error(`${label} The local attachment is not a file the app may read.`)
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `${label} The local attachment must be ${Math.floor(maxBytes / (1024 * 1024))}MB or smaller.`
      )
    }
    const buffer = Buffer.alloc(stats.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { filePath, buffer: buffer.subarray(0, offset) }
  } finally {
    await handle.close()
  }
}
