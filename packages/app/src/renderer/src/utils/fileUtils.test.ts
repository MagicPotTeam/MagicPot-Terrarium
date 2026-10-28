import { describe, expect, it, vi } from 'vitest'

const { getHistoryMock } = vi.hoisted(() => ({
  getHistoryMock: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcComfy: { getHistory: getHistoryMock } })
}))

import { extractWorkflowFromImage, extractWorkflowFromPNG } from './fileUtils'

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const chunk = (type: string, data: Uint8Array = new Uint8Array()): Uint8Array => {
  const bytes = new Uint8Array(12 + data.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(data, 8)
  return bytes
}

const textChunk = (keyword: string, value: string): Uint8Array =>
  chunk('tEXt', new TextEncoder().encode(`${keyword}\0${value}`))

const iTextChunk = (keyword: string, value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value)
  const keywordBytes = new TextEncoder().encode(keyword)
  const data = new Uint8Array(keywordBytes.length + 5 + encoded.length)
  data.set(keywordBytes)
  let offset = keywordBytes.length
  data[offset++] = 0
  data[offset++] = 0
  data[offset++] = 0
  data[offset++] = 0
  data[offset++] = 0
  data.set(encoded, offset)
  return chunk('iTXt', data)
}

const png = (...chunks: Uint8Array[]): File => {
  const totalLength = PNG_SIGNATURE.length + chunks.reduce((sum, value) => sum + value.length, 0)
  const bytes = new Uint8Array(totalLength)
  bytes.set(PNG_SIGNATURE)
  let offset = PNG_SIGNATURE.length
  for (const part of chunks) {
    bytes.set(part, offset)
    offset += part.length
  }
  return new File([bytes], 'workflow.png', { type: 'image/png' })
}

describe('extractWorkflowFromPNG', () => {
  it('extracts JSON from legacy tEXt metadata', async () => {
    const workflow = '{"1":{"class_type":"LoadImage"}}'
    await expect(
      extractWorkflowFromPNG(png(textChunk('prompt', workflow), chunk('IEND')))
    ).resolves.toBe(workflow)
  })

  it('extracts UTF-8 JSON from uncompressed iTXt metadata', async () => {
    const workflow = '{"标题":"椅子","1":{"class_type":"LoadImage"}}'
    await expect(
      extractWorkflowFromPNG(png(iTextChunk('workflow', workflow), chunk('IEND')))
    ).resolves.toBe(workflow)
  })

  it('returns null rather than throwing for truncated chunk data', async () => {
    const malformedChunk = new Uint8Array(12)
    new DataView(malformedChunk.buffer).setUint32(0, 1024)
    malformedChunk.set(new TextEncoder().encode('tEXt'), 4)
    await expect(extractWorkflowFromPNG(png(malformedChunk))).resolves.toBeNull()
  })

  it('returns null for incomplete metadata fields', async () => {
    await expect(
      extractWorkflowFromPNG(png(chunk('tEXt', new TextEncoder().encode('prompt')), chunk('IEND')))
    ).resolves.toBeNull()
    await expect(
      extractWorkflowFromPNG(png(iTextChunk('workflow', ''), chunk('IEND')))
    ).resolves.toBeNull()
  })
})

describe('extractWorkflowFromImage history fallback', () => {
  it('uses prompt history when a file contains a malformed PNG chunk', async () => {
    const workflow = { '1': { class_type: 'LoadImage', inputs: {} } }
    getHistoryMock.mockResolvedValueOnce({
      'prompt-1': { prompt: [0, 'prompt-1', workflow, {}, []] }
    })

    const malformedChunk = new Uint8Array(12)
    new DataView(malformedChunk.buffer).setUint32(0, 2048)
    malformedChunk.set(new TextEncoder().encode('tEXt'), 4)

    await expect(extractWorkflowFromImage(png(malformedChunk), 'prompt-1')).resolves.toEqual({
      workflow,
      source: 'history'
    })
    expect(getHistoryMock).toHaveBeenCalledWith({ prompt_id: 'prompt-1' })
  })
})
