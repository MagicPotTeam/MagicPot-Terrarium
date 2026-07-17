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

function createStore(fileSystem?: LauncherStateFileSystem) {
  return createLauncherStateStore({
    filePath,
    parse: parseLaunchState,
    serialize: serializeLaunchState,
    fileSystem,
    now: () => new Date('2026-07-18T01:02:03.004Z')
  })
}

beforeEach(() => {
  vol.reset()
})

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

  it('saves and loads validated state without leaving a temporary file', async () => {
    const store = createStore()
    await store.save(state(1))

    await expect(store.load(defaultState)).resolves.toEqual(state(1))
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(['launch-state.json'])
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['schema-invalid JSON', JSON.stringify({ ...state(1), state: 'unknown' })]
  ])('backs up %s and returns the caller default', async (_label, contents) => {
    vol.fromJSON({ [filePath]: contents })

    await expect(createStore().load(defaultState)).resolves.toBe(defaultState)
    await expect(fs.readFile(`${filePath}.2026-07-18T01-02-03-004Z.corrupt`, 'utf8')).resolves.toBe(
      contents
    )
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not overwrite an existing corrupt backup', async () => {
    const existingBackup = `${filePath}.2026-07-18T01-02-03-004Z.corrupt`
    vol.fromJSON({ [filePath]: 'broken', [existingBackup]: 'older broken state' })

    await createStore().load(defaultState)

    await expect(fs.readFile(existingBackup, 'utf8')).resolves.toBe('older broken state')
    await expect(
      fs.readFile(`${filePath}.2026-07-18T01-02-03-004Z-1.corrupt`, 'utf8')
    ).resolves.toBe('broken')
  })

  it('serializes concurrent saves and makes the last call win', async () => {
    const writes: number[] = []
    let releaseFirstWrite: (() => void) | undefined
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    const fileSystem: LauncherStateFileSystem = {
      mkdir: (...args) => fs.mkdir(...args),
      readFile: (...args) => fs.readFile(...args),
      rename: (...args) => fs.rename(...args),
      writeFile: async (target, data, encoding) => {
        const attempt = JSON.parse(data).attempt as number
        writes.push(attempt)
        if (attempt === 1) await firstWriteBlocked
        await fs.writeFile(target, data, encoding)
      }
    }
    const store = createStore(fileSystem)
    const first = store.save(state(1))
    const second = store.save(state(2))

    while (writes.length === 0) await Promise.resolve()
    expect(writes).toEqual([1])
    releaseFirstWrite?.()
    await Promise.all([first, second])

    expect(writes).toEqual([1, 2])
    await expect(store.load(defaultState)).resolves.toEqual(state(2))
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(['launch-state.json'])
  })

  it('propagates unrelated filesystem read errors', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    const fileSystem = {
      mkdir: (...args: Parameters<LauncherStateFileSystem['mkdir']>) => fs.mkdir(...args),
      readFile: async () => {
        throw denied
      },
      writeFile: (...args: Parameters<LauncherStateFileSystem['writeFile']>) =>
        fs.writeFile(...args),
      rename: (...args: Parameters<LauncherStateFileSystem['rename']>) => fs.rename(...args)
    } satisfies LauncherStateFileSystem

    await expect(createStore(fileSystem).load(defaultState)).rejects.toBe(denied)
  })
})
