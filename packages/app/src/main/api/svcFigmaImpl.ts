import type {
  CheckFigmaFileUpdateReq,
  CheckFigmaFileUpdateResp,
  FigmaSvc,
  ResolveFigmaFileReq,
  ResolveFigmaFileResp,
  SyncFigmaCanvasItem,
  SyncFigmaFileReq,
  SyncFigmaFileResp
} from '@shared/api/svcFigma'
import type { FigmaBindingPage } from '@shared/figma'

type FigmaApiBoundingBox = {
  x: number
  y: number
  width: number
  height: number
}

type FigmaApiNode = {
  id: string
  name?: string
  type?: string
  visible?: boolean
  absoluteBoundingBox?: FigmaApiBoundingBox
  children?: FigmaApiNode[]
}

type FigmaApiFileResponse = {
  name?: string
  version?: string
  lastModified?: string
  document?: FigmaApiNode
}

type FigmaApiImagesResponse = {
  err?: string
  images?: Record<string, string | null>
}

const FIGMA_API_ORIGIN = 'https://api.figma.com/v1'
const FIGMA_IMAGE_BATCH_SIZE = 20
const FIGMA_HOSTNAME = 'figma.com'

function ensureAccessToken(accessToken: string): string {
  const normalized = accessToken.trim()
  if (!normalized) {
    throw new Error('Figma Personal Access Token is required.')
  }
  return normalized
}

const isFigmaHostname = (hostname: string): boolean =>
  hostname === FIGMA_HOSTNAME || hostname.endsWith(`.${FIGMA_HOSTNAME}`)

export function normalizeFigmaFileKey(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Figma file link or file key is required.')
  }

  const tryParseUrl = (value: string): string | null => {
    try {
      const url = new URL(value)
      if (!isFigmaHostname(url.hostname.toLowerCase())) {
        return null
      }
      const match = url.pathname.match(/\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:[/?#]|$)/i)
      return match?.[1] ?? null
    } catch {
      return null
    }
  }

  const parsedFromUrl =
    tryParseUrl(trimmed) ||
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? null : tryParseUrl(`https://${trimmed}`))

  if (parsedFromUrl) {
    return parsedFromUrl
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error('Figma file URL must use figma.com.')
  }

  return trimmed
}

function buildFigmaHeaders(accessToken: string): HeadersInit {
  return {
    'X-Figma-Token': ensureAccessToken(accessToken)
  }
}

async function fetchFigmaJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${FIGMA_API_ORIGIN}${path}`, {
    headers: buildFigmaHeaders(accessToken)
  })

  if (!response.ok) {
    const errorText = (await response.text()).trim()
    throw new Error(errorText || `Figma API request failed with status ${response.status}.`)
  }

  return (await response.json()) as T
}

function getFigmaPages(file: FigmaApiFileResponse): FigmaBindingPage[] {
  const pageNodes = file.document?.children?.filter((node) => node.type === 'CANVAS') ?? []

  return pageNodes.map((page) => ({
    nodeId: page.id,
    name: page.name?.trim() || page.id,
    childCount: Array.isArray(page.children) ? page.children.length : 0
  }))
}

function getFigmaPageNode(file: FigmaApiFileResponse, pageNodeId?: string): FigmaApiNode {
  const pages = file.document?.children?.filter((node) => node.type === 'CANVAS') ?? []
  if (pages.length === 0) {
    throw new Error('The Figma file does not contain any pages that can be imported.')
  }

  if (pageNodeId) {
    const matched = pages.find((page) => page.id === pageNodeId)
    if (matched) {
      return matched
    }
  }

  return pages[0]
}

function getRenderablePageNodes(pageNode: FigmaApiNode): FigmaApiNode[] {
  const children = Array.isArray(pageNode.children) ? pageNode.children : []

  return children
    .filter((node) => node.visible !== false)
    .filter((node) => {
      const box = node.absoluteBoundingBox
      return Boolean(box && box.width > 0 && box.height > 0)
    })
    .sort((left, right) => {
      const leftBox = left.absoluteBoundingBox!
      const rightBox = right.absoluteBoundingBox!
      if (leftBox.y !== rightBox.y) return leftBox.y - rightBox.y
      return leftBox.x - rightBox.x
    })
}

function sanitizeFileStem(value: string): string {
  const sanitized = value.replace(/[\\/:*?"<>|]/g, ' ').trim()
  return sanitized || 'Figma node'
}

async function fetchImageDataUrl(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl)
  if (!response.ok) {
    throw new Error(`Failed to download rendered Figma node image (${response.status}).`)
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  const arrayBuffer = await response.arrayBuffer()
  const base64 = Buffer.from(arrayBuffer).toString('base64')
  return `data:${contentType};base64,${base64}`
}

async function fetchNodeImageUrls(
  fileKey: string,
  nodeIds: string[],
  accessToken: string
): Promise<Record<string, string | null>> {
  const results: Record<string, string | null> = {}

  for (let index = 0; index < nodeIds.length; index += FIGMA_IMAGE_BATCH_SIZE) {
    const batch = nodeIds.slice(index, index + FIGMA_IMAGE_BATCH_SIZE)
    const searchParams = new URLSearchParams({
      ids: batch.join(','),
      format: 'png',
      scale: '1'
    })
    const response = await fetchFigmaJson<FigmaApiImagesResponse>(
      `/images/${fileKey}?${searchParams.toString()}`,
      accessToken
    )

    if (response.err) {
      throw new Error(response.err)
    }

    for (const nodeId of batch) {
      results[nodeId] = response.images?.[nodeId] ?? null
    }
  }

  return results
}

async function loadFigmaFile(
  accessToken: string,
  fileKeyOrUrl: string
): Promise<{ fileKey: string; file: FigmaApiFileResponse }> {
  const fileKey = normalizeFigmaFileKey(fileKeyOrUrl)
  const file = await fetchFigmaJson<FigmaApiFileResponse>(`/files/${fileKey}`, accessToken)
  return { fileKey, file }
}

export class FigmaSvcImpl implements FigmaSvc {
  resolveFile = async (req: ResolveFigmaFileReq): Promise<ResolveFigmaFileResp> => {
    const { fileKey, file } = await loadFigmaFile(req.accessToken, req.fileKeyOrUrl)
    const pages = getFigmaPages(file)

    if (pages.length === 0) {
      throw new Error('The Figma file does not contain any pages that can be bound to this canvas.')
    }

    return {
      fileKey,
      fileName: file.name?.trim() || fileKey,
      pages,
      lastModified: file.lastModified,
      version: file.version
    }
  }

  syncFile = async (req: SyncFigmaFileReq): Promise<SyncFigmaFileResp> => {
    const { fileKey, file } = await loadFigmaFile(req.accessToken, req.fileKeyOrUrl)
    const pages = getFigmaPages(file)
    const pageNode = getFigmaPageNode(file, req.pageNodeId)
    const renderableNodes = getRenderablePageNodes(pageNode)
    const warnings: string[] = []

    if (renderableNodes.length === 0) {
      warnings.push(
        'The selected Figma page does not contain any visible top-level layers with bounds.'
      )
      return {
        fileKey,
        fileName: file.name?.trim() || fileKey,
        pages,
        pageNodeId: pageNode.id,
        pageName: pageNode.name?.trim() || pageNode.id,
        lastModified: file.lastModified,
        version: file.version,
        items: [],
        warnings
      }
    }

    const imageUrls = await fetchNodeImageUrls(
      fileKey,
      renderableNodes.map((node) => node.id),
      req.accessToken
    )

    const items: SyncFigmaCanvasItem[] = []
    for (const node of renderableNodes) {
      const box = node.absoluteBoundingBox
      if (!box) continue

      const imageUrl = imageUrls[node.id]
      if (!imageUrl) {
        warnings.push(
          `Skipped "${node.name?.trim() || node.id}" because Figma did not return a renderable image URL.`
        )
        continue
      }

      try {
        const src = await fetchImageDataUrl(imageUrl)
        items.push({
          nodeId: node.id,
          nodeName: node.name?.trim() || undefined,
          fileName: `${sanitizeFileStem(node.name?.trim() || node.id)}.png`,
          src,
          x: box.x,
          y: box.y,
          width: Math.max(1, Math.round(box.width)),
          height: Math.max(1, Math.round(box.height))
        })
      } catch (error) {
        warnings.push(
          `Skipped "${node.name?.trim() || node.id}" because its rendered image could not be downloaded.`
        )
        console.warn('[Figma] Failed to download rendered node image:', node.id, error)
      }
    }

    return {
      fileKey,
      fileName: file.name?.trim() || fileKey,
      pages,
      pageNodeId: pageNode.id,
      pageName: pageNode.name?.trim() || pageNode.id,
      lastModified: file.lastModified,
      version: file.version,
      items,
      warnings
    }
  }

  checkFileUpdate = async (req: CheckFigmaFileUpdateReq): Promise<CheckFigmaFileUpdateResp> => {
    const { fileKey, file } = await loadFigmaFile(req.accessToken, req.fileKey)
    const hasVersionUpdate =
      Boolean(req.knownVersion) && Boolean(file.version) && req.knownVersion !== file.version
    const hasModifiedUpdate =
      Boolean(req.knownLastModified) &&
      Boolean(file.lastModified) &&
      req.knownLastModified !== file.lastModified

    return {
      fileKey,
      fileName: file.name?.trim() || fileKey,
      pages: getFigmaPages(file),
      lastModified: file.lastModified,
      version: file.version,
      hasUpdate: hasVersionUpdate || hasModifiedUpdate
    }
  }
}
