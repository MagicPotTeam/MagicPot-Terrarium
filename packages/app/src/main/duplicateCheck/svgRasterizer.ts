import { app, BrowserWindow } from 'electron'

export type SvgRasterizationResult = {
  pngBuffer: Buffer
  width: number
  height: number
}

type SvgRootAttributes = {
  width: number | null
  height: number | null
  viewBoxWidth: number | null
  viewBoxHeight: number | null
}

const DEFAULT_SVG_WIDTH = 300
const DEFAULT_SVG_HEIGHT = 150
const MAX_SVG_DIMENSION = 4096
const MAX_SVG_AREA = 4096 * 4096

const ROOT_TAG_PATTERN = /<svg\b([^>]*)>/i
const VIEWBOX_PATTERN =
  /\bviewBox\s*=\s*(['"])\s*(-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(\d*\.?\d+(?:[eE][+-]?\d+)?)\s*\1/i
const ATTRIBUTE_PATTERN = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i')
const SVG_SCRIPT_PATTERN = /<script\b/i
const SVG_EXTERNAL_REFERENCE_PATTERN = /\b(?:href|xlink:href|src)\s*=\s*(['"])([^'"]+)\1/gi
const SVG_STYLE_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const SVG_STYLE_IMPORT_PATTERN = /@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/gi

const trimByteOrderMark = (value: string): string =>
  value.charCodeAt(0) === 0xfeff ? value.slice(1) : value

const decodeSvgProbeText = (buffer: Buffer): string =>
  trimByteOrderMark(buffer.toString('utf8', 0, Math.min(buffer.length, 4096))).trimStart()

const parseSvgLength = (value: string | null | undefined): number | null => {
  const normalized = value?.trim()
  if (!normalized || normalized.endsWith('%')) {
    return null
  }

  const match = normalized.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)([a-z]*)$/i)
  if (!match) {
    return null
  }

  const numericValue = Number.parseFloat(match[1])
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null
  }

  const unit = match[2].toLowerCase()
  const unitScale =
    unit === '' || unit === 'px'
      ? 1
      : unit === 'pt'
        ? 96 / 72
        : unit === 'pc'
          ? 16
          : unit === 'mm'
            ? 96 / 25.4
            : unit === 'cm'
              ? 96 / 2.54
              : unit === 'in'
                ? 96
                : null

  if (!unitScale) {
    return null
  }

  return numericValue * unitScale
}

const clampRasterSize = (width: number, height: number): { width: number; height: number } => {
  let nextWidth = Math.max(1, Math.round(width))
  let nextHeight = Math.max(1, Math.round(height))

  const maxDimension = Math.max(nextWidth, nextHeight)
  if (maxDimension > MAX_SVG_DIMENSION) {
    const scale = MAX_SVG_DIMENSION / maxDimension
    nextWidth = Math.max(1, Math.round(nextWidth * scale))
    nextHeight = Math.max(1, Math.round(nextHeight * scale))
  }

  const area = nextWidth * nextHeight
  if (area > MAX_SVG_AREA) {
    const scale = Math.sqrt(MAX_SVG_AREA / area)
    nextWidth = Math.max(1, Math.round(nextWidth * scale))
    nextHeight = Math.max(1, Math.round(nextHeight * scale))
  }

  return {
    width: nextWidth,
    height: nextHeight
  }
}

const readSvgRootAttributes = (svgText: string): SvgRootAttributes => {
  const rootMatch = svgText.match(ROOT_TAG_PATTERN)
  const rootAttributes = rootMatch?.[1] || ''
  const width = parseSvgLength(rootAttributes.match(ATTRIBUTE_PATTERN('width'))?.[2])
  const height = parseSvgLength(rootAttributes.match(ATTRIBUTE_PATTERN('height'))?.[2])
  const viewBoxMatch = svgText.match(VIEWBOX_PATTERN)

  return {
    width,
    height,
    viewBoxWidth: viewBoxMatch ? Number.parseFloat(viewBoxMatch[4]) : null,
    viewBoxHeight: viewBoxMatch ? Number.parseFloat(viewBoxMatch[5]) : null
  }
}

const isInternalSvgReference = (value: string): boolean => {
  const normalized = value.trim().toLowerCase()
  return (
    normalized.startsWith('#') ||
    normalized.startsWith('data:') ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('about:blank#')
  )
}

export const isSvgMimeType = (value: string | undefined): boolean =>
  value?.trim().toLowerCase() === 'image/svg+xml'

export const isSvgFileName = (value: string | undefined): boolean =>
  value?.trim().toLowerCase().endsWith('.svg') || false

export const isSvgImageDescriptor = (input: {
  name?: string
  sourcePath?: string
  mimeType?: string
}): boolean =>
  isSvgMimeType(input.mimeType) || isSvgFileName(input.name) || isSvgFileName(input.sourcePath)

export const looksLikeSvgBuffer = (buffer: Buffer): boolean =>
  /<svg\b/i.test(decodeSvgProbeText(buffer))

export const assertSelfContainedSvg = (svgText: string): void => {
  if (SVG_SCRIPT_PATTERN.test(svgText)) {
    throw new Error('SVG script content is unsupported for duplicate check')
  }

  for (const pattern of [
    SVG_EXTERNAL_REFERENCE_PATTERN,
    SVG_STYLE_URL_PATTERN,
    SVG_STYLE_IMPORT_PATTERN
  ]) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null = null
    while ((match = pattern.exec(svgText))) {
      const ref = match[2] || match[1]
      if (ref && !isInternalSvgReference(ref)) {
        throw new Error('SVG external references are unsupported for duplicate check')
      }
    }
  }
}

export const resolveSvgRasterSize = (svgText: string): { width: number; height: number } => {
  const attributes = readSvgRootAttributes(svgText)
  const aspectRatio =
    attributes.viewBoxWidth && attributes.viewBoxHeight
      ? attributes.viewBoxWidth / attributes.viewBoxHeight
      : null

  let width = attributes.width
  let height = attributes.height

  if ((!width || !height) && aspectRatio) {
    if (!width && height) {
      width = height * aspectRatio
    } else if (width && !height) {
      height = width / aspectRatio
    } else if (!width && !height) {
      width = attributes.viewBoxWidth
      height = attributes.viewBoxHeight
    }
  }

  if (!width) {
    width = DEFAULT_SVG_WIDTH
  }

  if (!height) {
    height = DEFAULT_SVG_HEIGHT
  }

  return clampRasterSize(width, height)
}

export const rasterizeSvgToPngBuffer = async (
  svgBuffer: Buffer
): Promise<SvgRasterizationResult> => {
  const svgText = trimByteOrderMark(svgBuffer.toString('utf8'))
  assertSelfContainedSvg(svgText)

  const { width, height } = resolveSvgRasterSize(svgText)
  const svgDataUrl = `data:image/svg+xml;base64,${svgBuffer.toString('base64')}`

  await app.whenReady()

  const browserWindow = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })

  try {
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"
    />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
      }
    </style>
  </head>
  <body></body>
</html>`

    await browserWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const script = `(async () => {
      const svgDataUrl = ${JSON.stringify(svgDataUrl)};
      const width = ${JSON.stringify(width)};
      const height = ${JSON.stringify(height)};
      const image = new Image();
      image.decoding = 'sync';
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Failed to decode SVG in Chromium renderer'));
        image.src = svgDataUrl;
      });
      if (!Number.isFinite(image.naturalWidth) || image.naturalWidth <= 0 || !Number.isFinite(image.naturalHeight) || image.naturalHeight <= 0) {
        throw new Error('SVG dimensions are unavailable');
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Canvas 2D context is unavailable');
      }
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      return {
        pngDataUrl: canvas.toDataURL('image/png'),
        width,
        height
      };
    })()`

    const result = (await browserWindow.webContents.executeJavaScript(script, true)) as {
      pngDataUrl: string
      width: number
      height: number
    }

    return {
      pngBuffer: Buffer.from(result.pngDataUrl.slice(result.pngDataUrl.indexOf(',') + 1), 'base64'),
      width: result.width,
      height: result.height
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error || 'Unknown SVG error')
    throw new Error(`SVG rasterization failed: ${rawMessage}`)
  } finally {
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy()
    }
  }
}
