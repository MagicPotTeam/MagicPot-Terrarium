// Provider projections only. Never replace the durable receipt used for display and replay.
const completion = 'Image generation completed.'
const boundedInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

export function summarizeCompletedImageToolReceipt(content: unknown): string {
  // Current receipts contain managed references, not image bytes. Do not parse a large legacy blob.
  if (typeof content !== 'string' || content.length > 128 * 1024) return completion
  try {
    const r = JSON.parse(content)
    if (
      r?.completed !== true ||
      !boundedInt(r.image_count, 1, 16) ||
      !boundedInt(r.edited_images, 0, 5) ||
      !Array.isArray(r.images) ||
      r.images.length !== r.image_count ||
      !r.images.every(
        (image: unknown) =>
          image !== null && typeof image === 'object' && 'type' in image && image.type === 'image'
      ) ||
      (r.output_format !== undefined && !['gif', 'png', 'jpeg', 'webp'].includes(r.output_format))
    )
      return completion
    return `${completion} image_count=${r.image_count}; edited_images=${r.edited_images}${r.output_format ? `; output_format=${r.output_format}` : ''}.`
  } catch {
    return completion
  }
}

// Only project the image tool's defined argument fields. Old rows can contain extra
// arbitrary attachments, metadata, or a prompt replaced with an inline image.
export function projectImageToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
  const { prompt, transparent_background, num_last_images_to_include, gif } = args as Record<
    string,
    unknown
  >
  const projected: Record<string, unknown> = {}
  if (typeof prompt === 'string' && prompt.length <= 16000 && !containsInlineMedia(prompt))
    projected.prompt = prompt
  if (typeof transparent_background === 'boolean')
    projected.transparent_background = transparent_background
  if (boundedInt(num_last_images_to_include, 1, 5))
    projected.num_last_images_to_include = num_last_images_to_include
  if (gif && typeof gif === 'object' && !Array.isArray(gif)) {
    const { frame_count, frame_duration_ms } = gif as Record<string, unknown>
    projected.gif = {
      ...(boundedInt(frame_count, 2, 16) ? { frame_count } : {}),
      ...(boundedInt(frame_duration_ms, 20, 2000) ? { frame_duration_ms } : {})
    }
  }
  return projected
}

const containsInlineMedia = (text: string): boolean =>
  /data:\s*(?:image\/|[^,\s]*;base64)|base64\s*,|(?:iVBORw0KGgo|R0lGOD|\/9j\/|UklGR)|[A-Za-z0-9+/=_-]{100,}/iu.test(
    text
  )

export function projectImageToolId(id: unknown): string {
  return typeof id === 'string' &&
    id.length <= 256 &&
    /^[\w.:-]+$/u.test(id) &&
    !containsInlineMedia(id)
    ? id
    : ''
}
