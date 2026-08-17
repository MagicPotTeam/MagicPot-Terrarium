import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './types'
import { selectMessagesForImageHistoryPolicy } from './imageHistory'

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
})
