import fs from 'node:fs/promises'
import path from 'node:path'
import { vol } from 'memfs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireUpdateLock,
  UPDATE_LOCK_FILE,
  UpdateLockBusyError,
  withUpdateLock,
  withWaitedUpdateLock
} from './updateLock'

let rootSequence = 0

async function temporaryRoot(): Promise<string> {
  const root = `/magicpot-update-lock-${++rootSequence}`
  await fs.mkdir(root, { recursive: true })
  return root
}

beforeEach(() => vol.reset())

describe('update lock', () => {
  it('uses atomic exclusive creation and reports owner metadata to competitors', async () => {
    const root = await temporaryRoot()
    const first = await acquireUpdateLock(root, {
      pid: 101,
      hostname: 'host-a',
      token: () => 'owner-a',
      now: () => new Date('2026-07-01T00:00:00.000Z')
    })

    await expect(
      acquireUpdateLock(root, { pid: 202, hostname: 'host-b', token: () => 'owner-b' })
    ).rejects.toMatchObject({
      name: 'UpdateLockBusyError',
      owner: { pid: 101, hostname: 'host-a', token: 'owner-a' }
    })
    await first.release()
  })

  it('releases normally and can be acquired again', async () => {
    const root = await temporaryRoot()
    const first = await acquireUpdateLock(root, { token: () => 'first' })
    await first.release()
    await expect(fs.stat(path.join(root, UPDATE_LOCK_FILE))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    const second = await acquireUpdateLock(root, { token: () => 'second' })
    await second.release()
  })

  it('releases when the protected operation throws', async () => {
    const root = await temporaryRoot()
    await expect(
      withUpdateLock(root, async () => {
        throw new Error('failed update')
      })
    ).rejects.toThrow('failed update')
    const next = await acquireUpdateLock(root)
    await next.release()
  })

  it('conservatively preserves stale-looking or malformed locks', async () => {
    const root = await temporaryRoot()
    const lockPath = path.join(root, UPDATE_LOCK_FILE)
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        schema: 1,
        token: 'old',
        pid: 999999,
        hostname: 'gone',
        createdAt: '2000-01-01T00:00:00.000Z'
      })
    )
    await expect(acquireUpdateLock(root)).rejects.toThrow('held by pid 999999')
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain('"token":"old"')

    await fs.writeFile(lockPath, '{broken')
    await expect(acquireUpdateLock(root)).rejects.toThrow('unreadable owner metadata')
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe('{broken')
  })

  it('rejects non-exact owner schemas, non-canonical timestamps, and out-of-range pids', async () => {
    const root = await temporaryRoot()
    const lockPath = path.join(root, UPDATE_LOCK_FILE)
    const valid = {
      schema: 1,
      token: 'owner',
      pid: 1,
      hostname: 'host',
      createdAt: '2026-07-01T00:00:00.000Z'
    }
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, createdAt: '2026-07-01T00:00:00Z' },
      { ...valid, createdAt: '2026-07-01T00:00:00.000+00:00' },
      { ...valid, pid: 2_147_483_648 }
    ]) {
      await fs.writeFile(lockPath, JSON.stringify(invalid))
      await expect(
        acquireUpdateLock(root, {
          hostname: 'host',
          staleAfterMs: 0,
          isProcessAlive: () => false
        })
      ).rejects.toThrow('unreadable owner metadata')
      await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(JSON.stringify(invalid))
    }
  })

  it('recovers an explicitly expired local lock only after its process is confirmed dead', async () => {
    const root = await temporaryRoot()
    const lockPath = path.join(root, UPDATE_LOCK_FILE)
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        schema: 1,
        token: 'dead-owner',
        pid: 404,
        hostname: 'local-host',
        createdAt: '2026-07-01T00:00:00.000Z'
      })
    )

    const recovered = await acquireUpdateLock(root, {
      hostname: 'local-host',
      token: () => 'replacement',
      now: () => new Date('2026-07-01T01:00:00Z'),
      staleAfterMs: 60_000,
      isProcessAlive: () => false
    })
    expect(recovered.owner.token).toBe('replacement')
    await recovered.release()
  })

  it('compares local hostnames case-insensitively but preserves truly remote stale locks', async () => {
    const root = await temporaryRoot()
    const lockPath = path.join(root, UPDATE_LOCK_FILE)
    const owner = {
      schema: 1,
      token: 'live-owner',
      pid: 505,
      hostname: 'local-host',
      createdAt: '2026-07-01T00:00:00.000Z'
    } as const
    await fs.writeFile(lockPath, JSON.stringify(owner))
    await expect(
      acquireUpdateLock(root, {
        hostname: 'LOCAL-HOST',
        now: () => new Date('2026-07-01T01:00:00Z'),
        staleAfterMs: 60_000,
        isProcessAlive: () => true
      })
    ).rejects.toThrow('held by pid 505')

    await fs.writeFile(lockPath, JSON.stringify({ ...owner, token: 'dead-owner' }))
    const recovered = await acquireUpdateLock(root, {
      hostname: 'LOCAL-HOST',
      token: () => 'replacement',
      now: () => new Date('2026-07-01T01:00:00Z'),
      staleAfterMs: 60_000,
      isProcessAlive: () => false
    })
    await recovered.release()

    const remoteHostname = 'remote-host'
    const isProcessAlive = vi.fn(() => false)
    await fs.writeFile(lockPath, JSON.stringify({ ...owner, hostname: remoteHostname }))
    await expect(
      acquireUpdateLock(root, {
        hostname: 'local-host',
        now: () => new Date('2026-07-01T01:00:00Z'),
        staleAfterMs: 60_000,
        isProcessAlive
      })
    ).rejects.toThrow(remoteHostname)
    expect(isProcessAlive).not.toHaveBeenCalled()
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain(remoteHostname)
  })

  it('waits through brief lock contention and then runs the operation', async () => {
    const root = await temporaryRoot()
    const existing = await acquireUpdateLock(root, {
      pid: 1,
      token: () => 'first',
      isProcessAlive: () => true
    })
    let sleeps = 0

    const result = await withWaitedUpdateLock(root, async () => 'done', {
      pid: 2,
      token: () => 'second',
      isProcessAlive: () => true,
      waitTimeoutMs: 1_000,
      retryIntervalMs: 10,
      sleep: async () => {
        sleeps += 1
        await existing.release()
      }
    })

    expect(result).toBe('done')
    expect(sleeps).toBe(1)
  })

  it('retries when Windows temporarily denies reading an existing lock owner', async () => {
    const root = await temporaryRoot()
    const existing = await acquireUpdateLock(root, { token: () => 'first' })
    const readFile = vi.spyOn(fs, 'readFile')
    readFile.mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code: 'EBUSY' }))
    let sleeps = 0

    const result = await withWaitedUpdateLock(root, async () => 'done', {
      token: () => 'second',
      waitTimeoutMs: 1_000,
      retryIntervalMs: 10,
      sleep: async () => {
        sleeps += 1
        await existing.release()
      }
    })

    expect(result).toBe('done')
    expect(sleeps).toBe(1)
    readFile.mockRestore()
  })

  it.each(['second snapshot', 'rename', 'quarantine read', 'quarantine unlink'] as const)(
    'retries stale recovery sharing conflicts during %s without deleting the lock',
    async (phase) => {
      const root = await temporaryRoot()
      const lockPath = path.join(root, UPDATE_LOCK_FILE)
      const staleOwner = {
        schema: 1,
        token: 'stale-owner',
        pid: 404,
        hostname: 'local-host',
        createdAt: '2026-07-01T00:00:00.000Z'
      }
      await fs.writeFile(lockPath, JSON.stringify(staleOwner))

      const restores: Array<() => void> = []
      if (phase === 'second snapshot') {
        const original = fs.stat.bind(fs)
        let calls = 0
        const spy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
          calls += 1
          if (calls === 3) throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' })
          return original(...args)
        })
        restores.push(() => spy.mockRestore())
      } else if (phase === 'rename') {
        const spy = vi
          .spyOn(fs, 'rename')
          .mockRejectedValueOnce(Object.assign(new Error('access denied'), { code: 'EACCES' }))
        restores.push(() => spy.mockRestore())
      } else if (phase === 'quarantine read') {
        const original = fs.readFile.bind(fs)
        const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
          if (String(args[0]).endsWith('.stale')) {
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
          }
          return original(...args)
        })
        restores.push(() => spy.mockRestore())
      } else {
        const original = fs.unlink.bind(fs)
        const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (...args) => {
          if (String(args[0]).endsWith('.stale')) {
            throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' })
          }
          return original(...args)
        })
        restores.push(() => spy.mockRestore())
      }

      let sleeps = 0
      const result = await withWaitedUpdateLock(root, async () => 'done', {
        hostname: 'local-host',
        token: () => 'replacement',
        now: () => new Date('2026-07-01T01:00:00Z'),
        staleAfterMs: 60_000,
        isProcessAlive: () => false,
        waitTimeoutMs: 1_000,
        retryIntervalMs: 10,
        sleep: async () => {
          sleeps += 1
          for (const restore of restores.splice(0)) restore()
          await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain('stale-owner')
        }
      })

      expect(result).toBe('done')
      expect(sleeps).toBe(1)
    }
  )

  it('does not retry an operation that throws an UpdateLockBusyError', async () => {
    const root = await temporaryRoot()
    let attempts = 0

    await expect(
      withWaitedUpdateLock(root, async () => {
        attempts += 1
        throw new UpdateLockBusyError('operation failure')
      })
    ).rejects.toThrow('operation failure')
    expect(attempts).toBe(1)
  })

  it('retries a transient sharing conflict across the release verification flow', async () => {
    const root = await temporaryRoot()
    const lock = await acquireUpdateLock(root, {
      token: () => 'owner',
      releaseTimeoutMs: 100,
      retryDelayMs: 1,
      sleep: async () => undefined
    })
    const original = fs.stat.bind(fs)
    const stat = vi
      .spyOn(fs, 'stat')
      .mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code: 'EBUSY' }))
      .mockImplementation(original)

    await lock.release()
    expect(stat).toHaveBeenCalledTimes(3)
    stat.mockRestore()
  })

  it('can retry release after persistent sharing conflicts exhaust one call', async () => {
    const root = await temporaryRoot()
    const lock = await acquireUpdateLock(root, {
      token: () => 'owner',
      releaseTimeoutMs: 0,
      retryDelayMs: 1,
      sleep: async () => undefined
    })
    const stat = vi
      .spyOn(fs, 'stat')
      .mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }))

    await expect(lock.release()).rejects.toMatchObject({ code: 'EACCES' })
    stat.mockRestore()
    await lock.release()
    await expect(fs.stat(lock.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never removes a lock whose ownership token changed', async () => {
    const root = await temporaryRoot()
    const lock = await acquireUpdateLock(root, { token: () => 'original' })
    await fs.writeFile(lock.path, JSON.stringify({ ...lock.owner, token: 'replacement' }))
    await expect(lock.release()).rejects.toThrow('ownership changed')
    await expect(fs.readFile(lock.path, 'utf8')).resolves.toContain('replacement')
    await expect(lock.release()).rejects.toThrow('ownership changed')
  })
})
