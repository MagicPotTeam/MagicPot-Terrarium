import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
}))
vi.mock('fs/promises', () => ({ default: { readdir: mocks.readdir, stat: mocks.stat } }))
vi.mock('../utils/fileUtils', () => ({ exists: mocks.exists }))
vi.mock('../config/config', () => ({
  getConfig: vi.fn(() => {
    throw Error('no ambient config')
  })
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: vi.fn(() => {
    throw Error('no ambient build env')
  })
}))
import { ComfyFSCli } from './fs'

const directory = path.resolve('synthetic-model-root')
const entry = (name: string, kind: 'file' | 'directory' | 'link' = 'file') => ({
  name,
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'directory'
})
const client = () =>
  new ComfyFSCli(structuredClone(DEFAULT_CONFIG), structuredClone(DEFAULT_BUILD_ENV))
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.exists.mockResolvedValue(true)
  mocks.readdir.mockResolvedValue([entry('first.CKPT'), entry('second.ckpt')])
  mocks.stat.mockResolvedValue({ size: 8, mtimeMs: 100 })
})

describe('ComfyFSCli cooperative listing cancellation', () => {
  it('does no filesystem work for a pre-aborted request', async () => {
    const [sender, receiver] = newAbortHandler()
    sender.abort()
    const emit = vi.fn()
    await client().forEachFileInfo(directory, ['ckpt'], emit, receiver)
    expect(mocks.exists).not.toHaveBeenCalled()
    expect(mocks.readdir).not.toHaveBeenCalled()
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it.each(['exists', 'readdir', 'stat'] as const)(
    'does not advance after abort during %s',
    async (stage) => {
      const [sender, receiver] = newAbortHandler()
      const called = deferred<void>()
      const pending = deferred<unknown>()
      mocks[stage].mockImplementationOnce(() => {
        called.resolve()
        return pending.promise
      })
      const emit = vi.fn()
      const work = client().forEachFileInfo(directory, ['.ckpt'], emit, receiver)
      await called.promise
      sender.abort()
      pending.resolve(
        stage === 'exists'
          ? true
          : stage === 'readdir'
            ? [entry('first.ckpt')]
            : { size: 8, mtimeMs: 100 }
      )
      await work
      expect(emit).not.toHaveBeenCalled()
      if (stage === 'exists') expect(mocks.readdir).not.toHaveBeenCalled()
      if (stage !== 'stat') expect(mocks.stat).not.toHaveBeenCalled()
    }
  )

  it('stops before sibling traversal when cancellation occurs in the consumer', async () => {
    const [sender, receiver] = newAbortHandler()
    mocks.readdir.mockResolvedValueOnce([
      entry('first.ckpt'),
      entry('later', 'directory'),
      entry('second.ckpt')
    ])
    const emit = vi.fn(async () => {
      sender.abort()
    })
    await client().forEachFileInfo(directory, ['.ckpt'], emit, receiver)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(mocks.readdir).toHaveBeenCalledTimes(1)
    expect(mocks.stat).toHaveBeenCalledTimes(1)
  })

  it('propagates one receiver into recursive directories', async () => {
    const [sender, receiver] = newAbortHandler()
    mocks.readdir.mockResolvedValueOnce([entry('nested', 'directory'), entry('root.ckpt')])
    const emit = vi.fn(async () => {
      sender.abort()
    })
    await client().forEachFileInfo(directory, undefined, emit, receiver)
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      name: 'first.CKPT',
      path: path.join(directory, 'nested', 'first.CKPT'),
      size: 8,
      lastModified: 100
    })
    expect(mocks.readdir).toHaveBeenCalledTimes(2)
    expect(mocks.stat).toHaveBeenCalledTimes(1)
  })

  it.each(['readdir', 'stat'] as const)(
    'ignores a late %s failure only after cancellation',
    async (stage) => {
      const [sender, receiver] = newAbortHandler()
      const called = deferred<void>()
      const pending = deferred<unknown>()
      mocks[stage].mockImplementationOnce(() => {
        called.resolve()
        return pending.promise
      })
      const work = client().forEachFileInfo(directory, undefined, vi.fn(), receiver)
      await called.promise
      sender.abort()
      pending.reject(Error('late failure'))
      await expect(work).resolves.toBeUndefined()
      mocks[stage].mockRejectedValueOnce(Error('current failure'))
      await expect(client().forEachFileInfo(directory, undefined, vi.fn())).rejects.toThrow(
        'current failure'
      )
      const [, activeReceiver] = newAbortHandler()
      mocks[stage].mockRejectedValueOnce(Error('active failure'))
      await expect(
        client().forEachFileInfo(directory, undefined, vi.fn(), activeReceiver)
      ).rejects.toThrow('active failure')
    }
  )

  it('waits for already-dispatched IO settlement rather than claiming native interruption', async () => {
    const [sender, receiver] = newAbortHandler()
    const called = deferred<void>()
    const pending = deferred<unknown>()
    mocks.stat.mockImplementationOnce(() => {
      called.resolve()
      return pending.promise
    })
    const emit = vi.fn()
    let settled = false
    const work = client()
      .forEachFileInfo(directory, undefined, emit, receiver)
      .then(() => {
        settled = true
      })
    await called.promise
    sender.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    pending.resolve({ size: 8, mtimeMs: 100 })
    await work
    expect(emit).not.toHaveBeenCalled()
  })

  it('retains optional receiver compatibility, case-insensitive extensions, metadata and link skipping', async () => {
    mocks.readdir.mockResolvedValueOnce([
      entry('nested', 'directory'),
      entry('ignore.txt'),
      entry('link.ckpt', 'link')
    ])
    const emit = vi.fn()
    await client().forEachFileInfo(directory, ['CKPT'], emit)
    expect(emit.mock.calls.map((call) => call[0].path)).toEqual([
      path.join(directory, 'nested', 'first.CKPT'),
      path.join(directory, 'nested', 'second.ckpt')
    ])
    expect(mocks.stat).toHaveBeenCalledTimes(2)
  })

  it('returns an empty result for a missing directory', async () => {
    mocks.exists.mockResolvedValueOnce(false)
    const emit = vi.fn()
    await client().forEachFileInfo(directory, undefined, emit)
    expect(emit).not.toHaveBeenCalled()
    expect(mocks.readdir).not.toHaveBeenCalled()
  })
})
