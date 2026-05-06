export const SVG_EXPORT_MIME_TYPE = 'image/svg+xml'

type BuildRasterBackedSvgMarkupOptions = {
  width: number
  height: number
  imageHref: string
  backgroundColor?: string
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeSvgLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 1
}

export function buildRasterBackedSvgMarkup({
  width,
  height,
  imageHref,
  backgroundColor
}: BuildRasterBackedSvgMarkupOptions): string {
  const safeWidth = normalizeSvgLength(width)
  const safeHeight = normalizeSvgLength(height)
  const escapedHref = escapeXmlAttribute(imageHref)
  const escapedBackground =
    backgroundColor && backgroundColor !== 'transparent'
      ? escapeXmlAttribute(backgroundColor)
      : null

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}" fill="none">`,
    escapedBackground
      ? `  <rect x="0" y="0" width="${safeWidth}" height="${safeHeight}" fill="${escapedBackground}" />`
      : null,
    `  <image x="0" y="0" width="${safeWidth}" height="${safeHeight}" preserveAspectRatio="none" href="${escapedHref}" xlink:href="${escapedHref}" />`,
    '</svg>'
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}
