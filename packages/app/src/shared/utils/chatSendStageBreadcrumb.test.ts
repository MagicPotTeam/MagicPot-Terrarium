import { describe, expect, it } from 'vitest'
import { parseChatSendStageBreadcrumb, parseChatSendStageReport, summarizeChatSendStage, withJsHeapNumbers } from './chatSendStageBreadcrumb'

describe('chat send-stage breadcrumb', () => {
  it('counts images, sizes and inline data: URLs without copying any content', () => {
    const inline = 'data:image/jpeg;base64,' + 'A'.repeat(400)
    const breadcrumb = summarizeChatSendStage(
      'request-built',
      [
        { attachments: [{ type: 'image', url: inline }, { type: 'image', url: 'local-media:///a.png', sizeBytes: 1234 }] },
        { attachments: [{ type: 'file', url: 'data:text/plain;base64,QQ==' }] },
        {}
      ]
    )
    expect(breadcrumb).toEqual({
      stage: 'request-built',
      messageCount: 3,
      imageCount: 2,
      imageBytes: 300 + 1234,
      dataUrlCount: 2,
      dataUrlChars: inline.length + 'data:text/plain;base64,QQ=='.length
    })
    expect(parseChatSendStageBreadcrumb(breadcrumb)).toEqual(breadcrumb)
  })

  it('the page reports no JS heap number, and a breadcrumb that claims one is not a breadcrumb', () => {
    const counts = summarizeChatSendStage('request-built', [{}])
    expect(Object.keys(counts).sort()).toEqual(['dataUrlChars', 'dataUrlCount', 'imageBytes', 'imageCount', 'messageCount', 'stage'])
    // performance.memory said 26 MB during a real out-of-memory death: never take it from the page.
    expect(parseChatSendStageBreadcrumb({ ...counts, usedJSHeapSize: 26_000_000 })).toBeNull()
    expect(parseChatSendStageBreadcrumb({ ...counts, jsHeapSizeLimit: 2_330_000_000 })).toBeNull()
  })

  it('the report main keeps adds the heap numbers the preload read, and only whole non-negative numbers', () => {
    const counts = summarizeChatSendStage('request-built', [{}])
    const report = withJsHeapNumbers(counts, { usedJSHeapSize: 1_932_642_304, jsHeapSizeLimit: 2_248_146_944 })
    expect(report).toEqual({ ...counts, usedJSHeapSize: 1_932_642_304, jsHeapSizeLimit: 2_248_146_944 })
    expect(parseChatSendStageReport(report)).toEqual(report)
    // Without a reading (or with a broken one) the counts still go through, without a heap number.
    expect(withJsHeapNumbers(counts, null)).toEqual(counts)
    expect(withJsHeapNumbers(counts, { usedJSHeapSize: Number.NaN, jsHeapSizeLimit: -1 })).toEqual(counts)
    expect(withJsHeapNumbers(counts, { usedJSHeapSize: 1.5, jsHeapSizeLimit: 7 })).toEqual({ ...counts, jsHeapSizeLimit: 7 })
    expect(parseChatSendStageReport(counts)).toEqual(counts)
  })

  it.each([
    null,
    'request-built',
    { stage: 'request-built' },
    { stage: 'request-built', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, usedJSHeapSize: '1' },
    { stage: 'request-built', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, jsHeapSizeLimit: -1 },
    { stage: 'request-built', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, usedJSHeapSize: 1, text: 'hello' }
  ])('the report rejects anything but counts and the two heap numbers: %j', (value) => {
    expect(parseChatSendStageReport(value)).toBeNull()
  })

  it('knows the stage of a request that failed or was aborted', () => {
    const failed = summarizeChatSendStage('reply-failed', [{}, {}])
    expect(parseChatSendStageBreadcrumb(failed)).toEqual({ stage: 'reply-failed', messageCount: 2, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 })
  })

  it.each([
    null,
    [],
    { stage: 'request-built' },
    { stage: 'unknown', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', messageCount: -1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0 },
    { stage: 'request-start', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, text: 'hello' },
    { stage: 'request-start', messageCount: 1, imageCount: 0, imageBytes: 0, dataUrlCount: 0, dataUrlChars: 0, usedJSHeapSize: 1 }
  ])('rejects anything but the exact shape: %j', (value) => {
    expect(parseChatSendStageBreadcrumb(value)).toBeNull()
  })
})
