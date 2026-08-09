import fs from 'node:fs/promises'
import path from 'node:path'
import { vol } from 'memfs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  parseLaunchState,
  serializeLaunchState,
  type LaunchStateV1
} from '../../shared/appUpdate/launcherProtocol'
import { createLauncherStateStore, type LauncherStateFileSystem } from './launcherStateStore'

const filePath = '/managed/runtime/launch-state.json'
const defaultState: LaunchStateV1 = {
  schema: 1,
  buildId: '20260716-050000-b7c8d9e',
  state: 'healthy',
  attempt: 1,
  startedAt: '2026-07-16T05:00:01Z'
}

function state(attempt: number): LaunchStateV1 {
  return {
    schema: 1,
    buildId: '20260717-053138-c9a892c',
    state: 'pending',
    attempt,
    startedAt: `2026-07-17T05:45:0${attempt}Z`
  }
}

function memfs(): LauncherStateFileSystem {
  return {
    mkdir: (...args) => fs.mkdir(...args),
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rename: (...args) => fs.rename(...args),
    unlink: (...args) => fs.unlink(...args)
  }
}

function createStore(
  fileSystem: LauncherStateFileSystem = memfs(),
  target = filePath,
  ids: string[] = []
) {
  let sequence = 0
  return createLauncherStateStore({
    filePath: target,
    parse: parseLaunchState,
    serialize: serializeLaunchState,
    fileSystem,
    now: () => new Date('2026-07-18T01:02:03.004Z'),
    uniqueId: () => ids[sequence++] ?? `id-${sequence}`
  })
}

beforeEach(() => vol.reset())

describe('LauncherStateStore', () => {
  it('requires an explicitly injected absolute file path', () => {
    expect(() =>
      createLauncherStateStore({
        filePath: 'runtime/launch-state.json',
        parse: parseLaunchState,
        serialize: serializeLaunchState
      })
    ).toThrow(/absolute/)
  })

  it('returns the caller default when the file is missing', async () => {
    await expect(createStore().load(defaultState)).resolves.toBe(defaultState)
  })

  it('replaces existing state and loads it without leaving a temporary file', async () => {
    const store = createStore()
    await store.save(state(1))
    await store.save(state(2))
    await expect(store.load(defaultState)).resolves.toEqual(state(2))
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(['launch-state.json'])
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['schema-invalid JSON', JSON.stringify({ ...state(1), state: 'unknown' })]
  ])('atomically moves %s aside and returns the caller default', async (_label, contents) => {
    const backup = `${filePath}.2026-07-18T01-02-03-004Z-backup.corrupt`
    vol.fromJSON({ [filePath]: contents })

    await expect(createStore(memfs(), filePath, ['backup']).load(defaultState)).resolves.toBe(
      defaultState
    )
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(backup, 'utf8')).resolves.toBe(contents)
  })

  it('does not overwrite an existing corrupt backup and chooses another unique name', async () => {
    const existing = `${filePath}.2026-07-18T01-02-03-004Z-taken.corrupt`
    const backup = `${filePath}.2026-07-18T01-02-03-004Z-next.corrupt`
    vol.fromJSON({ [filePath]: 'broken', [existing]: 'older broken state' })

    await expect(
      createStore(memfs(), filePath, ['taken', 'next']).load(defaultState)
    ).resolves.toBe(defaultState)
    await expect(fs.readFile(existing, 'utf8')).resolves.toBe('older broken state')
    await expect(fs.readFile(backup, 'utf8')).resolves.toBe('broken')
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent saves and makes the last call win', async () => {
    const writes: number[] = []
    let releaseFirstWrite!: () => void
    const blocked = new Promise<void>((resolve) => (releaseFirstWrite = resolve))
    const fileSystem = memfs()
    fileSystem.writeFile = async (target, data, encoding) => {
      const attempt = JSON.parse(data).attempt as number
      writes.push(attempt)
      if (attempt === 1) await blocked
      await fs.writeFile(target, data, encoding)
    }
    const store = createStore(fileSystem)
    const first = store.save(state(1))
    const second = store.save(state(2))
    while (writes.length === 0) await Promise.resolve()
    expect(writes).toEqual([1])
    releaseFirstWrite()
    await Promise.all([first, second])
    expect(writes).toEqual([1, 2])
    await expect(store.load(defaultState)).resolves.toEqual(state(2))
  })

  it('uses distinct temporary files for different Store instances', async () => {
    const temporaryPaths: string[] = []
    let releaseWrites!: () => void
    let blockedWrites = 0
    const blocked = new Promise<void>((resolve) => (releaseWrites = resolve))
    const fileSystem = memfs()
    fileSystem.writeFile = async (target, data, encoding) => {
      temporaryPaths.push(target)
      blockedWrites += 1
      if (blockedWrites < 2) await blocked
      else releaseWrites()
      await fs.writeFile(target, data, encoding)
    }
    const first = createStore(fileSystem, '/managed/a.json', ['store-a'])
    const second = createStore(fileSystem, '/managed/b.json', ['store-b'])
    await Promise.all([first.save(state(1)), second.save(state(2))])
    expect(new Set(temporaryPaths).size).toBe(2)
    expect(temporaryPaths.map((temporaryPath) => path.normalize(temporaryPath))).toEqual(
      expect.arrayContaining([
        path.normalize('/managed/a.json.store-a.tmp'),
        path.normalize('/managed/b.json.store-b.tmp')
      ])
    )
  })

  it('serializes a save and corrupt load race across Store instances for the same path', async () => {
    vol.fromJSON({ [filePath]: 'broken' })
    let releaseSaveRename!: () => void
    let saveRenameStarted!: () => void
    const started = new Promise<void>((resolve) => (saveRenameStarted = resolve))
    const blocked = new Promise<void>((resolve) => (releaseSaveRename = resolve))
    const fileSystem = memfs()
    fileSystem.rename = async (source, destination) => {
      if (source.endsWith('.save.tmp')) {
        saveRenameStarted()
        await blocked
      }
      await fs.rename(source, destination)
    }
    const savingStore = createStore(fileSystem, filePath, ['save'])
    const loadingStore = createStore(fileSystem, path.normalize(filePath), ['corrupt'])

    const saving = savingStore.save(state(1))
    await started
    const loading = loadingStore.load(defaultState)
    releaseSaveRename()

    await saving
    await expect(loading).resolves.toEqual(state(1))
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(serializeLaunchState(state(1)))
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(['launch-state.json'])
  })

  it('cleans up its unique temporary file when rename fails', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    const fileSystem = memfs()
    fileSystem.rename = async () => {
      throw denied
    }
    const store = createStore(fileSystem, filePath, ['failed'])
    await expect(store.save(state(1))).rejects.toBe(denied)
    await expect(fs.stat(`${filePath}.failed.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('continues the queue after a failed operation', async () => {
    const fileSystem = memfs()
    let fail = true
    fileSystem.rename = async (source, destination) => {
      if (fail) {
        fail = false
        throw Object.assign(new Error('failed'), { code: 'EIO' })
      }
      await fs.rename(source, destination)
    }
    const store = createStore(fileSystem)
    await expect(store.save(state(1))).rejects.toThrow('failed')
    await expect(store.save(state(2))).resolves.toBeUndefined()
    await expect(store.load(defaultState)).resolves.toEqual(state(2))
  })
})
