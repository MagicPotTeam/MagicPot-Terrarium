import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './types'
import { collectThreadImageHistory, selectMessagesForImageHistoryPolicy } from './imageHistory'

describe('collectThreadImageHistory', () => {
  const image = (
    digit: string,
    overrides: Partial<NonNullable<NonNullable<ChatMessage['attachments']>[number]['media']>> = {}
  ) => ({
    type: 'image' as const,
    url: 'data:image/png;base64,cHJpdmF0ZQ==',
    fileName: 'private.png',
    media: {
      version: 1 as const,
      kind: 'managed' as const,
      sha256: digit.repeat(64),
      mimeType: 'image/png',
      sizeBytes: 7,
      relativePath: 'hidden/original.png',
      originalUrl: 'https://private.invalid',
      ...overrides
    }
  })

  it('keeps the newest five image slots in reverse attachment order without copying paths or bytes', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', attachments: [image('0'), image('1'), image('2')] },
      { role: 'user', content: '', attachments: [image('3')] },
      {
        role: 'assistant',
        content: '',
        attachments: [
          image('4'),
          image('5', { status: 'missing' }),
          image('6'),
          { type: 'file', url: 'notes' }
        ]
      },
      { role: 'system', content: '', attachments: [image('7')] }
    ]
    const ref = (digit: string) => ({
      sha256: digit.repeat(64),
      mimeType: 'image/png',
      sizeBytes: 7
    })
    expect(collectThreadImageHistory(history)).toStrictEqual([
      ref('6'),
      null,
      ref('4'),
      null,
      ref('2')
    ])
  })

  it.each([
    image('a', { kind: 'project-asset' }),
    image('a', { status: 'corrupt' }),
    image('a', { mimeType: 'image/gif' }),
    image('x'),
    image('a', { sizeBytes: 0 }),
    { type: 'image' as const, url: 'blob:private' }
  ])('keeps an unavailable assistant image as a null slot (%#)', (attachment) => {
    expect(
      collectThreadImageHistory([{ role: 'assistant', content: '', attachments: [attachment] }])
    ).toStrictEqual([null])
  })
})

describe('selectMessagesForImageHistoryPolicy', () => {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: 'old text remains',
      attachments: [
        { type: 'image', url: 'old-image' },
        { type: 'file', url: 'old-file', fileName: 'notes.txt' }
      ]
    },
    { role: 'assistant', content: 'historical answer' },
    {
      role: 'user',
      content: 'latest text',
      attachments: [{ type: 'image', url: 'latest-image' }]
    }
  ]

  it('defaults to latest-user-turn without dropping historical text or files', () => {
    const selected = selectMessagesForImageHistoryPolicy(messages)

    expect(selected.map((message) => message.content)).toEqual([
      'old text remains',
      'historical answer',
      'latest text'
    ])
    expect(selected[0].attachments).toEqual([
      { type: 'file', url: 'old-file', fileName: 'notes.txt' }
    ])
    expect(selected[2].attachments).toEqual([{ type: 'image', url: 'latest-image' }])
  })

  it('includes every historical image in all mode', () => {
    const selected = selectMessagesForImageHistoryPolicy(messages, 'all')
    expect(
      selected
        .flatMap((message) => message.attachments || [])
        .filter((item) => item.type === 'image')
    ).toHaveLength(2)
  })

  it('strips provider image bytes after an image tool has consumed its inputs', async () => {
    const { stripImageAttachmentsForProviderFollowUp } = await import('./imageHistory')
    const selected = stripImageAttachmentsForProviderFollowUp([
      ...messages,
      {
        role: 'assistant',
        content: 'tool receipt',
        attachments: [{ type: 'file', url: 'tool-result' }]
      }
    ])

    expect(selected.map((message) => message.content)).toEqual([
      'old text remains',
      'historical answer',
      'latest text',
      'tool receipt'
    ])
    expect(selected.flatMap((message) => message.attachments || [])).toEqual([
      { type: 'file', url: 'old-file', fileName: 'notes.txt' },
      { type: 'file', url: 'tool-result' }
    ])
  })
})
