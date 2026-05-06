import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { BUILT_IN_TAGGING_SKILL_ID } from './builtInSkills'
import {
  buildAssistantReplyDownloadBaseName,
  buildAssistantReplyDownloadFileName,
  extractAssistantReplyTextContent,
  resolveAssistantReplyDownloadMode,
  resolveAssistantSidecarExportEntries
} from './chatReplyDownloadUtils'

describe('chatReplyDownloadUtils', () => {
  it('uses the previous media attachment file name when available', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: '',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///demo/reference.png',
            fileName: 'reference.png'
          }
        ]
      },
      {
        role: 'assistant',
        content: '# 打标结果'
      }
    ]

    expect(buildAssistantReplyDownloadBaseName(messages, 1)).toBe('reference')
    expect(buildAssistantReplyDownloadFileName(messages, 1, '.md')).toBe('reference.md')
  })

  it('prefers the assistant message explicit download base name when present', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'batch upload'
      },
      {
        role: 'assistant',
        content: '# Label A',
        preferredDownloadBaseName: 'hero-shot'
      }
    ]

    expect(buildAssistantReplyDownloadBaseName(messages, 1)).toBe('hero-shot')
    expect(buildAssistantReplyDownloadFileName(messages, 1, '.txt')).toBe('hero-shot.txt')
    expect(resolveAssistantReplyDownloadMode(messages, 1)).toBe('sidecar')
  })

  it('truncates plain-text prompts using chinese/english equivalent length', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: '这是一段用于测试下载文件名截断规则的提示词'
      },
      {
        role: 'assistant',
        content: 'reply'
      }
    ]

    expect(buildAssistantReplyDownloadBaseName(messages, 1)).toBe('这是一段用于测试下载')
  })

  it('falls back to a readable english slice for latin prompts', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'label this cinematic concept art with dramatic lighting'
      },
      {
        role: 'assistant',
        content: 'reply'
      }
    ]

    expect(buildAssistantReplyDownloadBaseName(messages, 1)).toBe('label this cinematic')
  })

  it('treats built-in tagging sessions as sidecar-oriented even without an explicit assistant base name', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: '',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///demo/single.png',
            fileName: 'single.png'
          }
        ]
      },
      {
        role: 'assistant',
        content: 'tag_a, tag_b'
      }
    ]

    expect(resolveAssistantReplyDownloadMode(messages, 1, 'builtin-tagging')).toBe('sidecar')
  })

  it('keeps ordinary assistant replies in generic download mode', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'summarize this'
      },
      {
        role: 'assistant',
        content: 'Here is the summary.'
      }
    ]

    expect(resolveAssistantReplyDownloadMode(messages, 1)).toBe('reply')
  })

  it('builds batch sidecar export entries with deduplicated base names', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'tag_a',
        preferredDownloadBaseName: 'sprite'
      },
      {
        role: 'assistant',
        content: 'tag_b',
        preferredDownloadBaseName: 'sprite'
      },
      {
        role: 'assistant',
        content: ''
      }
    ]

    expect(resolveAssistantSidecarExportEntries(messages)).toEqual([
      {
        assistantMessageIndex: 0,
        baseName: 'sprite',
        textContent: 'tag_a'
      },
      {
        assistantMessageIndex: 1,
        baseName: 'sprite_2',
        textContent: 'tag_b'
      }
    ])
  })

  it('keeps built-in tagging sidecar exports aligned to the originating file names', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: '',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///demo/hero-shot.png',
            fileName: 'hero-shot.png'
          }
        ]
      },
      {
        role: 'assistant',
        content: 'hero-shot, cinematic'
      },
      {
        role: 'user',
        content: '',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///demo/hero-shot.png',
            fileName: 'hero-shot.png'
          }
        ]
      },
      {
        role: 'assistant',
        content: 'hero-shot, dramatic lighting'
      }
    ]

    expect(resolveAssistantSidecarExportEntries(messages, BUILT_IN_TAGGING_SKILL_ID)).toEqual([
      {
        assistantMessageIndex: 1,
        baseName: 'hero-shot',
        textContent: 'hero-shot, cinematic'
      },
      {
        assistantMessageIndex: 3,
        baseName: 'hero-shot_2',
        textContent: 'hero-shot, dramatic lighting'
      }
    ])
  })

  it('extracts sidecar text from structured built-in tagging payloads', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: '',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///demo/hero-shot.png',
            fileName: 'hero-shot.png'
          }
        ]
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          results: [
            {
              fileName: 'hero-shot.png',
              tags: ['hero-shot', 'cinematic'],
              tagsText: 'hero-shot, cinematic',
              caption: 'A cinematic hero shot.'
            }
          ]
        })
      }
    ]

    expect(resolveAssistantSidecarExportEntries(messages, BUILT_IN_TAGGING_SKILL_ID)).toEqual([
      {
        assistantMessageIndex: 1,
        baseName: 'hero-shot',
        textContent: 'hero-shot, cinematic'
      }
    ])
  })

  it('skips empty assistant sidecar replies after text cleanup', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '   ',
        preferredDownloadBaseName: 'sprite'
      },
      {
        role: 'assistant',
        content: '\n\n[Generated Video](local-media:///demo.mp4)\n\n'
      }
    ]

    expect(resolveAssistantSidecarExportEntries(messages, 'builtin-tagging')).toEqual([])
  })

  it('strips generated video placeholders from exported assistant text', () => {
    expect(
      extractAssistantReplyTextContent('clip\n\n[Generated Video](local-media:///demo.mp4)')
    ).toBe('clip')
  })

  it('renders prompt yaml fences as copyable plain text', () => {
    const content = [
      '如果你想让修改完成度更高，可以用这版：',
      '```yaml',
      'ccbd91e879e9358fc81b791d0f4ed1af.png:',
      '  成品化正面提示词: >',
      '    shamanic dark fantasy aesthetic,',
      '    detailed bone texture',
      '  成品化负面提示词: >',
      '    low quality,',
      '    blurry, noisy',
      '```'
    ].join('\n')

    expect(extractAssistantReplyTextContent(content)).toBe(
      [
        '如果你想让修改完成度更高，可以用这版：',
        '成品化正面提示词：',
        'shamanic dark fantasy aesthetic, detailed bone texture',
        '',
        '成品化负面提示词：',
        'low quality, blurry, noisy'
      ].join('\n')
    )
  })

  it('leaves ordinary yaml code fences unchanged', () => {
    const content = ['```yaml', 'name: demo', 'count: 1', '```'].join('\n')

    expect(extractAssistantReplyTextContent(content)).toBe(content)
  })
})
