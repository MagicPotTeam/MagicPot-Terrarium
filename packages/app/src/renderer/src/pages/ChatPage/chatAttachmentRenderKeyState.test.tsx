import { StrictMode, Suspense, startTransition, useLayoutEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import { getChatAttachmentRenderKeys } from './chatAttachmentVisibility'
import {
  createChatAttachmentRenderKeyState,
  reconcileChatAttachmentRenderKeyState
} from './chatAttachmentRenderKeyState'
import { useChatAttachmentRenderKeys } from './useChatAttachmentRenderKeys'

const makeAttachments = (): ChatAttachment[] =>
  Array.from({ length: 8 }, (_, index) => ({
    type: 'image',
    url: 'data:image/png;base64,' + String.fromCharCode(65 + index).repeat(4096),
    fileName: 'synthetic-' + index + '.png'
  }))

const cloneAttachments = (attachments: readonly ChatAttachment[]): ChatAttachment[] =>
  attachments.map((attachment) => ({
    ...attachment,
    ...(attachment.media ? { media: { ...attachment.media } } : {})
  }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('attachment render key state', () => {
  it('replaces full-URL key serialization with bounded short keys for the same small inputs', () => {
    const attachments = makeAttachments()
    const passes = 25
    const measure = (run: () => readonly string[]) => {
      const stringify = vi.spyOn(JSON, 'stringify')
      try {
        let keys: readonly string[] = []
        for (let pass = 0; pass < passes; pass++) keys = run()
        return {
          stringifyCalls: stringify.mock.calls.length,
          keyCharactersPerPass: keys.reduce((total, key) => total + key.length, 0),
          maximumKeyLength: Math.max(...keys.map((key) => key.length)),
          keys
        }
      } finally {
        stringify.mockRestore()
      }
    }

    const old = measure(() => getChatAttachmentRenderKeys(attachments))
    let current = createChatAttachmentRenderKeyState([])
    const next = measure(() => {
      current = reconcileChatAttachmentRenderKeyState(current, cloneAttachments(attachments))
      return current.keys
    })

    expect(old.stringifyCalls).toBe(passes * attachments.length)
    expect(old.keyCharactersPerPass).toBeGreaterThan(8 * 4096)
    expect(next.stringifyCalls).toBe(0)
    expect(next.maximumKeyLength).toBeLessThan(64)
    expect(next.keyCharactersPerPass).toBeLessThan(old.keyCharactersPerPass / 100)
    expect(new Set(next.keys).size).toBe(8)
    expect(next.keys.every((key) => /^chat-attachment:\d+$/.test(key))).toBe(true)
    console.info('synthetic-short-key-observation', {
      passes,
      sources: attachments.length,
      sourceCharacters: attachments.reduce((total, attachment) => total + attachment.url.length, 0),
      oldStringifyCalls: old.stringifyCalls,
      newStringifyCalls: next.stringifyCalls,
      oldKeyCharactersPerPass: old.keyCharactersPerPass,
      newKeyCharactersPerPass: next.keyCharactersPerPass,
      maximumNewKeyLength: next.maximumKeyLength
    })
  })

  it('keeps equivalent clones and reordered duplicate occurrences stable without mutating prior state', () => {
    const [a, b] = makeAttachments()
    const initial = createChatAttachmentRenderKeyState([a, { ...a }, b])
    for (const entry of initial.entries) Object.freeze(entry)
    Object.freeze(initial.entries)
    Object.freeze(initial.keys)
    Object.freeze(initial)

    expect(reconcileChatAttachmentRenderKeyState(initial, cloneAttachments([a, a, b]))).toBe(
      initial
    )
    const reordered = reconcileChatAttachmentRenderKeyState(initial, cloneAttachments([b, a, a]))
    expect(reordered.keys).toEqual([initial.keys[2], initial.keys[0], initial.keys[1]])
    expect(new Set(reordered.keys).size).toBe(3)
    expect(initial.entries.map((entry) => entry.url)).toEqual([a.url, a.url, b.url])
    expect(initial.keys).toHaveLength(3)
  })

  it('detects in-place URL and type changes while preserving the prior identity snapshot', () => {
    const [attachment, replacement] = makeAttachments()
    const originalUrl = attachment.url
    const initial = createChatAttachmentRenderKeyState([attachment])
    attachment.url = replacement.url
    const changedUrl = reconcileChatAttachmentRenderKeyState(initial, [attachment])
    expect(changedUrl.keys[0]).not.toBe(initial.keys[0])
    expect(initial.entries[0].url).toBe(originalUrl)

    attachment.type = 'video'
    const changedType = reconcileChatAttachmentRenderKeyState(changedUrl, [attachment])
    expect(changedType.keys[0]).not.toBe(changedUrl.keys[0])
    expect(changedUrl.entries[0].type).toBe('image')
  })

  it('changes managed identity exactly but ignores display-only metadata updates', () => {
    const media = {
      version: 1 as const,
      kind: 'managed' as const,
      relativePath: 'assets/key-a.png',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      sizeBytes: 128,
      originalFileName: 'key-a.png'
    }
    const attachment: ChatAttachment = { ...makeAttachments()[0], media }
    const initial = createChatAttachmentRenderKeyState([attachment])
    const originalManagedIdentity = initial.entries[0].mediaIdentity
    const metadataOnly: ChatAttachment = {
      ...attachment,
      fileName: 'renamed.png',
      sourceWidth: 32,
      media: { ...media, sizeBytes: 256, originalFileName: 'renamed.png' }
    }
    expect(reconcileChatAttachmentRenderKeyState(initial, [metadataOnly])).toBe(initial)

    media.sha256 = 'b'.repeat(64)
    const changedHash = reconcileChatAttachmentRenderKeyState(initial, [attachment])
    expect(changedHash.keys[0]).not.toBe(initial.keys[0])
    expect(initial.entries[0].mediaIdentity).toBe(originalManagedIdentity)
    media.relativePath = 'assets/key-b.png'
    const changedPath = reconcileChatAttachmentRenderKeyState(changedHash, [attachment])
    expect(changedPath.keys[0]).not.toBe(changedHash.keys[0])

    delete attachment.media
    const unmanaged = reconcileChatAttachmentRenderKeyState(changedPath, [attachment])
    expect(unmanaged.keys[0]).not.toBe(changedPath.keys[0])
  })

  it('retains only current sources and gives a removed occurrence a fresh key when re-added', () => {
    const attachments = makeAttachments()
    const initial = createChatAttachmentRenderKeyState(attachments)
    const survivor = reconcileChatAttachmentRenderKeyState(initial, [attachments[1]])
    expect(survivor.entries.map((entry) => entry.url)).toEqual([attachments[1].url])
    expect(survivor.keys).toEqual([initial.keys[1]])
    const readded = reconcileChatAttachmentRenderKeyState(survivor, [
      { ...attachments[1] },
      { ...attachments[0] }
    ])
    expect(readded.keys[0]).toBe(initial.keys[1])
    expect(readded.keys[1]).not.toBe(initial.keys[0])
    expect(readded.entries.map((entry) => entry.url)).toEqual([
      attachments[1].url,
      attachments[0].url
    ])

    const empty = reconcileChatAttachmentRenderKeyState(readded, [])
    expect(empty.entries).toHaveLength(0)
    expect(empty.keys).toHaveLength(0)
    expect(empty.nextId).toBe(readded.nextId)
    const afterEmpty = reconcileChatAttachmentRenderKeyState(empty, [attachments[0]])
    expect(initial.keys).not.toContain(afterEmpty.keys[0])
    expect(readded.keys).not.toContain(afterEmpty.keys[0])
  })
})

describe('attachment render key hook lifecycle', () => {
  it('keeps committed DOM and keys when a new-source subtree suspends and is then superseded', async () => {
    type Model = {
      attachments: ChatAttachment[]
      blocked: boolean
      revision: number
    }
    const original = makeAttachments()
    const replacement = makeAttachments().map((attachment) => ({
      ...attachment,
      url: attachment.url + 'BBBB'
    }))
    let update!: Dispatch<SetStateAction<Model>>
    let renderedB = false
    let gateResolved = false
    let resolveGate!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })

    function Gate({ blocked }: { blocked: boolean }) {
      if (blocked && !gateResolved) {
        renderedB = true
        throw gate
      }
      return null
    }

    function Consumer({ model }: { model: Model }) {
      const keys = useChatAttachmentRenderKeys(model.attachments)
      return (
        <>
          <section data-testid="committed-list" data-revision={model.revision}>
            {model.attachments.map((attachment, index) => (
              <span key={keys[index]} data-testid="key-node" data-key={keys[index]}>
                {attachment.fileName}
              </span>
            ))}
          </section>
          <Gate blocked={model.blocked} />
        </>
      )
    }

    function App() {
      const [model, setModel] = useState<Model>({
        attachments: original,
        blocked: false,
        revision: 0
      })
      update = setModel
      return (
        <Suspense fallback={<span>key fallback</span>}>
          <Consumer model={model} />
        </Suspense>
      )
    }

    const view = render(
      <StrictMode>
        <App />
      </StrictMode>
    )
    const originalNodes = screen.getAllByTestId('key-node')
    const originalKeys = originalNodes.map((node) => node.getAttribute('data-key'))
    await act(async () => {
      startTransition(() => update({ attachments: replacement, blocked: true, revision: 1 }))
      await Promise.resolve()
    })
    expect(renderedB).toBe(true)
    expect(screen.queryByText('key fallback')).toBeNull()
    expect(screen.getByTestId('committed-list')).toHaveAttribute('data-revision', '0')
    expect(screen.getAllByTestId('key-node')).toEqual(originalNodes)

    act(() => {
      flushSync(() =>
        update({
          attachments: cloneAttachments(original),
          blocked: false,
          revision: 2
        })
      )
    })
    expect(screen.getByTestId('committed-list')).toHaveAttribute('data-revision', '2')
    const recoveredNodes = screen.getAllByTestId('key-node')
    recoveredNodes.forEach((node, index) => expect(node).toBe(originalNodes[index]))
    expect(recoveredNodes.map((node) => node.getAttribute('data-key'))).toEqual(originalKeys)

    await act(async () => {
      gateResolved = true
      resolveGate()
      await gate
    })
    expect(screen.getByTestId('committed-list')).toHaveAttribute('data-revision', '2')
    screen
      .getAllByTestId('key-node')
      .forEach((node, index) => expect(node).toBe(originalNodes[index]))
    view.unmount()
  })

  it('survives StrictMode setup and cleanup and remounts only removed occurrences', () => {
    const attachments = makeAttachments()
    const setup = vi.fn()
    const disposed = vi.fn()
    function KeyedNode({ label }: { label: string }) {
      useLayoutEffect(() => {
        setup()
        return () => disposed()
      }, [])
      return <span data-testid="lifecycle-node">{label}</span>
    }
    function List({ current }: { current: readonly ChatAttachment[] }) {
      const keys = useChatAttachmentRenderKeys(current)
      return (
        <>
          {current.map((attachment, index) => (
            <KeyedNode key={keys[index]} label={attachment.fileName || String(index)} />
          ))}
        </>
      )
    }
    const ui = (current: readonly ChatAttachment[]) => (
      <StrictMode>
        <List current={current} />
      </StrictMode>
    )
    const view = render(ui(attachments))
    const initial = screen.getAllByTestId('lifecycle-node')
    expect(setup.mock.calls.length).toBeGreaterThan(attachments.length)
    expect(disposed.mock.calls.length).toBeGreaterThan(0)
    const setupAfterReplay = setup.mock.calls.length

    view.rerender(ui(cloneAttachments(attachments)))
    screen
      .getAllByTestId('lifecycle-node')
      .forEach((node, index) => expect(node).toBe(initial[index]))
    expect(setup).toHaveBeenCalledTimes(setupAfterReplay)
    view.rerender(ui(cloneAttachments(attachments.slice(1))))
    const remaining = screen.getAllByTestId('lifecycle-node')
    remaining.forEach((node, index) => expect(node).toBe(initial[index + 1]))
    expect(initial[0].isConnected).toBe(false)

    view.rerender(ui(cloneAttachments(attachments)))
    const readded = screen.getAllByTestId('lifecycle-node')
    expect(readded[0]).not.toBe(initial[0])
    readded.slice(1).forEach((node, index) => expect(node).toBe(initial[index + 1]))
    view.unmount()
    expect(readded.every((node) => !node.isConnected)).toBe(true)
    expect(disposed.mock.calls.length).toBe(setup.mock.calls.length)
  })
})
