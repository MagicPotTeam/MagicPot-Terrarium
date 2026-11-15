import { describe, expect, it } from 'vitest'
import { parseChatSendStageBreadcrumb, summarizeChatSendStage } from './chatSendStageBreadcrumb'

describe('chat send-stage breadcrumb', () => {
  it('counts images, sizes and inline data: URLs without copying any content', () => {
    const inline = 'data:image/jpeg;base64,' + 'A'.repeat(400)
    const breadcrumb = summarizeChatSendStage(
      'request-built',
      [
        { attachments: [{ type: 'image', url: inline }, { type: 'image', url: 'local-media:///a.png', sizeBytes: 1234 }] },
        { attachments: [{ type: 'file', url: 'data:text/plain;base64,QQ==' }] },
        {}
      ],
      { usedJSHeapSize: 50_000_000, jsHeapSizeLimit: 4_000_000_000 }
    )
    expect(breadcrumb).toEqual({
      stage: 'request-built',
      messageCount: 3,
      imageCount: 2,
      imageBytes: 300 + 1234,
      dataUrlCount: 2,
      dataUrlChars: inline.length + 'data:text/plain;base64,QQ=='.length,
      usedJSHeapSize: 50_000_000,
      jsHeapSizeLimit: 4_000_000_000
    })
    expect(parseChatSendStageBreadcrumb(breadcrumb)).toEqual(breadcrumb)
  })

  it.each([
    null,
    [],
    { stage: 'request-built' },
    { stage: 'unknown', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', messageCount: -1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, text: 'hello' },
    { stage: 'request-start', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, usedJSHeapSize: '1' }
  ])('rejects anything but the exact shape: %j', (value) => {
    expect(parseChatSendStageBreadcrumb(value)).toBeNull()
  })
})
