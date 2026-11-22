import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { isRepairImagesCommand, parseRepairImagesCommand, scanMissingLocalImages, projectConfirmedImageContext, replaceConfirmedMissingImages } from './repairImagesCommand'

describe('repair_images explicit scan and confirmation projection', () => {
  it('accepts both command spellings, rejecting prefixes and arguments', () => {
    expect(parseRepairImagesCommand(' /REPAIR_IMAGES ')).toBe(true)
    expect(parseRepairImagesCommand('/repair-images')).toBe(true)
    expect(isRepairImagesCommand('/repair_images_extra')).toBe(false)
    expect(() => parseRepairImagesCommand('/repair-images all')).toThrow()
  })
  it('checks bounded local references, skipping remote, UNC and unfinished messages', async () => {
    const image = (url: string): ChatMessage => ({ role: 'assistant', content: '', attachments: [{ type: 'image', url }] })
    const exists = vi.fn(async (paths: string[]) => paths.map(() => false))
    const scan = await scanMissingLocalImages([
      image('local-media:///missing.png'), image('https://example.test/a.png'), image('file://server/share/a.png'),
      { role: 'assistant', content: '', attachments: [{ type: 'image', url: 'local-media:///unfinished.png', finishReason: 'cancelled' }] }
    ], exists)
    expect(exists).toHaveBeenCalledExactlyOnceWith(['/missing.png'])
    expect(scan).toEqual({ checked: 1, limited: false, missing: [{ messageIndex: 0, attachmentIndex: 0, url: 'local-media:///missing.png' }] })
    expect((await scanMissingLocalImages(Array.from({ length: 130 }, () => image('local-media:///a.png')), exists)).checked).toBe(128)
    await expect(scanMissingLocalImages([image('local-media:///a.png')], async () => [])).rejects.toThrow()
  })
  it('projects compression replay sharing the exact attachment but not an unrelated same-URL branch', () => {
    const original: ChatMessage = { role: 'assistant', content: 'original', attachments: [{ type: 'image', url: 'local-media:///missing.png' }] }
    const replay: ChatMessage = { role: 'assistant', content: 'Historical replay', attachments: [...original.attachments!] }
    const unrelated: ChatMessage = { ...original, attachments: original.attachments!.map(item => ({ ...item })) }
    const confirmed = new Map([[original, [{ messageIndex: 0, attachmentIndex: 0, url: 'local-media:///missing.png' }]]])
    const projected = projectConfirmedImageContext([replay, unrelated], confirmed)
    expect(projected[0].attachments).toEqual([])
    expect(projected[0].content).toContain('[Missing local image omitted')
    expect(projected[1]).toBe(unrelated)
    expect(original.attachments).toHaveLength(1)
    expect(replay.attachments).toHaveLength(1)
  })
  it('an empty confirmation map leaves every request message unchanged', () => {
    const message: ChatMessage = { role: 'user', content: 'unchanged', attachments: [{ type: 'image', url: 'local-media:///a.png' }] }
    expect(projectConfirmedImageContext([message], new Map())[0]).toBe(message)
  })
  it('replaces only exact confirmed image references in a detached branch projection, preserving source history', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: 'Original answer', attachments: [
      { type: 'image', url: 'local-media:///missing.png' },
      { type: 'image', url: 'local-media:///kept.png' },
      { type: 'file', url: 'local-media:///document.pdf' }
    ] }]
    const before = JSON.stringify(messages)
    const projected = replaceConfirmedMissingImages(messages, [{ messageIndex: 0, attachmentIndex: 0, url: 'local-media:///missing.png' }])
    expect(JSON.stringify(messages)).toBe(before)
    expect(projected[0].content).toBe('Original answer\n[Missing local image omitted from this branch context]')
    expect(projected[0].attachments).toEqual(messages[0].attachments?.slice(1))
    expect(replaceConfirmedMissingImages(messages, [{ messageIndex: 0, attachmentIndex: 0, url: 'stale-url' }])[0]).toBe(messages[0])
    expect(replaceConfirmedMissingImages(messages, [{ messageIndex: 0, attachmentIndex: 2, url: 'local-media:///document.pdf' }])[0]).toBe(messages[0])
  })
})
