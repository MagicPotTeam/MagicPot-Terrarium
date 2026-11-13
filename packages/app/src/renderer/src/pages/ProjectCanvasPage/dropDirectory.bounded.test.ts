import { describe, expect, it, vi } from 'vitest'
import { collectDroppedDirectoryFiles, collectDroppedDirectoryFilesBounded, DroppedDirectoryLimitError } from './dropDirectory'
import { droppedImageDescriptorKey, resolveDroppedDirectoryImageFiles } from '../ChatPage/chatDropFileUtils'

type Entry = { name: string; fullPath?: string; isFile: boolean; isDirectory: boolean; file?: (cb: (file: File) => void) => void; createReader?: () => { readEntries: (cb: (entries: Entry[]) => void) => void } }
const file = (path: string, mime: string): Entry => ({ name: path.split('/').pop()!, fullPath: path, isFile: true, isDirectory: false, file: cb => cb(new File(['x'], path.split('/').pop()!, { type: mime, lastModified: 1 })) })
const dir = (name: string, children: Entry[]): Entry => ({ name, isFile: false, isDirectory: true, createReader: () => { let i = 0; return { readEntries: cb => { const next = children.slice(i, i + 2); i += next.length; cb(next) } } } })
const transfer = (root: Entry) => [{ kind: 'file', webkitGetAsEntry: () => root }] as unknown as DataTransferItemList

describe('bounded drop traversal', () => {
  it('matches legacy first-path wins before image filtering, including a nonimage shadow', async () => {
    const root = dir('root', [file('/root/shadow', 'text/plain'), file('/root/shadow', 'image/png'), file('/root/other.png', 'text/plain'), file('/root/other.png', 'image/png')])
    const seen = new Set<string>()
    const bounded = await collectDroppedDirectoryFilesBounded(transfer(root), entry => { const key = droppedImageDescriptorKey(entry); if (key) seen.add(key); return true })
    const legacy = await collectDroppedDirectoryFiles(transfer(root))
    expect(resolveDroppedDirectoryImageFiles(bounded)).toEqual(resolveDroppedDirectoryImageFiles(legacy))
    expect(resolveDroppedDirectoryImageFiles(bounded).map(x => x.relativePath)).toEqual(['root/other.png'])
    expect(seen.size).toBe(1)
  })
  it('matches legacy root order even when an earlier root finishes later', async () => {
    const earlier = file('/shared', 'text/plain')
    const later = file('/shared', 'image/png')
    earlier.file = cb => { setTimeout(() => cb(new File(['x'], 'shared', { type: 'text/plain', lastModified: 1 })), 10) }
    const items = [dir('first', [earlier]), dir('second', [later, file('/second.png', 'image/png')])].map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })) as unknown as DataTransferItemList
    const old = await collectDroppedDirectoryFiles(items)
    const bounded = await collectDroppedDirectoryFilesBounded(items, () => true)
    expect(bounded.map(e => [e.path, e.file.type])).toEqual(old.map(e => [e.path, e.file.type]))
    expect(resolveDroppedDirectoryImageFiles(bounded).map(e => e.relativePath)).toEqual(['second.png'])
  })
  it('preserves the legacy collector for canvas callers and rejects bounded deep walks', async () => {
    let root = file('/root/end.png', 'image/png')
    for (let i = 0; i < 12; i++) root = dir(`d${i}`, [root])
    await expect(collectDroppedDirectoryFilesBounded(transfer(root), () => true, 8)).rejects.toBeInstanceOf(DroppedDirectoryLimitError)
    expect(await collectDroppedDirectoryFiles(transfer(root))).toHaveLength(1)
  })
  it('counts 50 same-path image occurrences for admission but preserves first-path output and accept', async () => {
    const entries = Array.from({ length: 50 }, () => file('/root/a.png', 'image/png'))
    const accept = vi.fn(() => true)
    const occurrence = vi.fn(() => true)
    const result = await collectDroppedDirectoryFilesBounded(transfer(dir('root', entries)), accept, 4096, occurrence)
    expect(occurrence).toHaveBeenCalledTimes(50)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('root/a.png')
  })
  it('stops at the 51st image occurrence even when a nonimage shadows its path', async () => {
    const callback = vi.fn()
    const shadow = file('/root/shared', 'text/plain')
    const images = Array.from({ length: 51 }, () => ({ ...file('/root/shared', 'image/png'), file: (cb: (f: File) => void) => { callback(); cb(new File(['x'], 'shared', { type: 'image/png' })) } }))
    const late = vi.fn()
    const accept = vi.fn(() => true)
    let count = 0
    const occurrence = vi.fn(({ file: item }: { file: File }) => !item.type.startsWith('image/') || ++count <= 50)
    await expect(collectDroppedDirectoryFilesBounded(transfer(dir('root', [shadow, ...images, { ...file('/root/later', 'image/png'), file: late }])), accept, 4096, occurrence)).rejects.toMatchObject({ reason: 'images' })
    expect(callback).toHaveBeenCalledTimes(51)
    expect(occurrence).toHaveBeenCalledTimes(52)
    expect(accept).toHaveBeenCalledTimes(1)
    expect(late).not.toHaveBeenCalled()
  })
  it('charges repeated entries to the existing node budget before occurrence admission', async () => {
    const occurrence = vi.fn(() => true)
    await expect(collectDroppedDirectoryFilesBounded(transfer(dir('root', Array.from({ length: 20 }, () => file('/root/a.png', 'image/png')))), () => true, 5, occurrence)).rejects.toMatchObject({ reason: 'nodes' })
    expect(occurrence).toHaveBeenCalledTimes(2)
  })
  it('observes multi-root occurrences in input order while legacy first path still wins', async () => {
    const first = file('/same', 'text/plain')
    first.file = cb => { setTimeout(() => cb(new File(['a'], 'same', { type: 'text/plain' })), 10) }
    const second = file('/same', 'image/png')
    const items = [dir('one', [first]), dir('two', [second])].map(entry => ({ kind: 'file', webkitGetAsEntry: () => entry })) as unknown as DataTransferItemList
    const seen: string[] = []
    const accept = vi.fn(() => true)
    const result = await collectDroppedDirectoryFilesBounded(items, accept, 4096, entry => { seen.push(entry.file.type); return true })
    const legacy = await collectDroppedDirectoryFiles(items)
    expect(seen).toEqual(['text/plain', 'image/png'])
    expect(accept).toHaveBeenCalledTimes(1)
    expect(result.map(entry => [entry.path, entry.file.type])).toEqual(legacy.map(entry => [entry.path, entry.file.type]))
  })
  it('stops later file callbacks at the admission failure', async () => {
    const late = vi.fn()
    const root = dir('root', [file('/root/a.png', 'image/png'), file('/root/b.png', 'image/png'), { ...file('/root/c.png', 'image/png'), file: late }])
    let count = 0
    await expect(collectDroppedDirectoryFilesBounded(transfer(root), () => ++count < 2)).rejects.toMatchObject({ reason: 'images' })
    expect(late).not.toHaveBeenCalled()
  })
})
