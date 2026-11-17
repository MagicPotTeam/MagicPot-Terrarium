import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { CommandJobsSpawnProcess } from './commandJobs'
import {
  buildWindowsJobObjectArguments,
  createWindowsJobObjectConfinementAdapter,
  probeWindowsCommandJobHelperCapability,
  resolveCapableWindowsCommandJobHelper,
  resolveWindowsCommandJobHelper,
  WINDOWS_COMMAND_JOB_CAPABILITY
} from './windowsJobObjectConfinement'

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const realOs = await vi.importActual<typeof import('node:os')>('node:os')
const roots: string[] = []

const fileOps = {
  realpath: (value: string) => realFs.realpathSync.native(value),
  isFile: (value: string) => realFs.statSync(value).isFile(),
  read: (value: string, encoding?: BufferEncoding) =>
    encoding === undefined ? realFs.readFileSync(value) : realFs.readFileSync(value, { encoding })
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

class FakeProbe extends EventEmitter {
  readonly stdout = new PassThrough()
  killed = 0
  kill(): boolean {
    this.killed += 1
    return true
  }
}

const probeSpawner = (answer: (probe: FakeProbe) => void) => {
  const calls: unknown[][] = []
  const probes: FakeProbe[] = []
  const spawnProcess = ((...args: unknown[]) => {
    calls.push(args)
    const probe = new FakeProbe()
    probes.push(probe)
    queueMicrotask(() => answer(probe))
    return probe as unknown as ChildProcess
  }) as CommandJobsSpawnProcess
  return { calls, probes, spawnProcess }
}

describe('Windows Job Object helper capability', () => {
  it('matches the capability string printed by the Rust helper', () => {
    const source = realFs.readFileSync(
      path.join(__dirname, '../../../../../magicpot-command-job/src/main.rs'),
      'utf8'
    )
    expect(source).toContain(`println!("${WINDOWS_COMMAND_JOB_CAPABILITY}");`)
  })

  it('asks the helper for --capabilities without a shell and trims the answer', async () => {
    const fake = probeSpawner((probe) => {
      probe.stdout.write(`${WINDOWS_COMMAND_JOB_CAPABILITY}\r\n`)
      probe.emit('close', 0)
    })
    await expect(
      probeWindowsCommandJobHelperCapability('C:\\h.exe', fake.spawnProcess)
    ).resolves.toBe(WINDOWS_COMMAND_JOB_CAPABILITY)
    expect(fake.calls).toEqual([
      [
        'C:\\h.exe',
        ['--capabilities'],
        { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      ]
    ])
  })

  it('treats a failing, erroring, oversized or silent probe as no capability', async () => {
    const failing = probeSpawner((probe) => {
      probe.stdout.write(WINDOWS_COMMAND_JOB_CAPABILITY)
      probe.emit('close', 1)
    })
    await expect(
      probeWindowsCommandJobHelperCapability('h', failing.spawnProcess)
    ).resolves.toBeUndefined()
    const erroring = probeSpawner((probe) => probe.emit('error', new Error('ENOENT')))
    await expect(
      probeWindowsCommandJobHelperCapability('h', erroring.spawnProcess)
    ).resolves.toBeUndefined()
    const oversized = probeSpawner((probe) => probe.stdout.write('x'.repeat(2000)))
    await expect(
      probeWindowsCommandJobHelperCapability('h', oversized.spawnProcess)
    ).resolves.toBeUndefined()
    expect(oversized.probes[0].killed).toBe(1)
    const silent = probeSpawner(() => undefined)
    await expect(
      probeWindowsCommandJobHelperCapability('h', silent.spawnProcess, 20)
    ).resolves.toBeUndefined()
    expect(silent.probes[0].killed).toBe(1)
    const throwing = (() => {
      throw new Error('spawn EACCES')
    }) as unknown as CommandJobsSpawnProcess
    await expect(probeWindowsCommandJobHelperCapability('h', throwing)).resolves.toBeUndefined()
  })

  it('resolves only a verified helper that answers the current capability', async () => {
    const helper = helperFixture()
    const canonical = realFs.realpathSync.native(helper)
    await expect(
      resolveCapableWindowsCommandJobHelper({
        candidates: [helper],
        fileOps,
        probe: async () => WINDOWS_COMMAND_JOB_CAPABILITY
      })
    ).resolves.toBe(canonical)
    await expect(
      resolveCapableWindowsCommandJobHelper({
        candidates: [helper],
        fileOps,
        probe: async () => 'magicpot-command-job:atomic-job-list-empty-v1'
      })
    ).resolves.toBeUndefined()
    await expect(
      resolveCapableWindowsCommandJobHelper({
        candidates: [helper],
        fileOps,
        probe: async () => {
          throw new Error('probe failed')
        }
      })
    ).resolves.toBeUndefined()
    // Replaced between the probe and the launch decision.
    await expect(
      resolveCapableWindowsCommandJobHelper({
        candidates: [helper],
        fileOps,
        probe: async () => {
          realFs.writeFileSync(helper, Buffer.from('swapped-after-probe'))
          return WINDOWS_COMMAND_JOB_CAPABILITY
        }
      })
    ).resolves.toBeUndefined()
    const probe = vi.fn(async () => WINDOWS_COMMAND_JOB_CAPABILITY)
    await expect(
      resolveCapableWindowsCommandJobHelper({
        candidates: [path.join(helper, 'missing')],
        fileOps,
        probe
      })
    ).resolves.toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })
})

/**
 * The command line hop through the helper: libuv quotes the helper's argv (quote_cmd_arg), the
 * helper's C runtime splits it, and the helper re-quotes each argument for CreateProcessW
 * (`quote` in packages/magicpot-command-job/src/main.rs). The command must see the same argv as
 * a direct spawn.
 */
describe('Windows Job Object helper argument round trip', () => {
  const libuvQuote = (arg: string): string => {
    if (arg === '') return '""'
    if (!/[ \t"]/.test(arg)) return arg
    if (!/["\\]/.test(arg)) return `"${arg}"`
    let out = ''
    let slashes = 0
    for (const ch of arg) {
      if (ch === '\\') {
        slashes += 1
        continue
      }
      out += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + ch
      slashes = 0
    }
    return `"${out}${'\\'.repeat(slashes * 2)}"`
  }
  // Port of `quote` in main.rs.
  const helperQuote = (text: string): string => {
    if (text !== '' && !/[ \t"]/.test(text)) return text
    let result = '"'
    let slashes = 0
    for (const ch of text) {
      if (ch === '\\') {
        slashes += 1
      } else {
        result += ch === '"' ? '\\'.repeat(slashes * 2 + 1) : '\\'.repeat(slashes)
        slashes = 0
        result += ch
      }
    }
    return `${result}${'\\'.repeat(slashes * 2)}"`
  }
  // Microsoft C runtime argument splitting (the rules both quoters target).
  const parse = (line: string): string[] => {
    const args: string[] = []
    let index = 0
    while (index < line.length) {
      while (line[index] === ' ' || line[index] === '\t') index += 1
      if (index >= line.length) break
      let current = ''
      let quoted = false
      while (index < line.length && (quoted || (line[index] !== ' ' && line[index] !== '\t'))) {
        let slashes = 0
        while (line[index] === '\\') {
          slashes += 1
          index += 1
        }
        if (line[index] === '"') {
          current += '\\'.repeat(Math.floor(slashes / 2))
          if (slashes % 2) current += '"'
          else quoted = !quoted
          index += 1
        } else {
          current += '\\'.repeat(slashes)
          if (index < line.length && (quoted || (line[index] !== ' ' && line[index] !== '\t'))) {
            current += line[index]
            index += 1
          }
        }
      }
      args.push(current)
    }
    return args
  }

  it('keeps arguments with spaces, quotes and trailing backslashes intact', () => {
    const command = 'C:\\Program Files\\Tool\\tool.exe'
    const args = [
      'plain',
      'with space',
      'tab\there',
      'quote"inside',
      '"fully quoted"',
      'trailing\\',
      'trailing space\\',
      'C:\\dir with space\\',
      'back\\\\"quote',
      '',
      '\\\\server\\share'
    ]
    const helperArgv = ['-', '-', '-', '--', command, ...args]
    const helperLine = ['helper.exe', ...helperArgv].map(libuvQuote).join(' ')
    const received = parse(helperLine).slice(1)
    expect(received).toEqual(helperArgv)
    const childLine = received.slice(4).map(helperQuote).join(' ')
    expect(parse(childLine)).toEqual([command, ...args])
  })
})
