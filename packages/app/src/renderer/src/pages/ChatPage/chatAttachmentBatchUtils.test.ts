import { describe, expect, it } from 'vitest'
import {
  buildAttachmentBatchEntries,
  buildAttachmentBatchPrompt,
  chunkAttachmentBatchEntries,
  parseAttachmentBatchResponse,
  shouldBatchAttachments
} from './chatAttachmentBatchUtils'

describe('chatAttachmentBatchUtils', () => {
  it('only batches plain multi-attachment sends and skips report bundles', () => {
    expect(
      shouldBatchAttachments([
        { type: 'image', url: 'local-media:///a.png', fileName: 'a.png' },
        { type: 'image', url: 'local-media:///b.png', fileName: 'b.png' }
      ])
    ).toBe(true)

    expect(
      shouldBatchAttachments([
        {
          type: 'file',
          url: 'local-media:///bundle/report.md',
          fileName: 'report.md',
          reportBundleRole: 'primary-report'
        },
        { type: 'image', url: 'local-media:///a.png', fileName: 'a.png' }
      ])
    ).toBe(false)
  })

  it('chunks entries and keeps attachment-derived download names', () => {
    const entries = buildAttachmentBatchEntries([
      { type: 'image', url: 'local-media:///a.png', fileName: 'a.png' },
      { type: 'video', url: 'local-media:///clip.mp4', fileName: 'clip.mp4' },
      { type: 'model3d', url: 'local-media:///mesh.glb', fileName: 'mesh.glb' }
    ])

    expect(entries.map((entry) => entry.preferredDownloadBaseName)).toEqual(['a', 'clip', 'mesh'])
    expect(chunkAttachmentBatchEntries(entries, 2).map((chunk) => chunk.length)).toEqual([2, 1])
  })

  it('builds a strict batch prompt and parses its response sections', () => {
    const entries = buildAttachmentBatchEntries([
      {
        type: 'image',
        url: 'local-media:///ref-a.png',
        fileName: 'ref-a.png',
        sourceWidth: 1280,
        sourceHeight: 720
      },
      {
        type: 'image',
        url: 'local-media:///ref-b.png',
        fileName: 'ref-b.png',
        sizeBytes: 2048
      }
    ])

    const prompt = buildAttachmentBatchPrompt('Please label each image.', entries)
    expect(prompt).toContain('User request:')
    expect(prompt).toContain('1. ref-a.png [image, 1280x720]')
    expect(prompt).toContain('2. ref-b.png [image, 2048 bytes]')
    expect(prompt).toContain('<<<MAGICPOT_RESULT_1>>>')
    expect(prompt).toContain('<<<END_MAGICPOT_RESULT_2>>>')

    expect(
      parseAttachmentBatchResponse(
        [
          '<<<MAGICPOT_RESULT_1>>>',
          'first result',
          '<<<END_MAGICPOT_RESULT_1>>>',
          '<<<MAGICPOT_RESULT_2>>>',
          'second result',
          '<<<END_MAGICPOT_RESULT_2>>>'
        ].join('\n'),
        2
      )
    ).toEqual(['first result', 'second result'])

    expect(parseAttachmentBatchResponse('plain answer', 2)).toBeNull()
  })
})
