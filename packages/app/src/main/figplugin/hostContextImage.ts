import { createHash } from 'node:crypto'
import { hostContextImageSchema, type HostContextImage } from '@shared/figplugin/hostContextImage'

export function validateHostContextImageBytes(input: HostContextImage): Buffer {
  const image = hostContextImageSchema.parse(input)
  const bytes = Buffer.from(image.bytesBase64, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== image.sha256)
    throw new Error('INVALID_CONTEXT_IMAGE')
  return bytes
}
