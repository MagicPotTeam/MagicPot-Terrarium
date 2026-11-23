import { mkdirSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatResult } from '@shared/llm'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

let mediaRoot = ''

vi.mock('./chatMediaDir', () => ({
  getChatMediaDir: (scope?: string) => {
    const target = scope ? path.join(mediaRoot, scope) : mediaRoot
    mkdirSync(target, { recursive: true })
    return target
  },
  sanitizeChatMediaScope: (value?: string | null) => {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
    return normalized || undefined
  }
}))

import { persistCodexImageArtifacts } from './codexAttachmentArtifacts'

function png(width = 1, height = 1): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  const iend = Buffer.alloc(12)
  iend.write('IEND', 4, 'ascii')
  return Buffer.concat([signature, ihdr, iend])
}

const dataUrl = (bytes = png()): string => `data:image/png;base64,${bytes.toString('base64')}`

const resultWithImage = (overrides: Record<string, unknown> = {}): LLMChatResult => ({
  content: 'generated',
  attachments: [
    {
      type: 'image',
      url: dataUrl(),
      mimeType: 'image/png',
      fileName: 'kept-name.png',
      sizeBytes: png().length,
      sourceWidth: 640,
      sourceHeight: 480,
      metadata: { existing: true },
      ...overrides
    }
  ]
})

describe('persistCodexImageArtifacts', () => {
  beforeEach(async () => {
    mediaRoot = await createNodeTestArtifactDir('codex-attachment-artifacts')
    await Promise.all(
      ['conversation-one', 'same-scope', 'scope-a', 'scope-b', 'failure', 'codex-image'].map(
        (scope) =>
          fs.mkdir(path.join(mediaRoot, `codex-images-${scope}`), {
            recursive: true
          })
      )
    )
  })

  afterEach(async () => {
    await fs.rm(mediaRoot, { recursive: true, force: true })
  })

  it('returns a managed reference and URL while preserving artifact fields and safe metadata', async () => {
    const persisted = await persistCodexImageArtifacts(resultWithImage(), {
      enabled: true,
      conversationId: 'Conversation One',
      responseId: 'Response One'
    })
    const attachment = persisted.attachments?.[0]

    expect(attachment).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      fileName: 'kept-name.png',
      sizeBytes: png().length,
      sourceWidth: 640,
      sourceHeight: 480,
      media: {
        version: 1,
        kind: 'managed',
        mimeType: 'image/png',
        originalFileName: 'kept-name.png'
      },
      metadata: {
        existing: true,
        codexArtifact: true
      }
    })
    expect(attachment?.url).toBe(attachment?.metadata?.localMediaUrl)
    expect(attachment?.url).toMatch(/^local-media:\/\//)
    expect(attachment?.metadata?.fileUrl).toBe(attachment?.url)
    expect(attachment?.metadata?.savedPath).toBeTruthy()
    await expect(fs.stat(String(attachment?.metadata?.savedPath))).resolves.toBeDefined()
    expect(attachment?.media?.relativePath).toMatch(/^codex-images-conversation-one\/originals\//)
    await expect(
      fs.readFile(path.resolve(mediaRoot, attachment?.media?.relativePath || ''))
    ).resolves.toEqual(png())
  })

  it('deduplicates equal bytes within a storage scope', async () => {
    const input: LLMChatResult = {
      content: '',
      attachments: [
        { type: 'image', url: dataUrl() },
        { type: 'image', url: dataUrl() }
      ]
    }
    const persisted = await persistCodexImageArtifacts(input, {
      enabled: true,
      conversationId: 'same-scope',
      responseId: 'response'
    })

    expect(persisted.attachments?.[0].media?.relativePath).toBe(
      persisted.attachments?.[1].media?.relativePath
    )
    expect(persisted.attachments?.[0].url).toBe(persisted.attachments?.[1].url)
    const originals = path.join(mediaRoot, 'codex-images-same-scope', 'originals')
    const files = await fs.readdir(path.join(originals, (await fs.readdir(originals))[0]))
    expect(files).toHaveLength(1)
  })

  it('keeps identical bytes under different scoped roots', async () => {
    const first = await persistCodexImageArtifacts(resultWithImage(), {
      enabled: true,
      conversationId: 'scope-a'
    })
    const second = await persistCodexImageArtifacts(resultWithImage(), {
      enabled: true,
      conversationId: 'scope-b'
    })

    expect(first.attachments?.[0].media?.relativePath).toContain('codex-images-scope-a/')
    expect(second.attachments?.[0].media?.relativePath).toContain('codex-images-scope-b/')
    expect(first.attachments?.[0].media?.relativePath).not.toBe(
      second.attachments?.[0].media?.relativePath
    )
    expect(first.attachments?.[0].url).not.toBe(second.attachments?.[0].url)
    expect(first.attachments?.[0].url).toContain('/codex-images-scope-a/')
    expect(second.attachments?.[0].url).toContain('/codex-images-scope-b/')
  })

  it('leaves legacy non-image and non-data attachments unchanged', async () => {
    const input: LLMChatResult = {
      content: '',
      attachments: [
        { type: 'file', url: 'data:text/plain;base64,SGVsbG8=' },
        { type: 'image', url: 'https://example.test/image.png' }
      ]
    }

    await expect(persistCodexImageArtifacts(input, { enabled: true })).resolves.toBe(input)
  })

  it('uses imported MIME and size and corrects a mismatched filename extension', async () => {
    const bytes = png(2, 3)
    const persisted = await persistCodexImageArtifacts(
      resultWithImage({
        url: dataUrl(bytes),
        mimeType: 'image/jpeg',
        sizeBytes: 999,
        fileName: 'safe.stem.jpeg'
      }),
      { enabled: true, conversationId: 'conversation-one' }
    )

    expect(persisted.attachments?.[0]).toMatchObject({
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      fileName: 'safe.stem.png',
      media: {
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        originalFileName: 'safe.stem.png'
      }
    })
  })

  it('leaves an invalid generated image attachment unchanged', async () => {
    const invalid = resultWithImage({ url: dataUrl(Buffer.from('not a png')) })

    await expect(
      persistCodexImageArtifacts(invalid, {
        enabled: true,
        conversationId: 'failure'
      })
    ).resolves.toBe(invalid)
  })

  it('propagates unexpected storage errors', async () => {
    const rootDirectory = mediaRoot
    const rootFile = path.join(rootDirectory, 'not-a-directory')
    await fs.writeFile(rootFile, 'occupied')
    mediaRoot = rootFile

    await expect(
      persistCodexImageArtifacts(resultWithImage(), {
        enabled: true,
        conversationId: 'failure'
      })
    ).rejects.toThrow()
    mediaRoot = rootDirectory
  })
})
