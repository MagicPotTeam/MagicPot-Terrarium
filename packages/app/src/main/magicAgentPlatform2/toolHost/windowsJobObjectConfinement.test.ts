import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { CommandJobsSpawnProcess } from './commandJobs'
import {
  buildWindowsJobObjectArguments,
  createWindowsJobObjectConfinementAdapter,
  resolveWindowsCommandJobHelper
} from './windowsJobObjectConfinement'

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const realOs = await vi.importActual<typeof import('node:os')>('node:os')
const roots: string[] = []

const fileOps = {
  realpath: (value: string) => realFs.realpathSync.native(value),
  isFile: (value: string) => realFs.statSync(value).isFile(),
  read: (value: string, encoding?: BufferEncoding) => realFs.readFileSync(value, encoding)
}

afterEach(() => {
  for (const root of roots.splice(0)) realFs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const helperFixture = () => {
  const root = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'magicpot-job-helper-'))
  roots.push(root)
  const helper = path.join(root, 'magicpot-command-job.exe')
  realFs.writeFileSync(helper, Buffer.from('trusted-helper'))
  const digest = createHash('sha256').update(realFs.readFileSync(helper)).digest('hex')
  realFs.writeFileSync(`${helper}.sha256`, `${digest}\n`, 'ascii')
  return helper
}

describe('Windows Job Object confinement adapter', () => {
  it('requires a regular canonical helper with a matching SHA-256 manifest', () => {
    const helper = helperFixture()
    expect(resolveWindowsCommandJobHelper([helper], fileOps)).toBe(
      realFs.realpathSync.native(helper)
    )
    realFs.writeFileSync(helper, Buffer.from('tampered-helper'))
    expect(resolveWindowsCommandJobHelper([helper], fileOps)).toBeUndefined()
    realFs.writeFileSync(`${helper}.sha256`, 'not-a-digest\n', 'ascii')
    expect(resolveWindowsCommandJobHelper([helper], fileOps)).toBeUndefined()
  })

  it('builds fixed helper arguments and rejects unsafe limits', () => {
    expect(
      buildWindowsJobObjectArguments({
        metadata: { maxMemoryBytes: 1024, maxCpuTimeMs: 250, maxProcessCount: 2 }
      })
    ).toEqual(['1024', '250', '2'])
    expect(buildWindowsJobObjectArguments({})).toEqual(['-', '-', '-'])
    expect(() => buildWindowsJobObjectArguments({ metadata: { maxProcessCount: 0 } })).toThrow(
      'positive safe integer'
    )
    expect(() =>
      buildWindowsJobObjectArguments({ metadata: { maxProcessCount: 0x1_0000_0000 } })
    ).toThrow('Windows Job Object limit')
    expect(() =>
      buildWindowsJobObjectArguments({ metadata: { maxCpuTimeMs: 922_337_203_685_478 } })
    ).toThrow('Windows Job Object limit')
  })

  it('revalidates helper identity during preparation and immediately before spawn', () => {
    const helper = helperFixture()
    const spawnProcess = vi.fn() as unknown as CommandJobsSpawnProcess
    const adapter = createWindowsJobObjectConfinementAdapter(
      'win32',
      [helper],
      spawnProcess,
      fileOps
    )!
    realFs.writeFileSync(helper, Buffer.from('tampered-before-prepare'))
    expect(() => adapter.prepare({ metadata: { maxMemoryBytes: 4096 } })).toThrow(
      'identity changed before execution'
    )
    expect(spawnProcess).not.toHaveBeenCalled()

    const restored = Buffer.from('trusted-helper')
    realFs.writeFileSync(helper, restored)
    realFs.writeFileSync(
      `${helper}.sha256`,
      `${createHash('sha256').update(restored).digest('hex')}
`,
      'ascii'
    )
    const confined = adapter.prepare({ metadata: { maxMemoryBytes: 4096 } })
    realFs.writeFileSync(helper, Buffer.from('tampered-before-spawn'))
    expect(() => confined(path.win32.resolve('C:/node.exe'), [], {})).toThrow(
      'identity changed before spawn'
    )
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('wraps the target in the verified helper and never advertises network controls', () => {
    const helper = helperFixture()
    const calls: unknown[][] = []
    const fake = {} as ChildProcess
    const spawnProcess = ((...args: unknown[]) => {
      calls.push(args)
      return fake
    }) as CommandJobsSpawnProcess
    const adapter = createWindowsJobObjectConfinementAdapter(
      'win32',
      [helper],
      spawnProcess,
      fileOps
    )
    expect(adapter?.capabilities).toEqual({
      memory: true,
      cpu: true,
      processCount: true,
      networkDeny: false,
      networkHosts: false
    })
    const confined = adapter!.prepare({ metadata: { maxMemoryBytes: 4096 } })
    const options = { cwd: 'C:\\workspace' }
    const target = path.win32.resolve('C:/node.exe')
    expect(confined(target, ['-v'], options)).toBe(fake)
    expect(calls).toEqual([
      [realFs.realpathSync.native(helper), ['4096', '-', '-', '--', target, '-v'], options]
    ])
  })
})
