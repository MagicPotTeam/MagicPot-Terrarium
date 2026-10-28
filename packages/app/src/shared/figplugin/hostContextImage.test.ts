import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  HOST_CONTEXT_IMAGE_MAX_BYTES,
  HOST_CONTEXT_IMAGE_MAX_DIMENSION,
  HOST_CONTEXT_IMAGE_TOKEN_BUDGET,
  contextImageSummary,
  hostContextImageSchema,
  type HostContextImage
} from './hostContextImage'
import { figPluginBridgePrepareRequestSchema, figPluginBridgePreviewSchema } from './bridge'

const chunk = (type: string, data: Buffer): Buffer => {
  const output = Buffer.alloc(data.length + 12)
  output.writeUInt32BE(data.length)
  output.write(type, 4, 4, 'ascii')
  data.copy(output, 8)
  let crc = 0xffffffff
  for (const byte of output.subarray(4, -4)) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
  return output
}
const header = (width = 1, height = 1): Buffer => {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width)
  data.writeUInt32BE(height, 4)
  data[8] = 8
  data[9] = 6
  return chunk('IHDR', data)
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const data = chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255])))
const end = chunk('IEND', Buffer.alloc(0))
const png = (chunks: Buffer[] = [header(), data, end]) => Buffer.concat([signature, ...chunks])
const image = (bytes = png()): HostContextImage => ({
  version: 1,
  kind: 'host-context-image',
  captureId: 'a'.repeat(32),
  targetId: '1:2',
  mimeType: 'image/png',
  width: 1,
  height: 1,
  sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytesBase64: bytes.toString('base64')
})
const request = (host: 'figma' | 'photoshop' = 'figma') => {
  const targetId = host === 'figma' ? '1:2' : '42'
  const type = host === 'figma' ? 'RECTANGLE' : 'pixel'
  const scopeId = host === 'figma' ? 'page' : '7'
  return {
    protocol: 1,
    requestId: 'owned-image',
    sequence: 1,
    prompt: 'Describe this selected object',
    context: {
      selectionRevision: 'a'.repeat(32),
      nodes: [{ id: targetId, type, name: 'Owned', locked: false }]
    },
    featureId: 'plan-preview',
    hostContext: {
      version: 1,
      host,
      documentId: host === 'figma' ? 'document' : '7',
      scopeId,
      captureId: 'a'.repeat(32),
      selectedIds: [targetId],
      nodes: [
        {
          id: targetId,
          type,
          name: 'Owned',
          parentId: scopeId,
          ancestors: [],
          locked: false,
          visible: true,
          commands: ['node.rename']
        }
      ]
    },
    contextImage: { ...image(), targetId }
  }
}

describe('bounded host context image contract', () => {
  it('accepts canonical PNG bytes and returns only declared metadata from the summary', () => {
    const value = image()
    expect(hostContextImageSchema.parse(value)).toEqual(value)
    expect(contextImageSummary(value)).toEqual({
      version: 1,
      kind: 'host-context-image',
      captureId: value.captureId,
      targetId: '1:2',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256
    })
    expect(
      contextImageSummary({ ...value, path: 'PRIVATE' } as HostContextImage)
    ).not.toHaveProperty('path')
    expect(HOST_CONTEXT_IMAGE_MAX_BYTES).toBe(24576)
    expect(HOST_CONTEXT_IMAGE_MAX_DIMENSION).toBe(256)
    expect(HOST_CONTEXT_IMAGE_TOKEN_BUDGET).toBe(4096)
  })

  it.each([
    { version: 2 },
    { kind: 'image' },
    { mimeType: 'image/jpeg' },
    { captureId: 'A'.repeat(32) },
    { captureId: 'a'.repeat(32) + '\n' },
    { sha256: 'A'.repeat(64) },
    { sha256: 'a'.repeat(64) + '\n' },
    { width: 0 },
    { width: 257 },
    { width: 2 },
    { height: 2 },
    { height: 1.5 },
    { sizeBytes: 69 },
    { sizeBytes: 24577 },
    { targetId: '' },
    { targetId: 'x'.repeat(129) },
    { url: 'https://example.test/private.png' },
    { path: 'C:\\private.png' }
  ])('rejects a substituted or unknown field: %j', (patch) => {
    expect(hostContextImageSchema.safeParse({ ...image(), ...patch }).success).toBe(false)
  })

  it.each([
    (value: string) => value + '\n',
    (value: string) => value.replace('gg==', 'gh=='),
    (value: string) => value.slice(0, -1),
    (value: string) => 'data:image/png;base64,' + value,
    (value: string) => value.replace('+', '-'),
    () => 'A'.repeat(32772),
    () => ''
  ])('rejects noncanonical or over-budget base64 %#', (change) => {
    const value = image()
    expect(
      hostContextImageSchema.safeParse({ ...value, bytesBase64: change(value.bytesBase64) }).success
    ).toBe(false)
  })

  it.each([
    () => Buffer.alloc(32),
    () => png([header()]),
    () => png([header(), end]),
    () => png([header(), chunk('IDAT', Buffer.alloc(0)), end]),
    () => png([header(), data]),
    () => png([header(), header(), data, end]),
    () => png([header(), chunk('acTL', Buffer.alloc(8)), data, end]),
    () => png([header(), chunk('ABCD', Buffer.alloc(1)), data, end]),
    () => png([header(), data, chunk('tEXt', Buffer.from('note\0owned')), data, end]),
    () => Buffer.concat([png(), Buffer.from([0])]),
    () => {
      const bytes = png()
      bytes[40] ^= 1
      return bytes
    },
    () => {
      const bytes = png()
      bytes.writeUInt32BE(0xffffffff, 33)
      return bytes
    },
    () => png([header(257), data, end])
  ])('rejects invalid, animated, truncated or oversized PNG structure %#', (makeBytes) => {
    expect(hostContextImageSchema.safeParse(image(makeBytes())).success).toBe(false)
  })

  it('accepts the exact byte cap and rejects one byte beyond it without raising request limits', () => {
    const paddingLength = HOST_CONTEXT_IMAGE_MAX_BYTES - png().length - 12
    const atLimit = image(
      png([header(), chunk('tEXt', Buffer.alloc(paddingLength, 65)), data, end])
    )
    expect(atLimit.sizeBytes).toBe(HOST_CONTEXT_IMAGE_MAX_BYTES)
    expect(atLimit.bytesBase64.length).toBe(32768)
    expect(hostContextImageSchema.safeParse(atLimit).success).toBe(true)
    const overLimit = image(
      png([header(), chunk('tEXt', Buffer.alloc(paddingLength + 1, 65)), data, end])
    )
    expect(hostContextImageSchema.safeParse(overLimit).success).toBe(false)
    const input = request()
    input.contextImage = atLimit
    input.prompt = '\u0000'.repeat(16000)
    expect(figPluginBridgePrepareRequestSchema.safeParse(input).success).toBe(false)
  })

  it.each(['figma', 'photoshop'] as const)(
    'allows only exact selected %s planning context without granting native execution',
    (host) => {
      const input = request(host)
      const parsed = figPluginBridgePrepareRequestSchema.parse(input)
      expect(parsed.contextImage).toEqual(input.contextImage)
      expect(parsed.hostContext).not.toHaveProperty('execution')
      for (const invalid of [
        { ...input, featureId: undefined },
        { ...input, hostContext: undefined },
        { ...input, hostContext: { ...input.hostContext, host: 'illustrator' } },
        { ...input, hostContext: { ...input.hostContext, selectedIds: undefined } },
        { ...input, context: { ...input.context, selectionRevision: 'b'.repeat(32) } },
        { ...input, context: { ...input.context, nodes: [] } },
        { ...input, hostContext: { ...input.hostContext, selectedIds: ['outside'] } },
        { ...input, contextImage: { ...input.contextImage, captureId: 'b'.repeat(32) } },
        { ...input, contextImage: { ...input.contextImage, targetId: 'outside' } }
      ])
        expect(figPluginBridgePrepareRequestSchema.safeParse(invalid).success).toBe(false)
      const preview = {
        callId: 'b'.repeat(32),
        pluginId: `owned.${host}`,
        host,
        projectId: 'owned',
        profileId: 'vision',
        profileRevision: 'c'.repeat(64),
        expiresAt: 1_800_000_000_000,
        payloadSha256: 'd'.repeat(64),
        estimatedInputTokens: 4200,
        context: input.context,
        prompt: input.prompt,
        featureId: input.featureId,
        hostContext: input.hostContext,
        contextImage: input.contextImage
      }
      expect(figPluginBridgePreviewSchema.safeParse(preview).success).toBe(true)
      expect(
        figPluginBridgePreviewSchema.safeParse({
          ...preview,
          contextImage: { ...image(), targetId: 'outside' }
        }).success
      ).toBe(false)
      const { contextImage: _image, ...legacy } = input
      expect(figPluginBridgePrepareRequestSchema.safeParse(legacy).success).toBe(true)
    }
  )
})
