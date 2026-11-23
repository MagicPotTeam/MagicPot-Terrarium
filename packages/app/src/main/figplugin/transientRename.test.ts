import { describe, expect, it, vi } from 'vitest'
import { renameWithTransientRetry } from './transientRename'

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: rename failed`), { code })

const harness = (failures: (attempt: number) => NodeJS.ErrnoException | undefined) => {
  const sleeps: number[] = []
  let attempts = 0
  const rename = vi.fn(async () => {
    attempts += 1
    const failure = failures(attempts)
    if (failure) throw failure
  })
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  return { rename, sleep, sleeps, attempts: () => attempts }
}

describe('renameWithTransientRetry', () => {
  it('retries EPERM twice with exponential backoff and then succeeds', async () => {
    const h = harness((attempt) => (attempt <= 2 ? errno('EPERM') : undefined))
    await renameWithTransientRetry('from', 'to', { rename: h.rename, sleep: h.sleep })
    expect(h.attempts()).toBe(3)
    expect(h.rename).toHaveBeenCalledWith('from', 'to')
    expect(h.sleeps).toEqual([25, 50])
  })

  it('rethrows the original error once a persistent EPERM exhausts the bounded retries', async () => {
    const failure = errno('EPERM')
    const h = harness(() => failure)
    await expect(
      renameWithTransientRetry('from', 'to', { rename: h.rename, sleep: h.sleep })
    ).rejects.toBe(failure)
    expect(h.attempts()).toBe(6)
    expect(h.sleeps).toEqual([25, 50, 100, 200, 400])
  })

  it.each(['EACCES', 'EBUSY'])('also treats %s as transient', async (code) => {
    const h = harness((attempt) => (attempt === 1 ? errno(code) : undefined))
    await renameWithTransientRetry('from', 'to', { rename: h.rename, sleep: h.sleep })
    expect(h.attempts()).toBe(2)
  })

  it.each([errno('ENOENT'), errno('EXDEV'), errno('ENOTEMPTY'), new Error('EPERM no code')])(
    'throws other errors immediately without retrying (%s)',
    async (failure) => {
      const h = harness(() => failure)
      await expect(
        renameWithTransientRetry('from', 'to', { rename: h.rename, sleep: h.sleep })
      ).rejects.toBe(failure)
      expect(h.attempts()).toBe(1)
      expect(h.sleeps).toEqual([])
    }
  )

  it('never waits past the caller deadline', async () => {
    const failure = errno('EBUSY')
    const h = harness(() => failure)
    await expect(
      renameWithTransientRetry('from', 'to', {
        rename: h.rename,
        sleep: h.sleep,
        now: () => 1_000,
        deadlineAt: 1_040
      })
    ).rejects.toBe(failure)
    expect(h.sleeps).toEqual([25])
    expect(h.attempts()).toBe(2)
  })
})
