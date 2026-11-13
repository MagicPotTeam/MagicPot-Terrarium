import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// All fs operations used by the snapshot reader are replaced; no selected file is opened.
const fakeFs = vi.hoisted(() => ({
  constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
  lstatSync: vi.fn(),
  openSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  realpathSync: { native: vi.fn() }
}))

vi.mock('node:fs', () => ({ ...fakeFs, default: fakeFs }))

import { readExplicitlySelectedSqliteSnapshot } from './sqliteSelectedSnapshot'

const selectedPath =
  process.platform === 'win32'
    ? 'C:\\__synthetic_sqlite_snapshot__\\selection.sqlite'
    : '/__synthetic_sqlite_snapshot__/selection.sqlite'
const fakeDescriptor = 73
const chunkSize = 65_536

function makeFixture() {
  const bytes = Buffer.alloc(chunkSize + 137)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + Math.floor(i / chunkSize) * 59) & 0xff
  bytes.write('SQLite format 3\0', 'binary')
  let descriptorOpen = false
  const selectedStat = {
    dev: 1n,
    ino: 2n,
    size: BigInt(bytes.length),
    nlink: 1n,
    mtimeNs: 3n,
    ctimeNs: 4n,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true
  }
  const directoryStat = {
    ...selectedStat,
    ino: 5n,
    isDirectory: () => true,
    isFile: () => false
  }
  const root = path.parse(selectedPath).root
  const components = selectedPath.slice(root.length).split(/[\\/]/)
  const permitted = new Set<string>()
  let current = root
  for (const component of components) {
    current = path.join(current, component)
    permitted.add(current)
  }

  fakeFs.lstatSync.mockImplementation((target: string) => {
    if (!permitted.has(target)) throw new Error('Unexpected synthetic path')
    return target === selectedPath ? selectedStat : directoryStat
  })
  fakeFs.realpathSync.native.mockImplementation((target: string) => {
    if (target !== selectedPath) throw new Error('Unexpected synthetic path')
    return selectedPath
  })
  fakeFs.openSync.mockImplementation((target: string) => {
    if (target !== selectedPath || descriptorOpen) throw new Error('Unexpected synthetic open')
    descriptorOpen = true
    return fakeDescriptor
  })
  fakeFs.fstatSync.mockImplementation((fd: number) => {
    if (fd !== fakeDescriptor || !descriptorOpen) throw new Error('Unexpected synthetic descriptor')
    return selectedStat
  })
  fakeFs.readSync.mockImplementation(
    (fd: number, target: Buffer, offset: number, length: number, position: number) => {
      if (fd !== fakeDescriptor || !descriptorOpen)
        throw new Error('Unexpected synthetic descriptor')
      return bytes.copy(target, offset, position, position + length)
    }
  )
  fakeFs.closeSync.mockImplementation((fd: number) => {
    if (fd !== fakeDescriptor || !descriptorOpen) throw new Error('Unexpected synthetic descriptor')
    descriptorOpen = false
  })
  return bytes
}

describe('selected SQLite snapshot authority between read chunks', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('throws without a partial return, stops reading and closes the descriptor when authority is revoked after one chunk', () => {
    makeFixture()
    const assertCurrent = vi.fn(() => {
      if (fakeFs.readSync.mock.calls.length > 0) throw new Error('synthetic authority revoked')
    })

    expect(() => readExplicitlySelectedSqliteSnapshot(selectedPath, assertCurrent)).toThrow(
      'synthetic authority revoked'
    )
    expect(assertCurrent).toHaveBeenCalledTimes(3)
    expect(fakeFs.openSync).toHaveBeenCalledOnce()
    expect(fakeFs.readSync).toHaveBeenCalledOnce()
    expect(fakeFs.readSync.mock.calls[0]).toEqual([
      fakeDescriptor,
      expect.any(Buffer),
      0,
      chunkSize,
      0
    ])
    expect(fakeFs.fstatSync).toHaveBeenCalledOnce()
    expect(fakeFs.closeSync).toHaveBeenCalledOnce()
    expect(fakeFs.closeSync).toHaveBeenCalledWith(fakeDescriptor)
    expect(fakeFs.readSync.mock.invocationCallOrder[0]).toBeLessThan(
      fakeFs.closeSync.mock.invocationCallOrder[0]
    )
  })

  it('returns the complete ordered snapshot and closes the descriptor when authority remains current', () => {
    const expected = makeFixture()
    const assertCurrent = vi.fn()

    expect(readExplicitlySelectedSqliteSnapshot(selectedPath, assertCurrent)).toEqual(expected)
    expect(assertCurrent).toHaveBeenCalledTimes(4)
    expect(fakeFs.readSync).toHaveBeenCalledTimes(2)
    expect(fakeFs.readSync.mock.calls[0]).toEqual([
      fakeDescriptor,
      expect.any(Buffer),
      0,
      chunkSize,
      0
    ])
    expect(fakeFs.readSync.mock.calls[1]).toEqual([
      fakeDescriptor,
      expect.any(Buffer),
      chunkSize,
      137,
      chunkSize
    ])
    expect(fakeFs.fstatSync).toHaveBeenCalledTimes(2)
    expect(fakeFs.closeSync).toHaveBeenCalledOnce()
    expect(fakeFs.closeSync).toHaveBeenCalledWith(fakeDescriptor)
    expect(fakeFs.readSync.mock.invocationCallOrder[1]).toBeLessThan(
      fakeFs.closeSync.mock.invocationCallOrder[0]
    )
    expect(fakeFs.fstatSync.mock.invocationCallOrder[1]).toBeLessThan(
      fakeFs.closeSync.mock.invocationCallOrder[0]
    )
  })

  it('rejects a descriptor that changes after the final chunk and still closes it', () => {
    makeFixture()
    const baseline = fakeFs.fstatSync.getMockImplementation()!
    let fstatCalls = 0
    fakeFs.fstatSync.mockImplementation((fd: number) => {
      const stat = baseline(fd)
      fstatCalls += 1
      return fstatCalls === 2 ? { ...stat, mtimeNs: 99n } : stat
    })
    const assertCurrent = vi.fn()

    expect(() => readExplicitlySelectedSqliteSnapshot(selectedPath, assertCurrent)).toThrow(
      'SQLite selection changed while reading.'
    )
    expect(fakeFs.readSync).toHaveBeenCalledTimes(2)
    expect(fakeFs.fstatSync).toHaveBeenCalledTimes(2)
    expect(fakeFs.closeSync).toHaveBeenCalledOnce()
    expect(fakeFs.closeSync).toHaveBeenCalledWith(fakeDescriptor)
  })

  it('closes the descriptor when a later chunk read fails', () => {
    makeFixture()
    const baseline = fakeFs.readSync.getMockImplementation()!
    let readCalls = 0
    fakeFs.readSync.mockImplementation(
      (fd: number, target: Buffer, offset: number, length: number, position: number) => {
        readCalls += 1
        if (readCalls === 2) throw new Error('synthetic read failure')
        return baseline(fd, target, offset, length, position)
      }
    )
    const assertCurrent = vi.fn()

    expect(() => readExplicitlySelectedSqliteSnapshot(selectedPath, assertCurrent)).toThrow(
      'synthetic read failure'
    )
    expect(fakeFs.readSync).toHaveBeenCalledTimes(2)
    expect(fakeFs.fstatSync).toHaveBeenCalledOnce()
    expect(fakeFs.closeSync).toHaveBeenCalledOnce()
    expect(fakeFs.closeSync).toHaveBeenCalledWith(fakeDescriptor)
  })

  it('closes the descriptor when the final fstat fails', () => {
    makeFixture()
    const baseline = fakeFs.fstatSync.getMockImplementation()!
    let fstatCalls = 0
    fakeFs.fstatSync.mockImplementation((fd: number) => {
      fstatCalls += 1
      if (fstatCalls === 2) throw new Error('synthetic final fstat failure')
      return baseline(fd)
    })
    const assertCurrent = vi.fn()

    expect(() => readExplicitlySelectedSqliteSnapshot(selectedPath, assertCurrent)).toThrow(
      'synthetic final fstat failure'
    )
    expect(fakeFs.readSync).toHaveBeenCalledTimes(2)
    expect(fakeFs.fstatSync).toHaveBeenCalledTimes(2)
    expect(fakeFs.closeSync).toHaveBeenCalledOnce()
    expect(fakeFs.closeSync).toHaveBeenCalledWith(fakeDescriptor)
  })
})
