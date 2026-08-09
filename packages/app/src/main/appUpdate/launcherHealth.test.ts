import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLauncherHealth,
  parseLauncherHealthState,
  serializeLauncherHealthState
} from './launcherHealth'

const buildId = '20250101-010203-abcdef0'
const runtimeId = 'runtime-1'
const launchToken = 'token-1'
const healthFilePath = path.resolve('launcher-health.json')

function memoryFileSystem(initial?: string) {
  let text = initial
  return {
    fs: {
      async readFile(): Promise<string> {
        if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return text
      },
      async writeFile(_path: string, value: string): Promise<void> {
        text = value
      },
      async rename(): Promise<void> {
        return Promise.resolve()
      },
      async mkdir(): Promise<void> {
        return Promise.resolve()
      },
      async unlink(): Promise<void> {
        return Promise.resolve()
      }
    },
    read: () => text
  }
}

function pendingJson(): string {
  return `{"schema":1,"failedAttemptCount":0,"pending":{"buildId":"${buildId}","runtimeId":"${runtimeId}","launchToken":"${launchToken}","attemptCount":1,"startedAt":"2025-01-01T00:00:00.000Z","deadline":"2025-01-01T00:01:00.000Z"}}`
}

describe('launcher health confirmation receipt', () => {
  it('reads legacy state and strictly validates receipt keys, identifiers, and timestamps', () => {
    expect(parseLauncherHealthState('{"schema":1,"failedAttemptCount":0}')).toEqual({
      schema: 1,
      failedAttemptCount: 0
    })
    const receipt = `{"schema":1,"failedAttemptCount":0,"lastHealthy":{"buildId":"${buildId}","runtimeId":"${runtimeId}","launchToken":"${launchToken}","confirmedAt":"2025-01-01T00:00:30.000Z"}}`
    expect(parseLauncherHealthState(receipt).lastHealthy?.launchToken).toBe(launchToken)
    for (const invalid of [
      receipt.replace('"confirmedAt":', '"extra":true,"confirmedAt":'),
      receipt.replace(buildId, 'bad-build'),
      receipt.replace('2025-01-01T00:00:30.000Z', '2025-01-01T00:00:30Z')
    ])
      expect(() => parseLauncherHealthState(invalid)).toThrow(/schema 1/)
  })

  it('writes a matching receipt before deadline and omits null fields', async () => {
    const memory = memoryFileSystem(pendingJson())
    const health = createLauncherHealth({
      filePath: healthFilePath,
      rollbackThreshold: 3,
      fileSystem: memory.fs,
      now: () => new Date('2025-01-01T00:00:30.000Z')
    })
    const result = await health.confirmHealthy({ buildId, runtimeId, launchToken })
    expect(result.accepted).toBe(true)
    expect(result.state).toEqual({
      schema: 1,
      failedAttemptCount: 0,
      lastHealthy: { buildId, runtimeId, launchToken, confirmedAt: '2025-01-01T00:00:30.000Z' }
    })
    expect(serializeLauncherHealthState({ schema: 1, failedAttemptCount: 0 })).not.toContain('null')
  })

  it('rejects a confirmation before startedAt without altering pending', async () => {
    const original = pendingJson()
    const memory = memoryFileSystem(original)
    const health = createLauncherHealth({
      filePath: healthFilePath,
      rollbackThreshold: 3,
      fileSystem: memory.fs,
      now: () => new Date('2024-12-31T23:59:59.999Z')
    })
    expect((await health.confirmHealthy({ buildId, runtimeId, launchToken })).accepted).toBe(false)
    expect(memory.read()).toBe(original)
  })

  it('rejects a late confirmation without altering pending', async () => {
    const original = pendingJson()
    const memory = memoryFileSystem(original)
    const health = createLauncherHealth({
      filePath: healthFilePath,
      rollbackThreshold: 3,
      fileSystem: memory.fs,
      now: () => new Date('2025-01-01T00:01:00.000Z')
    })
    expect((await health.confirmHealthy({ buildId, runtimeId, launchToken })).accepted).toBe(false)
    expect(memory.read()).toBe(original)
  })

  it('clears an old receipt on begin and failure', async () => {
    const old = `{"schema":1,"failedAttemptCount":0,"lastHealthy":{"buildId":"${buildId}","runtimeId":"${runtimeId}","launchToken":"old","confirmedAt":"2024-12-31T00:00:00.000Z"}}`
    const memory = memoryFileSystem(old)
    const health = createLauncherHealth({
      filePath: healthFilePath,
      rollbackThreshold: 3,
      fileSystem: memory.fs,
      now: () => new Date('2025-01-01T00:00:00.000Z')
    })
    const begun = await health.beginPendingLaunch({
      buildId,
      runtimeId,
      launchToken,
      deadline: '2025-01-01T00:01:00.000Z'
    })
    expect(begun.lastHealthy).toBeUndefined()
    const failed = await health.recordFailedOrExpired({
      buildId,
      runtimeId,
      launchToken,
      reason: 'failed'
    })
    expect(failed.state).toEqual({ schema: 1, failedAttemptCount: 1 })
  })
})
