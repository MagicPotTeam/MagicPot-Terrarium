import { describe, expect, it, vi } from 'vitest'
import { augmentMessageContentWithFileAttachments, expandReportBundleAttachmentsStrict } from './chatAttachmentPromptUtils'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

describe('expandReportBundleAttachmentsStrict', () => {
  const primary = (id: string, url: string): ChatAttachment => ({ type: 'file', url: 'file:///report', reportBundleRole: 'primary-report', reportBundleId: id, reportBundleManifestUrl: url })
  const manifest = (bundleId: string, entries: unknown[]) => JSON.stringify({ version: 1, bundleId, entries, extra: 'allowed' })
  const image = (fileName: string) => ({ role: 'report-image', fileName, relativePath: fileName })
  const error = 'Report bundle expansion failed'

  it('accepts omitted or undefined primary ID but rejects an empty ID', async () => {
    const { reportBundleId: _ignored, ...withoutId } = primary('a', 'file:///a/manifest.json')
    const reader = vi.fn(async () => manifest('a', []))
    await expect(expandReportBundleAttachmentsStrict([withoutId], reader)).resolves.toEqual([withoutId])
    await expect(expandReportBundleAttachmentsStrict([{ ...withoutId, reportBundleId: '' }], reader)).rejects.toThrow(error)
    await expect(expandReportBundleAttachmentsStrict([{ ...withoutId, reportBundleId: undefined }], reader)).resolves.toEqual([{ ...withoutId, reportBundleId: undefined }])
  })

  it('copies records without modifying or cloning their nested metadata', async () => {
    const nested = Object.freeze({ value: 'original' })
    const metadata = Object.freeze({ nested })
    const item = Object.freeze({ ...primary('a', 'file:///a/manifest.json'), metadata })
    const input: ChatAttachment[] = [item]
    Object.freeze(input)
    const result = await expandReportBundleAttachmentsStrict(input, async () => manifest('a', []))
    expect(result).not.toBe(input)
    expect(result?.[0]).not.toBe(input[0])
    expect(result?.[0].metadata).toBe(metadata)
    expect(nested.value).toBe('original')
    const empty: ChatAttachment[] = []
    expect(await expandReportBundleAttachmentsStrict(empty)).not.toBe(empty)
  })

  it('does not conflate distinct tuple fields containing the old key separator', async () => {
    const input = [primary('a', 'file:///a/manifest.json')]
    // The former delimiter-joined keys collide across URL and fileName boundaries.
    const collisionEntries = [
      { role: 'report-image', fileName: 'x::y', refName: 'r', sourceUrl: 'https://example.invalid/a' },
      { role: 'report-image', fileName: 'y', refName: 'r', sourceUrl: 'https://example.invalid/a::x' }
    ]
    const output = await expandReportBundleAttachmentsStrict(input, async () => manifest('a', collisionEntries))
    expect(output?.filter(item => item.type === 'image')).toHaveLength(2)
  })

  it('keeps identical image locations in distinct bundles while deduplicating within each', async () => {
    const a = primary('a', 'file:///a/manifest.json')
    const b = primary('b', 'file:///b/manifest.json')
    const reader = vi.fn(async (url: string) => manifest(url.includes('/a/') ? 'a' : 'b', [
      { role: 'report-image', fileName: 'same.png', sourceUrl: 'https://example.invalid/same.png' },
      { role: 'report-image', fileName: 'same.png', sourceUrl: 'https://example.invalid/same.png' }
    ]))
    const output = await expandReportBundleAttachmentsStrict([a, b], reader)
    expect(output?.filter(item => item.type === 'image').map(item => item.reportBundleId)).toEqual(['a', 'b'])
  })

  it('distinguishes successful zero images and reads a repeated manifest only once', async () => {
    const input = [primary('a', 'file:///a/manifest.json'), primary('a', 'file:///a/manifest.json')]
    const reader = vi.fn(async () => manifest('a', []))
    expect(await expandReportBundleAttachmentsStrict(input, reader)).toEqual(input)
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('accepts every defined non-image role without manufacturing images', async () => {
    const input = [primary('a', 'file:///a/manifest.json')]
    const reader = vi.fn(async () => manifest('a', ['primary-report', 'report-ocr', 'manifest'].map(role => ({ role }))))
    expect(await expandReportBundleAttachmentsStrict(input, reader)).toEqual(input)
  })

  it('expands multiple bundles in order and deduplicates existing and repeated image entries', async () => {
    const a = primary('a', 'file:///a/manifest.json')
    const b = primary('b', 'file:///b/manifest.json')
    const reader = vi.fn(async (url: string) => url.includes('/a/') ? manifest('a', [image('one.png'), image('one.png')]) : manifest('b', [image('two.png')]))
    const first = await expandReportBundleAttachmentsStrict([a, b], reader)
    expect(first?.map(item => item.fileName)).toEqual([undefined, undefined, 'one.png', 'two.png'])
    expect(await expandReportBundleAttachmentsStrict(first, reader)).toEqual(first)
  })

  it.each([
    ['missing URL', [primary('a', '')], async () => '{}'],
    ['bad JSON', [primary('a', 'file:///secret')], async () => '{'],
    ['bad manifest', [primary('a', 'file:///secret')], async () => '{"bundleId":"a","entries":null}'],
    ['bad version', [primary('a', 'file:///secret')], async () => JSON.stringify({ version: 2, bundleId: 'a', entries: [] })],
    ['missing role', [primary('a', 'file:///secret')], async () => manifest('a', [{ fileName: 'x.png' }])],
    ['unknown role', [primary('a', 'file:///secret')], async () => manifest('a', [{ role: 'other' }])],
    ['unsupported scheme', [primary('a', 'file:///secret')], async () => manifest('a', [{ role: 'report-image', fileName: 'x.png', sourceUrl: 'ftp://example.com/x.png' }])],
    ['invalid mime type', [primary('a', 'file:///secret')], async () => manifest('a', [{ ...image('x.png'), mimeType: 42 }])],
    ['missing image location', [primary('a', 'file:///secret')], async () => manifest('a', [{ role: 'report-image', fileName: 'x.png' }])],
    ['relative source URL', [primary('a', 'file:///secret')], async () => manifest('a', [{ role: 'report-image', fileName: 'x.png', sourceUrl: 'relative.png' }])],
    ['mismatched primary', [primary('a', 'file:///secret')], async () => manifest('b', [])],
    ['duplicate identity conflict', [primary('a', 'file:///one'), primary('a', 'file:///two')], async () => manifest('a', [])],
    ['reader failure', [primary('a', 'file:///secret')], async () => { throw new Error('file:///private-sensitive') }]
  ])('rejects %s with fixed redacted error', async (_name, input, reader) => {
    await expect(expandReportBundleAttachmentsStrict(input as ChatAttachment[], reader as (url: string) => Promise<string>)).rejects.toThrowError(error)
    await expect(expandReportBundleAttachmentsStrict(input as ChatAttachment[], reader as (url: string) => Promise<string>)).rejects.not.toThrow('secret')
  })

  it('does not mutate or return a partial expansion on a later failure', async () => {
    const input = [primary('a', 'file:///a/manifest.json'), primary('b', 'file:///b/manifest.json')]
    const before = structuredClone(input)
    const reader = vi.fn(async (url: string) => url.includes('/a/') ? manifest('a', [image('one.png')]) : manifest('b', [{ role: 'report-image', fileName: 'broken' }]))
    await expect(expandReportBundleAttachmentsStrict(input, reader)).rejects.toThrow(error)
    expect(input).toEqual(before)
  })
})

describe('augmentMessageContentWithFileAttachments', () => {
  it('appends text previews for text-like file attachments', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/note.txt',
      fileName: 'note.txt',
      mimeType: 'text/plain'
    }

    const nextContent = await augmentMessageContentWithFileAttachments(
      [attachment],
      'Summarize this.',
      vi.fn(async () => 'hello from file')
    )

    expect(nextContent).toContain('Summarize this.')
    expect(nextContent).toContain('[Attached file] note.txt')
    expect(nextContent).toContain('hello from file')
  })

  it('skips file attachments that already have canvas summaries in content', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/spec.md',
      fileName: 'spec.md',
      mimeType: 'text/markdown'
    }
    const readAttachmentText = vi.fn(async () => 'should not be used')

    const nextContent = await augmentMessageContentWithFileAttachments(
      [attachment],
      '[Canvas file] spec.md\nexisting summary',
      readAttachmentText
    )

    expect(nextContent).toBe('[Canvas file] spec.md\nexisting summary')
    expect(readAttachmentText).not.toHaveBeenCalled()
  })

  it('falls back to binary summaries for non-text file attachments', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/slides.pptx',
      fileName: 'slides.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }

    const nextContent = await augmentMessageContentWithFileAttachments([attachment], '')

    expect(nextContent).toContain('[Attached file] slides.pptx')
    expect(nextContent).toContain('slides.pptx')
    expect(nextContent).toContain(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(nextContent).toContain('file attached: slides.pptx')
  })

  it('adds readable summaries for non-image video and 3D attachments', async () => {
    const nextContent = await augmentMessageContentWithFileAttachments(
      [
        {
          type: 'video',
          url: 'file:///demo/clip.mp4',
          fileName: 'clip.mp4',
          mimeType: 'video/mp4'
        },
        {
          type: 'model3d',
          url: 'file:///demo/model.glb',
          fileName: 'model.glb',
          mimeType: 'model/gltf-binary'
        }
      ],
      ''
    )

    expect(nextContent).toContain('[Attached video] clip.mp4')
    expect(nextContent).toContain('[Attached 3D model] model.glb')
    expect(nextContent).toContain('video attached: clip.mp4')
    expect(nextContent).toContain('3D model attached: model.glb')
  })

  it('adds explicit metadata summaries for image attachments', async () => {
    const nextContent = await augmentMessageContentWithFileAttachments(
      [
        {
          type: 'image',
          url: 'file:///demo/reference.png',
          fileName: 'reference.png',
          mimeType: 'image/png',
          sizeBytes: 2048,
          sourceWidth: 1536,
          sourceHeight: 1024
        }
      ],
      'Please tag this image.'
    )

    expect(nextContent).toContain('Please tag this image.')
    expect(nextContent).toContain('[Attached image] reference.png')
    expect(nextContent).toContain('fileName="reference.png"')
    expect(nextContent).toContain('sizeBytes=2048')
    expect(nextContent).toContain('resolution=1536x1024')
    expect(nextContent).toContain('image attached: reference.png')
  })

  it('skips attachments excluded by the caller', async () => {
    const attachment: ChatAttachment = {
      type: 'file',
      url: 'file:///demo/spec.md',
      fileName: 'spec.md',
      mimeType: 'text/markdown'
    }
    const readAttachmentText = vi.fn(async () => 'should not be used')

    const nextContent = await augmentMessageContentWithFileAttachments(
      [attachment],
      'Keep only the user instruction.',
      readAttachmentText,
      {
        skipAttachment: () => true
      }
    )

    expect(nextContent).toBe('Keep only the user instruction.')
    expect(readAttachmentText).not.toHaveBeenCalled()
  })
})
