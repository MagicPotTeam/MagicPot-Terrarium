import type { CanvasGroup, CanvasItem } from './types'

export const PSD_IMPORT_EXTENSIONS = ['.psd', '.psb']
export const PSD_IMPORT_ACCEPT = PSD_IMPORT_EXTENSIONS.join(',')

export type PsdImportSourceApp = 'psd' | 'psb'

type PsdImportOptions = {
  importedAt?: string
  startZIndex?: number
}

type PsdImportResult = {
  sourceApp: PsdImportSourceApp
  title?: string
  items: CanvasItem[]
  groups: CanvasGroup[]
  warnings: string[]
}

type ParsedPsdNode = {
  type: 'Psd' | 'Group' | 'Layer'
  name: string
  children?: ParsedPsdNode[]
  width?: number
  height?: number
  left?: number
  top?: number
  text?: string
  isHidden?: boolean
  isTransparencyLocked?: boolean
  composite?: () => Promise<Uint8ClampedArray>
}

type PsdRasterContext = {
  putImageData: (imageData: ImageData, dx: number, dy: number) => void
}

type PsdRasterSurface = {
  getContext: (contextId: '2d') => PsdRasterContext | null
  convertToBlob: (options?: { type?: string }) => Promise<Blob>
}

const MAX_IMPORT_WARNINGS = 50
const DEFAULT_TEXT_FONT_FAMILY = 'Arial'
const DEFAULT_TEXT_FILL = '#111827'
const OFFSCREEN_CANVAS_CTOR_KEY = `Offscreen${'Canvas'}` as const

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '')
}

function getFileExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.')
  return index >= 0 ? fileName.slice(index).toLowerCase() : ''
}

function getSourceApp(fileName: string): PsdImportSourceApp {
  return getFileExtension(fileName) === '.psb' ? 'psb' : 'psd'
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function createImportedAt(options?: PsdImportOptions): string {
  return options?.importedAt ?? new Date().toISOString()
}

function createProvenance(
  sourceApp: PsdImportSourceApp,
  sourceFileName: string,
  sourceNodeId: string,
  sourceNodeName: string | undefined,
  importedAt: string
): NonNullable<CanvasItem['provenance']> {
  return {
    kind: sourceApp,
    sourceFileName,
    sourceNodeId,
    ...(sourceNodeName ? { sourceNodeName } : {}),
    importedAt
  }
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_IMPORT_WARNINGS) {
    warnings.push(message)
    return
  }

  if (warnings.length === MAX_IMPORT_WARNINGS) {
    warnings.push('Additional PSD import warnings were omitted.')
  }
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Failed to convert PSD layer to a data URI.'))
    reader.readAsDataURL(blob)
  })
}

function createCanvasSurface(width: number, height: number) {
  const SurfaceCtor = (
    globalThis as Record<
      typeof OFFSCREEN_CANVAS_CTOR_KEY,
      (new (width: number, height: number) => PsdRasterSurface) | undefined
    >
  )[OFFSCREEN_CANVAS_CTOR_KEY]

  if (typeof SurfaceCtor === 'function') {
    return new SurfaceCtor(width, height)
  }

  throw new Error('A raster surface is required for PSD import.')
}

async function rgbaToDataUri(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): Promise<string> {
  const surface = createCanvasSurface(width, height)
  const context = surface.getContext('2d')

  if (!context) {
    throw new Error('Failed to create a 2D canvas context for PSD import.')
  }

  const imagePixels = new Uint8ClampedArray(pixels)
  context.putImageData(new ImageData(imagePixels, width, height), 0, 0)
  const blob = await surface.convertToBlob({ type: 'image/png' })
  return await blobToDataUri(blob)
}

function nextId(prefix: string, state: { nextId: number }): string {
  state.nextId += 1
  return `${prefix}-${state.nextId}`
}

export function isPsdImportFile(file: Pick<File, 'name' | 'type'>): boolean {
  const normalizedName = file.name.trim().toLowerCase()
  return PSD_IMPORT_EXTENSIONS.some((extension) => normalizedName.endsWith(extension))
}

export async function materializePsdFile(
  file: Pick<File, 'name' | 'arrayBuffer'>,
  options?: PsdImportOptions
): Promise<PsdImportResult> {
  const { default: Psd } = await import('@webtoon/psd')
  const sourceApp = getSourceApp(file.name)
  const importedAt = createImportedAt(options)
  const warnings: string[] = []
  const items: CanvasItem[] = []
  const groups: CanvasGroup[] = []
  const idState = { nextId: 0 }
  const zIndexState = { nextZIndex: options?.startZIndex ?? 0 }
  const psd = Psd.parse(await file.arrayBuffer())

  const appendRasterLayer = async (
    node: ParsedPsdNode,
    sourceNodeId: string
  ): Promise<string[]> => {
    const rawWidth = Math.round(toFiniteNumber(node.width, 0))
    const rawHeight = Math.round(toFiniteNumber(node.height, 0))

    if (rawWidth <= 0 || rawHeight <= 0 || !node.composite) {
      pushWarning(
        warnings,
        `Skipped PSD layer "${node.name || sourceNodeId}" because it has no size.`
      )
      return []
    }

    const width = Math.max(1, rawWidth)
    const height = Math.max(1, rawHeight)

    const pixels = await node.composite()
    if (!(pixels instanceof Uint8ClampedArray) || pixels.length === 0) {
      pushWarning(
        warnings,
        `Skipped PSD layer "${node.name || sourceNodeId}" because its pixel data could not be decoded.`
      )
      return []
    }

    const src = await rgbaToDataUri(pixels, width, height)
    const itemId = nextId('psd-image', idState)
    items.push({
      id: itemId,
      type: 'image',
      src,
      fileName: `${node.name || itemId}.png`,
      x: toFiniteNumber(node.left, 0),
      y: toFiniteNumber(node.top, 0),
      width,
      height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: zIndexState.nextZIndex++,
      locked: Boolean(node.isTransparencyLocked),
      provenance: createProvenance(sourceApp, file.name, sourceNodeId, node.name, importedAt)
    })

    return [itemId]
  }

  const appendTextLayer = (node: ParsedPsdNode, sourceNodeId: string): string[] => {
    const text = node.text?.trim()
    if (!text) return []

    const itemId = nextId('psd-text', idState)
    const width = Math.max(
      1,
      Math.round(toFiniteNumber(node.width, Math.max(120, text.length * 12)))
    )
    const height = Math.max(1, Math.round(toFiniteNumber(node.height, 32)))

    items.push({
      id: itemId,
      type: 'text',
      text,
      x: toFiniteNumber(node.left, 0),
      y: toFiniteNumber(node.top, 0),
      width,
      height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: zIndexState.nextZIndex++,
      locked: Boolean(node.isTransparencyLocked),
      fontSize: Math.max(12, Math.round(Math.min(height, 32))),
      fontFamily: DEFAULT_TEXT_FONT_FAMILY,
      fill: DEFAULT_TEXT_FILL,
      provenance: createProvenance(sourceApp, file.name, sourceNodeId, node.name, importedAt)
    })

    return [itemId]
  }

  const walk = async (node: ParsedPsdNode, path: string[]): Promise<string[]> => {
    const nodeName = node.name?.trim() || node.type
    const sourceNodeId = [...path, nodeName].join(' / ')

    if (node.type === 'Group') {
      const descendantItemIds: string[] = []
      for (const child of node.children ?? []) {
        descendantItemIds.push(...(await walk(child, [...path, nodeName])))
      }

      if (descendantItemIds.length === 0) {
        return []
      }

      groups.push({
        id: nextId('psd-group', idState),
        name: nodeName,
        itemIds: descendantItemIds,
        createdAt: importedAt,
        provenance: createProvenance(sourceApp, file.name, sourceNodeId, nodeName, importedAt)
      })

      return descendantItemIds
    }

    if (node.type !== 'Layer') {
      const descendantItemIds: string[] = []
      for (const child of node.children ?? []) {
        descendantItemIds.push(...(await walk(child, path)))
      }
      return descendantItemIds
    }

    if (node.isHidden) {
      return []
    }

    const importedTextItemIds = appendTextLayer(node, sourceNodeId)
    if (importedTextItemIds.length > 0) {
      return importedTextItemIds
    }

    try {
      return await appendRasterLayer(node, sourceNodeId)
    } catch (error) {
      pushWarning(
        warnings,
        `Skipped PSD layer "${nodeName}" because it could not be rasterized: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return []
    }
  }

  for (const child of (psd as ParsedPsdNode).children ?? []) {
    await walk(child, [stripExtension(file.name)])
  }

  if (items.length === 0) {
    try {
      const composite = await psd.composite()
      if (composite.length > 0) {
        const itemId = nextId('psd-image', idState)
        items.push({
          id: itemId,
          type: 'image',
          src: await rgbaToDataUri(composite, psd.width, psd.height),
          fileName: `${stripExtension(file.name) || itemId}.png`,
          x: 0,
          y: 0,
          width: psd.width,
          height: psd.height,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: zIndexState.nextZIndex++,
          locked: false,
          provenance: createProvenance(
            sourceApp,
            file.name,
            stripExtension(file.name) || 'PSD document',
            stripExtension(file.name),
            importedAt
          )
        })
        pushWarning(
          warnings,
          'Imported a flattened PSD preview because no visible layers could be materialized individually.'
        )
      }
    } catch (error) {
      pushWarning(
        warnings,
        `Failed to decode a flattened PSD preview: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  return {
    sourceApp,
    title: stripExtension(file.name),
    items,
    groups,
    warnings
  }
}
