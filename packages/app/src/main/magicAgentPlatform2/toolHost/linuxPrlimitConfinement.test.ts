import { describe, expect, it } from 'vitest'
import {
  buildPrlimitArguments,
  createLinuxPrlimitConfinementAdapter,
  createProductionCommandJobsConfinementAdapter
} from './linuxPrlimitConfinement'

describe('Linux prlimit confinement adapter', () => {
  it('builds fixed resource-limit arguments with conservative CPU rounding', () => {
    expect(
      buildPrlimitArguments({
        metadata: {
          maxMemoryBytes: 64 * 1024 * 1024,
          maxCpuTimeMs: 1001
        }
      })
    ).toEqual(['--as=67108864:67108864', '--cpu=2:2'])
  })

  it('does not claim RLIMIT_NPROC as a per-job process-count boundary', () => {
    expect(buildPrlimitArguments({ metadata: { maxProcessCount: 3 } })).toEqual([])
    const adapter = createLinuxPrlimitConfinementAdapter()
    if (adapter) expect(adapter.capabilities.processCount).toBe(false)
  })

  it('rejects unsafe numeric metadata', () => {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildPrlimitArguments({ metadata: { maxMemoryBytes: value } })).toThrow(
        'positive safe integer'
      )
    }
  })

  it('fails closed when Linux prlimit is unavailable', () => {
    expect(createLinuxPrlimitConfinementAdapter('linux', [])).toBeUndefined()
  })

  it('uses an explicit production platform matrix', () => {
    expect(createProductionCommandJobsConfinementAdapter('win32')).toBeUndefined()
    expect(createProductionCommandJobsConfinementAdapter('darwin')).toBeUndefined()
    expect(createProductionCommandJobsConfinementAdapter('freebsd')).toBeUndefined()
  })

  it('skips non-Linux platforms and never advertises network confinement', () => {
    const adapter = createLinuxPrlimitConfinementAdapter()
    if (process.platform !== 'linux') {
      expect(adapter).toBeUndefined()
      return
    }
    if (adapter) {
      expect(adapter.capabilities).toMatchObject({
        memory: true,
        cpu: true,
        processCount: false,
        networkDeny: false,
        networkHosts: false
      })
    }
  })
})
